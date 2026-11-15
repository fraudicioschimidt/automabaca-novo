import type { Bot } from "grammy";
import { telegramReactionMetadata } from "@/src/domain/telegram-reaction";
import { createLogger } from "@/src/infra/logger";
import { enqueueTelegramJob } from "@/src/services/scheduling/enqueue-telegram-job";
import {
  emojisFromReactionCounts,
  hasThumbsDownReaction,
  thumbsDownPresentInReactionCounts,
} from "@/src/services/capture/channel/reactions";
import { dmMessageJob } from "./dm";
import { TelegramParseRetryError } from "@/src/services/capture/reading/retry-error";
import { isSupportedImageMime } from "./photo-download";
import { processTelegramJob, type NormalizedTelegramJob, type TelegramJobContext } from "./processing";

type ChannelMessage = {
  chat: { id: number | bigint };
  message_id: number;
  date: number;
  caption?: string;
};

const log = createLogger("telegram");

function postDateOf(msg: { date: number }): string {
  return new Date(msg.date * 1000).toISOString();
}

/**
 * Traduz o update do grammY no job normalizado e o processa na hora, dentro
 * do job de `telegram.updates` que trouxe o update. Erro sobe até a fila.
 */
export function registerTelegramLiveHandlers(bot: Bot, context: TelegramJobContext): void {
  const run = (job: NormalizedTelegramJob) => processTelegramJob(context, job).then(() => undefined);

  // Membro de álbum (foto, documento-imagem ou só legenda) é estagiado sem
  // download; o flush com debounce registra UMA aposta pelo álbum inteiro.
  const stageAlbumMember = (msg: ChannelMessage, mediaGroupId: string, fileId: string) => run({
    kind: "channel_photo_album",
    chatId: String(msg.chat.id),
    messageId: msg.message_id,
    caption: msg.caption ?? "",
    postDate: postDateOf(msg),
    fileId,
    mediaGroupId,
  });

  const capturePhoto = (msg: ChannelMessage, fileId: string) => run({
    kind: "channel_photo",
    chatId: String(msg.chat.id),
    messageId: msg.message_id,
    caption: msg.caption ?? "",
    postDate: postDateOf(msg),
    fileId,
  });

  const capturePost = (msg: ChannelMessage, text: string) => run({
    kind: "channel_post",
    chatId: String(msg.chat.id),
    messageId: msg.message_id,
    text,
    postDate: postDateOf(msg),
  });

  // Vídeo ou arquivo sem imagem: só a legenda interessa. Dentro de um álbum ele
  // entra no álbum; sozinho, viraria uma segunda aposta com outro `messageId`.
  const captureCaption = async (msg: ChannelMessage & { media_group_id?: string }) => {
    if (msg.media_group_id) return stageAlbumMember(msg, msg.media_group_id, "");
    const text = msg.caption?.trim();
    if (text) await capturePost(msg, text);
  };

  bot.on("channel_post:text", async (ctx) => {
    await capturePost(ctx.channelPost, ctx.channelPost.text);
  });

  bot.on("channel_post:photo", async (ctx) => {
    const msg = ctx.channelPost;
    const largest = msg.photo[msg.photo.length - 1];
    if (!largest) return;
    if (msg.media_group_id) {
      await stageAlbumMember(msg, msg.media_group_id, largest.file_id);
      return;
    }
    await capturePhoto(msg, largest.file_id);
  });

  bot.on("channel_post:document", async (ctx) => {
    const msg = ctx.channelPost;
    if (!isSupportedImageMime(msg.document.mime_type ?? "")) {
      await captureCaption(msg);
      return;
    }
    // Álbum enviado como ARQUIVO (imagem sem compressão) tem `media_group_id`
    // como o de fotos e passa pelo mesmo debounce: uma aposta, não uma por arquivo.
    if (msg.media_group_id) {
      await stageAlbumMember(msg, msg.media_group_id, msg.document.file_id);
      return;
    }
    await capturePhoto(msg, msg.document.file_id);
  });

  bot.on("channel_post:video", async (ctx) => {
    await captureCaption(ctx.channelPost);
  });

  bot.on("channel_post:animation", async (ctx) => {
    await captureCaption(ctx.channelPost);
  });

  // A edição leva as duas datas: a do post (referência do texto e da janela
  // de 30 min do rascunho) e a da edição (instante da entrada).
  const captureEdit = (msg: ChannelMessage & { edit_date: number }, text: string) => run({
    kind: "edited_channel_post",
    chatId: String(msg.chat.id),
    messageId: msg.message_id,
    text,
    postDate: postDateOf(msg),
    editDate: new Date(msg.edit_date * 1000).toISOString(),
  });

  bot.on("edited_channel_post:text", async (ctx) => {
    await captureEdit(ctx.editedChannelPost, ctx.editedChannelPost.text);
  });

  // Legenda de foto editada: o rascunho só se completa relendo a imagem.
  bot.on("edited_channel_post:caption", async (ctx) => {
    const msg = ctx.editedChannelPost;
    const caption = msg.caption ?? "";
    if (!caption.trim()) return;
    const imageFileId = msg.photo?.at(-1)?.file_id
      ?? (msg.document && isSupportedImageMime(msg.document.mime_type ?? "") ? msg.document.file_id : undefined);
    if (!imageFileId) {
      await captureEdit(msg, caption);
      return;
    }
    await run({
      kind: "edited_channel_photo",
      chatId: String(msg.chat.id),
      messageId: msg.message_id,
      caption,
      postDate: postDateOf(msg),
      editDate: new Date(msg.edit_date * 1000).toISOString(),
      fileId: imageFileId,
      ...(msg.media_group_id ? { mediaGroupId: msg.media_group_id } : {}),
    });
  });

  bot.on("message_reaction", async (ctx) => {
    const reaction = ctx.messageReaction;
    const emojis = reaction.new_reaction.flatMap((item) => item.type === "emoji" ? [item.emoji] : []);
    await run({
      kind: "reaction",
      ...(reaction.user ? { actorUserId: String(reaction.user.id) } : {}),
      ...telegramReactionMetadata(reaction.date, ctx.update?.update_id),
      chatId: String(reaction.chat.id),
      messageId: reaction.message_id,
      emojis,
      thumbsDownPresent: hasThumbsDownReaction(emojis),
    });
  });

  // Reação no canal chega anônima, como contagem: o 👎 presente é do dono.
  bot.on("message_reaction_count", async (ctx) => {
    const reaction = ctx.messageReactionCount;
    await run({
      kind: "reaction",
      ...telegramReactionMetadata(reaction.date, ctx.update?.update_id),
      chatId: String(reaction.chat.id),
      messageId: reaction.message_id,
      emojis: emojisFromReactionCounts(reaction.reactions),
      thumbsDownPresent: thumbsDownPresentInReactionCounts(reaction.reactions),
    });
  });

  // DM: a extração fora do ar avisa o dono uma vez e deixa a mesma mensagem
  // na fila, atrás deste job, com retry próprio até a dead-letter.
  bot.on("message", async (ctx, next) => {
    if (ctx.chat.type !== "private") return next();
    const job = dmMessageJob(ctx);
    if (!job) return;
    if ("reply" in job) {
      // É só a orientação ao dono: a falha ao enviar não repete o update até a dead-letter.
      await ctx.reply(job.reply, { reply_parameters: { message_id: ctx.message.message_id } })
        .catch((err: unknown) => log.warn({ err }, "falha ao responder arquivo da DM que a leitura não abre"));
      return;
    }
    try {
      await run(job);
    } catch (error) {
      if (!(error instanceof TelegramParseRetryError)) throw error;
      await enqueueTelegramJob(context.boss, job);
      await ctx.reply(
        "⏳ A extração está temporariamente indisponível. Vou tentar esta mesma mensagem novamente.",
        { reply_parameters: { message_id: job.messageId } },
      );
    }
  });
}
