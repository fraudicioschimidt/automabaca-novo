import { z } from "zod";
import type { Prisma } from "@/src/generated/prisma/client";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { manualSettlementView, type ManualSettlementResult } from "@/src/domain/manual-settlement";
import { runSerializableTransaction, type TransactionWriteGuard } from "@/src/services/shared/transaction";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import { applyManualBetStatusChangeTx, type ApplyBetStatusChangeParams } from "./settle";
import { finishBetStatusChange } from "./settle-effects";

const confirmationSchema = z.object({ expectedVersion: z.number().int().positive().max(2147483647), requestId: z.uuid() }).strict();

/** A versão vem da tela; relê-la no servidor antes de escrever ocultaria o conflito. */
export async function settleManualFromView(params: Pick<ApplyBetStatusChangeParams, "betId" | "newStatus" | "cashoutLucro" | "source" | "requirePending"> & {
  bankrollSlug: string; confirmation: unknown;
  /** Trilha extra na MESMA transação, só quando a transição é gravada (liquidação delegada). */
  audit?: { actor: string; action: string; details: Prisma.InputJsonObject };
}, options?: { beforeWrite?: TransactionWriteGuard; beforeSettlement?: TransactionWriteGuard }): Promise<ManualSettlementResult> {
  const confirmation = confirmationSchema.safeParse(params.confirmation);
  if (!confirmation.success) throw new RecusaDeNegocioError("Atualize a página antes de confirmar o resultado desta aposta.");
  const { expectedVersion, requestId } = confirmation.data;
  const requestHash = canonicalSha256({ betId: params.betId, bankrollSlug: params.bankrollSlug,
    newStatus: params.newStatus, cashoutLucro: params.cashoutLucro ?? null, source: params.source, expectedVersion });
  const outcome = await runSerializableTransaction("manualSettlement.confirm", async (tx) => {
    const bet = await tx.bet.findFirst({ where: { id: params.betId, bankroll: { slug: params.bankrollSlug } } });
    if (!bet || bet.deletedAt) return { reply: { kind: "unavailable", message: "Esta aposta foi removida ou não está disponível neste tipster." } as ManualSettlementResult };
    const current = manualSettlementView(bet);
    const receipt = await tx.manualSettlementReceipt.findUnique({ where: { betId_requestId: { betId: bet.id, requestId } } });
    if (receipt) {
      if (receipt.requestHash !== requestHash) throw new RecusaDeNegocioError("Esta confirmação já foi usada com outros dados. Reabra o resultado para confirmar novamente.");
      // Repetir uma requisição concluída não reaplica a transição, mesmo após outra correção.
      return { reply: { kind: "saved", lucro: current.profit, current, duplicate: true } as ManualSettlementResult };
    }
    if (bet.manualSettlementVersion !== expectedVersion) return { reply: { kind: "conflict", current } as ManualSettlementResult };
    // A guarda da decisão só roda depois do recibo e da versão: repetir uma
    // gravação concluída continua sendo no-op, mesmo que a elegibilidade mude.
    await options?.beforeSettlement?.(tx);
    const effects = await applyManualBetStatusChangeTx(tx, params);
    const saved = await tx.bet.findUniqueOrThrow({ where: { id: bet.id } });
    await tx.manualSettlementReceipt.create({ data: { betId: bet.id, requestId, requestHash, resultVersion: saved.manualSettlementVersion } });
    if (params.audit) {
      await tx.auditEvent.create({ data: { actor: params.audit.actor, action: params.audit.action, resource: "bet", resourceId: bet.id,
        details: { ...params.audit.details, requestId, from: current.status, to: saved.status, lucro: effects.lucro } } });
    }
    return { reply: { kind: "saved", lucro: effects.lucro, current: manualSettlementView(saved), duplicate: false } as ManualSettlementResult, effects };
  }, options);
  if (outcome.effects) await finishBetStatusChange(params.betId, outcome.effects);
  return outcome.reply;
}
