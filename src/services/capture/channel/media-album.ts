import { z } from "zod";
import { captureChannelFinancialContext } from "@/src/services/capture/capture-financial-context";
import type { PgBoss } from "pg-boss";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { QUEUES } from "@/src/infra/queue-contract";
import { withCurrentCorrelation } from "@/src/infra/observability-context";
import type { MediaAlbumFlushJob } from "@/src/domain/telegram-job";
import { splitEventoTeams } from "@/src/domain/text";
import { findPostSourceUse } from "@/src/services/bets/register";
import { telegramChannelSource } from "@/src/domain/telegram-source";

const log = createLogger("tg-media-album");

/**
 * Álbum do Telegram (`media_group_id`): as fotos são estagiadas no Postgres sem
 * download, e um flush com debounce lê só a vencedora e registra UMA aposta.
 * Depois do flush a linha vira o mapa `messageId irmão → vencedor` que as
 * reações e as edições de legenda consultam.
 */

const MEDIA_ALBUM_DEBOUNCE_SECONDS = 8;
/** Janela de STAGING: quanto tempo um álbum ainda aberto espera pelo flush. */
const ALBUM_TTL_MS = 30 * 60 * 1000;
/**
 * Retenção do álbum JÁ PROCESSADO: o 👎 numa foto irmã pode vir horas depois
 * do flush e precisa do mapa para achar a aposta. 30 dias alinha com a
 * retenção da evidência de captura, e a linha é pequena.
 */
const MEDIA_ALBUM_DONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MEDIA_ALBUM_FLUSH_MAX_DEFERRALS = 3;

type MediaAlbumPhoto = {
  messageId: number;
  /** Vazio = membro sem imagem legível (vídeo, arquivo que não é imagem): só doa a legenda. */
  fileId: string;
  caption: string;
};

type StageResult = "scheduled" | "updated" | "redundant";
type MediaAlbumFlushScheduleResult = "scheduled" | "rescheduled" | "already_scheduled";

const photosSchema = z.array(z.object({ messageId: z.number().int(), fileId: z.string(), caption: z.string() }));
function mergePhotos(raw: unknown, photo: MediaAlbumPhoto): MediaAlbumPhoto[] {
  const photos = photosSchema.parse(raw ?? []);
  return [...photos.filter((p) => p.messageId !== photo.messageId), photo].sort((a, b) => a.messageId - b.messageId);
}

function hasCaption(caption: string): boolean {
  return caption.trim().length > 0;
}

/** Prioriza legenda que contém os campos de uma aposta, não texto promocional longo. */
function albumCaptionScore(caption: string): number {
  const text = caption.trim();
  if (!text) return 0;
  let score = 1;
  if (splitEventoTeams(text)) score += 8;
  if (/\b(?:entrada|aposta|sele[cç][aã]o|pick|tip)\s*[:\-]/i.test(text)) score += 4;
  if (/\b(?:mercado|market|tipo)\s*[:\-]/i.test(text)) score += 3;
  if (/(?:@|\bodd?s?\s*[:\-]?)\s*\d[\d.,]*/i.test(text)) score += 4;
  if (/\b(?:stake|unidade?s?|valor)\s*[:\-]?\s*\d[\d.,]*\s*u?\b/i.test(text)) score += 4;
  if (/\b\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?(?:\s+(?:[àa]s?\s*)?\d{1,2}:\d{2})?/i.test(text)) score += 2;
  return score;
}

function mergeIds(existing: number[], messageId: number): number[] {
  if (existing.includes(messageId)) return existing;
  return [...existing, messageId].sort((a, b) => a - b);
}

export async function stageMediaAlbumPhoto(params: {
  mediaGroupId: string;
  chatId: string;
  photo: MediaAlbumPhoto;
  postDate: Date;
}): Promise<StageResult> {
  const { mediaGroupId, chatId, photo, postDate } = params;
  await captureChannelFinancialContext({ chatId: BigInt(chatId), messageId: photo.messageId, mediaGroupId });
  const expiresAt = new Date(Date.now() + ALBUM_TTL_MS);

  try {
    await prisma.telegramMediaAlbum.create({
      data: {
        mediaGroupId,
        chatId,
        status: "open",
        winnerMessageId: photo.messageId,
        winnerFileId: photo.fileId,
        winnerCaption: photo.caption,
        messageIds: [photo.messageId],
        photos: [photo],
        postDate,
        expiresAt,
      },
    });
    return "scheduled";
  } catch (err) {
    // Só unique → álbum já existe; demais erros falham alto.
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code !== "P2002") throw err;
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await prisma.telegramMediaAlbum.findUnique({
      where: { mediaGroupId },
    });
    if (!row) return "redundant";

    if (row.status !== "open") {
      // Álbum já concluído: se ainda está dentro do TTL, registra messageId de fotos irmãs
      // tardias para que reações futuras encontrem a aposta capturada.
      if (row.status === "done" && row.expiresAt > new Date()) {
        const messageIds = mergeIds(row.messageIds, photo.messageId);
        if (messageIds.length > row.messageIds.length) {
          const res = await prisma.telegramMediaAlbum.updateMany({
            where: { mediaGroupId, version: row.version, status: "done" },
            data: { messageIds, photos: mergePhotos(row.photos, photo), version: { increment: 1 } },
          });
          if (res.count === 0) {
            continue;
          }
        }
      }
      return "redundant";
    }

    const messageIds = mergeIds(row.messageIds, photo.messageId);
    // Promove pela informação estruturada; tamanho só desempata legendas equivalentes.
    const newCap = hasCaption(photo.caption);
    const oldCap = hasCaption(row.winnerCaption);
    const newScore = albumCaptionScore(photo.caption);
    const oldScore = albumCaptionScore(row.winnerCaption);
    const captionWins =
      newCap &&
      (!oldCap || newScore > oldScore || (
        newScore === oldScore && photo.caption.trim().length > row.winnerCaption.trim().length
      ));
    // Imagem e legenda da candidatura andam separadas: o membro sem imagem só
    // doa a legenda, e a primeira foto ocupa a vaga de imagem que estava vazia.
    const hasImage = photo.fileId !== "";
    const takesImage = hasImage && (row.winnerFileId === "" || captionWins);
    const promote = captionWins || takesImage;
    const idsGrew = messageIds.length > row.messageIds.length;

    if (!promote && !idsGrew) return "redundant";

    const updated = await prisma.telegramMediaAlbum.updateMany({
      where: { mediaGroupId, version: row.version, status: "open" },
      data: {
        ...(takesImage ? { winnerMessageId: photo.messageId, winnerFileId: photo.fileId } : {}),
        ...(captionWins ? { winnerCaption: photo.caption, captionEditedAt: null } : {}),
        messageIds,
        photos: mergePhotos(row.photos, photo),
        expiresAt,
        version: { increment: 1 },
      },
    });

    if (updated.count === 0) continue;

    if (promote) {
      log.info(
        { mediaGroupId, messageId: photo.messageId },
        "álbum: foto com legenda assumiu a candidatura",
      );
      return "updated";
    }
    return "redundant";
  }

  return "redundant";
}

export async function readOpenAlbumWinner(
  mediaGroupId: string,
): Promise<(MediaAlbumPhoto & { postDate: Date; editDate?: Date; chatId: string; version: number; photos: MediaAlbumPhoto[] }) | null> {
  const row = await prisma.telegramMediaAlbum.findUnique({
    where: { mediaGroupId },
  });
  if (!row || row.status !== "open") return null;
  return {
    messageId: row.winnerMessageId,
    fileId: row.winnerFileId,
    caption: row.winnerCaption,
    postDate: row.postDate,
    ...(row.captionEditedAt ? { editDate: row.captionEditedAt } : {}),
    chatId: row.chatId,
    version: row.version,
    photos: photosSchema.parse(row.photos ?? []),
  };
}

/**
 * A foto (e a legenda) que o flush leu ainda é a vencedora do álbum aberto?
 *
 * Conferido DEPOIS do OCR e ANTES de gravar a aposta: se outra foto virou
 * vencedora durante o OCR (legenda que chega tarde), gravar agora deixaria duas
 * apostas com `messageId` diferentes para o mesmo álbum. Compara a vencedora,
 * não a `version`, que também sobe quando só chega o id de uma foto irmã.
 */
export async function isOpenAlbumWinner(params: {
  mediaGroupId: string;
  messageId: number;
  caption: string;
  editDate?: Date;
}): Promise<boolean> {
  const row = await prisma.telegramMediaAlbum.findUnique({
    where: { mediaGroupId: params.mediaGroupId },
    select: { status: true, winnerMessageId: true, winnerCaption: true, captionEditedAt: true },
  });
  return row?.status === "open"
    && row.winnerMessageId === params.messageId
    && row.winnerCaption === params.caption
    && (row.captionEditedAt?.getTime() ?? null) === (params.editDate?.getTime() ?? null);
}

export async function scheduleMediaAlbumFlush(
  boss: PgBoss,
  params: { chatId: string; mediaGroupId: string },
  options?: { sliding?: boolean },
): Promise<MediaAlbumFlushScheduleResult> {
  const data: MediaAlbumFlushJob = {
    kind: "media_album_flush",
    chatId: params.chatId,
    mediaGroupId: params.mediaGroupId,
  };
  const singletonKey = `album-flush:${params.mediaGroupId}`;
  if (options?.sliding) {
    const updated = await boss.update(QUEUES.telegramDeferred, withCurrentCorrelation(data), {
      startAfter: MEDIA_ALBUM_DEBOUNCE_SECONDS,
      singletonKey,
    });
    if (updated.updated > 0) return "rescheduled";
  }
  const jobId = await boss.send(QUEUES.telegramDeferred, withCurrentCorrelation(data), {
    startAfter: MEDIA_ALBUM_DEBOUNCE_SECONDS,
    singletonKey,
  });
  return jobId ? "scheduled" : "already_scheduled";
}

export async function completeMediaAlbum(
  mediaGroupId: string,
  options?: { expectedVersion?: number },
): Promise<boolean> {
  const updated = await prisma.telegramMediaAlbum.updateMany({
    where: {
      mediaGroupId,
      status: "open",
      ...(options?.expectedVersion !== undefined ? { version: options.expectedVersion } : {}),
    },
    data: {
      status: "done",
      expiresAt: new Date(Date.now() + MEDIA_ALBUM_DONE_TTL_MS),
      version: { increment: 1 },
    },
  });
  return updated.count > 0;
}

/**
 * Todas as mensagens do álbum. A aposta fica na foto que venceu, e a vencedora
 * pode trocar depois de a aposta ser gravada: quem pergunta "o álbum já virou
 * aposta?" procura em todas.
 */
export async function albumMessageIds(mediaGroupId: string): Promise<number[]> {
  const row = await prisma.telegramMediaAlbum.findUnique({
    where: { mediaGroupId },
    select: { messageIds: true, winnerMessageId: true },
  });
  return row ? [...new Set([...row.messageIds, row.winnerMessageId])] : [];
}

/**
 * A aposta de um álbum já fechado, em qualquer mensagem dele: o retry do
 * flush cujo enfileiramento falhou depois de fechar o álbum a devolve como
 * reentrega, e a fila que faltou é refeita.
 */
export async function findClosedAlbumBetId(mediaGroupId: string): Promise<string | null> {
  const row = await prisma.telegramMediaAlbum.findUnique({
    where: { mediaGroupId },
    select: { status: true, chatId: true, messageIds: true, winnerMessageId: true },
  });
  if (!row || row.status === "open") return null;
  const used = await findPostSourceUse(telegramChannelSource(row.chatId),
    [...new Set([...row.messageIds, row.winnerMessageId])].map(String));
  return used?.kind === "bet" ? used.betId : null;
}

/** Foto vencedora do álbum de uma mensagem (é nela que a aposta do álbum fica). */
export async function findAlbumWinnerMessageId(chatId: bigint, messageId: number): Promise<number | null> {
  const row = await prisma.telegramMediaAlbum.findFirst({
    where: { chatId: String(chatId), messageIds: { has: messageId } },
    select: { winnerMessageId: true },
    orderBy: { updatedAt: "desc" },
  });
  return row?.winnerMessageId ?? null;
}

/**
 * Legenda editada num membro de álbum. Aberto: a nova legenda entra na
 * candidatura (a do próprio vencedor sempre; a de outro membro, se for
 * melhor). Concluído: a edição é de um álbum que já virou aposta. Em ambos os
 * casos o chamador NÃO deve tratá-la como post novo, ou o álbum ganharia uma
 * segunda aposta com outro `messageId`.
 */
export async function applyAlbumCaptionEdit(params: {
  chatId: string;
  messageId: number;
  caption: string;
  editDate: Date;
}): Promise<"open" | "done" | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await prisma.telegramMediaAlbum.findFirst({
      where: { chatId: params.chatId, messageIds: { has: params.messageId }, expiresAt: { gt: new Date() } },
    });
    if (!row) return null;
    if (row.status !== "open") return "done";
    const photos = photosSchema.parse(row.photos ?? []).map((p) =>
      p.messageId === params.messageId ? { ...p, caption: params.caption } : p);
    const own = row.winnerMessageId === params.messageId;
    const better = albumCaptionScore(params.caption) > albumCaptionScore(row.winnerCaption);
    const updated = await prisma.telegramMediaAlbum.updateMany({
      where: { mediaGroupId: row.mediaGroupId, version: row.version, status: "open" },
      data: {
        photos,
        ...(own || better ? { winnerCaption: params.caption, captionEditedAt: params.editDate } : {}),
        version: { increment: 1 },
      },
    });
    if (updated.count > 0) return "open";
  }
  return "open";
}
