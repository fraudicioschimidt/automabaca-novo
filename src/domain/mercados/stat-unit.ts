import { statisticFamilyOf } from "@/src/domain/settlement/statistics";
import { HALF_PERIOD_ABBREVIATIONS, HALF_PERIOD_PHRASES } from "./classify";
import { keepDeclaredPeriod } from "./finalize";
import { selecaoPareceHandicap } from "./selection-shape";
import { hasNonScoreStatQualifier, isBothTeamsCardsText } from "./stat-qualifier";
import { normalizeStr } from "@/src/domain/text";
import { matchTeamSide } from "@/src/domain/settlement/sides";
import { looksLikeTotalSelection, separateCompactStatUnit } from "./total-direction";

/**
 * Promove mercado genérico (Total / Moneyline / AH) para o rótulo Pinnacle da
 * estatística quando a seleção (ou a legenda) declara a unidade.
 *
 * Cantos e cartões podem aparecer em catálogos separados do placar principal
 * `(Corners)` / `(Bookings)` com `totals`/`spreads` no período `Game` ou `Half 1`.
 * O vocabulário persistido achata isso no mercado — uma implementação, captura
 * e coerção.
 */
const ASIAN_CARDS =
  /\b(?:total\s*(?:de\s*)?cart(?:[õo]es?|oes|eos)\s*asi[aá]ticos?|asian\s*total\s*cards?|cart(?:[õo]es?|oes|eos)\s*asi[aá]ticos?)\b/i;
const ASIAN_CORNERS =
  /\b(?:total\s*(?:de\s*)?escanteios?\s*asi[aá]ticos?|asian\s*total\s*corners?|asian\s*corners?|escanteios?\s*asi[aá]ticos?)\b/i;
const ASIAN_1H_CORNERS =
  /\b1(?:st|º|°)?\s*(?:half|tempo)(?:\s*[-–]\s*|\s+)(?:(?:asian\s*)?(?:total\s*)?(?:de\s*)?escanteios?\s*asi[aá]ticos?|asian\s*corners?)\b/i;
const ASIAN_HCP_CORNERS =
  /\b(?:handicap\s*asi[aá]tico(?:\s*[-–]\s*|\s+)(?:de\s+)?(?:escanteios?|cantos?)|asian\s*handicap\s*corners?)\b/i;
const CARDS = /\b(?:cards?|bookings?|cart(?:[õo]es?|oes|eos))\b/i;
const CORNERS = /\b(?:corners?|escanteios?|cantos?|(?:a\s+cantos?))\b/i;
const CARD_COLOR = /\b(?:yellow|red|amarel[oa]s?|vermelh[oa]s?)\b/i;
const TOTAL_SHOTS = /\b(?:shots?|remates?)\b/i;
const SHOTS_ON_TARGET =
  /\b(?:on\s+(?:target|goal)|ao?\s+gol|no\s+(?:gol|alvo)|a\s+baliza|enquadrad[oa]s?)\b/i;
const EXPLICIT_TEAM_SHOTS =
  /\b(?:team\s+total|(?:team|time|equipe)\s*(?:1|2|da casa|visitante|home|away)|home\s+team|away\s+team)\b/i;

const FIRST_HALF_RE = new RegExp(
  String.raw`\b(?:${HALF_PERIOD_PHRASES.first.join("|")}|${HALF_PERIOD_ABBREVIATIONS.first.join("|")})\b`,
);

function textoDePrimeiroTempo(text: string): boolean {
  // "1º tempo": o ordinal vira espaço, como no `marketPeriodOf`.
  return FIRST_HALF_RE.test(normalizeStr(text).replace(/[^a-z0-9+]+/g, " "));
}

/** O total de escanteios, no 1º tempo quando o texto o declara. */
function totalDeCantos(blob: string): string {
  return textoDePrimeiroTempo(blob) ? "Total (Corners) – 1st Half" : "Corners O/U";
}

function temCartoes(selecao: string, extraText: string): boolean {
  return CARDS.test(selecao) || CARDS.test(extraText);
}

export function inferPinnacleStatMarket(
  mercado: string,
  selecao: string,
  extraText = "",
  evento = "",
  esporte = "",
): string {
  const inferred = inferStatMarket(mercado, selecao, extraText, evento, esporte);
  const marketFamily = statisticFamilyOf(mercado, "", evento, esporte);
  if (marketFamily) {
    const originalFamily = statisticFamilyOf(mercado, selecao, evento, esporte);
    // Inferir serve para completar o genérico; uma unidade explícita não
    // pode sumir, nem um conflito virar a escolha silenciosa de uma delas.
    if (originalFamily === null || statisticFamilyOf(inferred, selecao, evento, esporte) !== originalFamily) return mercado;
  }
  return keepDeclaredPeriod(mercado, inferred, esporte);
}

function inferStatMarket(
  mercado: string,
  selecao: string,
  extraText: string,
  evento: string,
  esporte: string,
): string {
  // Um qualificador individual não pode virar total de chutes/cartões do jogo.
  if (/\b(?:player|jogador|jogadora|atleta)\b/i.test(mercado)) return mercado;
  selecao = separateCompactStatUnit(selecao);
  extraText = separateCompactStatUnit(extraText);
  const blob = `${mercado} ${selecao} ${extraText}`;

  if (ASIAN_HCP_CORNERS.test(blob)) return "Asian Handicap Corners";
  if (ASIAN_1H_CORNERS.test(blob)) return "1st Half Asian Corners";
  if (isBothTeamsCardsText(blob)) return "Both Teams Cards – Match";

  if (selecaoPareceHandicap(selecao)) {
    if (CORNERS.test(selecao) || (!CARDS.test(selecao) && CORNERS.test(extraText))) {
      return textoDePrimeiroTempo(blob) ? "1st Half Asian Corners" : "Asian Handicap Corners";
    }
    if (temCartoes(selecao, extraText)) return "Asian Handicap Cards";
  }

  if (!looksLikeTotalSelection(selecao)) return mercado;

  // Quando só a legenda nomeia a contagem, ela precisa sobreviver no rótulo:
  // conservar apenas "Total / Under 3.5" transformaria a entrada em gols.
  if (!hasNonScoreStatQualifier(mercado, selecao)) {
    const captionFamily = statisticFamilyOf(extraText, "", evento, esporte);
    if (captionFamily === "yellow_cards") return "Total Yellow Cards";
    if (captionFamily === "red_cards") return "Total Red Cards";
    if (captionFamily === "shots_on_target") return "Total Shots on Target";
  }

  // Remates TOTAIS e remates NO ALVO são unidades diferentes no FlashScore.
  // Só o catálogo de totais está aberto; a forma específica permanece
  // visível/fail-closed em vez de ser achatada para a estatística errada.
  if (normalizeStr(esporte) === "soccer" && TOTAL_SHOTS.test(blob)) {
    if (SHOTS_ON_TARGET.test(blob)) return mercado;
    const porTime = EXPLICIT_TEAM_SHOTS.test(mercado) ||
      (evento.length > 0 && matchTeamSide(selecao, evento) !== null);
    return porTime ? "Team Total (Shots) – Match" : "Total (Shots) – Match";
  }

  if (ASIAN_CARDS.test(blob)) return "Asian Total Cards";
  if (ASIAN_CORNERS.test(blob)) {
    return textoDePrimeiroTempo(blob) ? "Total (Corners) – 1st Half" : "Asian Total Corners";
  }

  // A seleção (e a legenda) vencem o rótulo genérico. O mercado atual fica de
  // fora desta detecção: "Cartões Amarelos / Over 1.5" não é Bookings (amarelo
  // ≠ ponto de cartão), e "Total (Corners) / Over 8.5" já está no final certo.
  if (CARDS.test(selecao) && !CARD_COLOR.test(selecao)) return "Total Cards";
  if (CORNERS.test(selecao)) return totalDeCantos(blob);
  if (temCartoes(selecao, extraText) && !CARD_COLOR.test(`${selecao} ${extraText}`)) {
    return "Total Cards";
  }
  // A seleção já não tem cantos aqui: só a legenda os nomeia.
  if (CORNERS.test(extraText)) return totalDeCantos(blob);

  return mercado;
}
