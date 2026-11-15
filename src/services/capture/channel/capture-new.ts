import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { preparePlayerCaptureBatch } from "@/src/domain/player-prop-capture";
import { reconcileImageCaptionSelection } from "@/src/domain/image-caption-selection";
import { telegramChannelSource, telegramPostLink } from "@/src/domain/telegram-source";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { captureChannelFinancialContext } from "@/src/services/capture/capture-financial-context";
import { findPostSourceUse } from "@/src/services/bets/register";
import { recordParseTelemetry } from "@/src/services/capture/parse-telemetry";
import { recordDiscardedChannelPost, type DiscardReason } from "@/src/services/capture/channel/channel-post-archive";
import { offerCaptureFix } from "@/src/services/capture/capture-fix";
import { sendOperatorNotification } from "@/src/services/ops/alerts";
import { recordCaptureReview, reportCaptureRefusal } from "@/src/services/capture/capture-review";
import { captureItemRef } from "@/src/services/capture/preparation/prepare-capture";
import { readBetPost, type CaptureVia, type ReadingResult } from "@/src/services/capture/reading/read-bet-post";
import type { ParsedBetPost } from "@/src/domain/bet-capture";
import type { PostImages } from "@/src/services/capture/preparation/parse-capture-handicap-retry";
import type { ChannelBankroll } from "@/src/services/bankrolls/lookup";
import { resolveChannelBankroll, type ChannelCaptureDeps } from "@/src/services/capture/channel/channel-bankroll";
import {
  registerCaptureBatch,
  refuseReadBet,
  registerParsedPost,
  type CapturePost,
  type ChannelCaptureOutcome,
} from "@/src/services/capture/channel/register-post";
import { TelegramParseRetryError } from "@/src/services/capture/reading/retry-error";
import { albumMessageIds, isOpenAlbumWinner } from "@/src/services/capture/channel/media-album";

/** O flush relança: pg-boss tenta de novo e lê a vencedora atual. */
export class MediaAlbumWinnerChangedError extends Error {
  constructor(readonly mediaGroupId: string, readonly messageId: number) {
    super(`Álbum ${mediaGroupId} trocou de vencedora durante o OCR da msg ${messageId}`);
    this.name = "MediaAlbumWinnerChangedError";
  }
}

const log = createLogger("tg-channel");

/** Dados de um post de texto já desacoplados do contexto do grammY. */
export type ChannelPost = {
  chatId: bigint;
  messageId: number;
  text: string;
  /** Data do post (fallback de kickoff quando o texto não traz data). */
  postDate: Date;
  /**
   * Só na edição: se a aposta nasce nela, é o instante da entrada; a data do
   * post segue como referência do texto.
   */
  editDate?: Date;
  /** Álbum sem imagem legível, cuja legenda é o post. */
  mediaGroupId?: string;
};

/**
 * O leitor por regra roda primeiro: é local e não custa nada. O filtro
 * anti-ruído só decide se o que ele não leu vale a cascata de LLM, e o post
 * que o filtro barra fica guardado para o painel. `forcedByOperator` é o
 * "Capturar mesmo assim": sem o filtro e sem esperar o edit do rascunho, a
 * cascata dá a resposta (aposta, revisão ou "não é aposta").
 */
export async function handleChannelPost(
  post: ChannelPost,
  options: { deps?: ChannelCaptureDeps; forcedByOperator?: boolean; forcedByReaction?: boolean } = {},
): Promise<ChannelCaptureOutcome> {
  const channel = await resolveChannelBankroll(post, { kind: "text", text: post.text }, options.deps ?? {});
  if ("outcome" in channel) return channel.outcome;
  const already = await alreadyCaptured(post);
  if (already) return already;
  // A configuração financeira fica presa ao post na chegada, antes da pausa e
  // dos descartes: é quando o dono pegou a aposta, e um retry ou o "Capturar
  // mesmo assim" relê com ela, não com a banca de agora.
  const bankroll = await captureChannelFinancialContext(post);
  if (!bankroll) return { kind: "skipped", reason: "canal_sem_bankroll" };
  const discard = async (reason: DiscardReason): Promise<ChannelCaptureOutcome> => {
    await recordDiscardedChannelPost({
      chatId: post.chatId, messageId: post.messageId, bankrollId: channel.bankroll.id, text: post.text,
      postDate: post.postDate, editDate: post.editDate, reason,
    });
    return { kind: "skipped", reason };
  };
  const forced = options.forcedByOperator === true;
  // O 👍 pula o filtro e a pausa, mas não a regra de recapitulação e de jogo
  // encerrado: só o painel, que mostra a idade do post, pula tudo.
  const byReaction = forced && options.forcedByReaction === true;
  // Canal pausado: o post fica guardado sem leitura nem LLM; o dono o traz de
  // volta pelo "Capturar mesmo assim" ou pelo 👍.
  if (!forced && channel.bankroll.capturePausedAt) return discard("canal_pausado");

  const capturePost = { ...post, forcedByOperator: forced && !byReaction, forcedByReaction: byReaction };
  const archiveFinishedGame = async (outcome: ChannelCaptureOutcome) =>
    outcome.kind === "skipped" && outcome.reason === "jogo_ja_terminado" ? discard("jogo_ja_terminado") : outcome;
  // A banca pode ter mudado entre a primeira leitura e um retry: a leitura
  // que vale usa a configuração presa ao post; a de agora só decide o ruído.
  const reading = await readBetPost(
    { kind: "text", text: post.text, ...(forced ? {} : { noiseFilter: { stakeSettings: channel.bankroll } }) },
    {
      now: post.postDate, stakeSettings: bankroll, itemRef: captureItemRef(post.chatId, post.messageId),
      gates: { recap: !forced || byReaction, draft: !forced }, askMissingNumbers: forced,
    },
  );

  switch (reading.kind) {
    case "skipped":
      return discard(reading.reason);
    case "bets": {
      await assertAlbumReadingCurrent(post, post.text);
      if (reading.via === "universal") {
        return archiveFinishedGame(await registerParsedPost(bankroll, capturePost, reading.bet, "universal", post.text));
      }
      const batch = preparePlayerCaptureBatch(reading.bets, post.text, false);
      if (!batch.ok) return refuseExtracted({ bankroll, post: capturePost, via: reading.via, reason: batch.reason, bet: reading.bet, caption: post.text });
      return archiveFinishedGame(await registerExtracted({
        bankroll, post: capturePost, bets: batch.bets, first: batch.bets[0] ?? reading.bet, via: reading.via, caption: post.text,
      }));
    }
    case "draft":
      return reportIncompleteReading(post, { bankroll, caption: post.text, via: "texto" }, reading);
    case "refused":
      return refuseUnreadPost({ bankroll, post: capturePost, caption: post.text, refusal: reading });
    case "not_bet":
    case "unavailable":
      break;
  }

  const notBet = reading.kind === "not_bet";
  log.warn(
    {
      eventCode: LOG_EVENTS.TELEGRAM_POST_UNPARSEABLE,
      chatId: String(post.chatId),
      messageId: post.messageId,
      bankrollSlug: bankroll.slug,
      missing: reading.missing,
      notBet,
      actionableHint: notBet
        ? "Post classificado como informativo (não é bilhete de aposta)."
        : "Post com padrão de aposta não reconhecido pela regra universal nem pela cascata LLM. Avalie adicionar regra de extração em src/services/capture/reading.",
    },
    "post não parseável (universal + cascata LLM)",
  );
  await recordParseTelemetry(post, "unparseable", {
    missing: reading.missing,
    via: "texto",
    reason: notBet ? "not_bet" : "llm_exhausted",
    ocrEvidence: reading.kind === "not_bet" ? reading.ocrEvidence : undefined,
  });
  if (reading.kind === "unavailable") {
    const exhausted = reading.refusalWhenExhausted;
    throw new TelegramParseRetryError("texto", post.messageId, exhausted ? {
      onExhausted: () => refuseUnreadPost({ bankroll, post: capturePost, caption: post.text, refusal: { reason: exhausted.reason, via: "ia" } }),
    } : undefined);
  }
  await discard("ia_nao_viu_aposta");
  await sendOperatorNotification([
    `❔ Post não virou aposta · ${bankroll.nome}`,
    `A leitura automática não achou ${reading.missing.join(", ")} no post ${post.messageId}` +
      ", e a IA entendeu que ele não é uma aposta.",
    "👉 Se era aposta, use \"Capturar mesmo assim\" em Monitoramento › Canais ou registre à mão.",
    telegramPostLink(post.chatId, post.messageId),
  ].filter(Boolean).join("\n"));
  return { kind: "unparseable", missing: reading.missing };
}

/** A leitura do flush só registra a legenda e o instante que continuam vigentes. */
async function assertAlbumReadingCurrent(
  post: Pick<ChannelPost, "mediaGroupId" | "messageId" | "editDate">,
  caption: string,
): Promise<void> {
  if (!post.mediaGroupId || await isOpenAlbumWinner({
    mediaGroupId: post.mediaGroupId, messageId: post.messageId, caption, editDate: post.editDate,
  })) return;
  log.info({ mediaGroupId: post.mediaGroupId, messageId: post.messageId },
    "álbum mudou durante a leitura — não grava; o flush relê");
  throw new MediaAlbumWinnerChangedError(post.mediaGroupId, post.messageId);
}

type ChannelPhotoPost = {
  mediaGroupId?: string;
  chatId: bigint;
  messageId: number;
  caption: string;
  postDate: Date;
  /** Rascunho de foto completado na edição (ver `capture-edit`). */
  editDate?: Date;
  /** A foto lida; só é baixada depois que banca, reentrega e rascunho deixam. */
  mediaFileId: string;
  /** Fotos do álbum com imagem, lidas juntas só pela banca que lê a stake da imagem. */
  albumFileIds?: string[];
  /** "Capturar mesmo assim" ou 👍 do dono: lê mesmo com o canal pausado ou a legenda de rascunho. */
  forcedByOperator?: boolean;
  /** O pedido veio do 👍: as regras de recapitulação e jogo encerrado continuam valendo. */
  forcedByReaction?: boolean;
};

/** Post com FOTO (print de slip) — extração direto por Gemini Vision. */
export async function handleChannelPhotoPost(
  post: ChannelPhotoPost,
  deps: ChannelCaptureDeps,
): Promise<ChannelCaptureOutcome> {
  const channel = await resolveChannelBankroll(post, { kind: "photo", text: post.caption, mediaFileId: post.mediaFileId }, deps);
  if ("outcome" in channel) return channel.outcome;
  const already = await alreadyCaptured(post);
  if (already) return already;
  const bankroll = await captureChannelFinancialContext(post);
  if (!bankroll) return { kind: "skipped", reason: "canal_sem_bankroll" };

  const forced = post.forcedByOperator === true;
  const byReaction = forced && post.forcedByReaction === true;
  const archivePhoto = async (reason: DiscardReason) => {
    await recordDiscardedChannelPost({
      chatId: post.chatId, messageId: post.messageId, bankrollId: bankroll.id, text: post.caption,
      postDate: post.postDate, editDate: post.editDate, reason, photo: { mediaFileId: post.mediaFileId },
    });
    return { kind: "skipped", reason } as const;
  };
  // Canal pausado: a foto fica guardada sem ser baixada nem lida.
  if (!forced && bankroll.capturePausedAt) return archivePhoto("canal_pausado");

  const capturePost = { ...post, forcedByOperator: forced && !byReaction };
  const loadImage = (fileId: string) => {
    if (!deps.loadImage) throw new Error("captura de foto sem acesso à Bot API para baixar a imagem");
    return deps.loadImage(fileId);
  };
  const reading = await readBetPost(
    { kind: "photo", caption: post.caption, fileId: post.mediaFileId, albumFileIds: post.albumFileIds, loadImage },
    {
      now: post.postDate, stakeSettings: bankroll, itemRef: captureItemRef(post.chatId, post.messageId),
      gates: { recap: !forced || byReaction, draft: !forced },
    },
  );

  switch (reading.kind) {
    case "skipped":
      // Guardada como os outros descartados: se o porteiro errou, o "Capturar mesmo assim" a traz de volta.
      await recordParseTelemetry(post, "unparseable", { via: "foto", reason: "not_bet", missing: [reading.reason] });
      return archivePhoto(reading.reason);
    case "refused":
      return refuseUnreadPost({ bankroll, post: capturePost, caption: post.caption, refusal: reading, mediaFileId: post.mediaFileId });
    case "draft":
      return reportIncompleteReading(post, { bankroll, caption: post.caption, via: "foto" }, reading);
    case "not_bet":
    case "unavailable": {
      const exhausted = reading.kind === "unavailable" ? reading.refusalWhenExhausted : undefined;
      const outcome = await reportUnreadablePhoto(post, bankroll.nome, reading, exhausted ? () => refuseUnreadPost({
        bankroll, post: capturePost, caption: post.caption, refusal: { reason: exhausted.reason, via: "ia" }, mediaFileId: post.mediaFileId,
      }) : undefined);
      if (reading.kind === "not_bet") await archivePhoto("ia_nao_viu_aposta");
      return outcome;
    }
    case "bets":
      break;
  }

  const refusal = { bankroll, post, via: reading.via, bet: reading.bet, caption: post.caption, mediaFileId: post.mediaFileId };
  // O leitor de bilhete único já concilia com a legenda; os de lote e de
  // jogador não, e a divergência é recusa: reler daria a mesma leitura.
  const selected = reconcileImageCaptionSelection(reading.bets, post.caption);
  if (!selected.ok) return refuseExtracted({ ...refusal, reason: selected.reason, missing: ["selecao"] });
  const batch = preparePlayerCaptureBatch(selected.bets, post.caption, bankroll.imageStakeAsUnits === true);
  if (!batch.ok) return refuseExtracted({ ...refusal, reason: batch.reason, missing: ["stake"] });
  await assertAlbumReadingCurrent(post, post.caption);
  return registerExtracted({
    bankroll,
    post: capturePost,
    bets: batch.bets,
    first: batch.bets[0] ?? reading.bet,
    via: reading.via,
    caption: post.caption,
    images: reading.pages,
    mediaFileId: post.mediaFileId,
    ...(reading.albumFileIds ? { mediaFileIds: reading.albumFileIds } : {}),
  });
}

/** Leitura que não passa no lote ou na conciliação com a legenda: recusa com aviso e pendência. */
async function refuseExtracted(params: {
  bankroll: ChannelBankroll; post: CapturePost; via: CaptureVia;
  reason: string; missing?: string[]; bet: ParsedBetPost; caption: string; mediaFileId?: string;
}): Promise<ChannelCaptureOutcome> {
  return refuseReadBet({ ...params, missing: params.missing ?? [params.reason], photo: params.mediaFileId !== undefined });
}

/**
 * A leitura terminou sem aposta a registrar: recusa com aviso e pendência,
 * sem relançar, porque reler repetiria a resposta. O post fica guardado para
 * o "Capturar mesmo assim", e a dúvida da leitura (`detail`) vai no aviso.
 * Grade sem marca traz a aposta lida e as opções que a DM pergunta ao dono.
 */
async function refuseUnreadPost(params: {
  bankroll: ChannelBankroll; post: CapturePost; caption: string; mediaFileId?: string;
  refusal: Pick<Extract<ReadingResult, { kind: "refused" }>, "reason" | "via" | "detail" | "bet" | "options">;
}): Promise<ChannelCaptureOutcome> {
  const { bankroll, post, caption, mediaFileId } = params;
  const { reason, via, detail, bet, options } = params.refusal;
  const photo = mediaFileId !== undefined;
  const missing = [reason];
  await reportCaptureRefusal({ post, bankroll, via, reason, missing, caption, mediaFileId, detail, evento: bet?.evento });
  await recordDiscardedChannelPost({
    chatId: post.chatId, messageId: post.messageId, bankrollId: bankroll.id, text: caption,
    postDate: post.postDate, editDate: post.editDate, reason: "captura_recusada",
    ...(photo ? { photo: { mediaFileId } } : {}),
    ...(bet && options ? { refusal: { reason, via, bet, options } } : {}),
  });
  if (bet && options) {
    await offerCaptureFix({ bankroll, post, bet, reason, via, caption, mediaFileId, options });
  }
  return { kind: "unparseable", missing };
}

/** Várias seleções ou prop de jogador vão pelo lote transacional; o resto é captura avulsa. */
function registerExtracted(params: {
  bankroll: ChannelBankroll;
  post: CapturePost;
  bets: ParsedBetPost[];
  first: ParsedBetPost;
  via: CaptureVia;
  caption: string;
  images?: PostImages;
  mediaFileId?: string;
  mediaFileIds?: string[];
}): Promise<ChannelCaptureOutcome> {
  const { bankroll, post, bets, via, caption } = params;
  if (bets.length > 1 || bets.some((bet) => buildPlayerPropTerms(bet))) {
    return registerCaptureBatch({
      bankroll, post, bets, via, caption,
      images: params.images, mediaFileId: params.mediaFileId, mediaFileIds: params.mediaFileIds,
    });
  }
  return registerParsedPost(bankroll, post, params.first, via, caption, params.images, params.mediaFileId);
}

/**
 * Leitura incompleta (falta stake/odd ou há revisão): espera a edição do
 * tipster ou a revisão. O rascunho fica guardado com os descartados: se a
 * edição não vier, o "Capturar mesmo assim" e o 👍 o acham.
 */
async function reportIncompleteReading(
  post: { chatId: bigint; messageId: number; postDate: Date; editDate?: Date; mediaFileId?: string },
  context: { bankroll: ChannelBankroll; caption: string; via: "texto" | "foto" },
  reading: Extract<ReadingResult, { kind: "draft" }>,
): Promise<ChannelCaptureOutcome> {
  const { review, missing } = reading;
  if (review) {
    await recordCaptureReview({
      chatId: post.chatId, messageId: post.messageId, postDate: post.postDate, editDate: post.editDate, caption: context.caption, mediaFileId: post.mediaFileId,
      bankroll: context.bankroll.nome, review,
    });
  } else {
    await recordDiscardedChannelPost({
      chatId: post.chatId, messageId: post.messageId, bankrollId: context.bankroll.id, text: context.caption,
      postDate: post.postDate, editDate: post.editDate, reason: "rascunho_incompleto",
      ...(post.mediaFileId ? { photo: { mediaFileId: post.mediaFileId } } : {}),
    });
  }
  if (!reading.byRule) {
    log.info(
      { messageId: post.messageId, missing },
      context.via === "foto"
        ? "captura incompleta após LLM Vision — aguarda correção ou revisão"
        : "captura incompleta após LLM — aguarda correção ou revisão",
    );
  }
  await recordParseTelemetry(post, "unparseable", {
    missing,
    via: context.via,
    reason: review?.reason ?? "rascunho_sem_stake",
    ocrEvidence: reading.ocrEvidence,
  });
  return { kind: "unparseable", missing };
}

/**
 * Nenhuma leitura da foto: sem resposta da IA vira retry, com a recusa que
 * vale se as tentativas acabarem; "não é aposta" avisa o operador.
 */
async function reportUnreadablePhoto(
  post: { chatId: bigint; messageId: number },
  bankroll: string,
  reading: Extract<ReadingResult, { kind: "not_bet" | "unavailable" }>,
  onExhausted?: () => Promise<unknown>,
): Promise<ChannelCaptureOutcome> {
  const notBet = reading.kind === "not_bet";
  await recordParseTelemetry(post, "unparseable", {
    missing: reading.missing,
    via: "foto",
    reason: notBet ? "not_bet" : "llm_exhausted",
    ocrEvidence: reading.kind === "not_bet" ? reading.ocrEvidence : undefined,
  });
  if (!notBet) {
    throw new TelegramParseRetryError("foto", post.messageId, onExhausted ? { onExhausted } : undefined);
  }
  await sendOperatorNotification([
    `❔ Foto não virou aposta · ${bankroll}`,
    `Post ${post.messageId}: a IA entendeu que a imagem não é uma aposta.`,
    "👉 Se era aposta, use \"Capturar mesmo assim\" em Monitoramento › Canais ou registre à mão.",
    telegramPostLink(post.chatId, post.messageId),
  ].filter(Boolean).join("\n"));
  return { kind: "unparseable", missing: reading.missing };
}

/**
 * Post já capturado (inclusive em lote), removido pelo operador ou com a
 * origem aposentada junto com a banca não passa de novo pela leitura. No
 * álbum vale qualquer foto: a vencedora pode ter trocado depois do registro.
 */
async function alreadyCaptured(post: { chatId: bigint; messageId: number; mediaGroupId?: string }): Promise<ChannelCaptureOutcome | null> {
  const siblings = post.mediaGroupId ? await albumMessageIds(post.mediaGroupId) : [];
  const postIds = [...new Set([post.messageId, ...siblings])].map(String);
  const used = await findPostSourceUse(telegramChannelSource(post.chatId), postIds);
  if (!used) return null;
  if (used.kind === "retired") return { kind: "skipped", reason: "fonte_retirada" };
  if (used.deleted) return { kind: "skipped", reason: "aposta_removida" };
  await recordParseTelemetry(post, "duplicate", { via: "source" });
  return { kind: "duplicate", betId: used.betId };
}
