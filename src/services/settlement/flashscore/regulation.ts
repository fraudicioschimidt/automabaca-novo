import { normalizeMercadoKey } from "@/src/domain/mercados/catalog";
import { isRegulationTimeMarket } from "@/src/domain/mercados/compatibility";
import {
  isThreeWayHandicapMarket,
  marketIncludesExtraTime,
  marketKindOf,
} from "@/src/domain/mercados/classify";
import { matchMoneylineSelection } from "@/src/domain/settlement/sides";
import { getFlashscoreMatchSummary } from "@/src/providers/flashscore/client";
import type { FlashscoreMatchCandidate } from "@/src/providers/flashscore/match";
import { resolveFlashscoreRegulationScore } from "@/src/providers/flashscore/summary";
import type { FlashscoreMatch } from "@/src/providers/flashscore/types";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import {
  cachedPerMatch,
  listedFlashscoreScore,
  orientFlashscorePair,
  type FlashscorePair,
  type SummaryCache,
} from "./settle";

/**
 * Prorrogação e pênaltis: quando o placar listado (agregado) paga a aposta, e
 * quando é preciso reconstruir os 90 minutos pelo resumo de gols.
 */

export type RegulationScoreEvidence = {
  source: "flashscore_summary";
  score: FlashscorePair;
  aggregateScore: FlashscorePair;
  goalEvents: number;
  extraTimeGoalEvents: number;
};

export async function loadFlashscoreRegulationScore(params: {
  candidate: FlashscoreMatchCandidate;
  cache: SummaryCache;
}): Promise<RegulationScoreEvidence | null> {
  const match = params.candidate.match;
  const listedScore = listedFlashscoreScore(match);
  if (!listedScore) return null;
  const summary = await cachedPerMatch(params.cache, match.match_id, getFlashscoreMatchSummary);
  if (!summary) return null;
  const evidence = resolveFlashscoreRegulationScore({ summary, listedScore });
  if (!evidence) return null;
  const score = orientFlashscorePair(evidence.regulationScore, params.candidate.swapped);
  const aggregateScore = orientFlashscorePair(evidence.aggregateScore, params.candidate.swapped);
  if (!score || !aggregateScore) return null;
  return {
    source: "flashscore_summary",
    score,
    aggregateScore,
    goalEvents: evidence.goalEvents,
    extraTimeGoalEvents: evidence.extraTimeGoalEvents,
  };
}

/**
 * Esportes cujo placar listado de jogo completo já inclui a prorrogação.
 * Basquete (sportId 3): Money Line / Total / Handicap de jogo liquidam pelo
 * placar final com OT; o resumo de gols (~90') é contrato de futebol.
 */
export function flashscoreListedScoreIncludesOvertime(sportId: number): boolean {
  return sportId === 3;
}

const REGULATION_ONLY_MARKET =
  /\b(?:1x2|3\s*way|three\s*way|3\s*vias?|tempo regulamentar|regular time|regulation time|regulation)\b|\(tr\)/;

/**
 * A aposta é sobre o resultado do TEMPO NORMAL, onde o empate existe: 1X2,
 * mercado de 3 vias, seleção no empate, Dupla Chance, Empate Anula e handicap
 * europeu. No basquete o placar listado inclui a prorrogação e nunca empata;
 * por ele, "Empate" com 100-100 no tempo normal sairia LOST e "1X2 Lakers"
 * com 110-105 na prorrogação sairia WON — os dois ao contrário.
 */
export function betsOnRegulationResult(term: { mercado: string; selecao: string; evento: string }): boolean {
  if (isRegulationTimeMarket(term.mercado)) return true;
  if (marketIncludesExtraTime(term.mercado) || marketIncludesExtraTime(term.selecao)) return false;
  const kind = marketKindOf(term.mercado, term.selecao, term.evento);
  if (kind === "draw_no_bet" || kind === "double_chance") return true;
  if (isThreeWayHandicapMarket(term.mercado)) return true;
  if (REGULATION_ONLY_MARKET.test(normalizeMercadoKey(`${term.mercado} ${term.selecao}`))) return true;
  return matchMoneylineSelection(term.selecao, term.evento) === "draw";
}

/**
 * O resumo de gols reconstrói 90 minutos: é contrato de FUTEBOL (sportId 1).
 * No hóquei a prorrogação começa aos 60' e o reconstrutor contaria o gol dela
 * como tempo regulamentar; fora do futebol, jogo decidido na prorrogação vai
 * para manual.
 */
export function flashscoreRegulationSummaryApplies(sportId: number): boolean {
  return sportId === 1;
}

type ExtraTimeStatus = Pick<
  FlashscoreMatch["match_status"],
  "is_finished" | "is_finished_after_extra_time" | "is_finished_after_penalties"
> & { stage?: string | null };

/**
 * Como o jogo encerrado terminou, pelas flags E pelo estágio: o feed já mandou
 * "After Extra Time"/"After Overtime"/"After Penalties" com as flags ausentes,
 * e flag faltando não pode virar "terminou no tempo normal".
 */
function extraTimeState(status: ExtraTimeStatus): { extraTime: boolean; penalties: boolean } {
  if (!status.is_finished) return { extraTime: false, penalties: false };
  const stage = (status.stage ?? "").toLowerCase();
  const penalties = status.is_finished_after_penalties === true || /\bafter\s+penalt/.test(stage);
  const extraTime = status.is_finished_after_extra_time === true || /\bafter\s+(?:extra\s*time|overtime)\b/.test(stage);
  return { extraTime, penalties };
}

export function decidedInExtraTime(status: ExtraTimeStatus): boolean {
  const state = extraTimeState(status);
  return state.extraTime || state.penalties;
}

/**
 * Promessa de prorrogação de UMA leitura (aposta ou perna): a frase pode estar
 * no mercado ou na seleção ("Over 2.5 incluindo prorrogação").
 */
function promisesExtraTime(term: { mercado: string; selecao?: string }): boolean {
  return marketIncludesExtraTime(term.mercado) || marketIncludesExtraTime(term.selecao ?? "");
}

export type FlashscoreRegulationContext = {
  decidedInExtraTime: boolean;
  /**
   * A prorrogação foi jogada de fato: a flag ou o estágio dizem, ou houve gol
   * depois dos 90'. Pênaltis sozinhos não provam: há copa que vai direto a eles.
   */
  extraTimePlayed: boolean;
  extraTimeCompatible: boolean;
  regulationEvidence: RegulationScoreEvidence | null;
  /**
   * A aposta pede os 90' e o resumo foi consultado: com `regulationEvidence`
   * null, o resumo ainda não bastou (sai com atraso), não "não se aplica".
   */
  regulationAttempted: boolean;
};

/** Aposta simples: o agregado vale, ou é obrigatório reconstruir os 90 minutos? */
export async function loadFlashscoreRegulationContext(params: {
  candidate: FlashscoreMatchCandidate;
  mercado: string;
  /** A frase "incluindo prorrogação" também chega pela seleção. */
  selecao?: string;
  /** Pernas de um "Criar Aposta" do mesmo jogo: cada uma tem a sua promessa. */
  legs?: readonly { mercado: string; selecao: string }[];
  scoreOnlyMarket: boolean;
  cache: SummaryCache;
  /** Basquete e afins não usam a reconstrução de 90'. */
  sportId: number;
  /** Para ler a seleção no empate ("Empate", "X", "Lakers ou Empate"). */
  evento: string;
}): Promise<FlashscoreRegulationContext> {
  const status = params.candidate.match.match_status;
  const extraTime = decidedInExtraTime(status);
  const state = extraTimeState(status);
  const readings = (params.legs ?? []).length > 0
    ? params.legs!.map((leg) => ({ mercado: leg.mercado, selecao: leg.selecao, evento: params.evento }))
    : [{ mercado: params.mercado, selecao: params.selecao ?? "", evento: params.evento }];
  // O placar com prorrogação só paga quem aposta no jogo inteiro; quem aposta
  // no tempo normal cai no bloqueio abaixo e vai para o operador.
  const listedIncludesOvertime = flashscoreListedScoreIncludesOvertime(params.sportId) &&
    !readings.some(betsOnRegulationResult);
  // Cada leitura (a aposta, ou cada perna herdando o MERCADO da aposta) promete
  // 120' ou 90'. Só o placar listado paga quem promete 120'; só a reconstrução
  // paga quem promete 90'. Mistura não tem número que pague as duas.
  //
  // Com pernas, a seleção da aposta guarda o texto inteiro do bilhete: herdar
  // dela faria a frase de uma perna valer para o "Casa" de 90' da outra.
  const legs = params.legs ?? [];
  const betPromise = legs.length > 0
    ? promisesExtraTime({ mercado: params.mercado })
    : promisesExtraTime({ mercado: params.mercado, selecao: params.selecao });
  const legPromises = legs.map(promisesExtraTime);
  // No registro, o mercado da Bet pode ser o da primeira perna. Se ela já
  // declara prorrogação, o rótulo da raiz não estende essa regra às outras.
  const globalPromise = betPromise && !legPromises.some(Boolean);
  const promises = legs.length > 0
    ? legPromises.map((promise) => globalPromise || promise)
    : [betPromise];
  const allExtraTime = listedIncludesOvertime || promises.every(Boolean);
  const anyExtraTime = listedIncludesOvertime || promises.some(Boolean);
  // Pênaltis não entram no placar de bola rolando: nem quem promete 120' se
  // paga pelo listado quando houve disputa de pênaltis.
  const extraTimeCompatible = allExtraTime && state.extraTime && !state.penalties;
  // A reconstrução de 90' só serve a quem prometeu 90'.
  const regulationAttempted =
    extraTime &&
    !extraTimeCompatible &&
    !anyExtraTime &&
    flashscoreRegulationSummaryApplies(params.sportId) &&
    params.scoreOnlyMarket;
  const regulationEvidence = regulationAttempted
    ? await loadFlashscoreRegulationScore({
        candidate: params.candidate,
        cache: params.cache,
      })
    : null;
  return {
    decidedInExtraTime: extraTime,
    extraTimePlayed: state.extraTime || (regulationEvidence?.extraTimeGoalEvents ?? 0) > 0,
    extraTimeCompatible,
    regulationEvidence,
    regulationAttempted,
  };
}

/** Jogo que foi à prorrogação e que a liquidação automática não decide. */
export async function alertExtraTimeManual(
  bet: { id: string; evento: string; selecao: string },
  score: FlashscorePair | null,
  why = "e não consegui decidir sozinho qual placar vale para esta aposta",
): Promise<void> {
  await sendOperationalAlert(
    `✋ Liquidar à mão · ${bet.evento}\n` +
      `${bet.selecao}\n` +
      `O jogo foi para a prorrogação ou pênaltis${score ? ` (placar listado ${score.home}-${score.away})` : ""}, ` +
      `${why}.\n` +
      "👉 Confira na casa se o mercado conta prorrogação e pênaltis e liquide em Operações.",
    {
      source: "settlement.flashscore-extra-time",
      key: bet.id,
      title: `Liquidação manual (prorrogação): ${bet.evento}`,
      resource: "bet",
      resourceId: bet.id,
      autoResolve: false,
    },
  );
}

/** O placar listado paga a promessa da perna, ou é preciso reconstruir 90'. */
export type TicketFixtureExtraTimeNeed = "aggregate" | "regulation" | "blocked";

/**
 * Prorrogação numa múltipla, decidida por CONFRONTO: numa tripla só o jogo que
 * foi à prorrogação precisa dos 90'. Confronto cujas pernas misturam as duas
 * promessas fica bloqueado — um placar por evento não paga as duas leituras.
 */
export function ticketFixtureExtraTimeNeed(params: {
  status: ExtraTimeStatus;
  mercados: readonly string[];
  sportId?: number;
  /** Alguma perna do confronto aposta no tempo normal (`betsOnRegulationResult`). */
  regulationOnly?: boolean;
}): TicketFixtureExtraTimeNeed {
  if (!decidedInExtraTime(params.status)) return "aggregate";
  const state = extraTimeState(params.status);
  // Basquete etc.: o placar listado já é o FT com OT — não reconstruir 90'.
  // A perna de tempo normal não tem esse placar: nada a reconstruir, bloqueia.
  if (params.sportId != null && flashscoreListedScoreIncludesOvertime(params.sportId)) {
    if (state.penalties || params.regulationOnly) return "blocked";
    return "aggregate";
  }
  // Confronto sem perna conhecida não tem promessa para conferir: fail-closed.
  if (params.mercados.length === 0) return "blocked";
  const includes = params.mercados.map((mercado) => marketIncludesExtraTime(mercado));
  if (includes.some(Boolean)) {
    // Pênaltis não entram no placar de bola rolando nem quando o mercado diz
    // incluir prorrogação — mesmo recorte da aposta simples.
    const extraTimeCompatible = state.extraTime && !state.penalties;
    return includes.every(Boolean) && extraTimeCompatible ? "aggregate" : "blocked";
  }
  if (params.sportId != null && !flashscoreRegulationSummaryApplies(params.sportId)) return "blocked";
  return "regulation";
}
