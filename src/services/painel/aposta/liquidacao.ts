import "server-only";
import type { BetStatus, IaJudgeEvidenceKind, Prisma } from "@/src/generated/prisma/client";
import { toNumber } from "@/src/domain/money";
import { prisma } from "@/src/infra/prisma";
import { jsonObject } from "@/src/services/settlement/flashscore/observation-store";

/**
 * A prova do resultado que está valendo, para a ficha. Quem decidiu é o último
 * `STATUS_CHANGED`, e é ele que diz qual evidência conta: a sugestão do
 * IA-Judge só entra quando foi ela que liquidou, então a aprovada antes de uma
 * reabertura não aparece como prova da decisão manual que veio depois.
 */
export type BetSettlementEvidence = {
  /** `source` do evento: `flashscore`, `ia-judge:<quem>`, `manual:<quem>`. */
  source: string | null;
  changedAt: Date;
  /** O status que esta liquidação deu, o atual da aposta. */
  status: BetStatus;
  /** O artilheiro por tempo diz o período só no mercado. */
  terms: { mercado: string; selecao: string; esporte: string };
  /** O que o FlashScore gravou do jogo. A liquidação manual não o apaga; só a reabertura. */
  result: {
    /** Gravado só com o jogo encerrado (liquidação ou recusa pelo placar). */
    scoreHome: number | null;
    scoreAway: number | null;
    matchConfidence: number | null;
    /**
     * A observação fechou. Aberta, o snapshot é a última leitura e pode ser do
     * jogo em andamento: a aposta liquidada à mão deixa de ser observada.
     */
    final: boolean;
    snapshot: unknown;
  } | null;
  /** A sugestão que esta liquidação aprovou; null fora do IA-Judge. */
  judge: {
    valueFound: string;
    confidence: number;
    sourceUrl: string | null;
    groundingSources?: unknown;
    reason: string;
    provider: string;
    evidenceKind: IaJudgeEvidenceKind;
  } | null;
  /**
   * `bet_player_prop.evidence`, que a rechecagem de 24h regrava com a leitura
   * dela: a prova da liquidação fica no snapshot (`playerProp.details`).
   */
  playerPropEvidence: unknown;
};

/**
 * Eventos sem vínculo explícito só admitem a sugestão se ela for única na
 * janela da transação. Reaberturas rápidas podem produzir várias aprovações.
 */
const JUDGE_LINK_TOLERANCE_MS = 2 * 60_000;

/** null para aposta pendente, removida ou sem o evento de quem a liquidou. */
export async function getBetSettlementEvidence(betId: string): Promise<BetSettlementEvidence | null> {
  return prisma.$transaction(async (tx) => {
    const bet = await tx.bet.findUnique({
      where: { id: betId },
      select: {
        status: true,
        deletedAt: true,
        mercado: true,
        selecao: true,
        esporte: true,
        result: {
          select: { scoreHome: true, scoreAway: true, resultMatchConfidence: true, resultFinal: true, resultSnapshot: true },
        },
        playerProp: { select: { evidence: true } },
      },
    });
    if (!bet || bet.deletedAt || bet.status === "PENDING") return null;
    const change = await tx.settlementEvent.findFirst({
      where: { betId, type: "STATUS_CHANGED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { payload: true, createdAt: true },
    });
    if (!change) return null;
    const payload = jsonObject(change.payload) ?? {};
    // O evento que não leva ao status atual não é quem o decidiu: melhor sem
    // cartão do que com o autor de outro resultado.
    if (payload.to !== bet.status) return null;
    const source = typeof payload.source === "string" && payload.source ? payload.source : null;
    const changedAt = typeof payload.changedAt === "string" && Number.isFinite(Date.parse(payload.changedAt))
      ? new Date(payload.changedAt)
      : change.createdAt;
    const judge = source?.startsWith("ia-judge:")
      ? await approvedSuggestion(tx, betId, source.slice("ia-judge:".length), bet.status, changedAt, payload.judgeSuggestionId)
      : null;
    const { result } = bet;
    return {
      source,
      changedAt,
      status: bet.status,
      terms: { mercado: bet.mercado, selecao: bet.selecao, esporte: bet.esporte },
      result: result
        ? {
            scoreHome: result.scoreHome,
            scoreAway: result.scoreAway,
            matchConfidence: result.resultMatchConfidence == null ? null : toNumber(result.resultMatchConfidence),
            final: result.resultFinal,
            snapshot: result.resultSnapshot,
          }
        : null,
      judge,
      playerPropEvidence: bet.playerProp?.evidence ?? null,
    };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}

/** Vínculo exato; sem id, só uma candidata inequívoca do mesmo ator, aposta e resultado. */
async function approvedSuggestion(
  tx: Prisma.TransactionClient,
  betId: string,
  actor: string,
  status: BetStatus,
  changedAt: Date,
  suggestionId: unknown,
): Promise<BetSettlementEvidence["judge"]> {
  if (suggestionId != null && (typeof suggestionId !== "string" || !suggestionId)) return null;
  const candidates = await tx.iaJudgeSuggestion.findMany({
    where: {
      betId,
      ...(typeof suggestionId === "string" ? { id: suggestionId } : {}),
      status: "APPROVED",
      resolvedBy: actor,
      suggestedStatus: status,
      ...(suggestionId == null ? { resolvedAt: {
        gte: new Date(changedAt.getTime() - JUDGE_LINK_TOLERANCE_MS),
        lte: new Date(changedAt.getTime() + JUDGE_LINK_TOLERANCE_MS),
      } } : {}),
    },
    take: 2,
    select: {
      valueFound: true, confidence: true, sourceUrl: true, reason: true, provider: true, evidenceKind: true, groundingSources: true,
    },
  });
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}
