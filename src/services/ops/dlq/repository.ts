import { prisma } from "@/src/infra/prisma";
import { scrubSecrets } from "@/src/infra/redaction";

export async function hasRetainedDeadLetter(queue: string, jobId: string): Promise<boolean> {
  const retained = await prisma.auditEvent.findFirst({
    where: { action: "job.dlq_retained", resource: queue, resourceId: jobId },
    select: { id: true },
  });
  return Boolean(retained);
}

export async function findOriginalDeadLetterMetadata(
  queue: string,
  data: unknown,
): Promise<{ output: unknown; singletonKey: string | null } | null> {
  const jobs = await prisma.$queryRaw<Array<{ output: unknown; singletonKey: string | null }>>`
    SELECT output, singleton_key AS "singletonKey"
    FROM pgboss.job
    WHERE name = ${queue} AND state = 'failed'
      AND (data::jsonb) = (${JSON.stringify(data)})::jsonb
    ORDER BY completed_on DESC NULLS LAST
    LIMIT 1
  `;
  return jobs[0] ?? null;
}

/**
 * Recupera em lote a causa original preservada antes de o handler da DLQ
 * lançar o erro sentinela que mantém o job disponível para replay manual.
 */
export async function findRetainedDeadLetterErrors(
  deadLetters: ReadonlyArray<{ queue: string; jobId: string }>,
): Promise<Map<string, { errorMsg: string; dlqClass: string | null; waitsFor: string | null }>> {
  if (deadLetters.length === 0) return new Map();
  const expectedQueueById = new Map(deadLetters.map((item) => [item.jobId, item.queue]));
  const rows = await prisma.auditEvent.findMany({
    where: {
      action: "job.dlq_retained",
      resourceId: { in: [...expectedQueueById.keys()] },
    },
    orderBy: { createdAt: "desc" },
    select: { resource: true, resourceId: true, details: true },
  });
  const errors = new Map<string, { errorMsg: string; dlqClass: string | null; waitsFor: string | null }>();
  for (const row of rows) {
    if (
      !row.resourceId ||
      expectedQueueById.get(row.resourceId) !== row.resource ||
      errors.has(row.resourceId) ||
      !row.details ||
      typeof row.details !== "object" ||
      Array.isArray(row.details)
    ) continue;
    const { errorMsg, dlqClass, waitsFor } = row.details as Record<string, unknown>;
    if (typeof errorMsg === "string" && errorMsg.trim() !== "") {
      errors.set(row.resourceId, { errorMsg, dlqClass: typeof dlqClass === "string" ? dlqClass : null,
        waitsFor: typeof waitsFor === "string" ? waitsFor : null });
    }
  }
  return errors;
}

/**
 * true quando o trabalho retido perdeu o ASSUNTO: a aposta não existe mais ou
 * está com `deletedAt`. Aposta apenas liquidada não entra: ainda há uma falha
 * real que o operador pode querer ver.
 */
export async function dlqPerdeuAssunto(betId: string): Promise<boolean> {
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    select: { deletedAt: true },
  });
  return !bet || bet.deletedAt !== null;
}

/** Falha de banco deve propagar; ausência, remoção ou estado final retornam false. */
export async function isBetStillPendingForDlq(betId: string): Promise<boolean> {
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    select: { status: true, deletedAt: true },
  });
  return Boolean(bet && !bet.deletedAt && bet.status === "PENDING");
}

/**
 * Maior que o ciclo de reenvios mais longo (12 de 2 h em 2 h): dentro de um
 * incidente todos contam; o payload que se repete (`closing.series`,
 * `capture.sport_resolve`) começa do zero no incidente seguinte.
 */
const REQUEUE_WINDOW_MS = 48 * 60 * 60_000;

export async function countDeadLetterRequeues(queue: string, payloadKey: string, now = new Date()): Promise<number> {
  return prisma.auditEvent.count({
    where: {
      action: "job.dlq_requeue", resource: queue, resourceId: payloadKey,
      createdAt: { gt: new Date(now.getTime() - REQUEUE_WINDOW_MS) },
    },
  });
}

/** Rastro do descarte de dead-letter cuja aposta foi removida ou nunca existiu. */
export async function recordDeadLetterDiscards(discards: ReadonlyArray<{
  queue: string;
  jobId: string;
  betId: string;
  errorMessage?: string;
  origem?: "varredura";
}>): Promise<void> {
  await prisma.auditEvent.createMany({
    data: discards.map((discard) => ({
      actor: "system",
      action: "job.dlq_discarded",
      resource: discard.queue,
      resourceId: discard.jobId,
      details: {
        betId: discard.betId,
        motivo: "aposta removida ou inexistente",
        ...(discard.errorMessage !== undefined
          ? { errorMsg: scrubSecrets(discard.errorMessage).slice(0, 400) }
          : {}),
        ...(discard.origem ? { origem: discard.origem } : {}),
      },
    })),
  });
}

export async function recordDeadLetterRequeue(params: {
  queue: string;
  payloadKey: string;
  jobId: string;
  requeuedJobId: string | null;
  errorMessage: string;
  startAfterSeconds: number;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      actor: "system",
      action: "job.dlq_requeue",
      resource: params.queue,
      resourceId: params.payloadKey,
      details: {
        errorMsg: scrubSecrets(params.errorMessage).slice(0, 400),
        startAfterSeconds: params.startAfterSeconds,
        dlqJobId: params.jobId,
        requeuedJobId: params.requeuedJobId,
        ...(params.requeuedJobId ? {} : { deduplicado: true }),
      },
    },
  });
}

export async function recordDeadLetterRetained(params: {
  queue: string;
  jobId: string;
  errorMessage: string;
  classification: string;
  waitsFor?: string;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      actor: "system",
      action: "job.dlq_retained",
      resource: params.queue,
      resourceId: params.jobId,
      details: {
        errorMsg: scrubSecrets(params.errorMessage).slice(0, 400),
        dlqClass: params.classification,
        ...(params.waitsFor ? { waitsFor: params.waitsFor } : {}),
      },
    },
  });
}

/** Rastro da dead-letter de fila agendada: o tique foi descartado, o próximo refaz o trabalho. */
export const SCHEDULED_TICK_DISCARD_ACTION = "job.dlq_tick_discarded";

export async function recordScheduledTickDiscards(discards: ReadonlyArray<{
  queue: string;
  jobId: string;
  errorMessage: string;
  classification: string;
  /** Cron longo: o disparo voltou à fila nesta tentativa, com esta espera. */
  retry?: { attempt: number; startAfterSeconds: number };
  origem?: "varredura";
}>): Promise<void> {
  if (discards.length === 0) return;
  await prisma.auditEvent.createMany({
    data: discards.map((discard) => ({
      actor: "system",
      action: SCHEDULED_TICK_DISCARD_ACTION,
      resource: discard.queue,
      resourceId: discard.jobId,
      details: {
        errorMsg: scrubSecrets(discard.errorMessage).slice(0, 400),
        dlqClass: discard.classification,
        ...(discard.retry ? { retry: discard.retry } : {}),
        ...(discard.origem ? { origem: discard.origem } : {}),
      },
    })),
  });
}

export async function countScheduledTickDiscards(queue: string, since: Date): Promise<number> {
  return prisma.auditEvent.count({
    where: { action: SCHEDULED_TICK_DISCARD_ACTION, resource: queue, createdAt: { gte: since } },
  });
}
