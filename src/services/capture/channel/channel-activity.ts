import { Prisma } from "@/src/generated/prisma/client";
import {
  BOT_SILENCE_BASELINE_DAYS,
  BOT_SILENCE_HOURS,
  botSilence,
  channelSilence,
  type ChannelSilence,
} from "@/src/domain/channel-silence";
import { CHANNEL_SOURCE_PREFIX } from "@/src/domain/telegram-source";
import { formatDurationMinutes } from "@/src/domain/dates";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { raiseOperationalAlertOnce } from "@/src/services/ops/alerts";
import { operationalActionFingerprint, reconcileOperationalActionSource } from "@/src/services/ops/operational-actions";
import { ACTIVE_OPERATIONAL_ACTION_STATUSES } from "@/src/domain/operational-action-status";

/**
 * Atividade dos canais contada na entrada do webhook (`telegram_channel_activity`)
 * e o vigia de silêncio que a lê. A contagem vem antes de qualquer leitura:
 * canal que parou de postar e Telegram que parou de entregar aparecem aqui
 * mesmo quando a captura não tem nada a dizer.
 */

const log = createLogger("tg-channel-activity");

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const CHANNEL_ACTIVITY_RETENTION_DAYS = 90;

const CHANNEL_SILENCE_SOURCE = "telegram.channel-silence";
const BOT_SILENCE_SOURCE = "telegram.bot-silence";

type ActivityKind = "post" | "edit" | "reaction";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const UPDATE_KINDS: ReadonlyArray<[string, ActivityKind]> = [
  ["channel_post", "post"],
  ["edited_channel_post", "edit"],
  ["message_reaction", "reaction"],
  ["message_reaction_count", "reaction"],
];

/** O canal e o tipo de um Update cru do Telegram; null para DM, grupo e o resto. */
export function channelActivityOf(update: unknown): { chatId: bigint; kind: ActivityKind } | null {
  const raw = record(update);
  for (const [key, kind] of UPDATE_KINDS) {
    const chat = record(record(raw?.[key])?.chat);
    if (!chat) continue;
    if (chat.type !== "channel") return null;
    const id = chat.id;
    if (typeof id === "number" && Number.isSafeInteger(id)) return { chatId: BigInt(id), kind };
    if (typeof id === "string" && /^-?\d+$/.test(id)) return { chatId: BigInt(id), kind };
    return null;
  }
  return null;
}

/** Soma o update na hora do canal. Reentrega do mesmo update não passa por aqui (a rota só conta o que entrou na fila). */
export async function recordChannelActivity(update: unknown, now = new Date()): Promise<void> {
  const activity = channelActivityOf(update);
  if (!activity) return;
  const hour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const posts = activity.kind === "post" ? 1 : 0;
  const edits = activity.kind === "edit" ? 1 : 0;
  const reactions = activity.kind === "reaction" ? 1 : 0;
  await prisma.$executeRaw`
    INSERT INTO telegram_channel_activity AS a ("chatId", hour, posts, edits, reactions, "lastUpdateAt", "lastPostAt")
    VALUES (${activity.chatId}, ${hour}, ${posts}, ${edits}, ${reactions}, ${now}, ${posts ? now : null}::timestamptz)
    ON CONFLICT ("chatId", hour) DO UPDATE SET
      posts = a.posts + EXCLUDED.posts,
      edits = a.edits + EXCLUDED.edits,
      reactions = a.reactions + EXCLUDED.reactions,
      "lastUpdateAt" = GREATEST(a."lastUpdateAt", EXCLUDED."lastUpdateAt"),
      "lastPostAt" = GREATEST(a."lastPostAt", EXCLUDED."lastPostAt")
  `;
}

/** Na rota do webhook: a contagem nunca atrasa nem derruba a resposta ao Telegram. */
export function recordChannelActivityInBackground(update: unknown): void {
  recordChannelActivity(update).catch((err: unknown) => {
    log.warn({ err }, "atividade do canal não gravada; o update seguiu para a fila");
  });
}

export async function purgeOldChannelActivity(now = new Date()): Promise<number> {
  const result = await prisma.telegramChannelActivity.deleteMany({
    where: { hour: { lt: new Date(now.getTime() - CHANNEL_ACTIVITY_RETENTION_DAYS * DAY_MS) } },
  });
  return result.count;
}

export type ChannelActivityState = {
  /** Último update de qualquer tipo (post, edição, reação) na retenção. */
  lastUpdateAt: Date | null;
  silence: ChannelSilence;
};

async function historySince(): Promise<Date | null> {
  const oldest = await prisma.telegramChannelActivity.findFirst({ orderBy: { hour: "asc" }, select: { hour: true } });
  return oldest?.hour ?? null;
}

/** Último update e veredito de silêncio de cada canal pedido, pela chave `String(chatId)`. */
export async function readChannelActivity(chatIds: readonly bigint[], now = new Date()): Promise<Map<string, ChannelActivityState>> {
  const result = new Map<string, ChannelActivityState>();
  if (chatIds.length === 0) return result;
  // O ritmo é medido até o último post, que pode ser antigo: lê toda a
  // retenção, só as horas com post.
  const [postHours, updates, since] = await Promise.all([
    prisma.telegramChannelActivity.findMany({
      where: { chatId: { in: [...chatIds] }, posts: { gt: 0 } },
      select: { chatId: true, hour: true, posts: true, lastPostAt: true },
      orderBy: { hour: "asc" },
    }),
    prisma.telegramChannelActivity.groupBy({
      by: ["chatId"],
      where: { chatId: { in: [...chatIds] } },
      _max: { lastUpdateAt: true },
    }),
    historySince(),
  ]);
  const lastUpdate = new Map(updates.map((row) => [String(row.chatId), row._max.lastUpdateAt]));
  for (const chatId of chatIds) {
    const own = postHours.filter((row) => row.chatId === chatId);
    const lastPostAt = own.reduce<Date | null>((max, row) => (row.lastPostAt && (!max || row.lastPostAt > max) ? row.lastPostAt : max), null);
    result.set(String(chatId), {
      lastUpdateAt: lastUpdate.get(String(chatId)) ?? null,
      silence: channelSilence({ hours: own, lastPostAt, historySince: since, now }),
    });
  }
  return result;
}

/**
 * Updates de canal nas últimas 24 h e a média diária dos últimos 8 dias,
 * contada só sobre o tempo que a tabela já existe (ela nasce vazia).
 * `dailyAverage` é null enquanto a tabela não tem 24 h.
 */
export async function readChannelUpdateVolume(now = new Date()): Promise<{ last24h: number; dailyAverage: number | null }> {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const [row] = await prisma.$queryRaw<Array<{ last24h: number; previous: number; oldest: Date | null }>>`
    SELECT
      coalesce(sum(posts + edits + reactions) FILTER (WHERE hour >= ${dayAgo}), 0)::int AS last24h,
      coalesce(sum(posts + edits + reactions) FILTER (WHERE hour < ${dayAgo} AND hour >= ${new Date(now.getTime() - 8 * DAY_MS)}), 0)::int AS previous,
      (SELECT min(hour) FROM telegram_channel_activity) AS oldest
    FROM telegram_channel_activity
  `;
  const oldest = row?.oldest ?? null;
  const days = oldest ? Math.min(8, (now.getTime() - oldest.getTime()) / DAY_MS) : 0;
  const last24h = row?.last24h ?? 0;
  return { last24h, dailyAverage: days >= 1 ? (last24h + (row?.previous ?? 0)) / days : null };
}

export type CaptureLatency = { samples: number; p50Min: number | null; p95Min: number | null };

/**
 * Do post ao 📥: `registradoEm − sourcePostedAt`, um valor por post (o lote
 * conta uma vez), sem as capturas que o dono pediu depois ("Capturar mesmo
 * assim"). Por origem, ou de todos os canais quando `sources` é null.
 */
export async function readCaptureLatency(
  sources: readonly string[] | null,
  since: Date,
): Promise<Map<string, CaptureLatency>> {
  const scope = sources === null
    ? Prisma.sql`b.source LIKE ${`${CHANNEL_SOURCE_PREFIX}%`}`
    : sources.length ? Prisma.sql`b.source IN (${Prisma.join([...sources])})` : Prisma.sql`FALSE`;
  const grouping = sources === null ? Prisma.sql`'*'` : Prisma.sql`source`;
  const rows = await prisma.$queryRaw<Array<{ source: string; samples: number; p50: number | null; p95: number | null }>>(Prisma.sql`
    WITH post AS (
      SELECT b.source, split_part(b."sourceExternalId", ':', 1) AS message,
        extract(epoch FROM (min(b."registradoEm") - min(b."sourcePostedAt"))) / 60 AS minutes
      FROM bets b
      LEFT JOIN bet_capture_evidence e ON e."betId" = b.id
      WHERE ${scope}
        AND b."sourcePostedAt" IS NOT NULL
        AND b."sourceExternalId" IS NOT NULL
        AND b."registradoEm" >= ${since}
        AND coalesce(e."parsedJson"->>'forcedByOperator', 'false') <> 'true'
      GROUP BY 1, 2
    )
    SELECT ${grouping} AS source, count(*)::int AS samples,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY greatest(minutes, 0))::float8 AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY greatest(minutes, 0))::float8 AS p95
    FROM post
    GROUP BY 1
  `);
  return new Map(rows.map((row) => [row.source, { samples: row.samples, p50Min: row.p50, p95Min: row.p95 }]));
}

/** Canais que o vigia acompanha: os que têm banca. */
/** Canal com banca e captura ativa: o dono pausou o canal que não quer ouvir. */
const WATCHED_BANKROLLS: Prisma.BankrollWhereInput = { telegramChannelId: { not: null }, capturePausedAt: null };

/** Cada canal vigiado com o veredito de silêncio de agora. */
export async function watchedChannels(now = new Date()): Promise<Array<{ id: string; nome: string; chatId: bigint; silence: ChannelSilence }>> {
  const bankrolls = await prisma.bankroll.findMany({ where: WATCHED_BANKROLLS, select: { id: true, nome: true, telegramChannelId: true }, orderBy: { nome: "asc" } });
  const channels = bankrolls.flatMap((bankroll) => bankroll.telegramChannelId === null ? [] : [{ id: bankroll.id, nome: bankroll.nome, chatId: bankroll.telegramChannelId }]);
  const activity = await readChannelActivity(channels.map((channel) => channel.chatId), now);
  return channels.map((channel) => ({
    ...channel,
    silence: activity.get(String(channel.chatId))?.silence ?? { state: "aprendendo", lastPostAt: null },
  }));
}

/** Canais cujo alerta de silêncio segue aberto sem post desde que abriu. */
async function openSilenceAlertsWithoutPost(
  channels: ReadonlyArray<{ chatId: bigint; silence: ChannelSilence }>,
): Promise<string[]> {
  if (channels.length === 0) return [];
  const byFingerprint = new Map(channels.map((channel) => [operationalActionFingerprint(CHANNEL_SILENCE_SOURCE, String(channel.chatId)), channel]));
  const open = await prisma.operationalAction.findMany({
    where: { fingerprint: { in: [...byFingerprint.keys()] }, status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] } },
    select: { fingerprint: true, openedAt: true, reopenedAt: true },
  });
  return open.flatMap((action) => {
    const channel = byFingerprint.get(action.fingerprint);
    const since = action.reopenedAt ?? action.openedAt;
    const posted = channel?.silence.lastPostAt && channel.silence.lastPostAt > since;
    return channel && !posted ? [String(channel.chatId)] : [];
  });
}

const hoursLabel = (hours: number) => formatDurationMinutes(hours * 60);

/**
 * `telegram.silence_watch`: alerta o canal calado além do próprio ritmo e o
 * bot que parou de receber. Os alertas fecham sozinhos quando o post volta;
 * com o bot calado, os de canal ficam como estão, porque a causa é uma só.
 */
export async function runSilenceWatch(now = new Date()): Promise<{ botSilent: boolean; mutedChannels: number }> {
  const [since, lastUpdate, baseline] = await Promise.all([
    historySince(),
    prisma.telegramChannelActivity.aggregate({ _max: { lastUpdateAt: true } }),
    prisma.$queryRaw<Array<{ posts: number }>>`
      SELECT coalesce(sum(a.posts), 0)::int AS posts
      FROM generate_series(1, ${BOT_SILENCE_BASELINE_DAYS}) AS d
      JOIN telegram_channel_activity a
        ON a.hour >= ${now}::timestamptz - make_interval(days => d, hours => ${BOT_SILENCE_HOURS})
       AND a.hour < ${now}::timestamptz - make_interval(days => d)
    `,
  ]);
  const bot = botSilence({ lastUpdateAt: lastUpdate._max.lastUpdateAt, historySince: since, baselinePosts: baseline[0]?.posts ?? 0, now });
  if (bot.silent) {
    const quiet = lastUpdate._max.lastUpdateAt ? (now.getTime() - lastUpdate._max.lastUpdateAt.getTime()) / HOUR_MS : null;
    await raiseOperationalAlertOnce(
      "🔇 Nenhum post do Telegram chegando\n" +
        `Nenhum update de canal ${quiet === null ? "registrado" : `há ${hoursLabel(quiet)}`}, num horário que costuma ter uns ${Math.round(bot.expectedPosts)} posts.\n` +
        "👉 Confira o webhook em Monitoramento e se o bot segue admin dos canais.",
      { source: BOT_SILENCE_SOURCE, key: "bot", title: "Telegram sem entregar posts", evidence: { expectedPosts: Math.round(bot.expectedPosts) } },
    );
    return { botSilent: true, mutedChannels: 0 };
  }
  await reconcileOperationalActionSource(BOT_SILENCE_SOURCE, [], now);

  const channels = await watchedChannels(now);
  const muted: string[] = [];
  for (const { silence, ...channel } of channels) {
    if (silence.state !== "mudo") continue;
    muted.push(String(channel.chatId));
    await raiseOperationalAlertOnce(
      `🔇 Canal calado · ${channel.nome}\n` +
        `Nenhum post há ${hoursLabel(silence.silentHours)}; no ritmo dele, o normal é postar em até ${hoursLabel(silence.limitHours)}.\n` +
        "👉 Confira se o canal segue ativo e se o bot ainda é admin dele. O aviso fecha sozinho quando o próximo post chegar.",
      {
        source: CHANNEL_SILENCE_SOURCE, key: String(channel.chatId), title: `${channel.nome}: canal calado`,
        resource: "bankroll", resourceId: channel.id,
        evidence: { lastPostAt: silence.lastPostAt.toISOString(), limitHours: Math.round(silence.limitHours) },
      },
    );
  }
  // Só o post fecha o alerta: canal morto há meses fica sem horas no
  // histórico e volta a "aprendendo", mas continua calado.
  const stillSilent = await openSilenceAlertsWithoutPost(channels.filter((channel) => !muted.includes(String(channel.chatId))));
  await reconcileOperationalActionSource(CHANNEL_SILENCE_SOURCE, [...muted, ...stillSilent], now);
  return { botSilent: false, mutedChannels: muted.length };
}
