import type { PgBoss } from "pg-boss";
import { getSharedBoss } from "@/src/infra/boss";
import { extractDlqErrorPayload } from "@/src/domain/dlq-classification";
import { parseTelegramJob, uuidFromKey } from "@/src/domain/telegram-job";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { Prisma } from "@/src/generated/prisma/client";
import { withCurrentCorrelation } from "@/src/infra/observability-context";
import { isContractQueue, QUEUES, recoverDlqSingletonKey } from "@/src/infra/queue-contract";
import { scrubSecrets } from "@/src/infra/redaction";
import { getPgBossQueueNames } from "@/src/services/ops/dlq/pgboss-queues";
import { reopenUnmatchedIdentity } from "@/src/services/sharp/revive";
import {
  findOriginalDeadLetterMetadata,
  findRetainedDeadLetterErrors,
} from "@/src/services/ops/dlq/repository";
import { telegramPostsOfDeadLetters, type DeadLetterTelegramPost } from "@/src/services/ops/dlq/telegram-post";
import { enqueueTelegramJob } from "@/src/services/scheduling/enqueue-telegram-job";

const log = createLogger("dlq");

/**
 * Inspeção e replay da dead-letter pelo painel. Replay = re-send do payload
 * original na fila de origem + remoção da DLQ, sempre auditado.
 */

export type DeadLetterRow = {
  id: string;
  /** Fila de origem (nome da DLQ sem o sufixo). */
  fila: string;
  data: unknown;
  criadoEm: Date;
  /** Erro que matou o job, quando o pg-boss preservou a saída. */
  erro: string | null;
  /** Classe registrada na retenção (`transient`, `business`, `other`). */
  classe: string | null;
  /** Recusa de negócio que se resolve sozinha: o que precisa acontecer antes. */
  waitsFor: string | null;
  /** Post do Telegram por trás de uma falha das filas `telegram.*`. */
  post: DeadLetterTelegramPost | null;
};

const DEFAULT_DEAD_LETTER_LIMIT = 200;

/** Janela padrão da LISTAGEM; a reconciliação da caixa de ações não usa recorte. */
const DEAD_LETTER_WINDOW_DAYS = 14;

type DeadLetterJob = {
  id: string;
  name: string;
  data: unknown;
  singletonKey: string | null;
};

const DLQ_PAYLOAD_ALLOWLIST = [
  "betId",
  "executionId",
  "jobId",
  "messageId",
  "origem",
  "sourceExternalId",
  "updateId",
] as const;

/** Preview mínimo; o payload cru continua apenas no pg-boss para permitir replay. */
function summarizeDeadLetterPayload(
  data: unknown,
): Record<string, Prisma.InputJsonValue | null> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const source = data as Record<string, unknown>;
  const summary: Record<string, Prisma.InputJsonValue | null> = {};
  for (const key of DLQ_PAYLOAD_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      summary[key] = scrubSecrets(value);
    }
  }
  return summary;
}

export async function listDeadLetters(
  limit = DEFAULT_DEAD_LETTER_LIMIT,
  /**
   * `null` = sem recorte de idade. A caixa de ações precisa disso: uma ação de
   * DLQ só pode encerrar quando o job SAI da fila (replay ou remoção), não
   * quando ele envelhece e cai da janela de exibição — senão a falha some da
   * caixa sozinha, sem ninguém ter olhado.
   */
  janelaDias: number | null = DEAD_LETTER_WINDOW_DAYS,
): Promise<DeadLetterRow[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
  const { deadLetters } = await getPgBossQueueNames();
  if (deadLetters.length === 0) return [];
  const rows = await prisma.$queryRaw<
    Array<{ id: string; name: string; data: unknown; created_on: Date; output: unknown }>
  >(Prisma.sql`
    SELECT id::text, name, data, created_on, COALESCE(source_output, output) AS output FROM pgboss.job
    WHERE name IN (${Prisma.join(deadLetters)})
      AND state IN ('created', 'retry', 'failed')
      AND (${janelaDias}::int IS NULL OR created_on > now() - make_interval(days => ${janelaDias}::int))
    ORDER BY created_on DESC
    LIMIT ${safeLimit}
  `);
  const retainedErrors = await findRetainedDeadLetterErrors(rows.map((r) => ({
    queue: r.name.slice(0, -".dlq".length),
    jobId: r.id,
  })));
  const posts = await telegramPostsOfDeadLetters(rows.map((r) => ({
    id: r.id, queue: r.name.slice(0, -".dlq".length), data: r.data,
  })));
  return rows.map((r) => {
    // A causa acionável da retida é a do AuditEvent, já sem segredos e com a
    // classe. A que o watcher ainda não tratou só tem a causa que o pg-boss
    // copiou da origem (`source_output`); o `output` dela chega vazio e vira o
    // sentinela "retida para replay manual" quando o watcher a falha.
    const retained = retainedErrors.get(r.id);
    const erro = retained?.errorMsg.trim()
      || extractDlqErrorPayload(r.output).message.trim();
    return {
      id: r.id,
      fila: r.name.slice(0, -".dlq".length),
      data: summarizeDeadLetterPayload(r.data),
      criadoEm: r.created_on,
      erro: erro === "" ? null : scrubSecrets(erro).slice(0, 400),
      classe: retained?.dlqClass ?? null,
      waitsFor: retained?.waitsFor ?? null,
      post: posts.get(r.id) ?? null,
    };
  });
}

export async function replayDeadLetter(
  jobId: string,
  actor: string,
  executionId?: string,
): Promise<{ fila: string } | null> {
  const { deadLetters } = await getPgBossQueueNames();
  if (deadLetters.length === 0) return null;
  const intent = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dlq-replay:${jobId}`}, 0))`;
    const rows = await tx.$queryRaw<DeadLetterJob[]>(Prisma.sql`
      SELECT id::text, name, data, singleton_key AS "singletonKey" FROM pgboss.job
      WHERE id = ${jobId}::uuid AND name IN (${Prisma.join(deadLetters)})
        AND state IN ('created', 'retry', 'failed')
      LIMIT 1
    `);
    const job = rows[0];
    if (!job) return null;
    const fila = job.name.slice(0, -".dlq".length);
    // A dead-letter de uma fila que esta versão não consome continua listada até
    // alguém apagar a fila; reprocessá-la deixaria o job parado na origem.
    if (!isContractQueue(fila)) {
      throw new Error(`A fila ${fila} não existe mais nesta versão; a tarefa ${jobId} não tem onde rodar.`);
    }
    // Payload fora do contrato não vira intent: o replay falharia a cada ciclo do outbox.
    if (fila === QUEUES.telegramUpdates) parseTelegramJob(fila, job.data);
    const existing = await tx.auditEvent.findFirst({
      where: { action: "dlq_replay", resource: "pgboss_job", resourceId: jobId, outcome: "pending" },
      select: { id: true },
    });
    if (existing) return existing;
    // O onDeadLetter do sharp.enrich encerra a identidade depois do jogo; sem
    // reabri-la, o job reenviado sairia sem consultar ninguém.
    const betId = (job.data as { betId?: unknown } | null)?.betId;
    if (fila === QUEUES.sharpEnrich && typeof betId === "string") {
      await reopenUnmatchedIdentity(betId, actor, "dlq-replay", tx);
    }
    return tx.auditEvent.create({
      data: {
        actor,
        action: "dlq_replay",
        resource: "pgboss_job",
        resourceId: jobId,
        outcome: "pending",
        details: {
          fila,
          payload: summarizeDeadLetterPayload(job.data),
          executionId: executionId ?? null,
        },
      },
      select: { id: true },
    });
  });
  if (!intent) return null;

  const boss = await getSharedBoss();
  return dispatchDeadLetterReplayAudit(boss, intent.id);
}

type ReplayAuditDetails = {
  fila?: unknown;
  executionId?: unknown;
  payload?: unknown;
};

/**
 * Despacha o intent persistido antes do efeito externo. O job novo leva o id
 * derivado do intent: se o processo cair depois do `send`, a retomada colide
 * nesse id e não agenda duas vezes.
 */
export async function dispatchDeadLetterReplayAudit(
  boss: PgBoss,
  auditId: string,
): Promise<{ fila: string } | null> {
  const audit = await prisma.auditEvent.findFirst({
    where: { id: auditId, action: "dlq_replay", outcome: "pending" },
    select: { id: true, resourceId: true, details: true, actor: true },
  });
  if (!audit?.resourceId) return null;
  const details = audit.details as ReplayAuditDetails | null;
  const fila = typeof details?.fila === "string" ? details.fila : null;
  if (!fila) throw new Error(`Intent de replay ${audit.id} sem fila válida.`);
  const dlqName = `${fila}.dlq`;
  const rows = await prisma.$queryRaw<DeadLetterJob[]>`
    SELECT id::text, name, data, singleton_key AS "singletonKey" FROM pgboss.job
    WHERE id = ${audit.resourceId}::uuid AND name = ${dlqName}
      AND state IN ('created', 'retry', 'failed')
    LIMIT 1
  `;
  const job = rows[0];
  if (!job) {
    await prisma.auditEvent.updateMany({
      where: { id: audit.id, outcome: "pending" },
      data: { outcome: "success" },
    });
    return { fila };
  }

  const executionId = typeof details?.executionId === "string" ? details.executionId : undefined;
  const replayId = executionId ?? uuidFromKey(`dlq-replay:${audit.id}`);
  const { replayJobId, singletonKey } = fila === QUEUES.telegramUpdates
    // Update do Telegram volta pela fila ordenada do post.
    ? { replayJobId: await enqueueTelegramJob(boss, parseTelegramJob(fila, job.data), { id: replayId }), singletonKey: null }
    : await replayOnSourceQueue(boss, fila, job, replayId);
  const deduplicado = replayJobId === null;
  const auditDetails = {
    fila,
    payload: details?.payload && typeof details.payload === "object" ? details.payload : {},
    executionId: executionId ?? null,
  };
  if (deduplicado && !(await sourceQueueHasReplay(fila, replayId, singletonKey))) {
    // Apagar a dead-letter aqui perderia o único vestígio do trabalho; `failure`
    // (e não `pending`) para o outbox não repetir o mesmo envio a cada minuto.
    const reason = `O pg-boss não agendou o replay de ${job.id} em ${fila} e não há job vivo dessa unidade.`;
    await prisma.auditEvent.updateMany({
      where: { id: audit.id, outcome: "pending" },
      data: { outcome: "failure", details: { ...auditDetails, reason } },
    });
    throw new Error(reason);
  }
  await boss.deleteJob(job.name, job.id);
  await prisma.auditEvent.updateMany({
    where: { id: audit.id, outcome: "pending" },
    data: {
      outcome: "success",
      details: { ...auditDetails, replayJobId, ...(deduplicado ? { deduplicado: true } : {}) },
    },
  });
  log.info(
    { jobId: job.id, replayJobId, fila, actor: audit.actor, deduplicado },
    "dead-letter reenfileirada",
  );
  return { fila };
}

/**
 * A `singletonKey` deduplica contra a unidade ainda viva (created, retry ou
 * active) nas filas exclusive. Sem `singletonSeconds`: o throttle do pg-boss
 * vale também para o job que já falhou ou concluiu, e descartaria o replay de
 * uma unidade que falhou de novo na mesma semana.
 */
async function replayOnSourceQueue(
  boss: PgBoss,
  fila: string,
  job: DeadLetterJob,
  replayId: string,
): Promise<{ replayJobId: string | null; singletonKey: string }> {
  const original = job.singletonKey
    ? null
    : await findOriginalDeadLetterMetadata(fila, job.data);
  const singletonKey = recoverDlqSingletonKey({
    name: fila,
    data: job.data,
    metadataKey: job.singletonKey ?? original?.singletonKey ?? null,
  }) ?? `dlq-replay:${job.id}`;
  const replayJobId = await boss.send(
    fila,
    withCurrentCorrelation((job.data ?? {}) as Record<string, unknown>),
    { id: replayId, singletonKey },
  );
  return { replayJobId, singletonKey };
}

/** O `send` que devolveu null só é dedup legítima se o trabalho está na origem. */
async function sourceQueueHasReplay(
  fila: string,
  replayId: string,
  singletonKey: string | null,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ found: number }>>`
    SELECT 1 AS found FROM pgboss.job
    WHERE name = ${fila}
      AND (id = ${replayId}::uuid
        OR (${singletonKey}::text IS NOT NULL AND singleton_key = ${singletonKey}
          AND state IN ('created', 'retry', 'active')))
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Repescagem do outbox de replay após falha de processo/pg-boss. */
export async function dispatchPendingDeadLetterReplays(boss: PgBoss): Promise<number> {
  const pending = await prisma.auditEvent.findMany({
    where: { action: "dlq_replay", outcome: "pending" },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true },
  });
  let dispatched = 0;
  for (const row of pending) {
    try {
      if (await dispatchDeadLetterReplayAudit(boss, row.id)) dispatched += 1;
    } catch (err) {
      log.error({ err, auditId: row.id }, "outbox de replay DLQ segue pendente");
    }
  }
  return dispatched;
}

export type ReplayDeadLettersResult = {
  replayed: number;
  alreadyGone: number;
  failures: number;
};

/**
 * Replay de um incidente agrupado. Cada membro continua auditado pelo caminho
 * unitario; o lote apenas garante que a acao da UI cobre a mesma base do `n`.
 */
export async function replayDeadLetters(
  jobIds: readonly string[],
  actor: string,
): Promise<ReplayDeadLettersResult> {
  const result: ReplayDeadLettersResult = { replayed: 0, alreadyGone: 0, failures: 0 };
  for (const jobId of jobIds) {
    try {
      const replayed = await replayDeadLetter(jobId, actor);
      if (replayed) result.replayed += 1;
      else result.alreadyGone += 1;
    } catch (err) {
      result.failures += 1;
      log.error({ jobId, actor, err }, "falha no replay agrupado de dead-letter");
    }
  }
  return result;
}
