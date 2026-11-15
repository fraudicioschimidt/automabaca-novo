
/** Boot do Node: aborta se DATABASE_URL de produção apontar para role admin. */
export async function register(): Promise<void> {
  // Edge não tem pg; o check só roda no runtime Node do Next.
  if (process.env.NEXT_RUNTIME === "edge") return;
  try {
    const { pgPool } = await import("@/src/infra/prisma");
    const { assertRuntimeConnectionIsUnprivileged } = await import(
      "@/src/infra/runtime-db-role"
    );
    await assertRuntimeConnectionIsUnprivileged(pgPool);
  } catch (err) {
    // Fail-fast explícito: não deixe o processo web subir com privilégios errados.
    console.error("[SEC-02] falha na asserção da role de banco no boot:", err);
    process.exit(1);
  }
}

import type { Instrumentation } from "next";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { isBusinessRefusalError, isStaleServerActionError } from "@/src/infra/next-request-errors";
import { isSafeCorrelationId } from "@/src/infra/observability-store";

const log = createLogger("next-instrumentation");

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String(error.digest)
      : undefined;
  const rawCorrelation = request.headers["x-correlation-id"];
  const correlationId = Array.isArray(rawCorrelation) ? rawCorrelation[0] : rawCorrelation;
  const details = {
    err: error,
    digest,
    ...(isSafeCorrelationId(correlationId) ? { correlationId } : {}),
    method: request.method,
    route: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind,
  };
  if (isStaleServerActionError(error)) {
    log.warn(
      { ...details, eventCode: LOG_EVENTS.NEXT_CLIENT_SKEW },
      "Server Action desconhecida — cliente antigo ou requisição inválida",
    );
    return;
  }
  if (isBusinessRefusalError(error)) {
    log.info(
      {
        ...details,
        eventCode: LOG_EVENTS.ACTION_REFUSED,
        actionableHint: "Recusa de negócio ou conflito de estado esperado. Não representa falha no servidor.",
      },
      "ação recusada por regra de negócio ou conflito de estado",
    );
    return;
  }
  log.error(
    { ...details, eventCode: LOG_EVENTS.NEXT_REQUEST_ERROR },
    "erro não tratado capturado pelo Next",
  );
};