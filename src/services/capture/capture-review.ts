import { MOTIVOS_DE_PERDA, rotuloDoMotivo } from "@/src/domain/recusa-de-captura";
import { telegramPostLink } from "@/src/domain/telegram-source";
import type { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import {
  raiseOperationalAlertOnce,
  sendOperatorNotification,
  type OperationalAlertContext,
} from "@/src/services/ops/alerts";
import { reconcileOperationalActionSource, reportOperationalAction } from "@/src/services/ops/operational-actions";
import { recordParseTelemetry } from "@/src/services/capture/parse-telemetry";

const CAPTURE_REVIEW_SOURCE = "telegram.capture-review";
const REFUSAL_CLUSTER_SOURCE = "telegram.capture-refusal-cluster";

/** Recusas do mesmo motivo no mesmo canal que viram um aviso só. */
export const REFUSAL_CLUSTER_MIN_POSTS = 3;
const REFUSAL_CLUSTER_WINDOW_MS = 24 * 3_600_000;

type ChannelPostRef = { chatId: bigint; messageId: number };

/**
 * O post recusado. As datas vão para a evidência da pendência: o 👍 do dono
 * pede a captura depois, e ela precisa do instante da entrada.
 */
export type RefusedPost = ChannelPostRef & { postDate: Date; editDate?: Date; forcedByOperator?: boolean };

/**
 * Post que não virou aposta e precisa do dono: fica na caixa de ações até ele
 * decidir, ou até o post virar aposta (`resolverRevisoesDeCapturaGravadas`).
 */
export async function recordCaptureReview(params: ChannelPostRef & {
  postDate?: Date; editDate?: Date;
  caption: string; mediaFileId?: string;
  bankroll: string; review: { reason: string; description: string; evidence: Record<string, unknown> };
}) {
  const link = telegramPostLink(params.chatId, params.messageId);
  return reportOperationalAction({
    source: CAPTURE_REVIEW_SOURCE, key: `${params.chatId}:${params.messageId}`,
    area: "captura", actionType: "capture_review",
    title: `${params.bankroll}: conferir bilhete da mensagem ${params.messageId}`,
    description: params.review.description, resource: "telegram-channel", resourceId: `${params.chatId}:${params.messageId}`,
    autoResolve: false, evidence: {
      reason: params.review.reason, caption: params.caption, mediaFileId: params.mediaFileId ?? null,
      link, postDate: params.postDate?.toISOString() ?? null, editDate: params.editDate?.toISOString() ?? null,
      extraction: params.review.evidence as Prisma.InputJsonObject,
    },
  });
}

export type CaptureRefusal = {
  post: RefusedPost;
  bankroll: { id: string; nome: string };
  /** Leitor que produziu a aposta recusada (`universal`, provedor, `-vision`). */
  via: string;
  /** Motivo do vocabulário de `domain/recusa-de-captura`. */
  reason: string;
  missing: string[];
  evento?: string | null;
  /** A dúvida que a leitura escreveu (as opções da grade, o lado incerto), dita ao dono. */
  detail?: string;
  caption: string;
  mediaFileId?: string;
  /** Post com várias apostas: a recusa de uma segura todas, e o aviso lista as do post. */
  batch?: { size: number; lines: string[] };
};

/**
 * A saída única de toda recusa de captura: grava a telemetria, abre a
 * pendência do post e avisa com o link. Da terceira recusa com o mesmo
 * motivo no mesmo canal em 24 h em diante, o aviso individual dá lugar a um
 * aviso agrupado com o conserto sugerido; a pendência de cada post continua.
 * Só agrupa motivo que tem conserto na banca (os de um post só sempre avisam)
 * e nunca a captura que o próprio dono pediu.
 */
export async function reportCaptureRefusal(refusal: CaptureRefusal, now = new Date()): Promise<void> {
  const { post, bankroll, reason } = refusal;
  const link = telegramPostLink(post.chatId, post.messageId);
  const motivo = rotuloDoMotivo(reason);
  const detail = refusal.detail?.trim().slice(0, 300);
  const { batch } = refusal;
  const nextStep = (reason === "unsupported_promotion_terms" || reason === "unsupported_trading_terms") ? MOTIVOS_DE_PERDA[reason]!.proximaEtapa : null;
  await recordParseTelemetry(post, "guard_rejected", {
    via: refusal.via, reason, missing: refusal.missing, ...(batch ? { items: batch.size } : {}),
  });
  await recordCaptureReview({
    chatId: post.chatId, messageId: post.messageId, postDate: post.postDate, editDate: post.editDate,
    caption: refusal.caption, mediaFileId: refusal.mediaFileId, bankroll: bankroll.nome,
    review: {
      reason,
      description: `${batch ? `Post com ${batch.size} apostas, nenhuma registrada` : "Aposta não registrada"}: ${motivo}.` +
        `${detail ? ` Dúvida da leitura: ${detail}.` : ""} ${nextStep ?? "Confira o post e registre à mão se for o caso."}`,
      evidence: { evento: refusal.evento ?? null, missing: refusal.missing, via: refusal.via },
    },
  });

  const channelWide = MOTIVOS_DE_PERDA[reason]?.consertoNoCanal !== undefined && !post.forcedByOperator;
  const repeated = channelWide ? await countRefusedPosts(post.chatId, reason, now) : 0;
  if (repeated >= REFUSAL_CLUSTER_MIN_POSTS) {
    await reportRefusalCluster(refusal, repeated, link);
    return;
  }
  await sendOperatorNotification([
    batch ? `⛔ Apostas não registradas · ${bankroll.nome}` : `⛔ Aposta não registrada · ${bankroll.nome}`,
    batch ? `Post com ${batch.size} apostas: nenhuma foi registrada.` : null,
    refusal.evento?.trim() || "Evento não identificado",
    `Motivo: ${motivo}.`,
    detail ? `Dúvida da leitura: ${detail}` : null,
    ...(batch?.lines ?? []),
    `👉 ${nextStep ?? `Confira o post ${post.messageId} no canal e registre à mão${batch ? ` as ${batch.size} apostas` : ""} se for o caso.`}`,
    link,
  ].filter(Boolean).join("\n"));
}

/** Posts distintos do canal recusados pelo motivo na janela (retries e edições contam uma vez). */
async function countRefusedPosts(chatId: bigint, reason: string, now: Date): Promise<number> {
  const rows = await prisma.auditEvent.findMany({
    where: {
      action: "telegram.parse",
      outcome: "guard_rejected",
      resource: String(chatId),
      createdAt: { gte: new Date(now.getTime() - REFUSAL_CLUSTER_WINDOW_MS) },
      details: { path: ["reason"], equals: reason },
    },
    distinct: ["resourceId"],
    select: { resourceId: true },
  });
  return rows.length;
}

function refusalClusterContext(refusal: CaptureRefusal, posts: number): OperationalAlertContext {
  return {
    source: REFUSAL_CLUSTER_SOURCE,
    key: `${refusal.post.chatId}:${refusal.reason}`,
    title: `${refusal.bankroll.nome}: recusas repetidas (${rotuloDoMotivo(refusal.reason)})`,
    resource: "bankroll",
    resourceId: refusal.bankroll.id,
    evidence: { reason: refusal.reason, posts, lastMessageId: refusal.post.messageId },
  };
}

/** O Telegram recebe o agrupado uma vez por episódio; a contagem segue atualizada na caixa. */
async function reportRefusalCluster(refusal: CaptureRefusal, posts: number, lastLink: string | null): Promise<void> {
  const conserto = MOTIVOS_DE_PERDA[refusal.reason]?.consertoNoCanal ?? "confira os posts no canal e registre à mão";
  const message = [
    `🔁 Recusas repetidas · ${refusal.bankroll.nome}`,
    `${posts} posts recusados em 24 h pelo mesmo motivo: ${rotuloDoMotivo(refusal.reason)}.`,
    `👉 ${conserto.charAt(0).toUpperCase()}${conserto.slice(1)}.`,
    "Enquanto isso, as próximas recusas deste motivo ficam só na caixa de ações, cada post com a sua pendência.",
    lastLink ? `Último post: ${lastLink}` : null,
  ].filter(Boolean).join("\n");
  await raiseOperationalAlertOnce(message, refusalClusterContext(refusal, posts));
}

/** Fecha o aviso agrupado quando o motivo sai da janela de 24 h do canal. */
export async function reconcileCaptureRefusalClusters(now = new Date()): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ chatId: string; reason: string }>>`
    SELECT resource AS "chatId", details->>'reason' AS reason
    FROM audit_events
    WHERE action = 'telegram.parse' AND outcome = 'guard_rejected'
      AND "createdAt" >= ${new Date(now.getTime() - REFUSAL_CLUSTER_WINDOW_MS)}
      AND details->>'reason' IS NOT NULL
    GROUP BY 1, 2
    HAVING count(DISTINCT "resourceId") >= ${REFUSAL_CLUSTER_MIN_POSTS}
  `;
  return reconcileOperationalActionSource(REFUSAL_CLUSTER_SOURCE, rows.map((row) => `${row.chatId}:${row.reason}`), now);
}
