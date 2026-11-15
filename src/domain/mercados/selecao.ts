import { statisticFamilyInText } from "@/src/domain/settlement/statistics";
import { hasSportScoreUnitMismatch, selecaoDeclaraLinhaDeEstatistica } from "./stat-qualifier";
import { ehMercadoArtilheiro } from "@/src/domain/settlement/goalscorer";
import { classificarPropDeJogador } from "@/src/domain/settlement/player-prop-classify";
import { subjectAfterLine } from "@/src/domain/settlement/over-under-subject";
import { normalizeStr, splitEventoTeams } from "@/src/domain/text";
import {
  matchDoubleChanceSelection,
  matchDrawNoBetSelection,
  matchMoneylineSelection,
  matchTeamSide,
  stripTeamNames,
} from "@/src/domain/settlement/sides";
import { UNKNOWN_LINE_SEPARATOR, parseLineQuarters } from "@/src/domain/settlement/lines";
import { bttsSelectionSide, declaresRegulationTime, isThreeWayHandicapMarket, marketIncludesExtraTime, marketKindOf, marketPeriodOf } from "./classify";
import { restrictsToRegulationTime } from "./compatibility";
import { trailingTeamCandidate } from "./trailing-side";
import { expandAbbreviatedDirection, separateCompactStatUnit } from "./total-direction";
import { selecaoNomeiaTimeDoTotal, selecaoPareceHandicap, selecaoPareceTotal, stripSelectionOdds } from "./selection-shape";

const TOTAL_MARKET_SELECTION_PREFIX =
  /^\s*(?:(?:total(?:\s+de)?(?:\s+(?:gols?|goals?|pontos?|points?|runs?|corridas?|games?|jogos?|sets?|kills?|abates?))?)|(?:linha\s+de\s+(?:gols?|goals?|pontos?|points?|runs?|corridas?|escanteios?|cantos?|corners?|cart(?:[oõ]es?|oes|eos)|cards?|kills?|abates?))|gols?|goals?|pontos?|points?|runs?|corridas?|games?|jogos?|sets?|kills?|abates?)\s*[:–—-]\s*(?=(?:mais|menos|acima|abaixo|over|under|ov|un|o|u)\b)/i;

/** "+" seguido de número é sinal de linha ("Flamengo + 1.5"), não ligação. */
const COMBINED_SEPARATOR = /\s+(?:e|and|&|\+(?!\s*\d))\s+/i;
const CONDITION_WORDS = /\b(?:ambas?|ambos|btts|both teams|vence|vencer|ganha|ganhar|wins?)\b|^(?:sim|nao|yes|no)$/;
const LEADING_DIRECTION = /^(?:over|under|mais|menos|acima|abaixo|ov|un|o|u)\b/;

/**
 * Duas condições ligadas por "e", "+" ou "&" ("Sim e Over 2.5", "Flamengo e
 * Over 1.5", "Ambas marcam e Over 2.5"): é uma aposta combinada, e não a
 * seleção de um mercado só. Cada parte tem de ser uma condição (direção com
 * linha, handicap de um time, Sim/Não, ambas marcam, "vence") ou um lado do
 * jogo, e ao menos uma delas, condição: "Brighton & Hove", "Flamengo e
 * Palmeiras marcam" e "Pontos e rebotes Over 30.5" não são.
 */
export function isCombinedSelection(rawSelecao: string, evento: string): boolean {
  const selecao = stripSelectionOdds(rawSelecao);
  const parts = selecao.split(COMBINED_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2 || matchMoneylineSelection(selecao, evento, { strict: true })) return false;
  const isCondition = (part: string) => {
    const text = normalizeStr(part);
    if (CONDITION_WORDS.test(text)) return true;
    if (selecaoPareceTotal(part)) return LEADING_DIRECTION.test(text) || selecaoNomeiaTimeDoTotal(part, evento);
    return selecaoPareceHandicap(part) && matchTeamSide(part, evento) !== null;
  };
  const isSide = (part: string) =>
    matchMoneylineSelection(part, evento, { strict: true }) !== null || matchDoubleChanceSelection(part, evento) !== null;
  return parts.some(isCondition) && parts.every((part) => isCondition(part) || isSide(part));
}

/**
 * Seleção em estilo Pinnacle:
 *  - Casa/Fora → nome real do time (do evento), Empate → "Draw";
 *  - Sim/Não → "Yes"/"No" (BTTS);
 *  - "Mais de 2,5" → "Over 2.5" (decimal com ponto; linha dupla preservada).
 * Não reconheceu, ou a seleção é uma combinada → devolve como veio (visível
 * para correção manual).
 */

function cleanPlayerPropSelection(selecao: string): string {
  let cleaned = selecao.replace(/^(?:para\s+marcar|jogador|atleta|player)\s*[:\-–—]\s*/i, "").trim();
  cleaned = cleaned.split(/\s+[-–—]\s+(?:anytime|ass|assists?|goalscorer|scorer|marcar|gol|gols)/i)[0]?.trim() ?? cleaned;
  cleaned = cleaned.replace(/\s+(?:anytime(?:\s+goalscorer)?|goalscorer|scorer|to\s+score|(?:(?:para|pra)\s+)?marcar(?:\s+a\s+qualquer\s+momento)?|marcador|ass|assists?|assist[eê]ncias?|sofreu?\s+faltas?|cometeu?\s+faltas?|chutes?\s+ao\s+gol|finaliza[cç][oõ]es?|desarmes?)$/i, "").trim();
  return cleaned || selecao;
}

export function pinnacleizeSelecao(params: {
  selecao: string;
  mercadoPinnacle: string;
  evento: string;
  esporte?: string;
}): string {
  const selecao = separateCompactStatUnit(stripSelectionOdds(params.selecao ?? "")).trim();
  if (!selecao) return selecao;
  // A combinada fica inteira: formatá-la pelo mercado apagaria uma das condições.
  if (isCombinedSelection(selecao, params.evento)) return selecao;
  if (hasSportScoreUnitMismatch(params.mercadoPinnacle, selecao, params.esporte) &&
    !hasSportScoreUnitMismatch(params.mercadoPinnacle, "", params.esporte)) return selecao;
  // O rótulo pode nomear só a família genérica: tirar "vermelhos" ou "no
  // alvo" da seleção mudaria a contagem usada para pagar a aposta.
  if (selecaoDeclaraLinhaDeEstatistica(selecao) &&
    statisticFamilyInText(selecao) !== statisticFamilyInText(params.mercadoPinnacle)) return selecao;
  // A regra dita só na seleção precisa sobreviver à formatação do número/lado.
  if ((marketIncludesExtraTime(selecao) && !marketIncludesExtraTime(params.mercadoPinnacle)) ||
    (restrictsToRegulationTime(selecao, params.esporte) && !declaresRegulationTime(params.mercadoPinnacle) &&
      !isThreeWayHandicapMarket(params.mercadoPinnacle))) return selecao;
  const lower = normalizeStr(selecao);
  // A qualifier carried only by the selection is evidence. Formatting must
  // not erase it and turn a set/half/statistical line into a match-score bet.
  const selectionPeriod = marketPeriodOf(selecao);
  if (selectionPeriod !== "FT" &&
    (selectionPeriod === "OTHER" || selectionPeriod === "MAP" || selectionPeriod !== marketPeriodOf(params.mercadoPinnacle))) return selecao;
  const unitGroups = [/\bsets?\b/, /\bgames\b/, /\b(?:kills?|abates?)\b/,
    /\b(?:corners?|escanteios?|cantos?)\b/, /\b(?:cards?|bookings?|cartoes|cartao|carteos)\b/,
    /\b(?:points?|pontos?)\b/, /\b(?:maps|mapas)\b/, /\brounds\b/, /\bframes\b/, /\blegs\b/,
    /\b(?:rebounds?|rebotes?)\b/, /\b(?:assists?|assistencias?)\b/, /\b(?:shots?|chutes?)\b/, /\baces?\b/];
  if (unitGroups.some(pattern => pattern.test(lower) && !pattern.test(normalizeStr(params.mercadoPinnacle)))) return selecao;
  const selectionWithoutTotalLabel = selecao.replace(TOTAL_MARKET_SELECTION_PREFIX, "");
  const kind = marketKindOf(params.mercadoPinnacle, selectionWithoutTotalLabel);
  const teams = splitEventoTeams(params.evento);




  const canonicalizeSignedSide = (): string | null => {
    const formatted = selecao.replace(
      /(?<![\d.,])([+-]?\d+),(\d+)(?![\d.])/g,
      "$1.$2",
    );
    const side = matchTeamSide(formatted, params.evento);
    // A linha pode vir entre parênteses ("Time 1 (+0.5)"); o parêntese é
    // fronteira válida como o espaço, mas não entra na saída canônica.
    const signedLine = formatted.match(/(?:^|\s|\()\s*([+\-]\s*\d+(?:\.\d+)?)\s*(?=\s|\)|$)/)?.[1]
      ?.replace(/\s+/g, "");
    if (!side || !signedLine || !teams) return null;
    // Read the whole financial line before shortening the label. Selecting
    // only the last signed number turned `0.0, +0.5` into a different bet.
    const lineText = stripTeamNames(formatted, params.evento);
    const quarters = parseLineQuarters(lineText, { allowNegative: true });
    if (quarters === null || UNKNOWN_LINE_SEPARATOR.test(lineText)) return null;
    if (quarters !== Number(signedLine) * 4) {
      if (isThreeWayHandicapMarket(params.mercadoPinnacle)) return null;
      const line = quarters / 4;
      return `${side === "home" ? teams.home : teams.away} ${line > 0 ? "+" : ""}${line}`;
    }
    return `${side === "home" ? teams.home : teams.away} ${signedLine}`;
  };

  if (isThreeWayHandicapMarket(params.mercadoPinnacle)) {
    return canonicalizeSignedSide() ?? selecao;
  }

  if (kind === "draw_no_bet") {
    const side = matchDrawNoBetSelection(selecao, params.evento);
    if (side && teams) return side === "home" ? teams.home : teams.away;
    // DNB não tem seleção de empate; texto ambíguo permanece visível para
    // correção manual em vez de virar "Draw".
    return selecao;
  }

  if (kind === "moneyline") {
    const side = matchMoneylineSelection(selecao, params.evento);
    if (side === "home" && teams) return teams.home;
    if (side === "away" && teams) return teams.away;
    if (side === "draw") return "Draw";
    // Seleção-por-lado é um NOME de time — nunca um total. Devolve como veio para
    // não cair no bloco Over/Under abaixo (ex.: "U21 Spain" viraria "Under 21";
    // "O'Higgins" viraria "Over …").
    return selecao;
  }

  if (kind === "double_chance") {
    const outcomes = matchDoubleChanceSelection(selecao, params.evento);
    if (!outcomes || !teams) return selecao;
    const label = (outcome: (typeof outcomes)[number]) =>
      outcome === "home" ? teams.home : outcome === "away" ? teams.away : "Draw";
    return `${label(outcomes[0])} or ${label(outcomes[1])}`;
  }

  if (kind === "correct_score") {
    // "2 a 1" e "2 por 1" só são separadores DENTRO de placar exato; fora dele
    // as letras pertencem ao texto.
    const score = lower.match(/\b(\d{1,2})\s*(?:[-x×:]|\s+(?:a|por)\s+)\s*(\d{1,2})\b/);
    if (score?.[1] === undefined || score[2] === undefined || score.index === undefined) return selecao;
    return correctScoreInEventOrder({
      first: Number(score[1]),
      second: Number(score[2]),
      before: lower.slice(0, score.index),
      after: lower.slice(score.index + score[0].length),
      evento: params.evento,
    }) ?? selecao;
  }

  if (kind === "spread") {
    // Vírgula decimal PT em linha assinada → ponto Pinnacle. O lookbehind não
    // toca a vírgula que separa split já escrito com ponto ("0.0,0.5").
    return canonicalizeSignedSide() ??
      selecao.replace(/(?<![\d.,])([+-]?\d+),(\d+)(?![\d.])/g, "$1.$2");
  }

  if (kind === "btts") {
    const side = bttsSelectionSide(selecao);
    return side === "yes" ? "Yes" : side === "no" ? "No" : selecao;
  }

  if (
    ehMercadoArtilheiro(params.mercadoPinnacle) ||
    params.mercadoPinnacle.startsWith("Player ") ||
    Boolean(classificarPropDeJogador({ mercado: params.mercadoPinnacle, selecao, evento: params.evento }))
  ) {
    return cleanPlayerPropSelection(selecao);
  }

  // Inclui abreviações de tipster ("U. 4.5", "O 2.5", "u2.25") — o dígito
  // obrigatório no resto impede falso positivo com nomes ("Uruguai").
  // Bet365 split "Mais de 2.0,2.5" → média Pinnacle "Over 2.25" (não "Over +2.25").
  const totalSelection = kind === "total" ? selectionWithoutTotalLabel : selecao;
  // "Flamengo O 1.5" vira "Flamengo Over 1.5"; a sigla solta depois do time só
  // é direção com as travas de `expandAbbreviatedDirection` ("Sporting U23").
  const expandedSelection = expandAbbreviatedDirection(totalSelection);
  // Se a sigla expandida não foi a do começo ("U21 Spain U 2.5"), ou se a
  // direção vem escrita adiante ("U21 Spain Over 2.5"), a do começo é a
  // categoria do time: lida como direção, a linha viraria o 21.
  const leadsWithTeamCategory = (expandedSelection !== totalSelection &&
    /^(?:ov|un|o|u)\s*\.?\s*\d/i.test(expandedSelection)) ||
    /^(?:ov|un|o|u)\s*\.?\s*\d+\s+\D.*\b(?:over|under|mais|menos|acima|abaixo)\b/i.test(totalSelection);
  const leadingDirection = leadsWithTeamCategory
    ? null
    : totalSelection.match(/^(mais|menos|acima|abaixo|over|under|ov|un|o|u)\.?\s*(?:(?:de|que)\s+)?(\+?\s*\d.*)$/i);
  const prefixedTeamTotal = kind === "team_total"
    ? expandedSelection.match(/^(.+?)\s+(mais|menos|acima|abaixo|over|under|ov|un)\.?\s*(?:(?:de|que)\s+)?(\+?\s*\d.*)$/i)
      // In an already classified team total, "+70.5 pontos" means Over.
      // Spread selections returned above retain their handicap sign.
      ?? expandedSelection.match(/^(.+?)\s+(\+)\s*(\d.*)$/i)
    : null;
  const directionToken = leadingDirection?.[1] ?? prefixedTeamTotal?.[2];
  const rawLine = leadingDirection?.[2] ?? prefixedTeamTotal?.[3];
  const rawTeamPrefix = prefixedTeamTotal?.[1]?.trim();
  const teamPrefixSide = rawTeamPrefix
    ? matchTeamSide(rawTeamPrefix, params.evento)
    : null;
  const teamPrefix = teamPrefixSide && teams
    ? (teamPrefixSide === "home" ? teams.home : teams.away)
    : rawTeamPrefix;
  // Separador sem procedência não vira linha nem na captura: gravar "Over 2.0"
  // a partir de "Over 2.0; 2.5" escolheria a perna em silêncio.
  if (directionToken && rawLine && UNKNOWN_LINE_SEPARATOR.test(normalizeStr(rawLine))) {
    return selecao;
  }
  if (directionToken && rawLine) {
    const side = /^(mais|acima|over|ov|o|\+)$/i.test(directionToken) ? "Over" : "Under";
    // A linha é o PRIMEIRO número; o segundo só conta quando está colado por
    // vírgula/barra ou por hífen entre dois números, grafias de split line da
    // Bet365 ("2.0,2.5"/"2.0-2.5" → 2.25).
    // Varrer todos os números do resto e tirar média incluía tokens de período
    // e estatística: "Over 9.5 corners 1st half" virava "Over 5.25" e
    // "Over 2.5 - 1st Half" virava "Over 1.75" — linha corrompida gravada, com
    // mis-settle e CLV contra a linha errada.
    const linha = rawLine.match(
      /^\+?\s*(\d+(?:[.,]\d+)?)(?:\s*([,/-])\s*(\d+(?:[.,]\d+)?)(?![a-z0-9.,]))?/i,
    );
    const first = linha?.[1] === undefined ? Number.NaN : Number(linha[1].replace(",", "."));
    if (Number.isFinite(first)) {
      const separator = linha?.[2];
      const secondRaw = linha?.[3];
      // O lado também aparece DEPOIS da linha ("Over 1.5 Flamengo Gols",
      // "Mais de 1.5 Gols do Flamengo", "Over 1.5 Casa"). Sem ler o resto, o
      // time era descartado e um total POR EQUIPE virava total do JOGO — com
      // mercado genérico ("Total de Gols") isso liquida pelo placar agregado e
      // inverte dinheiro.
      const teamSuffix = teamPrefix
        ? null
        : resolveTrailingSide(rawLine.slice(linha?.[0]?.length ?? 0), params.evento, teams);
      // Quem vem depois da linha e não é time ("Over 0.5 - Mbappé") é o sujeito
      // de outra aposta: reduzida a "Over 0.5", ela liquidaria pelo total do jogo.
      if (!teamPrefix && !teamSuffix && subjectAfterLine(totalSelection, params.evento)) return selecao;
      const teamName = teamPrefix ?? teamSuffix;
      const prefix = teamName ? `${teamName} ` : "";
      if (secondRaw === undefined) return `${prefix}${side} ${formatTotalLine(first)}`;
      const second = Number(secondRaw.replace(",", "."));
      // Hífen também separa período/metadado ("2.5 - 1st Half"). Só é uma
      // split line quando as duas pernas asiáticas são adjacentes (0.5).
      if (separator === "-" && Math.abs(first - second) !== 0.5) {
        return `${prefix}${side} ${formatTotalLine(first)}`;
      }
      const mid = (first + second) / 2;
      if (Number.isFinite(mid)) return `${prefix}${side} ${formatTotalLine(mid)}`;
      return `${prefix}${side} ${formatTotalLine(first)}`;
    }
  }

  return selecao;
}

const CORRECT_SCORE_LABEL = /\b(?:(?:placar|resultado)\s+(?:exato|correto|certo)|correct\s+score)\b/g;

/**
 * Placar exato na ordem do evento. O time citado antes do placar é o dono do
 * primeiro número ("Palmeiras 2x1" é o Palmeiras vencendo, como a casa
 * escreve), e o citado depois, do segundo. Null quando o texto não decide de
 * quem é cada gol: a seleção fica como veio, com o time, para o dono ver.
 */
function correctScoreInEventOrder(params: {
  first: number;
  second: number;
  before: string;
  after: string;
  evento: string;
}): string | null {
  const { first, second } = params;
  const sideOf = (text: string) => {
    const withoutLabel = text.replace(CORRECT_SCORE_LABEL, " ");
    return /[a-z]/.test(withoutLabel) ? matchTeamSide(withoutLabel, params.evento) : null;
  };
  const leading = sideOf(params.before);
  const trailing = sideOf(params.after);
  const inOrder = `${first}-${second}`;
  const reversed = `${second}-${first}`;
  if (leading && trailing) return leading === trailing ? null : leading === "home" ? inOrder : reversed;
  const named = leading ?? trailing;
  if (!named || named === "home" || first === second) return inOrder;
  // Só o visitante na frente do placar maior é inequívoco: "Palmeiras 1x2"
  // pode ser o placar dele ou o do jogo.
  return first > second ? reversed : null;
}

/** Nome do clube quando o lado vem DEPOIS da linha; null quando não resolve. */
function resolveTrailingSide(
  trailing: string,
  evento: string,
  teams: { home: string; away: string } | null,
): string | null {
  if (!teams) return null;
  // O recorte do sufixo é compartilhado com o settlement (`trailing-side.ts`).
  // `matchTeamSide` normaliza de novo, e o nome devolvido vem do evento, não
  // deste candidato.
  const candidate = trailingTeamCandidate(trailing);
  if (!candidate) return null;
  const side = matchTeamSide(candidate, evento);
  if (!side) return null;
  return side === "home" ? teams.home : teams.away;
}

/** Formata linha de total sem sinal de handicap ("2.25", "2.5", "3.0"). */
function formatTotalLine(line: number): string {
  const absolute = Math.abs(line);
  return absolute % 1 === 0 ? absolute.toFixed(1) : String(Number(absolute.toFixed(2)));
}

/**
 * Moneyline cuja seleção não aponta um vencedor ("Ambas marcam", "Over2.5",
 * "Placar exato 2x1"): o rótulo é conhecido, a aposta não. Conta como mercado
 * não reconhecido, para o aviso sair e a liquidação não ser a única a saber.
 */
export function moneylineSelectionUnreadable(bet: { mercado: string; selecao: string; evento: string }): boolean {
  return marketKindOf(bet.mercado, bet.selecao, bet.evento) === "moneyline" &&
    matchMoneylineSelection(bet.selecao, bet.evento) === null;
}
