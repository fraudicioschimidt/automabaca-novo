import { marketKindOf } from "@/src/domain/mercados/classify";
import { parseLineQuarters } from "@/src/domain/settlement/lines";
import {
  matchTeamSide,
  resolveSideFromMarketAndSelection,
  stripTeamNames,
} from "@/src/domain/settlement/sides";
import { splitEventoTeams } from "@/src/domain/text";

/**
 * Linha asiática split (Bet365) → quarter line canônica.
 * Ex.: "Colômbia 0.0, -0.5" → "Colômbia -0.25"
 *      "Over 2.0, 2.5" → "Over 2.25" (total asiático, sem sinal de handicap).
 */

const SPLIT_LINE_PAIR_SUFFIX =
  /(?:[+−–—-]?\d+\.\d+|[+−–—-]?\d+)\s*,\s*(?:[+−–—-]\d+(?:[.,]\d+)?|\d+\.\d+)\s*$/;

// O delimitador do split também é vírgula, então a primeira perna usa ponto
// decimal. A evidência mínima de split é: ponto em alguma perna ou sinal
// explícito na segunda. Assim `-0,5` continua sendo UMA linha decimal PT.
const SPLIT_PAIR_SUFFIX =
  /([+−–—-]?)\s*(\d+(?:\.\d+)?)\s*,\s*([+−–—-]?)\s*(\d+(?:\.\d+)?)\s*$/;
const DECIMAL_PT_SUFFIX = /([+−–—-]?)\s*(\d+),(\d+)\s*$/;

const TOTAL_SIDE_PREFIX = /^(over|under|mais|menos)\b/i;
const TERMINAL_ASIAN_HANDICAP_LABEL =
  /(?<=\d)\s*(?:a\s*\.?\s*h\s*\.?|asian\s+handicap)\s*$/i;

function formatHandicapLineFromQuarters(lineQ: number): string {
  const line = lineQ / 4;
  if (Math.abs(line) < 1e-9) return "0";
  const abs = Math.abs(line);
  const body =
    (abs % 1 === 0 ? abs.toFixed(1) : abs.toFixed(2)).replace(/\.?0+$/, "") || "0";
  return line > 0 ? `+${body}` : `-${body}`;
}

function formatTotalLineFromQuarters(lineQ: number): string {
  const line = Math.abs(lineQ / 4);
  // Linha inteira sai com uma casa ("2.0", não "2"): o dedup de registerBet
  // compara `selecao` como STRING, e a mesma tip chegando por outra origem
  // (sem split para canonicalizar) é escrita "Over 2.0". Sem a casa, as duas
  // grafias da MESMA linha não casavam e a rede contra duplicata cruzada de
  // origem furava — o settlement sempre foi igual nos dois casos, porque
  // `parseLineQuarters` lê 2 e 2.0 como os mesmos 8 quartos.
  return line % 1 === 0 ? line.toFixed(1) : String(Number(line.toFixed(2)));
}

/**
 * Normaliza seleção AH/Total com split Bet365 pela média em quartos (SSOT do settlement).
 * Sem vírgula na linha → no-op. Mercado não-spread/não-total sem split → no-op.
 */
export function canonicalizeAsianHandicapSelecao(
  selecao: string,
  evento: string,
  mercado?: string,
): string {
  const rawTrimmed = selecao.trim();
  if (!rawTrimmed) return selecao;
  const kind = mercado ? marketKindOf(mercado) : null;
  // Tipsters frequentemente colam a abreviação do MERCADO na linha
  // (`Bolivar -2ah`). O sufixo não faz parte nem do time nem do handicap e
  // impedia a seleção de chegar à forma canônica, embora o settlement ainda
  // conseguisse extrair o número. Remove somente o marcador terminal depois de
  // um dígito; `-2` permanece porque é o contrato financeiro da aposta.
  const trimmed = kind === "spread" || !mercado
    ? rawTrimmed.replace(TERMINAL_ASIAN_HANDICAP_LABEL, "").trim()
    : rawTrimmed;
  const removedMarketLabel = trimmed !== rawTrimmed;
  const isTotalish = kind === "total" || kind === "team_total" || TOTAL_SIDE_PREFIX.test(trimmed);
  const isSpreadish = kind === "spread" || (!kind && !isTotalish);
  if (mercado && kind !== "spread" && kind !== "total" && kind !== "team_total") {
    return selecao;
  }

  const splitCandidate = trimmed.match(SPLIT_PAIR_SUFFIX);
  const split =
    splitCandidate &&
    ((splitCandidate[2] ?? "").includes(".") ||
      (splitCandidate[4] ?? "").includes(".") ||
      Boolean(splitCandidate[3]))
      ? splitCandidate
      : null;
  let lineQ: number | null = null;
  let prefix = "";
  if (split?.index !== undefined) {
    const [, firstSignText = "", firstBody = "", secondSignText = "", secondBody = ""] = split;
    // O sinal Unicode do print pertence à linha, nunca ao nome do time.
    const firstSign = firstSignText.replace(/[−–—]/g, "-");
    const secondSignRaw = secondSignText.replace(/[−–—]/g, "-");
    const firstValue = Number(firstBody);
    // Sinais explícitos opostos não formam uma linha asiática válida. Fazer a
    // média (`-2,+2.5` → `+0.25`) troca lado e preço; mantém o texto cru para o
    // pipeline falhar fechado e pedir correção da captura.
    if (!isTotalish && firstSign && secondSignRaw && firstSign !== secondSignRaw) {
      return selecao;
    }
    // Em handicap, `-2,2.5` é a abreviação Bet365 de `-2,-2.5`: a segunda
    // perna herda o sinal explícito da primeira. Já `2,2.5` não declara lado
    // algum e pode ser OCR/decimal corrompido; falha fechado em vez de inventar
    // +2.25. Zero é neutro e `0,0.5` continua sendo o split +0.25 conhecido.
    if (
      !isTotalish &&
      firstValue !== 0 &&
      firstSign === "" &&
      secondSignRaw === ""
    ) {
      return selecao;
    }
    if (!isTotalish && firstValue !== 0 && firstSign === "" && secondSignRaw === "-") {
      return selecao;
    }
    const secondSign = secondSignRaw || (!isTotalish ? firstSign : "");
    const firstLeg = `${firstSign}${firstBody}`;
    const secondLeg = `${secondSign}${secondBody}`;
    lineQ = parseLineQuarters(`${firstLeg}, ${secondLeg}`, {
      allowNegative: !isTotalish,
    });
    prefix = trimmed.slice(0, split.index).trim();
  } else {
    // Preserva a normalização histórica de uma única linha decimal PT:
    // `Time -0,5` → `Time -0.5`, sem confundi-la com split.
    const decimalPt = trimmed.match(DECIMAL_PT_SUFFIX);
    if (decimalPt?.index === undefined) return removedMarketLabel ? trimmed : selecao;
    const [, sign = "", integer = "", fraction = ""] = decimalPt;
    lineQ = parseLineQuarters(`${sign}${integer}.${fraction}`, {
      allowNegative: !isTotalish,
    });
    prefix = trimmed.slice(0, decimalPt.index).trim();
  }
  if (lineQ === null) return selecao;

  if (!prefix && evento && isSpreadish) {
    const side = matchTeamSide(trimmed, evento);
    const teams = splitEventoTeams(evento);
    if (side && teams) prefix = side === "home" ? teams.home : teams.away;
  }
  if (!prefix) return selecao;

  if (isTotalish || TOTAL_SIDE_PREFIX.test(prefix)) {
    const sideMatch = prefix.match(/^(over|under|mais|menos)\b/i);
    const sideToken = sideMatch?.[1];
    const side = sideToken
      ? /^(mais|over)$/i.test(sideToken)
        ? "Over"
        : "Under"
      : prefix;
    return `${side} ${formatTotalLineFromQuarters(lineQ)}`.trim();
  }

  return `${prefix} ${formatHandicapLineFromQuarters(lineQ)}`.trim();
}

/**
 * Vision truncou o split Bet365 e gravou só "0" / "0.0" — candidato a retry.
 * Já tem split completo → não precisa.
 *
 * AH level ball (`Time 0` / `Time 0.0`) é linha VÁLIDA: não confundir com
 * truncamento. Só trate zero como suspeito quando não há lado (time) na
 * seleção — aí pode ser "0.0, -0.5" cortado para "0".
 */
export function asianHandicapLineNeedsRetry(selecao: string, evento: string): boolean {
  const trimmed = selecao.trim();
  // Não trate qualquer vírgula textual como prova de split: nomes/observações
  // também podem conter vírgula. O par exige duas linhas numéricas explícitas.
  if (SPLIT_LINE_PAIR_SUFFIX.test(trimmed)) return false;
  const lineText = stripTeamNames(trimmed, evento).replace(/\s+/g, " ").trim();
  // Um handicap sem qualquer linha ("Charlotte Independence") é tão
  // incompleto quanto um split truncado em zero: não pode ser precificado nem
  // liquidado com segurança.
  if (!lineText || parseLineQuarters(lineText, { allowNegative: true }) === null) {
    return true;
  }
  // Time + linha legível (inclui 0 / 0.0) → completo.
  if (matchTeamSide(trimmed, evento)) return false;
  // Sem time: zero isolado ainda é o caso clássico de split truncado.
  if (/^[+−–—-]?0(?:[.,]0)?$/.test(lineText)) return true;
  return /(?:^|\s)[+−–—-]?0(?:[.,]0)?$/.test(trimmed);
}

/**
 * AH com linha legível mas sem lado (time/home/away). Tipsters como Luis
 * circulam o lado no print; a visão às vezes grava só "0.0, -0.5".
 * Não inventa home — candidato a retry de visão (círculo) ou rejeição.
 */
export function asianHandicapSideNeedsRetry(
  selecao: string,
  evento: string,
  mercado?: string,
): boolean {
  if (TOTAL_SIDE_PREFIX.test(selecao.trim())) return false;
  if (mercado && marketKindOf(mercado) !== "spread") return false;
  const trimmed = selecao.trim();
  if (!trimmed || !evento.trim()) return false;
  // Mesmo invariante do settlement: o lado tem DUAS fontes, e o rótulo do
  // mercado é uma delas. Perguntando só à seleção, "Home Asian Handicap" com a
  // linha nua pedia retry de visão para uma aposta que o liquidador resolve
  // sozinho — custo de visão por uma dúvida que não existe.
  if (resolveSideFromMarketAndSelection(mercado ?? "", trimmed, evento).side) return false;
  const lineText = stripTeamNames(trimmed, evento).replace(/\s+/g, " ").trim();
  if (!lineText) return false;
  return parseLineQuarters(lineText, { allowNegative: true }) !== null;
}
