import type { Api } from "grammy";
import { createLogger } from "@/src/infra/logger";
import { handleChannelPhotoPost, handleChannelPost } from "@/src/services/capture/channel/capture-new";
import type { MediaAlbumFlushJob } from "@/src/domain/telegram-job";
import {
  albumMessageIds,
  completeMediaAlbum,
  findClosedAlbumBetId,
  MEDIA_ALBUM_FLUSH_MAX_DEFERRALS,
  readOpenAlbumWinner,
} from "@/src/services/capture/channel/media-album";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { channelCaptureDeps, type CaptureOutcome } from "@/src/telegram/processing";

const log = createLogger("tg-deferred");

export class MediaAlbumCaptionPendingError extends Error {
  constructor(readonly mediaGroupId: string, readonly attempt: number) {
    super(`Álbum ${mediaGroupId} ainda aguarda legenda (tentativa ${attempt})`);
    this.name = "MediaAlbumCaptionPendingError";
  }
}

/**
 * Com a aposta gravada (ou já existente), o álbum fecha mesmo que outra foto
 * tenha chegado durante a leitura: relê-lo criaria a segunda aposta. Sem
 * aposta, a versão lida tem de ser a atual, ou o retry lê a legenda nova.
 */
function albumCompletion(outcome: { kind: string }, version: number): { expectedVersion?: number } {
  return outcome.kind === "registered" || outcome.kind === "duplicate" ? {} : { expectedVersion: version };
}

/**
 * Jobs agendados do Telegram (flush de álbum) — fila separada de
 * `telegram.updates` para não misturar a ordem dos posts com debounce
 * intencional.
 */
export async function processTelegramDeferredJob(
  data: MediaAlbumFlushJob,
  deps: { api: Api; token: string; retryCount: number },
): Promise<CaptureOutcome | void> {
  const winner = await readOpenAlbumWinner(data.mediaGroupId);
  if (!winner) {
    // Fechado com aposta: o retry de um flush que falhou ao enfileirar depois
    // de fechar o álbum a devolve como reentrega, e a fila que faltou volta.
    const betId = await findClosedAlbumBetId(data.mediaGroupId);
    if (betId) return { kind: "duplicate", betId };
    // Fechado sem aposta: outro flush já leu e deu o desfecho. Sem a linha, o
    // álbum expirou e foi apagado antes da leitura, e nada foi lido.
    if ((await albumMessageIds(data.mediaGroupId)).length > 0) {
      log.info({ mediaGroupId: data.mediaGroupId }, "flush de álbum já concluído — no-op");
      return undefined;
    }
    log.warn({ mediaGroupId: data.mediaGroupId, chatId: data.chatId }, "flush de álbum que expirou antes da leitura");
    await sendOperationalAlert(
      `🖼️ Álbum não lido · canal ${data.chatId}\nAs fotos do álbum expiraram antes da leitura, e nenhuma aposta foi registrada.\n` +
        "👉 Confira os posts recentes do canal e registre à mão se era aposta.",
      {
        source: "telegram.album-expired",
        key: data.mediaGroupId,
        title: "Álbum do Telegram expirou sem leitura",
        resource: "telegram-channel",
        resourceId: data.chatId,
        evidence: { mediaGroupId: data.mediaGroupId },
        autoResolve: false,
      },
    );
    return undefined;
  }

  const attempt = deps.retryCount;
  if (!winner.caption.trim() && attempt < MEDIA_ALBUM_FLUSH_MAX_DEFERRALS) {
    log.info(
      { mediaGroupId: data.mediaGroupId, attempt },
      "flush de álbum aguardando retry nativo para receber legenda",
    );
    throw new MediaAlbumCaptionPendingError(data.mediaGroupId, attempt);
  }

  // Álbum sem nenhuma imagem legível (só vídeo com legenda): a legenda é o post.
  if (winner.fileId === "") {
    if (!winner.caption.trim()) {
      await completeMediaAlbum(data.mediaGroupId, { expectedVersion: winner.version });
      return undefined;
    }
    const outcome = await handleChannelPost({
      chatId: BigInt(winner.chatId),
      messageId: winner.messageId,
      text: winner.caption,
      postDate: winner.postDate,
      ...(winner.editDate ? { editDate: winner.editDate } : {}),
      mediaGroupId: data.mediaGroupId,
    }, { deps: channelCaptureDeps(deps.api, deps.token) });
    const completed = await completeMediaAlbum(data.mediaGroupId, albumCompletion(outcome, winner.version));
    if (!completed) throw new Error(`álbum ${data.mediaGroupId} com versão concorrente no flush`);
    return outcome;
  }

  // Processa a foto vencedora PRIMEIRO. Se o worker falhar ou reiniciar durante o processamento,
  // o álbum permanece 'open' e o retry do pg-boss recupera a captura sem descarte silencioso da tip.
  const outcome = await handleChannelPhotoPost({
    mediaGroupId: data.mediaGroupId,
    chatId: BigInt(winner.chatId),
    messageId: winner.messageId,
    caption: winner.caption,
    postDate: winner.postDate,
    ...(winner.editDate ? { editDate: winner.editDate } : {}),
    mediaFileId: winner.fileId,
    albumFileIds: winner.photos.flatMap((photo) => photo.fileId === "" ? [] : [photo.fileId]),
  }, channelCaptureDeps(deps.api, deps.token));

  const completed = await completeMediaAlbum(data.mediaGroupId, albumCompletion(outcome, winner.version));
  if (!completed) {
    log.info(
      { mediaGroupId: data.mediaGroupId, expectedVersion: winner.version },
      "álbum com versão concorrente durante o flush — relançando para processar versão mais recente",
    );
    throw new Error(`álbum ${data.mediaGroupId} com versão concorrente no flush`);
  }

  return outcome;
}
