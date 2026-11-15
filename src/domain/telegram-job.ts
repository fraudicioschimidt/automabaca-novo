import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalSha256 } from "@/src/domain/canonical-json";

/*
 * Contrato dos jobs das filas `telegram.*`: o que cada `kind` carrega e em
 * que ordem ele roda. A fila `telegram.updates` é `key_strict_fifo`: jobs com
 * a mesma chave de ordem rodam um de cada vez, na ordem de chegada, e a chave
 * fica presa enquanto um deles está em retry ou falhou.
 */

const chatId = z.string().regex(/^-?\d{1,20}$/);
const messageId = z.number().int().nonnegative();
const isoDate = z.iso.datetime();

const channelTextJob = z.object({
  kind: z.enum(["channel_post", "edited_channel_post"]),
  chatId,
  messageId,
  text: z.string(),
  postDate: isoDate,
  editDate: isoDate.optional(),
  /** "Capturar mesmo assim" do painel ou 👍 do dono: o post vai à leitura sem o filtro anti-ruído. */
  forcedByOperator: z.boolean().optional(),
  /** O pedido veio do 👍: recapitulação e jogo encerrado continuam recusados. */
  forcedByReaction: z.boolean().optional(),
});

const channelPhotoJob = z.object({
  kind: z.literal("channel_photo"),
  chatId,
  messageId,
  caption: z.string(),
  postDate: isoDate,
  /** Rascunho de foto completado na edição: a entrada é a edição. */
  editDate: isoDate.optional(),
  fileId: z.string().min(1),
  /** "Capturar mesmo assim" ou 👍: lê mesmo com o canal pausado. */
  forcedByOperator: z.boolean().optional(),
  forcedByReaction: z.boolean().optional(),
});

const editedChannelPhotoJob = z.object({
  kind: z.literal("edited_channel_photo"),
  chatId,
  messageId,
  caption: z.string(),
  postDate: isoDate,
  editDate: isoDate,
  fileId: z.string().min(1),
  mediaGroupId: z.string().min(1).optional(),
});

const channelPhotoAlbumJob = z.object({
  kind: z.literal("channel_photo_album"),
  chatId,
  messageId,
  caption: z.string(),
  postDate: isoDate,
  /** Vazio para o membro sem imagem legível (vídeo): só a legenda conta. */
  fileId: z.string(),
  mediaGroupId: z.string().min(1),
});

const reactionJob = z.object({
  kind: z.literal("reaction"),
  actorUserId: z.string().optional(),
  occurredAt: isoDate.optional(),
  updateId: z.number().int().nonnegative().optional(),
  chatId,
  messageId,
  emojis: z.array(z.string()),
  thumbsDownPresent: z.boolean().optional(),
});

const dmMessageJob = z.object({
  kind: z.literal("dm_message"),
  chatId,
  messageId,
  postDate: isoDate,
  text: z.string().optional(),
  caption: z.string().optional(),
  fileId: z.string().min(1).optional(),
});

/** O update do Telegram como chegou; o grammY decide o que ele é. */
const telegramUpdateJob = z.object({
  kind: z.literal("telegram_update"),
  update: z.looseObject({ update_id: z.number().int().nonnegative() }),
});

export const telegramJobSchema = z.discriminatedUnion("kind", [
  channelTextJob,
  channelPhotoJob,
  editedChannelPhotoJob,
  channelPhotoAlbumJob,
  reactionJob,
  dmMessageJob,
  telegramUpdateJob,
]);

export type TelegramJob = z.infer<typeof telegramJobSchema>;
export type TelegramJobOf<K extends TelegramJob["kind"]> = Extract<TelegramJob, { kind: K }>;

/** `telegram.deferred`: o flush do álbum, com espera intencional pela legenda. */
export const mediaAlbumFlushJobSchema = z.object({
  kind: z.literal("media_album_flush"),
  chatId,
  mediaGroupId: z.string().min(1),
});

export type MediaAlbumFlushJob = z.infer<typeof mediaAlbumFlushJobSchema>;

/** Payload fora do contrato: não adianta repetir, vai para a dead-letter com o motivo. */
export class InvalidTelegramJobError extends Error {
  constructor(readonly queue: string, issues: string) {
    super(`Job de ${queue} fora do contrato: ${issues}`);
    this.name = "InvalidTelegramJobError";
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues.slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
    .join("; ");
}

export function parseTelegramJob(queue: string, data: unknown): TelegramJob {
  const parsed = telegramJobSchema.safeParse(data);
  if (!parsed.success) throw new InvalidTelegramJobError(queue, describeIssues(parsed.error));
  return parsed.data;
}

export function parseMediaAlbumFlushJob(queue: string, data: unknown): MediaAlbumFlushJob {
  const parsed = mediaAlbumFlushJobSchema.safeParse(data);
  if (!parsed.success) throw new InvalidTelegramJobError(queue, describeIssues(parsed.error));
  return parsed.data;
}

// ── Roteamento na fila ordenada ─────────────────────────────────────────────

/** De que post (ou conversa) o job trata; base da chave de ordem e dos logs. */
export type TelegramJobSubject = {
  kind: string;
  chatId?: string;
  messageId?: number;
  mediaGroupId?: string;
  /** Conversa privada com o bot: a mensagem e o botão da prévia dividem a chave. */
  direct?: boolean;
};

type RawMessage = { chat?: { id?: unknown }; message_id?: unknown; media_group_id?: unknown; reply_to_message?: unknown };

function asMessage(value: unknown): RawMessage | null {
  return value && typeof value === "object" ? value as RawMessage : null;
}

function messageSubject(kind: string, message: RawMessage | null, direct = false): TelegramJobSubject | null {
  const chat = message?.chat?.id;
  const id = message?.message_id;
  if ((typeof chat !== "number" && typeof chat !== "string") || typeof id !== "number") return null;
  return {
    kind,
    chatId: String(chat),
    messageId: id,
    ...(typeof message?.media_group_id === "string" ? { mediaGroupId: message.media_group_id } : {}),
    ...(direct ? { direct } : {}),
  };
}

/**
 * Mensagem na DM. A resposta a uma pergunta do bot (o número do conserto)
 * entra na fila da pergunta, junto com os cliques nela.
 */
function dmMessageSubject(message: RawMessage | null): TelegramJobSubject | null {
  const subject = messageSubject("dm_message", message, true);
  const replied = messageSubject("dm_message", asMessage(message?.reply_to_message), true);
  return subject && replied ? { ...replied, kind: subject.kind } : subject;
}

function updateSubject(update: TelegramJobOf<"telegram_update">["update"]): TelegramJobSubject {
  const found = messageSubject("channel_post", asMessage(update.channel_post))
    ?? messageSubject("edited_channel_post", asMessage(update.edited_channel_post))
    ?? messageSubject("reaction", asMessage(update.message_reaction))
    ?? messageSubject("reaction", asMessage(update.message_reaction_count))
    ?? dmMessageSubject(asMessage(update.message));
  if (found) return found;
  // O botão da DM responde à prévia, que responde à mensagem original: a
  // escolha da banca entra na fila da mensagem, depois da própria extração.
  // O botão do conserto está na própria pergunta, que não responde a nada.
  const callback = asMessage(update.callback_query) as { message?: RawMessage } | null;
  return messageSubject("dm_callback", asMessage(callback?.message?.reply_to_message) ?? asMessage(callback?.message), true)
    ?? { kind: "update" };
}

export function telegramJobSubject(job: TelegramJob): TelegramJobSubject {
  switch (job.kind) {
    case "telegram_update":
      return updateSubject(job.update);
    case "dm_message":
      return { kind: job.kind, chatId: job.chatId, messageId: job.messageId, direct: true };
    case "edited_channel_photo":
    case "channel_photo_album":
      return { kind: job.kind, chatId: job.chatId, messageId: job.messageId,
        ...(job.mediaGroupId ? { mediaGroupId: job.mediaGroupId } : {}) };
    default:
      return { kind: job.kind, chatId: job.chatId, messageId: job.messageId };
  }
}

/** UUID estável a partir de uma chave: a mesma chave vira o mesmo id de job. */
export function uuidFromKey(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  // Versão 8 (formato livre) e variante RFC: o Postgres aceita como uuid.
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type TelegramJobRoute = {
  /** Chave de ordem da fila `key_strict_fifo`. */
  orderingKey: string;
  /** Grupo de concorrência: um chat não ocupa todos os consumidores. */
  group: string;
  /** Id determinístico: a reentrega do mesmo update não vira um segundo job. */
  id: string;
};

/**
 * Post e edição do mesmo post (ou do mesmo álbum) caem na mesma chave e rodam
 * em ordem; posts diferentes rodam em paralelo. Sem post identificável, a
 * chave é o próprio update.
 */
export function routeTelegramJob(job: TelegramJob): TelegramJobRoute {
  const subject = telegramJobSubject(job);
  const updateKey = job.kind === "telegram_update" ? `tg:update:${job.update.update_id}` : null;
  let orderingKey: string;
  if (subject.chatId !== undefined && subject.direct) {
    orderingKey = `tg:dm:${subject.chatId}:${subject.messageId}`;
  } else if (subject.chatId !== undefined && subject.mediaGroupId) {
    orderingKey = `tg:${subject.chatId}:album:${subject.mediaGroupId}`;
  } else if (subject.chatId !== undefined) {
    orderingKey = `tg:${subject.chatId}:msg:${subject.messageId}`;
  } else {
    orderingKey = updateKey ?? `tg:job:${canonicalSha256(job)}`;
  }
  const id = job.kind === "telegram_update"
    ? uuidFromKey(`telegram-update:${job.update.update_id}`)
    : uuidFromKey(`telegram-job:${canonicalSha256(job)}`);
  return { orderingKey, group: subject.chatId ?? orderingKey, id };
}
