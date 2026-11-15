import "server-only";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { telegramChannelSource } from "@/src/domain/telegram-source";
import { foraDaBaseDeCobertura, missingClvReason, MOTIVOS_FORA_DA_BASE } from "@/src/domain/no-odds-reason";
import {
  DESFECHO_GRAVADO,
  DESFECHO_REPETIDO,
  rendimentoDoMotor,
  type Perda,
} from "@/src/domain/recusa-de-captura";
import {
  countTransientBetsByChannel,
  TRANSIENT_CHANNEL_REPROCESS_LIMIT,
} from "@/src/services/ops/reprocess";
import { listDiscardedChannelPosts, type DiscardedPost } from "@/src/services/capture/channel/channel-post-archive";
import {
  readCaptureLatency,
  readChannelActivity,
  type CaptureLatency,
  type ChannelActivityState,
} from "@/src/services/capture/channel/channel-activity";

const DISCARDED_POSTS_VISIBLE = 5;

/**
 * Saúde dos canais do Telegram em Monitoramento. A taxa de parse sai do mesmo
 * `rendimentoDoMotor` que o funil de captura usa (`domain/recusa-de-captura`),
 * contada por post e não por evento de auditoria.
 */

export type ChannelHealth = {
  bankrollNome: string;
  bankrollSlug: string;
  /** Captura pausada pelo dono: o silêncio do canal não é alerta. */
  capturePaused: boolean;
  channelId: string;
  capturas: number;
  ultimaCaptura: Date | null;
  parse: {
    /** Posts julgados pelo parser na janela. */
    posts: number;
    ok: number;
    /** Não eram aposta: descarte correto, FORA do denominador da taxa. */
    descartadas: number;
    /** Posts que eram aposta de verdade — a base da `taxaOk`. */
    tentativas: number;
    falhas: number;
    taxaOk: number | null;
    /** Por motivo, já com rótulo e próxima etapa. Uma cópia só do vocabulário. */
    perdas: Perda[];
  };
  identity: {
    resolved: number;
    pending: number;
    failed: number;
    total: number;
    taxaOk: number | null;
  };
  /** Por que as apostas do canal com identidade não têm preço sharp. */
  odds: {
    faltas: Array<{ reason: string; n: number }>;
  };
  resolution: { samples: number; p50Min: number | null; p95Min: number | null };
  preKickoffFailures: number;
  transientFailures: number;
  transientBatchLimit: number;
  /** Posts de texto que o filtro barrou e ainda não viraram aposta (30 dias). */
  discarded: { total: number; recent: DiscardedPost[] };
  /** O que chegou do Telegram, antes da leitura: último update e o veredito de silêncio. */
  activity: ChannelActivityState;
  /** Do post ao 📥, nos 30 dias. */
  latency: CaptureLatency;
};

type ChannelSource = {
  nome: string;
  slug: string;
  sharpMode: string;
  telegramChannelId: bigint | null;
  capturePausedAt: Date | null;
};

type CaptureRow = { source: string; captures: number; latest: Date | null };
/** Um POST já resolvido: a auditoria grava uma linha por tentativa de parse. */
type PostRow = { resource: string; capturado: boolean; motivo: string | null; count: number };
type SharpRow = {
  source: string;
  matched: number;
  manual: number;
  pending: number;
  unmatched: number;
  unsupported: number;
  total: number;
};
type NoOddsRow = {
  source: string;
  sharpReason: string | null;
  closingReason: string | null;
  clvReliable: boolean | null;
  frozen: boolean;
  count: number;
};

/**
 * Faltas de odds do canal pelo mesmo critério da coluna "Sem odds"
 * (`missingClvReason`): o motivo do fechamento primeiro, e nada quando o CLV
 * confiável já congelou. O que não se aplica (entrada ao vivo, múltipla, modo
 * da banca) não é falta e sai antes do top-3, para não tomar vaga de causa.
 */
function missingOddsBySource(rows: NoOddsRow[], now: Date): Map<string, Array<{ reason: string; count: number }>> {
  const counts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const reason = missingClvReason({
      clvReliable: row.clvReliable,
      closingFetchedAt: row.frozen ? now : null,
      noOddsReason: row.sharpReason,
      closingNoOddsReason: row.closingReason,
    });
    if (!reason || foraDaBaseDeCobertura(reason)) continue;
    const bySource = counts.get(row.source) ?? new Map<string, number>();
    bySource.set(reason, (bySource.get(reason) ?? 0) + row.count);
    counts.set(row.source, bySource);
  }
  return new Map([...counts].map(([source, byReason]) => [
    source,
    [...byReason].map(([reason, count]) => ({ reason, count })),
  ]));
}
type ResolutionRow = { source: string; samples: number; p50: number | null; p95: number | null };

export async function getChannelHealth(
  channels: ChannelSource[],
  now: Date,
): Promise<ChannelHealth[]> {
  if (channels.length === 0) return [];
  const sources = channels.map((channel) => telegramChannelSource(String(channel.telegramChannelId)));
  const resources = channels.map((channel) => String(channel.telegramChannelId));
  const since30d = new Date(now.getTime() - 30 * 86_400_000);
  const [rows, discarded, activity, latency] = await Promise.all([
    readChannelRows(sources, resources, now),
    listDiscardedChannelPosts(resources, since30d, DISCARDED_POSTS_VISIBLE),
    readChannelActivity(channels.flatMap((channel) => channel.telegramChannelId === null ? [] : [channel.telegramChannelId]), now),
    readCaptureLatency(sources, since30d),
  ]);
  const capturesBySource = new Map(rows.captures.map((row) => [row.source, row]));
  const sharpBySource = new Map(rows.sharp.map((row) => [row.source, row]));
  const resolutionBySource = new Map(rows.resolution.map((row) => [row.source, row]));
  const transientByResource = new Map(rows.transient.map((row) => [row.resource, row]));
  const missingOdds = missingOddsBySource(rows.noOdds, now);

  return channels.map((channel) => {
    const source = telegramChannelSource(String(channel.telegramChannelId));
    const resource = String(channel.telegramChannelId);
    const capture = capturesBySource.get(source) ?? { captures: 0, latest: null };
    const sharp = sharpBySource.get(source) ?? {
      matched: 0, manual: 0, pending: 0, unmatched: 0, unsupported: 0,
      total: 0,
    };
    const rendimento = rendimentoDoMotor(
      rows.posts
        .filter((row) => row.resource === resource)
        .map((row) => ({ capturado: row.capturado, motivo: row.motivo, n: row.count })),
    );
    const noOddsGroups = [...(missingOdds.get(source) ?? [])]
      .sort((left, right) => right.count - left.count)
      .slice(0, 3);
    const transient = transientByResource.get(resource) ?? {
      transientFailures: 0,
      preKickoffFailures: 0,
    };

    const resolved = sharp.matched + sharp.manual;
    const failed = sharp.unmatched + sharp.unsupported;
    // Banca OFF não resolve identidade: a captura sem `bet_sharp` não espera nada.
    const pending = sharp.pending
      + (channel.sharpMode === "OFF" ? 0 : Math.max(0, capture.captures - sharp.total));
    const resolution = resolutionBySource.get(source) ?? { samples: 0, p50: null, p95: null };

    return {
      bankrollNome: channel.nome,
      bankrollSlug: channel.slug,
      capturePaused: channel.capturePausedAt !== null,
      channelId: resource,
      capturas: capture.captures,
      ultimaCaptura: capture.latest,
      parse: {
        posts: rendimento.posts,
        ok: rendimento.gravadas,
        descartadas: rendimento.descartadas,
        tentativas: rendimento.tentativas,
        falhas: rendimento.perdidas,
        taxaOk: rendimento.taxa,
        perdas: [...rendimento.perdas],
      },
      identity: {
        resolved,
        pending,
        failed,
        total: resolved + pending + failed,
        taxaOk: resolved + failed > 0 ? (resolved / (resolved + failed)) * 100 : null,
      },
      odds: {
        faltas: noOddsGroups.map((group) => ({ reason: group.reason, n: group.count })),
      },
      resolution: { samples: resolution.samples, p50Min: resolution.p50, p95Min: resolution.p95 },
      preKickoffFailures: transient.preKickoffFailures,
      transientFailures: transient.transientFailures,
      transientBatchLimit: TRANSIENT_CHANNEL_REPROCESS_LIMIT,
      discarded: discarded.get(resource) ?? { total: 0, recent: [] },
      activity: activity.get(resource) ?? { lastUpdateAt: null, silence: { state: "aprendendo", lastPostAt: null } },
      latency: latency.get(source) ?? { samples: 0, p50Min: null, p95Min: null },
    };
  });
}

/** As leituras por canal: capturas, posts julgados, identidade, sem odds, tempo de resolução e transitórias. */
async function readChannelRows(sources: string[], resources: string[], now: Date) {
  const parseSince = new Date(now.getTime() - 30 * 86_400_000);
  const [captures, posts, sharp, noOdds, resolution, transient] = await Promise.all([
    prisma.$queryRaw<CaptureRow[]>(Prisma.sql`
      SELECT source, count(*)::int AS captures, max("registradoEm") AS latest
      FROM bets
      WHERE source IN (${Prisma.join(sources)}) AND "deletedAt" IS NULL
      GROUP BY source
    `),
    prisma.$queryRaw<PostRow[]>(Prisma.sql`
      WITH post AS (
        SELECT resource,
          bool_or(outcome IN (${DESFECHO_GRAVADO}, ${DESFECHO_REPETIDO})) AS capturado,
          (array_agg(details->>'reason' ORDER BY "createdAt" DESC))[1] AS motivo
        FROM audit_events
        WHERE action = 'telegram.parse'
          AND resource IN (${Prisma.join(resources)})
          AND "createdAt" >= ${parseSince}
        GROUP BY resource, "resourceId"
      )
      SELECT resource, capturado,
        CASE WHEN capturado THEN NULL ELSE motivo END AS motivo,
        count(*)::int AS count
      FROM post
      GROUP BY 1, 2, 3
    `),
    prisma.$queryRaw<SharpRow[]>(Prisma.sql`
      SELECT b.source,
        count(*) FILTER (WHERE s."identityStatus" = 'MATCHED')::int AS matched,
        count(*) FILTER (WHERE s."identityStatus" = 'MANUAL')::int AS manual,
        count(*) FILTER (WHERE s."identityStatus" = 'PENDING')::int AS pending,
        count(*) FILTER (WHERE s."identityStatus" = 'UNMATCHED')::int AS unmatched,
        -- A múltipla (motivo fora da base) não tem jogo único para casar: não é falha.
        count(*) FILTER (WHERE s."identityStatus" = 'UNSUPPORTED' AND (s."noOddsReason" IS NULL
          OR NOT (s."noOddsReason" = ANY(${[...MOTIVOS_FORA_DA_BASE]}::text[]))))::int AS unsupported,
        count(s."betId")::int AS total
      FROM bets b
      LEFT JOIN bet_sharp s ON s."betId" = b.id
      WHERE b.source IN (${Prisma.join(sources)}) AND b."deletedAt" IS NULL
      GROUP BY b.source
    `),
    prisma.$queryRaw<NoOddsRow[]>(Prisma.sql`
      SELECT b.source, s."noOddsReason" AS "sharpReason", c."noOddsReason" AS "closingReason",
        c."clvReliable" AS "clvReliable", (c."fetchedAt" IS NOT NULL) AS frozen, count(*)::int AS count
      FROM bets b
      JOIN bet_sharp s ON s."betId" = b.id
      LEFT JOIN bet_closing c ON c."betId" = b.id
      WHERE b.source IN (${Prisma.join(sources)})
        AND b."deletedAt" IS NULL
        AND (s."noOddsReason" IS NOT NULL OR c."noOddsReason" IS NOT NULL)
        AND s."identityStatus" IN ('MATCHED', 'MANUAL')
      GROUP BY 1, 2, 3, 4, 5
    `),
    prisma.$queryRaw<ResolutionRow[]>(Prisma.sql`
      SELECT b.source, count(*)::int AS samples,
        percentile_cont(0.50) WITHIN GROUP (
          ORDER BY extract(epoch FROM (s."identityResolvedAt" - b."registradoEm")) / 60
        )::float8 AS p50,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY extract(epoch FROM (s."identityResolvedAt" - b."registradoEm")) / 60
        )::float8 AS p95
      FROM bet_sharp s
      JOIN bets b ON b.id = s."betId"
      WHERE b.source IN (${Prisma.join(sources)})
        AND b."deletedAt" IS NULL
        AND s."identityResolvedAt" IS NOT NULL
        AND s."identityResolvedAt" >= ${parseSince}
      GROUP BY b.source
    `),
    countTransientBetsByChannel(resources, now),
  ]);
  return { captures, posts, sharp, noOdds, resolution, transient };
}

const CANAIS_ORFAOS_VISIVEIS = 20;

export type CanalOrfao = { channelId: string; postsPreservados: number; ultimaVez: Date };

/**
 * Canais com banca e sua saúde, mais os canais sem banca que mandaram posts
 * nos últimos 30 dias (preservados em auditoria), o mais recente primeiro.
 */
export async function getCanaisMonitorados(now: Date = new Date()): Promise<{
  canais: ChannelHealth[];
  orfaos: CanalOrfao[];
  /** Total depois de excluir canais que já têm banca; a lista visível para em 20. */
  orfaosTotal: number;
}> {
  const desde30d = new Date(now.getTime() - 30 * 86_400_000);
  const [bankrolls, postsSemBanca] = await Promise.all([
    prisma.bankroll.findMany({
      where: { telegramChannelId: { not: null } },
      select: { nome: true, slug: true, sharpMode: true, telegramChannelId: true, capturePausedAt: true },
    }),
    // Volume deduplicado de posts preservados, separado dos alertas consolidados em 6h.
    prisma.$queryRaw<CanalOrfao[]>`
      SELECT details->>'chatId' AS "channelId",
        count(*)::int AS "postsPreservados",
        max("createdAt") AS "ultimaVez"
      FROM audit_events
      WHERE action = 'canal_sem_bankroll_payload'
        AND resource = 'telegram_message'
        AND "createdAt" >= ${desde30d}
        AND details->>'chatId' IS NOT NULL
      GROUP BY details->>'chatId'
    `,
  ]);
  const canais = await getChannelHealth(bankrolls, now);
  const comBanca = new Set(bankrolls.map((c) => String(c.telegramChannelId)));
  const orfaos = postsSemBanca
    .filter((o) => !comBanca.has(o.channelId))
    .map(({ channelId, postsPreservados, ultimaVez }) => ({ channelId, postsPreservados, ultimaVez }))
    .sort((a, b) => b.ultimaVez.getTime() - a.ultimaVez.getTime());
  return { canais, orfaos: orfaos.slice(0, CANAIS_ORFAOS_VISIVEIS), orfaosTotal: orfaos.length };
}
