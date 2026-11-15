import { isRaceToMarket } from "@/src/domain/mercados/classify";
import { toNumber } from "@/src/domain/money";
import {
  resolveResultFromStatistics,
  statisticFamilyOf,
  type StatisticFamily,
} from "@/src/domain/settlement/statistics";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";
import { createLogger } from "@/src/infra/logger";
import { getFlashscoreMatchStats } from "@/src/providers/flashscore/client";
import type { FlashscoreMatchCandidate } from "@/src/providers/flashscore/match";
import {
  normalizeFlashscoreStats,
  type FlashscoreNormalizedStats,
} from "@/src/providers/flashscore/stats";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import {
  cachedPerMatch,
  isFlashscoreUnavailable,
  marcarInferido,
  orientFlashscorePair,
  settleFlashscoreBet,
  STATS_GRACE_MS,
  type StatsCache,
} from "./settle";

/**
 * Mercados de estatística de time (escanteios, cartões, finalizações…): a
 * leitura do bloco de estatísticas da partida, a liquidação pela família e o
 * pedido ao operador quando o feed não resolve.
 */

const log = createLogger("flashscore-settlement");

export type FlashscoreSettlementStats = FlashscoreNormalizedStats;
export type StatsPeriod = "FT" | "HT" | "SECOND_HALF";

export const ESTATISTICAS_VAZIAS: FlashscoreSettlementStats = {
  corners: null,
  yellowCards: null,
  redCards: null,
  shotsTotal: null,
  shotsOnTarget: null,
  fouls: null,
  offsides: null,
  saves: null,
  interceptions: null,
  clearances: null,
  assists: null,
  blocks: null,
  steals: null,
  turnovers: null,
  rebounds: null,
  aces: null,
  doubleFaults: null,
  threePointers: null,
};

const ROTULO_ESTATISTICA: Record<StatisticFamily, string> = {
  corners: "escanteios",
  booking_points: "pontos de cartões",
  yellow_cards: "cartões amarelos",
  red_cards: "cartões vermelhos",
  shots_total: "finalizações",
  shots_on_target: "finalizações no gol",
  fouls: "faltas",
  offsides: "impedimentos",
  saves: "defesas",
  interceptions: "interceptações",
  clearances: "cortes",
  assists: "assistências",
  blocks: "tocos",
  steals: "roubos de bola",
  turnovers: "turnovers",
  rebounds: "rebotes",
  aces: "aces",
  double_faults: "duplas faltas",
  three_pointers: "cestas de três",
};

export async function loadFlashscoreSettlementStats(params: {
  betId: string;
  candidate: FlashscoreMatchCandidate;
  statsPeriod: StatsPeriod;
  cache: StatsCache;
  /** Agregado de vermelhos da listagem: fallback só para o jogo inteiro. */
  listedRedCards: { home: number; away: number } | null;
}): Promise<FlashscoreSettlementStats> {
  const match = params.candidate.match;
  const listedRedCards = params.statsPeriod === "FT" ? params.listedRedCards : null;
  const pending = cachedPerMatch(params.cache, match.match_id, getFlashscoreMatchStats);
  try {
    const rawStats = await pending;
    if (!rawStats) return { ...ESTATISTICAS_VAZIAS, redCards: listedRedCards };
    const normalized = normalizeFlashscoreStats(rawStats, params.statsPeriod);
    const orientadas = { ...ESTATISTICAS_VAZIAS };
    for (const chave of Object.keys(orientadas) as Array<keyof FlashscoreSettlementStats>) {
      orientadas[chave] = orientFlashscorePair(
        normalized[chave],
        params.candidate.swapped,
      );
    }
    return {
      ...orientadas,
      redCards: orientadas.redCards ?? listedRedCards,
    };
  } catch (error) {
    // Breaker/cota/HTTP sobem tipados: embrulhar viraria "falha de estatística"
    // por aposta e manteria o ciclo martelando o provider.
    if (isFlashscoreUnavailable(error)) throw error;
    log.error(
      { err: error, betId: params.betId, matchId: match.match_id },
      "falha ao consultar estatísticas do FlashScore",
    );
    throw new Error(
      `Falha ao consultar estatísticas FlashScore da aposta ${params.betId}.`,
      { cause: error },
    );
  }
}

export async function processFlashscoreStatisticOutcome(params: {
  bet: EligibleBet;
  stats: FlashscoreSettlementStats;
  statsPeriod: StatsPeriod;
  now: Date;
  viaInferencia: boolean;
}): Promise<{
  settled: boolean;
  unsupported: boolean;
  observationFinal: boolean;
  settlementOutcome: string;
}> {
  const resolution = resolveResultFromStatistics({
    mercado: params.bet.mercado,
    selecao: params.bet.selecao,
    evento: params.bet.evento,
    odds: toNumber(params.bet.odds),
    stake: toNumber(params.bet.stake),
    stats: params.stats,
    statsPeriod: params.statsPeriod,
  });
  if (resolution.ok) {
    const label = `${ROTULO_ESTATISTICA[resolution.statistic]} ${resolution.values.home}-${resolution.values.away}`;
    const settled = await settleFlashscoreBet({
      bet: params.bet,
      status: resolution.status,
      label,
    });
    return {
      settled,
      unsupported: false,
      observationFinal: true,
      settlementOutcome: settled
        ? marcarInferido("settled_from_stats", params.viaInferencia)
        : "already_settled",
    };
  }
  if (resolution.reason === "missing_stat") {
    if (params.now.getTime() - params.bet.data.getTime() < STATS_GRACE_MS) {
      return { settled: false, unsupported: false, observationFinal: false, settlementOutcome: "stats_pending" };
    }
    await alertFlashscoreStatManual(params.bet, "missing_stat", {
      afterGraceHours: STATS_GRACE_MS / 3_600_000,
    });
    return { settled: false, unsupported: true, observationFinal: true, settlementOutcome: "manual_missing_stats" };
  }
  await alertFlashscoreStatManual(params.bet, resolution.reason);
  return {
    settled: false,
    unsupported: true,
    observationFinal: true,
    settlementOutcome: `manual_${resolution.reason}`,
  };
}

export type PedidoDeParEstatistico = {
  family: StatisticFamily | null;
  rotulo: string | null;
  sentence: string;
};

/**
 * O que o operador precisa informar — o par da família, não WON/LOST pelo
 * placar de gols. "Primeiro a N" não tem par: o agregado mente.
 */
export function pedidoDeParEstatistico(params: {
  mercado: string;
  selecao: string;
  evento?: string;
  esporte?: string;
}): PedidoDeParEstatistico {
  if (isRaceToMarket(params.mercado, params.selecao)) {
    return {
      family: null,
      rotulo: null,
      sentence:
        "Este mercado é 'primeiro a N' — não liquida pelo placar nem pelo total agregado. "
        + "Confira quem chegou primeiro e liquide em Operações.",
    };
  }
  const family = statisticFamilyOf(
    params.mercado,
    params.selecao,
    params.evento,
    params.esporte,
  );
  if (family) {
    const rotulo = ROTULO_ESTATISTICA[family];
    const exemplo = family === "booking_points"
      ? "5-3 (amarelo=1, vermelho=2)"
      : "4-2";
    return {
      family,
      rotulo,
      sentence:
        `Informe o par de ${rotulo} mandante-visitante (ex.: ${exemplo}). `
        + "O placar de gols não resolve esta linha.",
    };
  }
  return {
    family: null,
    rotulo: null,
    sentence:
      "Esta linha é estatística — o placar de gols não resolve. "
      + "Informe o número da família (par mandante-visitante) e liquide em Operações.",
  };
}

export async function alertFlashscoreStatManual(
  bet: Pick<EligibleBet, "id" | "evento" | "mercado" | "selecao" | "esporte">,
  reason: string,
  opts: { afterGraceHours?: number } = {},
): Promise<void> {
  const pedido = pedidoDeParEstatistico({
    mercado: bet.mercado,
    selecao: bet.selecao,
    evento: bet.evento,
    esporte: bet.esporte,
  });
  const missing = reason === "missing_stat";
  const published = pedido.rotulo ?? `a estatística de "${bet.mercado}"`;
  const grace = opts.afterGraceHours;
  const prefix = missing && grace != null
    ? `O FlashScore encerrou o jogo, mas não publicou ${published} nem ${grace}h depois. `
    : "";
  await sendOperationalAlert(
    `✋ Liquidar à mão · ${bet.evento}\n${bet.selecao}\n${prefix}${pedido.sentence}\n👉 Liquide em Operações.`,
    {
      source: missing
        ? "settlement.flashscore-missing-stats"
        : "settlement.flashscore-stat-unsupported",
      key: bet.id,
      title: missing
        ? `Liquidação manual (sem estatística): ${bet.evento}`
        : `Liquidação manual (estatística): ${bet.evento}`,
      resource: "bet",
      resourceId: bet.id,
      autoResolve: false,
      evidence: {
        reason,
        mercado: bet.mercado,
        statistic: pedido.family,
      },
    },
  );
}
