import { fromPrisma, type PgBoss } from "pg-boss";
import { prisma } from "@/src/infra/prisma";
import { QUEUES, enrichSingletonKey } from "@/src/infra/queue-contract";
import type { SharpContinuation } from "@/src/services/sharp/enrich/continuation";
import { isHistoricalIdentityRecovery } from "@/src/services/sharp/enrich/historical-identity";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";

export type SharpJobData = {
  betId: string;
  origem?: string;
  continuation?: SharpContinuation;
  continuations?: number;
  firstQueuedAt?: string;
};

/** Completar + reenfileirar é um único commit; rollback deixa o job original ativo. */
export async function continueSharpEnrich(
  boss: PgBoss,
  job: { id: string; data: SharpJobData },
  retryAt: Date,
  continuation: SharpContinuation,
): Promise<void> {
  const firstQueuedAt = job.data.firstQueuedAt ?? new Date().toISOString();
  const count = (job.data.continuations ?? 0) + 1;
  const startAfter = new Date(Math.max(Date.now() + 1_000, retryAt.getTime()));
  const id = await prisma.$transaction(async (tx) => {
    // Compartilha o lock da linha com remoção/edição; não cria sucessor após cancelamento.
    await tx.$queryRaw`SELECT id FROM bets WHERE id = ${job.data.betId} FOR UPDATE`;
    const bet = await tx.bet.findUnique({
      where: { id: job.data.betId },
      select: { id: true, data: true, registradoEm: true, sourcePostedAt: true, deletedAt: true, status: true, bankroll: { select: { sharpMode: true } } },
    });
    const db = fromPrisma(tx);
    const completed = await boss.complete(QUEUES.sharpEnrich, job.id, { deferred: true, continuation: count }, { db });
    if (!("affected" in completed) || typeof completed.affected !== "number") {
      throw new Error("pg-boss não confirmou a conclusão; revertendo continuação.");
    }
    if (!completed.affected || !bet || bet.deletedAt || bet.bankroll.sharpMode === "OFF") return null;
    if (bet.status !== "PENDING") {
      const sharp = await tx.betSharp.findUnique({ where: { betId: bet.id }, select: { identityStatus: true } });
      if (!isHistoricalIdentityRecovery({ ...bet, sharp }, new Date())) return null;
    }
    // O revival continua como backstop, sem loop infinito em falta prolongada de capacidade.
    if (count > 90 || Date.now() - Date.parse(firstQueuedAt) > 60 * 60_000) return null;
    const next = await boss.send(QUEUES.sharpEnrich, {
      ...job.data, firstQueuedAt, continuations: count, continuation,
    }, {
      db, singletonKey: enrichSingletonKey(job.data.betId), startAfter,
      priority: job.data.origem !== "revive" && Date.now() - Date.parse(firstQueuedAt) < 15 * 60_000 ? 10 : 0,
    });
    if (!next) throw new Error("Continuação sharp não foi criada; preservando job original para retry.");
    return next;
  });
  await recordOperationalMetric({
    kind: "action", name: "sharp.continuation", outcome: "expected_retry",
    durationMs: Math.max(0, startAfter.getTime() - Date.now()),
    labels: { scheduled: id !== null, continuation: count, cursor: continuation.bridge?.nextSearchAt ?? 0 },
  });
}
