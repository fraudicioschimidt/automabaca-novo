import "server-only";
import { headers } from "next/headers";
import { observeAction as observeDomainAction } from "@/src/services/ops/telemetry";
import { isSafeCorrelationId, runWithObservabilityContext } from "@/src/infra/observability-context";

/** Borda Next: o proxy substitui a correlação fornecida pelo cliente. */
export async function observeAction<T>(
  name: string,
  run: () => Promise<T>,
  classify?: (result: T) => {
    outcome?: "success" | "error" | "expected_retry";
    labels?: Record<string, string | number | boolean | null>;
  },
): Promise<T> {
  const correlationId = (await headers()).get("x-correlation-id");
  if (!isSafeCorrelationId(correlationId)) return observeDomainAction(name, run, classify);
  return runWithObservabilityContext(
    { correlationId },
    () => observeDomainAction(name, run, classify),
  );
}
