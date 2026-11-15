import { z } from "zod";
import type { ParsedBetPost } from "@/src/domain/bet-capture";
import { parseStoredLegs, type BetLegsTicket } from "@/src/domain/bet-legs";
import { playerPropInputSchema } from "@/src/domain/settlement/player-prop-terms";
import { prisma } from "@/src/infra/prisma";

const DM_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const storedBetSchema = z.object({
  evento: z.string(),
  esporte: z.string(),
  competicao: z.string(),
  pais: z.string(),
  mercado: z.string(),
  selecao: z.string(),
  odds: z.number().finite(),
  stake: z.number().finite(),
  data: z.string().datetime().nullable(),
  kickoffDateOnly: z.boolean().optional(),
  casaDeAposta: z.string(),
  /** O placar da entrada ao vivo que a prévia mostrou: sem ele, o handicap liquidaria pelo jogo inteiro. */
  liveScoreHome: z.number().int().nonnegative().optional(),
  liveScoreAway: z.number().int().nonnegative().optional(),
  liveScoreEvidence: z.string().optional(),
  /** Prop de jogador e pernas da múltipla: fazem parte da aposta que o dono confirmou. */
  playerProp: playerPropInputSchema.optional(),
  legs: z.custom<BetLegsTicket>((value) => parseStoredLegs(value) !== null).optional(),
});

export type TelegramDmDraftSnapshot = {
  bet: ParsedBetPost;
  caption: string;
  imageFileId: string | null;
  postDate: Date;
};

export function serializeDraftBet(bet: ParsedBetPost): z.input<typeof storedBetSchema> {
  return { ...bet, data: bet.data?.toISOString() ?? null };
}

function deserializeBet(value: unknown): ParsedBetPost {
  const parsed = storedBetSchema.parse(value);
  return { ...parsed, data: parsed.data ? new Date(parsed.data) : null };
}

/**
 * A prévia da DM guarda a aposta que o dono viu, com o placar da entrada, a
 * prop e as pernas; do esporte, só o nome, e a decisão sai no registro, pela
 * legenda. O conserto de captura precisa também da proveniência do esporte:
 * guarda a aposta inteira.
 */
export const fullDraftBetSchema = storedBetSchema.passthrough();

export function deserializeFullDraftBet(value: z.infer<typeof fullDraftBetSchema>): ParsedBetPost {
  return { ...(value as unknown as ParsedBetPost), data: value.data ? new Date(value.data) : null };
}

export async function saveTelegramDmDraft(params: {
  chatId: string;
  messageId: number;
  bet: ParsedBetPost;
  caption: string;
  imageFileId?: string | null;
  postDate: Date;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const data = {
    parsedBet: serializeDraftBet(params.bet),
    caption: params.caption,
    imageFileId: params.imageFileId ?? null,
    postDate: params.postDate,
    expiresAt: new Date(now.getTime() + DM_DRAFT_TTL_MS),
  };
  await prisma.telegramDmDraft.upsert({
    where: { chatId_messageId: { chatId: params.chatId, messageId: params.messageId } },
    create: { chatId: params.chatId, messageId: params.messageId, ...data },
    update: data,
  });
}

export async function loadTelegramDmDraft(params: {
  chatId: string;
  messageId: number;
  now?: Date;
}): Promise<TelegramDmDraftSnapshot | null> {
  const now = params.now ?? new Date();
  const row = await prisma.telegramDmDraft.findUnique({
    where: { chatId_messageId: { chatId: params.chatId, messageId: params.messageId } },
  });
  if (!row || row.expiresAt <= now) return null;
  return {
    bet: deserializeBet(row.parsedBet),
    caption: row.caption,
    imageFileId: row.imageFileId,
    postDate: row.postDate,
  };
}

/** Remove a prévia quando o operador cancela explicitamente o fluxo. */
export async function deleteTelegramDmDraft(params: {
  chatId: string;
  messageId: number;
}): Promise<boolean> {
  const result = await prisma.telegramDmDraft.deleteMany({
    where: { chatId: params.chatId, messageId: params.messageId },
  });
  return result.count > 0;
}
