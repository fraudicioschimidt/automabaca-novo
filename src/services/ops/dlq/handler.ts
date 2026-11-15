import type { Job, JobWithMetadata, PgBoss } from "pg-boss";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { parseTelegramJob } from "@/src/domain/telegram-job";
import { classifyDlqError, deadLetterGuidance, extractDlqErrorPayload } from "@/src/domain/dlq-classification";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { correlationIdFromPayload, runWithObservabilityContext } from "@/src/infra/observability-context";
import { prisma } from "@/src/infra/prisma";
import {
  deadLetterOf,
  enrichSingletonKey,
  QUEUES,
  recoverDlqSingletonKey,
} from "@/src/infra/queue-contract";
import { raiseOperationalAlertOnce, sendOperationalAlert, sendOperatorNotification } from "@/src/services/ops/alerts";
import {
  countDeadLetterRequeues,
  countScheduledTickDiscards,
  dlqPerdeuAssunto,
  findOriginalDeadLetterMetadata,
  findRetainedDeadLetterErrors,
  hasRetainedDeadLetter,
  isBetStillPendingForDlq,
  recordDeadLetterDiscards,
  recordDeadLetterRequeue,
  recordDeadLetterRetained,
  recordScheduledTickDiscards,
} from "@/src/services/ops/dlq/repository";
import {
  describeTelegramPost,
  telegramPostsOfDeadLetters,
  type DeadLetterTelegramPost,
} from "@/src/services/ops/dlq/telegram-post";
import { enqueueTelegramJob } from "@/src/services/scheduling/enqueue-telegram-job";

const log = createLogger("jobs");
const TRANSIENT_REQUEUE_MAX = 3;
const SPORT_BLOCKED_REQUEUE_MAX = 12;
const TRANSIENT_START_AFTER_SECONDS = 7200;
const TELEGRAM_TRANSIENT_START_AFTER_SECONDS = 120;
/** Teto por rodada das varreduras de dead-letter — a fila nunca chega perto disso. */
const ORPHAN_SWEEP_LIMIT = 200;

export function transientStartAfterSeconds(queue: string, priorRequeues = 0): number {
  // Keep the first recovery quick, then leave room for provider quotas to recover.
  // A fixed two-minute delay would exhaust every DLQ cycle within one outage.
  if (queue.startsWith("telegram")) {
    const delays = [TELEGRAM_TRANSIENT_START_AFTER_SECONDS, 600, 1800];
    const attempt = Number.isFinite(priorRequeues) ? Math.max(0, Math.trunc(priorRequeues)) : 0;
    return delays[Math.min(attempt, delays.length - 1)] ?? TELEGRAM_TRANSIENT_START_AFTER_SECONDS;
  }
  return TRANSIENT_START_AFTER_SECONDS;
}

export function transientDlqRequeueMax(errorName: string | undefined, errorMsg: string): number {
  return errorName === "SportNotConfirmedError" ||
    /ainda n[aã]o possui esporte confirmado/i.test(errorMsg)
    ? SPORT_BLOCKED_REQUEUE_MAX
    : TRANSIENT_REQUEUE_MAX;
}

/**
 * A tentativa em curso de um job do Telegram (`telegram.updates` ou o flush do
 * álbum em `telegram.deferred`) é a última: a fila não repete mais e a
 * dead-letter já fez todos os reenvios de falha passageira. Se ela falhar, o
 * post para na dead-letter.
 */
export async function isLastTelegramAttempt(queue: string, job: { data: unknown; retryCount?: number; retryLimit?: number }): Promise<boolean> {
  if (job.retryCount === undefined || job.retryLimit === undefined || job.retryCount < job.retryLimit) return false;
  const requeues = await countDeadLetterRequeues(queue, canonicalSha256(job.data));
  return requeues >= TRANSIENT_REQUEUE_MAX;
}

/**
 * Aposta nomeada no payload, sem política de fila. Duas perguntas usam isto com
 * escopos diferentes: "vale re-enfileirar?" só interessa ao `sharp.enrich`
 * (quem restringe é o chamador); "ainda existe assunto?" vale para qualquer
 * fila que nomeie uma aposta, como `capture.sport_resolve`.
 */
export function dlqBetId(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("betId" in data)) return null;
  const betId = (data as { betId: unknown }).betId;
  return typeof betId === "string" ? betId : null;
}

type DeadLetterFailure = {
  message: string;
  name?: string;
  code?: string;
  status?: number;
  businessRefusal?: boolean;
  waitsFor?: string;
  singletonKey: string | null;
};

type DeadLetterOptions = { onDeadLetter?: (data: unknown) => Promise<void>; cronMaxGapMinutes?: number };

async function extractFailure(
  name: string,
  job: Job,
): Promise<DeadLetterFailure> {
  const metadata = job as Job & Partial<JobWithMetadata>;
  // O pg-boss entrega a causa da falha da origem em `sourceOutput`; o `output`
  // da cópia é o da execução dela própria e chega vazio. Só a dead-letter
  // criada antes dessa coluna traz a causa no `output`.
  let response: unknown = metadata.sourceOutput ?? metadata.output;
  let singletonKey = metadata.singletonKey ?? null;
  if (!metadata.sourceId && (!response || !singletonKey)) {
    const original = await findOriginalDeadLetterMetadata(name, job.data);
    if (!response) response = original?.output;
    singletonKey ??= original?.singletonKey ?? null;
  }
  singletonKey = recoverDlqSingletonKey({ name, data: job.data, metadataKey: singletonKey });
  return { ...extractDlqErrorPayload(response), singletonKey };
}

async function notifyRequeue(name: string, job: Job, errorMsg: string, max: number): Promise<void> {
  const seconds = transientStartAfterSeconds(name);
  const delay = seconds >= 3600 ? `${seconds / 3600}h` : `${seconds / 60}min`;
  await sendOperatorNotification(
    `⏳ Tarefa adiada · ${name}\n` +
      `Falhou por um problema passageiro e vai tentar de novo em ${delay} (até ${max} vezes).` +
      (errorMsg ? `\nErro: ${errorMsg.slice(0, 300)}` : ""),
  );
}

async function alertFailedRequeue(name: string, job: Job, errorMsg: string): Promise<void> {
  await sendOperationalAlert(
    `🛑 Tarefa parada · ${name}\n` +
      `A tarefa ${job.id} falhou e não consegui agendá-la de novo.\n` +
      "👉 Reprocesse pelo painel.",
    {
      source: "jobs.dlq-requeue",
      key: `${name}:${job.id}`,
      title: `Falha ao reenfileirar ${name}`,
      resource: "pgboss-job",
      resourceId: String(job.id),
      evidence: { queue: name, error: errorMsg.slice(0, 400) },
      autoResolve: false,
    },
  );
}

async function tryTransientRequeue(params: {
  boss: PgBoss;
  name: string;
  job: Job;
  errorMsg: string;
  errorName?: string;
  singletonKey: string | null;
}): Promise<"requeued" | "skip" | "retain"> {
  const { boss, name, job, errorMsg, errorName, singletonKey } = params;
  const betId = name === QUEUES.sharpEnrich ? dlqBetId(job.data) : null;
  if (betId && !(await isBetStillPendingForDlq(betId))) {
    log.info({ queue: name, jobId: job.id, betId }, "DLQ transitório mas tip não PENDING — sem requeue");
    await sendOperatorNotification(
      `ℹ️ Tarefa descartada · ${name}\n` +
        `Falhou por um problema passageiro, mas a aposta ${betId} já foi liquidada ou removida, então não precisa repetir.` +
        (errorMsg ? `\nErro: ${errorMsg.slice(0, 300)}` : ""),
    );
    return "skip";
  }

  const payloadKey = canonicalSha256(job.data);
  const priorRequeues = await countDeadLetterRequeues(name, payloadKey);
  const requeueMax = transientDlqRequeueMax(errorName, errorMsg);
  if (priorRequeues >= requeueMax) {
    log.warn({ queue: name, jobId: job.id, priorRequeues }, "DLQ transitório esgotou requeues");
    return "retain";
  }
  if (priorRequeues === 0) await notifyRequeue(name, job, errorMsg, requeueMax);

  try {
    const startAfterSeconds = transientStartAfterSeconds(name, priorRequeues);
    let requeuedJobId: string | null;
    if (name === QUEUES.telegramUpdates) {
      requeuedJobId = await requeueTelegramJob(boss, job, startAfterSeconds);
    } else {
      const options: { startAfter: number; singletonKey?: string } = {
        startAfter: startAfterSeconds,
      };
      if (singletonKey) options.singletonKey = singletonKey;
      else if (betId) options.singletonKey = enrichSingletonKey(betId);
      requeuedJobId = await boss.send(name, job.data as object, options);
      if (!requeuedJobId && !options.singletonKey) {
        throw new Error(`pg-boss recusou o re-enfileiramento da fila "${name}" sem dedupe`);
      }
    }
    await recordDeadLetterRequeue({
      queue: name,
      payloadKey,
      jobId: String(job.id),
      requeuedJobId,
      errorMessage: errorMsg,
      startAfterSeconds,
    });
    return "requeued";
  } catch (error) {
    log.error({ sendErr: error, queue: name, jobId: job.id }, "falha ao re-enfileirar DLQ transitória");
    await alertFailedRequeue(name, job, errorMsg);
    return "retain";
  }
}

/**
 * Na fila ordenada, o job que falhou por algo passageiro volta a ser a cabeça
 * da fila do post: sai de `failed` para `retry` com a espera, e a edição que
 * chegou depois continua atrás dele. Sem a origem (já solta pela varredura),
 * o update entra de novo no fim da fila do post, com a mesma correlação para a
 * contagem de requeues não recomeçar.
 */
async function requeueTelegramJob(boss: PgBoss, job: Job, startAfter: number): Promise<string | null> {
  const queue = QUEUES.telegramUpdates;
  const sourceId = sourceIdOf(job);
  if (sourceId) {
    // O tipo do pg-boss 12 não declara `affected`, mas o retorno do retry o traz.
    const retried = await boss.retry(queue, sourceId) as { affected?: number };
    if ((retried.affected ?? 0) > 0) {
      await boss.update(queue, undefined, { id: sourceId, startAfter });
      return sourceId;
    }
  }
  const correlationId = correlationIdFromPayload(job.data);
  const requeue = () => enqueueTelegramJob(boss, parseTelegramJob(queue, job.data), { id: "fresh", startAfter });
  return correlationId
    ? runWithObservabilityContext({ correlationId, source: `queue:${deadLetterOf(queue)}` }, requeue)
    : requeue();
}

function sourceIdOf(job: Job): string | undefined {
  return (job as Job & Partial<JobWithMetadata>).sourceId ?? undefined;
}

/**
 * Dead-letter que não volta para a fila: a origem `failed` seguraria a chave
 * do post para sempre, e a cópia na dead-letter já guarda o que importa. Se
 * isto falhar, a varredura de chaves presas solta depois.
 */
async function releaseOrderingKey(boss: PgBoss, name: string, job: Job): Promise<void> {
  const sourceId = sourceIdOf(job);
  if (name !== QUEUES.telegramUpdates || !sourceId) return;
  try {
    await boss.deleteJob(name, sourceId);
  } catch (err) {
    log.error({ err, queue: name, jobId: job.id, sourceId }, "falha ao soltar a chave do post; a varredura tenta de novo");
  }
}

async function runDeadLetterCallback(
  name: string,
  job: Job,
  onDeadLetter: DeadLetterOptions["onDeadLetter"],
): Promise<void> {
  if (!onDeadLetter) return;
  try {
    await onDeadLetter(job.data);
  } catch (error) {
    log.error({ err: error, queue: name, jobId: job.id }, "onDeadLetter falhou");
    await sendOperationalAlert(
      `🛑 Falha ao tratar tarefa esgotada · ${name}\n` +
        `A tarefa ${job.id} esgotou as tentativas, e a rotina de encerramento dela também falhou.\n` +
        "👉 Confira nos logs do worker.",
      {
        source: "jobs.dead-letter-handler",
        key: `${name}:${job.id}`,
        title: `Falha no tratamento da DLQ ${name}`,
        resource: "pgboss-job",
        resourceId: String(job.id),
        autoResolve: false,
      },
    );
  }
}

/** Aviso de dead-letter retida: o que parou, de qual post (filas `telegram.*`) e o que fazer. */
export function retainedDeadLetterMessage(params: {
  queue: string;
  jobId: string;
  errorMessage: string;
  dlqClass: string;
  waitsFor: string | null;
  post: DeadLetterTelegramPost | null;
}): string {
  const { queue, jobId, errorMessage, dlqClass, waitsFor, post } = params;
  const { status, nextStep } = deadLetterGuidance({ dlqClass, waitsFor, hasPost: post !== null });
  const head = dlqClass === "business"
    ? `⚠️ Tarefa recusada pela regra · ${queue}\nA tarefa ${jobId} ficou guardada. ${status}`
    : `🛑 Tarefa esgotou as tentativas · ${queue}\nA tarefa ${jobId} parou e ficou guardada para análise.`;
  return [head, post ? describeTelegramPost(post) : null,
    errorMessage ? `Erro: ${errorMessage.slice(0, 400)}` : null, `👉 ${nextStep}`]
    .filter(Boolean).join("\n");
}

/** Fonte da ação "tarefa agendada falhando de novo"; o vigia dos agendamentos a fecha. */
export const SCHEDULED_FAILURE_ALERT_SOURCE = "jobs.scheduled-failure";
/** Duas falhas de uma fila agendada nesta janela viram um aviso. */
export const SCHEDULED_FAILURE_WINDOW_MS = 6 * 60 * 60_000;

/** Retentativas de um mesmo disparo de cron longo antes de desistir do dia. */
const SCHEDULED_RETRY_MAX_ATTEMPTS = 3;

/**
 * O que fazer com o disparo de cron que esgotou as tentativas. Se o disparo
 * seguinte vem antes da espera de um reenfileiramento (2 h), ele mesmo refaz o
 * trabalho, e a dead-letter é descartada. Se não (cron diário, de 2 em 2 h),
 * descartar perderia o dia: o disparo volta à fila.
 */
export function scheduledDeadLetterPolicy(cronMaxGapMinutes: number): "discard" | "retry" {
  return cronMaxGapMinutes * 60 < TRANSIENT_START_AFTER_SECONDS ? "discard" : "retry";
}

/** Espera da retentativa: até 2 h, e no máximo metade do intervalo, para não cair no disparo seguinte. */
function scheduledRetryDelaySeconds(cronMaxGapMinutes: number): number {
  return Math.min(TRANSIENT_START_AFTER_SECONDS, Math.floor((cronMaxGapMinutes * 60) / 2));
}

type ScheduledRetry = { origin: string; attempt: number };

/** A retentativa carrega no payload o disparo de origem e a tentativa, para contar por disparo. */
function scheduledRetryOf(data: unknown): ScheduledRetry | null {
  if (!data || typeof data !== "object" || !("scheduledRetry" in data)) return null;
  const retry = (data as { scheduledRetry: unknown }).scheduledRetry;
  if (!retry || typeof retry !== "object") return null;
  const { origin, attempt } = retry as { origin?: unknown; attempt?: unknown };
  return typeof origin === "string" && typeof attempt === "number" && Number.isSafeInteger(attempt)
    ? { origin, attempt }
    : null;
}

/**
 * Dead-letter de fila agendada: o job é um disparo do cron. Nunca fica retida
 * para replay (seria pedir ao dono uma decisão que não existe) nem volta sem
 * chave (o job `created` ocuparia a vaga da fila `exclusive`, e os disparos do
 * cron seriam descartados enquanto ele esperasse).
 * - Cron curto: a dead-letter sai; a repetição em 6 h vira UM aviso por fila.
 * - Cron longo: o disparo volta à fila com chave própria, que não disputa a
 *   vaga dos disparos do cron, até 3 vezes; esgotado, avisa que o disparo
 *   ficou sem ser feito.
 */
async function handleScheduledDeadLetters(
  boss: PgBoss,
  name: string,
  opts: DeadLetterOptions & { cronMaxGapMinutes: number },
  jobs: Job[],
  now = new Date(),
): Promise<void> {
  const policy = scheduledDeadLetterPolicy(opts.cronMaxGapMinutes);
  for (const job of jobs) {
    const jobId = String(job.id);
    let failure: DeadLetterFailure = { message: "", singletonKey: null };
    try {
      failure = await extractFailure(name, job);
    } catch (error) {
      log.error({ err: error, jobId }, "falha ao extrair erro original para DLQ");
    }
    const dlqClass = classifyDlqError(failure);
    const previous = scheduledRetryOf(job.data);
    const attempt = (previous?.attempt ?? 0) + 1;
    const retry = policy === "retry" && attempt <= SCHEDULED_RETRY_MAX_ATTEMPTS
      ? { origin: previous?.origin ?? sourceIdOf(job) ?? jobId, attempt,
        startAfterSeconds: scheduledRetryDelaySeconds(opts.cronMaxGapMinutes) }
      : null;
    log.warn(
      {
        eventCode: LOG_EVENTS.JOB_RETRY_EXHAUSTED,
        queue: name,
        jobId,
        dlqClass,
        errorName: failure.name || undefined,
        errorMessage: failure.message || undefined,
        ...(retry ? { retryAttempt: retry.attempt, startAfterSeconds: retry.startAfterSeconds } : {}),
        actionableHint: retry
          ? "Disparo de cron longo: volta à fila com chave própria e roda de novo na espera indicada."
          : policy === "retry"
            ? "Disparo de cron longo esgotou as retentativas: o trabalho deste disparo não foi feito."
            : "Disparo de cron curto: descartado, o próximo disparo refaz o trabalho.",
      },
      retry ? "disparo de fila agendada esgotou retries — volta à fila" : "disparo de fila agendada esgotou retries — descartado",
    );
    await runDeadLetterCallback(name, job, opts.onDeadLetter);
    if (retry) {
      await boss.send(name, { scheduledRetry: { origin: retry.origin, attempt: retry.attempt } }, {
        singletonKey: `scheduled-retry:${retry.origin}`,
        startAfter: retry.startAfterSeconds,
      });
    }
    await recordScheduledTickDiscards([{
      queue: name, jobId, errorMessage: failure.message, classification: dlqClass,
      ...(retry ? { retry: { attempt: retry.attempt, startAfterSeconds: retry.startAfterSeconds } } : {}),
    }]);
    await boss.deleteJob(deadLetterOf(name), jobId);
    if (retry) continue;
    if (policy === "retry") await warnScheduledRunLost(name, failure.message, SCHEDULED_RETRY_MAX_ATTEMPTS);
    else await warnRepeatedScheduledFailure(name, failure.message, now);
  }
}

async function warnScheduledRunLost(queue: string, errorMessage: string, attempts: number): Promise<void> {
  await raiseOperationalAlertOnce(
    `⚠️ Tarefa agendada não rodou · ${queue}\n`
      + `O disparo falhou e as ${attempts} retentativas também: o trabalho dele não foi feito, e o próximo `
      + "disparo é o do cron."
      + (errorMessage ? `\nÚltimo erro: ${errorMessage.slice(0, 300)}` : "")
      + "\n👉 Veja o log do worker desta fila. O aviso fecha sozinho quando ela voltar a concluir.",
    {
      source: SCHEDULED_FAILURE_ALERT_SOURCE,
      key: queue,
      title: `Tarefa agendada não rodou: ${queue}`,
      resource: "pgboss-queue",
      resourceId: queue,
      evidence: { queue, attempts },
    },
  );
}

async function warnRepeatedScheduledFailure(queue: string, errorMessage: string, now: Date): Promise<void> {
  const failures = await countScheduledTickDiscards(queue, new Date(now.getTime() - SCHEDULED_FAILURE_WINDOW_MS));
  if (failures < 2) return;
  await raiseOperationalAlertOnce(
    `⚠️ Tarefa agendada falhando de novo · ${queue}\n`
      + `${failures} execuções seguidas esgotaram as tentativas nas últimas 6 h. Cada falha é descartada, `
      + "porque o próximo disparo refaz o trabalho, mas enquanto isso ele não é feito."
      + (errorMessage ? `\nÚltimo erro: ${errorMessage.slice(0, 300)}` : "")
      + "\n👉 Veja o log do worker desta fila. O aviso fecha sozinho quando ela voltar a concluir.",
    {
      source: SCHEDULED_FAILURE_ALERT_SOURCE,
      key: queue,
      title: `Tarefa agendada falhando: ${queue}`,
      resource: "pgboss-queue",
      resourceId: queue,
      evidence: { queue, failures, windowHours: SCHEDULED_FAILURE_WINDOW_MS / 3_600_000 },
    },
  );
}

/**
 * Dead-letter de cron curto que ficou retida (o watcher falhou ao tratá-la):
 * sai com o mesmo rastro, e a ação da caixa fecha dizendo por quê. A de cron
 * longo não entra aqui: ela volta à fila pelo watcher ou pelo replay.
 */
export async function discardRetainedScheduledDeadLetters(
  boss: PgBoss,
  scheduledQueues: readonly string[],
): Promise<number> {
  if (scheduledQueues.length === 0) return 0;
  const retained = await prisma.$queryRaw<Array<{ id: string; name: string; data: unknown }>>`
    SELECT id::text AS id, name, data
    FROM pgboss.job
    WHERE name = ANY(${scheduledQueues.map(deadLetterOf)}::text[]) AND state = 'failed'
    LIMIT ${ORPHAN_SWEEP_LIMIT}
  `;
  if (retained.length === 0) return 0;
  const errors = await findRetainedDeadLetterErrors(retained.map((job) => ({
    queue: job.name.replace(/\.dlq$/, ""), jobId: job.id,
  })));
  await recordScheduledTickDiscards(retained.map((job) => {
    const known = errors.get(job.id);
    return {
      queue: job.name.replace(/\.dlq$/, ""),
      jobId: job.id,
      errorMessage: known?.errorMsg ?? "",
      classification: known?.dlqClass ?? "other",
      origem: "varredura" as const,
    };
  }));
  let discarded = 0;
  for (const job of retained) {
    try {
      await boss.deleteJob(job.name, job.id);
      discarded += 1;
    } catch (err) {
      log.error({ err, fila: job.name, jobId: job.id }, "falha ao descartar dead-letter de fila agendada; lote segue");
    }
  }
  log.warn({ discarded, filas: [...new Set(retained.map((job) => job.name))] }, "dead-letters de filas agendadas descartadas");
  return discarded;
}

/**
 * Watcher da `.dlq` de cada fila: falha transitória volta à fila com backoff;
 * dead-letter cuja aposta sumiu é descartada; o resto fica retido para replay
 * manual, com a causa registrada e o operador avisado.
 */
export async function handleDeadLetterBatch(
  boss: PgBoss,
  name: string,
  opts: DeadLetterOptions,
  jobs: Job[],
): Promise<void> {
  if (opts.cronMaxGapMinutes !== undefined) {
    return handleScheduledDeadLetters(boss, name, { ...opts, cronMaxGapMinutes: opts.cronMaxGapMinutes }, jobs);
  }
  let retainedFailure: Error | null = null;
  for (const job of jobs) {
    const jobId = String(job.id);
    const alreadyRetained = await hasRetainedDeadLetter(name, jobId);

    let failure: DeadLetterFailure = {
      message: "",
      singletonKey: null,
    };
    try {
      failure = await extractFailure(name, job);
    } catch (error) {
      log.error({ err: error, jobId: job.id }, "falha ao extrair erro original para DLQ");
    }
    const dlqClass = classifyDlqError({
      name: failure.name,
      code: failure.code,
      status: failure.status,
      message: failure.message,
      businessRefusal: failure.businessRefusal,
    });
    const betId = dlqBetId(job.data);

    log.error(
      {
        eventCode: LOG_EVENTS.JOB_RETRY_EXHAUSTED,
        queue: name,
        jobId: job.id,
        betId: betId ?? undefined,
        dlqClass,
        errorName: failure.name || undefined,
        errorMessage: failure.message || undefined,
        actionableHint: dlqClass === "transient"
          ? "Falha transitória. O handler tentará reenfileirar automaticamente com backoff."
          : "Falha permanente ou não-transitória. Inspecione o erro e execute replayDeadLetters([jobId]) após sanar a causa.",
      },
      "Job esgotou retries — movido para dead-letter",
    );

    if (dlqClass !== "transient") {
      if (betId && (await dlqPerdeuAssunto(betId))) {
        await recordDeadLetterDiscards([{ queue: name, jobId, betId, errorMessage: failure.message }]);
        await boss.deleteJob(deadLetterOf(name), jobId);
        log.warn(
          {
            eventCode: LOG_EVENTS.DLQ_JOB_DISCARDED,
            queue: name,
            jobId: job.id,
            betId,
            reason: "aposta_inexistente",
            actionableHint: "Aposta original foi removida ou cancelada; dead-letter descartada sem necessidade de replay.",
          },
          "dead-letter descartada: aposta inexistente",
        );
        await releaseOrderingKey(boss, name, job);
        continue;
      }
    }
    if (alreadyRetained && dlqClass !== "transient") {
      await releaseOrderingKey(boss, name, job);
      retainedFailure ??= new Error(`Dead-letter ${job.id} retida para replay manual.`);
      continue;
    }
    if (dlqClass === "transient") {
      const outcome = await tryTransientRequeue({
        boss,
        name,
        job,
        errorMsg: failure.message,
        errorName: failure.name,
        singletonKey: failure.singletonKey,
      });
      if (outcome === "requeued") continue;
      if (outcome === "skip") {
        await releaseOrderingKey(boss, name, job);
        continue;
      }
    }
    await releaseOrderingKey(boss, name, job);
    if (alreadyRetained) {
      retainedFailure ??= new Error(`Dead-letter ${job.id} retida para replay manual.`);
      continue;
    }

    const post = name.startsWith("telegram.")
      ? (await telegramPostsOfDeadLetters([{ id: jobId, queue: name, data: job.data }])
        .catch((error: unknown) => {
          log.warn({ err: error, queue: name, jobId }, "falha ao ler o post da dead-letter; aviso sai sem ele");
          return new Map<string, DeadLetterTelegramPost>();
        })).get(jobId) ?? null
      : null;
    await sendOperatorNotification(retainedDeadLetterMessage({
      queue: name, jobId, errorMessage: failure.message, dlqClass, waitsFor: failure.waitsFor ?? null, post,
    }));
    await runDeadLetterCallback(name, job, opts.onDeadLetter);
    await recordDeadLetterRetained({
      queue: name,
      jobId,
      errorMessage: failure.message,
      classification: dlqClass,
      ...(dlqClass === "business" && failure.waitsFor ? { waitsFor: failure.waitsFor } : {}),
    });
    retainedFailure = new Error(`Dead-letter ${job.id} retida para replay manual.`);
  }
  if (retainedFailure) throw retainedFailure;
}

/**
 * Descarta dead-letters já retidas cuja aposta deixou de existir.
 *
 * O watcher não alcança estas: a `.dlq` tem `retryLimit: 0` e entrega cada
 * dead-letter uma vez só. Aposta excluída depois disso (👎 horas depois)
 * deixaria o job em `failed` para sempre, reabrindo a ação a cada ciclo.
 * Fail-closed: só descarta quando o payload nomeia uma aposta inexistente ou
 * com `deletedAt`. Sem `betId` (telegram.updates) ou com aposta viva, a
 * dead-letter continua retida para decisão humana.
 */
export async function descartarDeadLettersSemAssunto(boss: PgBoss): Promise<number> {
  // Só `failed`: o job fica `active` enquanto o watcher o processa, e apagá-lo
  // ali engoliria a notificação ao operador.
  const presas = await prisma.$queryRaw<Array<{ id: string; name: string; data: unknown }>>`
    SELECT id::text AS id, name, data
    FROM pgboss.job
    WHERE name LIKE '%.dlq' AND state = 'failed'
    LIMIT ${ORPHAN_SWEEP_LIMIT}
  `;
  const comAposta = presas.flatMap((job) => {
    const betId = dlqBetId(job.data);
    return betId ? [{ ...job, betId }] : [];
  });
  if (comAposta.length === 0) return 0;

  const vivas = await prisma.bet.findMany({
    where: { id: { in: [...new Set(comAposta.map((job) => job.betId))] }, deletedAt: null },
    select: { id: true },
  });
  const idsVivos = new Set(vivas.map((bet) => bet.id));
  const orfas = comAposta.filter((job) => !idsVivos.has(job.betId));
  if (orfas.length === 0) return 0;

  await recordDeadLetterDiscards(orfas.map((job) => ({
    // A fila ORIGINAL é a identidade do trabalho; `.dlq` é só o transporte.
    queue: job.name.replace(/\.dlq$/, ""),
    jobId: job.id,
    betId: job.betId,
    origem: "varredura",
  })));
  // Isolado por job: o rastro já está gravado, e o que sobrar volta na próxima
  // passada, que é idempotente.
  let descartadas = 0;
  for (const job of orfas) {
    try {
      await boss.deleteJob(job.name, job.id);
      descartadas += 1;
    } catch (err) {
      log.error({ err, fila: job.name, jobId: job.id }, "falha ao descartar dead-letter; lote segue");
    }
  }
  log.warn(
    { descartadas, filas: [...new Set(orfas.map((job) => job.name))] },
    "dead-letters sem assunto descartadas",
  );
  return descartadas;
}

/** Tempo que o watcher da dead-letter tem para soltar a chave sozinho. */
const STUCK_KEY_AFTER_MS = 10 * 60_000;

/**
 * Rede da fila ordenada: job `failed` em `telegram.updates` segura a chave do
 * post, e todo update seguinte daquele post espera atrás dele. O watcher da
 * dead-letter apaga a origem na hora; se ele não conseguiu, esta varredura
 * apaga depois de 10 min (a cópia na dead-letter continua) e avisa o dono.
 */
export async function releaseStuckTelegramKeys(boss: PgBoss, now = new Date()): Promise<number> {
  // Worker sem o bot (dev sem token) nunca cria a fila.
  if (!(await boss.getQueue(QUEUES.telegramUpdates))) return 0;
  const keys = await boss.getBlockedKeys(QUEUES.telegramUpdates);
  let released = 0;
  for (const key of keys) {
    const jobs = await boss.findJobs(QUEUES.telegramUpdates, { key });
    for (const job of jobs) {
      const failedAt = job.completedOn ? new Date(job.completedOn).getTime() : null;
      if (job.state !== "failed" || failedAt === null || now.getTime() - failedAt < STUCK_KEY_AFTER_MS) continue;
      await boss.deleteJob(QUEUES.telegramUpdates, job.id);
      released += 1;
    }
  }
  if (released > 0) {
    log.warn({ queue: QUEUES.telegramUpdates, released }, "chaves de post presas soltas pela varredura");
    await sendOperationalAlert(
      `⚠️ Posts do Telegram destravados · ${released}\n` +
        "Um update falhou e ficou segurando a fila do próprio post por mais de 10 min. Soltei a fila; " +
        "a tarefa que falhou continua guardada.\n👉 Confira as tarefas paradas em Operações.",
      {
        source: "telegram.blocked-keys",
        key: "telegram-updates",
        title: "Fila de post do Telegram presa",
        resource: "pgboss-queue",
        resourceId: QUEUES.telegramUpdates,
        evidence: { released },
        autoResolve: false,
      },
    );
  }
  return released;
}
