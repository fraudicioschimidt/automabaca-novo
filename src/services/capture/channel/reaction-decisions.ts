import type { Prisma } from "@/src/generated/prisma/client";
import { reactionOrder, type ReactionDecision, type ReactionEvent, type ReactionOutcome } from "@/src/domain/telegram-reaction";
import { channelIdFromSource, postExternalIdsWhere, postIdOfExternalId, telegramChannelSource } from "@/src/domain/telegram-source";
import { telegramAllowedChats, telegramOwnerId } from "@/src/infra/env";
import { channelFinancialSource } from "@/src/services/capture/capture-financial-context";
import { lockBetsForRemovalTx, removalNeedsReview, restoreRemovedBet, softDeleteBet, type RestoreResult } from "@/src/services/bets/remove";
import { finishNotTakenRestore, finishSoftDeleteBet } from "@/src/services/bets/remove-effects";
import { sendOperatorNotification } from "@/src/services/ops/alerts";
import { reportOperationalActionTx } from "@/src/services/ops/operational-actions";
import { reuseSerializableTransaction, runSerializableTransaction } from "@/src/services/shared/transaction";

/**
 * Reação no post do tipster: 👎 = "não peguei", só 👍 = "peguei". A decisão
 * fica guardada por post/banca (inclusive antes de a aposta existir) e é
 * aplicada na mesma transação da captura ou da própria reação. A reação
 * anônima do canal é do dono (só ele e os bots estão no canal); a
 * identificada vale de usuário autorizado.
 */

export function isAuthorizedReactionActor(actor: string | undefined | null): actor is string {
  return typeof actor === "string" && telegramAllowedChats().users.includes(actor);
}

/**
 * Quem reagiu: o usuário autorizado identificado ou, na contagem anônima do
 * canal, o dono, porque só ele e os bots estão no canal. O dono é o primeiro
 * id pessoal de `TELEGRAM_ALLOWED_CHATS` (ver `telegramAllowedChats`).
 */
export function reactionOwner(actorUserId: string | undefined): string | null {
  if (actorUserId !== undefined) return isAuthorizedReactionActor(actorUserId) ? actorUserId : null;
  return telegramOwnerId();
}

type ReactionEffect = { betId: string; event: string; removed?: { alreadyDeleted: boolean }; restored?: RestoreResult };
type AppliedReaction = { outcome: ReactionOutcome; effects?: ReactionEffect[] };

async function reviewReactionTx(tx: Prisma.TransactionClient, scope: ReactionScope, reason: string) {
  for (const bet of scope.bets) await reportOperationalActionTx(tx, {
    source: "telegram.reaction-review", key: `${scope.chatId}:${scope.targetMessageId}:${bet.id}`,
    area: "apostas", actionType: "bet.reaction.review", title: "Reação requer confirmação no painel",
    description: `Confira ${bet.evento} — ${bet.selecao} antes de alterar a participação nesta aposta.`,
    resource: "bet", resourceId: bet.id, autoResolve: false,
    evidence: { messageId: scope.targetMessageId, betIds: scope.bets.map(item => item.id), reason },
  });
}

/**
 * Apenas operações transacionais. Efeitos de fila/Telegram saem após o commit.
 *
 * Só age a mudança: o 👎 que entra remove o lote do post e tira a marca de
 * pega do que removeu; o que sai restaura o que o 👎 removeu, nunca o que o painel removeu.
 * Sem 👎, o 👍 que entra marca como pegas as apostas não removidas do post, e
 * o que sai desmarca todas.
 * Reação que não muda nada disso (❤️, 👎 mantido, 👍 repetido na contagem)
 * não mexe na aposta, e o que o painel fez depois fica. `before` é o estado do
 * post já aplicado antes deste evento; sem ele (captura, entrega atrasada) só
 * vale o 👎 ou o 👍 ainda pendente. Aplicado, o estado cobre todas as fotos
 * pendentes.
 */
async function applyLatestReactionTx(tx: Prisma.TransactionClient, scope: ReactionScope, before: ReactionDecision | null = null): Promise<AppliedReaction> {
  const photos = await reactionPhotosTx(tx, scope);
  const pending = photos.filter((photo) => !photo.handledAt);
  const [decision] = pending;
  if (!decision) return { outcome: { kind: "ignored", reason: photos.length > 0 ? "reacao_ja_tratada" : "sem_decisao" } };
  if (!isAuthorizedReactionActor(decision.actorUserId)) return { outcome: { kind: "ignored", reason: "autor_nao_autorizado" } };
  if (scope.bets.length === 0) return { outcome: { kind: "remembered" } };
  const actor = `telegram-user:${decision.actorUserId}`;
  const handled = async () => tx.telegramReactionState.updateMany({ where: { chatId: scope.chatId, messageId: { in: pending.map((photo) => photo.messageId) } }, data: { handledAt: new Date() } });
  const state = postDecision(photos);
  const down = state === "NOT_TAKEN";
  const up = state === "TAKEN";
  const wasDown = before === "NOT_TAKEN";
  // Com o 👎 no post o 👍 não conta: a aposta está fora da banca.
  const changed = down ? !wasDown : wasDown || up !== (before === "TAKEN");
  if (!changed) {
    await handled();
    return { outcome: { kind: "ignored", reason: "reacao_irrelevante" } };
  }
  const options = { client: reuseSerializableTransaction(tx), deferEffects: true };
  const effects: ReactionEffect[] = [];
  let outcome: ReactionOutcome = { kind: "ignored", reason: "reacao_irrelevante" };
  if (down) await lockBetsForRemovalTx(tx, scope.bets.map((bet) => bet.id));
  // O lote do post segue a mesma reação: cada seleção é removida ou restaurada.
  for (const bet of scope.bets) {
    if (down) {
      if (bet.status !== "PENDING" && !bet.settledAt) throw new Error("Aposta terminal sem instante de liquidação.");
      if (removalNeedsReview(bet)) {
        await reviewReactionTx(tx, { ...scope, bets: [bet] }, "aposta_liquidada_requer_painel");
        outcome = { kind: "ignored", reason: "aposta_liquidada_requer_painel" };
        continue;
      }
      const removed = await softDeleteBet({ betId: bet.id, actor, motivo: "nao_peguei (👎)", origin: "reacao" }, options);
      effects.push({ betId: bet.id, event: bet.evento, removed });
      outcome = { kind: "removed", betId: bet.id };
    } else if (wasDown && bet.notTakenAt) {
      const restored = await restoreRemovedBet({ betId: bet.id, actor, motivo: "reacao 👎 removida", by: "reacao" }, options);
      if (restored.blocked) { outcome = { kind: "ignored", reason: restored.blocked }; continue; }
      if (restored.panelOnly) { outcome = { kind: "ignored", reason: "removida_pelo_painel" }; continue; }
      effects.push({ betId: bet.id, event: bet.evento, restored });
      outcome = { kind: "neutralized", betId: bet.id };
    }
  }
  // Na captura atrasada, a reação mais recente pode ser um ❤️ noutra foto.
  // O instante do 👍 vem do começo do estado que ainda o mantém ativo.
  const taken = up && before === null
    ? photos.filter((photo) => photo.decision === "TAKEN" && isAuthorizedReactionActor(photo.actorUserId))
      .sort((a, b) => (a.decisionAt ?? a.occurredAt)!.getTime() - (b.decisionAt ?? b.occurredAt)!.getTime())[0]
    : null;
  const marked = await syncTakenTx(tx, scope, { up, down, at: taken?.decisionAt ?? taken?.occurredAt ?? decision.occurredAt ?? new Date(), actor });
  // A remoção e a restauração pesam mais no relato: elas mexeram no ledger.
  if (marked && outcome.kind === "ignored" && outcome.reason === "reacao_irrelevante") outcome = marked;
  await handled();
  return { outcome, effects };
}

/**
 * "Peguei": com só o 👍, as apostas do post que não estão removidas ganham a
 * hora da reação (a primeira fica); sem ele, todas perdem a marca, inclusive a
 * removida, para o "Restaurar" do painel não trazer uma marca que o post já
 * não tem. O 👎, que vence, tira a marca só da aposta que saiu da banca: a
 * liquidada que ele não remove continua pega. Não mexe em stake, lucro, conta nem
 * liquidação; só muda a versão da aposta (`updatedAt`), e uma sugestão
 * pendente do IA-Judge é refeita.
 */
async function syncTakenTx(
  tx: Prisma.TransactionClient,
  scope: ReactionScope,
  input: { up: boolean; down: boolean; at: Date; actor: string },
): Promise<ReactionOutcome | null> {
  const bets = await tx.bet.findMany({
    where: { id: { in: scope.bets.map((bet) => bet.id) } },
    select: { id: true, deletedAt: true, takenAt: true },
    orderBy: { id: "asc" },
  });
  const targets = input.up
    ? bets.filter((bet) => !bet.deletedAt && !bet.takenAt)
    : bets.filter((bet) => bet.takenAt && (!input.down || bet.deletedAt));
  const [first] = targets;
  if (!first) return null;
  await tx.bet.updateMany({ where: { id: { in: targets.map((bet) => bet.id) } }, data: { takenAt: input.up ? input.at : null } });
  await tx.auditEvent.createMany({
    data: targets.map((bet) => ({
      actor: input.actor, resource: "bet", resourceId: bet.id,
      action: input.up ? "bet.taken" : "bet.taken_undone",
      details: input.up
        ? { via: "👍 no post do canal", takenAt: input.at.toISOString(), messageId: scope.targetMessageId }
        : { via: input.down ? "👎 no post do canal" : "👍 retirado do post do canal", previousTakenAt: bet.takenAt?.toISOString() ?? null, messageId: scope.targetMessageId },
    })),
  });
  return { kind: input.up ? "taken" : "untaken", betId: first.id };
}

export async function applyTelegramReaction(event: ReactionEvent, decision: ReactionDecision): Promise<ReactionOutcome> {
  const actorUserId = reactionOwner(event.actorUserId);
  if (!actorUserId) return { kind: "ignored", reason: "autor_nao_autorizado" };
  if (!Number.isSafeInteger(event.messageId) || event.messageId <= 0 || event.messageId > 2147483647) return { kind: "ignored", reason: "mensagem_invalida" };
  const order = reactionOrder(event);
  const applied = await runSerializableTransaction("telegram.reaction", async (tx): Promise<AppliedReaction> => {
    const scope = await reactionScopeTx(tx, event.chatId, event.messageId);
    if (!scope) return { outcome: { kind: "ignored", reason: "origem_ambigua_ou_sem_banca" } };
    if (!order) {
      await reviewReactionTx(tx, scope, "reacao_sem_ordem_original");
      return { outcome: { kind: "ignored", reason: "reacao_sem_ordem_original" } };
    }
    // A ordem é a da própria foto: cada uma recebe as próprias contagens, e
    // as fotos do álbum chegam em filas paralelas.
    const photo = await tx.telegramReactionState.findUnique({ where: { chatId_messageId: { chatId: event.chatId, messageId: event.messageId } } });
    if (photo?.occurredAt && photo.updateId !== null) {
      const delta = order.occurredAt.getTime() - photo.occurredAt.getTime();
      if (delta < 0 || (delta === 0 && order.updateId <= photo.updateId)) {
        // Uma entrega repetida pode reencontrar o registro agora pronto. Usa
        // sempre a intenção persistida, nunca o payload antigo recebido.
        return applyLatestReactionTx(tx, scope);
      }
    }
    const before = postDecision((await reactionPhotosTx(tx, scope)).filter((row) => row.handledAt));
    await tx.telegramReactionState.update({ where: { chatId_messageId: { chatId: event.chatId, messageId: event.messageId } }, data: { ...order, actorUserId, decision, decisionAt: photo?.decision === decision ? photo.decisionAt ?? photo.occurredAt ?? order.occurredAt : order.occurredAt, handledAt: null } });
    await tx.auditEvent.create({ data: { actor: `telegram-user:${actorUserId}`, action: "telegram.reaction_decision", resource: "telegram-message", resourceId: `${event.chatId}:${event.messageId}`, details: { decision, anonima: event.actorUserId === undefined, occurredAt: order.occurredAt.toISOString(), updateId: String(order.updateId), targetMessageId: scope.targetMessageId, bankrollId: scope.bankrollId } } });
    return applyLatestReactionTx(tx, scope, before);
  });
  for (const effect of applied.effects ?? []) {
    if (effect.removed) {
      await finishSoftDeleteBet(effect.betId, effect.removed);
      if (!effect.removed.alreadyDeleted) await sendOperatorNotification(`👎 Aposta removida pela sua reação\n${effect.event}`, { key: `reaction:${effect.betId}:${event.updateId}` });
    }
    if (effect.restored) {
      await finishNotTakenRestore(effect.betId, effect.restored);
      if (effect.restored.changed) await sendOperatorNotification(`↩️ Aposta restaurada: você tirou o 👎\n${effect.event}`, { key: `reaction:${effect.betId}:${event.updateId}` });
    }
  }
  return applied.outcome;
}

/** O registro fornece a banca e a origem interna, fora da saída controlada pela IA. */
export async function reconcileCapturedReactionTx(tx: Prisma.TransactionClient, input: { source: string; sourceExternalId?: string; bankrollId: string }) {
  const chatId = channelIdFromSource(input.source);
  if (!chatId || !input.sourceExternalId || !/^[1-9]\d*$/.test(input.sourceExternalId)) return false;
  const messageId = Number(input.sourceExternalId);
  if (!Number.isSafeInteger(messageId) || messageId > 2147483647) return false;
  const scope = await reactionScopeTx(tx, BigInt(chatId), messageId, input.bankrollId);
  if (!scope) return false;
  await applyLatestReactionTx(tx, scope);
  if (scope.bets.length === 0) return false;
  const states = await tx.bet.findMany({ where: { id: { in: scope.bets.map((bet) => bet.id) } }, select: { notTakenAt: true } });
  return states.every((state) => state.notTakenAt !== null);
}

const reactionBetSelect = {
  id: true, bankrollId: true, sourceExternalId: true, evento: true, selecao: true,
  status: true, settledAt: true, deletedAt: true, notTakenAt: true,
} satisfies Prisma.BetSelect;
type ReactionBet = Prisma.BetGetPayload<{ select: typeof reactionBetSelect }>;
type ReactionScope = { chatId: bigint; bankrollId: string; targetMessageId: number; bets: ReactionBet[] };

/** Chamado dentro da mesma transação do registro/decisão. Os vínculos sobrevivem
 * à purga do álbum, mas nunca transferem uma intenção para outra banca. */
async function reactionScopeTx(tx: Prisma.TransactionClient, chatId: bigint, messageId: number, requiredBankrollId?: string): Promise<ReactionScope | null> {
  const albums = await tx.telegramMediaAlbum.findMany({ where: { chatId: String(chatId), messageIds: { has: messageId } }, take: 2 });
  if (albums.length > 1) return null;
  const album = albums[0];
  const ids = new Set([messageId, ...(album?.messageIds ?? []), ...(album ? [album.winnerMessageId] : [])]);
  const links = await tx.telegramReactionState.findMany({ where: { chatId, OR: [{ messageId: { in: [...ids] } }, { targetMessageId: { in: [...ids] } }] } });
  for (const link of links) { ids.add(link.messageId); ids.add(link.targetMessageId); }
  const source = telegramChannelSource(chatId);
  const bets = await tx.bet.findMany({ where: { source, ...postExternalIdsWhere([...ids]) }, select: reactionBetSelect });
  const roots = new Set(bets.map(bet => Number(bet.sourceExternalId ? postIdOfExternalId(bet.sourceExternalId) : NaN)));
  if (roots.size > 1 || [...roots].some(id => !Number.isSafeInteger(id) || id <= 0)) return null;
  const targetMessageId = [...roots][0] ?? links[0]?.targetMessageId ?? album?.winnerMessageId ?? messageId;
  ids.add(targetMessageId);
  const banks = new Set([...bets.map(bet => bet.bankrollId), ...links.map(link => link.bankrollId)]);
  const financial = await tx.captureFinancialContext.findUnique({ where: { source_sourceExternalId: channelFinancialSource({ chatId, messageId: targetMessageId, ...(album ? { mediaGroupId: album.mediaGroupId } : {}) }) }, select: { bankrollId: true } });
  if (financial) banks.add(financial.bankrollId);
  if (requiredBankrollId) banks.add(requiredBankrollId);
  if (banks.size > 1) return null;
  const historicalBank = [...banks][0];
  const bank = await tx.bankroll.findFirst({ where: { ...(historicalBank ? { id: historicalBank } : { telegramChannelId: chatId }) }, select: { id: true } });
  if (!bank) return null;
  await tx.telegramReactionState.createMany({ data: [...ids].map(id => ({ chatId, messageId: id, bankrollId: bank.id, targetMessageId })), skipDuplicates: true });
  await tx.telegramReactionState.updateMany({ where: { chatId, bankrollId: bank.id, messageId: { in: [...ids] } }, data: { targetMessageId } });
  return { chatId, bankrollId: bank.id, targetMessageId, bets };
}

/** As fotos do post com reação recebida, da mais nova para a mais antiga. */
function reactionPhotosTx(tx: Prisma.TransactionClient, scope: ReactionScope) {
  return tx.telegramReactionState.findMany({ where: { chatId: scope.chatId, bankrollId: scope.bankrollId, targetMessageId: scope.targetMessageId, occurredAt: { not: null } }, orderBy: [{ occurredAt: "desc" }, { updateId: "desc" }] });
}

/**
 * Estado do post: cada foto do álbum guarda as próprias reações, e o ❤️ numa
 * foto não apaga o 👍 ou o 👎 de outra. 👎 em qualquer foto vence; sem ele,
 * vale o 👍 em qualquer foto.
 */
function postDecision(photos: ReadonlyArray<{ decision: string | null; actorUserId: string | null }>): ReactionDecision {
  const decisions = photos.filter((photo) => isAuthorizedReactionActor(photo.actorUserId)).map((photo) => photo.decision);
  if (decisions.includes("NOT_TAKEN")) return "NOT_TAKEN";
  return decisions.includes("TAKEN") ? "TAKEN" : "NEUTRAL";
}
