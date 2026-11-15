import type { Api } from "grammy";
import type { PgBoss } from "pg-boss";
import { telegramJobSubject, type TelegramJob, type TelegramJobOf } from "@/src/domain/telegram-job";
import type { ReactionEvent } from "@/src/domain/telegram-reaction";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { privacyHash } from "@/src/infra/privacy";
import { enqueueAfterCapture, ensureCaptureFollowups, type CapturedBet } from "@/src/services/scheduling/enqueue-after-capture";
import { scheduleMediaAlbumFlush, stageMediaAlbumPhoto } from "@/src/services/capture/channel/media-album";
import { answerDmMessage } from "@/src/services/capture/dm";
import { type ChannelPost, handleChannelPhotoPost, handleChannelPost } from "@/src/services/capture/channel/capture-new";
import { handleEditedChannelPhoto, handleEditedChannelPost } from "@/src/services/capture/channel/capture-edit";
import type { ChannelCaptureDeps } from "@/src/services/capture/channel/channel-bankroll";
import { telegramChannelProfileLoader } from "./channel/channel-bankroll";
import { handleChannelReaction } from "@/src/services/capture/channel/reactions";
import { dmPhotoLoader } from "./dm";
import { downloadTelegramPhoto } from "./photo-download";

const log = createLogger("telegram");

/** Acesso de que um job do Telegram precisa fora do próprio payload. */
export type TelegramJobContext = { api: Api; boss: PgBoss; token: string };

/** Job já normalizado: o que o grammY tira de um update e o que as filas carregam. */
export type NormalizedTelegramJob = Exclude<TelegramJob, { kind: "telegram_update" }>;

/** O que as capturas devolvem e decide qual fila (enrich ou esporte) vem depois. */
export type CaptureOutcome = {
  kind?: string;
  reason?: string;
  betId?: string;
  registeredBets?: CapturedBet[];
  sportResolutionStatus?: "CONFIRMED" | "PENDING" | "CONFLICT";
  notTaken?: boolean;
};

export function toChannelPost(data: TelegramJobOf<"channel_post" | "edited_channel_post">): ChannelPost {
  return {
    chatId: BigInt(data.chatId),
    messageId: data.messageId,
    text: data.text,
    postDate: new Date(data.postDate),
    ...(data.editDate ? { editDate: new Date(data.editDate) } : {}),
  };
}

export function toReactionEvent(data: TelegramJobOf<"reaction">): ReactionEvent {
  return {
    chatId: BigInt(data.chatId),
    messageId: data.messageId,
    emojis: data.emojis,
    ...(data.actorUserId ? { actorUserId: data.actorUserId } : {}),
    thumbsDownPresent: data.thumbsDownPresent,
    occurredAt: data.occurredAt,
    updateId: data.updateId,
  };
}

/** Bot API da captura: a foto do post (lida só quando a captura precisa) e o perfil do canal novo. */
export function channelCaptureDeps(api: Api, token: string): ChannelCaptureDeps {
  return {
    loadImage: (fileId) => downloadTelegramPhoto(api, token, fileId),
    loadChannelProfile: telegramChannelProfileLoader(api),
  };
}

/** Sem o chat em claro: o hash basta para cruzar logs do mesmo canal. */
export function telegramLogContext(job: TelegramJob): {
  kind: string;
  chatIdHash?: string;
  messageId?: number;
  mediaGroupId?: string;
} {
  const subject = telegramJobSubject(job);
  return {
    kind: subject.kind,
    ...(subject.chatId !== undefined ? { chatIdHash: privacyHash(subject.chatId, "telegram-chat") } : {}),
    ...(subject.messageId !== undefined ? { messageId: subject.messageId } : {}),
    ...(subject.mediaGroupId ? { mediaGroupId: subject.mediaGroupId } : {}),
  };
}

/**
 * Roda um job do Telegram de ponta a ponta: a captura, o desfecho no log e a
 * fila que vem depois. Erro sobe: quem chama é o consumidor da fila, e o retry
 * nativo segura a chave do post até dar certo ou ir para a dead-letter.
 */
export async function processTelegramJob(
  context: TelegramJobContext,
  job: NormalizedTelegramJob,
): Promise<CaptureOutcome | void> {
  const outcome = await dispatchTelegramJob(context, job);
  await logAndScheduleFollowups(context.boss, telegramLogContext(job), outcome);
  return outcome;
}

/** Desfecho de qualquer captura (post, álbum, DM) e a fila seguinte. */
export async function logAndScheduleFollowups(
  boss: PgBoss,
  logContext: ReturnType<typeof telegramLogContext>,
  outcome: CaptureOutcome | void,
): Promise<void> {
  const bets = outcome?.registeredBets?.length ?? (outcome?.kind === "registered" ? 1 : 0);
  log.info({
    eventCode: LOG_EVENTS.TELEGRAM_UPDATE_COMPLETED,
    ...logContext,
    outcome: outcome?.kind ?? "done",
    ...(outcome?.reason ? { reason: outcome.reason } : {}),
    bets,
  }, "update do Telegram processado");
  if (outcome?.kind === "registered" && outcome.betId && !outcome.notTaken) {
    await enqueueAfterCapture(boss, outcome.registeredBets ?? [{
      betId: outcome.betId,
      sportResolutionStatus: outcome.sportResolutionStatus ?? "PENDING",
    }], "telegram-capture");
  } else if (outcome?.kind === "duplicate" && outcome.betId) {
    const restored = await ensureCaptureFollowups(boss, outcome.betId, "telegram-capture");
    if (restored > 0) log.warn({ ...logContext, restored }, "reentrega refez a fila que faltava depois da captura");
  }
}

function dispatchTelegramJob(context: TelegramJobContext, job: NormalizedTelegramJob): Promise<CaptureOutcome | void> {
  const deps = channelCaptureDeps(context.api, context.token);
  switch (job.kind) {
    case "dm_message":
      return answerDmMessage(job, {
        loadImage: dmPhotoLoader(context.api, context.token),
        reply: (text, other) => context.api.sendMessage(job.chatId, text, other),
      });
    case "channel_post":
      return handleChannelPost(toChannelPost(job), {
        deps, forcedByOperator: job.forcedByOperator === true, forcedByReaction: job.forcedByReaction === true,
      });
    case "edited_channel_post":
      return handleEditedChannelPost(toChannelPost(job), deps);
    case "channel_photo":
      return captureChannelPhoto(job, deps);
    case "edited_channel_photo":
      // O rascunho de foto se completa relendo a imagem, com a legenda nova e
      // a data da edição como entrada.
      return handleEditedChannelPhoto({
        chatId: BigInt(job.chatId),
        messageId: job.messageId,
        caption: job.caption,
        postDate: new Date(job.postDate),
        editDate: new Date(job.editDate),
        fileId: job.fileId,
        ...(job.mediaGroupId ? { mediaGroupId: job.mediaGroupId } : {}),
      }, () => captureChannelPhoto({
        kind: "channel_photo",
        chatId: job.chatId,
        messageId: job.messageId,
        caption: job.caption,
        postDate: job.postDate,
        editDate: job.editDate,
        fileId: job.fileId,
      }, deps));
    case "channel_photo_album":
      return stageAlbumPhoto(context.boss, job);
    case "reaction":
      return handleChannelReaction(toReactionEvent(job));
  }
}

function captureChannelPhoto(job: TelegramJobOf<"channel_photo">, deps: ChannelCaptureDeps) {
  return handleChannelPhotoPost({
    chatId: BigInt(job.chatId),
    messageId: job.messageId,
    caption: job.caption,
    postDate: new Date(job.postDate),
    ...(job.editDate ? { editDate: new Date(job.editDate) } : {}),
    mediaFileId: job.fileId,
    ...(job.forcedByOperator ? { forcedByOperator: true } : {}),
    ...(job.forcedByReaction ? { forcedByReaction: true } : {}),
  }, deps);
}

export async function stageAlbumPhoto(
  boss: PgBoss,
  data: TelegramJobOf<"channel_photo_album">,
): Promise<{ kind: "media_album_staged" }> {
  const staged = await stageMediaAlbumPhoto({
    mediaGroupId: data.mediaGroupId,
    chatId: data.chatId,
    photo: { messageId: data.messageId, fileId: data.fileId, caption: data.caption },
    postDate: new Date(data.postDate),
  });
  await scheduleMediaAlbumFlush(
    boss,
    { chatId: data.chatId, mediaGroupId: data.mediaGroupId },
    { sliding: staged === "updated" },
  );
  return { kind: "media_album_staged" };
}
