import { fromPrisma, type PgBoss } from "pg-boss";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { createLogger } from "@/src/infra/logger";

const log = createLogger("cancel-queued-jobs");

/** Cancelamento após commit: uma falha é observável e não desfaz a operação financeira. */
export async function cancelQueuedJobs(
  boss: PgBoss,
  queue: string,
  betId: string,
  selector: { key: string } | { prefix: string },
  onlyWhile?: "removed" | "settled",
): Promise<number> {
  try {
    const predicate = "key" in selector
      ? Prisma.sql`singleton_key = ${selector.key}`
      : Prisma.sql`singleton_key LIKE ${selector.prefix.replace(/[\\%_]/g, "\\$&") + "%"}`;
    const cancel = async (db: Prisma.TransactionClient, guarded: boolean): Promise<number> => {
      let cutoff: Date | null = null;
      if (guarded) {
        // A restauração/reabertura usa a mesma trava: cancelamento atrasado
        // não pode atingir a cadeia que passou a valer depois do commit.
        await db.$queryRaw`SELECT id FROM bets WHERE id = ${betId} FOR NO KEY UPDATE`;
        const bet = await db.bet.findUnique({ where: { id: betId }, select: { deletedAt: true, status: true, settledAt: true } });
        if (!bet || (onlyWhile === "removed" ? !bet.deletedAt : bet.status === "PENDING")) return 0;
        cutoff = onlyWhile === "removed" ? bet.deletedAt : bet.settledAt;
        if (!cutoff) return 0;
      }
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM pgboss.job
        WHERE name = ${queue} AND ${predicate}
          AND state IN ('created', 'retry', 'active')
          AND (${cutoff}::timestamptz IS NULL OR created_on <= ${cutoff}::timestamptz)
      `;
      if (rows.length === 0) return 0;
      const ids = rows.map((row) => row.id);
      if (guarded) await boss.cancel(queue, ids, { db: fromPrisma(db) });
      else await boss.cancel(queue, ids);
      log.info({ queue, betId, cancelled: ids.length }, "jobs pendentes cancelados");
      return ids.length;
    };
    return onlyWhile ? await prisma.$transaction((tx) => cancel(tx, true)) : await cancel(prisma, false);
  } catch (err) {
    log.warn({ err, queue, betId }, "falha ao cancelar jobs pendentes");
    return 0;
  }
}
