import { Prisma } from "@/src/generated/prisma/client";
import { getSharedBoss } from "@/src/infra/boss";
import { prisma } from "@/src/infra/prisma";
import { routeTelegramJob, type TelegramJob } from "@/src/domain/telegram-job";
import { QUEUES } from "@/src/infra/queue-contract";
import { enqueueTelegramJob } from "@/src/services/scheduling/enqueue-telegram-job";
import { CHANNEL_SOURCE_PREFIX } from "@/src/domain/telegram-source";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import type { ParsedBetPost } from "@/src/domain/bet-capture";
import {
  captureFixFieldFor, offerCaptureFix, serializeFixBet, type CaptureFixOption, type OfferCaptureFixResult,
} from "@/src/services/capture/capture-fix";
import { deserializeFullDraftBet, fullDraftBetSchema } from "@/src/services/capture/dm-draft";

/**
 * Posts de canal que não viraram leitura guardados em `audit_events`, com a
 * retenção comum de 30 dias: os de canal sem banca, os que o filtro
 * anti-ruído barrou, os de canal pausado e os que a IA leu sem achar aposta.
 * Nenhum post some sem deixar o texto (e a foto, pelo file_id).
 *
 * A escrita em `audit_events` passa pela redação de segredos, que troca a
 * quebra de linha por "\\n". O post descartado, que pode voltar à captura,
 * guarda o texto em linhas para voltar idêntico.
 */

export const UNMAPPED_CHANNEL_AUDIT_INTERVAL_MS = 6 * 60 * 60_000;
export const CHANNEL_POST_TEXT_LIMIT = 4_000;
const DISCARDED_POST_ACTION = "canal_post_descartado";
const MESSAGE_RESOURCE = "telegram_message";

function archivedText(text: string | undefined): { text: string | null; textTruncated: boolean } {
  return {
    text: text?.slice(0, CHANNEL_POST_TEXT_LIMIT) ?? null,
    textTruncated: (text?.length ?? 0) > CHANNEL_POST_TEXT_LIMIT,
  };
}

function messageResourceId(chatId: bigint | string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

const UNMAPPED_CHANNEL_ACTION = "canal_sem_bankroll";
const CHANNEL_RESOURCE = "telegram_channel";
/** O dono não administra o canal: qualquer pessoa pode pôr o bot no próprio canal. */
export const CHANNEL_NOT_OWNED = "dono_nao_administra";

/**
 * Registra, de forma durável, mensagens recebidas de canais ainda não
 * mapeados. O texto e a foto de canal alheio não são guardados: quem chama
 * os omite.
 */
export async function recordUnmappedChannel(params: {
  chatId: bigint;
  messageId: number;
  kind: "text" | "photo";
  text?: string;
  mediaFileId?: string;
  /** Por que o canal ficou sem banca; o registro do canal é um por motivo a cada intervalo. */
  reason?: string;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  return runSerializableTransaction("recordUnmappedChannel", async (tx) => {
    const resourceId = String(params.chatId);
    const captureResourceId = messageResourceId(params.chatId, params.messageId);
    const existingCapture = await tx.auditEvent.findFirst({
      where: {
        action: "canal_sem_bankroll_payload",
        resource: MESSAGE_RESOURCE,
        resourceId: captureResourceId,
      },
      select: { id: true },
    });
    if (!existingCapture) {
      await tx.auditEvent.create({
        data: {
          actor: "system",
          action: "canal_sem_bankroll_payload",
          resource: MESSAGE_RESOURCE,
          resourceId: captureResourceId,
          createdAt: now,
          details: {
            chatId: resourceId,
            messageId: params.messageId,
            kind: params.kind,
            ...archivedText(params.text),
            mediaFileId: params.mediaFileId ?? null,
          } satisfies Prisma.InputJsonValue,
        },
      });
    }
    const recent = await tx.auditEvent.findFirst({
      where: {
        action: UNMAPPED_CHANNEL_ACTION,
        resource: CHANNEL_RESOURCE,
        resourceId,
        createdAt: { gte: new Date(now.getTime() - UNMAPPED_CHANNEL_AUDIT_INTERVAL_MS) },
        ...(params.reason ? { details: { path: ["reason"], equals: params.reason } } : {}),
      },
      select: { id: true },
    });
    if (!recent) {
      await tx.auditEvent.create({
        data: {
          actor: "system",
          action: UNMAPPED_CHANNEL_ACTION,
          resource: CHANNEL_RESOURCE,
          resourceId,
          createdAt: now,
          details: {
            messageId: params.messageId,
            kind: params.kind,
            ...(params.reason ? { reason: params.reason } : {}),
          } satisfies Prisma.InputJsonValue,
        },
      });
    }
    return !recent;
  });
}

/**
 * O canal já foi visto como alheio dentro do intervalo do registro: o próximo
 * post dele não consulta o Telegram nem grava nada.
 */
export async function isChannelKnownAsNotOwned(chatId: bigint, now = new Date()): Promise<boolean> {
  const known = await prisma.auditEvent.findFirst({
    where: {
      action: UNMAPPED_CHANNEL_ACTION,
      resource: CHANNEL_RESOURCE,
      resourceId: String(chatId),
      createdAt: { gte: new Date(now.getTime() - UNMAPPED_CHANNEL_AUDIT_INTERVAL_MS) },
      details: { path: ["reason"], equals: CHANNEL_NOT_OWNED },
    },
    select: { id: true },
  });
  return known !== null;
}

/**
 * Por que o post não virou aposta. `canal_pausado`: o dono pausou a captura
 * do canal e o post nem foi lido; `ia_nao_viu_aposta`: a IA leu e entendeu
 * que não é aposta; `captura_recusada`: o guard recusou a aposta lida;
 * `rascunho_incompleto`: o post saiu sem a stake ou a odd e espera a edição.
 */
export type DiscardReason =
  | "nao_parece_aposta"
  | "resultado_ou_balanco"
  | "jogo_ja_terminado"
  | "canal_pausado"
  | "ia_nao_viu_aposta"
  | "captura_recusada"
  | "rascunho_incompleto";

type DiscardedPostDetails = {
  chatId: string;
  messageId: number;
  bankrollId: string;
  /** Foto: `lines` é a legenda e a imagem volta pelo `mediaFileId`. */
  kind?: "text" | "photo";
  mediaFileId?: string | null;
  lines: string[];
  textTruncated: boolean;
  reason: DiscardReason;
  postDate: string;
  /** O texto guardado veio de uma edição: é também o instante da entrada. */
  editDate?: string;
  captureRequestedAt?: string;
  captureRequestedBy?: string;
  /** O 👍 presente no post já foi respondido: a contagem de reações o repete a cada mudança. */
  reactionAnsweredAt?: string;
  /** Recusa do guard: a aposta lida e o motivo, para o 👍 oferecer o conserto pela DM. */
  refusal?: { reason: string; via: string; bet: Prisma.InputJsonObject; options?: CaptureFixOption[] };
};

/**
 * Post que não foi à leitura ou não virou aposta. A edição do mesmo post
 * atualiza o texto: "Capturar mesmo assim" lê a versão mais recente.
 */
export async function recordDiscardedChannelPost(params: {
  chatId: bigint;
  messageId: number;
  bankrollId: string;
  text: string;
  postDate: Date;
  editDate?: Date;
  reason: DiscardReason;
  /** Foto: guarda o file_id para a captura forçada baixar de novo. */
  photo?: { mediaFileId: string | null };
  /** O que o guard recusou; a aposta vai serializada como no conserto. */
  refusal?: { reason: string; via: string; bet: ParsedBetPost; options?: CaptureFixOption[] };
}): Promise<void> {
  const resourceId = messageResourceId(params.chatId, params.messageId);
  await runSerializableTransaction("recordDiscardedChannelPost", async (tx) => {
    const existing = await tx.auditEvent.findFirst({
      where: { action: DISCARDED_POST_ACTION, resource: MESSAGE_RESOURCE, resourceId },
      select: { id: true, details: true },
    });
    const archived = archivedText(params.text);
    // A recusa guardada é a da última leitura: a de uma leitura anterior não volta ao 👍.
    const { refusal: _previousRefusal, ...previous } = (existing?.details ?? {}) as Partial<DiscardedPostDetails>;
    const details: DiscardedPostDetails = {
      ...previous,
      chatId: String(params.chatId),
      messageId: params.messageId,
      bankrollId: params.bankrollId,
      kind: params.photo ? "photo" : "text",
      ...(params.photo ? { mediaFileId: params.photo.mediaFileId } : {}),
      ...(params.refusal ? { refusal: { ...params.refusal, bet: serializeFixBet(params.refusal.bet) as Prisma.InputJsonObject } } : {}),
      lines: (archived.text ?? "").split(/\r?\n/),
      textTruncated: archived.textTruncated,
      reason: params.reason,
      postDate: params.postDate.toISOString(),
      ...(params.editDate ? { editDate: params.editDate.toISOString() } : {}),
    };
    if (existing) {
      await tx.auditEvent.update({ where: { id: existing.id }, data: { details } });
      return;
    }
    await tx.auditEvent.create({
      data: { actor: "telegram-channel", action: DISCARDED_POST_ACTION, resource: MESSAGE_RESOURCE, resourceId, details },
    });
  });
}

export type DiscardedPost = {
  messageId: number;
  kind: "text" | "photo";
  text: string;
  textTruncated: boolean;
  reason: DiscardReason;
  /** Instante do texto guardado: a edição, se ele veio de uma. */
  postedAt: Date;
  captureRequestedAt: Date | null;
};

/**
 * Descartados por canal na janela, sem os que viraram aposta depois (edição
 * do tipster ou "Capturar mesmo assim"). `total` conta todos; `recent` traz os
 * mais novos.
 */
export async function listDiscardedChannelPosts(
  channelIds: readonly string[],
  since: Date,
  perChannel: number,
): Promise<Map<string, { total: number; recent: DiscardedPost[] }>> {
  const result = new Map<string, { total: number; recent: DiscardedPost[] }>();
  if (channelIds.length === 0) return result;
  const rows = await prisma.$queryRaw<Array<{ chatId: string; total: number; details: DiscardedPostDetails }>>(Prisma.sql`
    WITH pending AS (
      SELECT a.details->>'chatId' AS "chatId", a.details, a."createdAt"
      FROM audit_events a
      WHERE a.action = ${DISCARDED_POST_ACTION}
        AND a.resource = ${MESSAGE_RESOURCE}
        AND a."createdAt" >= ${since}
        AND a.details->>'chatId' IN (${Prisma.join([...channelIds])})
        AND NOT EXISTS (
          SELECT 1 FROM bets b
          WHERE b.source = ${CHANNEL_SOURCE_PREFIX} || (a.details->>'chatId')
            AND (b."sourceExternalId" = a.details->>'messageId'
              OR b."sourceExternalId" LIKE (a.details->>'messageId') || ':%')
        )
        -- Post que virou aposta depois apagada (banca excluída, apostas
        -- apagadas) não volta a ser um descartado para capturar.
        AND NOT EXISTS (
          SELECT 1 FROM retired_bet_sources r
          WHERE r.source = ${CHANNEL_SOURCE_PREFIX} || (a.details->>'chatId')
            AND (r."sourceExternalId" = a.details->>'messageId'
              OR r."sourceExternalId" LIKE (a.details->>'messageId') || ':%')
        )
    ), ranked AS (
      SELECT "chatId", details,
        row_number() OVER (PARTITION BY "chatId" ORDER BY details->>'postDate' DESC, "createdAt" DESC) AS position,
        count(*) OVER (PARTITION BY "chatId")::int AS total
      FROM pending
    )
    SELECT "chatId", total, details FROM ranked WHERE position <= ${perChannel}
    ORDER BY "chatId", position
  `);
  for (const row of rows) {
    const entry = result.get(row.chatId) ?? { total: row.total, recent: [] };
    entry.recent.push({
      messageId: row.details.messageId,
      kind: row.details.kind ?? "text",
      text: row.details.lines.join("\n"),
      textTruncated: row.details.textTruncated,
      reason: row.details.reason ?? "nao_parece_aposta",
      postedAt: new Date(row.details.editDate ?? row.details.postDate),
      captureRequestedAt: row.details.captureRequestedAt ? new Date(row.details.captureRequestedAt) : null,
    });
    result.set(row.chatId, entry);
  }
  return result;
}

/**
 * "Capturar mesmo assim": a captura roda no worker, pelo mesmo job do post ao
 * vivo, só que sem o filtro, na fila do post. Clique repetido com o pedido
 * ainda na fila não enfileira outro; depois dele, a deduplicação por origem
 * devolve a aposta já gravada. O pedido do painel pula também a regra de jogo
 * terminado (o painel mostra a idade do post); o do 👍 não, e vale uma vez:
 * cada atualização da contagem de reações repete o 👍.
 */
export async function requestDiscardedPostCapture(
  params: { chatId: string; messageId: number; actor: string; byReaction?: boolean },
): Promise<"enfileirado" | "ja_na_fila" | "ja_pedido"> {
  const record = await findDiscardedPost(params.chatId, params.messageId);
  if (!record) throw new RecusaDeNegocioError("Post descartado não encontrado (a retenção é de 30 dias).");
  const { details } = record;
  if (params.byReaction && details.captureRequestedAt) return "ja_pedido";
  const common = {
    chatId: details.chatId,
    messageId: details.messageId,
    postDate: details.postDate,
    ...(details.editDate ? { editDate: details.editDate } : {}),
    forcedByOperator: true,
    ...(params.byReaction ? { forcedByReaction: true } : {}),
  };
  let job: TelegramJob;
  if (details.kind === "photo") {
    if (!details.mediaFileId) throw new Error("A foto deste post não foi guardada; registre à mão.");
    job = { kind: "channel_photo", ...common, caption: details.lines.join("\n"), fileId: details.mediaFileId };
  } else {
    job = { kind: "channel_post", ...common, text: details.lines.join("\n") };
  }
  const boss = await getSharedBoss();
  const pending = await boss.findJobs(QUEUES.telegramUpdates, {
    key: routeTelegramJob(job).orderingKey,
    data: { kind: job.kind, forcedByOperator: true },
    queued: true,
  });
  // O pedido é explícito: roda de novo mesmo com o texto de um pedido já atendido.
  const jobId = pending.length > 0 ? null : await enqueueTelegramJob(boss, job, { id: "fresh" });
  const requestedAt = new Date();
  await runSerializableTransaction("requestDiscardedPostCapture", async (tx) => {
    await tx.auditEvent.update({
      where: { id: record.id },
      data: { details: { ...details, captureRequestedAt: requestedAt.toISOString(), captureRequestedBy: params.actor } },
    });
    await tx.auditEvent.create({
      data: {
        actor: params.actor,
        action: "channel.capture_discarded",
        resource: "telegram-channel",
        resourceId: details.chatId,
        details: { messageId: details.messageId, enfileirado: Boolean(jobId), ...(params.byReaction ? { origem: "reacao" } : {}) },
      },
    });
  });
  return jobId ? "enfileirado" : "ja_na_fila";
}

async function findDiscardedPost(chatId: bigint | string, messageId: number) {
  const record = await prisma.auditEvent.findFirst({
    where: { action: DISCARDED_POST_ACTION, resource: MESSAGE_RESOURCE, resourceId: messageResourceId(chatId, messageId) },
    select: { id: true, details: true },
  });
  const details = record?.details as DiscardedPostDetails | null | undefined;
  return record && details?.lines.length ? { id: record.id, details } : null;
}

/** Resultado do 👍 num post sem aposta; `ignorado` traz o porquê. */
export type ReactionCaptureResult =
  | { result: "enfileirado" | "ja_na_fila" | "ja_pedido" }
  | { result: "conserto"; offer: OfferCaptureFixResult }
  | { result: "ignorado"; reason: "sem_registro" | "jogo_encerrado" | "ia_ja_leu" | "recusa_sem_conserto" | "foto_sem_arquivo" | "ja_respondido" };

/**
 * O 👍 do dono num post guardado sem aposta. Post que nem foi lido (filtro,
 * canal pausado) e rascunho sem stake ou odd vão à captura forçada, que
 * pergunta na DM o número que falta; recusa que o dono conserta vira a
 * pergunta na DM. Recapitulação e jogo encerrado nunca: gravariam aposta de
 * jogo acabado. O que a IA já leu sem ver aposta também não, porque repetir a
 * leitura repete a resposta. Sem registro não há o que ler: a Bot API não
 * devolve post por id.
 *
 * O 👍 é respondido uma vez enquanto está no post: cada mudança na contagem de
 * reações o repete, e o aviso ou a pergunta que o dono dispensou não voltam.
 * Tirar o 👍 e pôr de novo é outro pedido (`forgetReactionAnswer`).
 */
export async function requestCaptureByReaction(params: ReactionCaptureRequest): Promise<ReactionCaptureResult> {
  const record = await findDiscardedPost(params.chatId, params.messageId);
  if (!record) return { result: "ignorado", reason: "sem_registro" };
  if (record.details.reactionAnsweredAt) return { result: "ignorado", reason: "ja_respondido" };
  const answer = await answerReaction(params, record.details);
  // A pergunta que não saiu por falha de envio fica para o próximo evento.
  if (!(answer.result === "conserto" && answer.offer === "falhou")) {
    await setReactionAnswer(params.chatId, params.messageId, new Date().toISOString());
  }
  return answer;
}

/** O 👍 saiu do post: o próximo é um pedido novo. */
export async function forgetReactionAnswer(chatId: bigint, messageId: number): Promise<void> {
  await setReactionAnswer(chatId, messageId, null);
}

/** Relê o registro: a captura pedida pelo 👍 acabou de gravar nele. */
async function setReactionAnswer(chatId: bigint, messageId: number, answeredAt: string | null): Promise<void> {
  const record = await findDiscardedPost(chatId, messageId);
  if (!record || (record.details.reactionAnsweredAt ?? null) === answeredAt) return;
  const { reactionAnsweredAt: _previous, ...details } = record.details;
  await prisma.auditEvent.update({
    where: { id: record.id },
    data: { details: { ...details, ...(answeredAt ? { reactionAnsweredAt: answeredAt } : {}) } },
  });
}

type ReactionCaptureRequest = { chatId: bigint; messageId: number; bankroll: { id: string; nome: string }; actor: string };

async function answerReaction(params: ReactionCaptureRequest, details: DiscardedPostDetails): Promise<ReactionCaptureResult> {
  switch (details.reason ?? "nao_parece_aposta") {
    case "resultado_ou_balanco":
    case "jogo_ja_terminado":
      return { result: "ignorado", reason: "jogo_encerrado" };
    case "ia_nao_viu_aposta":
      return { result: "ignorado", reason: "ia_ja_leu" };
    case "captura_recusada": {
      const refusal = details.refusal;
      const bet = refusal ? fullDraftBetSchema.safeParse(refusal.bet) : null;
      if (!refusal || !bet?.success || !captureFixFieldFor(refusal.reason)) return { result: "ignorado", reason: "recusa_sem_conserto" };
      const offer = await offerCaptureFix({
        bankroll: params.bankroll,
        post: {
          chatId: params.chatId, messageId: params.messageId, postDate: new Date(details.postDate),
          ...(details.editDate ? { editDate: new Date(details.editDate) } : {}),
        },
        bet: deserializeFullDraftBet(bet.data),
        reason: refusal.reason,
        via: refusal.via,
        ...(refusal.options ? { options: refusal.options } : {}),
        caption: details.lines.join("\n"),
        ...(details.mediaFileId ? { mediaFileId: details.mediaFileId } : {}),
      });
      return { result: "conserto", offer };
    }
    case "nao_parece_aposta":
    case "canal_pausado":
    case "rascunho_incompleto":
      if (details.kind === "photo" && !details.mediaFileId) return { result: "ignorado", reason: "foto_sem_arquivo" };
      return {
        result: await requestDiscardedPostCapture({
          chatId: String(params.chatId), messageId: params.messageId, actor: params.actor, byReaction: true,
        }),
      };
  }
}
