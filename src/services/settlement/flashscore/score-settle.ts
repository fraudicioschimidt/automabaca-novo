import type { BetStatus, Prisma } from "@/src/generated/prisma/client";
import { fmtU } from "@/src/domain/formato-de-resultado";
import { resolveLiveScoreAtTip } from "@/src/domain/live-score-at-tip";
import { emojiStatus, rotuloStatus } from "@/src/domain/mensagem-operador";
import { toNumber } from "@/src/domain/money";
import type { JogadorDaPartida, OrderedGoal } from "@/src/domain/settlement/goalscorer";
import type { ScoreResolution, ScoreResolutionFailure } from "@/src/domain/settlement/score-resolution";
import {
  resolveTicketFromScore,
  ticketFixtureEventos,
  type EligibleBet,
  type FixtureScore,
  type PeriodScores,
} from "@/src/domain/settlement/ticket-resolution";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { AUTOMATIC_RESULT_PROVIDER } from "@/src/providers/coverage";
import {
  applyAutomaticBetStatusChangeTx,
  BetNotPendingError,
  type ApplyBetStatusChangeResult,
} from "@/src/services/bets/settle";
import { alertarLiquidacaoSemConta } from "@/src/services/bets/settle-effects";
import { assertBetSettlementTermsTx } from "@/src/services/bets/settle-terms";
import { sendOperationalAlert, sendOperatorNotification } from "@/src/services/ops/alerts";
import { writeScoreOnce } from "@/src/services/settlement/bet-result";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { jsonObject } from "./observation-store";
import { alertExtraTimeManual } from "./regulation";

/**
 * Aplica à aposta o resultado que o placar decide, grava o placar como
 * evidência e avisa o operador — ou recusa com alerta quando o placar não basta.
 */

const log = createLogger("settlement.flashscore-score");

/** Recusas terminais porque o mercado não tem motor de placar. */
const SCORE_FAILURES_SAFE_TO_INGEST = new Set<ScoreResolutionFailure>([
  "unsupported_market",
  "stat_qualifier",
  "score_unit_mismatch",
  "unsupported_live_score",
]);

/** Unidades que o placar não mede e que não devem gerar falso alerta. */
const SCORE_FAILURES_SILENT = new Set<ScoreResolutionFailure>([
  "stat_qualifier",
  "incomplete_legs",
]);

/** Liquidação transacional por placar com guarda de mudança material nos termos. */
export async function settleFromFlashscoreScoreTx(
  tx: Prisma.TransactionClient,
  bet: EligibleBet,
  params: {
    status: BetStatus;
    homeScore: number;
    awayScore: number;
  },
): Promise<{ settledResult: ApplyBetStatusChangeResult; wrote: boolean }> {
  const settledResult = await applyAutomaticBetStatusChangeTx(tx, {
    betId: bet.id,
    newStatus: params.status,
    source: AUTOMATIC_RESULT_PROVIDER,
    expectedTerms: bet,
  });

  const wrote = await writeScoreOnce(
    bet.id,
    { scoreHome: params.homeScore, scoreAway: params.awayScore },
    { requireNotPending: true, client: tx },
  );

  return { settledResult, wrote };
}

/**
 * Único ponto de entrada da liquidação automática por placar externo.
 *
 * A autoria é fixa em FlashScore: quem chama não passa provider e, portanto,
 * não consegue promover placar de BridgeOdds ou Pinnacle17 a resultado
 * financeiro por acidente.
 */
export async function settleFromFlashscoreScore(
  bet: EligibleBet,
  score: { homeScore: number | null | undefined; awayScore: number | null | undefined },
  opts: {
    scoredEvento?: string;
    scoresByEvento?: readonly FixtureScore[];
    /** Todas as pernas já são terminais: recusa incompleta exige ação humana. */
    alertIncompleteLegs?: boolean;
    /** Parciais do jogo, quando o fornecedor os declara e eles fecham com o total. */
    periodScores?: PeriodScores | null;
    /** Placar do tempo regulamentar, quando se sabe que o jogo não teve prorrogação. */
    regulationScore?: { home: number; away: number } | null;
    /** Jogadores da partida, para as pernas de artilheiro e props. */
    players?: readonly JogadorDaPartida[] | null;
    /** Gols com minuto, para as pernas de gol por tempo. */
    goals?: readonly OrderedGoal[] | null;
    /**
     * O bilhete pede dado que o feed publica com atraso (lista de jogadores,
     * minuto dos gols) e ele ainda não saiu: a recusa não grava o placar, que
     * travaria a próxima passada, nem chama o operador.
     */
    awaitingData?: boolean;
    /** Perna de jogador recusada (nome ambíguo, lista que não saiu) pede a mão do dono. */
    alertStatQualifier?: boolean;
  } = {},
): Promise<boolean> {
  const { homeScore, awayScore } = score;
  // O snapshot é a leitura ANTERIOR. Estágio de prorrogação nele só diz que o
  // jogo estava na prorrogação quando olhamos; quem decide se o placar paga é
  // a leitura atual (`loadFlashscoreRegulationContext`). Só uma recusa já
  // decidida segura a liquidação, e com alerta: aposta parada nunca fica muda.
  if (jsonObject(bet.result?.resultSnapshot)?.settlementOutcome === "manual_extra_time") {
    await alertExtraTimeRefusalStands(bet);
    return false;
  }
  const scoreAlreadyIngested =
    ticketFixtureEventos(bet).length === 0 &&
    bet.result?.scoreHome !== null &&
    bet.result?.scoreHome !== undefined;
  if (
    homeScore === null || homeScore === undefined ||
    awayScore === null || awayScore === undefined ||
    scoreAlreadyIngested
  ) {
    return false;
  }

  const resolution = resolveTicketFromScore(bet, {
    homeScore,
    awayScore,
    odds: toNumber(bet.odds),
    stake: toNumber(bet.stake),
    scoresByEvento: opts.scoresByEvento
      ?? (opts.scoredEvento
        ? [{ evento: opts.scoredEvento, home: homeScore, away: awayScore }]
        : undefined),
    periodScores: opts.periodScores ?? null,
    regulationScore: opts.regulationScore ?? null,
    players: opts.players ?? null,
    goals: opts.goals ?? null,
  });
  const scoreDescription = describeScore(bet, homeScore, awayScore);
  if (resolution.ok) {
    return applyScoreResolution(bet, resolution, { homeScore, awayScore, scoreDescription });
  }
  if (opts.awaitingData) {
    log.info({ betId: bet.id, reason: resolution.reason }, "placar à espera dos dados de jogador");
    return false;
  }
  await handleScoreRefusal(bet, resolution.reason, {
    homeScore,
    awayScore,
    scoreDescription,
    alertIncompleteLegs: opts.alertIncompleteLegs,
    alertStatQualifier: opts.alertStatQualifier,
  });
  return false;
}

async function alertExtraTimeRefusalStands(bet: EligibleBet): Promise<void> {
  if (bet.status !== "PENDING") return;
  // Mesma fonte e chave do alerta da recusa original: não duplica a ação.
  await alertExtraTimeManual(bet, null);
}

/** "final 2-1, estava 1-0 na aposta, 1-1 depois dela" quando a tip foi ao vivo. */
function describeScore(bet: EligibleBet, homeScore: number, awayScore: number): string {
  const tipScoreResolution = resolveLiveScoreAtTip({
    liveScoreHome: bet.liveScoreHome,
    liveScoreAway: bet.liveScoreAway,
    texts: [bet.selecao],
    market: bet.mercado,
    requireStructured: true,
  });
  const tipScore = tipScoreResolution.ok ? tipScoreResolution.score : null;
  return tipScore
    ? `final ${homeScore}-${awayScore}, estava ${tipScore.home}-${tipScore.away} na aposta, ` +
      `${homeScore - tipScore.home}-${awayScore - tipScore.away} depois dela`
    : `${homeScore}-${awayScore}`;
}

async function cancelPendingEnrich(betId: string): Promise<void> {
  try {
    const { getSharedBoss } = await import("@/src/infra/boss");
    const { cancelPendingSharpEnrich } = await import("@/src/services/scheduling/enqueue-enrich");
    const boss = await getSharedBoss();
    await cancelPendingSharpEnrich(boss, betId, "settled");
  } catch (err) {
    log.warn({ err, betId }, "falha ao cancelar sharp.enrich pós-settle");
  }
}

/**
 * Aplica o status que o placar decidiu. Se a aposta já tinha resultado, grava
 * o placar como evidência e confere: confirma, ou alerta a divergência.
 */
async function applyScoreResolution(
  bet: EligibleBet,
  resolution: Extract<ScoreResolution, { ok: true }>,
  score: { homeScore: number; awayScore: number; scoreDescription: string },
): Promise<boolean> {
  const { homeScore, awayScore, scoreDescription } = score;
  let applied: ApplyBetStatusChangeResult;
  let ingested = false;

  try {
    const txResult = await runSerializableTransaction("scoreSettle", (tx) =>
      settleFromFlashscoreScoreTx(tx, bet, {
        status: resolution.status,
        homeScore,
        awayScore,
      }),
    );
    applied = txResult.settledResult;
    ingested = txResult.wrote;
    if (applied.previousStatus === "PENDING" && applied.status !== "PENDING") {
      await cancelPendingEnrich(bet.id);
    }
    await alertarLiquidacaoSemConta(bet.id, applied);
  } catch (err) {
    if (!(err instanceof BetNotPendingError)) throw err;
    const fallback = await runSerializableTransaction("scoreAlreadySettled", async (tx) => {
      await assertBetSettlementTermsTx(tx, bet, { allowSettledTransition: true });
      const fresh = await tx.bet.findUniqueOrThrow({
        where: { id: bet.id },
        select: { status: true, lucro: true },
      });
      const wrote = await writeScoreOnce(
        bet.id,
        { scoreHome: homeScore, scoreAway: awayScore },
        { requireNotPending: true, client: tx },
      );
      return { fresh, wrote };
    });
    applied = {
      status: fallback.fresh.status,
      lucro: toNumber(fallback.fresh.lucro),
      previousStatus: fallback.fresh.status,
    };
    ingested = fallback.wrote;
  }

  if (
    applied.previousStatus === "PENDING" &&
    (ingested || ticketFixtureEventos(bet).length > 0)
  ) {
    await sendOperatorNotification(
      `${emojiStatus(applied.status)} ${rotuloStatus(applied.status)} (${fmtU(applied.lucro)}) · ${bet.evento}\n` +
        `${bet.selecao}\n` +
        `Placar: ${scoreDescription}`,
      { key: `settlement:${bet.id}:${bet.manualSettlementVersion ?? 0}` },
    );
    return true;
  }
  const settledEarlier = ingested &&
    applied.previousStatus !== "PENDING" &&
    applied.previousStatus !== "CASHOUT";
  if (settledEarlier && resolution.status === applied.status) {
    await sendOperatorNotification(
      `☑️ Placar confirma o resultado · ${bet.evento}\n` +
        `${bet.selecao}: ${rotuloStatus(applied.status)} (placar ${scoreDescription})`,
      { key: `score-confirmation:${bet.id}:${bet.manualSettlementVersion ?? 0}` },
    );
  } else if (settledEarlier) {
    await sendOperationalAlert(
      `⚠️ Resultado diferente do placar · ${bet.evento}\n` +
        `${bet.selecao}\n` +
        `Está como ${rotuloStatus(applied.status)}, mas pelo placar (${scoreDescription}) seria ${rotuloStatus(resolution.status)}.\n` +
        "👉 Confira e corrija no painel se for o caso.",
      {
        source: "settlement.score-conflict",
        key: bet.id,
        title: `Conflito de liquidação: ${bet.evento}`,
        resource: "bet",
        resourceId: bet.id,
        autoResolve: false,
      },
    );
    log.warn(
      { betId: bet.id, statusAtual: applied.status, peloPlacar: resolution.status },
      "resultado gravado diverge do placar do FlashScore",
    );
  }
  return false;
}

/**
 * O placar não decide a aposta. Recusa terminal (mercado sem motor de placar)
 * ainda grava o placar como evidência; a aposta pendente vira alerta, exceto
 * nas recusas que só significam "ainda não dá".
 */
async function handleScoreRefusal(
  bet: EligibleBet,
  reason: ScoreResolutionFailure,
  params: {
    homeScore: number;
    awayScore: number;
    scoreDescription: string;
    alertIncompleteLegs?: boolean;
    alertStatQualifier?: boolean;
  },
): Promise<void> {
  const safeToIngest = SCORE_FAILURES_SAFE_TO_INGEST.has(reason);
  const silentFailure = SCORE_FAILURES_SILENT.has(reason) && !(
    (reason === "incomplete_legs" && params.alertIncompleteLegs) ||
    (reason === "stat_qualifier" && params.alertStatQualifier)
  );
  const ingested = safeToIngest
    ? await runSerializableTransaction("scoreEvidence", async (tx) => {
        await assertBetSettlementTermsTx(tx, bet);
        return writeScoreOnce(bet.id, {
          scoreHome: params.homeScore,
          scoreAway: params.awayScore,
        }, { client: tx });
      })
    : false;
  if (bet.status !== "PENDING") return;
  if ((!safeToIngest || ingested) && !silentFailure) {
    await sendOperationalAlert(
      `✋ Liquidar à mão · ${bet.evento}\n` +
        `${bet.selecao}\n` +
        `Tenho o placar (${params.scoreDescription}), mas não consegui decidir a aposta com ele (${String(reason).replaceAll("_", " ")}).\n` +
        "👉 Liquide em Operações.",
      {
        source: "settlement.score-unsupported",
        key: bet.id,
        title: `Liquidação manual necessária: ${bet.evento}`,
        resource: "bet",
        resourceId: bet.id,
        autoResolve: false,
      },
    );
    log.warn({
      eventCode: LOG_EVENTS.SETTLEMENT_SCORE_REFUSED,
      betId: bet.id,
      evento: bet.evento,
      mercado: bet.mercado,
      selecao: bet.selecao,
      reason,
      actionableHint: "O placar obtido não suporta a liquidação automática deste mercado. Resolva manualmente em Operações com resultado auditado.",
    }, "settlement por placar recusado");
  } else if (silentFailure) {
    log.info({
      betId: bet.id,
      evento: bet.evento,
      mercado: bet.mercado,
      selecao: bet.selecao,
      reason,
    }, "placar ainda não acionável");
  }
}
