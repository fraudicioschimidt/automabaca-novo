import type { Prisma } from "@/src/generated/prisma/client";
import { fmtU } from "@/src/domain/formato-de-resultado";
import { emojiStatus, rotuloStatus } from "@/src/domain/mensagem-operador";
import { mentionsLiveEntry } from "@/src/domain/live-score-at-tip";
import { toNumber } from "@/src/domain/money";
import { supportsBasketballFirstHalf } from "@/src/domain/settlement/basketball-half";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";
import { verifyBasketballHalfDetails, type BasketballHalfProof } from "@/src/providers/flashscore/basketball-half";
import type { FlashscoreMatchCandidate } from "@/src/providers/flashscore/match";
import { applyAutomaticBetStatusChangeTx, BetNotPendingError } from "@/src/services/bets/settle";
import { finishBetStatusChange } from "@/src/services/bets/settle-effects";
import { sendOperationalAlert, sendOperatorNotification } from "@/src/services/ops/alerts";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { recordFlashscoreFirstCheckTx } from "./observation-store";
import { fetchMatchDetails, STATS_GRACE_MS, type DetailsCache } from "./settle";

/** Só pré-jogo e aposta simples: o contrato de placar restante/live é outro. */
function supportedBet(bet: EligibleBet): boolean {
  const posted = bet.sourcePostedAt ?? bet.registradoEm;
  return supportsBasketballFirstHalf(bet) && !bet.legsJson && bet.playerPropRevision === undefined
    && !bet.kickoffInferido && posted.getTime() < bet.data.getTime()
    && bet.liveScoreHome == null && bet.liveScoreAway == null && !bet.liveTextAtCapture
    && ![bet.mercado, bet.selecao].some(mentionsLiveEntry);
}

/**
 * 1º tempo de basquete: o placar do período sai de `/matches/details`, é
 * verificado de novo dentro da transação e só então liquida.
 */
export async function processBasketballHalf(params: {
  bet: EligibleBet; candidate: FlashscoreMatchCandidate; cache: DetailsCache; now: Date;
}): Promise<{ settled: boolean; unsupported: boolean; observationFinal: boolean;
  settlementOutcome: string; proof: BasketballHalfProof | null }> {
  const refused = (reason: string, pending = false) => ({ settled: false, unsupported: !pending,
    observationFinal: !pending, settlementOutcome: `${pending ? "pending" : "manual"}_basketball_half_${reason}`, proof: null });
  if (!supportedBet(params.bet)) return refused("unsupported_contract");
  const observation = await fetchMatchDetails(params.candidate.match.match_id, params.cache);
  const verified = verifyBasketballHalfDetails({ ...observation, candidate: params.candidate, now: new Date() });
  if (!verified.ok) {
    const pending = params.now.getTime() - params.bet.data.getTime() < STATS_GRACE_MS;
    if (!pending) await sendOperationalAlert(
      `✋ Liquidar à mão · ${params.bet.evento}\n${params.bet.selecao}\nO FlashScore não comprovou o placar do primeiro tempo.\n👉 Liquide em Operações.`,
      { source: "settlement.flashscore-basketball-half", key: params.bet.id,
        title: `Primeiro tempo sem placar comprovado: ${params.bet.evento}`, resource: "bet",
        resourceId: params.bet.id, autoResolve: false, evidence: { reason: verified.reason } },
    );
    return refused(verified.reason, pending);
  }
  const proof = verified.proof;
  const resolution = resolveResultFromScore({ ...params.bet, scorePeriod: "HT",
    homeScore: proof.score.home, awayScore: proof.score.away,
    odds: toNumber(params.bet.odds), stake: toNumber(params.bet.stake) });
  if (!resolution.ok) return refused(resolution.reason);
  let applied;
  try {
    applied = await runSerializableTransaction("basketballHalfSettle", async (tx) => {
      // Reconstituir a prova antes de gravar; termos e CAS são revalidados pelo motor financeiro.
      const repeated = verifyBasketballHalfDetails({ ...observation, candidate: params.candidate, now: new Date() });
      if (!repeated.ok || repeated.proof.payloadSha256 !== proof.payloadSha256) {
        throw new Error("Prova de primeiro tempo alterada ou vencida antes da liquidação.");
      }
      const result = await applyAutomaticBetStatusChangeTx(tx, { betId: params.bet.id,
        newStatus: resolution.status, source: "flashscore", expectedTerms: params.bet });
      if (result.previousStatus === "PENDING") {
        const resultSnapshot = { outcome: "matched", settlementOutcome: "settled_from_basketball_first_half",
          basketballFirstHalf: proof } as unknown as Prisma.InputJsonValue;
        const data = { resultProvider: "flashscore", resultMatchId: proof.matchId,
          resultCheckedAt: new Date(proof.observedAt), resultFinal: true, resultSnapshot };
        await recordFlashscoreFirstCheckTx(tx, params.bet.id, data.resultCheckedAt);
        await tx.betResult.upsert({ where: { betId: params.bet.id },
          create: { betId: params.bet.id, ...data }, update: data });
        // scoreHome/scoreAway conservam seu contrato FT: o parcial está identificado no snapshot.
      }
      return result;
    });
  } catch (error) {
    if (error instanceof BetNotPendingError) return { ...refused("already_settled"), unsupported: false, settlementOutcome: "already_settled" };
    throw error;
  }
  const settled = applied.previousStatus === "PENDING";
  if (settled) {
    await finishBetStatusChange(params.bet.id, applied);
    await sendOperatorNotification(
      `${emojiStatus(applied.status)} ${rotuloStatus(applied.status)} (${fmtU(applied.lucro)}) · ${params.bet.evento}\n` +
        `${params.bet.selecao}\n` +
        `1º tempo: ${proof.score.home}–${proof.score.away} (FlashScore)`,
      { key: `settlement:${params.bet.id}:${params.bet.manualSettlementVersion ?? 0}` },
    );
  }
  return { settled, unsupported: false, observationFinal: true, proof,
    settlementOutcome: settled ? "settled_from_basketball_first_half" : "already_settled" };
}
