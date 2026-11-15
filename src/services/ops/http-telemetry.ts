import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import {
  createCorrelationId,
  isSafeCorrelationId,
  runWithObservabilityContext,
} from "@/src/infra/observability-context";
import type { OperationalMetricInput } from "@/src/infra/operational-metrics";

const log = createLogger("http");

/**
 * A métrica HTTP é gravada DEPOIS de a resposta sair: começa aqui, no contexto
 * de observabilidade da requisição, e ninguém a espera; esperar o INSERT
 * atrasaria toda resposta quando o banco está lento. O import é dinâmico para
 * a rota não carregar o Prisma só por importar a telemetria;
 * `recordOperationalMetric` não lança, e o `catch` é a rede do import.
 */
function recordHttpMetricAfterResponse(input: OperationalMetricInput): void {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.OBSERVABILITY_METRICS_IN_TEST !== "true"
  ) {
    return;
  }
  if (!withinHttpMetricBudget(input)) return;
  loadOperationalMetrics()
    .then(({ recordOperationalMetric }) => recordOperationalMetric(input))
    .catch((err: unknown) => log.error({ err, route: input.name }, "falha ao gravar a métrica HTTP"));
}

/**
 * Cota por minuto de cada rota e classe de status. Login, webhook e telemetria
 * do navegador são públicos e recusam sem tocar o banco: sem a cota, um flood
 * anônimo viraria uma linha de métrica por requisição, mais do que a limpeza
 * diária apaga. A classe separada guarda os 2xx e 5xx durante um flood de 4xx,
 * e o uso do painel fica muito abaixo dela.
 */
const HTTP_METRIC_BUDGET_PER_MINUTE = 120;
const httpMetricBudget = new Map<string, number>();
let httpMetricBudgetMinute = -1;
let droppedOverBudget = 0;
let lastBudgetLog = 0;

function withinHttpMetricBudget(input: OperationalMetricInput): boolean {
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  if (minute !== httpMetricBudgetMinute) {
    httpMetricBudget.clear();
    httpMetricBudgetMinute = minute;
  }
  const key = `${input.name}|${input.labels?.statusClass ?? "thrown"}`;
  const used = (httpMetricBudget.get(key) ?? 0) + 1;
  httpMetricBudget.set(key, used);
  if (used <= HTTP_METRIC_BUDGET_PER_MINUTE) return true;
  droppedOverBudget += 1;
  if (now - lastBudgetLog >= 60_000) {
    log.warn({ eventCode: LOG_EVENTS.OBSERVABILITY_METRICS_DROPPED, reasonCode: "http_route_budget",
      route: input.name, dropped: droppedOverBudget }, "métricas HTTP acima da cota do minuto descartadas");
    lastBudgetLog = now;
    droppedOverBudget = 0;
  }
  return false;
}

type OperationalMetricsModule = typeof import("@/src/infra/operational-metrics");
let operationalMetricsModule: Promise<OperationalMetricsModule> | null = null;

/** Um import só, compartilhado: requisições simultâneas não disparam cargas concorrentes do módulo. */
function loadOperationalMetrics(): Promise<OperationalMetricsModule> {
  operationalMetricsModule ??= import("@/src/infra/operational-metrics").catch((err: unknown) => {
    operationalMetricsModule = null;
    throw err;
  });
  return operationalMetricsModule;
}

function emitHttpLog(
  level: "debug" | "error",
  details: Record<string, unknown>,
  message: string,
): void {
  if (process.env.NODE_ENV === "test") return;
  log[level](details, message);
}

function requestCorrelationId(request: Request): string {
  // The proxy already replaces the caller's ID. Preserve its ID across the
  // response, route logs, Next errors and queued work.
  const correlationId = request.headers.get("x-correlation-id");
  if (isSafeCorrelationId(correlationId)) return correlationId;
  const incoming = request.headers.get("x-request-id");
  return isSafeCorrelationId(incoming)
    ? `http_ext_${incoming}`.slice(0, 100)
    : createCorrelationId("http");
}

type HttpObservationOptions = {
  metric?: boolean | "errors";
  /** Status abaixo de 500 que, nesta rota, são falha técnica (ex.: 401 do webhook = segredo divergente). */
  failureStatuses?: readonly number[];
};

export async function observeHttpRequest<T extends Response>(
  request: Request,
  route: string,
  run: () => Promise<T>,
  options: HttpObservationOptions = {},
): Promise<T> {
  const correlationId = requestCorrelationId(request);
  return runWithObservabilityContext(
    { correlationId, source: `http:${route}`, route },
    async () => {
      const startedAt = Date.now();
      try {
        const response = await run();
        const durationMs = Date.now() - startedAt;
        const technicalFailure = response.status >= 500 || (options.failureStatuses?.includes(response.status) ?? false);
        if (options.metric !== false && (options.metric !== "errors" || technicalFailure)) recordHttpMetricAfterResponse({
          kind: "http",
          name: route,
          outcome: technicalFailure ? "error" : "success",
          durationMs,
          statusCode: response.status,
          labels: { method: request.method, statusClass: `${Math.floor(response.status / 100)}xx`,
            ...(options.metric === "errors" ? { sampling: "errors_only" } : {}) },
        });
        // `Response.redirect()` (e algumas respostas vindas de runtimes Web)
        // expõe um guard imutável. Telemetria nunca pode transformar um 3xx
        // válido em 500 só porque o header de correlação não pôde ser anexado.
        try {
          response.headers.set("x-correlation-id", correlationId);
        } catch {
          // Preserva a resposta original e seus headers imutáveis.
        }
        const details = {
          eventCode: technicalFailure
            ? LOG_EVENTS.HTTP_REQUEST_FAILED
            : LOG_EVENTS.HTTP_REQUEST_COMPLETED,
          route,
          method: request.method,
          statusCode: response.status,
          durationMs,
        };
        emitHttpLog(
          technicalFailure ? "error" : "debug",
          details,
          technicalFailure ? "requisição HTTP falhou" : "requisição HTTP concluída",
        );
        return response;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        if (options.metric !== false) recordHttpMetricAfterResponse({
          kind: "http",
          name: route,
          outcome: "error",
          durationMs,
          labels: { method: request.method, error: err instanceof Error ? err.name : "unknown",
            ...(options.metric === "errors" ? { sampling: "errors_only" } : {}) },
        });
        emitHttpLog(
          "error",
          { eventCode: LOG_EVENTS.HTTP_REQUEST_FAILED, err, route, method: request.method, durationMs },
          "requisição HTTP lançou erro",
        );
        throw err;
      }
    },
  );
}

export function observedRoute<
  TRequest extends Request,
  TArgs extends unknown[],
  TResult extends Response,
>(
  route: string,
  handler: (request: TRequest, ...args: TArgs) => Promise<TResult>,
  options: HttpObservationOptions = {},
): (request: TRequest, ...args: TArgs) => Promise<TResult> {
  return (request, ...args) => observeHttpRequest(request, route, () => handler(request, ...args), options);
}
