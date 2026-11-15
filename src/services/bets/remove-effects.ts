import type { BetStatus } from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";

/**
 * Efeitos pós-commit da remoção e da restauração: filas de enrich e de esporte.
 * A agenda do fechamento não precisa: a série confere a aposta antes de cada
 * consulta e se encerra sozinha quando ela foi removida.
 */

const log = createLogger("bet-remove");

export async function finishSoftDeleteBet(betId: string, result: { alreadyDeleted: boolean }) {
  if (!result.alreadyDeleted) {
    try {
      const { getSharedBoss } = await import("@/src/infra/boss");
      const { cancelPendingSharpEnrich } = await import("@/src/services/scheduling/enqueue-enrich");
      const { cancelPendingSportResolution } = await import(
        "@/src/services/scheduling/enqueue-sport-resolution"
      );
      const boss = await getSharedBoss();
      await Promise.all([
        cancelPendingSharpEnrich(boss, betId, "removed"),
        cancelPendingSportResolution(boss, betId, "removed"),
      ]);
    } catch (err) {
      // A remoção já foi persistida e jobs antigos viram no-op, mas a falha
      // precisa ficar observável para não esconder degradação do pg-boss.
      log.warn(
        { err, betId: betId },
        "falha ao cancelar jobs pendentes após soft-delete",
      );
    }
  }

}

export async function finishNotTakenRestore(betId: string, result: { changed: boolean; restoredStatus?: BetStatus | null; captureFollowupId?: string }) {
  if (result.changed) {
    log.info(
      { betId: betId, restoredStatus: result.restoredStatus },
      "decisão não peguei desfeita e aposta restaurada",
    );
    if (result.restoredStatus === "PENDING") {
      try {
        const { getSharedBoss } = await import("@/src/infra/boss");
        const { dispatchCaptureFollowupAudit } = await import("@/src/services/scheduling/enqueue-after-capture");
        if (result.captureFollowupId) {
          await dispatchCaptureFollowupAudit(await getSharedBoss(), result.captureFollowupId);
        }
      } catch (err) {
        // A intenção gravada na restauração continua pendente para a outbox.
        log.warn({ err, betId: betId }, "falha ao reenfileirar aposta restaurada");
      }
    }
  }
}
