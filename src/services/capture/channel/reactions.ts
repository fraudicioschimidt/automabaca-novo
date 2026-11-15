import type { ReactionDecision, ReactionEvent, ReactionOutcome } from "@/src/domain/telegram-reaction";
import { telegramChannelSource } from "@/src/domain/telegram-source";
import { createLogger } from "@/src/infra/logger";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { privacyHash } from "@/src/infra/privacy";
import { findBankrollByChannel } from "@/src/services/bankrolls/lookup";
import { findPostSourceUse } from "@/src/services/bets/register";
import { sendOperatorNotification } from "@/src/services/ops/alerts";
import { forgetReactionAnswer, requestCaptureByReaction } from "@/src/services/capture/channel/channel-post-archive";
import { findAlbumWinnerMessageId } from "@/src/services/capture/channel/media-album";
import { applyTelegramReaction, isAuthorizedReactionActor, reactionOwner } from "@/src/services/capture/channel/reaction-decisions";

const log = createLogger("tg-reaction");

/**
 * Reações no post original do tipster:
 *   👎 = "não peguei" — remove com reversão (soft-delete), o lote inteiro;
 *   tirar o 👎 = restaura a aposta;
 *   👍 em post com aposta = "peguei" — marca o lote como pego (a ficha e a
 *   trilha mostram a hora); tirar o 👍 desmarca. 👍 junto com 👎 vale
 *   como 👎;
 *   👍 em post que NÃO virou aposta = "capture": pede a captura do post
 *   guardado (descartado ou pausado) ou o conserto da recusa pela DM, nunca
 *   de recapitulação ou jogo encerrado.
 * Qualquer outro emoji é ignorado. Inclui variações de tom de pele.
 *
 * No canal só estão o dono e os bots, e a reação chega anônima (a contagem):
 * todo 👎 e 👍 do canal é do dono. Reação identificada só vale de usuário
 * autorizado. O 👎 ou 👍 que chega antes da aposta fica guardado e é aplicado
 * no registro.
 */

const THUMBS_DOWN = new Set(["👎", "👎🏻", "👎🏼", "👎🏽", "👎🏾", "👎🏿"]);
const THUMBS_UP = new Set(["👍", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"]);

/**
 * Emojis presentes na contagem anônima. Como no 👎, qualquer contagem vale:
 * só o dono reage no canal, e ler o 👍 só com uma reação tiraria a marca de
 * pega quando a contagem subisse.
 */
export function emojisFromReactionCounts(
  reactions: ReadonlyArray<{ type: { type: string; emoji?: string }; total_count: number }>,
): string[] {
  const emojis: string[] = [];
  for (const r of reactions) {
    if (r.type.type === "emoji" && r.type.emoji && r.total_count > 0) {
      emojis.push(r.type.emoji);
    }
  }
  return emojis;
}

export function hasThumbsDownReaction(emojis: readonly string[]): boolean {
  return emojis.some((emoji) => THUMBS_DOWN.has(emoji));
}

export function thumbsDownPresentInReactionCounts(
  reactions: ReadonlyArray<{ type: { type: string; emoji?: string }; total_count: number }>,
): boolean {
  return reactions.some((reaction) => {
    const emoji = reaction.type.emoji;
    return reaction.total_count > 0
      && reaction.type.type === "emoji"
      && typeof emoji === "string"
      && THUMBS_DOWN.has(emoji);
  });
}

/** O estado do post que decide: 👎 vence; sem ele, o 👍 marca a entrada como pega. */
function reactionDecision(down: boolean, emojis: readonly string[]): ReactionDecision {
  if (down) return "NOT_TAKEN";
  return emojis.some((emoji) => THUMBS_UP.has(emoji)) ? "TAKEN" : "NEUTRAL";
}

export async function handleChannelReaction(
  event: ReactionEvent,
): Promise<ReactionOutcome> {
  if (event.actorUserId === undefined) {
    // Contagem anônima: o estado atual do 👎 e do 👍 no post decide.
    if (event.thumbsDownPresent === undefined) return { kind: "ignored", reason: "reacao_irrelevante" };
    const outcome = await applyTelegramReaction(event, reactionDecision(event.thumbsDownPresent, event.emojis));
    if (event.thumbsDownPresent) return outcome;
    return (await requestCaptureOnThumbsUp(event, reactionOwner(undefined))) ?? outcome;
  }
  if (!isAuthorizedReactionActor(event.actorUserId)) return { kind: "ignored", reason: "autor_nao_autorizado" };
  const down = event.emojis.some((e) => THUMBS_DOWN.has(e));
  // O que saiu também decide: sem 👎 a aposta removida pelo 👎 volta, e sem 👍
  // a marca de pega sai.
  const outcome = await applyTelegramReaction(event, reactionDecision(down, event.emojis));
  if (down) return outcome;
  return (await requestCaptureOnThumbsUp(event, event.actorUserId)) ?? outcome;
}

/** Mensagem ao dono por resultado do 👍; o que não mudou nada fica só na telemetria. */
const THUMBS_UP_NOTICE: Partial<Record<string, (messageId: number) => string>> = {
  enfileirado: (id) => `Você reagiu com 👍 ao post ${id}, que não tinha virado aposta. Vou lê-lo de novo, sem o filtro.`,
  jogo_encerrado: (id) => `Você reagiu com 👍 ao post ${id}, mas ele é recapitulação ou de jogo encerrado: não capturo. Se era entrada, registre à mão.`,
  ia_ja_leu: (id) => `Você reagiu com 👍 ao post ${id}, mas a IA já o leu sem achar aposta. Use "Capturar mesmo assim" em Monitoramento › Canais ou registre à mão.`,
  conserto_jogo_comecou: (id) => `Você reagiu com 👍 ao post ${id}, recusado na captura, mas o prazo do conserto pela DM já passou. Se era entrada, registre à mão.`,
  recusa_sem_conserto: (id) => `Você reagiu com 👍 ao post ${id}, recusado na captura, mas o conserto pela DM não cobre essa recusa (ou o post tem várias apostas). Se era entrada, registre à mão.`,
};

/**
 * 👍 do dono num post sem aposta: pede a captura do post guardado ou o
 * conserto pela DM (ver `requestCaptureByReaction`). Cada mudança na contagem
 * de reações repete o 👍, então o pedido e o aviso valem uma vez; sem o 👍, o
 * post esquece a resposta, e o próximo 👍 pede de novo.
 */
async function requestCaptureOnThumbsUp(event: ReactionEvent, owner: string | null | undefined): Promise<ReactionOutcome | null> {
  if (!owner) return null;
  const source = telegramChannelSource(event.chatId);
  // A aposta de um álbum fica na foto vencedora; o 👍 pode estar em outra.
  const winner = await findAlbumWinnerMessageId(event.chatId, event.messageId);
  const candidates = [...new Set([winner ?? event.messageId, event.messageId])];
  if (!event.emojis.some((e) => THUMBS_UP.has(e))) {
    for (const messageId of candidates) await forgetReactionAnswer(event.chatId, messageId);
    return null;
  }
  for (const messageId of candidates) {
    if (await findPostSourceUse(source, String(messageId))) return null;
  }
  const bankroll = await findBankrollByChannel(event.chatId);
  if (!bankroll) return null;
  for (const messageId of candidates) {
    const outcome = await requestCaptureByReaction({
      chatId: event.chatId, messageId, bankroll, actor: `telegram-user:${owner}`,
    });
    const label = outcome.result === "ignorado" ? outcome.reason : outcome.result === "conserto" ? `conserto_${outcome.offer}` : outcome.result;
    await recordOperationalMetric({ kind: "action", name: "telegram.thumbs_up", outcome: "success", labels: { result: label } });
    if (outcome.result === "ignorado" && outcome.reason === "sem_registro") continue;
    log.info({ chatIdHash: privacyHash(String(event.chatId), "telegram-chat"), messageId, result: label }, "👍 em post sem aposta");
    const notice = THUMBS_UP_NOTICE[label];
    if (notice) await sendOperatorNotification(`👍 ${bankroll.nome}\n${notice(messageId)}`);
    if (outcome.result === "ignorado") return { kind: "ignored", reason: outcome.reason };
    if (outcome.result === "conserto") return { kind: "fix_offered", messageId, offer: outcome.offer };
    return { kind: "capture_requested", messageId, result: outcome.result };
  }
  return null;
}
