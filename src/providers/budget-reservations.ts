import type { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { findProviderCap, periodKeyFor } from "@/src/providers/budget-config";

type ReservationKey = {
  provider: string;
  purpose: string;
  resourceKey: string;
  units?: number;
  now?: Date;
};

type ReservationRow = { units: number };

function capFor(provider: string) {
  const cap = findProviderCap(provider);
  if (!cap) throw new Error(`Provider sem cap configurado: ${provider}`);
  return cap;
}

async function lockProviderPeriod(
  tx: Prisma.TransactionClient,
  provider: string,
  periodKey: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget:${provider}:${periodKey}`}, 0))::text
  `;
}

/**
 * O período civil local é só a chave de armazenamento. Se o provider declarou
 * uma janela real e ela virou dentro da mesma chave, gasto antigo não pode
 * bloquear reservas. Reservas já feitas continuam valendo.
 */
async function resetExpiredProviderWindow(
  tx: Prisma.TransactionClient,
  provider: string,
  periodKey: string,
  now: Date,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE provider_budgets
    SET spent = 0, "windowResetAt" = NULL, "updatedAt" = ${now}
    WHERE provider = ${provider}
      AND "periodKey" = ${periodKey}
      AND "windowResetAt" IS NOT NULL
      AND "windowResetAt" <= ${now}
  `;
}

export async function reserveProviderBudget(
  key: ReservationKey,
): Promise<{ ok: boolean; created: boolean }> {
  const cap = capFor(key.provider);
  const now = key.now ?? new Date();
  const periodKey = periodKeyFor(cap.period, now);
  const units = key.units ?? 1;
  if (!Number.isInteger(units) || units <= 0) throw new Error("Reserva de provider inválida");

  return prisma.$transaction(async (tx) => {
    await lockProviderPeriod(tx, key.provider, periodKey);
    const existing = await tx.$queryRaw<ReservationRow[]>`
      SELECT units
      FROM provider_budget_reservations
      WHERE provider = ${key.provider}
        AND "periodKey" = ${periodKey}
        AND purpose = ${key.purpose}
        AND "resourceKey" = ${key.resourceKey}
    `;
    if (existing[0]) return { ok: true, created: false };

    await tx.$executeRaw`
      INSERT INTO provider_budgets (provider, "periodKey", spent, reserved, "updatedAt")
      VALUES (${key.provider}, ${periodKey}, 0, 0, ${now})
      ON CONFLICT (provider, "periodKey") DO NOTHING
    `;
    await resetExpiredProviderWindow(tx, key.provider, periodKey, now);
    const updated = await tx.$executeRaw`
      UPDATE provider_budgets
      SET reserved = reserved + ${units}, "updatedAt" = ${now}
      WHERE provider = ${key.provider}
        AND "periodKey" = ${periodKey}
        AND spent + reserved + ${units} <= ${cap.cap}
    `;
    if (updated === 0) return { ok: false, created: false };

    await tx.$executeRaw`
      INSERT INTO provider_budget_reservations
        (provider, "periodKey", purpose, "resourceKey", units, "createdAt", "updatedAt")
      VALUES (${key.provider}, ${periodKey}, ${key.purpose}, ${key.resourceKey}, ${units}, ${now}, ${now})
    `;
    return { ok: true, created: true };
  });
}

export async function releaseProviderBudgetReservation(key: ReservationKey): Promise<boolean> {
  const cap = capFor(key.provider);
  const now = key.now ?? new Date();
  const periodKey = periodKeyFor(cap.period, now);
  return releaseReservationForPeriod({ ...key, now }, periodKey);
}

/** Apaga a reserva e devolve suas unidades; undefined se ela não existia. */
async function deleteReservation(
  tx: Prisma.TransactionClient,
  key: ReservationKey,
  periodKey: string,
): Promise<number | undefined> {
  const rows = await tx.$queryRaw<ReservationRow[]>`
    DELETE FROM provider_budget_reservations
    WHERE provider = ${key.provider}
      AND "periodKey" = ${periodKey}
      AND purpose = ${key.purpose}
      AND "resourceKey" = ${key.resourceKey}
    RETURNING units
  `;
  return rows[0]?.units || undefined;
}

async function releaseReservationForPeriod(key: ReservationKey, periodKey: string): Promise<boolean> {
  const now = key.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockProviderPeriod(tx, key.provider, periodKey);
    const units = await deleteReservation(tx, key, periodKey);
    if (!units) return false;
    await tx.$executeRaw`
      UPDATE provider_budgets
      SET reserved = GREATEST(0, reserved - ${units}), "updatedAt" = ${now}
      WHERE provider = ${key.provider} AND "periodKey" = ${periodKey}
    `;
    return true;
  });
}

/** Converte a reserva em spent imediatamente antes da request física. */
export async function consumeProviderBudgetReservation(
  key: ReservationKey,
): Promise<boolean> {
  const cap = capFor(key.provider);
  const now = key.now ?? new Date();
  const periodKey = periodKeyFor(cap.period, now);
  return prisma.$transaction(async (tx) => {
    await lockProviderPeriod(tx, key.provider, periodKey);
    await resetExpiredProviderWindow(tx, key.provider, periodKey, now);
    const units = await deleteReservation(tx, key, periodKey);
    if (!units) return false;
    await tx.$executeRaw`
      UPDATE provider_budgets
      SET reserved = GREATEST(0, reserved - ${units}),
          spent = spent + ${units},
          "updatedAt" = ${now}
      WHERE provider = ${key.provider} AND "periodKey" = ${periodKey}
    `;
    return true;
  });
}

const DEFAULT_ORPHAN_RESERVATION_TTL_MS = 72 * 60 * 60_000;

/**
 * Limpeza de reservas órfãs com TTL > 72h cujo evento já encerrou (sem apostas pendentes),
 * liberando cotas presas no Postgres.
 */
export async function cleanupOrphanedProviderBudgetReservations(params?: {
  olderThanMs?: number;
  now?: Date;
}): Promise<{ cleaned: number; releasedUnits: number }> {
  const now = params?.now ?? new Date();
  const olderThanMs = params?.olderThanMs ?? DEFAULT_ORPHAN_RESERVATION_TTL_MS;
  const cutoff = new Date(now.getTime() - olderThanMs);

  const candidates = await prisma.$queryRaw<
    Array<{
      provider: string;
      periodKey: string;
      purpose: string;
      resourceKey: string;
      units: number;
    }>
  >`
    SELECT r.provider, r."periodKey", r.purpose, r."resourceKey", r.units
    FROM provider_budget_reservations r
    WHERE r."createdAt" <= ${cutoff}
      AND NOT EXISTS (
        SELECT 1
        FROM bets b
        LEFT JOIN bet_sharp s ON s."betId" = b.id
        LEFT JOIN bet_closing c ON c."betId" = b.id
        WHERE b."deletedAt" IS NULL
          AND b.status = 'PENDING'
          AND c."fetchedAt" IS NULL
          AND (
            s."providerMatchId" = r."resourceKey"
            OR s."priceReference" = r."resourceKey"
            OR (s."providerMatchId" IS NOT NULL AND r."resourceKey" LIKE '%' || s."providerMatchId" || '%')
          )
      )
  `;

  if (!candidates.length) return { cleaned: 0, releasedUnits: 0 };

  let cleaned = 0;
  let releasedUnits = 0;

  for (const orphan of candidates) {
    const released = await releaseReservationForPeriod({
      provider: orphan.provider,
      purpose: orphan.purpose,
      resourceKey: orphan.resourceKey,
      now,
    }, orphan.periodKey);
    if (released) {
      cleaned++;
      releasedUnits += orphan.units;
    }
  }

  return { cleaned, releasedUnits };
}
