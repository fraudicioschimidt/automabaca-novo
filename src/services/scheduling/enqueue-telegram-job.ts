import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { parseTelegramJob, routeTelegramJob, type TelegramJob } from "@/src/domain/telegram-job";
import { QUEUES } from "@/src/infra/queue-contract";
import { withCurrentCorrelation } from "@/src/infra/observability-context";

/**
 * Único caminho para pôr trabalho do Telegram na fila ordenada. Valida o
 * payload antes do `send`: o que entra na fila sempre passa no contrato.
 *
 * Nunca manda `singletonSeconds`: na fila `key_strict_fifo` a `singletonKey`
 * é a chave de ORDEM, e o throttle descartaria a edição que chega logo depois
 * do post. A reentrega do mesmo update é barrada pelo id determinístico
 * (`ON CONFLICT DO NOTHING`), e aí o `send` devolve `null`.
 */
export async function enqueueTelegramJob(
  boss: PgBoss,
  job: TelegramJob,
  options: {
    /** Pedido explícito (replay, "Capturar mesmo assim"): roda de novo mesmo com conteúdo igual. */
    id?: string | "fresh";
    startAfter?: number;
  } = {},
): Promise<string | null> {
  const valid = parseTelegramJob(QUEUES.telegramUpdates, job);
  const route = routeTelegramJob(valid);
  return boss.send(QUEUES.telegramUpdates, withCurrentCorrelation(valid), {
    id: options.id === "fresh" ? randomUUID() : options.id ?? route.id,
    singletonKey: route.orderingKey,
    group: { id: route.group },
    ...(options.startAfter != null ? { startAfter: options.startAfter } : {}),
  });
}
