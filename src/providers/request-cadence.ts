import { prisma } from "@/src/infra/prisma";
import { ProviderCadenceDeferredError } from "@/src/domain/provider-error";
import { providerWorkDeadline } from "@/src/infra/provider-work-budget";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";

/** Reserva no Postgres o próximo slot do endpoint e espera fora da transação. */
export async function awaitProviderCadence(params: {
  provider: string;
  route: string;
  cooldownMs: number;
  now?: () => Date;
  deadlineMs?: number;
}): Promise<void> {
  const now = params.now?.() ?? new Date();
  const deadlineMs = providerWorkDeadline(params.provider, params.deadlineMs);
  const slot = await prisma.$transaction(async (tx) => {
    const lockKey = `provider-cadence:${params.provider}:${params.route}`;
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text
    `;
    const rows = await tx.$queryRaw<Array<{ nextAllowedAt: Date }>>`
      SELECT "nextAllowedAt"
      FROM provider_request_gates
      WHERE provider = ${params.provider} AND route = ${params.route}
    `;
    const previous = rows[0]?.nextAllowedAt;
    const slotAt = previous && previous > now ? previous : now;
    if (deadlineMs != null && slotAt.getTime() >= deadlineMs) {
      // Não reserva nem empurra a fila global quando este chamador não pode esperar.
      throw new ProviderCadenceDeferredError(params.provider, slotAt);
    }
    const next = new Date(slotAt.getTime() + params.cooldownMs);
    await tx.$executeRaw`
      INSERT INTO provider_request_gates (provider, route, "nextAllowedAt", "updatedAt")
      VALUES (${params.provider}, ${params.route}, ${next}, ${now})
      ON CONFLICT (provider, route) DO UPDATE SET
        "nextAllowedAt" = EXCLUDED."nextAllowedAt",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
    return slotAt;
  }).catch(async (error: unknown) => {
    if (error instanceof ProviderCadenceDeferredError) {
      await recordOperationalMetric({
        kind: "action", name: "provider.cadence", outcome: "expected_retry",
        durationMs: Math.max(0, error.retryAt.getTime() - now.getTime()),
        labels: { provider: params.provider, route: params.route, deferred: true },
      });
    }
    throw error;
  });
  const waitMs = Math.max(0, slot.getTime() - Date.now());
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  await recordOperationalMetric({
    kind: "action", name: "provider.cadence", outcome: "success", durationMs: waitMs,
    labels: { provider: params.provider, route: params.route, deferred: false },
  });
}
