import type { Prisma } from "@/src/generated/prisma/client";
import {
  SportResolutionSource,
  SportResolutionStatus,
} from "@/src/generated/prisma/enums";
import { SPORT_RESOLVER_VERSION, UNKNOWN_SPORT } from "@/src/domain/sports/detect";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { StaleSportResolutionError, type SportResolutionSnapshot } from "@/src/services/bets/edit";
import { captureSportEvidence } from "./decision";
import type { SportCandidate, SportDissent } from "./types";

/**
 * O efeito da resolução: gravar o veredito e os candidatos. A confirmação da
 * modalidade não ensina alias de time: a confiança dela é do ESPORTE, e o
 * candidato que a sustenta pode ser um homônimo de outro país.
 */

export async function persistCandidates(
  snapshot: SportResolutionSnapshot,
  candidates: readonly SportCandidate[],
  status: SportResolutionStatus,
  candidate: SportCandidate | null,
  /** Por que não confirmou: o motivo, a próxima tentativa e quem discordou. */
  outcome?: { reason: string; retryAt?: string; dissent?: SportDissent },
): Promise<void> {
  const confidence =
    candidate?.confidence ??
    candidates.reduce(
      (highest, item) => Math.max(highest, item.confidence),
      0,
    );
  await runSerializableTransaction("sportResolution.persistCandidates", async (tx) => {
    // A leitura da captura fica junto dos candidatos: sem ela, o conflito que
    // a captura apontou sumiria na primeira consulta aos provedores.
    const current = await tx.bet.findUnique({
      where: { id: snapshot.id },
      select: { sportEvidence: true, sportResolutionStatus: true },
    });
    const capture = current ? captureSportEvidence(current) : null;
    const evidence = {
      candidates,
      selected: candidate,
      evaluatedAt: new Date().toISOString(),
      resolverVersion: SPORT_RESOLVER_VERSION,
      ...(outcome ?? {}),
      ...(capture ? { capture } : {}),
    } as Prisma.InputJsonValue;
    const changed = await tx.bet.updateMany({
      where: {
        id: snapshot.id,
        manualSettlementVersion: snapshot.manualSettlementVersion,
        deletedAt: null,
        sportResolutionStatus: {
          in: [SportResolutionStatus.PENDING, SportResolutionStatus.CONFLICT],
        },
      },
      data: {
        sportResolutionStatus: status,
        esporte: status === SportResolutionStatus.CONFIRMED
          ? (candidate?.sport ?? UNKNOWN_SPORT)
          : UNKNOWN_SPORT,
        sportConfidence: confidence,
        sportSource:
          candidate?.source ?? SportResolutionSource.UNRESOLVED,
        sportEvidence: evidence,
        sportResolvedAt:
          status === SportResolutionStatus.CONFIRMED ? new Date() : null,
        sportResolverVersion: SPORT_RESOLVER_VERSION,
      },
    });
    if (changed.count !== 1) throw new StaleSportResolutionError(snapshot.id);
    await tx.betCaptureEvidence.updateMany({
      where: { betId: snapshot.id },
      data: { candidatesJson: evidence },
    });
  });
}
