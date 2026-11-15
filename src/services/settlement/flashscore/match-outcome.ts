import { isBasketballFirstHalf } from "@/src/domain/settlement/basketball-half";
import {
  ehMercadoArtilheiro,
  ehMercadoArtilheiroPorTempo,
  orderedGoalscorerMarketOrder,
} from "@/src/domain/settlement/goalscorer";
import { declaredScorePeriod } from "@/src/domain/settlement/markets";
import { classificarPropDeJogador } from "@/src/domain/settlement/player-prop-classify";
import { toNumber } from "@/src/domain/money";
import { resolveResultFromStatistics } from "@/src/domain/settlement/statistics";
import {
  resolveTicketFromScore,
  ticketForScore,
  type EligibleBet,
} from "@/src/domain/settlement/ticket-resolution";
import type { BasketballHalfProof } from "@/src/providers/flashscore/basketball-half";
import type { FlashscoreMatchCandidate } from "@/src/providers/flashscore/match";
import { marketNeedsFlashscoreStats } from "@/src/providers/flashscore/stats";
import {
  decidirTerminal,
  interruptedFinishOf,
  type DecisaoTerminal,
  type InterruptedFinish,
  type ObservacaoAnterior,
} from "@/src/providers/flashscore/terminal";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { processBasketballHalf } from "./basketball-half";
import { reportIaCrossCheck, type CrossCheckVerdict } from "./ia-crosscheck";
import {
  settleFlashscoreGoalscorer,
  settleFlashscoreOrderedGoalscorer,
  type GoalscorerEvidence,
  type OrderedGoalscorerEvidence,
} from "./goalscorer";
import {
  settleFlashscorePlayerProp,
  settlePersistentPlayerProp,
  type PlayerPropEvidence,
} from "./player-props";
import {
  alertExtraTimeManual,
  loadFlashscoreRegulationContext,
  type FlashscoreRegulationContext,
  type RegulationScoreEvidence,
} from "./regulation";
import { settleFlashscoreScore } from "./score";
import {
  listedFlashscoreScore,
  marcarInferido,
  orientFlashscorePair,
  POSTPONED_VOID_GRACE_MS,
  refundFlashscorePostponedOrCancelled,
  scoredEventoFromFlashscoreMatch,
  STATS_GRACE_MS,
  type DetailsCache,
  type FlashscorePair,
  type PlayerStatsCache,
  type StatsCache,
  type SummaryCache,
} from "./settle";
import {
  loadFlashscoreSettlementStats,
  processFlashscoreStatisticOutcome,
  type FlashscoreSettlementStats,
  type StatsPeriod,
} from "./statistics";

/**
 * Uma aposta casada numa partida do FlashScore: decide se o jogo acabou,
 * roteia o mercado para o caminho que o responde (placar, estatística,
 * artilheiro, prop de jogador, 1º tempo de basquete) e devolve a evidência
 * de cada fonte para o snapshot.
 */

export type FlashscoreSettlementOutcome = {
  final: boolean;
  observationFinal: boolean;
  settlementOutcome: string;
  score: FlashscorePair | null;
  stats: FlashscoreSettlementStats | null;
  statsPeriod: StatsPeriod;
  settled: boolean;
  refunded: boolean;
  unsupported: boolean;
  goalscorer: GoalscorerEvidence | null;
  orderedGoalscorer: OrderedGoalscorerEvidence | null;
  playerProp: PlayerPropEvidence | null;
  regulationScore: FlashscorePair | null;
  regulationEvidence: RegulationScoreEvidence | null;
  basketballFirstHalf?: BasketballHalfProof | null;
};

type MatchOutcomeParams = {
  bet: EligibleBet;
  candidate: FlashscoreMatchCandidate;
  /** Necessário para escolher entre flag do fornecedor e inferência. */
  sportId: number;
  /** Leitura do ciclo anterior — confirma estabilidade nos esportes inferidos. */
  anterior?: ObservacaoAnterior | null;
  statsCache: StatsCache;
  playerStatsCache: PlayerStatsCache;
  summaryCache: SummaryCache;
  basketballDetailsCache?: DetailsCache;
  now?: Date;
};

/** Qual caminho responde o mercado da aposta. */
type MarketRoute = {
  playerProp: boolean;
  orderedGoalscorer: boolean;
  needsStats: boolean;
  scoreOnlyMarket: boolean;
  basketballHalf: boolean;
};

function routeMarket(bet: EligibleBet, sportId: number): MarketRoute {
  const goalscorer = ehMercadoArtilheiro(bet.mercado, bet.selecao);
  const orderedGoalscorer = orderedGoalscorerMarketOrder(bet.mercado, bet.selecao) !== null;
  const playerProp = classificarPropDeJogador({
    mercado: bet.mercado,
    selecao: bet.selecao,
    evento: bet.evento,
    esporte: bet.esporte,
  }) !== null;
  const needsStats = !goalscorer && !orderedGoalscorer && !playerProp &&
    marketNeedsFlashscoreStats(bet.mercado, bet.selecao, bet.evento, bet.esporte);
  const scoreOnlyMarket = !needsStats && !goalscorer && !orderedGoalscorer && !playerProp;
  return {
    playerProp,
    orderedGoalscorer,
    needsStats,
    scoreOnlyMarket,
    basketballHalf: scoreOnlyMarket && sportId === 3 && isBasketballFirstHalf(bet),
  };
}

/**
 * O que um ramo de liquidação decidiu. `observationFinal` ausente = a
 * observação fecha junto com o fim do jogo; `false` a mantém aberta.
 */
type BranchDecision = {
  settlementOutcome: string;
  settled?: boolean;
  unsupported?: boolean;
  refunded?: boolean;
  observationFinal?: boolean;
  goalscorer?: GoalscorerEvidence;
  orderedGoalscorer?: OrderedGoalscorerEvidence;
  playerProp?: PlayerPropEvidence;
  basketballFirstHalf?: BasketballHalfProof | null;
};

/** Contexto que os ramos compartilham depois de ler o fim do jogo. */
type BranchContext = {
  params: MatchOutcomeParams;
  now: Date;
  decisao: DecisaoTerminal;
  viaInferencia: boolean;
  route: MarketRoute;
  score: FlashscorePair | null;
  stats: FlashscoreSettlementStats | null;
  statsPeriod: StatsPeriod;
  regulation: FlashscoreRegulationContext;
};

/** Coordena observação, reembolso e liquidação, preservando a evidência de cada fonte. */
export async function processFlashscoreMatchOutcome(
  params: MatchOutcomeParams,
): Promise<FlashscoreSettlementOutcome> {
  const now = params.now ?? new Date();
  const match = params.candidate.match;
  // Cancelado e adiado são terminais por si: afirmação do fornecedor, em
  // qualquer esporte, com ou sem flag de fim.
  const decisao = decidirTerminal({
    match,
    sportId: params.sportId,
    agora: now,
    anterior: params.anterior,
  });
  const partidaAconteceu =
    !match.match_status.is_cancelled && !match.match_status.is_postponed;
  const final = decisao.terminal || !partidaAconteceu;
  const score = orientFlashscorePair(listedFlashscoreScore(match), params.candidate.swapped);
  const route = routeMarket(params.bet, params.sportId);
  // O período das duas superfícies, como a liquidação: a aposta gravada com o
  // 1º tempo só na seleção carrega a estatística do 1º tempo.
  const period = declaredScorePeriod({ mercado: params.bet.mercado, selecao: params.bet.selecao, esporte: params.bet.esporte });
  const statsPeriod: StatsPeriod = period === "HT" || period === "SECOND_HALF" ? period : "FT";
  // Jogo cancelado ou adiado NÃO paga estatística: termina em reembolso ou
  // espera, e a chamada de estatística seria comprada para ser descartada.
  const stats = final && partidaAconteceu && route.needsStats
    ? await loadFlashscoreSettlementStats({
        betId: params.bet.id,
        candidate: params.candidate,
        statsPeriod,
        cache: params.statsCache,
        // `red_cards` da listagem é agregado da partida: fallback FT, nunca
        // para um bloco parcial que omitiu a linha de vermelhos.
        listedRedCards: orientFlashscorePair(
          typeof match.home_team.red_cards === "number" &&
          typeof match.away_team.red_cards === "number"
            ? { home: match.home_team.red_cards, away: match.away_team.red_cards }
            : null,
          params.candidate.swapped,
        ),
      })
    : null;
  const regulation = await loadFlashscoreRegulationContext({
    candidate: params.candidate,
    mercado: params.bet.mercado,
    selecao: params.bet.selecao,
    legs: ticketForScore(params.bet)?.legs,
    scoreOnlyMarket: route.scoreOnlyMarket && !route.basketballHalf,
    cache: params.summaryCache,
    sportId: params.sportId,
    evento: params.bet.evento,
  });

  const decision: BranchDecision = params.bet.status === "PENDING"
    ? await settlePendingBet({
        params,
        now,
        decisao,
        viaInferencia: decisao.terminal && decisao.via === "inferencia",
        route,
        score,
        stats,
        statsPeriod,
        regulation,
      })
    : await crossCheckSettledBet({
        params,
        now,
        decisao,
        viaInferencia: false,
        route,
        score,
        stats,
        statsPeriod,
        regulation,
      });

  return {
    final,
    observationFinal: decision.observationFinal ?? final,
    settlementOutcome: decision.settlementOutcome,
    score,
    stats,
    statsPeriod,
    settled: decision.settled ?? false,
    refunded: decision.refunded ?? false,
    unsupported: decision.unsupported ?? false,
    goalscorer: decision.goalscorer ?? null,
    orderedGoalscorer: decision.orderedGoalscorer ?? null,
    playerProp: decision.playerProp ?? null,
    regulationScore: regulation.regulationEvidence?.score ?? null,
    regulationEvidence: regulation.regulationEvidence,
    basketballFirstHalf: decision.basketballFirstHalf ?? null,
  };
}

async function settlePendingBet(context: BranchContext): Promise<BranchDecision> {
  const { params, now, decisao, route, regulation, statsPeriod } = context;
  const { bet, candidate } = params;
  const match = candidate.match;
  if (match.match_status.is_cancelled || match.match_status.is_postponed) {
    return settleNotPlayed(bet, match.match_status, now);
  }
  // Antes de qualquer ramo: o placar de jogo interrompido não paga placar,
  // estatística, artilheiro nem prop. A observação segue a regra do fim
  // (fecha com a flag; "Abandoned" sem flag continua olhando, porque o jogo
  // pode ser retomado).
  const interrupted = interruptedFinishOf(match.match_status.stage);
  if (interrupted) {
    await alertInterruptedManual(bet, interrupted, match.match_status.stage, context.score);
    return { unsupported: true, settlementOutcome: `manual_${interrupted}` };
  }
  if (route.basketballHalf && decisao.terminal) {
    const half = await processBasketballHalf({
      bet,
      candidate,
      cache: params.basketballDetailsCache ?? new Map(),
      now,
    });
    return {
      settled: half.settled,
      unsupported: half.unsupported,
      observationFinal: half.observationFinal,
      settlementOutcome: half.settlementOutcome,
      basketballFirstHalf: half.proof,
    };
  }
  if (route.playerProp && bet.playerPropRevision !== undefined && decisao.terminal) {
    const prop = await settlePersistentPlayerProp({
      bet,
      matchId: match.match_id,
      now,
      homeId: match.home_team.team_id,
      awayId: match.away_team.team_id,
      swapped: candidate.swapped,
      extraTime: regulation.decidedInExtraTime,
    });
    return {
      settled: prop.settled,
      unsupported: prop.unsupported,
      ...(prop.aguardando ? { observationFinal: false } : {}),
      settlementOutcome: prop.settlementOutcome,
      playerProp: prop.evidencia,
    };
  }
  // O resumo de gols sai com atraso: até a graça, os 90' ainda podem ser
  // reconstruídos, e a observação segue aberta sem chamar o operador.
  if (
    regulation.regulationAttempted &&
    regulation.regulationEvidence === null &&
    now.getTime() - bet.data.getTime() < STATS_GRACE_MS
  ) {
    return { observationFinal: false, settlementOutcome: "regulation_pending" };
  }
  if (
    regulation.decidedInExtraTime &&
    !regulation.extraTimeCompatible &&
    regulation.regulationEvidence === null &&
    (!route.needsStats || statsPeriod === "FT")
  ) {
    await alertExtraTimeManual(bet, context.score);
    return { unsupported: true, settlementOutcome: "manual_extra_time" };
  }
  // `decisao.terminal`, NUNCA `is_finished`: nos esportes inferidos a flag do
  // fornecedor é `false` para sempre, e a observação fecharia sem liquidar.
  if (decisao.terminal) return settleFinishedMatch(context);
  return { settlementOutcome: "not_attempted" };
}

/**
 * Aposta que o IA-Judge liquidou (a fila só traz essas entre as não pendentes):
 * o FlashScore continua olhando o jogo e compara o resultado que ELE daria com
 * o gravado. Só compara o que sai do que já foi buscado (placar e estatística
 * de time); artilheiro, prop e 1º tempo de basquete custariam chamadas extras.
 */
async function crossCheckSettledBet(context: BranchContext): Promise<BranchDecision> {
  return reportIaCrossCheck(context.params.bet, flashscoreVerdict(context), context.now);
}

/** O que a liquidação automática decidiria, sem aplicar nada. */
function flashscoreVerdict(context: BranchContext): CrossCheckVerdict {
  const { params, now, decisao, route, regulation, statsPeriod } = context;
  const { bet } = params;
  const status = params.candidate.match.match_status;
  if (status.is_cancelled || status.is_postponed) {
    const graceElapsed = now.getTime() - bet.data.getTime() >= POSTPONED_VOID_GRACE_MS;
    if (status.is_postponed && !status.is_cancelled && !graceElapsed) {
      return { kind: "wait", outcome: "crosscheck_postponed_waiting" };
    }
    return { kind: "status", status: "VOID", evidence: "jogo cancelado ou adiado" };
  }
  if (interruptedFinishOf(status.stage)) {
    return { kind: "uncomparable", outcome: "crosscheck_interrupted", reason: "interrupted" };
  }
  if (!decisao.terminal) return { kind: "none", outcome: "not_attempted" };
  if (regulation.decidedInExtraTime && !regulation.extraTimeCompatible && regulation.regulationEvidence === null) {
    return { kind: "uncomparable", outcome: "crosscheck_extra_time", reason: "extra_time" };
  }
  const odds = toNumber(bet.odds);
  const stake = toNumber(bet.stake);
  if (route.needsStats && context.stats) {
    const resolution = resolveResultFromStatistics({
      mercado: bet.mercado, selecao: bet.selecao, evento: bet.evento, odds, stake,
      stats: context.stats, statsPeriod,
    });
    return resolution.ok
      ? {
          kind: "status",
          status: resolution.status,
          evidence: `${resolution.statistic} ${resolution.values.home}-${resolution.values.away}`,
        }
      : { kind: "none", outcome: "crosscheck_not_comparable" };
  }
  const score = regulation.regulationEvidence?.score ?? context.score;
  if (!route.scoreOnlyMarket || route.basketballHalf || !score) {
    return { kind: "none", outcome: "crosscheck_not_comparable" };
  }
  const resolution = resolveTicketFromScore(bet, {
    homeScore: score.home,
    awayScore: score.away,
    odds,
    stake,
    regulationScore: regulationTimeScore(context),
    scoresByEvento: [{
      evento: scoredEventoFromFlashscoreMatch(params.candidate.match, params.candidate.swapped),
      home: score.home,
      away: score.away,
    }],
  });
  return resolution.ok
    ? { kind: "status", status: resolution.status, evidence: `placar ${score.home}-${score.away}` }
    : { kind: "none", outcome: "crosscheck_not_comparable" };
}

/**
 * Placar do tempo regulamentar: o reconstruído dos 90', ou o listado quando o
 * jogo terminou sem prorrogação. Com prorrogação e sem reconstrução, não há.
 */
function regulationTimeScore(context: BranchContext): FlashscorePair | null {
  const { regulation, score } = context;
  return regulation.regulationEvidence?.score ?? (regulation.decidedInExtraTime ? null : score);
}

/** Cancelado reembolsa; adiado espera a graça; prop persistida segue a regra da casa. */
async function settleNotPlayed(
  bet: EligibleBet,
  status: { is_cancelled: boolean; is_postponed: boolean },
  now: Date,
): Promise<BranchDecision> {
  if (bet.playerPropRevision !== undefined) {
    return { unsupported: true, settlementOutcome: "manual_regra_de_adiamento_da_casa" };
  }
  const graceElapsed = now.getTime() - bet.data.getTime() >= POSTPONED_VOID_GRACE_MS;
  if (status.is_postponed && !status.is_cancelled && !graceElapsed) {
    return { observationFinal: false, settlementOutcome: "postponed_waiting" };
  }
  const refunded = await refundFlashscorePostponedOrCancelled(bet);
  return { refunded, settlementOutcome: refunded ? "refunded" : "already_settled" };
}

const INTERRUPTED_LABEL: Record<InterruptedFinish, string> = {
  retired: "terminou por abandono de um dos jogadores",
  walkover: "terminou por W.O.",
  awarded: "teve o resultado decidido fora de campo",
  abandoned: "foi abandonado antes do fim",
  interrupted: "está parado (interrompido ou suspenso) e pode ou não ser retomado",
};

export async function alertInterruptedManual(
  bet: { id: string; evento: string; selecao: string },
  kind: InterruptedFinish,
  stage: string | null,
  score: FlashscorePair | null,
): Promise<void> {
  await sendOperationalAlert(
    `✋ Liquidar à mão · ${bet.evento}\n` +
      `${bet.selecao}\n` +
      `O jogo ${INTERRUPTED_LABEL[kind]} (FlashScore: "${stage ?? "?"}"` +
      `${score ? `, placar no momento ${score.home}-${score.away}` : ""}). ` +
      "O placar não diz quem venceu, e cada casa tem regra própria para abandono e W.O.\n" +
      "👉 Confira a regra da casa e liquide em Operações.",
    {
      source: "settlement.flashscore-interrupted",
      key: bet.id,
      title: `Liquidação manual (jogo não concluído): ${bet.evento}`,
      resource: "bet",
      resourceId: bet.id,
      evidence: { stage, kind, score },
      autoResolve: false,
    },
  );
}

/**
 * Jogo encerrado: artilheiro (ordenado ou não) e prop de jogador vêm ANTES do
 * caminho estatístico — são perguntas sobre JOGADOR, e só o `player-stats`
 * responde. Depois, estatística de time; por fim, o placar.
 */
async function settleFinishedMatch(context: BranchContext): Promise<BranchDecision> {
  const { params, now, route, viaInferencia } = context;
  const { bet, candidate } = params;
  const match = candidate.match;
  const inferredIfSettled = (outcome: { settled: boolean; settlementOutcome: string }) =>
    outcome.settled ? marcarInferido(outcome.settlementOutcome, viaInferencia) : outcome.settlementOutcome;

  if (route.orderedGoalscorer) {
    const ordered = await settleFlashscoreOrderedGoalscorer({ ...params, now });
    return {
      settled: ordered.settled,
      unsupported: ordered.unsupported,
      ...(ordered.aguardando ? { observationFinal: false } : {}),
      settlementOutcome: inferredIfSettled(ordered),
      orderedGoalscorer: ordered.evidencia,
    };
  }
  if (ehMercadoArtilheiro(bet.mercado, bet.selecao) || ehMercadoArtilheiroPorTempo(bet.mercado, bet.selecao)) {
    const listedScore = listedFlashscoreScore(match);
    const artilheiro = await settleFlashscoreGoalscorer({
      bet,
      matchId: match.match_id,
      cache: params.playerStatsCache,
      now,
      summaryCache: params.summaryCache,
      ...(listedScore ? { listedScore } : {}),
    });
    // Escalação ainda não publicada: a observação NÃO fecha, senão a aposta
    // sai da fila e nunca mais volta.
    return {
      settled: artilheiro.settled,
      unsupported: artilheiro.unsupported,
      ...(artilheiro.aguardando ? { observationFinal: false } : {}),
      settlementOutcome: inferredIfSettled(artilheiro),
      goalscorer: artilheiro.evidencia,
    };
  }
  if (route.playerProp) {
    const prop = await settleFlashscorePlayerProp({
      bet,
      matchId: match.match_id,
      cache: params.playerStatsCache,
      now,
    });
    return {
      settled: prop.settled,
      unsupported: prop.unsupported,
      ...(prop.aguardando ? { observationFinal: false } : {}),
      settlementOutcome: inferredIfSettled(prop),
      playerProp: prop.evidencia,
    };
  }
  if (route.needsStats) {
    // Invariante: `needsStats` é o mesmo predicado que carregou o bloco, e
    // `decisao.terminal` implica `final`. Divergência é bug e estoura alto.
    if (context.stats === null) {
      throw new Error(
        `Estatística não carregada para a aposta ${bet.id} apesar do roteamento pedir — ` +
          "portão de estatística e busca divergiram.",
      );
    }
    return processFlashscoreStatisticOutcome({
      bet,
      stats: context.stats,
      statsPeriod: context.statsPeriod,
      now,
      viaInferencia,
    });
  }
  if (context.score) {
    const regulationEvidence = context.regulation.regulationEvidence;
    return settleFlashscoreScore({
      bet,
      score: regulationEvidence?.score ?? context.score,
      regulationTimeScore: regulationTimeScore(context),
      scoredEvento: scoredEventoFromFlashscoreMatch(match, candidate.swapped),
      swapped: candidate.swapped,
      regulation: context.regulation,
      viaInferencia,
      // Só quem declara 1º/2º tempo paga a chamada de detalhes, e o cache é o
      // mesmo do 1º tempo de basquete: uma requisição por partida.
      matchId: match.match_id,
      halfScoresPublished: params.sportId === 1 && match.match_status.stage === "Finished",
      detailsCache: params.basketballDetailsCache,
      playerStatsCache: params.playerStatsCache,
      summaryCache: params.summaryCache,
      listedScore: listedFlashscoreScore(match),
      now,
    });
  }
  return { observationFinal: false, settlementOutcome: "score_pending" };
}
