import type { PgBoss } from "pg-boss";
import { QUEUES, sportResolveKeyPrefix, sportResolveSingletonKey } from "@/src/infra/queue-contract";
import { cancelQueuedJobs } from "@/src/infra/cancel-queued-jobs";
import { withCurrentCorrelation } from "@/src/infra/observability-context";
import { prisma } from "@/src/infra/prisma";
import type { SportBridgeCursor } from "@/src/services/bets/sport-resolution/types";


export type SportResolutionJobData = {
  betId: string;
  attempt: number;
  origem?: string;
  bridgeCursor?: SportBridgeCursor;
  continuation?: number;
  /**
   * Tentativa avulsa, fora da cadeia de backoff: não agenda a próxima nem
   * avisa o dono no fim dela. A cadeia da aposta segue como estava.
   */
  oneShot?: boolean;
};

export async function enqueueSportResolution(
  boss: PgBoss,
  betId: string,
  options: {
    jobId?: string;
    attempt?: number;
    startAfterSeconds?: number;
    origem?: string;
    bridgeCursor?: SportBridgeCursor;
    continuation?: number;
    kickoff?: Date;
    oneShot?: boolean;
  } = {},
): Promise<string | null> {
  const attempt = options.attempt ?? 0;
  const kickoff = options.kickoff ?? (await prisma.bet.findUnique({
    where: { id: betId }, select: { data: true },
  }))?.data;
  return boss.send(
    QUEUES.sportResolve,
    withCurrentCorrelation({
      betId,
      attempt,
      ...(options.origem ? { origem: options.origem } : {}),
      ...(options.bridgeCursor ? { bridgeCursor: options.bridgeCursor } : {}),
      ...(options.continuation ? { continuation: options.continuation } : {}),
      ...(options.oneShot ? { oneShot: true } : {}),
    }),
    {
      ...(options.jobId ? { id: options.jobId } : {}),
      singletonKey: sportResolveSingletonKey(betId, attempt) + (options.oneShot ? ":one-shot" : "") +
        (options.continuation ? `:resume:${options.continuation}` : ""),
      // A prioridade é estável pelo dia de início; eventos próximos passam primeiro.
      ...(kickoff ? { priority: -Math.floor(kickoff.getTime() / 86_400_000) } : {}),
      ...(options.startAfterSeconds != null
        ? { startAfter: options.startAfterSeconds }
        : {}),
    },
  );
}

export async function cancelPendingSportResolution(boss: PgBoss, betId: string, onlyWhile?: "removed" | "settled"): Promise<number> {
  return cancelQueuedJobs(boss, QUEUES.sportResolve, betId, { prefix: sportResolveKeyPrefix(betId) }, onlyWhile);
}

/**
 * Os esportes do canal mudaram: a aposta dele ainda sem esporte ganha uma
 * tentativa avulsa agora, e o resolvedor já lê a marcação nova (com um esporte
 * só, a mesma regra da captura). A cadeia de backoff dela não é cancelada nem
 * reiniciada: o aviso do fim da busca sai uma vez só. Conflito continua com o
 * dono.
 */
export async function requeuePendingSportsOfBankroll(boss: PgBoss, bankrollId: string): Promise<number> {
  const bets = await prisma.bet.findMany({
    where: { bankrollId, deletedAt: null, sportResolutionStatus: "PENDING" },
    select: { id: true, data: true },
  });
  for (const bet of bets) {
    await enqueueSportResolution(boss, bet.id, { origem: "channel_sports_changed", kickoff: bet.data, oneShot: true });
  }
  return bets.length;
}
