import { IdentityStatus, TrainingStatus } from "@/src/generated/prisma/client";
import { kickoffChangedMaterially } from "@/src/domain/kickoff-infer";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";

const log = createLogger("kickoff-revive");

/**
 * Reabre identidade sharp encerrada cedo (UNSUPPORTED/UNMATCHED) após o
 * kickoff mudar ≥1h. Após reopen, enfileira enrich imediato (não espera o
 * cron `sharp.revive`).
 */
export async function reopenSharpIdentityAfterKickoffChange(params: {
  betId: string;
  anterior: Date;
  novo: Date;
}): Promise<{ reopened: boolean; reason?: string }> {
  if (!kickoffChangedMaterially(params.anterior, params.novo)) {
    return { reopened: false, reason: "immaterial_change" };
  }

  const bet = await prisma.bet.findFirst({
    where: { id: params.betId, deletedAt: null },
    select: {
      id: true,
      status: true,
      evento: true,
      esporte: true,
      sharp: { select: { identityStatus: true } },
    },
  });
  if (!bet) return { reopened: false, reason: "bet_not_found" };
  if (bet.status !== "PENDING") {
    return { reopened: false, reason: "bet_not_pending" };
  }

  const status = bet.sharp?.identityStatus;
  if (status === IdentityStatus.MATCHED) {
    return { reopened: false, reason: "already_matched" };
  }

  const terminal =
    status === IdentityStatus.UNSUPPORTED || status === IdentityStatus.UNMATCHED;

  const reopenedCase = await prisma.trainingCase.findFirst({
    where: { betId: params.betId, status: TrainingStatus.REJECTED },
    orderBy: { resolvedAt: "desc" },
    select: { id: true },
  });
  const openCase = await prisma.trainingCase.findFirst({
    where: { betId: params.betId, status: TrainingStatus.OPEN },
    select: { id: true },
  });

  if (!terminal && !reopenedCase) {
    return { reopened: false, reason: "nothing_to_reopen" };
  }

  await prisma.$transaction(async (tx) => {
    if (terminal) {
      await tx.betSharp.updateMany({
        where: {
          betId: params.betId,
          identityStatus: { in: [IdentityStatus.UNSUPPORTED, IdentityStatus.UNMATCHED] },
        },
        data: { identityStatus: IdentityStatus.PENDING, confidence: 0, identityResolvedAt: null },
      });
    }

    if (reopenedCase) {
      await tx.trainingCase.update({
        where: { id: reopenedCase.id },
        data: {
          status: TrainingStatus.OPEN,
          resolvedAt: null,
          resolution: null,
        },
      });
    } else if (terminal && !openCase) {
      await tx.trainingCase.create({
        data: {
          betId: params.betId,
          status: TrainingStatus.OPEN,
          evento: bet.evento,
          esporte: bet.esporte,
          candidatesJson: [],
          autoScore: 0,
          llmVerdictJson: {
            source: "matching",
            reason: "kickoff_changed_reopened",
          },
        },
      });
    }
  });

  try {
    const { getSharedBoss } = await import("@/src/infra/boss");
    const { enqueueSharpEnrich } = await import("@/src/services/scheduling/enqueue-enrich");
    const boss = await getSharedBoss();
    const jobId = await enqueueSharpEnrich(boss, params.betId, {
      origem: "kickoff-revive",
    });
    await prisma.auditEvent.create({
      data: {
        actor: "system",
        action: "kickoff.sharp_revive",
        resource: "bet",
        resourceId: params.betId,
        details: {
          anterior: params.anterior.toISOString(),
          novo: params.novo.toISOString(),
          jobId,
        },
      },
    });
  } catch (err) {
    // Reopen já commitou — enqueue é best-effort (cron revive cobre).
    log.warn({ err, betId: params.betId }, "falha ao enfileirar enrich pós-kickoff-revive");
  }

  return { reopened: true };
}
