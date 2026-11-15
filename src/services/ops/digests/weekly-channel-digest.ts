import { comparaDecisao } from "@/src/domain/analyzer/decisao";
import { AMOSTRA_MINIMA_CLV, VEREDITO_RANK, VEREDITO_ROTULO, type EdgeVeredito } from "@/src/domain/analyzer/shared";
import { latestCronFiring } from "@/src/domain/cron-cadence";
import { formatSpDateTime, SAO_PAULO_UTC_OFFSET_HOURS } from "@/src/domain/dates";
import { fmtPct, fmtPp } from "@/src/domain/formato-de-resultado";
import { prisma } from "@/src/infra/prisma";
import { createLogger } from "@/src/infra/logger";
import { queryChannelDecisions, type ChannelDecision } from "@/src/services/bankrolls/channel-decision";
import { sendRequiredOperatorNotification } from "@/src/services/ops/alerts";
import { DIGEST_MAX_CHARS, truncatePendingDigestMessage } from "@/src/services/ops/digests/pending-digest";

const log = createLogger("weekly-channel-digest");

/**
 * Boletim semanal dos canais no Telegram: a régua de cada canal que teve
 * movimento nos últimos 7 dias, na ordem de Bancas, e quem mudou de veredito
 * nesse tempo. Os números saem de `queryChannelDecisions`, o agregado de
 * Bancas e do aviso 📥; a semana é a régua de agora menos a
 * de 7 dias atrás (`asOf`), sem uma segunda consulta que pudesse divergir.
 *
 * Semana sem aposta de canal não manda nada: um boletim vazio toda segunda
 * ensina a não ler o que chega.
 */

/** Segunda às 09:00 de São Paulo, no manifesto do worker. */
export const WEEKLY_CHANNEL_DIGEST_CRON = "0 9 * * 1";

const WEEK_MS = 7 * 86_400_000;
// Depois da entrega, a trava por disparo cobre as retentativas do job e da
// dead-letter (horas). Durante o envio ela é curta (ver
// sendRequiredOperatorNotification): o processo que morre no meio não leva o
// boletim da semana junto.
const DEDUPE_MS = 86_400_000;
// O pg-boss decide que o disparo venceu pelo relógio do banco; um worker um
// pouco atrasado ainda precisa achar o disparo de hoje, e não o da semana passada.
const CLOCK_SKEW_MS = 60_000;

/**
 * Fechamentos confiáveis exigidos em cada janela de 30 dias (a recente e a
 * anterior) para destacar a troca de veredito. Com menos, a troca é o teste
 * oscilando na borda com pouca amostra nova, e o destaque seria ruído.
 */
const VERDICT_CHANGE_MIN_WINDOW_SAMPLE = 20;

/**
 * No máximo 15 canais na lista. O nome vai até 128 caracteres, e com nomes
 * longos cabem menos: a lista para antes de a mensagem passar do teto, para
 * a linha dos que faltam não ser a que o corte leva.
 */
const MAX_LISTED_CHANNELS = 15;

type ChannelWeek = {
  channel: ChannelDecision;
  previousVeredito: EdgeVeredito;
  bets: number;
  nClv: number;
  clv: number | null;
};

type WeeklyChannelDigest = {
  /** `null` quando nenhum canal teve aposta na semana. */
  message: string | null;
  channels: number;
  verdictChanges: number;
};

const clvSum = (decisao: ChannelDecision["decisao"] | undefined) =>
  decisao?.clvMedio != null ? decisao.clvMedio * decisao.nClv : 0;

/**
 * Sem amostra anterior, o canal nasceu nesta semana; a base nunca é negativa.
 */
function weekOf(current: ChannelDecision, weekAgo: ChannelDecision | undefined): ChannelWeek {
  const past = weekAgo?.decisao;
  const nClv = Math.max(0, current.decisao.nClv - (past?.nClv ?? 0));
  return {
    channel: current,
    previousVeredito: past?.veredito ?? "AMOSTRA_CURTA",
    bets: Math.max(0, current.decisao.apostas - (past?.apostas ?? 0)),
    nClv,
    clv: nClv > 0 ? (clvSum(current.decisao) - clvSum(past)) / nClv : null,
  };
}

function isNotableVerdictChange({ channel, previousVeredito }: ChannelWeek): boolean {
  const { veredito, n30d, n30a60d } = channel.decisao;
  return veredito !== previousVeredito
    && n30d >= VERDICT_CHANGE_MIN_WINDOW_SAMPLE
    && n30a60d >= VERDICT_CHANGE_MIN_WINDOW_SAMPLE;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const charCount = (text: string) => Array.from(text).length;
const omittedLine = (omitted: number) => `… e mais ${plural(omitted, "canal", "canais")}; veja Tipsters no painel.`;

function verdictChangeLine({ channel, previousVeredito }: ChannelWeek): string {
  const { veredito, deltaClv30d, n30d, n30a60d } = channel.decisao;
  const arrow = VEREDITO_RANK[veredito] < VEREDITO_RANK[previousVeredito] ? "⬆️" : "⬇️";
  return `${arrow} ${channel.nome}: ${VEREDITO_ROTULO[previousVeredito]} → ${VEREDITO_ROTULO[veredito]}`
    + ` · Δ 30d ${fmtPp(deltaClv30d)} (n ${n30d}/${n30a60d})`;
}

/** Os mesmos números da decisão de assinatura de Bancas, cada um com a amostra que o sustenta. */
function channelLines(week: ChannelWeek, position: number): string[] {
  const { nome, decisao } = week.channel;
  const sample = decisao.nClv < AMOSTRA_MINIMA_CLV ? `n ${decisao.nClv} de ${AMOSTRA_MINIMA_CLV}` : `n ${decisao.nClv}`;
  const ruler = [
    decisao.nClv > 0 ? `CLV ${fmtPct(decisao.clvMedio)} (${sample})` : `nenhum fechamento (${sample})`,
    decisao.beatClosePct !== null ? `beat-close ${Math.round(decisao.beatClosePct)}%` : null,
    decisao.roiReal !== null ? `ROI ${fmtPct(decisao.roiReal)} (n ${decisao.nFinal})` : null,
  ];
  const weekParts = [
    plural(week.bets, "aposta", "apostas"),
    week.nClv > 0 ? `CLV ${fmtPct(week.clv)} (n ${week.nClv})` : "nenhum fechamento",
  ];
  return [
    `${position}. ${nome} · ${VEREDITO_ROTULO[decisao.veredito]}`,
    `• ${ruler.filter(Boolean).join(" · ")}`,
    `• Na semana: ${weekParts.join(" · ")}`,
  ];
}

/**
 * O boletim a partir da régua de agora e da de 7 dias atrás. Entra o canal
 * com aposta ou fechamento na semana; a banca sem canal do Telegram fica de
 * fora.
 */
export function buildWeeklyChannelDigest(
  current: readonly ChannelDecision[],
  weekAgo: readonly ChannelDecision[],
  now: Date,
): WeeklyChannelDigest {
  const weekAgoById = new Map(weekAgo.map((channel) => [channel.id, channel]));
  const weeks = current
    .filter((channel) => channel.temCanal)
    .map((channel) => weekOf(channel, weekAgoById.get(channel.id)))
    .filter((week) => week.bets > 0 || week.nClv > 0)
    .sort((a, b) => comparaDecisao(a.channel.decisao, b.channel.decisao));
  if (!weeks.some((week) => week.bets > 0)) return { message: null, channels: 0, verdictChanges: 0 };

  const changes = weeks.filter(isNotableVerdictChange);
  const lines = [`📊 Boletim semanal dos canais · 7 dias até ${formatSpDateTime(now)}`];
  if (changes.length > 0) {
    lines.push("", "🔀 Mudou de veredito", ...changes.map(verdictChangeLine));
    if (changes.some((week) => week.channel.decisao.veredito === "SEM_EDGE")) {
      lines.push("👉 Para parar um canal sem perder o histórico de CLV, pause-o em Config › Tipsters.");
    }
  }
  lines.push("", "📋 Canais com movimento, na ordem de Tipsters");
  // Cada canal entra se couber junto com a linha dos que ainda faltariam.
  const omittedReserve = 1 + charCount(omittedLine(weeks.length));
  let size = charCount(lines.join("\n"));
  let listed = 0;
  for (const week of weeks.slice(0, MAX_LISTED_CHANNELS)) {
    const block = channelLines(week, listed + 1).join("\n");
    const reserve = listed + 1 < weeks.length ? omittedReserve : 0;
    if (size + 1 + charCount(block) + reserve > DIGEST_MAX_CHARS) break;
    lines.push(block);
    size += 1 + charCount(block);
    listed += 1;
  }
  const omitted = weeks.length - listed;
  if (omitted > 0) lines.push(omittedLine(omitted));
  return { message: lines.join("\n"), channels: weeks.length, verdictChanges: changes.length };
}

/**
 * O boletim do disparo mais recente do cron. A retentativa do job e a da
 * dead-letter (até horas depois) refazem esse mesmo disparo: o cabeçalho e a
 * semana saem dele, e não da hora da execução, e a entrega é uma por disparo,
 * porque entre uma execução e outra os números podem ter mudado.
 */
export async function sendWeeklyChannelDigest(now = new Date()): Promise<Omit<WeeklyChannelDigest, "message"> & { sent: boolean }> {
  const firing = latestCronFiring(
    WEEKLY_CHANNEL_DIGEST_CRON,
    new Date(now.getTime() - WEEK_MS),
    new Date(now.getTime() + CLOCK_SKEW_MS),
    SAO_PAULO_UTC_OFFSET_HOURS,
  );
  if (!firing) throw new Error("boletim semanal sem disparo do cron nos 7 dias até agora");
  const [current, weekAgo] = await prisma.$transaction(async (tx) => [
    await queryChannelDecisions(firing, { asOf: true }, tx),
    await queryChannelDecisions(new Date(firing.getTime() - WEEK_MS), { asOf: true }, tx),
  ], { isolationLevel: "RepeatableRead", timeout: 20_000 });
  const { message, channels, verdictChanges } = buildWeeklyChannelDigest(current, weekAgo, firing);
  if (!message) {
    log.info("nenhum canal com aposta na semana: boletim semanal não enviado");
    return { sent: false, channels, verdictChanges };
  }
  // Última trava: muitas trocas de veredito com nome longo ainda passam do teto.
  const delivery = await sendRequiredOperatorNotification(
    truncatePendingDigestMessage(message, DIGEST_MAX_CHARS, "Tipsters"),
    { key: `weekly-channel-digest:${firing.toISOString()}`, forMs: DEDUPE_MS },
  );
  log.info(
    { channels, verdictChanges, delivery, firing: firing.toISOString() },
    delivery === "deduplicated" ? "boletim semanal deste disparo já tinha saído" : "boletim semanal dos canais entregue",
  );
  return { sent: true, channels, verdictChanges };
}
