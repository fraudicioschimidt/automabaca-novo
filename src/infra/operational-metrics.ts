import { createLogger } from "@/src/infra/logger";
import { getObservabilityContext } from "@/src/infra/observability-context";
import { getMetricsPool } from "@/src/infra/prisma";
import { createHash } from "node:crypto";
import { redactSensitiveValue } from "@/src/infra/redaction";
import { LOG_EVENTS } from "@/src/infra/log-events";

const log = createLogger("operational-metrics");
const MAX_DURATION_MS = 2_147_483_647;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

/**
 * Série diária: uma linha por dia, com os números do dia em `labels`, gravada
 * pelo dono da série, e não por `recordOperationalMetric`, que pode descartar.
 * O desfecho próprio a tira do SLO (que lê `success`, `error` e
 * `expected_retry`), e a purga de 30 dias a poupa: é linha de base que se
 * compara semanas depois e não se reconstrói.
 */
export const DAILY_METRIC = { kind: "daily", outcome: "snapshot" } as const;

export type OperationalMetricInput = {
  kind: "queue" | "provider" | "action" | "http";
  name: string;
  outcome: "success" | "error" | "expected_retry";
  durationMs?: number;
  queueLagMs?: number;
  statusCode?: number;
  labels?: Record<string, string | number | boolean | null>;
};

function safeMs(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(MAX_DURATION_MS, Math.round(value)));
}

function metricsEnabled(): boolean {
  return process.env.NODE_ENV !== "test" || process.env.OBSERVABILITY_METRICS_IN_TEST === "true";
}

export function normalizeMetricName(kind: OperationalMetricInput["kind"], name: string): string {
  const normalized = name.trim().replace(UUID_PATTERN, ":id");
  const compact = kind === "provider"
    ? normalized.replace(/\/\d+(?=\/|$)/g, "/:id")
    : normalized;
  if (compact.length <= 160) return compact;
  const digest = createHash("sha256").update(compact).digest("hex").slice(0, 12);
  return `${compact.slice(0, 147)}:${digest}`;
}

const INSERT_METRIC = `
  INSERT INTO operational_metrics (kind, name, outcome, "durationMs", "queueLagMs", "statusCode", labels)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
`;

// Sem fila de espera ilimitada nem Promise.race deixando INSERT órfão. O teto
// casa com as conexões do pool da telemetria (`METRICS_POOL_MAX`).
const MAX_IN_FLIGHT = 2;
const MAX_WAITING = 32;
const CAPACITY_WAIT_MS = 100;
let inFlight = 0;
const waiting = new Set<(allowed: boolean) => void>();
let dropped = 0;
let failures = 0;
let lastDropLog = 0;
let lastFailureLog = 0;
let lastSlowLog = 0;
let lastRecoveryLog = 0;
const SUMMARY_MS = 60_000;

async function acquireCapacity(): Promise<boolean> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return true;
  }
  if (waiting.size >= MAX_WAITING) return false;
  return new Promise((resolve) => {
    const done = (allowed: boolean) => {
      waiting.delete(done);
      clearTimeout(timer);
      resolve(allowed);
    };
    const timer = setTimeout(() => done(false), CAPACITY_WAIT_MS);
    waiting.add(done);
  });
}

function releaseCapacity(): void {
  const next = waiting.values().next().value;
  if (next) next(true);
  else inFlight -= 1;
}

/** Telemetria nunca pode transformar sucesso do domínio em falha. */
export async function recordOperationalMetric(input: OperationalMetricInput): Promise<void> {
  if (!metricsEnabled()) return;
  const startedAt = Date.now();
  if (!await acquireCapacity()) {
    dropped += 1;
    if (!lastDropLog || Date.now() - lastDropLog >= SUMMARY_MS) {
      log.warn({ eventCode: LOG_EVENTS.OBSERVABILITY_METRICS_DROPPED, dropped, inFlight,
        reasonCode: "capacity_budget", waiting: waiting.size }, "métricas descartadas para preservar capacidade do banco");
      lastDropLog = Date.now();
    }
    return;
  }
  try {
    const safeInput = redactSensitiveValue(input) as OperationalMetricInput;
    const context = getObservabilityContext();
    const safeContext = redactSensitiveValue(context);
    // Um comando só: o servidor cancela passados 250 ms (ou 100 ms esperando
    // lock), pelas opções da conexão do pool da telemetria.
    await getMetricsPool().query(INSERT_METRIC, [
      safeInput.kind,
      normalizeMetricName(safeInput.kind, safeInput.name),
      safeInput.outcome,
      safeMs(safeInput.durationMs) ?? null,
      safeMs(safeInput.queueLagMs) ?? null,
      safeInput.statusCode ?? null,
      JSON.stringify({
        ...safeInput.labels,
        ...(safeContext?.correlationId ? { correlationId: safeContext.correlationId } : {}),
        ...(safeContext?.jobId ? { jobId: safeContext.jobId } : {}),
        ...(safeContext?.betId ? { betId: safeContext.betId } : {}),
        ...(safeContext?.llmCallId ? { llmCallId: safeContext.llmCallId } : {}),
        ...(safeContext?.llmCallStartedAtMs !== undefined ? { llmCallStartedAtMs: safeContext.llmCallStartedAtMs } : {}),
        ...(typeof safeContext?.llmEvaluationRandomized === "boolean" ? { llmEvaluationRandomized: safeContext.llmEvaluationRandomized } : {}),
        process: process.env.AUTOMABACA_PROCESS ?? "unknown",
        releaseId: process.env.AUTOMABACA_RELEASE_ID ?? "development",
        releaseSha: process.env.AUTOMABACA_RELEASE_SHA ?? "development",
      }),
    ]);
    const durationMs = Date.now() - startedAt;
    if ((failures || dropped) && (!lastRecoveryLog || Date.now() - lastRecoveryLog >= SUMMARY_MS)) {
      log.info({ eventCode: LOG_EVENTS.OBSERVABILITY_METRICS_RECOVERED, failures, dropped, durationMs },
        "métrica persistida após perdas; amostras perdidas não são reprocessadas");
      lastRecoveryLog = Date.now();
      failures = 0;
      dropped = 0;
    }
    if (durationMs >= 200 && (!lastSlowLog || Date.now() - lastSlowLog >= SUMMARY_MS)) {
      lastSlowLog = Date.now();
      log.warn({ eventCode: LOG_EVENTS.OBSERVABILITY_METRICS_SLOW, durationMs }, "gravação de métrica lenta");
    }
  } catch (err) {
    failures += 1;
    if (!lastFailureLog || Date.now() - lastFailureLog >= SUMMARY_MS) {
      lastFailureLog = Date.now();
      log.error(
        { err, kind: input.kind, name: input.name, failures, durationMs: Date.now() - startedAt,
          eventCode: LOG_EVENTS.OBSERVABILITY_METRICS_WRITE_FAILED },
        "telemetria operacional não está sendo gravada; SLO e painel podem estar cegos",
      );
    }
  } finally {
    releaseCapacity();
  }
}
