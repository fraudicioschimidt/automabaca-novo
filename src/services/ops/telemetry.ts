import type { Job, JobWithMetadata, PgBoss } from "pg-boss";
import { PGBOSS_NOTIFY_BACKSTOP_SECONDS } from "@/src/infra/boss";
import { errorMessageWithCode } from "@/src/infra/error-details";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import {
  betIdFromPayload,
  correlationIdFromPayload,
  createCorrelationId,
  getObservabilityContext,
  runWithObservabilityContext,
} from "@/src/infra/observability-context";

const log = createLogger("telemetry");

/** Código nativo do erro (Prisma `P2028`, SQLSTATE `57014`), quando ele traz um. */
function errorCodeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code).slice(0, 40) : undefined;
}
export function jobLagMs(jobs: Job[]): number | undefined {
  const now = Date.now();
  const lags = jobs.flatMap((job) => {
    const metadata = job as Job & { createdOn?: Date | string; startAfter?: Date | string };
    const created = metadata.createdOn ? new Date(metadata.createdOn).getTime() : NaN;
    const eligible = metadata.startAfter ? new Date(metadata.startAfter).getTime() : NaN;
    // Scheduled waits and retry backoff are not worker backlog. Only time
    // after the job becomes eligible can violate the queue-lag objective.
    const timestamps = [created, eligible].filter(Number.isFinite);
    return timestamps.length ? [Math.max(0, now - Math.max(...timestamps))] : [];
  });
  return lags.length ? Math.max(...lags) : undefined;
}

/** Registra um handler pg-boss com duração, atraso máximo do lote e resultado. */
export async function workObserved(
  boss: PgBoss,
  name: string,
  handler: (jobs: Array<Job & Partial<Pick<JobWithMetadata, "retryCount">>>) => Promise<unknown>,
  options: {
    includeMetadata?: boolean;
    localConcurrency?: number;
    /** Teto de jobs simultâneos do mesmo grupo (`group.id` do job) neste worker. */
    localGroupConcurrency?: number;
    /** O handler devolve o desfecho de cada job (`completed`, `failed`, `deadletter`). */
    perJobResults?: boolean;
    isExpectedRetry?: (error: unknown) => boolean;
  } = {},
): Promise<void> {
  await boss.work(name, {
    notifyPollingIntervalSeconds: PGBOSS_NOTIFY_BACKSTOP_SECONDS,
    includeMetadata: true,
    ...(options.localConcurrency ? { localConcurrency: options.localConcurrency } : {}),
    ...(options.localGroupConcurrency ? { localGroupConcurrency: options.localGroupConcurrency } : {}),
    ...(options.perJobResults ? { perJobResults: true } : {}),
  }, async (jobs: Array<Job & Partial<Pick<JobWithMetadata, "retryCount">>>) => {
    const firstJob = jobs[0];
    // Herdar a correlação do job só é honesto quando o lote tem UM job (o
    // `batchSize` padrão do pg-boss). Lote maior ganha id próprio em vez de
    // atribuir tudo ao primeiro job.
    const correlationId =
      (jobs.length === 1 ? correlationIdFromPayload(firstJob?.data) : null) ??
      (jobs.length === 1 && firstJob?.id
        ? `job_${String(firstJob.id)}`
        : createCorrelationId("job"));
    const betId = jobs.length === 1 ? betIdFromPayload(firstJob?.data) : undefined;
    return runWithObservabilityContext(
      {
        correlationId,
        source: `queue:${name}`,
        jobId: jobs.length === 1 ? firstJob?.id : undefined,
        ...(betId ? { betId } : {}),
      },
      async () => {
        const startedAt = Date.now();
        const queueLagMs = jobLagMs(jobs);
        const retryCount = jobs.length === 1 ? firstJob?.retryCount : undefined;
        const metadata = {
          jobs: jobs.length,
          ...(retryCount === undefined ? {} : { attempt: retryCount + 1, retryCount }),
        };
        const details = { queue: name, ...metadata, queueLagMs };
        try {
          const result = await handler(jobs);
          const durationMs = Date.now() - startedAt;
          await recordOperationalMetric({
            kind: "queue",
            name,
            outcome: "success",
            durationMs,
            queueLagMs,
            labels: metadata,
          });
          log.debug(
            { eventCode: LOG_EVENTS.JOB_BATCH_SUCCEEDED, ...details, durationMs, outcome: "success" },
            "lote da fila concluído",
          );
          return result;
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          const expectedRetry = options.isExpectedRetry?.(err) === true;
          const errorCode = errorCodeOf(err);
          await recordOperationalMetric({
            kind: "queue",
            name,
            outcome: expectedRetry ? "expected_retry" : "error",
            durationMs,
            queueLagMs,
            labels: { ...metadata, error: err instanceof Error ? err.name : "unknown", ...(errorCode ? { errorCode } : {}) },
          });
          if (expectedRetry) {
            log.info(
              {
                eventCode: LOG_EVENTS.JOB_BATCH_RETRY_EXPECTED,
                ...details,
                durationMs,
                outcome: "expected_retry",
                error: err instanceof Error ? err.name : "unknown",
              },
              "lote da fila aguardando retentativa esperada",
            );
            throw err;
          }
          log.error(
            {
              eventCode: LOG_EVENTS.JOB_BATCH_FAILED, err, ...details, durationMs, outcome: "error",
              ...(errorCode ? { errorCode } : {}),
              errorMessage: errorMessageWithCode(err).slice(0, 500),
            },
            "lote da fila falhou",
          );
          throw err;
        }
      },
    );
  });
}

export async function observeAction<T>(
  name: string,
  run: () => Promise<T>,
  classify?: (result: T) => {
    outcome?: "success" | "error" | "expected_retry";
    labels?: Record<string, string | number | boolean | null>;
  },
): Promise<T> {
  const correlationId = getObservabilityContext()?.correlationId ?? createCorrelationId("action");
  return runWithObservabilityContext({ correlationId, source: `action:${name}` }, async () => {
    const startedAt = Date.now();
    try {
      const result = await run();
      const durationMs = Date.now() - startedAt;
      const classified = classify?.(result);
      const outcome = classified?.outcome ?? "success";
      await recordOperationalMetric({
        kind: "action",
        name,
        outcome,
        durationMs,
        ...(classified?.labels ? { labels: classified.labels } : {}),
      });
      log[outcome === "error" ? "error" : "info"](
        {
          eventCode: outcome === "error" ? LOG_EVENTS.ACTION_FAILED
            : outcome === "expected_retry" ? LOG_EVENTS.ACTION_DEFERRED : LOG_EVENTS.ACTION_SUCCEEDED,
          action: name, durationMs, outcome,
          ...(classified?.labels ? { labels: classified.labels } : {}),
        },
        outcome === "error" ? "ação retornou falha"
          : outcome === "expected_retry" ? "ação aguardando continuidade" : "ação concluída",
      );
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      // Recusa de NEGÓCIO não é falha do sistema: é a regra funcionando (por
      // exemplo, excluir conta com saldo). Vira `expected_retry`, que fica fora
      // de `successPct` e não derruba o SLO da ação.
      const recusa = err instanceof RecusaDeNegocioError;
      await recordOperationalMetric({
        kind: "action",
        name,
        outcome: recusa ? "expected_retry" : "error",
        durationMs,
        labels: { error: err instanceof Error ? err.name : "unknown" },
      });
      if (recusa) {
        log.info(
          { eventCode: LOG_EVENTS.ACTION_REFUSED, err, action: name, durationMs, outcome: "expected_retry" },
          "ação recusada pela regra de negócio",
        );
      } else {
        log.error(
          { eventCode: LOG_EVENTS.ACTION_FAILED, err, action: name, durationMs, outcome: "error" },
          "ação falhou",
        );
      }
      throw err;
    }
  });
}
