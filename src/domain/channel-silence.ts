/**
 * Quando o silêncio de um canal do Telegram é suspeito. Cada canal é medido
 * contra o próprio ritmo: um canal que posta de hora em hora e some por 8 h é
 * notícia; um que posta duas vezes por semana, não. Puro, sem I/O: quem lê
 * `telegram_channel_activity` é `services/capture/channel/channel-activity`.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Histórico que o ritmo do canal considera: as 4 semanas que terminam no
 * último post, não em agora. Contar até agora faria o próprio silêncio
 * encolher o histórico, e o canal morto voltaria a "aprendendo".
 */
export const SILENCE_HISTORY_DAYS = 28;
/** Antes disto o canal está "aprendendo": pouco post para dizer o que é normal. */
export const SILENCE_MIN_POSTS = 20;
export const SILENCE_MIN_DAYS = 7;
/** Nenhum alerta enquanto a tabela não tiver esta idade (ela nasce vazia no deploy). */
export const SILENCE_WARMUP_DAYS = 7;
/** Limites do dobro do p95: nem alarme por uma tarde calma, nem cego por semanas. */
export const SILENCE_FLOOR_HOURS = 6;
export const SILENCE_CEILING_HOURS = 96;
/** Folga sobre a pausa que se repete (fim de semana, intervalo entre dias de jogo). */
export const SILENCE_RECURRING_MARGIN = 1.25;

/** Bot inteiro: sem nenhum update há tanto tempo numa faixa do dia que costuma ter posts. */
export const BOT_SILENCE_HOURS = 2;
export const BOT_SILENCE_MIN_EXPECTED_POSTS = 5;
export const BOT_SILENCE_BASELINE_DAYS = 14;

export type PostHour = { hour: Date; posts: number };

export type ChannelSilence =
  | { state: "aprendendo"; lastPostAt: Date | null }
  | { state: "ok" | "mudo"; lastPostAt: Date; limitHours: number; silentHours: number };

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

/**
 * A maior pausa que aconteceu pelo menos duas vezes: o fim de semana do
 * canal que só posta em dia útil, a semana do canal que só posta em dia de
 * jogo. Uma pausa única (a queda de um dia) não vira ritmo.
 */
function recurringGap(gaps: readonly number[]): number {
  return [...gaps].sort((a, b) => b - a)[1] ?? 0;
}

/** A tabela já tem idade para julgar silêncio? */
export function silenceWarmedUp(historySince: Date | null, now: Date): boolean {
  return historySince !== null && now.getTime() - historySince.getTime() >= SILENCE_WARMUP_DAYS * DAY_MS;
}

/**
 * O limite é o maior entre o dobro do p95 do intervalo entre horas com post
 * (entre 6 h e 96 h) e a pausa que se repete, com folga. `hours` são as
 * horas do canal com post; `lastPostAt` é o último post recebido.
 */
export function channelSilence(input: {
  hours: readonly PostHour[];
  lastPostAt: Date | null;
  historySince: Date | null;
  now: Date;
}): ChannelSilence {
  const { lastPostAt, now } = input;
  if (!lastPostAt || !silenceWarmedUp(input.historySince, now)) return { state: "aprendendo", lastPostAt };
  const since = lastPostAt.getTime() - SILENCE_HISTORY_DAYS * DAY_MS;
  const window = input.hours.filter((row) => row.posts > 0 && row.hour.getTime() >= since && row.hour.getTime() <= lastPostAt.getTime());
  const hours = window.map((row) => row.hour.getTime()).sort((a, b) => a - b);
  const posts = window.reduce((total, row) => total + row.posts, 0);
  const days = new Set(hours.map((hour) => Math.floor(hour / DAY_MS))).size;
  if (posts < SILENCE_MIN_POSTS || days < SILENCE_MIN_DAYS) return { state: "aprendendo", lastPostAt };
  const gaps = hours.slice(1).map((hour, index) => (hour - (hours[index] ?? hour)) / HOUR_MS);
  const limitHours = Math.max(
    Math.min(SILENCE_CEILING_HOURS, Math.max(SILENCE_FLOOR_HOURS, 2 * percentile95(gaps))),
    SILENCE_RECURRING_MARGIN * recurringGap(gaps),
  );
  const silentHours = (now.getTime() - lastPostAt.getTime()) / HOUR_MS;
  return { state: silentHours > limitHours ? "mudo" : "ok", lastPostAt, limitHours, silentHours };
}

/**
 * O bot inteiro parou de receber: nenhum update de canal há 2 h numa faixa
 * do relógio que, nos últimos 14 dias, teve em média 5 posts ou mais.
 * `baselinePosts` é a soma desses 14 dias na mesma faixa.
 */
export function botSilence(input: {
  lastUpdateAt: Date | null;
  historySince: Date | null;
  baselinePosts: number;
  now: Date;
}): { silent: boolean; expectedPosts: number } {
  const expectedPosts = input.baselinePosts / BOT_SILENCE_BASELINE_DAYS;
  const quietFor = input.lastUpdateAt ? input.now.getTime() - input.lastUpdateAt.getTime() : Number.POSITIVE_INFINITY;
  return {
    silent: silenceWarmedUp(input.historySince, input.now)
      && quietFor >= BOT_SILENCE_HOURS * HOUR_MS
      && expectedPosts >= BOT_SILENCE_MIN_EXPECTED_POSTS,
    expectedPosts,
  };
}
