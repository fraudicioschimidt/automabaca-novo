import { Prisma } from "@/src/generated/prisma/client";
import { extractDlqErrorPayload } from "@/src/domain/dlq-classification";
import {
  countsAsReleaseError,
  isPublishedSha,
  judgeRelease,
  observationEndOf,
  releaseVerdictMessage,
  type ReleaseErrorOccurrence,
  type ReleaseFinding,
  type ReleaseRecord,
  type ReleaseVerdictKind,
} from "@/src/domain/release-verdict";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { scrubSecrets } from "@/src/infra/redaction";
import { getMessageFingerprint, sendRequiredOperatorNotification } from "@/src/services/ops/alerts";
import { AUDIT_RETENTION_DAYS } from "@/src/services/ops/audit-purge";

const log = createLogger("release-verdict");

const READY_ACTION = "release.ready";
const VERDICT_ACTION = "release.verdict";
const RESOURCE = "release";
const DAY_MS = 86_400_000;
/** Linha de base lida do pg-boss antes da release (o job some depois de 1 a 7 dias). */
const BASELINE_DAYS = 7;
/** Release mais velha que isto sem veredito fica sem: o worker parou demais para julgá-la. */
const PENDING_MAX_AGE_MS = DAY_MS;
/** Saídas distintas lidas da linha de base, das mais recentes para as mais velhas. */
const BASELINE_LIMIT = 5_000;
const OCCURRENCE_LIMIT = 20_000;
const STORED_FINDINGS = 20;
/**
 * O erro da linha de base lembrado há mais que isto é gravado de novo: a
 * memória dura 30 dias desde a última vez que o erro apareceu, não desde a primeira.
 */
const MEMORY_RENEWAL_DAYS = 7;

/**
 * Registra a release no primeiro boot pronto dela; o restart da mesma release
 * não conta de novo. Fora de produção (sem sha publicado) não há release.
 */
export async function recordReleaseReady(input: {
  bootedAt: Date;
  readyAt?: Date;
  releaseId?: string;
  sha?: string;
}): Promise<"recorded" | "already_recorded" | "not_a_release"> {
  const releaseId = input.releaseId ?? process.env.AUTOMABACA_RELEASE_ID ?? "";
  const sha = input.sha ?? process.env.AUTOMABACA_RELEASE_SHA ?? "";
  if (!releaseId || !isPublishedSha(sha)) return "not_a_release";
  const readyAt = input.readyAt ?? new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${READY_ACTION}, 0))`;
    const existing = await tx.auditEvent.findFirst({
      where: { action: READY_ACTION, resource: RESOURCE, resourceId: releaseId },
      select: { id: true },
    });
    if (existing) return "already_recorded";
    const recentReleases = await tx.auditEvent.findMany({
      where: { action: READY_ACTION, resource: RESOURCE },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { details: true },
    });
    const previous = latestFirst(recentReleases.flatMap((row) => parseReleaseReady(row.details) ?? []))[0];
    await tx.auditEvent.create({
      data: {
        actor: "system",
        action: READY_ACTION,
        resource: RESOURCE,
        resourceId: releaseId,
        details: {
          releaseId,
          sha,
          bootedAt: input.bootedAt.toISOString(),
          readyAt: readyAt.toISOString(),
          previousSha: previous?.sha ?? null,
        },
      },
    });
    return "recorded";
  });
}

/**
 * `ops.release_verdict`: julga cada release 45 min depois de ela ficar pronta
 * e avisa o dono da que trouxe erro novo. Um aviso que não saiu é tentado de
 * novo nas passadas seguintes, por 24 h; o texto igual deduplica.
 */
export async function judgePendingReleases(now = new Date()): Promise<{ judged: number; flagged: number; notified: number }> {
  const pending = await readPendingReleases(now);
  const flagged = await judgeReleases(pending, now);
  const notified = await notifyFlaggedReleases(now);
  return { judged: pending.length, flagged, notified };
}

type StoredFinding = Omit<ReleaseFinding, "fingerprint">;

export type ReleaseOverview = {
  releaseId: string;
  sha: string;
  previousSha: string | null;
  readyAt: Date;
  observationEnd: Date;
  /** `em_observacao` inclui a release já observada que espera a próxima passada do job. */
  state: "em_observacao" | "sem_veredito" | ReleaseVerdictKind;
  findings: StoredFinding[];
  belowThreshold: StoredFinding[];
  knownErrors: number | null;
  /** Aviso do Telegram da release com erro novo; as tentativas duram 24 h depois do veredito. */
  notice: "sent" | "retrying" | "gave_up" | null;
};

export type RecentReleases = {
  releases: ReleaseOverview[];
  /** Releases com veredito de erro novo dado nas últimas 24 h: acendem o número de Desempenho. */
  flaggedLast24h: number;
};

/**
 * As últimas releases com o veredito de cada uma, para o Monitoramento, e as
 * apontadas com erro novo nas últimas 24 h que já saíram delas: com várias
 * publicações por hora, a apontada à noite sairia da lista antes de o dono
 * abrir o painel de manhã.
 */
export async function getRecentReleases(limit = 10, now = new Date()): Promise<RecentReleases> {
  const [latestRows, flaggedRows] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { action: READY_ACTION, resource: RESOURCE },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { resourceId: true, details: true },
    }),
    prisma.auditEvent.findMany({
      where: {
        action: VERDICT_ACTION,
        resource: RESOURCE,
        createdAt: { gte: new Date(now.getTime() - PENDING_MAX_AGE_MS) },
        details: { path: ["verdict"], equals: "erro_novo" },
      },
      select: { resourceId: true },
    }),
  ]);
  const flaggedIds = new Set(flaggedRows.flatMap((row) => row.resourceId ?? []));
  const listedIds = new Set(latestRows.map((row) => row.resourceId));
  const missingIds = [...flaggedIds].filter((id) => !listedIds.has(id));
  const olderRows = missingIds.length === 0 ? [] : await prisma.auditEvent.findMany({
    where: { action: READY_ACTION, resource: RESOURCE, resourceId: { in: missingIds } },
    select: { resourceId: true, details: true },
  });
  const releases = latestFirst([...latestRows, ...olderRows].flatMap((row) => parseReleaseReady(row.details) ?? []));
  const verdicts = await readVerdicts(releases.map((release) => release.releaseId));
  const overviews = releases.map((release): ReleaseOverview => {
    const verdict = verdicts.get(release.releaseId);
    const observationEnd = observationEndOf(release);
    return {
      releaseId: release.releaseId,
      sha: release.sha,
      previousSha: release.previousSha,
      readyAt: release.readyAt,
      observationEnd,
      state: verdict?.verdict
        ?? (now.getTime() - release.readyAt.getTime() > PENDING_MAX_AGE_MS ? "sem_veredito" : "em_observacao"),
      findings: verdict?.findings ?? [],
      belowThreshold: verdict?.belowThreshold ?? [],
      knownErrors: verdict?.knownErrors ?? null,
      notice: verdict?.verdict !== "erro_novo" ? null
        : verdict.notifiedAt != null ? "sent"
        : now.getTime() - verdict.judgedAt.getTime() <= PENDING_MAX_AGE_MS ? "retrying"
        : "gave_up",
    };
  });
  return {
    releases: overviews,
    // Contado na lista, para o número nunca apontar uma release que o cartão não mostra.
    flaggedLast24h: overviews.filter((release) => flaggedIds.has(release.releaseId) && release.state === "erro_novo").length,
  };
}

// ───────────── julgamento ─────────────

async function readPendingReleases(now: Date): Promise<ReleaseRecord[]> {
  const rows = await prisma.auditEvent.findMany({
    where: { action: READY_ACTION, resource: RESOURCE, createdAt: { gte: new Date(now.getTime() - PENDING_MAX_AGE_MS) } },
    select: { details: true },
  });
  const releases = rows.flatMap((row) => parseReleaseReady(row.details) ?? []);
  if (releases.length === 0) return [];
  const judged = await prisma.auditEvent.findMany({
    where: { action: VERDICT_ACTION, resource: RESOURCE, resourceId: { in: releases.map((release) => release.releaseId) } },
    select: { resourceId: true },
  });
  const judgedIds = new Set(judged.map((row) => row.resourceId));
  return releases
    .filter((release) => !judgedIds.has(release.releaseId)
      && observationEndOf(release) <= now
      && now.getTime() - release.readyAt.getTime() <= PENDING_MAX_AGE_MS)
    .sort((a, b) => a.bootedAt.getTime() - b.bootedAt.getTime());
}

/**
 * Julga as releases na ordem do boot. O que falhou antes de cada uma (a
 * memória dos vereditos, a linha de base do pg-boss e a observação das
 * anteriores) é conhecido para ela; o que ela produziu passa a ser conhecido
 * para as seguintes e fica gravado no veredito dela.
 */
async function judgeReleases(pending: readonly ReleaseRecord[], now: Date): Promise<number> {
  const [first] = pending;
  if (!first) return 0;
  const firstBoot = first.bootedAt;
  const lastEnd = new Date(Math.max(...pending.map((release) => observationEndOf(release).getTime())));
  const [recorded, baseline, occurrences] = await Promise.all([
    readRecordedFingerprints(new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS)),
    readBaselineFingerprints(new Date(firstBoot.getTime() - BASELINE_DAYS * DAY_MS), firstBoot),
    readErrorOccurrences(firstBoot, lastEnd),
  ]);
  const known = new Set(recorded.keys());
  const renewBefore = new Date(now.getTime() - MEMORY_RENEWAL_DAYS * DAY_MS);
  let toRecord = new Set<string>();
  const record = (fingerprint: string) => {
    known.add(fingerprint);
    toRecord.add(fingerprint);
    recorded.set(fingerprint, now);
  };
  const learn = (fingerprint: string) => {
    const lastRecorded = recorded.get(fingerprint);
    if (!lastRecorded || lastRecorded < renewBefore) record(fingerprint);
  };
  baseline.forEach(learn);

  let flagged = 0;
  for (const release of pending) {
    const end = observationEndOf(release);
    for (const occurrence of occurrences) if (occurrence.occurredAt < release.bootedAt) learn(occurrence.fingerprint);
    const judgement = judgeRelease({
      releaseId: release.releaseId,
      occurrences: occurrences.filter((occurrence) => occurrence.occurredAt >= release.bootedAt && occurrence.occurredAt < end),
      known,
    });
    // O que a release produziu vai sempre, e a memória dele recomeça daqui.
    judgement.seen.forEach(record);
    await prisma.auditEvent.create({
      data: {
        actor: "system",
        action: VERDICT_ACTION,
        resource: RESOURCE,
        resourceId: release.releaseId,
        outcome: judgement.verdict === "erro_novo" ? "attention" : "success",
        details: {
          releaseId: release.releaseId,
          sha: release.sha,
          previousSha: release.previousSha,
          verdict: judgement.verdict,
          observedUntil: end.toISOString(),
          knownErrors: judgement.knownErrors,
          findings: judgement.findings.slice(0, STORED_FINDINGS).map(storedFinding),
          belowThreshold: judgement.belowThreshold.slice(0, STORED_FINDINGS).map(storedFinding),
          seen: [...toRecord],
          notifiedAt: null,
        },
      },
    });
    toRecord = new Set();
    if (judgement.verdict === "erro_novo") flagged += 1;
    log[judgement.verdict === "erro_novo" ? "warn" : "info"]({
      eventCode: LOG_EVENTS.RELEASE_VERDICT,
      releaseId: release.releaseId,
      verdict: judgement.verdict,
      findings: judgement.findings.map((finding) => ({ queue: finding.queue, occurrences: finding.occurrences })),
      belowThreshold: judgement.belowThreshold.map((finding) => ({ queue: finding.queue, occurrences: finding.occurrences })),
      knownErrors: judgement.knownErrors,
    }, judgement.verdict === "erro_novo" ? "release com erro novo" : "release sem erro novo");
  }
  return flagged;
}

function storedFinding(finding: ReleaseFinding) {
  return {
    queue: finding.queue,
    text: finding.text,
    occurrences: finding.occurrences,
    jobs: finding.jobs,
    firstAt: finding.firstAt.toISOString(),
  };
}

async function notifyFlaggedReleases(now: Date): Promise<number> {
  const rows = await prisma.auditEvent.findMany({
    where: {
      action: VERDICT_ACTION,
      resource: RESOURCE,
      createdAt: { gte: new Date(now.getTime() - PENDING_MAX_AGE_MS) },
      details: { path: ["verdict"], equals: "erro_novo" },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, details: true },
  });
  let notified = 0;
  for (const row of rows) {
    const verdict = parseVerdict(row.details);
    if (!verdict || verdict.notifiedAt != null) continue;
    try {
      await sendRequiredOperatorNotification(releaseVerdictMessage(verdict, verdict.findings));
    } catch (err) {
      log.warn({ err, releaseId: verdict.releaseId }, "aviso da release com erro novo não saiu; tento na próxima passada");
      continue;
    }
    await prisma.auditEvent.update({
      where: { id: row.id },
      data: { details: { ...(row.details as Prisma.JsonObject), notifiedAt: now.toISOString() } },
    });
    notified += 1;
  }
  return notified;
}

// ───────────── leitura das falhas ─────────────

/**
 * Cada tentativa que falhou tem uma métrica com a release que a rodou, e o
 * job no pg-boss guarda a mensagem da última falha. O job que depois concluiu
 * já não tem o erro e fica de fora, dos dois lados da comparação. A tentativa
 * cujo erro (nome, na métrica) não é o da última falha fica de fora: a
 * mensagem dela se perdeu, e a da última é de outro erro, talvez de outra release.
 */
function queueErrorsBetween(from: Date, to: Date): Prisma.Sql {
  return Prisma.sql`
    FROM operational_metrics m
    JOIN pgboss.job j
      ON j.name = m.name
     AND j.id = CASE
       WHEN m.labels->>'jobId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN (m.labels->>'jobId')::uuid
     END
     AND j.state IN ('retry', 'active', 'failed')
     AND j.output IS NOT NULL
    WHERE m.kind = 'queue'
      AND m.outcome = 'error'
      AND m."occurredAt" >= ${from}
      AND m."occurredAt" < ${to}
      AND (m.labels->>'error' IS NULL OR j.output->>'name' IS NULL OR m.labels->>'error' = j.output->>'name')
  `;
}

const ERROR_OUTPUT = Prisma.sql`CASE WHEN jsonb_typeof(j.output) = 'object' THEN j.output - 'stack' ELSE j.output END`;

/**
 * O output bruto varia por job (ids, meta do Prisma), então um erro ruidoso
 * ocupa muitas linhas distintas. No teto, ficam as saídas mais recentes, e o
 * log avisa: o que caiu fora pode ser apontado como novo.
 */
async function readBaselineFingerprints(from: Date, to: Date): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ queue: string; output: unknown }>>(Prisma.sql`
    SELECT m.name AS queue, ${ERROR_OUTPUT} AS output
    ${queueErrorsBetween(from, to)}
    GROUP BY 1, 2
    ORDER BY max(m."occurredAt") DESC
    LIMIT ${BASELINE_LIMIT}
  `);
  if (rows.length >= BASELINE_LIMIT) {
    log.warn({ eventCode: LOG_EVENTS.RELEASE_VERDICT, limit: BASELINE_LIMIT, from, to },
      "linha de base do veredito da release no teto; erros mais velhos que o corte podem ser apontados como novos");
  }
  return rows.flatMap((row) => errorFingerprint(row.queue, row.output)?.fingerprint ?? []);
}

async function readErrorOccurrences(from: Date, to: Date): Promise<ReleaseErrorOccurrence[]> {
  const rows = await prisma.$queryRaw<Array<{
    queue: string;
    releaseId: string | null;
    jobId: string | null;
    occurredAt: Date;
    output: unknown;
  }>>(Prisma.sql`
    SELECT m.name AS queue, m.labels->>'releaseId' AS "releaseId", m.labels->>'jobId' AS "jobId",
           m."occurredAt" AS "occurredAt", ${ERROR_OUTPUT} AS output
    ${queueErrorsBetween(from, to)}
    ORDER BY m."occurredAt" ASC
    LIMIT ${OCCURRENCE_LIMIT}
  `);
  if (rows.length >= OCCURRENCE_LIMIT) {
    log.warn({ eventCode: LOG_EVENTS.RELEASE_VERDICT, limit: OCCURRENCE_LIMIT, from, to, cutAt: rows.at(-1)?.occurredAt },
      "falhas das observações no teto; as releases mais novas perdem as tentativas depois do corte e podem sair sem erro novo");
  }
  return rows.flatMap((row) => {
    const fingerprint = errorFingerprint(row.queue, row.output);
    if (!fingerprint) return [];
    return [{ ...fingerprint, queue: row.queue, releaseId: row.releaseId, jobId: row.jobId, occurredAt: row.occurredAt }];
  });
}

/**
 * Fila + nome do erro + mensagem normalizada (a impressão digital dos
 * alertas): TypeError e RangeError com a mesma mensagem são erros diferentes.
 * A chave vai gravada na auditoria, que passa o texto pela redação: redigida
 * antes, ela volta igual e continua casando na leitura seguinte.
 */
function errorFingerprint(queue: string, output: unknown): { fingerprint: string; text: string } | null {
  if (!countsAsReleaseError(output)) return null;
  const { message, name } = extractDlqErrorPayload(output);
  const normalized = getMessageFingerprint(scrubSecrets(message.replace(/\s+/g, " ")));
  const text = scrubSecrets(name && name !== "Error" ? `${name}: ${normalized}` : normalized);
  return { fingerprint: `${queue}|${text}`, text };
}

/** Cada impressão digital da memória com a última vez em que um veredito a gravou. */
async function readRecordedFingerprints(since: Date): Promise<Map<string, Date>> {
  const rows = await prisma.$queryRaw<Array<{ fingerprint: string; lastRecordedAt: Date }>>(Prisma.sql`
    SELECT seen.value AS fingerprint, max(e."createdAt") AS "lastRecordedAt"
    FROM audit_events e,
      jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(e.details->'seen') = 'array' THEN e.details->'seen' ELSE '[]'::jsonb END
      ) AS seen(value)
    WHERE e.action = ${VERDICT_ACTION}
      AND e."createdAt" >= ${since}
    GROUP BY seen.value
  `);
  return new Map(rows.map((row) => [row.fingerprint, row.lastRecordedAt]));
}

// ───────────── formato gravado ─────────────

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A ordem é a de quando cada release ficou pronta, não a da gravação. */
function latestFirst(releases: ReleaseRecord[]): ReleaseRecord[] {
  return releases.sort((a, b) => b.readyAt.getTime() - a.readyAt.getTime());
}

function parseReleaseReady(details: unknown): ReleaseRecord | null {
  if (!details || typeof details !== "object") return null;
  const value = details as Record<string, unknown>;
  const releaseId = nonEmptyString(value.releaseId);
  const sha = nonEmptyString(value.sha);
  const bootedAt = isoDate(value.bootedAt);
  const readyAt = isoDate(value.readyAt);
  if (!releaseId || !isPublishedSha(sha) || !bootedAt || !readyAt) return null;
  return {
    releaseId,
    sha,
    bootedAt,
    readyAt,
    previousSha: nonEmptyString(value.previousSha),
  };
}

type StoredVerdict = Pick<ReleaseRecord, "releaseId" | "sha" | "previousSha"> & {
  verdict: ReleaseVerdictKind;
  findings: StoredFinding[];
  belowThreshold: StoredFinding[];
  knownErrors: number | null;
  notifiedAt: string | null;
};

function parseFindings(value: unknown): StoredFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const finding = raw as Record<string, unknown>;
    const queue = nonEmptyString(finding.queue);
    const message = nonEmptyString(finding.text);
    const firstAt = isoDate(finding.firstAt);
    if (!queue || !message || !firstAt) return [];
    return [{
      queue,
      text: message,
      occurrences: typeof finding.occurrences === "number" ? finding.occurrences : 0,
      jobs: typeof finding.jobs === "number" ? finding.jobs : 0,
      firstAt,
    }];
  });
}

function parseVerdict(details: unknown): StoredVerdict | null {
  if (!details || typeof details !== "object") return null;
  const value = details as Record<string, unknown>;
  const releaseId = nonEmptyString(value.releaseId);
  const sha = nonEmptyString(value.sha);
  const verdict = value.verdict === "erro_novo" || value.verdict === "sem_erro_novo" ? value.verdict : null;
  if (!releaseId || !isPublishedSha(sha) || !verdict) return null;
  return {
    releaseId,
    sha,
    previousSha: nonEmptyString(value.previousSha),
    verdict,
    findings: parseFindings(value.findings),
    belowThreshold: parseFindings(value.belowThreshold),
    knownErrors: typeof value.knownErrors === "number" ? value.knownErrors : null,
    notifiedAt: nonEmptyString(value.notifiedAt),
  };
}

async function readVerdicts(releaseIds: readonly string[]): Promise<Map<string, StoredVerdict & { judgedAt: Date }>> {
  if (releaseIds.length === 0) return new Map();
  const rows = await prisma.auditEvent.findMany({
    where: { action: VERDICT_ACTION, resource: RESOURCE, resourceId: { in: [...releaseIds] } },
    select: { details: true, createdAt: true },
  });
  return new Map(rows.flatMap((row) => {
    const verdict = parseVerdict(row.details);
    return verdict ? [[verdict.releaseId, { ...verdict, judgedAt: row.createdAt }] as const] : [];
  }));
}
