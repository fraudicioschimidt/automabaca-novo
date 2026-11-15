/**
 * A parte do contexto de observabilidade sem `node:async_hooks`: o logger e a
 * instrumentação do Next leem daqui. O AsyncLocalStorage que grava o contexto
 * mora em `observability-context.ts`, que registra o getter no boot.
 */
export type ObservabilityContext = {
  correlationId: string;
  source?: string;
  actor?: string;
  jobId?: string;
  /** Aposta em foco no job/ação; entra no mixin do logger e nas labels de métrica. */
  betId?: string;
  llmCallId?: string;
  /** Origem e regime da cascata para comparar itens inteiros nas janelas. */
  llmCallStartedAtMs?: number;
  llmEvaluationRandomized?: boolean;
  route?: string;
};

type ContextGetter = () => ObservabilityContext | undefined;
type ObservabilityGlobal = typeof globalThis & {
  __automabacaObservabilityContextGetter?: ContextGetter;
};

const SAFE_CORRELATION = /^[A-Za-z0-9:_-]{1,100}$/;

function observabilityGlobal(): ObservabilityGlobal {
  return globalThis as ObservabilityGlobal;
}

export function registerObservabilityContextGetter(getter: ContextGetter): void {
  observabilityGlobal().__automabacaObservabilityContextGetter = getter;
}

export function getObservabilityContext(): ObservabilityContext | undefined {
  return observabilityGlobal().__automabacaObservabilityContextGetter?.();
}

export function isSafeCorrelationId(value: unknown): value is string {
  return typeof value === "string" && SAFE_CORRELATION.test(value);
}
