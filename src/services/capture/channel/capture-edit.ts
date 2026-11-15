import { telegramChannelSource } from "@/src/domain/telegram-source";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { findPostSourceUse } from "@/src/services/bets/register";
import { applyAlbumCaptionEdit, findAlbumWinnerMessageId } from "@/src/services/capture/channel/media-album";
import { handleChannelPost, type ChannelPost } from "@/src/services/capture/channel/capture-new";
import type { ChannelCaptureDeps } from "@/src/services/capture/channel/channel-bankroll";
import type { ChannelCaptureOutcome } from "@/src/services/capture/channel/register-post";

const log = createLogger("tg-channel");

/**
 * Edição de post do canal. O dono pega a aposta na hora em que o post chega,
 * então o que foi capturado vale: edição de post que já virou aposta é
 * ignorada, seja odd, stake, seleção ou resultado. Só o rascunho que ainda não
 * virou aposta se completa, e só na janela de `DRAFT_EDIT_WINDOW_MS` e antes do
 * jogo; o instante da entrada passa a ser o da edição.
 */
export const DRAFT_EDIT_WINDOW_MS = 30 * 60_000;

type EditedPost = { chatId: bigint; messageId: number; postDate: Date; editDate?: Date; mediaGroupId?: string };

function ignoreEdit(post: EditedPost, reason: string): ChannelCaptureOutcome {
  log.info(
    { eventCode: LOG_EVENTS.TELEGRAM_EDIT_IGNORED, chatId: String(post.chatId), messageId: post.messageId, reason },
    "edição de post ignorada",
  );
  return { kind: "ignored", reason };
}

/**
 * O que a edição ainda pode fazer: nada (post já capturado, álbum que a
 * captura ainda vai ler, fora da janela) ou completar o rascunho.
 */
async function draftEditVerdict(post: EditedPost, caption: string): Promise<ChannelCaptureOutcome | null> {
  const source = telegramChannelSource(post.chatId);
  if (await findPostSourceUse(source, String(post.messageId))) return ignoreEdit(post, "post_ja_capturado");
  // A legenda do álbum também é um rascunho: validar antes de persistir,
  // pois o flush registra o conteúdo guardado sem passar por este handler.
  if (!post.editDate) return ignoreEdit(post, "edicao_sem_data");
  const elapsed = post.editDate.getTime() - post.postDate.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > DRAFT_EDIT_WINDOW_MS) {
    return ignoreEdit(post, "edicao_fora_da_janela");
  }
  const album = await applyAlbumCaptionEdit({ chatId: String(post.chatId), messageId: post.messageId, caption, editDate: post.editDate });
  // Álbum ainda aberto: a legenda nova entra na candidatura e o flush lê.
  if (album === "open") return { kind: "skipped", reason: "album_em_captura" };
  if (album === "done") {
    const winner = await findAlbumWinnerMessageId(post.chatId, post.messageId);
    if (winner !== null && winner !== post.messageId && await findPostSourceUse(source, String(winner))) {
      return ignoreEdit(post, "post_ja_capturado");
    }
  }
  return null;
}

/** Texto (ou legenda sem imagem) editado. */
export async function handleEditedChannelPost(
  post: ChannelPost,
  deps: ChannelCaptureDeps = {},
): Promise<ChannelCaptureOutcome> {
  return (await draftEditVerdict(post, post.text)) ?? handleChannelPost(post, { deps });
}

export type EditedChannelPhoto = EditedPost & { caption: string; fileId: string };

/**
 * Foto com a legenda editada: o rascunho se completa relendo a imagem com a
 * legenda nova, na hora, com a data da edição como entrada.
 */
export async function handleEditedChannelPhoto(
  post: EditedChannelPhoto,
  capturePhoto: () => Promise<ChannelCaptureOutcome>,
): Promise<ChannelCaptureOutcome> {
  return (await draftEditVerdict(post, post.caption)) ?? capturePhoto();
}
