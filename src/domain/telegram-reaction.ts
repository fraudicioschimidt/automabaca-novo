export type ReactionEvent = {
  chatId: bigint;
  actorUserId?: string;
  messageId: number;
  emojis: string[];
  thumbsDownPresent?: boolean;
  /** Relógio e ordem originais do Telegram; nunca o instante da retentativa. */
  occurredAt?: string;
  updateId?: number;
};

export type ReactionOutcome =
  | { kind: "removed" | "neutralized"; betId: string }
  /** 👍 num post com aposta: a entrada foi marcada como pega (ou desmarcada, sem o 👍). */
  | { kind: "taken" | "untaken"; betId: string }
  | { kind: "ignored"; reason: string }
  | { kind: "remembered" }
  /** 👍 num post sem aposta: a captura forçada foi pedida (ou já tinha sido). */
  | { kind: "capture_requested"; messageId: number; result: "enfileirado" | "ja_na_fila" | "ja_pedido" }
  /** 👍 num post recusado por dado que o dono sabe: a pergunta foi para a DM. */
  | { kind: "fix_offered"; messageId: number; offer: string };

/** Estado do post: 👎 (`NOT_TAKEN`, vence o 👍), só 👍 (`TAKEN`) ou nenhum dos dois. */
export type ReactionDecision = "NOT_TAKEN" | "TAKEN" | "NEUTRAL";

export function telegramReactionMetadata(date?: number, updateId?: number): Pick<ReactionEvent, "occurredAt" | "updateId"> {
  if (typeof date !== "number" || !Number.isSafeInteger(date) || date <= 0 || !Number.isFinite(new Date(date * 1000).getTime())) return {};
  return { occurredAt: new Date(date * 1000).toISOString(), updateId };
}

export function reactionOrder(event: Pick<ReactionEvent, "occurredAt" | "updateId">) {
  const at = typeof event.occurredAt === "string" ? new Date(event.occurredAt) : null;
  if (!at || !Number.isFinite(at.getTime()) || at.getTime() <= 0 ||
    typeof event.updateId !== "number" || !Number.isSafeInteger(event.updateId) || event.updateId < 0) return null;
  return { occurredAt: at, updateId: BigInt(event.updateId) };
}
