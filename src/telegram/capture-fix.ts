import type { Bot, Context, Filter, NextFunction } from "grammy";
import type { PgBoss } from "pg-boss";
import { telegramOwnerId } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import {
  answerCaptureFix,
  CAPTURE_FIX_CALLBACK,
  CAPTURE_FIX_PROMPT_PREFIX,
  looksLikeCaptureFixAnswer,
} from "@/src/services/capture/capture-fix";

const log = createLogger("tg-capture-fix");

const CLOSED_PROMPT_REPLY = "⚠️ Esta pergunta expirou ou já foi respondida.";

// ── grammY ──────────────────────────────────────────────────────────────────

/**
 * Registra antes dos handlers da DM: o clique `fx:` e a resposta a uma
 * pergunta de conserto não são aposta nova. O resto segue adiante.
 */
export function registerCaptureFixHandlers(bot: Bot, boss: PgBoss): void {
  bot.on("callback_query:data", (ctx, next) => handleCaptureFixCallback(ctx, next, boss));
  bot.on("message", (ctx, next) => handleCaptureFixReplyMessage(ctx, next, boss));
}

async function handleCaptureFixCallback(
  ctx: Filter<Context, "callback_query:data">,
  next: NextFunction,
  boss: PgBoss,
): Promise<void> {
  const data = ctx.callbackQuery.data;
  const message = ctx.callbackQuery.message;
  if (!data.startsWith(CAPTURE_FIX_CALLBACK) || !message) return next();
  if (String(message.chat.id) !== telegramOwnerId()) {
    await ctx.answerCallbackQuery({ text: "Chat não autorizado.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery().catch((err: unknown) => log.warn({ err }, "falha ao confirmar callback do conserto"));
  const reply = await answerCaptureFix({
    ownerChatId: String(message.chat.id),
    promptMessageId: message.message_id,
    answer: data.slice(CAPTURE_FIX_CALLBACK.length),
  }, { boss });
  const text = reply?.text ?? CLOSED_PROMPT_REPLY;
  if (reply?.keep) {
    await ctx.reply(text).catch((err: unknown) => log.warn({ err }, "falha ao responder no conserto"));
    return;
  }
  await ctx.editMessageText(`${"text" in message && message.text ? `${message.text}\n\n` : ""}${text}`)
    .catch((err: unknown) => log.warn({ err }, "falha ao editar a pergunta do conserto"));
}

async function handleCaptureFixReplyMessage(
  ctx: Filter<Context, "message">,
  next: NextFunction,
  boss: PgBoss,
): Promise<void> {
  const replyTo = ctx.message.reply_to_message;
  if (ctx.chat.type !== "private" || String(ctx.chat.id) !== telegramOwnerId()) return next();
  if (!replyTo || !ctx.message.text || replyTo.from?.id !== ctx.me.id) return next();
  const reply = await answerCaptureFix({
    ownerChatId: String(ctx.chat.id),
    promptMessageId: replyTo.message_id,
    answer: ctx.message.text,
  }, { boss });
  // A pergunta vencida ou já respondida não lê a resposta de novo como tip.
  // Só a que tem cara de odd, stake ou placar: uma tip nova presa à pergunta
  // pelo teclado do Telegram segue para a DM.
  const closedPromptAnswer = !reply && replyTo.text?.startsWith(CAPTURE_FIX_PROMPT_PREFIX) === true &&
    looksLikeCaptureFixAnswer(ctx.message.text);
  if (!reply && !closedPromptAnswer) return next();
  // A resposta já foi aplicada (ou a pergunta segue aberta): falha ao avisar
  // não repete a mensagem, que cairia como tip nova na DM.
  await ctx.reply(reply?.text ?? CLOSED_PROMPT_REPLY, { reply_parameters: { message_id: ctx.message.message_id } })
    .catch((err: unknown) => log.warn({ err }, "falha ao responder no conserto"));
}
