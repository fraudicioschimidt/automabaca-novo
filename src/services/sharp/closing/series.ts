import type { PgBoss } from "pg-boss";
import { createHash } from "node:crypto";
import type { ClosingPriceWatch, PriceArchiveObservation, Prisma } from "@/src/generated/prisma/client";
import { canonicalJson, canonicalSha256 } from "@/src/domain/canonical-json";
import { formatSpDateTime, spDayKey } from "@/src/domain/dates";
import { entrouAoVivo } from "@/src/domain/entrada-ao-vivo";
import { sameKickoff } from "@/src/domain/kickoff-infer";
import type { NoOddsReason } from "@/src/domain/no-odds-reason";
import { linhaClv } from "@/src/domain/mensagem-operador";
import { toNumber } from "@/src/domain/money";
import { percentualContraFair } from "@/src/domain/odds";
import { assertPriceProvenance } from "@/src/domain/price-provenance";
import { BudgetExhaustedError } from "@/src/domain/provider-error";
import { normalizeStr } from "@/src/domain/text";
import { getSharedBoss } from "@/src/infra/boss";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { QUEUES } from "@/src/infra/queue-contract";
import { chargeClosingSeriesBudget, chargeProviderRequest } from "@/src/providers/budget";
import { oddsProviders } from "@/src/providers/coverage";
import {
  fetchPinnacle17Odds,
  findPinnacle17EventById,
  pinnacle17Enabled,
  type Pinnacle17Deadline,
} from "@/src/providers/pinnacle17/client";
import { resolvePinnacle17CurrentOdds } from "@/src/providers/pinnacle17/odds";
import {
  normalizePinnacle17Markets,
  parsePinnacle17PriceReference,
  pinnacle17SportId,
  sanitizePinnacle17Event,
  type Pinnacle17Event,
  type Pinnacle17Market,
} from "@/src/providers/pinnacle17/types";
import { unpackPriceResponse } from "@/src/providers/price-archive/codec";
import { priceArchiveConfig } from "@/src/providers/price-archive/config";
import { purgePriceArchive } from "@/src/providers/price-archive/store";
import { readProviderCache } from "@/src/providers/provider-cache";
import { raiseOperationalAlertOnce, sendOperatorNotification } from "@/src/services/ops/alerts";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { maxBetCurrencyForProvider } from "@/src/services/sharp/liquidity-currency";
import { anySegmentSharpOff } from "@/src/services/sharp/segment-policy";
import {
  capturePinnacle17Closing,
  persistedPinnacle17Event,
  pinnedPinnacle17Reference,
  type Pinnacle17ClosingCapture,
} from "./pinnacle17-clv";
import type { SnapshotBet } from "./pinnacle17-snapshot";

/**
 * Fechamento da Pinnacle17, o único caminho que grava o preço dela em
 * `bet_closing`. A agenda (`closing_price_watches`) nasce quando o enrich
 * confirma a identidade:
 * - aos 90 e aos 45 min do kickoff confere o horário no feed de jogos, sem
 *   consulta de odds; o jogo remarcado muda o kickoff e a agenda recomeça no
 *   horário novo;
 * - aos 5 min consulta com a reserva de fechamento (a da identidade, se for do
 *   mesmo dia de São Paulo; senão uma nova, do orçamento geral do dia);
 * - aos 3 min, 1:45 e 30 s consulta com o orçamento diário próprio das extras
 *   (até 5, a última guardada para os 30 s).
 * Depois do apito o `closing.sync` congela o que a série gravou, e a
 * recuperação pelo arquivo completa o que faltou. A cotação mais recente antes
 * do kickoff vence; decisão manual nunca é sobrescrita.
 *
 * O arquivo guarda toda resposta `/match/odds` que o sistema pagou, venha de
 * onde vier. Por ele uma aposta aproveita a consulta de outra do mesmo jogo, o
 * worker recupera o preço depois de reiniciar, e a aposta corrigida (ou que só
 * teve a identidade confirmada) depois do kickoff ainda fecha sem HTTP.
 */

const stateLog = createLogger("closing-series-state");
const scheduleLog = createLogger("closing-series-schedule");
const log = createLogger("closing-series");
/** Só vale cotação observada na última hora antes do kickoff. */
const CLOSING_QUOTE_WINDOW_MS = 3_600_000;
/**
 * Só a cotação dos últimos 10 min é o fechamento: mais cedo a linha ainda se
 * move, e o preço fica gravado sem CLV confiável até chegar uma mais nova.
 */
const CLOSING_RELIABLE_WINDOW_MS = 10 * 60_000;
const TOO_EARLY: NoOddsReason = "closing_quote_too_early";
/** Remarcação maior que isto não muda o kickoff sozinha: vira ação para o dono. */
const KICKOFF_MOVE_MAX_MS = 3 * 3_600_000;
const KICKOFF_MOVED_BY_PROVIDER_ACTION = "bet.kickoff_moved_by_provider";

const CLOSING_EXTRA_ATTEMPTS = 5;
const CLOSING_EXTRA_COOLDOWN_MS = 30_000;
const CLOSING_SERIES_RETENTION_MS = 30 * 86_400_000;
const CLOSING_RECOVERY_MS = 86_400_000;
/** Os pontos de consulta antes do kickoff; o primeiro usa a reserva de fechamento, os outros o orçamento extra. */
const CLOSING_FINAL_OFFSETS = [300_000, 180_000, 105_000, 30_000] as const;
const PRIMARY_OFFSET_MS = CLOSING_FINAL_OFFSETS[0];
/**
 * As conferências do horário, antes das consultas: o jogo antecipado ainda tem
 * os quatro pontos no horário novo. Duas porque a de 45 min sozinha perde o
 * jogo antecipado entre 45 e 55 min, que já teria começado nela.
 */
const SCHEDULE_CHECK_OFFSETS = [90 * 60_000, 45 * 60_000] as const;
/** Posse de uma volta da agenda; a consulta primária (25 s e uma retentativa) cabe nela. */
const WATCH_LEASE_MS = 45_000;
const PRIMARY_ATTEMPT_TIMEOUT_MS = 25_000;
const CLOSING_WATCH_CAP = 20_000;
/** Recusas das extras que são falta de orçamento, e não de posse, cadência ou tentativa guardada. */
const EXTRAS_OUT_OF_BUDGET = new Set(["closing-series-daily-cap", "closing-series-normal-headroom"]);
export function closingSeriesConfig() {
  return { dailyCap: getEnv().CLOSING_SERIES_DAILY_CAP ?? 500 };
}

export async function readClosingBet(betId: string, db: Prisma.TransactionClient = prisma) {
  const bet = await db.bet.findUnique({ where: { id: betId } });
  if (!bet) return null;
  const bankroll = await db.bankroll.findUnique({ where: { id: bet.bankrollId }, select: { id: true, sharpMode: true, sharpModeChangedAt: true } });
  const sharp = await db.betSharp.findUnique({ where: { betId } });
  const closing = await db.betClosing.findUnique({ where: { betId } });
  const evidence = await db.betCaptureEvidence.findUnique({ where: { betId }, select: { caption: true, mediaFileId: true, expiresAt: true } });
  const prop = await db.betPlayerProp.findUnique({ where: { betId }, select: { betId: true } });
  return { ...bet, bankroll, sharp, closing, evidence, prop };
}
export type ClosingBet = NonNullable<Awaited<ReturnType<typeof readClosingBet>>>;
type EligibleClosingBet = ClosingBet & { bankroll: NonNullable<ClosingBet["bankroll"]> };

/**
 * Aposta de um jogo só, com identidade numérica da Pinnacle17, em banca que
 * mede CLV, com esporte confirmado, horário real e entrada antes do kickoff.
 */
export function closingBetEligible(bet: ClosingBet | null): bet is EligibleClosingBet {
  return Boolean(bet && !bet.deletedAt && !bet.notTakenAt && bet.bankroll
    && bet.bankroll.sharpMode === "CLV_ONLY" && bet.sportResolutionStatus === "CONFIRMED"
    && !bet.kickoffInferido && !bet.legsJson && !bet.prop && !bet.evento.includes(" | ")
    && (bet.sourcePostedAt ?? bet.registradoEm).getTime() < bet.data.getTime()
    && bet.sharp?.provider === "pinnacle17" && ["MATCHED", "MANUAL"].includes(bet.sharp.identityStatus)
    && /^\d+$/.test(bet.sharp.providerMatchId ?? "") && bet.closing?.source !== "MANUAL"
    && oddsProviders(bet).includes("pinnacle17")
    && !entrouAoVivo({ ...bet, kickoff: bet.data }));
}
/** Medição de preço ligada no segmento, lida dentro da transação de quem decide. */
async function segmentPriceEnabled(bet: ClosingBet, db: Prisma.TransactionClient = prisma) {
  return !await anySegmentSharpOff(db, bet.esporte, bet.mercado);
}
/**
 * Cotação só vale se observada depois que a aposta existia e depois
 * da última troca do modo de medição da banca: o modo vigente é o de agora
 * (ele pode ter ido a OFF e voltado). O arquivo exige também o pedido após
 * esse corte. Editar nome, esportes ou pausa não conta.
 */
function closingSince(bet: ClosingBet): Date {
  return new Date(Math.max(bet.registradoEm.getTime(), bet.bankroll?.sharpModeChangedAt?.getTime() ?? 0));
}
function closingSourceHash(bet: ClosingBet) {
  return createHash("sha256").update(canonicalJson({ betId: bet.id, bankrollId: bet.bankrollId,
    source: bet.source, externalId: bet.sourceExternalId, postedAt: (bet.sourcePostedAt ?? bet.registradoEm).toISOString(),
    caption: bet.evidence?.caption ?? null, media: bet.evidence?.mediaFileId ?? null })).digest("hex");
}
export function closingContextHash(bet: ClosingBet) {
  return canonicalSha256({ betId: bet.id, source: closingSourceHash(bet), bankrollId: bet.bankrollId,
    mode: bet.bankroll?.sharpMode, modeChangedAt: bet.bankroll?.sharpModeChangedAt?.toISOString() ?? null, evento: bet.evento,
    esporte: bet.esporte, mercado: bet.mercado, selecao: bet.selecao, kickoff: bet.data.toISOString(),
    odds: toNumber(bet.odds), provider: bet.sharp?.provider, eventId: bet.sharp?.providerMatchId,
    reference: bet.sharp?.priceReference ?? null });
}
export function matchesClosingInput(current: ClosingBet, input: SnapshotBet) {
  return current.id === input.id && current.evento === input.evento && current.esporte === input.esporte
    && current.mercado === input.mercado && current.selecao === input.selecao
    && current.data.getTime() === input.data.getTime() && toNumber(current.odds) === toNumber(input.odds)
    && current.sharp?.provider === input.sharp?.provider && current.sharp?.providerMatchId === input.sharp?.providerMatchId
    && (current.sharp?.priceReference ?? null) === (input.sharp?.priceReference ?? null)
    && (current.sourcePostedAt ?? current.registradoEm).getTime() === (input.sourcePostedAt ?? input.registradoEm).getTime();
}
export function nextClosingOpportunity(kickoff: Date, now: Date, failed: boolean, attempts: number) {
  const future = CLOSING_FINAL_OFFSETS.map((ms) => kickoff.getTime() - ms).find((at) => at > now.getTime());
  if (now >= kickoff) return new Date(now.getTime() + 300_000);
  if (attempts >= CLOSING_EXTRA_ATTEMPTS) return new Date(kickoff.getTime() + 10_000);
  if (attempts === CLOSING_EXTRA_ATTEMPTS - 1 && now.getTime() < kickoff.getTime() - 30_000)
    return new Date(kickoff.getTime() - 30_000); // Guarda uma tentativa para o último ponto.
  const retry = failed && now.getTime() + CLOSING_EXTRA_COOLDOWN_MS < kickoff.getTime() - 5_000
    ? now.getTime() + CLOSING_EXTRA_COOLDOWN_MS : Infinity;
  return new Date(Math.min(future ?? Infinity, retry, kickoff.getTime() + 10_000));
}
export type ClosingQuote = Pinnacle17ClosingCapture & { archiveId?: string; archiveSha?: string };

function closingEvent(bet: ClosingBet): Pinnacle17Event | null {
  const id = Number(bet.sharp?.providerMatchId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return persistedPinnacle17Event(bet, id);
}
/**
 * A cotação de fechamento que a resposta dá para a aposta ou, sem ela, o motivo
 * da resposta: o mercado que ela não lista, a linha que não é a da aposta. O
 * motivo é null quando a resposta nem vale para a aposta (fora da janela,
 * evento ou referência inválidos).
 */
function resolveClosing(bet: ClosingBet, markets: Pinnacle17Market[], observedAt: Date):
  { quote: ClosingQuote } | { quote: null; miss: NoOddsReason | null } {
  const event = closingEvent(bet), rawReference = bet.sharp?.priceReference ?? null;
  const reference = parsePinnacle17PriceReference(rawReference);
  if (!event || rawReference && !reference || observedAt < closingSince(bet) || observedAt >= bet.data
    || observedAt.getTime() < bet.data.getTime() - CLOSING_QUOTE_WINDOW_MS) return { quote: null, miss: null };
  const resolved = resolvePinnacle17CurrentOdds({ event, markets, esporte: bet.esporte,
    mercado: bet.mercado, selecao: bet.selecao, observedAt, now: observedAt });
  if (!resolved.ok) return { quote: null, miss: resolved.reason === "stale_price" ? null : resolved.reason };
  const next = pinnedPinnacle17Reference(reference, resolved.value.reference);
  // A linha que a resposta tem não é a da referência gravada na entrada.
  if (rawReference && rawReference !== next) return { quote: null, miss: "line_mismatch" };
  return { quote: { ...resolved.value.current, reference: next, observedAt, gameStartAt: resolved.value.gameStartAt } };
}
export function resolveClosingMarkets(bet: ClosingBet, markets: Pinnacle17Market[], observedAt: Date): ClosingQuote | null {
  return resolveClosing(bet, markets, observedAt).quote;
}
async function cachedClosingQuote(bet: ClosingBet, now: Date) {
  const cache = await readProviderCache<Pinnacle17Market[]>({ provider: "pinnacle17", key: `odds:${bet.sharp?.providerMatchId}:prematch:v2`, now });
  return cache && cache.fetchedAt <= now && Array.isArray(cache.data) ? resolveClosingMarkets(bet, cache.data, cache.fetchedAt) : null;
}
type ArchivedClosingResponse = { id: string; sha256: string; observedAt: Date; markets: Pinnacle17Market[] };

/**
 * Respostas `/match/odds` guardadas do jogo da aposta, da mais nova para a mais
 * velha, observadas de `from` até o kickoff: pedidas depois que a aposta existia
 * e depois da última troca do modo da banca, do mesmo evento, no mesmo horário
 * e antes do início.
 */
async function* archivedClosingResponses(bet: EligibleClosingBet, from: Date, now: Date): AsyncGenerator<ArchivedClosingResponse> {
  const eventId = bet.sharp?.providerMatchId;
  if (!priceArchiveConfig().enabled || !eventId) return;
  const ids = await prisma.priceArchiveObservation.findMany({ where: { provider: "pinnacle17", eventIds: { has: eventId },
    requestedAt: { gte: closingSince(bet) }, observedAt: { gte: from, lt: bet.data, lte: now },
    expiresAt: { gt: now } }, orderBy: [{ observedAt: "desc" }, { id: "asc" }], select: { id: true }, take: 64 });
  for (const { id } of ids) {
    const row = await prisma.priceArchiveObservation.findUnique({ where: { id } });
    if (!row) continue;
    const response = await decodeClosingResponse(row, bet);
    if (response) yield response;
  }
}

/** A mesma atribuição do arquivo é conferida na busca e no commit sob lock. */
async function decodeClosingResponse(row: PriceArchiveObservation, bet: EligibleClosingBet): Promise<ArchivedClosingResponse | null> {
  const eventId = bet.sharp?.providerMatchId;
  const e = await unpackPriceResponse(row);
  if (!e || e.provider !== "pinnacle17" || e.endpoint !== "/api/pinnacle/v1/match/odds"
    || e.context.host !== "pinnacle17.p.rapidapi.com"
    || !eventId || !e.eventIds.includes(eventId)
    || String((e.context.query as Record<string, unknown> | null)?.match_id) !== eventId) return null;
  const event = sanitizePinnacle17Event(e.context.event), markets = normalizePinnacle17Markets(e.body);
  if (!event || !markets || String(event.id) !== eventId || event.sport.id !== pinnacle17SportId(bet.esporte)
    || new Date(event.startTime).getTime() !== bet.data.getTime() || event.status.isStarted || event.status.isInProgress || event.status.isInterrupted
    || normalizeStr(`${event.homeTeam.name} vs ${event.awayTeam.name}`) !== normalizeStr(bet.evento)) return null;
  return { id: row.id, sha256: row.sha256, observedAt: new Date(e.observedAt), markets };
}

/** Última resposta guardada que ainda vale para a aposta; nunca cria preço pós-jogo. */
export async function archivedClosingQuote(bet: EligibleClosingBet, now: Date): Promise<ClosingQuote | null> {
  for await (const response of archivedClosingResponses(bet, new Date(bet.data.getTime() - CLOSING_QUOTE_WINDOW_MS), now)) {
    const quote = resolveClosingMarkets(bet, response.markets, response.observedAt);
    if (quote) return { ...quote, archiveId: response.id, archiveSha: response.sha256 };
  }
  return null;
}

/**
 * Por que a última resposta da Pinnacle17 nos 10 min finais não deu o
 * fechamento: o mercado que ela não listava, a linha que não era a da aposta.
 * Null sem resposta com mercados nessa janela; aí quem faltou foi a captura.
 */
async function lastResponseMissReason(bet: EligibleClosingBet, now: Date): Promise<NoOddsReason | null> {
  for await (const response of archivedClosingResponses(bet, new Date(bet.data.getTime() - CLOSING_RELIABLE_WINDOW_MS), now)) {
    // Resposta sem nenhum mercado é falha passageira do feed (`fetchPinnacle17Odds`), não linha ausente.
    if (response.markets.length === 0) continue;
    const resolved = resolveClosing(bet, response.markets, response.observedAt);
    return resolved.quote ? null : resolved.miss;
  }
  return null;
}
type Source = "primary" | "extra" | "archive";
type Outcome = "applied" | "preserved" | "unavailable" | "quota" | "deferred" | "obsolete";

async function recordClosingObservation(watchId: string, source: Source, outcome: Outcome,
  attemptedAt: Date, quote?: ClosingQuote | null) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('closing-series-history-v1', 0))`;
      if (!await tx.closingPriceWatch.findUnique({ where: { id: watchId } })) return;
      if (await tx.closingPriceObservation.count({ where: { watchId } }) >= 16
        || await tx.closingPriceObservation.count() >= 20_000) return;
      await tx.closingPriceObservation.create({ data: { watchId, source, outcome, attemptedAt,
        observedAt: quote?.observedAt, rawOdd: quote?.raw, fairOdd: quote?.fair, archiveId: quote?.archiveId } });
    }, { timeout: 10_000 });
  } catch (error) {
    stateLog.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "diagnóstico de fechamento não gravado; preço preservado");
  }
}
type KickoffDrift = { betId: string; evento: string; recorded: Date; gameStartAt: Date };

/** Cotação pré-jogo da última hora antes deste kickoff, já observada. */
function quoteFitsWindow(quote: ClosingQuote, kickoff: Date, now: Date): boolean {
  return quote.observedAt <= now && quote.observedAt < kickoff
    && quote.observedAt.getTime() >= kickoff.getTime() - CLOSING_QUOTE_WINDOW_MS;
}

/**
 * A resposta mais antiga nunca vence a mais recente, nem uma decisão manual.
 *
 * Quando o horário do jogo na Pinnacle diverge do kickoff gravado, o preço não
 * vale contra o horário velho. Aposta pendente com remarcação de até 3 h muda
 * de kickoff aqui, e a mesma cotação vale se cair na janela do horário novo
 * (o jogo antecipado não perde o fechamento). Acima de 3 h o horário não muda
 * sozinho: vira ação para o dono.
 */
export async function applyClosingQuote(expected: ClosingBet, quote: ClosingQuote, source: Source, now = new Date()) {
  assertPriceProvenance({ ...quote, provider: "pinnacle17", requireReference: true }, "fechamento da série");
  const expectedHash = closingContextHash(expected);
  const result = await runSerializableTransaction("closingSeriesApply", async (tx): Promise<{ applied: boolean; drift?: KickoffDrift }> => {
    await tx.$queryRaw`SELECT id FROM bets WHERE id = ${expected.id} FOR UPDATE`;
    const bet = await readClosingBet(expected.id, tx);
    if (!closingBetEligible(bet) || closingContextHash(bet) !== expectedHash || !await segmentPriceEnabled(bet, tx)
      || quote.observedAt < closingSince(bet) || !quoteFitsWindow(quote, bet.data, now)) return { applied: false };
    const reference = parsePinnacle17PriceReference(quote.reference);
    const pinnedReference = bet.sharp?.priceReference?.trim();
    if (!reference || String(reference.eventId) !== bet.sharp?.providerMatchId
      || pinnedReference && quote.reference !== pinnedReference) return { applied: false };
    if (quote.archiveId) {
      // Bloqueio explícito fecha a corrida com a purga: o snapshot MVCC sozinho
      // ainda enxergaria uma prova que acabou de ser removida.
      await tx.$queryRaw`SELECT id FROM price_archive_observations WHERE id = ${quote.archiveId}::uuid FOR SHARE`;
      const raw = await tx.priceArchiveObservation.findUnique({ where: { id: quote.archiveId } });
      if (!raw || raw.expiresAt <= now || raw.sha256 !== quote.archiveSha || raw.requestedAt < closingSince(bet)) return { applied: false };
      const response = await decodeClosingResponse(raw, bet);
      const verified = response && resolveClosingMarkets(bet, response.markets, response.observedAt);
      // O hash prova a integridade da resposta; a reconstrução prova que ela
      // sustenta este preço, instante, limite e horário de início.
      if (!verified || verified.reference !== quote.reference || verified.raw !== quote.raw || verified.fair !== quote.fair
        || verified.maxBet !== quote.maxBet || verified.observedAt.getTime() !== quote.observedAt.getTime()
        || verified.gameStartAt?.getTime() !== quote.gameStartAt?.getTime()
        || canonicalSha256(verified.snapshot) !== canonicalSha256(quote.snapshot)) return { applied: false };
    }
    // Cotação velha não vence a mais nova e, por isso, nunca muda o kickoff.
    const existing = bet.closing;
    if (existing?.closingOdd != null && (!existing.closingPriceObservedAt || existing.closingPriceObservedAt >= quote.observedAt)) {
      return { applied: false };
    }
    if (!quote.gameStartAt || sameKickoff(quote.gameStartAt, bet.data)) {
      return { applied: await writeClosingQuote(tx, bet, quote, source, now) };
    }
    const move = await moveKickoffWithGuards(tx, bet, quote.gameStartAt, now, "match/odds");
    if (!move.moved) return { applied: false, drift: move.drift };
    const rescheduled = { ...bet, data: quote.gameStartAt };
    return { applied: quoteFitsWindow(quote, rescheduled.data, now) && await writeClosingQuote(tx, rescheduled, quote, source, now) };
  });
  if (result.drift) await raiseKickoffDriftAlert(result.drift);
  return result.applied;
}

async function writeClosingQuote(tx: Prisma.TransactionClient, bet: EligibleClosingBet, quote: ClosingQuote, source: Source, now: Date) {
  const existing = bet.closing;
  const clv = percentualContraFair(toNumber(bet.odds), quote.fair);
  if (clv == null) return false;
  const reliable = quote.observedAt.getTime() >= bet.data.getTime() - CLOSING_RELIABLE_WINDOW_MS;
  const data = { closingOdd: quote.fair, closingRawOdd: quote.raw, clv, clvReliable: reliable,
    noOddsReason: reliable ? null : TOO_EARLY, provider: "pinnacle17", closingPriceSnapshot: quote.snapshot as unknown as Prisma.InputJsonValue,
    closingPriceReference: quote.reference, closingPriceObservedAt: quote.observedAt,
    closingMaxBet: quote.maxBet, closingMaxBetCurrency: quote.maxBet == null ? null : maxBetCurrencyForProvider("pinnacle17"),
    source: source === "archive" ? "REPROCESS" as const : "CRON" as const,
    ...(now >= bet.data ? { fetchedAt: existing?.fetchedAt ?? now } : {}) };
  await tx.betClosing.upsert({ where: { betId: bet.id }, create: { betId: bet.id, ...data }, update: data });
  await tx.auditEvent.create({ data: { actor: "system:closing-series", action: "closing.series.price_applied",
    resource: "bet", resourceId: bet.id, details: { source, observedAt: quote.observedAt.toISOString(),
      previousObservedAt: existing?.closingPriceObservedAt?.toISOString() ?? null, archiveId: quote.archiveId ?? null } } });
  return true;
}

type KickoffMove = { moved: boolean; drift?: KickoffDrift };
/** De onde veio o horário: o corte de um mercado do jogo inteiro (período 0) na resposta de odds ou o feed de jogos. */
type KickoffSource = "match/odds" | "sport/matches";

/** Só aposta PENDING muda de kickoff, e só até 3 h; acima vira ação para o dono. */
async function moveKickoffWithGuards(tx: Prisma.TransactionClient, bet: EligibleClosingBet, gameStartAt: Date,
  now: Date, via: KickoffSource): Promise<KickoffMove> {
  if (bet.status !== "PENDING") return { moved: false };
  if (Math.abs(gameStartAt.getTime() - bet.data.getTime()) > KICKOFF_MOVE_MAX_MS) {
    return { moved: false, drift: { betId: bet.id, evento: bet.evento, recorded: bet.data, gameStartAt } };
  }
  return { moved: await moveKickoffToGameStart(tx, bet, gameStartAt, now, via) };
}

/**
 * O kickoff passa a ser o horário da Pinnacle: o contexto do fechamento muda
 * junto e a série recomeça no horário novo, com uma agenda nova.
 */
async function moveKickoffToGameStart(tx: Prisma.TransactionClient, bet: EligibleClosingBet, gameStartAt: Date,
  now: Date, via: KickoffSource) {
  const moved = await tx.bet.updateMany({
    where: { id: bet.id, data: bet.data, deletedAt: null, kickoffInferido: false, status: "PENDING" },
    data: { data: gameStartAt },
  });
  if (moved.count !== 1) return false;
  await tx.auditEvent.create({ data: { actor: "system:closing-series", action: KICKOFF_MOVED_BY_PROVIDER_ACTION,
    resource: "bet", resourceId: bet.id, details: { provider: "pinnacle17", via, anterior: bet.data.toISOString(),
      novo: gameStartAt.toISOString(), observadoEm: now.toISOString() } } });
  log.info({ betId: bet.id, anterior: bet.data.toISOString(), novo: gameStartAt.toISOString() }, "kickoff remarcado pela Pinnacle");
  return true;
}

async function raiseKickoffDriftAlert(drift: KickoffDrift) {
  await raiseOperationalAlertOnce(
    `⚠️ Jogo remarcado · ${drift.evento}\n`
      + `A Pinnacle dá o início em ${formatSpDateTime(drift.gameStartAt)}, e a aposta está com ${formatSpDateTime(drift.recorded)}. `
      + "A diferença passa de 3 h, então o horário não muda sozinho e o fechamento não é gravado contra o horário velho.\n"
      + "👉 Confira o horário do jogo e corrija a aposta pelo painel se ele mudou mesmo.",
    {
      source: "closing.series",
      key: `kickoff-drift:${drift.betId}`,
      title: "Jogo remarcado na Pinnacle",
      resource: "bet",
      resourceId: drift.betId,
      evidence: { gravado: drift.recorded.toISOString(), pinnacle: drift.gameStartAt.toISOString() },
      autoResolve: false,
    },
  );
}
/**
 * Congela o fechamento no kickoff. Sem preço dos 10 min finais, o motivo é o da
 * última resposta da Pinnacle17 nessa janela (o fornecedor não tinha a linha);
 * sem resposta nenhuma, a captura é que faltou (`kickoff_sem_captura`, ou
 * `closing_quote_too_early` quando há uma cotação mais velha). Releitura no
 * commit impede uma finalização antiga de apagar uma captura concorrente.
 */
export async function finalizeClosingSeries(expected: ClosingBet, now = new Date()) {
  // Já congelado: a transação recusaria, e o motivo abaixo descompacta o arquivo à toa.
  if (expected.closing?.fetchedAt) return false;
  const expectedHash = closingContextHash(expected);
  // Fora da transação: descompactar o arquivo não segura o lock da aposta. O
  // hash do contexto, conferido no commit, garante que o motivo é desta aposta.
  const missReason = closingBetEligible(expected) ? await lastResponseMissReason(expected, now) : null;
  const result = await runSerializableTransaction("closingSeriesFreeze", async (tx) => {
    await tx.$queryRaw`SELECT id FROM bets WHERE id = ${expected.id} FOR UPDATE`;
    const bet = await readClosingBet(expected.id, tx);
    if (!closingBetEligible(bet) || now < bet.data || closingContextHash(bet) !== expectedHash
      || !await segmentPriceEnabled(bet, tx) || bet.closing?.fetchedAt) return null;
    const hasPrice = bet.closing?.closingOdd != null;
    // O kickoff pode ter mudado depois da cotação: a janela confiável é a do horário final.
    const observedAt = bet.closing?.closingPriceObservedAt;
    const tooEarly = hasPrice && observedAt != null && observedAt.getTime() < bet.data.getTime() - CLOSING_RELIABLE_WINDOW_MS;
    const data = { fetchedAt: now, ...(!hasPrice ? { clvReliable: false, noOddsReason: missReason ?? "kickoff_sem_captura" }
      : tooEarly ? { clvReliable: false, noOddsReason: missReason ?? TOO_EARLY } : {}) };
    await tx.betClosing.upsert({ where: { betId: bet.id }, create: { betId: bet.id, source: "CRON", ...data }, update: data });
    return { hasPrice, clv: tooEarly || bet.closing?.clv == null ? null : toNumber(bet.closing.clv) };
  });
  if (result?.hasPrice) await sendOperatorNotification(
    `🔒 Fechamento · ${expected.evento}\n${expected.selecao} @${toNumber(expected.odds)}\n${linhaClv(result.clv)}`, { key: `closing:${expected.id}` });
  return Boolean(result);
}
export async function enqueueClosingWatch(row: ClosingPriceWatch, boss?: PgBoss, now = new Date()) {
  if (row.completedAt || row.kickoff.getTime() + CLOSING_RECOVERY_MS <= now.getTime()) return;
  await (boss ?? await getSharedBoss()).send(QUEUES.closingSeries, { watchId: row.id }, {
    singletonKey: `closing-series:${row.id}:${row.nextAttemptAt.getTime()}`,
    startAfter: new Date(Math.max(now.getTime(), row.nextAttemptAt.getTime(), row.leaseUntil?.getTime() ?? 0)),
    retryLimit: 0, priority: now < row.kickoff ? 20 : 0, expireInSeconds: 120, deleteAfterSeconds: 2 * 86_400,
  });
}
/** O começo da agenda: a primeira conferência do horário, ou agora, se já passou. */
function firstWatchPoint(kickoff: Date, now: Date) {
  return new Date(Math.max(now.getTime(), kickoff.getTime() - SCHEDULE_CHECK_OFFSETS[0]));
}
/** Depois de uma conferência, a seguinte ou, sem outra pela frente, a consulta primária. */
function afterScheduleCheck(kickoff: Date, now: Date) {
  const next = SCHEDULE_CHECK_OFFSETS.map((ms) => kickoff.getTime() - ms).find((at) => at > now.getTime());
  return new Date(next ?? kickoff.getTime() - PRIMARY_OFFSET_MS);
}
/**
 * A agenda da aposta no contexto atual. A encerrada do mesmo contexto (aposta
 * removida e restaurada, ou editada e desfeita, antes do apito) volta a valer,
 * com as consultas que já gastou.
 */
export async function ensureClosingWatch(betId: string, boss?: PgBoss, now = new Date()) {
  if (!pinnacle17Enabled()) return null;
  const bet = await readClosingBet(betId);
  if (!closingBetEligible(bet) || now >= bet.data || !await segmentPriceEnabled(bet)) return null;
  const eventId = bet.sharp?.providerMatchId;
  if (!eventId) return null;
  const contextHash = closingContextHash(bet);
  const { row, full } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('closing-series-contexts-v1', 0))`;
    const existing = await tx.closingPriceWatch.findUnique({ where: { betId_contextHash: { betId, contextHash } } });
    if (existing?.completedAt) {
      return { row: await tx.closingPriceWatch.update({ where: { id: existing.id }, data: { completedAt: null,
        leaseToken: null, leaseUntil: null, nextAttemptAt: firstWatchPoint(bet.data, now) } }), full: false };
    }
    if (existing) return { row: existing, full: false };
    if (await tx.closingPriceWatch.count() >= CLOSING_WATCH_CAP) return { row: null, full: true };
    return { row: await tx.closingPriceWatch.create({ data: { betId, contextHash, eventId,
      kickoff: bet.data, createdAt: now, nextAttemptAt: firstWatchPoint(bet.data, now) } }), full: false };
  }, { timeout: 10_000 });
  if (full) await raiseWatchCapAlert(bet.id);
  if (row) {
    try { await enqueueClosingWatch(row, boss, now); } catch (error) {
      scheduleLog.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "agenda persistida; varredura retoma envio de fechamento");
    }
  }
  return row;
}
async function raiseWatchCapAlert(betId: string) {
  await raiseOperationalAlertOnce(
    "⚠️ Agenda do fechamento cheia\n"
      + `As agendas guardadas chegaram a ${CLOSING_WATCH_CAP}, e aposta nova fica sem as consultas de fechamento `
      + "da Pinnacle17 até a limpeza abrir espaço.\n"
      + "👉 Confira se a varredura da agenda (`closing.price_series_sweep`) está rodando.",
    { source: "closing.series", key: "watch-cap", title: "Agenda do fechamento cheia", resource: "bet", resourceId: betId,
      evidence: { teto: CLOSING_WATCH_CAP }, autoResolve: false },
  );
}
/** Varredura independente do backlog Bridge e dos fechamentos antigos. */
export async function maintainClosingSeries(boss?: PgBoss, now = new Date()) {
  const expired = await prisma.closingPriceWatch.findMany({ where: { kickoff: { lt: new Date(now.getTime() - CLOSING_SERIES_RETENTION_MS) } }, select: { id: true }, take: 500 });
  if (expired.length) await prisma.closingPriceWatch.deleteMany({ where: { id: { in: expired.map((r) => r.id) } } });
  await prisma.closingPriceBudget.deleteMany({ where: { day: { lt: spDayKey(new Date(now.getTime() - 2 * 86_400_000)) } } });
  const overdue = await prisma.closingPriceWatch.findMany({ where: { completedAt: null,
    kickoff: { lte: new Date(now.getTime() - CLOSING_RECOVERY_MS) } }, select: { id: true }, take: 500 });
  if (overdue.length) await prisma.closingPriceWatch.updateMany({ where: { id: { in: overdue.map((r) => r.id) } }, data: { completedAt: now } });
  await realignUnqueriedWatches(now);
  const due = await prisma.closingPriceWatch.findMany({ where: { completedAt: null, nextAttemptAt: { lte: now },
    OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }, orderBy: { kickoff: "asc" }, take: 100 });
  for (const row of due) await enqueueClosingWatch(row, boss, now);
  for (const bet of await betsWithoutCurrentWatch(now)) await ensureClosingWatch(bet.id, boss, now);
}
/**
 * Agenda aberta que ainda não consultou nada e está marcada para depois da
 * consulta primária (as de antes da conferência de horário começavam aos
 * 3 min) volta ao começo da agenda.
 */
async function realignUnqueriedWatches(now: Date) {
  await prisma.$executeRaw`
    UPDATE closing_price_watches w
    SET "nextAttemptAt" = GREATEST(${now}::timestamptz,
      w.kickoff - make_interval(secs => ${SCHEDULE_CHECK_OFFSETS[0] / 1000}::double precision))
    WHERE w."completedAt" IS NULL AND w."lastPhysicalAt" IS NULL AND w.attempts = 0 AND w.kickoff > ${now}
      AND w."nextAttemptAt" > w.kickoff - make_interval(secs => ${PRIMARY_OFFSET_MS / 1000}::double precision)
      AND (w."leaseUntil" IS NULL OR w."leaseUntil" <= ${now})
      AND NOT EXISTS (SELECT 1 FROM closing_price_observations o WHERE o."watchId" = w.id)`;
}
/**
 * Apostas até a primeira conferência do horário sem agenda aberta no kickoff
 * atual: a agenda que se perdeu e a do jogo que o dono antecipou, cuja agenda
 * aberta ainda é a do horário antigo.
 */
async function betsWithoutCurrentWatch(now: Date) {
  return prisma.$queryRaw<{ id: string }[]>`
    SELECT b.id FROM bets b
    JOIN bankrolls br ON br.id = b."bankrollId"
    JOIN bet_sharp s ON s."betId" = b.id
    WHERE b."deletedAt" IS NULL AND b."notTakenAt" IS NULL AND b."kickoffInferido" = false
      AND b."sportResolutionStatus" = 'CONFIRMED'
      AND b.data > ${now} AND b.data <= ${new Date(now.getTime() + SCHEDULE_CHECK_OFFSETS[0])}
      AND br."sharpMode" = 'CLV_ONLY' AND s.provider = 'pinnacle17' AND s."identityStatus" IN ('MATCHED', 'MANUAL')
      AND NOT EXISTS (SELECT 1 FROM closing_price_watches w
        WHERE w."betId" = b.id AND w."completedAt" IS NULL AND w.kickoff = b.data)
    ORDER BY b.data LIMIT 100`;
}
/**
 * Passe pós-kickoff do `closing.sync` para a aposta da série: aplica a última
 * cotação pré-jogo guardada (arquivo ou cache) e congela. Não consulta a
 * Pinnacle17: antes do apito quem consulta é a agenda. Null quando a aposta
 * não é da série (quem chama congela sem preço, com o motivo dela).
 */
export async function closeSeriesAfterKickoff(input: SnapshotBet, now: Date): Promise<{ closed: boolean } | null> {
  const bet = await readClosingBet(input.id);
  if (!closingBetEligible(bet)) return null;
  if (now < bet.data || !matchesClosingInput(bet, input) || !await segmentPriceEnabled(bet)) return { closed: false };
  // Depois do kickoff só vale o que já foi observado antes dele.
  const archived = await archivedClosingQuote(bet, now);
  const cached = await cachedClosingQuote(bet, now);
  const quote = archived && (!cached || archived.observedAt >= cached.observedAt) ? archived : cached;
  if (quote) await applyClosingQuote(bet, quote, quote.archiveId ? "archive" : "primary", now);
  return { closed: await finalizeClosingSeries(bet, now) };
}

async function claimWatch(id: string, now: Date) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM closing_price_watches WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.closingPriceWatch.findUnique({ where: { id } });
    if (!row || row.completedAt || row.nextAttemptAt > now || row.leaseUntil && row.leaseUntil > now) return null;
    return tx.closingPriceWatch.update({ where: { id }, data: { leaseToken: crypto.randomUUID(),
      leaseUntil: new Date(now.getTime() + WATCH_LEASE_MS), nextAttemptAt: new Date(now.getTime() + 30_000) } });
  });
}
type Claim = NonNullable<Awaited<ReturnType<typeof claimWatch>>>;
/**
 * Relê, com a agenda travada, o que decide se a consulta ainda vale: a mesma
 * posse da agenda, antes do apito, a aposta no mesmo contexto e o provedor e o
 * segmento ligados. Senão a consulta não sai.
 */
async function lockLiveWatch(tx: Prisma.TransactionClient, claim: Claim) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('closing-series-spend-v1', 0))`;
  await tx.$queryRaw`SELECT id FROM bets WHERE id = ${claim.betId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM closing_price_watches WHERE id = ${claim.id}::uuid FOR UPDATE`;
  const now = new Date(), row = await tx.closingPriceWatch.findUnique({ where: { id: claim.id } });
  const bet = await readClosingBet(claim.betId, tx);
  if (!pinnacle17Enabled() || !row || row.leaseToken !== claim.leaseToken || !row.leaseUntil || row.leaseUntil <= now
    || row.completedAt || now >= row.kickoff
    || !closingBetEligible(bet) || closingContextHash(bet) !== row.contextHash || !await segmentPriceEnabled(bet, tx))
    throw new BudgetExhaustedError("pinnacle17", "closing-series-context-changed");
  return { row, now };
}
/** Antes de cada tentativa da consulta primária. */
async function validateLiveWatch(claim: Claim) {
  await prisma.$transaction((tx) => lockLiveWatch(tx, claim), { timeout: 10_000 });
}
/** A consulta primária conta como feita só depois de a cota dela ser paga. */
async function markQueried(claim: Claim) {
  await prisma.closingPriceWatch.updateMany({ where: { id: claim.id, leaseToken: claim.leaseToken },
    data: { lastPhysicalAt: new Date() } });
}
async function queried(claim: Claim) {
  const row = await prisma.closingPriceWatch.findUnique({ where: { id: claim.id }, select: { lastPhysicalAt: true } });
  return row?.lastPhysicalAt != null;
}
/** Consulta extra: orçamento diário próprio, 30 s entre consultas do jogo e a última guardada para os 30 s finais. */
async function beforeExtraRequest(claim: Claim) {
  await prisma.$transaction(async (tx) => {
    const { row, now } = await lockLiveWatch(tx, claim);
    if (row.attempts >= CLOSING_EXTRA_ATTEMPTS)
      throw new BudgetExhaustedError("pinnacle17", "closing-series-attempts-spent");
    if (row.attempts === CLOSING_EXTRA_ATTEMPTS - 1 && now.getTime() < row.kickoff.getTime() - 30_000)
      throw new BudgetExhaustedError("pinnacle17", "closing-series-final-attempt-reserved");
    if (await tx.closingPriceWatch.findFirst({ where: { eventId: row.eventId,
      lastPhysicalAt: { gt: new Date(now.getTime() - CLOSING_EXTRA_COOLDOWN_MS) } }, select: { id: true } }))
      throw new BudgetExhaustedError("pinnacle17", "closing-series-event-cooldown");
    await chargeClosingSeriesBudget(tx, now, closingSeriesConfig().dailyCap);
    await tx.closingPriceWatch.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, lastPhysicalAt: now } });
  }, { timeout: 10_000 });
}
/** A primária: 25 s por tentativa e uma retentativa, até 2 s antes do fim da posse e nunca depois do apito. */
function primaryDeadline(claim: Claim, bet: EligibleClosingBet): Pinnacle17Deadline {
  const leaseEnd = claim.leaseUntil?.getTime() ?? Date.now() + WATCH_LEASE_MS;
  return { deadlineMs: Math.min(bet.data.getTime(), leaseEnd - 2_000), purpose: "closing-series", cadenceWaitMs: 5000,
    attemptTimeoutMs: PRIMARY_ATTEMPT_TIMEOUT_MS, retries: 1 };
}
async function finish(claim: Claim, nextAttemptAt: Date, completed: boolean, boss?: PgBoss) {
  await prisma.closingPriceWatch.updateMany({ where: { id: claim.id, leaseToken: claim.leaseToken },
    data: { nextAttemptAt, leaseToken: null, leaseUntil: null, ...(completed ? { completedAt: new Date() } : {}) } });
  const row = await prisma.closingPriceWatch.findUnique({ where: { id: claim.id } });
  if (row) await enqueueClosingWatch(row, boss);
}
/**
 * Horário do jogo no feed de jogos da Pinnacle17 (`sport/matches`, em cache por
 * 15 min), sem consulta de odds e sem o orçamento do fechamento. Procura no dia
 * (UTC) do kickoff e no de 3 h antes, o alcance da remarcação.
 */
async function feedGameStart(bet: EligibleClosingBet, deadlineMs: number): Promise<Date | null> {
  const sportId = pinnacle17SportId(bet.esporte);
  const eventId = bet.sharp?.providerMatchId;
  if (sportId === null || !eventId) return null;
  const event = await findPinnacle17EventById({ sportId, eventId,
    around: [bet.data, new Date(bet.data.getTime() - KICKOFF_MOVE_MAX_MS)],
    deadline: { deadlineMs, purpose: "closing-schedule", cadenceWaitMs: 5000 } });
  if (!event || event.status.isStarted || event.status.isInProgress || event.status.isInterrupted) return null;
  const startAt = new Date(event.startTime);
  return Number.isFinite(startAt.getTime()) ? startAt : null;
}
/** Remarca pelo horário do feed, com as guardas da remarcação pela cotação e a aposta no mesmo contexto. */
async function rescheduleFromFeed(expected: EligibleClosingBet, gameStartAt: Date, now: Date) {
  const expectedHash = closingContextHash(expected);
  const result = await runSerializableTransaction("closingSeriesReschedule", async (tx): Promise<KickoffMove> => {
    await tx.$queryRaw`SELECT id FROM bets WHERE id = ${expected.id} FOR UPDATE`;
    const bet = await readClosingBet(expected.id, tx);
    if (!closingBetEligible(bet) || closingContextHash(bet) !== expectedHash || !await segmentPriceEnabled(bet, tx)) {
      return { moved: false };
    }
    return moveKickoffWithGuards(tx, bet, gameStartAt, now, "sport/matches");
  });
  if (result.drift) await raiseKickoffDriftAlert(result.drift);
  return result.moved;
}
/**
 * A volta antes da consulta primária confere o horário. O jogo remarcado mais
 * de 5 min para um horário ainda por vir muda o kickoff, e a agenda recomeça
 * no horário novo; horário que já passou não vale, mesmo com o feed dizendo
 * que o jogo não começou. Senão, a próxima volta é a conferência seguinte ou a
 * consulta primária.
 */
async function checkSchedule(claim: Claim, bet: EligibleClosingBet, now: Date, boss?: PgBoss) {
  const leaseEnd = claim.leaseUntil?.getTime() ?? now.getTime() + WATCH_LEASE_MS;
  const gameStartAt = await feedGameStart(bet, leaseEnd - 2_000);
  if (gameStartAt && gameStartAt > now && !sameKickoff(gameStartAt, bet.data)
    && await rescheduleFromFeed(bet, gameStartAt, now)) {
    await finish(claim, now, true, boss);
    await ensureClosingWatch(bet.id, boss);
    return { status: "rescheduled" };
  }
  await finish(claim, afterScheduleCheck(bet.data, now), false, boss);
  return { status: "schedule_checked" };
}
type ClosingQuery = { quote: ClosingQuote | null; source: "primary" | "extra"; quota: boolean };
/**
 * As consultas de uma volta. A primeira da agenda é a primária, pela reserva
 * de fechamento; sem consulta física nela, a extra tenta na mesma volta. Com a
 * reserva e as extras sem orçamento, a primária ainda tenta uma vez pelo
 * orçamento geral do dia.
 */
async function queryClosing(claim: Claim, bet: EligibleClosingBet, archived: ClosingQuote | null, now: Date): Promise<ClosingQuery> {
  // A resposta de outra aposta do jogo, de menos de 1 min, dispensa consulta nova.
  if (archived && now.getTime() - archived.observedAt.getTime() < 60_000) return { quote: archived, source: "extra", quota: false };
  const event = closingEvent(bet);
  if (!event || !pinnacle17Enabled()) return { quote: null, source: "extra", quota: false };
  const primaryHooks = { validate: () => validateLiveWatch(claim), charged: () => markQueried(claim) };
  const firstQuery = claim.lastPhysicalAt == null && claim.attempts === 0;
  if (firstQuery) {
    const captured = await capturePinnacle17Closing(bet, primaryHooks, primaryDeadline(claim, bet));
    const quote = captured && captured.observedAt >= closingSince(bet) ? captured : null;
    if (quote || await queried(claim)) return { quote, source: "primary", quota: false };
  }
  if (claim.attempts >= CLOSING_EXTRA_ATTEMPTS) return { quote: null, source: "extra", quota: false };
  let refusal: string | undefined;
  const observed = await fetchPinnacle17Odds(event.id, async () => {
    try { await beforeExtraRequest(claim); } catch (error) {
      if (error instanceof BudgetExhaustedError) refusal = error.requestLabel ?? "quota";
      throw error;
    }
  }, event, { deadlineMs: bet.data.getTime(), purpose: "closing-series", cadenceWaitMs: 5000 });
  if (observed) return { quote: resolveClosingMarkets(bet, observed.data, observed.observedAt), source: "extra", quota: false };
  if (firstQuery && refusal && EXTRAS_OUT_OF_BUDGET.has(refusal) && !await queried(claim)) {
    const general = await fetchPinnacle17Odds(event.id, async () => {
      await primaryHooks.validate();
      await chargeProviderRequest("pinnacle17", "closing-primary");
      await primaryHooks.charged();
    }, event, primaryDeadline(claim, bet));
    if (general) return { quote: resolveClosingMarkets(bet, general.data, general.observedAt), source: "primary", quota: false };
  }
  return { quote: null, source: "extra", quota: refusal !== undefined };
}
export async function runClosingWatch(watchId: string, boss?: PgBoss) {
  let claim: Claim | null = null;
  try {
    claim = await claimWatch(watchId, new Date());
    if (!claim) return { status: "ineligible_or_claimed" };
    const bet = await readClosingBet(claim.betId), now = new Date();
    if (!closingBetEligible(bet) || closingContextHash(bet) !== claim.contextHash || !await segmentPriceEnabled(bet)) {
      await finish(claim, now, true, boss);
      if (bet && now < bet.data) await ensureClosingWatch(bet.id, boss);
      return { status: "obsolete" };
    }
    if (now.getTime() < bet.data.getTime() - PRIMARY_OFFSET_MS) return await checkSchedule(claim, bet, now, boss);
    const archived = await archivedClosingQuote(bet, now);
    if (archived) {
      const applied = await applyClosingQuote(bet, archived, "archive");
      await recordClosingObservation(claim.id, "archive", applied ? "applied" : "preserved", now, archived);
    }
    if (now >= bet.data) {
      await finalizeClosingSeries(bet, now);
      const latest = await readClosingBet(bet.id);
      // Congelado, a agenda acabou: resposta pré-jogo não aparece depois do apito,
      // e a leitura nova do arquivo é da recuperação do `closing.sync`.
      const done = latest?.closing?.closingOdd != null || latest?.closing?.fetchedAt != null
        || now.getTime() >= bet.data.getTime() + CLOSING_RECOVERY_MS;
      await finish(claim, new Date(now.getTime() + 300_000), done, boss);
      return { status: done ? "finalized" : "awaiting_archive" };
    }
    const { quote, source, quota } = await queryClosing(claim, bet, archived, now);
    const applied = quote ? await applyClosingQuote(bet, quote, quote.archiveId ? "archive" : source) : false;
    await recordClosingObservation(claim.id, source, quote ? applied ? "applied" : "preserved" : quota ? "quota" : "unavailable", now, quote);
    const current = await prisma.closingPriceWatch.findUniqueOrThrow({ where: { id: claim.id } });
    await finish(claim, nextClosingOpportunity(bet.data, new Date(), !quote, current.attempts), false, boss);
    return { status: quote ? applied ? "updated" : "preserved" : "deferred" };
  } catch (error) {
    log.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "fechamento extra adiado; última referência permanece");
    if (claim) await finish(claim, nextClosingOpportunity(claim.kickoff, new Date(), true, claim.attempts), false, boss).catch(() => {});
    return { status: "unavailable" };
  }
}

/** Tenta, sem HTTP, uma resposta pré-jogo mais recente que a já congelada. */
export async function recoverArchivedClosing(betId: string, now = new Date()): Promise<boolean> {
  const bet = await readClosingBet(betId);
  if (!closingBetEligible(bet) || now < bet.data || !await segmentPriceEnabled(bet)) return false;
  const quote = await archivedClosingQuote(bet, now);
  return quote ? applyClosingQuote(bet, quote, "archive", now) : false;
}

const RECOVERY_BATCH = 25;
let recoveryCursor = "";
/**
 * Reavalia só o arquivo local, em rodízio pelo id: uma resposta mais recente
 * pode terminar de ser arquivada depois do congelamento, inclusive quando a
 * cotação anterior já era confiável. A recuperação vale enquanto a resposta
 * estiver retida. O cursor fica em memória; um reinício só recomeça a volta.
 */
async function recoverArchivedClosings(now: Date) {
  if (!priceArchiveConfig().enabled) return { checked: 0, recovered: 0 };
  const from = new Date(now.getTime() - priceArchiveConfig().retentionMs);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT b.id FROM bets b
    JOIN bankrolls br ON br.id = b."bankrollId"
    JOIN bet_sharp s ON s."betId" = b.id
    JOIN bet_closing c ON c."betId" = b.id
    WHERE b.id > ${recoveryCursor} AND b."deletedAt" IS NULL AND b.data <= ${now} AND b.data > ${from}
      AND br."sharpMode" = 'CLV_ONLY' AND s.provider = 'pinnacle17' AND s."identityStatus" IN ('MATCHED', 'MANUAL')
      AND c."fetchedAt" IS NOT NULL AND c.source IS DISTINCT FROM 'MANUAL'
      AND EXISTS (SELECT 1 FROM price_archive_observations o WHERE o.provider = 'pinnacle17'
        AND o."eventIds" @> ARRAY[s."providerMatchId"] AND o."expiresAt" > ${now}
        AND o."observedAt" >= b.data - interval '1 hour' AND o."observedAt" < b.data
        AND (c."closingPriceObservedAt" IS NULL OR o."observedAt" > c."closingPriceObservedAt")
        AND o."requestedAt" >= GREATEST(b."registradoEm", br."sharpModeChangedAt"))
    ORDER BY b.id LIMIT ${RECOVERY_BATCH}`;
  recoveryCursor = rows.length < RECOVERY_BATCH ? "" : rows.at(-1)?.id ?? "";
  let checked = 0, recovered = 0;
  const started = performance.now();
  for (const { id } of rows) {
    if (performance.now() - started > 15_000) break;
    checked++;
    if (await recoverArchivedClosing(id, now)) recovered++;
  }
  return { checked, recovered };
}
/** Limpeza do arquivo e recuperação sem HTTP; falha aqui não para a manutenção. */
export async function maintainClosingArchive(now = new Date()) {
  try {
    return { ...await purgePriceArchive(now), ...await recoverArchivedClosings(now) };
  } catch (error) {
    log.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "arquivo de preços indisponível; fechamento ao vivo preservado");
    return { unavailable: true };
  }
}
