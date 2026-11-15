import { z } from "zod";
import { mediaAlbumFlushJobSchema, telegramJobSchema } from "@/src/domain/telegram-job";
import { prisma } from "@/src/infra/prisma";
import { scrubSecrets } from "@/src/infra/redaction";
import { telegramPostLink } from "@/src/domain/telegram-source";

/*
 * O post do Telegram por trás de uma tarefa morta das filas `telegram.*`, lido
 * do payload do job, para o dono achar a mensagem e registrar a aposta à mão.
 * De conversa privada (DM) sai só o número da mensagem: nome, username e texto
 * da conversa não entram em aviso nem em ação.
 */

export type DeadLetterTelegramPost = {
  /** Canal de origem; null em DM. */
  channelId: string | null;
  messageId: number | null;
  mediaGroupId: string | null;
  /** Começo do texto ou da legenda do post de canal. */
  excerpt: string | null;
  /** Banca vinculada ao canal, quando existe. */
  bankroll: string | null;
};

const EXCERPT_CHARS = 140;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

function excerptOf(raw: string): string | null {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  const cut = compact.length > EXCERPT_CHARS ? `${compact.slice(0, EXCERPT_CHARS - 1)}…` : compact;
  return scrubSecrets(cut);
}

function messageId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Update cru do Telegram, como o job `telegram_update` o guarda. */
function postFromUpdate(update: Record<string, unknown>): Omit<DeadLetterTelegramPost, "bankroll"> | null {
  const message = asRecord(update.channel_post) ?? asRecord(update.edited_channel_post)
    ?? asRecord(update.message) ?? asRecord(update.edited_message)
    ?? asRecord(update.message_reaction) ?? asRecord(update.message_reaction_count);
  const chat = asRecord(message?.chat);
  if (!message || !chat) return null;
  const channel = chat.type === "channel";
  return {
    channelId: channel && (typeof chat.id === "number" || typeof chat.id === "string") ? String(chat.id) : null,
    messageId: messageId(message.message_id),
    mediaGroupId: typeof message.media_group_id === "string" ? message.media_group_id : null,
    excerpt: channel ? excerptOf(text(message.text) || text(message.caption)) : null,
  };
}

const deadLetterPayloadSchema = z.union([telegramJobSchema, mediaAlbumFlushJobSchema]);

/** O post por trás do payload de qualquer fila `telegram.*`; fora do contrato, nada. */
function telegramPostFromPayload(data: unknown): Omit<DeadLetterTelegramPost, "bankroll"> | null {
  const parsed = deadLetterPayloadSchema.safeParse(data);
  if (!parsed.success) return null;
  const job = parsed.data;
  switch (job.kind) {
    case "telegram_update":
      return postFromUpdate(job.update);
    case "media_album_flush":
      return { channelId: job.chatId, messageId: null, mediaGroupId: job.mediaGroupId, excerpt: null };
    case "dm_message":
      return { channelId: null, messageId: job.messageId, mediaGroupId: null, excerpt: null };
    default:
      return {
        channelId: job.chatId,
        messageId: job.messageId,
        mediaGroupId: "mediaGroupId" in job ? job.mediaGroupId ?? null : null,
        excerpt: excerptOf("text" in job ? job.text : "caption" in job ? job.caption : ""),
      };
  }
}

/** Posts das dead-letters `telegram.*`, com a banca de cada canal, por id do job. */
export async function telegramPostsOfDeadLetters(
  jobs: ReadonlyArray<{ id: string; queue: string; data: unknown }>,
): Promise<Map<string, DeadLetterTelegramPost>> {
  const posts = jobs.flatMap((job) => {
    const post = job.queue.startsWith("telegram.") ? telegramPostFromPayload(job.data) : null;
    return post ? [{ id: job.id, post }] : [];
  });
  const channelIds = [...new Set(posts.flatMap(({ post }) => post.channelId && /^-?\d+$/.test(post.channelId) ? [post.channelId] : []))];
  const bankrolls = channelIds.length === 0 ? [] : await prisma.bankroll.findMany({
    where: { telegramChannelId: { in: channelIds.map((id) => BigInt(id)) } },
    select: { nome: true, telegramChannelId: true },
  });
  const bankrollByChannel = new Map(bankrolls.map((row) => [String(row.telegramChannelId), row.nome]));
  return new Map(posts.map(({ id, post }) => [id, { ...post, bankroll: post.channelId ? bankrollByChannel.get(post.channelId) ?? null : null }]));
}

/** Onde está o post, em uma ou duas linhas, para aviso e ação. */
export function describeTelegramPost(post: DeadLetterTelegramPost): string {
  if (!post.channelId) {
    return post.messageId === null ? "Mensagem da conversa com o bot" : `Mensagem ${post.messageId} da conversa com o bot`;
  }
  const where = post.bankroll ? `Tipster ${post.bankroll}` : "Canal sem tipster vinculado";
  const item = post.messageId !== null ? `mensagem ${post.messageId}`
    : post.mediaGroupId ? `álbum ${post.mediaGroupId}` : "post sem número";
  const link = post.messageId === null ? null : telegramPostLink(post.channelId, post.messageId);
  return `${where} · ${item} do canal ${post.channelId}${link ? ` (${link})` : ""}`
    + (post.excerpt ? `\n“${post.excerpt}”` : "");
}
