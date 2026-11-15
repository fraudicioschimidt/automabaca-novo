import type { BetStatus } from "@/src/domain/bet-status";
import { computeLucroFromStatus } from "@/src/domain/lucro";
import { isMercadoFinal } from "@/src/domain/mercados/catalog";
import { isMercadoFinalForSport, isRegulationTimeMarket } from "@/src/domain/mercados/compatibility";
import { bttsSelectionSide, isEsports, marketPeriodOf, totalLabelSide } from "@/src/domain/mercados/classify";
import { totalDirectionOf } from "@/src/domain/mercados/total-direction";
import { selecaoNomeiaTimeDoTotal } from "@/src/domain/mercados/selection-shape";
import { normalizeStr } from "@/src/domain/text";
import {
  mentionsLiveEntry,
  resolveLiveScoreAtTip,
  stripLiveScoreAtTip,
} from "@/src/domain/live-score-at-tip";
import { extractSignedNumbers, parseLineQuarters, statusFromAdjustedQuarters, withoutNumberedHalf } from "./lines";
import { isBasketballFirstHalf, supportsBasketballFirstHalf } from "./basketball-half";
import {
  classifyScoreMarket,
  declaredScorePeriod,
  hasNonScoreStatQualifier,
  hasScoreUnitMismatch,
  hasUnknownScoreQualifier,
} from "./markets";
import {
  matchDoubleChanceSelection,
  matchDrawNoBetSelection,
  matchMoneylineSelection,
  resolveSideFromMarketAndSelection,
  stripTeamNames,
} from "./sides";

/**
 * Resolução de resultado por placar. Linhas em quartos inteiros (sem epsilon),
 * ambiguidade recusa com motivo, DNB e Dupla Chance resolvem nativamente.
 */

export type ScoreResolutionFailure =
  | "unsupported_market"
  | "stat_qualifier"
  | "score_unit_mismatch"
  | "wrong_period"
  | "missing_line"
  | "invalid_line"
  | "ambiguous_selection"
  | "incomplete_legs"
  | "parlay_fractional_or_void_requires_manual"
  | "incomplete_live_score"
  | "invalid_live_score"
  | "conflicting_live_score"
  | "live_score_after_final"
  | "unsupported_live_score"
  | "invalid_score"
  | "invalid_stake"
  | "invalid_odds";

export type ScoreResolution =
  | { ok: true; status: BetStatus; lucro: number }
  | { ok: false; reason: ScoreResolutionFailure };

/** Período que um placar representa. FT = jogo inteiro (sem prorrogação à parte). */
/** `REGULATION`: o placar sem a prorrogação, para os mercados do tempo regulamentar. */
export type ScorePeriod = "FT" | "HT" | "SECOND_HALF" | "REGULATION";

type Refusal = { ok: false; reason: ScoreResolutionFailure };
type KindResult = { ok: true; status: BetStatus } | Refusal;
type ScoreKind = NonNullable<ReturnType<typeof classifyScoreMarket>>;

/** O que cada família de mercado precisa depois das guardas comuns. */
type ScoreContext = {
  kind: ScoreKind;
  mercado: string;
  /** Seleção sem o placar ao vivo anotado na tip. */
  selecao: string;
  selecaoN: string;
  evento: string;
  esporte?: string;
  /** Placar final recebido. */
  homeScore: number;
  awayScore: number;
  /**
   * Placar que conta para a aposta: o final menos o placar no instante da tip.
   * Só o handicap aceita tip ao vivo; nos demais os dois placares coincidem.
   */
  settlementHomeScore: number;
  settlementAwayScore: number;
};

export function resolveResultFromScore(params: {
  mercado: string;
  selecao: string;
  evento: string;
  esporte?: string;
  homeScore: number;
  awayScore: number;
  liveScoreHome?: number | null;
  liveScoreAway?: number | null;
  /** `Bet.liveTextAtCapture`: a legenda dizia ao vivo. Gravado, não relido da evidência que expira. */
  liveTextAtCapture?: boolean;
  odds: number;
  stake: number;
  /**
   * Qual período o placar recebido representa. Omissão = FT.
   *
   * `HT` no basquete exige o contrato próprio (`supportsBasketballFirstHalf`).
   * No futebol, `HT` e `SECOND_HALF` vêm dos parciais do FlashScore.
   */
  scorePeriod?: ScorePeriod;
}): ScoreResolution {
  const context = scoreContext(params);
  if (!context.ok) return context;
  const result = resolveByKind(context.value);
  if (!result.ok) return result;
  return {
    ok: true,
    status: result.status,
    lucro: computeLucroFromStatus({
      status: result.status,
      stake: params.stake,
      odds: params.odds,
      currentLucro: 0,
    }),
  };
}

/** Guardas comuns a todo mercado de placar, na ordem em que recusam. */
function scoreContext(
  params: Parameters<typeof resolveResultFromScore>[0],
): { ok: true; value: ScoreContext } | Refusal {
  const { mercado, evento, esporte, homeScore, awayScore, odds, stake } = params;
  const originalSelecao = params.selecao;
  const liveScore = resolveLiveScoreAtTip({
    liveScoreHome: params.liveScoreHome,
    liveScoreAway: params.liveScoreAway,
    texts: [originalSelecao],
    market: mercado,
    requireStructured: true,
  });
  if (!liveScore.ok) return { ok: false, reason: liveScore.reason };
  const selecao = stripLiveScoreAtTip(originalSelecao, mercado);

  if (
    !Number.isInteger(homeScore) ||
    !Number.isInteger(awayScore) ||
    homeScore < 0 ||
    awayScore < 0
  ) {
    return { ok: false, reason: "invalid_score" };
  }
  if (!Number.isFinite(stake) || stake <= 0) {
    return { ok: false, reason: "invalid_stake" };
  }
  if (!Number.isFinite(odds) || odds <= 1) {
    return { ok: false, reason: "invalid_odds" };
  }
  if (
    esporte &&
    (isMercadoFinal(mercado) || isRegulationTimeMarket(mercado)) &&
    !isMercadoFinalForSport(mercado, esporte)
  ) {
    return { ok: false, reason: "unsupported_market" };
  }

  if (hasNonScoreStatQualifier(mercado, selecao)) {
    return { ok: false, reason: "stat_qualifier" };
  }
  // Linha em games/sets (tênis): o placar do feed é em SETS.
  if (hasScoreUnitMismatch(mercado, selecao, esporte)) {
    return { ok: false, reason: "score_unit_mismatch" };
  }
  // O placar tem que ser o DO PERÍODO que o mercado declara: um total de 1º
  // tempo contra o placar de 90 minutos liquidaria outra aposta. Quem chama
  // declara o período do placar que passa; sem declaração vale FT.
  const periodoDoPlacar = params.scorePeriod ?? "FT";
  const periodoDoMercado = isRegulationTimeMarket(mercado)
    // A seleção ainda pode declarar outra fase ("1º tempo"): aí não é o regulamentar.
    ? (marketPeriodOf(selecao, esporte) === "FT" ? "REGULATION" : "OTHER")
    : declaredScorePeriod({ mercado, selecao, esporte });
  const basqueteHT = isBasketballFirstHalf({ mercado, selecao, esporte });
  if (periodoDoMercado !== periodoDoPlacar
    || (basqueteHT && !supportsBasketballFirstHalf({ mercado, selecao, esporte, evento }))) {
    return { ok: false, reason: "wrong_period" };
  }
  if (hasUnknownScoreQualifier(mercado)) {
    return { ok: false, reason: "unsupported_market" };
  }
  const selecaoN = normalizeStr(selecao);
  const kind = classifyScoreMarket(normalizeStr(mercado), selecaoN, evento);
  if (!kind) return { ok: false, reason: "unsupported_market" };

  const tipScore = liveScore.score;
  // Placar ao vivo é do JOGO inteiro; o do período não se deduz dele.
  if ((params.scorePeriod === "HT" || params.scorePeriod === "SECOND_HALF") && (tipScore !== null
    || params.liveScoreHome != null || params.liveScoreAway != null
    || params.liveTextAtCapture === true
    || [originalSelecao, mercado].some(mentionsLiveEntry))) {
    return { ok: false, reason: "unsupported_live_score" };
  }
  // Handicap ao vivo sem o placar da entrada liquidaria o jogo inteiro onde a
  // casa paga só o restante: sem o par estruturado, recusa.
  if (kind === "handicap" && tipScore === null && (params.liveTextAtCapture === true
    || [originalSelecao, mercado].some(mentionsLiveEntry))) {
    return { ok: false, reason: "incomplete_live_score" };
  }
  const isLive = tipScore !== null && (tipScore.home > 0 || tipScore.away > 0);
  if (isLive && kind !== "handicap") {
    return { ok: false, reason: "unsupported_live_score" };
  }
  if (
    isLive &&
    (homeScore < tipScore.home || awayScore < tipScore.away)
  ) {
    return { ok: false, reason: "live_score_after_final" };
  }
  return {
    ok: true,
    value: {
      kind,
      mercado,
      selecao,
      selecaoN,
      evento,
      esporte,
      homeScore,
      awayScore,
      settlementHomeScore: isLive ? homeScore - tipScore.home : homeScore,
      settlementAwayScore: isLive ? awayScore - tipScore.away : awayScore,
    },
  };
}

function resolveByKind(context: ScoreContext): KindResult {
  switch (context.kind) {
    case "handicap": return resolveHandicap(context);
    case "total": return resolveTotal(context);
    case "team_total": return resolveTeamTotal(context);
    case "btts": return resolveBtts(context);
    case "moneyline": return resolveMoneyline(context);
    case "draw_no_bet": return resolveDrawNoBet(context);
    case "double_chance": return resolveDoubleChance(context);
  }
}

/**
 * Linha da seleção; na falta dela, a do RÓTULO ("Asian Handicap 0" / "Total
 * 2.5"), para capturas que separam lado/direção e linha. Número inválido na
 * seleção é evidência conflitante, não autorização para usar o mercado.
 */
export function lineFromSelectionOrMarket(
  selectionText: string,
  marketText: string,
  allowNegative: boolean,
): number | null {
  const selectionLine = withoutNumberedHalf(selectionText);
  return parseLineQuarters(selectionLine, { allowNegative })
    ?? (extractSignedNumbers(selectionLine).length === 0
      ? parseLineQuarters(withoutNumberedHalf(marketText), { allowNegative })
      : null);
}

function unreadableLine(...texts: string[]): Refusal {
  return {
    ok: false,
    reason: texts.some((text) => extractSignedNumbers(text).length > 0)
      ? "invalid_line"
      : "missing_line",
  };
}

function overUnderStatus(direction: "over" | "under", totalQ: number, lineQ: number): BetStatus {
  return statusFromAdjustedQuarters(direction === "over" ? totalQ - lineQ : lineQ - totalQ);
}

function resolveHandicap(context: ScoreContext): KindResult {
  const { mercado, selecao, evento, esporte } = context;
  // Remove o nome do time ANTES de ler a linha: dígitos no nome do clube
  // corrompem o handicap.
  const lineText = stripTeamNames(selecao, evento);
  // `PK`/pick'em É a linha zero, a grafia americana do handicap sem vantagem.
  const lineQ = /\b(?:pk|pick\s*.?\s*em|level\s+ball)\b/.test(normalizeStr(lineText))
    ? 0
    : lineFromSelectionOrMarket(lineText, mercado, true);
  if (lineQ === null) return unreadableLine(lineText);
  if (lineOutsideSetScore({ lineQ, kind: "handicap", esporte, homeScore: context.homeScore, awayScore: context.awayScore })) {
    return { ok: false, reason: "score_unit_mismatch" };
  }
  // O lado tem duas fontes, o rótulo ("Away Asian Handicap") e o nome na
  // seleção; quando discordam, a recusa é do resolvedor de lado.
  const side = resolveSideFromMarketAndSelection(mercado, selecao, evento).side;
  if (!side) return { ok: false, reason: "ambiguous_selection" };
  const scoreDiff = side === "home"
    ? context.settlementHomeScore - context.settlementAwayScore
    : context.settlementAwayScore - context.settlementHomeScore;
  return { ok: true, status: statusFromAdjustedQuarters(4 * scoreDiff + lineQ) };
}

function resolveTotal(context: ScoreContext): KindResult {
  const { mercado, selecao, selecaoN, evento, esporte, homeScore, awayScore } = context;
  // Total do JOGO cuja seleção nomeia um time ("Flamengo over 1.5") é total
  // do time gravado com o rótulo errado: pelo placar somado, 1x1 pagaria.
  if (selecaoNomeiaTimeDoTotal(selecao, evento)) return { ok: false, reason: "ambiguous_selection" };
  // Times com número no nome (Mainz 05, Sub-20) não fazem parte da linha.
  const lineText = stripTeamNames(selecao, evento);
  const lineQ = lineFromSelectionOrMarket(lineText, mercado, false);
  if (lineQ === null) return unreadableLine(lineText);
  if (lineOutsideSetScore({ lineQ, kind: "total", esporte, homeScore, awayScore })) {
    return { ok: false, reason: "score_unit_mismatch" };
  }
  const direction = totalDirectionOf(selecaoN, { allowBarePositiveLine: true });
  if (!direction) return { ok: false, reason: "ambiguous_selection" };
  return { ok: true, status: overUnderStatus(direction, 4 * (homeScore + awayScore), lineQ) };
}

function resolveTeamTotal(context: ScoreContext): KindResult {
  const { mercado, selecao, selecaoN, evento } = context;
  // O lado tem DUAS fontes que podem se contradizer: o rótulo ("Home Total
  // Goals") e o nome do time na seleção. Contradição vira decisão humana.
  // O rótulo também nomeia o time no meio do nome do mercado ("Total de Gols
  // do Vasco"), que o resolvedor comum não separa do vocabulário de total.
  const labelSide = totalLabelSide(mercado, evento);
  const named = resolveSideFromMarketAndSelection(mercado, selecao, evento);
  const side = named.side ?? labelSide;
  if (!side || named.contradicts || (labelSide && labelSide !== side)) {
    return { ok: false, reason: "ambiguous_selection" };
  }
  const lineText = stripTeamNames(selecao, evento);
  // A linha pode estar no rótulo ("Home Team Total 1.5" / "Over"), sem ler
  // como linha os dígitos de clubes como Mainz 05.
  const marketLineText = stripTeamNames(mercado, evento);
  const lineQ = lineFromSelectionOrMarket(lineText, marketLineText, false);
  if (lineQ === null) return unreadableLine(lineText, marketLineText);
  const direction = totalDirectionOf(selecaoN, { allowBarePositiveLine: true });
  if (!direction) return { ok: false, reason: "ambiguous_selection" };
  const teamGoals = side === "home" ? context.homeScore : context.awayScore;
  return { ok: true, status: overUnderStatus(direction, 4 * teamGoals, lineQ) };
}

function resolveBtts(context: ScoreContext): KindResult {
  const side = bttsSelectionSide(context.selecao);
  if (!side) return { ok: false, reason: "ambiguous_selection" };
  const bothScored = context.homeScore > 0 && context.awayScore > 0;
  return { ok: true, status: (side === "yes" ? bothScored : !bothScored) ? "WON" : "LOST" };
}

function resolveMoneyline(context: ScoreContext): KindResult {
  const { homeScore, awayScore } = context;
  const selection = matchMoneylineSelection(context.selecao, context.evento);
  if (!selection) return { ok: false, reason: "ambiguous_selection" };
  const won = selection === "home"
    ? homeScore > awayScore
    : selection === "away"
      ? awayScore > homeScore
      : homeScore === awayScore;
  return { ok: true, status: won ? "WON" : "LOST" };
}

function resolveDrawNoBet(context: ScoreContext): KindResult {
  const { homeScore, awayScore } = context;
  const side = matchDrawNoBetSelection(context.selecao, context.evento);
  // Mesmo no empate o lado precisa ser identificável: "Sem empate" sem time
  // não prova qual aposta foi feita.
  if (!side) return { ok: false, reason: "ambiguous_selection" };
  if (homeScore === awayScore) return { ok: true, status: "VOID" };
  const won = side === "home" ? homeScore > awayScore : awayScore > homeScore;
  return { ok: true, status: won ? "WON" : "LOST" };
}

function resolveDoubleChance(context: ScoreContext): KindResult {
  const { homeScore, awayScore } = context;
  const covers = matchDoubleChanceSelection(context.selecao, context.evento);
  if (!covers) return { ok: false, reason: "ambiguous_selection" };
  const outcome: "home" | "away" | "draw" =
    homeScore > awayScore ? "home" : awayScore > homeScore ? "away" : "draw";
  return { ok: true, status: covers.includes(outcome) ? "WON" : "LOST" };
}

/**
 * Nos esportes de sets o placar do feed conta SETS, e a linha da aposta quase
 * sempre é de games ou pontos. `hasScoreUnitMismatch` recusa quando a unidade
 * está escrita ("Total (Games) 22.5"); sem a palavra ("Over 22.5"), a recusa
 * vem da própria linha: nenhum placar em sets chega perto dela.
 *
 * Máximo de sets de uma partida (melhor de 5 no tênis masculino e no vôlei,
 * melhor de 7 no tênis de mesa, melhor de 3 no vôlei de praia e no badminton).
 * O eSports conta MAPAS, melhor de 5 no máximo: "FURIA -4.5" é handicap de
 * rounds ou kills, que o placar em mapas não responde. Com o placar, o limite
 * é o do formato jogado (`playedSeriesLimits`).
 */
const MAX_SETS: Readonly<Record<string, number>> = {
  tennis: 5,
  volleyball: 5,
  "beach volleyball": 3,
  "table tennis": 7,
  badminton: 3,
  esports: 5,
};

/**
 * Linha de total a partir da qual nenhum esporte liquidável por placar tem
 * placar de até 4 por lado (o beisebol, o mais baixo com linha alta, fica em
 * 8.5 a 12.5). Vale sem esporte: a perna de tênis dentro de uma múltipla
 * herda o esporte do bilhete.
 */
const UNIVERSAL_TOTAL_LINE = 15.5;
const SET_LIKE_SIDE_MAX = 4;

/**
 * O placar final mostra o formato jogado: o vencedor leva ceil(n/2) sets ou
 * mapas, então 2-0 é melhor de 3, e ali "-2.5" ou "Over 3.5" não são de mapas.
 * O empate (1-1) é a melhor de 2 do eSports, com os dois somados.
 */
function playedSeriesLimits(homeScore: number, awayScore: number): { handicap: number; total: number } | null {
  if (homeScore === awayScore) return homeScore > 0 ? { handicap: 2 * homeScore, total: 2 * homeScore } : null;
  const wins = Math.max(homeScore, awayScore);
  return { handicap: wins, total: 2 * wins - 1 };
}

/** A linha não cabe num placar em sets: vai para manual, não para o placar. */
export function lineOutsideSetScore(params: {
  lineQ: number;
  kind: "total" | "handicap";
  esporte?: string | null;
  homeScore?: number;
  awayScore?: number;
}): boolean {
  const line = Math.abs(params.lineQ) / 4;
  const maxSets = MAX_SETS[isEsports(params.esporte) ? "esports" : normalizeStr(params.esporte ?? "")];
  if (maxSets !== undefined) {
    // Handicap de sets vai até a vantagem que cabe na partida: ±2.5 no
    // melhor de 5, ±3.5 no melhor de 7. Além disso é handicap de games.
    const sportLimit = params.kind === "total" ? maxSets : Math.ceil(maxSets / 2);
    const played = params.homeScore === undefined || params.awayScore === undefined
      ? null
      : playedSeriesLimits(params.homeScore, params.awayScore);
    const limit = Math.min(sportLimit, played ? played[params.kind] : sportLimit);
    if (line > limit) return true;
  }
  return params.kind === "total"
    && params.homeScore !== undefined
    && params.awayScore !== undefined
    && line >= UNIVERSAL_TOTAL_LINE
    && Math.max(params.homeScore, params.awayScore) <= SET_LIKE_SIDE_MAX;
}
