import type { PgBoss } from "pg-boss";
import { enrichSingletonKey, QUEUES } from "@/src/infra/queue-contract";
import { cancelQueuedJobs } from "@/src/infra/cancel-queued-jobs";
import { withCurrentCorrelation } from "@/src/infra/observability-context";


/**
 * Enfileira `sharp.enrich` com chave estável por aposta.
 * A fila usa policy `exclusive` — `singletonKey` evita trabalho pendente ou
 * ativo duplicado na mesma bet (retry/DLQ continuam funcionando).
 *
 * Ausência esperada de linha não usa retry da fila: o worker conclui o job e
 * a cadência adaptativa de findBetsParaReviver decide a próxima tentativa.
 * Retry da fila fica reservado a falhas técnicas reais.
 */
export async function enqueueSharpEnrich(
  boss: PgBoss,
  betId: string,
  opts?: {
    jobId?: string;
    origem?: string;
    singletonSeconds?: number;
    retryLimit?: number;
    retryDelay?: number;
  },
): Promise<string | null> {
  return boss.send(
    QUEUES.sharpEnrich,
    withCurrentCorrelation({ betId, firstQueuedAt: new Date().toISOString(), ...(opts?.origem ? { origem: opts.origem } : {}) }),
    {
      ...(opts?.jobId ? { id: opts.jobId } : {}),
      singletonKey: enrichSingletonKey(betId),
      priority: opts?.origem === "revive" ? 0 : 10,
      ...(opts?.singletonSeconds != null
        ? { singletonSeconds: opts.singletonSeconds }
        : {}),
      ...(opts?.retryLimit != null ? { retryLimit: opts.retryLimit } : {}),
      ...(opts?.retryDelay != null ? { retryDelay: opts.retryDelay } : {}),
    },
  );
}

/** Cancela jobs `sharp.enrich` pendentes (created/retry/active) da aposta. */
export async function cancelPendingSharpEnrich(boss: PgBoss, betId: string, onlyWhile?: "removed" | "settled"): Promise<number> {
  return cancelQueuedJobs(boss, QUEUES.sharpEnrich, betId, { key: enrichSingletonKey(betId) }, onlyWhile);
}
