import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { Prisma } from "@/src/generated/prisma/client";
import type { NoOddsReason } from "@/src/domain/no-odds-reason";
import { recordTrainingFailure } from "./training-cases";
import { lockActiveEnrichBet, SharpAlreadyExistsError, createSharpWithoutAbortingTransaction } from "./write-guard";

const log = createLogger("sharp-enrich");

/** `bet_sharp` guarda só identidade: sem preço de entrada nem abertura (`bet_opening`). */
export type SharpUpsertData = {
  identityStatus: "PENDING" | "MATCHED" | "UNMATCHED" | "UNSUPPORTED" | "MANUAL";
  confidence: number;
  provider?: string;
  providerMatchId?: string;
  priceReference?: string | null;
  noOddsReason?: NoOddsReason | null;
};

export type SharpPersistenceClient = Pick<Prisma.TransactionClient, "betSharp" | "$executeRaw">;

export type UpsertSharpFn = (
  betId: string,
  data: SharpUpsertData,
  db?: SharpPersistenceClient,
) => Promise<void>;

type SharpResolutionWhere = {
  identityStatus?: SharpUpsertData["identityStatus"] | {
    in?: SharpUpsertData["identityStatus"][];
    not?: SharpUpsertData["identityStatus"];
    notIn?: SharpUpsertData["identityStatus"][];
  };
};

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof SharpAlreadyExistsError ||
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
    (typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002")
  );
}

async function updateResolved(
  betId: string,
  where: SharpResolutionWhere,
  data: SharpUpsertData,
  db: SharpPersistenceClient,
): Promise<number> {
  const updatePreservingListing = async (
    resolutionWhere: SharpResolutionWhere & { identityResolvedAt?: null },
    updateData: SharpUpsertData & { identityResolvedAt?: Date },
  ): Promise<number> => (await db.betSharp.updateMany({
    where: { betId, ...resolutionWhere },
    data: updateData,
  })).count;

  const firstResolution = await updatePreservingListing(
    { ...where, identityResolvedAt: null },
    { ...data, identityResolvedAt: new Date() },
  );
  if (firstResolution > 0) return firstResolution;
  return updatePreservingListing(where, data);
}

/**
 * Persistência sharp com guards atômicos (sem read-then-write):
 *
 * | Escrita     | Não sobrescreve                          |
 * |-------------|------------------------------------------|
 * | PENDING     | MATCHED, MANUAL, UNMATCHED, UNSUPPORTED  |
 * | UNMATCHED   | MATCHED, MANUAL, UNSUPPORTED             |
 * | MATCHED/…   | UNSUPPORTED                              |
 * | UNSUPPORTED | (sempre)                                 |
 *
 * Reopen legítimo (kickoff ≥1h) usa updateMany em kickoff-revive.ts.
 */
export async function upsertSharp(
  betId: string,
  data: SharpUpsertData,
  db: SharpPersistenceClient = prisma,
): Promise<void> {
  if (db === prisma) {
    return prisma.$transaction(async (tx) => {
      await lockActiveEnrichBet(tx, betId);
      await upsertSharp(betId, data, tx);
    });
  }
  const status = data.identityStatus;

  if (status === "PENDING") {
    const pendingData = { ...data, identityResolvedAt: null };
    const updated = await db.betSharp.updateMany({
      where: { betId, identityStatus: "PENDING" },
      data: pendingData,
    });
    if (updated.count > 0) return;
    try {
      await createSharpWithoutAbortingTransaction(db, {
        data: { betId, ...pendingData },
      });
      return;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const secondAttempt = await db.betSharp.updateMany({
          where: { betId, identityStatus: "PENDING" },
          data: pendingData,
        });
        if (secondAttempt.count === 0) {
          log.info(
            { betId },
            "sharp resolvida — regressão para PENDING bloqueada",
          );
        }
        return;
      }
      throw error;
    }
  }

  if (status === "UNMATCHED") {
    const updated = await updateResolved(betId, { identityStatus: { in: ["PENDING", "UNMATCHED"] } }, data, db);
    if (updated > 0) return;
    try {
      await createSharpWithoutAbortingTransaction(db, { data: { betId, ...data, identityResolvedAt: new Date() } });
      return;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const secondAttempt = await updateResolved(betId, { identityStatus: { in: ["PENDING", "UNMATCHED"] } }, data, db);
        if (secondAttempt === 0) {
          log.info(
            { betId },
            "sharp já resolvida — UNMATCHED ignorado",
          );
        }
        return;
      }
      throw error;
    }
  }

  if (status === "UNSUPPORTED") {
    const firstResolution = await db.betSharp.updateMany({
      where: { betId, identityResolvedAt: null },
      data: { ...data, identityResolvedAt: new Date() },
    });
    if (firstResolution.count > 0) return;
    try {
      await createSharpWithoutAbortingTransaction(db, {
        data: { betId, ...data, identityResolvedAt: new Date() },
      });
      return;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        await db.betSharp.updateMany({
          where: { betId, identityStatus: { in: ["PENDING", "UNSUPPORTED"] } },
          data,
        });
        return;
      }
      throw error;
    }
  }

  if (status === "MATCHED") {
    // MATCHED não pisa UNSUPPORTED nem MANUAL
    const updated = await updateResolved(betId, { identityStatus: { notIn: ["UNSUPPORTED", "MANUAL"] } }, data, db);
    if (updated > 0) return;
    // Se a linha já é MANUAL, atualiza os dados de odds preservando identityStatus MANUAL
    const manualData: SharpUpsertData = { ...data, identityStatus: "MANUAL" };
    const manualUpdated = await updateResolved(betId, { identityStatus: "MANUAL" }, manualData, db);
    if (manualUpdated > 0) return;
    try {
      await createSharpWithoutAbortingTransaction(db, {
        data: { betId, ...data, identityResolvedAt: new Date() },
      });
      return;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const secondAttempt = await updateResolved(betId, { identityStatus: { notIn: ["UNSUPPORTED", "MANUAL"] } }, data, db);
        if (secondAttempt === 0) {
          await updateResolved(betId, { identityStatus: "MANUAL" }, manualData, db);
        }
        return;
      }
      throw error;
    }
  }

  // MANUAL: não pisa UNSUPPORTED
  const updated = await updateResolved(betId, { identityStatus: { not: "UNSUPPORTED" } }, data, db);
  if (updated > 0) return;
  try {
    await createSharpWithoutAbortingTransaction(db, {
      data: { betId, ...data, identityResolvedAt: new Date() },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const secondAttempt = await updateResolved(betId, { identityStatus: { not: "UNSUPPORTED" } }, data, db);
      if (secondAttempt === 0) {
        log.info({ betId }, "sharp UNSUPPORTED terminal — upsert ignorado");
      }
      return;
    }
    throw error;
  }
}

/**
 * DLQ do sharp.enrich: mantém PENDING enquanto ainda há janela útil para o
 * revival; só terminaliza UNMATCHED depois do evento. Sempre materializa um
 * caso OPEN se ainda não houver.
 */
export async function markEnrichDeadLettered(
  betId: string,
  now = new Date(),
): Promise<void> {
  const bet = await prisma.bet.findFirst({
    where: { id: betId, deletedAt: null },
    select: {
      id: true,
      status: true,
      data: true,
      registradoEm: true, sourcePostedAt: true,
      evento: true,
      esporte: true,
      pais: true,
      competicao: true,
      sharp: { select: { identityStatus: true } },
    },
  });
  if (!bet) return;
  const before = bet.sharp;
  if (before?.identityStatus === "MATCHED" || before?.identityStatus === "MANUAL") {
    return;
  }
  if (before?.identityStatus === "UNSUPPORTED") return;

  const retryable =
    bet.status === "PENDING" &&
    (bet.data.getTime() >= now.getTime() - 30 * 60_000 ||
      bet.registradoEm.getTime() >= now.getTime() - 60 * 60_000);
  const targetStatus = retryable ? "PENDING" : "UNMATCHED";

  if (before) {
    await prisma.betSharp.updateMany({
      where: { betId, identityStatus: { in: ["PENDING", "UNMATCHED"] } },
      data: {
        identityStatus: targetStatus,
        confidence: 0,
        identityResolvedAt: retryable ? null : (before.identityStatus === "PENDING" ? now : undefined),
      },
    });
  } else {
    try {
      await prisma.betSharp.create({
        data: {
          betId,
          identityStatus: targetStatus,
          confidence: 0,
          identityResolvedAt: retryable ? null : now,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        await prisma.betSharp.updateMany({
          where: { betId, identityStatus: { in: ["PENDING", "UNMATCHED"] } },
          data: {
            identityStatus: targetStatus,
            confidence: 0,
            identityResolvedAt: retryable ? null : now,
          },
        });
      } else {
        throw error;
      }
    }
  }

  const sharp = await prisma.betSharp.findUnique({
    where: { betId },
    select: { identityStatus: true },
  });
  if (!sharp || sharp.identityStatus !== targetStatus) return;

  await recordTrainingFailure(
    bet,
    retryable ? "enrich_dead_letter_retryable" : "enrich_dead_letter_terminal",
  );
  log.info(
    { betId, identityStatus: targetStatus },
    retryable
      ? "DLQ antes do evento → PENDING + training case OPEN"
      : "DLQ terminal → UNMATCHED + training case OPEN",
  );
}
