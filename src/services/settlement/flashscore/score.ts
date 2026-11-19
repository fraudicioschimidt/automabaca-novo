import {
  ehMercadoArtilheiro,
  ehMercadoArtilheiroPorTempo,
  type JogadorDaPartida,
  type OrderedGoal,
} from "@/src/domain/settlement/goalscorer";
import { toNumber } from "@/src/domain/money";
import { declaredScorePeriod } from "@/src/domain/settlement/markets";
import { hasNonScoreStatQualifier } from "@/src/domain/mercados/stat-qualifier";
import { classificarPropDeJogador } from "@/src/domain/settlement/player-prop-classify";
import {
  resolveTicketFromScore,
  ticketForScore,
  type EligibleBet,
  type PeriodScores,
} from "@/src/domain/settlement/ticket-resolution";
import { createLogger } from "@/src/infra/logger";
import {
  getFlashscoreMatchPlayerStats,
  getFlashscoreMatchSummary,
} from "@/src/providers/flashscore/client";
import { normalizeFlashscorePlayers } from "@/src/providers/flashscore/player-stats";
import { soccerPeriodScores } from "@/src/providers/flashscore/soccer-periods";
import { orderedGoalsFromFlashscoreSummary } from "@/src/providers/flashscore/summary";
import { alertExtraTimeManual, type FlashscoreRegulationContext } from "./regulation";
import { settleFromFlashscoreScore } from "./score-settle";
import {
  awaitFlashscoreDetail,
  cachedPerMatch,
  fetchMatchDetails,
  marcarInferido,
  orientFlashscorePair,
  STATS_GRACE_MS,
  type DetailsCache,
  type FlashscorePair,
  type PlayerStatsCache,
  type SummaryCache,
} from "./settle";
import { alertFlashscoreStatManual } from "./statistics";

/**
 * Aposta de um jogo só pelo placar: reúne o que o bilhete pede além do placar
 * final (parciais de 1º/2º tempo, lista de jogadores, minuto dos gols) e
 * entrega a `settleFromFlashscoreScore`.
 */

const log = createLogger("flashscore-parciais");

type LegTerms = { mercado: string; selecao: string; evento: string };

function isPlayerGoalLeg(leg: LegTerms): boolean {
  return ehMercadoArtilheiro(leg.mercado, leg.selecao)
    || ehMercadoArtilheiroPorTempo(leg.mercado, leg.selecao);
}

function isPlayerPropLeg(leg: LegTerms, esporte: string): boolean {
  return classificarPropDeJogador({
    mercado: leg.mercado,
    selecao: leg.selecao,
    esporte,
    evento: leg.evento,
  }) !== null;
}

/**
 * O bilhete pede estatística que o placar não mede — e que NÃO sabemos
 * resolver? Perna de artilheiro e prop de jogador têm resolvedor próprio (a
 * lista de jogadores); as demais estatísticas seguem em manual. A aposta
 * SIMPLES de prop tem caminho próprio no orquestrador e nunca cai no placar.
 */
function ticketDeclaresNonScoreStat(bet: EligibleBet): boolean {
  if (hasNonScoreStatQualifier(bet.mercado, bet.selecao)) return true;
  return (ticketForScore(bet)?.legs ?? []).some((leg) =>
    hasNonScoreStatQualifier(leg.mercado, leg.selecao)
    && !isPlayerGoalLeg(leg)
    && !isPlayerPropLeg(leg, bet.esporte));
}

/** Perna que sai da lista de jogadores: artilheiro ou prop com estatística. */
function precisaDeJogadores(bet: EligibleBet): boolean {
  return (ticketForScore(bet)?.legs ?? []).some((leg) =>
    isPlayerGoalLeg(leg) || isPlayerPropLeg(leg, bet.esporte));
}

/**
 * Perna de gol por TEMPO precisa do minuto de cada gol, e minuto só o resumo da
 * partida tem — as estatísticas por jogador são todas do jogo inteiro.
 */
function precisaDosMinutos(bet: EligibleBet): boolean {
  return (ticketForScore(bet)?.legs ?? []).some((leg) =>
    ehMercadoArtilheiroPorTempo(leg.mercado, leg.selecao));
}

/** A aposta pede placar de 1º ou 2º tempo — nela mesma ou em alguma perna? */
function precisaDeParciais(bet: EligibleBet): boolean {
  const periodos = [
    declaredScorePeriod({ mercado: bet.mercado, selecao: bet.selecao, esporte: bet.esporte }),
    ...(ticketForScore(bet)?.legs ?? []).map((leg) =>
      declaredScorePeriod({ mercado: leg.mercado, selecao: leg.selecao, esporte: bet.esporte })),
  ];
  return periodos.some((periodo) => periodo === "HT" || periodo === "SECOND_HALF");
}

async function golsComMinuto(params: {
  bet: EligibleBet; matchId?: string; listedScore?: FlashscorePair | null; cache?: SummaryCache;
}): Promise<readonly OrderedGoal[] | null> {
  if (!params.matchId || !params.listedScore || !precisaDosMinutos(params.bet)) return null;
  const summary = await awaitFlashscoreDetail(
    cachedPerMatch(params.cache ?? new Map(), params.matchId, getFlashscoreMatchSummary),
    "o resumo da partida",
    params.bet.id,
  );
  if (!summary) return null;
  // Placar CRU do feed: os eventos do resumo falam em mandante/visitante da
  // partida, não da nossa aposta.
  const gols = orderedGoalsFromFlashscoreSummary({ summary, listedScore: params.listedScore });
  if (!gols.ok) {
    log.info({ betId: params.bet.id, matchId: params.matchId, motivo: gols.reason },
      "resumo ainda não explica os gols da partida");
    return null;
  }
  return gols.gols;
}

async function jogadoresDaPartida(params: {
  bet: EligibleBet; matchId?: string; cache?: PlayerStatsCache;
}): Promise<readonly JogadorDaPartida[] | null> {
  if (!params.matchId || !precisaDeJogadores(params.bet)) return null;
  const payload = await awaitFlashscoreDetail(
    cachedPerMatch(params.cache ?? new Map(), params.matchId, getFlashscoreMatchPlayerStats),
    "jogadores",
    params.bet.id,
  );
  const jogadores = payload ? normalizeFlashscorePlayers(payload) : [];
  return jogadores.length > 0 ? jogadores : null;
}

/** Parciais só do fornecedor, só quando fecham com o total; senão, manual. */
async function parciaisDoJogo(params: {
  bet: EligibleBet; matchId?: string; cache?: DetailsCache; swapped: boolean; listedScore: FlashscorePair | null;
}): Promise<PeriodScores | null> {
  if (!params.matchId || !precisaDeParciais(params.bet)) return null;
  const observação = await fetchMatchDetails(params.matchId, params.cache ?? new Map());
  const extraído = soccerPeriodScores(observação.body, { matchId: params.matchId, score: params.listedScore });
  if (!extraído.ok) {
    log.info({ betId: params.bet.id, matchId: params.matchId, motivo: extraído.reason },
      "parciais do jogo indisponíveis — liquidação por tempo segue manual");
    return null;
  }
  // Os parciais vêm na ordem do FEED e precisam da orientação do casamento.
  const ht = orientFlashscorePair(extraído.scores.ht, params.swapped);
  const sh = orientFlashscorePair(extraído.scores.sh, params.swapped);
  return ht && sh ? { ht, sh } : null;
}

/**
 * Com os 90' reconstruídos, a lista de jogadores é do jogo inteiro e só a perna
 * de gol se prova por ela: sem gol depois dos 90' no resumo, que explica o
 * placar todo, a contagem do jogo inteiro é a dos 90'. Chute, cartão e o resto
 * somariam a prorrogação, e o feed não prova que ela não houve.
 */
function playerLegsAreGoalsOnly(bet: EligibleBet): boolean {
  return (ticketForScore(bet)?.legs ?? []).every((leg) =>
    isPlayerGoalLeg(leg) || !isPlayerPropLeg(leg, bet.esporte));
}

/**
 * A lista que soma mais gols que o placar (a disputa de pênaltis, se o feed a
 * contasse) não prova a contagem de ninguém.
 */
function listCountsMoreGoalsThanScore(players: readonly JogadorDaPartida[], score: FlashscorePair): boolean {
  return players.reduce((total, player) => total + player.gols, 0) > score.home + score.away;
}

/** Alguma perna de placar já perdeu, o que decide o bilhete sem as pernas de jogador. */
function scoreLegLost(
  params: { bet: EligibleBet; score: FlashscorePair; scoredEvento?: string; regulationTimeScore?: FlashscorePair | null },
  periodScores: PeriodScores | null,
): boolean {
  const { home, away } = params.score;
  const resolution = resolveTicketFromScore(params.bet, {
    homeScore: home,
    awayScore: away,
    odds: toNumber(params.bet.odds),
    stake: toNumber(params.bet.stake),
    ...(params.scoredEvento ? { scoresByEvento: [{ evento: params.scoredEvento, home, away }] } : {}),
    periodScores,
    regulationScore: params.regulationTimeScore ?? null,
  });
  return resolution.ok && resolution.status === "LOST";
}

/** Aposta simples (ou criar-aposta do mesmo jogo) resolvida pelo placar da partida. */
export async function settleFlashscoreScore(params: {
  bet: EligibleBet;
  score: FlashscorePair;
  scoredEvento?: string;
  /** Os 90' reconstruídos pelo resumo, quando o jogo foi além deles. */
  regulation: Pick<FlashscoreRegulationContext, "regulationEvidence" | "extraTimePlayed">;
  viaInferencia: boolean;
  matchId?: string;
  /**
   * O FlashScore publica parciais de 1º/2º tempo para esta partida (futebol
   * encerrado em "Finished"). Fora disso eles não vêm: nem busca nem espera.
   */
  halfScoresPublished: boolean;
  detailsCache?: DetailsCache;
  playerStatsCache?: PlayerStatsCache;
  summaryCache?: SummaryCache;
  /** Placar como o FEED lista (sem inverter pelo casamento). */
  listedScore?: FlashscorePair | null;
  /** O casamento inverteu mandante e visitante em relação ao feed. */
  swapped: boolean;
  /** Placar sem a prorrogação, já orientado; null quando o jogo foi além do tempo normal. */
  regulationTimeScore?: FlashscorePair | null;
  now: Date;
}): Promise<{
  settled: boolean;
  unsupported: boolean;
  observationFinal?: false;
  settlementOutcome: string;
}> {
  if (ticketDeclaresNonScoreStat(params.bet)) {
    await alertFlashscoreStatManual(params.bet, "stat_qualifier");
    return {
      settled: false,
      unsupported: true,
      settlementOutcome: "manual_stat_qualifier",
    };
  }

  const evidence = params.regulation.regulationEvidence;
  const needsPlayers = evidence !== null && precisaDeJogadores(params.bet);
  const goalsProvable = needsPlayers && evidence.extraTimeGoalEvents === 0 && playerLegsAreGoalsOnly(params.bet);
  // Sem prova, só uma perna de placar perdida decide o bilhete, e as listas nem
  // são buscadas; o resto vai para o dono.
  const listsUseless = needsPlayers && !goalsProvable;
  const [periodScores, fetchedPlayers, fetchedGoals] = await Promise.all([
    !params.halfScoresPublished ? null : parciaisDoJogo({ bet: params.bet, matchId: params.matchId, cache: params.detailsCache, swapped: params.swapped,
      listedScore: params.listedScore ?? orientFlashscorePair(params.score, params.swapped) }),
    listsUseless
      ? null
      : jogadoresDaPartida({ bet: params.bet, matchId: params.matchId, cache: params.playerStatsCache }),
    listsUseless
      ? null
      : golsComMinuto({ bet: params.bet, matchId: params.matchId, listedScore: params.listedScore, cache: params.summaryCache }),
  ]);
  const listExceedsScore = goalsProvable && fetchedPlayers !== null && listCountsMoreGoalsThanScore(fetchedPlayers, params.score);
  const playerLegsWithoutProof = listsUseless || listExceedsScore;
  const players = playerLegsWithoutProof ? null : fetchedPlayers;
  const goals = playerLegsWithoutProof ? null : fetchedGoals;
  if (playerLegsWithoutProof && !scoreLegLost(params, periodScores)) {
    await alertExtraTimeManual(
      params.bet,
      orientFlashscorePair(params.listedScore ?? null, params.swapped),
      listExceedsScore
        ? "e a lista de jogadores do FlashScore conta mais gols que o placar: não decido sozinho a perna de gol"
        : params.regulation.extraTimePlayed
          ? "e a estatística de jogador do FlashScore soma a prorrogação: não decido sozinho a perna de jogador"
          : "e o FlashScore não diz se houve prorrogação antes dos pênaltis, que a estatística de jogador somaria: não decido sozinho a perna de jogador",
    );
    return { settled: false, unsupported: true, settlementOutcome: "manual_extra_time" };
  }
  // Lista de jogadores, minuto dos gols e parciais saem com atraso: até a
  // graça, a recusa por falta deles é "ainda não", e a observação segue aberta.
  // Parcial que o fornecedor não publica para esta partida não é espera.
  const extrasMissing = !playerLegsWithoutProof && (
    (precisaDeJogadores(params.bet) && players === null) ||
    (precisaDosMinutos(params.bet) && goals === null) ||
    (params.halfScoresPublished && precisaDeParciais(params.bet) && periodScores === null));
  const awaitingData = extrasMissing && params.now.getTime() - params.bet.data.getTime() < STATS_GRACE_MS;
  const settled = await settleFromFlashscoreScore(
    params.bet,
    { homeScore: params.score.home, awayScore: params.score.away },
    {
      scoredEvento: params.scoredEvento, periodScores, players, goals,
      regulationScore: params.regulationTimeScore ?? null,
      awaitingData,
      alertStatQualifier: precisaDeJogadores(params.bet),
    },
  );
  if (!settled && awaitingData) {
    return { settled: false, unsupported: false, observationFinal: false, settlementOutcome: "score_extras_pending" };
  }
  return {
    settled,
    unsupported: false,
    settlementOutcome: settled
      ? evidence !== null
        ? "settled_from_regulation_score"
        : marcarInferido("settled_from_score", params.viaInferencia)
      : "manual_or_already_settled",
  };
}
