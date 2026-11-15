import type { JobWithMetadata, PgBoss } from "pg-boss";
import { cronMaxGapMinutes } from "@/src/domain/cron-cadence";
import { PGBOSS_NOTIFY_BACKSTOP_SECONDS } from "@/src/infra/boss";
import { createLogger } from "@/src/infra/logger";
import { handleDeadLetterBatch } from "@/src/services/ops/dlq/handler";
import {
  deadLetterOf,
  defaultQueuePolicy,
  type QueueOptions,
} from "@/src/infra/queue-contract";

const log = createLogger("jobs");

/** Retenção dos jobs agendados e dos disparos de boot. */
export const JOB_RETENTION_SECONDS = 2 * 24 * 60 * 60;
/**
 * Cron de minuto em minuto ou de 5 em 5 é mais da metade da tabela do pg-boss
 * e não serve de histórico: um dia basta para investigar e para o vigia de
 * "parou de rodar", que só olha o último concluído.
 */
const FREQUENT_JOB_RETENTION_SECONDS = 24 * 60 * 60;
const FREQUENT_CRON_MAX_GAP_MINUTES = 5;

/**
 * Dead-letter retida espera decisão humana. Com os 7 dias padrão do pg-boss ela
 * sumiria antes de alguém decidir, e a ação da caixa fecharia sozinha.
 */
export const DEAD_LETTER_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** Fila interna do pg-boss que dispara cada cron: um job por disparo, sem valor depois de concluído. */
const PGBOSS_CRON_DISPATCH_QUEUE = "__pgboss__send-it";

/**
 * O cron semanal guarda o dobro do intervalo: com os 2 dias dos demais, a
 * última conclusão sumiria da tabela antes do disparo seguinte, e o vigia de
 * "parou de rodar" daria a fila por parada toda semana.
 */
export function scheduledJobRetentionSeconds(cron: string): number {
  const maxGapMinutes = cronMaxGapMinutes(cron);
  if (maxGapMinutes <= FREQUENT_CRON_MAX_GAP_MINUTES) return FREQUENT_JOB_RETENTION_SECONDS;
  return Math.max(JOB_RETENTION_SECONDS, 2 * maxGapMinutes * 60);
}

async function ensureQueue(
  boss: PgBoss,
  name: string,
  opts: {
    deadLetter?: string;
    retryLimit?: number;
    retryDelay?: number;
    retryBackoff?: boolean;
    retryDelayMax?: number;
    policy?: QueueOptions["policy"];
    notify?: boolean;
    heartbeatSeconds?: number;
    expireInSeconds?: number;
    deleteAfterSeconds?: number;
  },
): Promise<void> {
  const existing = await boss.getQueue(name);
  if (existing && opts.policy && existing.policy !== opts.policy) {
    throw new Error(
      `Fila ${name} tem policy ${existing.policy}; migração operacional explícita necessária antes de usar ${opts.policy}. O boot não apaga filas automaticamente.`,
    );
  }
  const desired = {
    ...(opts.deadLetter ? { deadLetter: opts.deadLetter } : {}),
    ...(opts.retryLimit != null ? { retryLimit: opts.retryLimit } : {}),
    ...(opts.retryDelay != null ? { retryDelay: opts.retryDelay } : {}),
    ...(opts.retryBackoff != null ? { retryBackoff: opts.retryBackoff } : {}),
    ...(opts.retryDelayMax != null ? { retryDelayMax: opts.retryDelayMax } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.notify != null ? { notify: opts.notify } : {}),
    ...(opts.heartbeatSeconds != null ? { heartbeatSeconds: opts.heartbeatSeconds } : {}),
    ...(opts.expireInSeconds != null ? { expireInSeconds: opts.expireInSeconds } : {}),
    ...(opts.deleteAfterSeconds != null ? { deleteAfterSeconds: opts.deleteAfterSeconds } : {}),
  };
  if (existing === null) {
    await boss.createQueue(name, desired);
    return;
  }
  const mutableDrift = Object.fromEntries(
    Object.entries(desired).filter(([key, value]) => (
      key !== "policy" && existing?.[key as keyof typeof existing] !== value
    )),
  );
  // O pg-boss recusa `retryDelayMax` sem ver `retryBackoff: true` no MESMO
  // payload (`attorney.js`). Mandar só o teto — o caso de quem ajusta apenas
  // ele depois — derruba o boot do worker inteiro, não a fila.
  if ("retryDelayMax" in mutableDrift && desired.retryBackoff != null) {
    mutableDrift.retryBackoff = desired.retryBackoff;
  }
  if (Object.keys(mutableDrift).length > 0) {
    log.warn({ queue: name, drift: mutableDrift }, "configuração mutável da fila diverge — atualizando");
    await boss.updateQueue(name, mutableDrift);
  }
}

/**
 * TOPOLOGIA da fila: cria a fila e sua dead-letter ligadas, sem consumir nada.
 * Devolve o nome da DLQ.
 *
 * Separado de `registerQueue` porque criar a fila e CONSUMIR a DLQ são coisas
 * diferentes: quem só precisa da topologia não deve levar junto um consumidor
 * vivo que rouba qualquer dead-letter semeada como fixture de teste.
 */
export async function ensureQueueWithDeadLetter(
  boss: PgBoss,
  name: string,
  opts: QueueOptions = {},
): Promise<string> {
  const deadLetter = deadLetterOf(name);
  await ensureQueue(boss, deadLetter, {
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    policy: "standard",
    notify: true,
    // Vale para as dead-letters novas: o pg-boss grava o prazo em cada job ao
    // criá-lo, e as que já estavam na fila mantêm os 7 dias de antes.
    deleteAfterSeconds: DEAD_LETTER_RETENTION_SECONDS,
  });
  await ensureQueue(boss, name, {
    deadLetter,
    retryLimit: opts.retryLimit ?? 3,
    retryDelay: opts.retryDelay ?? 60,
    retryBackoff: opts.retryBackoff ?? true,
    ...(opts.retryDelayMax != null ? { retryDelayMax: opts.retryDelayMax } : {}),
    policy: opts.policy ?? defaultQueuePolicy(name),
    notify: true,
    ...(opts.heartbeatSeconds != null ? { heartbeatSeconds: opts.heartbeatSeconds } : {}),
    ...(opts.expireInSeconds != null ? { expireInSeconds: opts.expireInSeconds } : {}),
    ...(opts.deleteAfterSeconds != null ? { deleteAfterSeconds: opts.deleteAfterSeconds } : {}),
  });
  return deadLetter;
}

/** Cria a fila, sua dead-letter e o watcher fail-loud da DLQ. */
export async function registerQueue(
  boss: PgBoss,
  name: string,
  opts: QueueOptions = {},
): Promise<void> {
  const deadLetter = await ensureQueueWithDeadLetter(boss, name, opts);
  await boss.work(
    deadLetter,
    {
      includeMetadata: true,
      notifyPollingIntervalSeconds: PGBOSS_NOTIFY_BACKSTOP_SECONDS,
    },
    async (jobs: JobWithMetadata[]) => handleDeadLetterBatch(boss, name, opts, jobs),
  );
}

/**
 * Retenção da fila interna de disparo dos crons. O pg-boss a cria sem opções no
 * `start()` e nunca a ajusta; cada disparo vira um job guardado 7 dias.
 */
export async function tunePgBossCronDispatchRetention(boss: PgBoss): Promise<void> {
  const queue = await boss.getQueue(PGBOSS_CRON_DISPATCH_QUEUE);
  if (!queue || queue.deleteAfterSeconds === FREQUENT_JOB_RETENTION_SECONDS) return;
  await boss.updateQueue(PGBOSS_CRON_DISPATCH_QUEUE, { deleteAfterSeconds: FREQUENT_JOB_RETENTION_SECONDS });
  log.info({ queue: PGBOSS_CRON_DISPATCH_QUEUE, deleteAfterSeconds: FREQUENT_JOB_RETENTION_SECONDS }, "retenção da fila de disparo dos crons ajustada");
}
