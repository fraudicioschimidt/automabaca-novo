import { rotuloStatus } from "@/src/domain/mensagem-operador";
import type { GroundingSource } from "@/src/domain/trusted-sports-source-url";
import {
  Prisma,
  type BetStatus,
  type IaJudgeEvidenceKind,
} from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { applyAutomaticBetStatusChangeTx } from "@/src/services/bets/settle";
import { finishBetStatusChange } from "@/src/services/bets/settle-effects";
import { sendOperatorNotification } from "@/src/services/ops/alerts";
import { resolveOperationalActionBySourceKeyTx } from "@/src/services/ops/operational-actions";
import { runSerializableTransaction, type TransactionWriteGuard } from "@/src/services/shared/transaction";
import type { IaJudgeCandidate } from "./candidates";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

/**
 * Ciclo de vida da sugestão do IA-Judge: criação (com trava na versão da
 * aposta), aprovação que liquida, recusa com cooldown e descarte das órfãs.
 */

const log = createLogger("ia-judge-approve");
const judgeLog = createLogger("ia-judge");

/** Descarta PENDING de tips soft-deletadas (FK não cascateia status). */
export async function dismissOrphanedIaJudgeSuggestions(): Promise<number> {
  const orphaned = await prisma.iaJudgeSuggestion.updateMany({
    where: { status: "PENDING", bet: { deletedAt: { not: null } } },
    data: {
      status: "REJECTED",
      resolvedAt: new Date(),
      resolvedBy: "system",
    },
  });
  const stale = await prisma.$executeRaw`
    UPDATE ia_judge_suggestions AS suggestion
    SET status = 'REJECTED'::"IaJudgeSuggestionStatus",
        "resolvedAt" = now(),
        "resolvedBy" = 'system:stale-bet-version'
    FROM bets AS bet
    WHERE suggestion."betId" = bet.id
      AND suggestion.status = 'PENDING'::"IaJudgeSuggestionStatus"
      AND (suggestion."betUpdatedAt" IS NULL OR suggestion."betUpdatedAt" <> bet."updatedAt")
  `;
  const count = orphaned.count + stale;
  if (count > 0) {
    log.info(
      { count, orphaned: orphaned.count, stale },
      "sugestões IA-Judge órfãs ou desatualizadas descartadas",
    );
  }
  return count;
}

export async function approveIaJudgeSuggestion(params: {
  suggestionId: string;
  actor: string;
  /** Só o agente do dono: a aposta que ele conferiu, a revisão vista e a trilha, na mesma transação. */
  delegated?: { betId: string; expectedVersion: number; audit: { action: string; details: Prisma.InputJsonObject } };
}, options?: { beforeWrite?: TransactionWriteGuard }): Promise<{ betId: string; status: string }> {
  const { suggestionId, actor } = params;

  const resultado = await runSerializableTransaction("approveIaJudgeSuggestion", async (tx) => {
    const suggestion = await tx.iaJudgeSuggestion.findUnique({
      where: { id: suggestionId },
      include: {
        bet: { select: { id: true, deletedAt: true, status: true, updatedAt: true, manualSettlementVersion: true } },
      },
    });
    if (!suggestion) throw new RecusaDeNegocioError(`Sugestão IA-Judge ${suggestionId} não encontrada.`);
    if (params.delegated && (
      suggestion.betId !== params.delegated.betId
      || suggestion.bet.manualSettlementVersion !== params.delegated.expectedVersion
    )) {
      throw new RecusaDeNegocioError(`A aposta ${suggestion.betId} mudou depois do plano; gere um novo plano.`);
    }
    if (suggestion.status !== "PENDING") {
      throw new RecusaDeNegocioError(`Sugestão já processada (${suggestion.status}).`);
    }
    if (suggestion.bet.deletedAt) {
      throw new RecusaDeNegocioError(`Aposta ${suggestion.betId} foi removida.`);
    }
    if (suggestion.bet.status !== "PENDING") {
      throw new RecusaDeNegocioError(`Aposta ${suggestion.betId} já não está pendente.`);
    }
    if (
      !suggestion.betUpdatedAt ||
      suggestion.betUpdatedAt.getTime() !== suggestion.bet.updatedAt.getTime()
    ) {
      throw new RecusaDeNegocioError(
        `Sugestão IA-Judge ${suggestionId} está desatualizada; reavalie a aposta.`,
      );
    }

    const settled = await applyAutomaticBetStatusChangeTx(tx, {
      betId: suggestion.betId,
      newStatus: suggestion.suggestedStatus,
      source: `ia-judge:${actor}`,
      judgeSuggestionId: suggestion.id,
    });

    const approved = await tx.iaJudgeSuggestion.updateMany({
      where: { id: suggestionId, status: "PENDING" },
      data: {
        status: "APPROVED",
        resolvedAt: new Date(),
        resolvedBy: actor,
      },
    });
    if (approved.count !== 1) {
      throw new RecusaDeNegocioError(`Sugestão ${suggestionId} já não está pendente.`);
    }
    if (params.delegated) {
      await tx.auditEvent.create({
        data: {
          actor, action: params.delegated.audit.action, resource: "bet", resourceId: suggestion.betId,
          details: {
            ...params.delegated.audit.details, suggestionId, from: "PENDING", to: settled.status, lucro: settled.lucro,
          },
        },
      });
    }

    await resolveOperationalActionBySourceKeyTx(
      tx,
      "settlement.parado",
      suggestion.betId,
      actor === "ia_judge_auto"
        ? "Liquidada automaticamente via IA-Judge"
        : `Liquidada via IA-Judge (${actor})`,
    );

    log.info(
      { suggestionId, betId: suggestion.betId, status: settled.status },
      "IA-Judge aprovado — tip liquidada",
    );
    return { betId: suggestion.betId, status: settled.status, settled };
  }, options);

  // DEPOIS do commit, como toda liquidação: cancela o sharp.enrich pendente e
  // avisa quando a aposta mudou de status sem mexer no saldo de uma conta.
  await finishBetStatusChange(resultado.betId, resultado.settled);
  return { betId: resultado.betId, status: resultado.status };
}

/**
 * O "Rejeitar" do dono em Operações. A sugestão REJECTED sozinha não serve de
 * marca: a remoção da aposta também rejeita a pendente. A retenção padrão do
 * AuditEvent (30 dias) cobre a janela do juiz, que fecha 30 dias após o jogo.
 */
const OWNER_REJECTION_ACTION = "ia_judge.suggestion_rejected";

/** O dono já recusou um veredito da IA para esta aposta: ela só sugere, não liquida sozinha. */
export async function ownerRejectedIaJudge(betId: string): Promise<boolean> {
  const rejection = await prisma.auditEvent.findFirst({
    where: { resource: "bet", resourceId: betId, action: OWNER_REJECTION_ACTION },
    select: { id: true },
  });
  return rejection !== null;
}

export async function rejectIaJudgeSuggestion(params: {
  suggestionId: string;
  actor: string;
}): Promise<void> {
  const { suggestionId, actor } = params;
  const now = new Date();
  await runSerializableTransaction("rejectIaJudgeSuggestion", async (tx) => {
    const suggestion = await tx.iaJudgeSuggestion.findFirst({
      where: { id: suggestionId, status: "PENDING" },
      select: { betId: true },
    });
    if (!suggestion) throw new RecusaDeNegocioError(`Sugestão ${suggestionId} não está pendente.`);

    await tx.iaJudgeSuggestion.update({
      where: { id: suggestionId },
      data: { status: "REJECTED", resolvedAt: now, resolvedBy: actor },
    });
    await tx.auditEvent.create({
      data: {
        actor,
        action: OWNER_REJECTION_ACTION,
        resource: "bet",
        resourceId: suggestion.betId,
        details: { suggestionId },
      },
    });
    await tx.iaJudgeCooldown.upsert({
      where: { key: `bet:${suggestion.betId}` },
      create: {
        key: `bet:${suggestion.betId}`,
        reason: "manual_rejection",
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      },
      update: {
        reason: "manual_rejection",
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      },
    });
  });
  log.info({ suggestionId, actor }, "IA-Judge rejeitado");
}

const PENDING_IA_JUDGE_WHERE = {
  status: "PENDING",
  bet: { deletedAt: null, status: "PENDING" },
} as const;

/**
 * Página e total PENDING com tip ativa — evita esconder backlog acima do limite
 * visual. Quem lê descarta antes as desatualizadas (`dismissOrphanedIaJudgeSuggestions`).
 */
export async function getPendingIaJudgeSuggestionsPage() {
  const select = {
      id: true,
      betId: true,
      suggestedStatus: true,
      valueFound: true,
      confidence: true,
      reason: true,
      sourceUrl: true,
      groundingSources: true,
      evidenceKind: true,
      provider: true,
      createdAt: true,
      bet: {
        select: {
          evento: true,
          esporte: true,
          pais: true,
          competicao: true,
          mercado: true,
          selecao: true,
          odds: true,
          stake: true,
          data: true,
          bankroll: { select: { nome: true } },
        },
      },
    } as const;
  const [items, total] = await Promise.all([
    prisma.iaJudgeSuggestion.findMany({
      where: PENDING_IA_JUDGE_WHERE,
      // O jogo mais antigo primeiro, como nas outras filas de Operações.
      orderBy: [{ bet: { data: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
      take: 40,
      select,
    }),
    prisma.iaJudgeSuggestion.count({ where: PENDING_IA_JUDGE_WHERE }),
  ]);
  return { items, total };
}

export async function persistSuggestion(
  current: IaJudgeCandidate,
  suggestion: {
    suggestedStatus: BetStatus; valueFound: string; confidence: number;
    reason: string; sourceUrl: string | null; provider: string;
    evidenceKind: IaJudgeEvidenceKind;
    groundingQuery?: string;
    groundingSources?: GroundingSource[];
    groundedAt?: Date;
  },
): Promise<{ outcome: "created" | "skipped"; suggestionId?: string }> {
  let createdId: string | undefined;
  try {
    const persisted = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM bets WHERE id = ${current.id} AND "deletedAt" IS NULL
          AND status = 'PENDING'::"BetStatus"
          AND "sportResolutionStatus" = 'CONFIRMED'::"SportResolutionStatus"
          AND "updatedAt" = ${current.updatedAt} FOR UPDATE
      `;
      if (locked.length === 0) return false;
      const created = await tx.iaJudgeSuggestion.create({ data: {
        betId: current.id, suggestedStatus: suggestion.suggestedStatus,
        valueFound: suggestion.valueFound, confidence: suggestion.confidence,
        reason: suggestion.reason, sourceUrl: suggestion.sourceUrl,
        provider: suggestion.provider, status: "PENDING", betUpdatedAt: current.updatedAt,
        evidenceKind: suggestion.evidenceKind,
        groundingQuery: suggestion.groundingQuery,
        groundedAt: suggestion.groundedAt,
        ...(suggestion.groundingSources
          ? { groundingSources: suggestion.groundingSources as Prisma.InputJsonValue }
          : {}),
      } });
      createdId = created.id;
      return true;
    });
    if (!persisted || !createdId) return { outcome: "skipped" };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { outcome: "skipped" };
    throw error;
  }
  try {
    await sendOperatorNotification(
      `🤖 IA sugere: ${rotuloStatus(suggestion.suggestedStatus)} · ${current.evento}\n` +
      `${current.bankrollNome} · ${current.mercado} · ${current.selecao}\n` +
      `Certeza: ${Math.round(suggestion.confidence * 100)}%\n` +
      `O que achou: ${suggestion.valueFound}\n${suggestion.reason}` +
      (suggestion.sourceUrl ? `\nFonte: ${suggestion.sourceUrl}` : "") +
      "\n👉 Aprove ou recuse em Operações.",
      { key: `ia-judge-suggestion:${createdId}` },
    );
  } catch (error) {
    judgeLog.error({ err: error, betId: current.id }, "alerta IA-Judge falhou — sugestão já criada");
  }
  return { outcome: "created", suggestionId: createdId };
}
