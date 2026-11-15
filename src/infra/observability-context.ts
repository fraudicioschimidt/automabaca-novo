import { AsyncLocalStorage } from "node:async_hooks";
import {
  isSafeCorrelationId,
  registerObservabilityContextGetter,
  type ObservabilityContext,
} from "@/src/infra/observability-store";

export { getObservabilityContext, isSafeCorrelationId } from "@/src/infra/observability-store";

// Next can load independent copies of this module for routes/instrumentation.
// A global getter alone is insufficient: every copy must use the SAME store.
const observabilityGlobal = globalThis as typeof globalThis & {
  __automabacaObservabilityStorage?: AsyncLocalStorage<ObservabilityContext>;
};
const storage = observabilityGlobal.__automabacaObservabilityStorage ??=
  new AsyncLocalStorage<ObservabilityContext>();
registerObservabilityContextGetter(() => storage.getStore());

export function createCorrelationId(prefix = "corr"): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

export function runWithObservabilityContext<T>(
  context: Partial<ObservabilityContext>,
  run: () => T,
): T {
  const parent = storage.getStore();
  // Partial com `betId: undefined` não deve apagar o betId do pai (ninhos em loops).
  const patch = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as Partial<ObservabilityContext>;
  return storage.run(
    {
      ...parent,
      ...patch,
      correlationId: patch.correlationId ?? parent?.correlationId ?? createCorrelationId(),
    },
    run,
  );
}

type CorrelatedPayload = {
  _observability?: { correlationId?: unknown };
};

export function correlationIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as CorrelatedPayload)._observability?.correlationId;
  return isSafeCorrelationId(value) ? value : undefined;
}

const SAFE_BET_ID = /^[A-Za-z0-9:_-]{1,80}$/;

/** Extrai betId tipado do payload de fila/ação (mesma sanidade do correlationId). */
export function betIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as { betId?: unknown }).betId;
  return typeof value === "string" && SAFE_BET_ID.test(value) ? value : undefined;
}

export function withCurrentCorrelation<T extends object>(payload: T): T & CorrelatedPayload {
  const correlationId = storage.getStore()?.correlationId;
  return correlationId
    ? { ...payload, _observability: { correlationId } }
    : payload;
}
