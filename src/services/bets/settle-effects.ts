import { OperationalActionStatus, OperationalRisk, type Prisma } from "@/src/generated/prisma/client";
import type { ApplyBetStatusChangeResult, NoAccountReason } from "./settle";
import type { OperationalAlertContext } from "@/src/services/ops/alerts";
import { ACTIVE_OPERATIONAL_ACTION_STATUSES } from "@/src/domain/operational-action-status";
import {
  operationalActionFingerprint,
  priorityForRisk,
  reportOperationalActionTx,
} from "@/src/services/ops/operational-actions";
import { recordActionAuditTx } from "@/src/services/ops/operational-actions";
import { createLogger } from "@/src/infra/logger";

/**
 * Efeitos operacionais da liquidação: a ação "liquidada sem conta" (gravada na
 * transação do resultado) e o que só pode rodar depois do commit.
 */

const NO_ACCOUNT_TEXT: Record<NoAccountReason, (casa: string) => string> = {
  sem_conta_unica: (casa) => `Há conta na ${casa}, mas nenhuma (ou mais de uma) ligada a este tipster.`,
  conta_limitada: (casa) =>
    `A conta na ${casa} está limitada, e aposta nova não entra em conta limitada.`,
  conta_encerrada: (casa) =>
    `A conta da ${casa} desta aposta foi encerrada, e não há outra conta ativa da casa ligada a este tipster.`,
  conta_removida: (casa) =>
    `A conta da ${casa} desta aposta foi removida, e não há outra conta ativa da casa ligada a este tipster.`,
};

/** O que resolve em cada caso; "volte para Pendente" só serve depois de haver conta elegível. */
const NO_ACCOUNT_ACTION: Record<NoAccountReason, string> = {
  sem_conta_unica:
    '👉 Em Contas, ligue a conta certa ao tipster e volte a aposta para "Pendente": ela liquida de novo.',
  conta_limitada:
    "👉 Se você não fez esta aposta, nada a fazer. Se fez por outra conta, cadastre-a em Contas, " +
    'ligue-a ao tipster e volte a aposta para "Pendente": ela liquida de novo.',
  conta_encerrada:
    "👉 Se a aposta deve contar numa conta, reabra a conta ou ligue outra da casa ao tipster em Contas " +
    'e volte a aposta para "Pendente": ela liquida de novo.',
  // A conta removida não reabre: só resta outra conta da casa.
  conta_removida:
    "👉 Se a aposta deve contar numa conta, ligue outra conta ativa da casa ao tipster em Contas " +
    'e volte a aposta para "Pendente": ela liquida de novo.',
};

function liquidacaoSemContaAlert(
  betId: string,
  result: ApplyBetStatusChangeResult,
): { message: string; context: OperationalAlertContext } | null {
  if (!result.semContaElegivel) return null;
  const { casaDeAposta, reason } = result.semContaElegivel;
  return {
    message:
      `💳 Aposta liquidada sem mexer no saldo da conta\n` +
      `${NO_ACCOUNT_TEXT[reason](casaDeAposta)}\n` +
      "O resultado foi registrado; só o saldo não acompanhou.\n" +
      NO_ACCOUNT_ACTION[reason],
    context: {
      source: "bets.settle-sem-conta",
      key: betId,
      title: "Liquidada sem movimentar conta",
      resource: "bet",
      resourceId: betId,
      evidence: {
        casaDeAposta: result.semContaElegivel.casaDeAposta,
        bankrollId: result.semContaElegivel.bankrollId,
        reason,
        status: result.status,
      },
      autoResolve: false,
    },
  };
}

/** Fecha quando o ledger acompanha ou a correção final deixa de exigir lançamento. */
export async function persistirLiquidacaoSemContaTx(
  tx: Prisma.TransactionClient,
  betId: string,
  result: ApplyBetStatusChangeResult,
  opts: { ledgerPosted?: boolean } = {},
): Promise<void> {
  const alert = liquidacaoSemContaAlert(betId, result);
  if (alert) {
    await reportOperationalActionTx(tx, {
      source: alert.context.source,
      key: alert.context.key,
      area: "incidentes",
      actionType: "incident.review",
      title: alert.context.title,
      description: alert.message,
      priority: priorityForRisk(OperationalRisk.MEDIUM),
      risk: OperationalRisk.MEDIUM,
      resource: alert.context.resource,
      resourceId: alert.context.resourceId,
      evidence: { message: alert.message.slice(0, 2_000), ...(alert.context.evidence ?? {}) },
      autoResolve: false,
    });
    return;
  }
  const zeroFinalResult = result.status !== "PENDING" && result.lucro === 0;
  if (!opts.ledgerPosted && !zeroFinalResult) return;
  const fingerprint = operationalActionFingerprint("bets.settle-sem-conta", betId);
  const existing = await tx.operationalAction.findFirst({
    where: { fingerprint, status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] } },
    select: { id: true },
  });
  if (!existing) return;
  const note = zeroFinalResult
    ? "Resultado final sem lucro ou perda; não há lançamento de conta a reparar."
    : "Ledger criado; a conta única já acompanha a liquidação.";
  const changed = await tx.operationalAction.updateMany({
    where: { id: existing.id, status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] } },
    data: {
      status: OperationalActionStatus.RESOLVED,
      owner: "system",
      resolvedAt: new Date(),
      resolutionNote: note,
    },
  });
  if (changed.count !== 1) return;
  await recordActionAuditTx(
    tx,
    [await tx.operationalAction.findUniqueOrThrow({ where: { id: existing.id } })],
    "resolved",
    "system",
    note,
  );
}

export async function alertarLiquidacaoSemConta(
  betId: string,
  result: ApplyBetStatusChangeResult,
): Promise<void> {
  const alert = liquidacaoSemContaAlert(betId, result);
  if (!alert) return;
  const { notifyPersistedOperationalAlert } = await import("@/src/services/ops/alerts");
  await notifyPersistedOperationalAlert(alert.message, alert.context);
}

/** Executar somente após o commit da transação que gravou o resultado. */
export async function finishBetStatusChange(betId: string, result: ApplyBetStatusChangeResult): Promise<void> {
  if (result.previousStatus === "PENDING" && result.status !== "PENDING") {
    try {
      const { getSharedBoss } = await import("@/src/infra/boss");
      const { cancelPendingSharpEnrich } = await import("@/src/services/scheduling/enqueue-enrich");
      await cancelPendingSharpEnrich(await getSharedBoss(), betId, "settled");
    } catch (err) {
      createLogger("bets-settle").warn({ err, betId }, "falha ao cancelar sharp.enrich pós-settle");
    }
  }
  await alertarLiquidacaoSemConta(betId, result);
}
