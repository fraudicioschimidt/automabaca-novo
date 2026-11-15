import { z } from "zod";
import type { Prisma } from "@/src/generated/prisma/client";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { RecusaDeNegocioError } from "./recusa";

type CreationRequest = { action: "conta.create" | "bankroll.create"; actor: string; requestId: string; requestHash: string };

/** O formulário mantém a chave após falha de transporte; dados diferentes não a reutilizam. */
export function prepareCreationRequest(action: CreationRequest["action"], actor: string, requestId: string | undefined, data: unknown): CreationRequest | null {
  if (requestId === undefined) return null;
  if (!z.uuid().safeParse(requestId).success) throw new RecusaDeNegocioError("Identificador de criação inválido. Abra um novo formulário.");
  return { action, actor, requestId: requestId.toLowerCase(), requestHash: canonicalSha256(data) };
}

/** Antes de qualquer efeito: um pedido concluído continua concluído após edição ou exclusão. */
export async function findCreationReceiptTx(tx: Prisma.TransactionClient, request: CreationRequest | null): Promise<string | null> {
  if (!request) return null;
  const receipt = await tx.creationReceipt.findUnique({ where: { action_actor_requestId: {
    action: request.action, actor: request.actor, requestId: request.requestId,
  } } });
  if (!receipt) return null;
  if (receipt.requestHash !== request.requestHash) throw new RecusaDeNegocioError("Esta criação já foi confirmada com outros dados. Abra um novo formulário.");
  return receipt.resourceId;
}

/** Na mesma transação do recurso e da auditoria; rollback não consome o pedido. */
export async function recordCreationReceiptTx(tx: Prisma.TransactionClient, request: CreationRequest | null, resourceId: string): Promise<void> {
  if (request) await tx.creationReceipt.create({ data: { ...request, resourceId } });
}
