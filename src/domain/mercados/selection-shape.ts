import { expandAbbreviatedDirection, looksLikeTotalSelection } from "./total-direction";
import { normalizeStr } from "@/src/domain/text";
import { prefixoAntesDaLinha } from "@/src/domain/settlement/over-under-subject";
import { parseLineQuarters } from "@/src/domain/settlement/lines";
import { matchTeamSide, stripTeamNames } from "@/src/domain/settlement/sides";
import { trailingTeamCandidateOfSelection } from "./trailing-side";

/** A trailing quoted price is metadata, never a handicap/total line. */
export function stripSelectionOdds(selection: string): string {
  return selection.replace(/\s*@\s*\d+(?:[.,]\d+)?\s*$/, "").trim();
}

/** A named eSports player, distinct from either fixture team. */
export function isEsportsPlayerSelection(selecao: string, evento: string): boolean {
  const subject = prefixoAntesDaLinha(selecao);
  return Boolean(/\b(?:kills?|deaths?|abates?|mortes?)\b/.test(normalizeStr(selecao)) && subject
    && /[a-z]/i.test(subject) && !matchTeamSide(subject, evento)
    && !/\b(?:total|totais|kills?|deaths?|abates?|mortes?|time|team|mapa?|jogador|player)\b/i.test(subject));
}

/**
 * A linha de um total como a liquidação a lê: o "1" de "1T Over 110.5" é o
 * período. Quando a liquidação não lê a linha ("U3.5", "O2.5"), vale o
 * primeiro número, para a escala do esporte continuar conferida.
 */
export function selectionTotalLine(selecao: string, evento: string): number | null {
  const quarters = parseLineQuarters(stripTeamNames(selecao, evento), { allowNegative: false });
  if (quarters !== null) return quarters / 4;
  const first = Number(selecao.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(",", ".") ?? Number.NaN);
  return Number.isFinite(first) ? first : null;
}

/** Time/lado seguido de linha; `+2.5` nu continua ambíguo. */
export function selecaoPareceHandicap(selecao: string): boolean {
  selecao = stripSelectionOdds(selecao);
  if (looksLikeTotalSelection(selecao)) return false;
  const normalized = normalizeStr(selecao).replace(/\s+/g, " ").trim();
  // Sem sinal, só a forma DECIMAL é inequívoca o bastante: "Flamengo 0.5"
  // é linha, enquanto inteiros podem pertencer ao nome/categoria do time.
  const line = normalized.match(
    /(?:^|\s)(?:[+-]\d+(?:[.,]\d+)?|\d+[.,]\d+)(?:\s*[,/]\s*[+-]?\d+(?:[.,]\d+)?)?(?:\s*(?:a\s+)?(?:cantos?|escanteios?|corners?|cart(?:[õo]es?|oes|eos)|cards?))?$/,
  );
  if (!line || line.index === undefined) return false;
  const prefix = normalized.slice(0, line.index).trim();
  if (!/[a-z]/.test(prefix)) return false;
  if (/^(?:over|under|ov|un|o|u|mais|menos|acima|abaixo)$/i.test(prefix)) return false;
  return true;
}

/**
 * A seleção nomeia o TIME do total ("Flamengo mais de 0.5", "Over 1.5 do
 * Flamengo") — confirmado contra o evento, nunca por parecer nome. Coagir para
 * `Total` apagaria o time e liquidaria pelo placar agregado (um 0x3 pagaria
 * "Flamengo mais de 0.5"). A captura usa isto para escolher Team Total e a
 * liquidação para recusar um total de jogo que nomeia um time. A direção
 * abreviada ("Flamengo O 1.5") nomeia o time do mesmo jeito.
 */
export function selecaoNomeiaTimeDoTotal(selecao: string, evento: string): boolean {
  const prefixo = normalizeStr(expandAbbreviatedDirection(selecao))
    .replace(/[^a-z0-9]+/g, " ")
    .match(/^(.+?)\s+\b(?:over|under|mais|menos|acima|abaixo)\b/)?.[1]
    ?.trim();
  if (prefixo && /[a-z]/.test(prefixo) && matchTeamSide(prefixo, evento)) return true;
  const trailing = trailingTeamCandidateOfSelection(selecao);
  return Boolean(trailing && matchTeamSide(trailing, evento));
}

/**
 * Handicap europeu (3 vias) declarado na própria seleção: "Flamengo -1
 * (Handicap Europeu)", "Handicap 3 vias Flamengo -1". O rótulo do mercado pode
 * ter vindo genérico; a seleção é a evidência da mecânica sem push.
 */
export function declaresEuropeanHandicap(selecao: string): boolean {
  return /\b(?:europeu|european|europeo|europea|3\s*vias?|3\s*way|three\s*way|tres\s*vias)\b/.test(normalizeStr(selecao));
}
