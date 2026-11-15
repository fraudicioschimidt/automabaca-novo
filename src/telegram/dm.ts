import { GrammyError, type Api, type Bot, type Context, type Filter } from "grammy";
import type { PgBoss } from "pg-boss";
import type { CaptureImage } from "@/src/domain/bet-capture";
import { telegramAllowedChats } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { privacyHash } from "@/src/infra/privacy";
import { listBankrollsParaSelecao } from "@/src/services/bankrolls/lookup";
import {
  buildDmKeyboard,
  discardDmDraft,
  registerDmDraftInBankroll,
  reportDmRegisterFailure,
  type DmDraftRef,
  type DmMessageJob,
  type DmScreen,
} from "@/src/services/capture/dm";
import { downloadTelegramPhoto, isSupportedImageMime, MAX_TELEGRAM_IMAGE_BYTES } from "./photo-download";

/*
 * Borda do grammY da DM de apostas: a mensagem vira o job `dm_message` (que
 * roda pelo mesmo caminho dos posts de canal) e o clique no teclado da prévia
 * registra na banca escolhida. O que a DM faz com a aposta está em
 * `src/services/capture/dm.ts`. Restrito a TELEGRAM_ALLOWED_CHATS.
 */

const log = createLogger("tg-dm");

function allowedChats(): Set<string> {
  return telegramAllowedChats().chats;
}

/** A foto da DM pela Bot API; a falha fica no log e sobe para quem leu. */
export function dmPhotoLoader(api: Api, token: string): (fileId: string) => Promise<CaptureImage> {
  return async (fileId) => {
    try {
      return await downloadTelegramPhoto(api, token, fileId);
    } catch (err) {
      log.error({ err }, "falha ao baixar foto de DM");
      throw err;
    }
  };
}

export function registerDmCallbackHandler(bot: Bot, boss: PgBoss, token: string): void {
  if (allowedChats().size === 0) {
    log.warn("DM desativada: TELEGRAM_ALLOWED_CHATS não possui chats autorizados");
  }
  bot.on("callback_query:data", (ctx) => handleDmCallback(ctx, { boss, loadImage: dmPhotoLoader(bot.api, token) }));
}

/**
 * Mensagem privada de chat autorizado com texto, foto ou a imagem mandada como
 * arquivo (sem compressão), como no canal. Arquivo que a leitura não abre
 * ganha uma resposta direta (`reply`); o resto não é conversa com o bot.
 */
export function dmMessageJob(ctx: Filter<Context, "message">): DmMessageJob | { reply: string } | null {
  if (ctx.chat.type !== "private") return null;
  const chatId = String(ctx.chat.id);
  if (!allowedChats().has(chatId)) {
    log.warn({ chatIdHash: privacyHash(chatId, "telegram-chat") }, "DM de chat não autorizado ignorada");
    return null;
  }
  const msg = ctx.message;
  const document = msg.document;
  const imageDocument = document && isSupportedImageMime(document.mime_type ?? "") ? document : undefined;
  if (document && !imageDocument) {
    return { reply: "📎 Não leio esse tipo de arquivo. Mande o print do bilhete como foto ou o texto da aposta." };
  }
  // O download recusaria depois de enfileirar, e a mensagem ficaria em retry como leitura fora do ar.
  if (imageDocument && (imageDocument.file_size ?? 0) > MAX_TELEGRAM_IMAGE_BYTES) {
    return { reply: `🖼️ A imagem passa de ${MAX_TELEGRAM_IMAGE_BYTES / 1024 / 1024} MB e não consigo ler. Mande o print como foto.` };
  }
  const fileId = msg.photo?.at(-1)?.file_id ?? imageDocument?.file_id;
  if (!msg.text && !fileId) return null;
  return {
    kind: "dm_message",
    chatId,
    messageId: msg.message_id,
    postDate: new Date(msg.date * 1000).toISOString(),
    ...(msg.text ? { text: msg.text } : {}),
    ...(msg.caption ? { caption: msg.caption } : {}),
    ...(fileId ? { fileId } : {}),
  };
}

// ── Callback: escolha da banca ──────────────────────────────────────────────

type CallbackContext = Filter<Context, "callback_query:data">;
type OriginalMessage = { chat: { id: number }; message_id: number };

function draftRefOf(original: OriginalMessage): DmDraftRef {
  return { chatId: String(original.chat.id), messageId: original.message_id };
}

async function handleDmCallback(
  ctx: CallbackContext,
  deps: { boss: PgBoss; loadImage: (fileId: string) => Promise<CaptureImage> },
): Promise<void> {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("dm:")) return;

  // Revalida allowlist no callback (mensagem antiga / chat removido da lista).
  const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id ?? "");
  if (!allowedChats().has(chatId)) {
    log.warn({ chatIdHash: privacyHash(String(chatId), "telegram-chat") }, "callback DM de chat não autorizado ignorado");
    await ctx.answerCallbackQuery({ text: "Chat não autorizado.", show_alert: true });
    return;
  }

  const bankrollId = data.slice(3);
  const original = ctx.callbackQuery.message?.reply_to_message;
  if (bankrollId === "cancel") return cancelDmDraft(ctx, original);
  if (bankrollId.startsWith("page:")) {
    // Paginar é só exibição: as falhas (toque antigo demais, edição recusada)
    // ficam no log, sem repetir o job da prévia.
    await ctx.answerCallbackQuery().catch((err) => log.warn({ err }, "falha ao confirmar callback de página da DM"));
    const page = Number.parseInt(bankrollId.slice(5), 10);
    const bancas = await listBankrollsParaSelecao();
    await ctx.editMessageReplyMarkup({
      reply_markup: buildDmKeyboard(bancas, Number.isFinite(page) ? page : 0),
    }).catch(logEditFailure("falha ao paginar o teclado da DM"));
    return;
  }
  if (!original) {
    await ctx.answerCallbackQuery({ text: "Post original não encontrado." });
    return;
  }
  // Encerra o spinner do Telegram antes de banco, download, guard ou LLM.
  await ctx.answerCallbackQuery({ text: "Registrando…" }).catch((err) => {
    log.warn({ err }, "falha ao confirmar callback DM; registro continua idempotente");
  });
  const draftRef = draftRefOf(original);
  let screen: DmScreen;
  try {
    screen = await registerDmDraftInBankroll(draftRef, bankrollId, deps);
  } catch (err) {
    const text = await reportDmRegisterFailure(draftRef, bankrollId, err);
    await ctx.editMessageText(text).catch(
      (editErr) => log.error({ err: editErr }, "falha ao exibir erro de registro da DM"),
    );
    return;
  }
  // Uma falha ao mostrar não é falha do registro: a aposta gravada ou a recusa
  // já estão decididas, e o teclado continua na prévia.
  await (screen.keyboard ? ctx.editMessageText(screen.text, { reply_markup: screen.keyboard }) : ctx.editMessageText(screen.text))
    .catch(logEditFailure(screen.registered ? "falha ao editar mensagem DM (registrada)" : "falha ao editar a prévia da DM"));
}

/**
 * Toque repetido no mesmo botão (a página na tela, a mesma recusa de novo)
 * pede uma edição que deixa a mensagem igual, e a Bot API a recusa: a tela já
 * está certa. As outras falhas de edição ficam no log.
 */
function logEditFailure(message: string): (err: unknown) => void {
  return (err) => {
    const unchanged = err instanceof GrammyError && err.error_code === 400 && err.description.includes("message is not modified");
    if (!unchanged) log.warn({ err }, message);
  };
}

async function cancelDmDraft(ctx: CallbackContext, original: OriginalMessage | undefined): Promise<void> {
  await ctx.answerCallbackQuery({ text: "Cancelado" });
  if (original) await discardDmDraft(draftRefOf(original));
  await ctx.editMessageText("✖️ Cancelado.").catch((err) => {
    log.warn({ err }, "falha ao editar mensagem DM (cancel)");
  });
}
