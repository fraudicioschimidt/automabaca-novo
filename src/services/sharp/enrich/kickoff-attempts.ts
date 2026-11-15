import type { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";

/**
 * Estado persistido do ciclo de kickoff provisório: cooldown por fonte paga
 * (Bridge e busca web) e a trilha de cada tentativa em `audit_events`. Miss
 * fica auditado mas não encerra a busca, porque o catálogo pode ganhar o
 * evento mais tarde; só a correção aplicada encerra o ciclo.
 */

const WEB_KICKOFF_COOLDOWN_MS = 6 * 3_600_000;
const BRIDGE_COOLDOWN_FAR_MS = 2 * 3_600_000;
const BRIDGE_COOLDOWN_NEAR_MS = 30 * 60_000;
const PERTO_DO_KICKOFF_MS = 8 * 3_600_000;

const BRIDGE_KICKOFF_COOLDOWN_KEY = (betId: string) => `kickoff-bridge:${betId}`;
const WEB_KICKOFF_COOLDOWN_KEY = (betId: string) => `kickoff-web:${betId}`;

export async function bridgeKickoffCooldownActive(betId: string, now: Date): Promise<boolean> {
  const row = await prisma.iaJudgeCooldown.findUnique({
    where: { key: BRIDGE_KICKOFF_COOLDOWN_KEY(betId) },
  });
  return Boolean(row && row.expiresAt > now);
}

export async function webCooldownActive(betId: string, now: Date): Promise<boolean> {
  const row = await prisma.iaJudgeCooldown.findUnique({
    where: { key: WEB_KICKOFF_COOLDOWN_KEY(betId) },
  });
  return Boolean(row && row.expiresAt > now);
}

export async function setWebCooldown(betId: string, reason: string, now: Date): Promise<void> {
  const expiresAt = new Date(now.getTime() + WEB_KICKOFF_COOLDOWN_MS);
  const key = WEB_KICKOFF_COOLDOWN_KEY(betId);
  await prisma.iaJudgeCooldown.upsert({
    where: { key },
    create: { key, reason: reason.slice(0, 500), expiresAt },
    update: { reason: reason.slice(0, 500), expiresAt },
  });
}

export async function setBridgeCooldown(
  betId: string,
  kickoff: Date,
  now: Date,
  reason: string,
): Promise<void> {
  const near = kickoff.getTime() - now.getTime() <= PERTO_DO_KICKOFF_MS;
  const ttl = near ? BRIDGE_COOLDOWN_NEAR_MS : BRIDGE_COOLDOWN_FAR_MS;
  const expiresAt = new Date(now.getTime() + ttl);
  const key = BRIDGE_KICKOFF_COOLDOWN_KEY(betId);
  await prisma.iaJudgeCooldown.upsert({
    where: { key },
    create: { key, reason: reason.slice(0, 500), expiresAt },
    update: { reason: reason.slice(0, 500), expiresAt },
  });
}

export async function clearBridgeCooldown(betId: string): Promise<void> {
  await prisma.iaJudgeCooldown.deleteMany({
    where: { key: BRIDGE_KICKOFF_COOLDOWN_KEY(betId) },
  });
}

export async function clearKickoffCooldowns(
  betId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await client.iaJudgeCooldown.deleteMany({
    where: { key: { in: [BRIDGE_KICKOFF_COOLDOWN_KEY(betId), WEB_KICKOFF_COOLDOWN_KEY(betId)] } },
  });
}

export const KICKOFF_RESOLVE_ATTEMPT_ACTION = "kickoff.resolve_attempt";
export const WEB_KICKOFF_MISS_REASON = "web_kickoff_miss";

export type KickoffResolveSource =
  | "bridge"
  | "flashscore"
  | "pinnacle17"
  | "web";

type AuditClient = {
  auditEvent: {
    findFirst: typeof prisma.auditEvent.findFirst;
    create: typeof prisma.auditEvent.create;
    deleteMany: typeof prisma.auditEvent.deleteMany;
  };
};

export async function recordKickoffResolveAttempt(params: {
  betId: string;
  source: KickoffResolveSource;
  anterior: Date;
  resolvido: Date | null;
  aplicado: boolean;
  esporteAnterior?: string;
  esporteResolvido?: string;
  missReason?: string;
  /** URL verificável (grounding / sourceUrl) quando source=web. */
  sourceUrl?: string;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      actor: "system",
      action: KICKOFF_RESOLVE_ATTEMPT_ACTION,
      resource: "bet",
      resourceId: params.betId,
      details: {
        source: params.source,
        anterior: params.anterior.toISOString(),
        resolvido: params.resolvido ? params.resolvido.toISOString() : null,
        aplicado: params.aplicado,
        ...(params.esporteAnterior
          ? { esporteAnterior: params.esporteAnterior }
          : {}),
        ...(params.esporteResolvido
          ? { esporteResolvido: params.esporteResolvido }
          : {}),
        ...(params.missReason ? { missReason: params.missReason } : {}),
        ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
      } satisfies Prisma.InputJsonValue,
    },
  });
}

/** Edit substancial: libera novo ciclo de kickoff. */
export async function clearKickoffResolveAttempt(
  betId: string,
  client: AuditClient = prisma,
): Promise<void> {
  await client.auditEvent.deleteMany({
    where: {
      resource: "bet",
      resourceId: betId,
      action: KICKOFF_RESOLVE_ATTEMPT_ACTION,
    },
  });
}
