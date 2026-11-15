import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import type { Prisma } from "@/src/generated/prisma/client";
import type * as EnvModule from "@/src/infra/env";
import { createTestDb, type TestDb } from "../helpers/db";
import { priceEnvelope, ARCHIVE_ENTRY as SOURCE, ARCHIVE_KICKOFF as KICK } from "../helpers/price-archive-fixtures";
const mocks = vi.hoisted(() => ({ mode: "on", cap: 500, raw: 2, status: 200, live: false, cutoff: null as string | null, firstHalf: false, empty: false,
  /** Horário do jogo no feed de jogos e o instante em que ele começou de verdade (dali em diante o livro é live). */
  startTime: null as string | null, startedAt: null as Date | null,
  physical: vi.fn(), feed: vi.fn(), send: vi.fn(async () => "queued"), alert: vi.fn(async () => true),
  beforeAttempt: undefined as undefined | (() => Promise<void>), beforeResponse: undefined as undefined | (() => Promise<void>) }));
vi.mock("@/src/infra/env", async (original) => {
  const env = await original<typeof EnvModule>();
  return { ...env, getEnv: () => ({ ...env.getEnv(), CLOSING_SERIES_DAILY_CAP: mocks.cap,
    PRICE_ARCHIVE_ENABLED: true, PINNACLE17_MODE: mocks.mode, PINNACLE17_RAPIDAPI_KEY: "synthetic-c18" }) };
});
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => ({ send: mocks.send }) }));
vi.mock("@/src/infra/circuit-breaker", () => ({ withBreaker: (_: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperatorNotification: mocks.alert, sendOperationalAlert: mocks.alert,
  raiseOperationalAlertOnce: mocks.alert }));
vi.mock("@/src/providers/core/http", async (original) => ({ ...await original<object>(),
  fetchJsonWithRetry: async (params: { beforeAttempt: () => Promise<void>; maxRetries: number; timeoutMs: number; url: string }) => {
    if (params.url.includes("/sport/matches")) {
      await params.beforeAttempt(); mocks.feed(params);
      const { event } = priceEnvelope().context as { event: Record<string, unknown> };
      return { ok: true, status: 200, data: { matches: [{ ...event, startTime: mocks.startTime ?? event.startTime }] } };
    }
    await mocks.beforeAttempt?.(); await params.beforeAttempt(); mocks.physical(params);
    const body = priceEnvelope().body as { markets: Array<{ outcomes: Array<{ oddsDecimal: number }>; isLive: boolean; cutoffAt: string }> };
    body.markets[0]!.outcomes[0]!.oddsDecimal = mocks.raw;
    body.markets[0]!.isLive = mocks.live || (mocks.startedAt !== null && Date.now() >= mocks.startedAt.getTime());
    if (mocks.cutoff) body.markets[0]!.cutoffAt = mocks.cutoff;
    if (mocks.firstHalf) Object.assign(body.markets[0]!, { name: "Money Line – 1st Half", period: 1, periodName: "1st Half" });
    if (mocks.empty) body.markets = [];
    await mocks.beforeResponse?.(); vi.setSystemTime(new Date(Date.now() + 1000));
    return mocks.status === 200 ? { ok: true, status: 200, data: body } : { ok: false, status: mocks.status, error: "synthetic failure" };
  } }));
import {
  applyClosingQuote, archivedClosingQuote, closingBetEligible, closingContextHash, enqueueClosingWatch, ensureClosingWatch,
  finalizeClosingSeries, maintainClosingSeries, nextClosingOpportunity, readClosingBet, resolveClosingMarkets, runClosingWatch,
  type ClosingQuote,
} from "@/src/services/sharp/closing/series";
import { snapshotClosingForBet } from "@/src/services/sharp/closing/pinnacle17-snapshot";
import { runClosingSyncOnce } from "@/src/services/sharp/closing/sync";
import { normalizePinnacle17Markets } from "@/src/providers/pinnacle17/types";
import { archivePriceResponse } from "@/src/providers/price-archive/store";
import * as PriceArchiveStore from "@/src/providers/price-archive/store";
import { invalidateSegmentPolicyCache } from "@/src/services/sharp/segment-policy";
import { spDayKey } from "@/src/domain/dates";
import { writeProviderCache } from "@/src/providers/provider-cache";
import { getBetDetail } from "@/src/services/painel/queries/bet-rows";
import { editarBankroll } from "@/src/services/bankrolls/manage";
let db: TestDb;
const boss = { send: mocks.send } as unknown as PgBoss;
const at = (offset: number) => new Date(KICK.getTime() + offset * 1000);
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { vi.useRealTimers(); await db.dispose(); });
beforeEach(async () => {
  vi.useRealTimers(); await db.reset(); vi.clearAllMocks(); invalidateSegmentPolicyCache();
  Object.assign(mocks, { mode: "on", cap: 500, raw: 2, status: 200, live: false, cutoff: null, firstHalf: false, empty: false,
    startTime: null, startedAt: null, beforeAttempt: undefined, beforeResponse: undefined });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(at(-600));
});
async function seed(mode: "CLV_ONLY" = "CLV_ONLY", eventId = 123, odds = 2.5, registeredAt = SOURCE) {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Synthetic C18", slug: crypto.randomUUID(),
    valorUnidade: 100, sharpMode: mode, createdAt: SOURCE, updatedAt: SOURCE } });
  const bet = await db.prisma.bet.create({ data: { bankrollId: bankroll.id, evento: "Alpha vs Beta", esporte: "Soccer",
    competicao: "Synthetic", pais: "World", mercado: "Money Line – Match", selecao: "Alpha", odds, stake: 1,
    valorUnidade: 100, data: KICK, registradoEm: registeredAt, sourcePostedAt: SOURCE,
    sportResolutionStatus: "CONFIRMED", sportResolvedAt: SOURCE } });
  await db.prisma.betSharp.create({ data: { betId: bet.id, identityStatus: "MATCHED", provider: "pinnacle17", providerMatchId: String(eventId) } });
  const watch = await ensureClosingWatch(bet.id, boss); if (!watch) throw new Error("watch fixture");
  return { bet, bankroll, watch };
}
async function context(id: string) {
  const bet = await readClosingBet(id); if (!closingBetEligible(bet)) throw new Error("fixture"); return bet;
}
async function closing(id: string) { return db.prisma.betClosing.findUniqueOrThrow({ where: { betId: id } }); }
/** O passe do `closing.sync`, que só congela depois do kickoff. */
async function afterKickoff(id: string, seconds: number) {
  vi.setSystemTime(at(seconds)); return snapshotClosingForBet(await context(id), new Date());
}
/** Uma volta da agenda: antes dos 5 min confere o horário; a primeira consulta usa a reserva, as seguintes o orçamento extra. */
async function extra(id: string, seconds: number) { vi.setSystemTime(at(seconds)); return runClosingWatch(id, boss); }
/** Cotação gravada longe do apito (a da identidade, por exemplo). */
async function earlyQuote(id: string, seconds: number, raw: number) {
  const q = await quote(id, seconds, raw); vi.setSystemTime(at(seconds + 10));
  expect(await applyClosingQuote(await context(id), q, "extra")).toBe(true);
}
async function quote(id: string, seconds: number, raw: number): Promise<ClosingQuote> {
  const e = priceEnvelope("pinnacle17", at(seconds));
  (e.body as { markets: Array<{ outcomes: Array<{ oddsDecimal: number }> }> }).markets[0]!.outcomes[0]!.oddsDecimal = raw;
  const q = resolveClosingMarkets(await context(id), normalizePinnacle17Markets(e.body)!, at(seconds));
  if (!q) throw new Error("quote fixture"); return q;
}

describe("série de fechamento com banco, cache, budget e cliente reais; somente transporte simulado", () => {
  it.each([499.75, 0.75])("fechamento Pinnacle17 conserva limite fracionário na leitura (%s)", async (limit) => {
    const { bet } = await seed();
    const envelope = priceEnvelope("pinnacle17", at(-30));
    const body = envelope.body as { markets: Array<{ limits: Array<{ amount: number; type: string }> }> };
    body.markets[0]!.limits = [{ type: "maxRiskStake", amount: limit }];
    const ctx = await context(bet.id);
    const q = resolveClosingMarkets(ctx, normalizePinnacle17Markets(body)!, at(-30));
    expect(q).not.toBeNull();
    vi.setSystemTime(at(10));
    expect(await applyClosingQuote(ctx, q!, "extra")).toBe(true);
    expect((await getBetDetail(bet.id))?.closingMaxBet).toBe(limit);
  });

  it("a agenda consulta aos 5 min com a reserva e nos três pontos finais com o orçamento extra", async () => {
    const { bet, watch } = await seed();
    // A 10 min do jogo a agenda começa já, pela conferência do horário.
    expect(watch.nextAttemptAt).toEqual(at(-600));
    mocks.raw = 1.95; await extra(watch.id, -300);
    mocks.raw = 1.90; await extra(watch.id, -180);
    mocks.raw = 1.85; await extra(watch.id, -105);
    mocks.raw = 1.80; await extra(watch.id, -30);
    await extra(watch.id, 10);
    const result = await closing(bet.id);
    expect(Number(result.closingRawOdd)).toBe(1.8); expect(result.closingPriceObservedAt).toEqual(at(-29));
    expect(result.clvReliable).toBe(true); expect(result.fetchedAt).not.toBeNull();
    // Quatro consultas: a primária pela reserva de fechamento e três extras pelo orçamento próprio.
    expect(mocks.physical).toHaveBeenCalledTimes(4);
    expect((await db.prisma.closingPriceBudget.findUniqueOrThrow({ where: { day: spDayKey(KICK) } })).spent).toBe(3);
    const sources = await db.prisma.closingPriceObservation.groupBy({ by: ["source"], where: { watchId: watch.id, outcome: "applied" }, _count: true });
    expect(Object.fromEntries(sources.map((r) => [r.source, r._count]))).toMatchObject({ primary: 1, extra: 3 });
    const unchanged = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect([Number(unchanged.odds), Number(unchanged.stake), Number(unchanged.valorUnidade), unchanged.status]).toEqual([2.5, 1, 100, "PENDING"]);
    expect(await db.prisma.movimentacao.count()).toBe(0); expect(await db.prisma.settlementEvent.count()).toBe(0);
   
  });
  it("resposta recebida antes do apito permanece válida quando o arquivo termina depois", async () => {
    const { bet, watch } = await seed();
    const archive = PriceArchiveStore.archivePriceResponse;
    const delayed = vi.spyOn(PriceArchiveStore, "archivePriceResponse").mockImplementation(async (...args) => {
      vi.setSystemTime(new Date(Date.now() + 2000));
      return archive(...args);
    });
    try {
      await extra(watch.id, -2); // Transporte termina a -1 s; arquivo termina a +1 s.
      const result = await closing(bet.id);
      expect(result).toMatchObject({ clvReliable: true, closingPriceObservedAt: at(-1), fetchedAt: at(1) });
      expect(Number(result.closingRawOdd)).toBe(2);
      const archived = await archivedClosingQuote(await context(bet.id), new Date());
      expect(archived?.observedAt).toEqual(result.closingPriceObservedAt);
      expect((await db.prisma.providerCache.findUniqueOrThrow({ where: {
        provider_key: { provider: "pinnacle17", key: "odds:123:prematch:v2" } } })).fetchedAt).toEqual(at(-1));
      expect(mocks.physical).toHaveBeenCalledOnce();
    } finally { delayed.mockRestore(); }
  });
  it("closing.sync não consulta antes do apito: quem consulta é a agenda", async () => {
    const { bet } = await seed(); vi.setSystemTime(at(-240));
    expect(await runClosingSyncOnce({ now: new Date() })).toMatchObject({ processed: 0 });
    expect(mocks.physical).not.toHaveBeenCalled();
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
  });
  it.each(["event", "period", "unit"])("commit recusa referência diferente da fixada na entrada: %s", async kind => {
    const { bet } = await seed();
    const valid = await quote(bet.id, -30, 1.8);
    await db.prisma.betSharp.update({ where: { betId: bet.id }, data: { priceReference: valid.reference } });
    const reference = kind === "event" ? valid.reference.replace(":123:", ":999:")
      : kind === "period" ? valid.reference.replace(":0:", ":1:") : valid.reference.replace(/goals$/, "corners");
    vi.setSystemTime(at(-20));
    expect(await applyClosingQuote(await context(bet.id), { ...valid, reference }, "primary")).toBe(false);
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
  });
  it("commit sem referência de entrada ainda exige o evento da identidade", async () => {
    const { bet } = await seed(); const valid = await quote(bet.id, -30, 1.8); vi.setSystemTime(at(-20));
    expect(await applyClosingQuote(await context(bet.id), { ...valid,
      reference: valid.reference.replace(":123:", ":999:") }, "primary")).toBe(false);
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
  });
  it.each(["price", "time", "kickoff", "limit", "event"])("arquivo deve reconstruir a cotação aplicada: %s", async kind => {
    const { bet } = await seed(); const ctx = await context(bet.id);
    const envelope = priceEnvelope("pinnacle17", at(-30));
    if (kind === "event") {
      Object.assign(envelope.context.event as object, { id: 999 });
      envelope.context.query = { match_id: 999 };
    }
    vi.setSystemTime(at(10));
    const id = await archivePriceResponse(envelope);
    const row = await db.prisma.priceArchiveObservation.findUniqueOrThrow({ where: { id: id! } });
    const valid = await quote(bet.id, -30, kind === "price" ? 1.8 : 2);
    const divergent = { ...valid, archiveId: row.id, archiveSha: row.sha256,
      ...(kind === "time" ? { observedAt: at(-10) } : {}),
      ...(kind === "kickoff" ? { gameStartAt: at(60) } : {}),
      ...(kind === "limit" ? { maxBet: 999 } : {}) };
    vi.setSystemTime(at(10));
    expect(await applyClosingQuote(ctx, divergent, "archive")).toBe(false);
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await db.prisma.auditEvent.count({ where: { action: "closing.series.price_applied" } })).toBe(0);
  });
  it("cotação a mais de 10 min do kickoff fica sem CLV confiável, com motivo, e congela assim", async () => {
    const { bet, watch } = await seed(); await earlyQuote(bet.id, -1800, 2);
    const early = await closing(bet.id);
    expect(early).toMatchObject({ clvReliable: false, noOddsReason: "closing_quote_too_early" });
    expect(Number(early.closingRawOdd)).toBe(2);
    mocks.status = 500; await extra(watch.id, -300); await extra(watch.id, -180); await extra(watch.id, -105);
    await extra(watch.id, -30); await extra(watch.id, 10);
    const frozen = await closing(bet.id);
    expect(frozen.fetchedAt).not.toBeNull();
    expect(frozen).toMatchObject({ clvReliable: false, noOddsReason: "closing_quote_too_early" });
  });
  it("resposta sem a linha nos 10 min finais congela com o motivo dela, não como captura perdida", async () => {
    const { bet, watch } = await seed();
    // A Pinnacle17 respondeu, mas só com o mercado do 1º tempo.
    mocks.firstHalf = true; await extra(watch.id, -180); await extra(watch.id, 10);
    expect(mocks.physical).toHaveBeenCalledOnce();
    expect(await closing(bet.id)).toMatchObject({ closingOdd: null, clvReliable: false, noOddsReason: "market_not_listed" });
  });
  it("agenda que congelou sem preço encerra no apito, sem voltar de 5 em 5 min", async () => {
    const { bet, watch } = await seed();
    mocks.firstHalf = true; await extra(watch.id, -180);
    mocks.send.mockClear();
    expect(await extra(watch.id, 10)).toEqual({ status: "finalized" });
    expect((await closing(bet.id)).fetchedAt).not.toBeNull();
    expect((await db.prisma.closingPriceWatch.findUniqueOrThrow({ where: { id: watch.id } })).completedAt).not.toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(await extra(watch.id, 310)).toEqual({ status: "ineligible_or_claimed" });
  });
  it("cotação cedo e, no apito, resposta sem a linha: o motivo é o da resposta", async () => {
    const { bet, watch } = await seed(); await earlyQuote(bet.id, -1800, 2);
    mocks.firstHalf = true; await extra(watch.id, -180); await extra(watch.id, 10);
    const frozen = await closing(bet.id);
    expect(frozen).toMatchObject({ clvReliable: false, noOddsReason: "market_not_listed" });
    expect(Number(frozen.closingRawOdd)).toBe(2);
  });
  it("resposta vazia no apito é falha passageira do feed: a captura é que faltou", async () => {
    const { bet, watch } = await seed(); mocks.empty = true;
    await extra(watch.id, -180); await extra(watch.id, 10);
    expect(await db.prisma.priceArchiveObservation.count()).toBe(1);
    expect(await closing(bet.id)).toMatchObject({ closingOdd: null, clvReliable: false, noOddsReason: "kickoff_sem_captura" });
  });
  it("cotação dentro dos 10 min finais substitui a cedo e vira o fechamento confiável", async () => {
    const { bet, watch } = await seed(); await earlyQuote(bet.id, -1800, 2);
    mocks.raw = 1.9; await extra(watch.id, -180); await extra(watch.id, 10);
    const row = await closing(bet.id);
    expect(row).toMatchObject({ clvReliable: true, noOddsReason: null });
    expect(Number(row.closingRawOdd)).toBe(1.9);
  });
  it("jogo adiado pela Pinnacle: o horário do jogo vira o kickoff e o preço espera o horário novo", async () => {
    const { bet, watch } = await seed(); mocks.cutoff = at(7200).toISOString();
    await extra(watch.id, -180);
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).data).toEqual(at(7200));
    // Ação própria: a edição da aposta apaga as tentativas de kickoff, não esta.
    expect(await db.prisma.auditEvent.findFirst({ where: { action: "bet.kickoff_moved_by_provider", resourceId: bet.id } }))
      .toMatchObject({ actor: "system:closing-series", details: { anterior: KICK.toISOString(), novo: at(7200).toISOString() } });
    // No horário velho nada congela, e a série passa a vigiar o horário novo.
    await extra(watch.id, 10); await afterKickoff(bet.id, 60);
    expect((await db.prisma.betClosing.findUnique({ where: { betId: bet.id } }))?.fetchedAt ?? null).toBeNull();
    expect(await db.prisma.closingPriceWatch.count({ where: { betId: bet.id, kickoff: at(7200), completedAt: null } })).toBe(1);
  });
  it("jogo antecipado: o kickoff muda e a mesma cotação vale na janela do horário novo", async () => {
    const { bet } = await seed(); const ctx = await context(bet.id);
    const early = { ...await quote(bet.id, -1200, 1.9), gameStartAt: at(-900) };
    vi.setSystemTime(at(-1100));
    expect(await applyClosingQuote(ctx, early, "extra")).toBe(true);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).data).toEqual(at(-900));
    const row = await closing(bet.id);
    expect(row).toMatchObject({ clvReliable: true, noOddsReason: null });
    expect(Number(row.closingRawOdd)).toBe(1.9);
  });
  it("cotação velha não muda o kickoff", async () => {
    const { bet } = await seed(); const ctx = await context(bet.id);
    vi.setSystemTime(at(-20));
    expect(await applyClosingQuote(ctx, await quote(bet.id, -30, 1.8), "extra")).toBe(true);
    // Resposta mais antiga, guardada no arquivo, já com o jogo remarcado.
    const stale = priceEnvelope("pinnacle17", at(-180));
    (stale.body as { markets: Array<{ cutoffAt: string }> }).markets[0]!.cutoffAt = at(7200).toISOString();
    await archivePriceResponse(stale);
    const archived = await archivedClosingQuote(ctx, new Date());
    expect(archived?.observedAt).toEqual(at(-180));
    expect(await applyClosingQuote(ctx, archived!, "archive")).toBe(false);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).data).toEqual(KICK);
  });
  it("aposta liquidada não muda o kickoff", async () => {
    const { bet, watch } = await seed();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { status: "WON", settledAt: at(-600), lucro: 1.5 } });
    mocks.cutoff = at(7200).toISOString(); await extra(watch.id, -180);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).data).toEqual(KICK);
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.kickoff_moved_by_provider" } })).toBe(0);
  });
  it("mercado de período nunca muda o kickoff", async () => {
    const { bet } = await seed();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { mercado: "Money Line – 1st Half" } });
    const watch = await ensureClosingWatch(bet.id, boss); if (!watch) throw new Error("watch fixture");
    mocks.firstHalf = true; mocks.cutoff = at(7200).toISOString(); await extra(watch.id, -240);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).data).toEqual(KICK);
    expect((await closing(bet.id)).clvReliable).toBe(true);
  });
  it("remarcação acima de 3 h não muda o kickoff nem grava preço: vira ação para o dono", async () => {
    const { bet } = await seed(); const ctx = await context(bet.id);
    const far = { ...await quote(bet.id, -60, 1.8), gameStartAt: at(4 * 3600) };
    vi.setSystemTime(at(-50));
    expect(await applyClosingQuote(ctx, far, "extra")).toBe(false);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).data).toEqual(KICK);
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(mocks.alert).toHaveBeenCalledWith(expect.stringContaining("Jogo remarcado"),
      expect.objectContaining({ key: `kickoff-drift:${bet.id}`, resourceId: bet.id }));
  });
  it("falhas finais não removem CLV válido, inclusive referência com mais de 120 segundos", async () => {
    const { bet, watch } = await seed(); await extra(watch.id, -300);
    mocks.raw = 1.9; await extra(watch.id, -180); const valid = await closing(bet.id);
    mocks.status = 500; await extra(watch.id, -105); await extra(watch.id, -30); await extra(watch.id, 10);
    const after = await closing(bet.id);
    expect([after.closingOdd, after.closingRawOdd, after.clv, after.clvReliable, after.closingPriceObservedAt])
      .toEqual([valid.closingOdd, valid.closingRawOdd, valid.clv, true, valid.closingPriceObservedAt]);
    expect(await db.prisma.closingPriceObservation.count({ where: { watchId: watch.id, outcome: "unavailable" } })).toBeGreaterThan(0);
  });
  it("reserva a quinta tentativa extra para o último ponto mesmo após quatro falhas", async () => {
    const { bet, watch } = await seed(); mocks.status = 500;
    // Depois da conferência do horário, a primária e quatro extras falham.
    for (let attempt = 0; attempt < 6; attempt++) {
      vi.setSystemTime((await db.prisma.closingPriceWatch.findUniqueOrThrow({ where: { id: watch.id } })).nextAttemptAt);
      await runClosingWatch(watch.id, boss);
    }
    await extra(watch.id, -60); expect(mocks.physical).toHaveBeenCalledTimes(5);
    mocks.status = 200; mocks.raw = 1.8; await extra(watch.id, -30); await extra(watch.id, 10);
    expect(mocks.physical).toHaveBeenCalledTimes(6); expect((await closing(bet.id)).clvReliable).toBe(true);
  });
  it("arquivo sobrevive à falha de aplicação; restart após kickoff recupera sem HTTP", async () => {
    const { bet, watch } = await seed();
    await db.prisma.$executeRawUnsafe(`CREATE FUNCTION c18_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='closing.series.price_applied' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await db.prisma.$executeRawUnsafe(`CREATE TRIGGER c18_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION c18_fail_audit()`);
    try { await extra(watch.id, -180); expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull(); }
    finally { await db.prisma.$executeRawUnsafe('DROP TRIGGER c18_fail_audit ON audit_events'); await db.prisma.$executeRawUnsafe('DROP FUNCTION c18_fail_audit()'); }
    await db.prisma.providerCache.deleteMany();
    await extra(watch.id, 60);
    expect(mocks.physical).toHaveBeenCalledOnce(); expect((await closing(bet.id)).clvReliable).toBe(true);
    expect((await closing(bet.id)).source).toBe("REPROCESS");
  });
  it("finalização com leitura antiga não apaga captura que chegou entre leitura e commit", async () => {
    const { bet } = await seed(); const stale = await context(bet.id), valid = await quote(bet.id, -30, 1.8);
    vi.setSystemTime(at(10));
    await Promise.all([finalizeClosingSeries(stale), applyClosingQuote(stale, valid, "extra")]);
    const row = await closing(bet.id); expect(row.clvReliable).toBe(true); expect(Number(row.closingRawOdd)).toBe(1.8);
  });
  it("resposta antiga não substitui referência mais recente, inclusive depois do freeze", async () => {
    const { bet } = await seed(); const ctx = await context(bet.id);
    const old = await quote(bet.id, -180, 2), latest = await quote(bet.id, -30, 1.8); vi.setSystemTime(at(10));
    expect(await applyClosingQuote(ctx, latest, "extra")).toBe(true);
    expect(await applyClosingQuote(ctx, old, "primary")).toBe(false);
    expect(Number((await closing(bet.id)).closingRawOdd)).toBe(1.8);
  });
  it.each(["same-watch", "same-event"])("concorrência %s compra uma resposta e conserva apostas distintas", async (kind) => {
    const a = await seed(); const b = kind === "same-event" ? await seed("CLV_ONLY", 123, 2.7) : a;
    vi.setSystemTime(at(-180)); mocks.beforeResponse = () => new Promise((resolve) => setTimeout(resolve, 60));
    await Promise.all([runClosingWatch(a.watch.id, boss), runClosingWatch(b.watch.id, boss)]);
    expect(mocks.physical).toHaveBeenCalledOnce(); expect(await db.prisma.bet.count()).toBe(kind === "same-event" ? 2 : 1);
    if (kind === "same-event") expect(Number((await closing(a.bet.id)).clv)).not.toBe(Number((await closing(b.bet.id)).clv));
  });
  it("teto extra não impede a consulta primária de outra partida", async () => {
    mocks.cap = 1; const a = await seed(); const b = await seed("CLV_ONLY", 456);
    await extra(a.watch.id, -300); await extra(b.watch.id, -299);
    await extra(a.watch.id, -180); await extra(b.watch.id, -179);
    // As duas primárias vão pela reserva; das extras, só a primeira cabe no teto de 1.
    expect(mocks.physical).toHaveBeenCalledTimes(3); expect((await closing(b.bet.id)).clvReliable).toBe(true);
    expect((await db.prisma.closingPriceBudget.findUniqueOrThrow({ where: { day: spDayKey(KICK) } })).spent).toBe(1);
    expect(await db.prisma.closingPriceObservation.count({ where: { watchId: b.watch.id, outcome: "quota" } })).toBe(1);
  });
  it("limite diário não reinicia ao apagar a aposta", async () => {
    mocks.cap = 1; const a = await seed(); await extra(a.watch.id, -300); await extra(a.watch.id, -180);
    await db.prisma.bet.delete({ where: { id: a.bet.id } });
    const b = await seed("CLV_ONLY", 456); await extra(b.watch.id, -180); await extra(b.watch.id, -105);
    expect(mocks.physical).toHaveBeenCalledTimes(3); expect(await db.prisma.closingPriceBudget.count()).toBe(1);
    expect((await db.prisma.closingPriceBudget.findUniqueOrThrow({ where: { day: spDayKey(KICK) } })).spent).toBe(1);
  });
  it("quota e reservas esgotadas preservam a referência existente", async () => {
    const { bet, watch } = await seed(); await extra(watch.id, -300); const previous = await closing(bet.id);
    await db.prisma.providerBudget.updateMany({ data: { spent: 7500, reserved: 100 } });
    await extra(watch.id, -180); expect(mocks.physical).toHaveBeenCalledOnce();
    expect((await closing(bet.id)).closingOdd).toEqual(previous.closingOdd); expect(await db.prisma.closingPriceBudget.count()).toBe(0);
  });
  it("cache recente não gasta quota extra; o ponto seguinte obtém preço novo", async () => {
    const { bet, watch } = await seed();
    // A primária responde sem a linha, e a nova tentativa 30 s depois lê o cache.
    mocks.firstHalf = true; await extra(watch.id, -300); await extra(watch.id, -270);
    expect(mocks.physical).toHaveBeenCalledOnce(); expect(await db.prisma.closingPriceBudget.count()).toBe(0);
    mocks.firstHalf = false; mocks.raw = 1.8; await extra(watch.id, -180); expect(mocks.physical).toHaveBeenCalledTimes(2);
    expect(Number((await closing(bet.id)).closingRawOdd)).toBe(1.8);
  });
  it.each(["manual", "manual-empty", "market", "selection", "odds", "identity", "kickoff", "mode", "removed", "source"])("mudança de %s durante HTTP impede escrita atrasada", async (kind) => {
    const { bet, bankroll, watch } = await seed();
    mocks.beforeResponse = async () => {
      if (kind === "manual" || kind === "manual-empty") await db.prisma.betClosing.create({ data: { betId: bet.id, source: "MANUAL",
        ...(kind === "manual" ? { closingOdd: 2.2, closingRawOdd: 2.1, clv: 10, clvReliable: true, fetchedAt: at(-179) } : {}) } });
      if (kind === "market") await db.prisma.bet.update({ where: { id: bet.id }, data: { mercado: "Total – Match" } });
      if (kind === "selection") await db.prisma.bet.update({ where: { id: bet.id }, data: { selecao: "Beta" } });
      if (kind === "odds") await db.prisma.bet.update({ where: { id: bet.id }, data: { odds: 2.8 } });
      if (kind === "identity") await db.prisma.betSharp.update({ where: { betId: bet.id }, data: { providerMatchId: "999" } });
      if (kind === "kickoff") await db.prisma.bet.update({ where: { id: bet.id }, data: { data: at(900) } });
      if (kind === "mode") await db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { sharpMode: "OFF" } });
      if (kind === "removed") await db.prisma.bet.update({ where: { id: bet.id }, data: { deletedAt: at(-179) } });
      if (kind === "source") await db.prisma.bet.update({ where: { id: bet.id }, data: { sourcePostedAt: at(-500) } });
    };
    await extra(watch.id, -180); expect(mocks.physical).toHaveBeenCalledOnce();
    const row = await db.prisma.betClosing.findUnique({ where: { betId: bet.id } });
    if (kind.startsWith("manual")) expect(row?.source).toBe("MANUAL"); else expect(row).toBeNull();
    expect(await db.prisma.auditEvent.count({ where: { action: "closing.series.price_applied" } })).toBe(0);
  });
  it.each(["source", "segment", "mode", "provider-off"])("mudança de %s depois do claim impede gasto", async (kind) => {
    const { bet, bankroll, watch } = await seed();
    mocks.beforeAttempt = async () => {
      if (kind === "source") await db.prisma.bet.update({ where: { id: bet.id }, data: { sourcePostedAt: at(-500) } });
      if (kind === "segment") await db.prisma.marketSegmentPolicy.create({ data: { esporte: bet.esporte, mercado: bet.mercado, phase: "SHARP_OFF" } });
      if (kind === "mode") await db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { sharpMode: "OFF" } });
      if (kind === "provider-off") mocks.mode = "off";
    };
    await extra(watch.id, -180); expect(mocks.physical).not.toHaveBeenCalled(); expect(await db.prisma.closingPriceBudget.count()).toBe(0);
  });
  it("resposta pós-kickoff não substitui captura prévia e não há HTTP novo depois do início", async () => {
    const { bet, watch } = await seed(); await extra(watch.id, -300); const previous = await closing(bet.id);
    mocks.raw = 1.8; mocks.beforeResponse = async () => { vi.setSystemTime(at(1)); };
    await extra(watch.id, -2); await extra(watch.id, 10); await afterKickoff(bet.id, 60);
    expect((await closing(bet.id)).closingOdd).toEqual(previous.closingOdd); expect(mocks.physical).toHaveBeenCalledTimes(2);
  });
  it("livro live não apaga referência válida", async () => {
    const { bet, watch } = await seed(); await extra(watch.id, -300); const previous = await closing(bet.id);
    mocks.live = true; await extra(watch.id, -105); await extra(watch.id, 10);
    expect(mocks.physical).toHaveBeenCalledTimes(2);
    expect((await closing(bet.id)).closingOdd).toEqual(previous.closingOdd); expect((await closing(bet.id)).clvReliable).toBe(true);
  });
  it("varredura recompõe agenda perdida sem depender de fechamentos históricos Bridge", async () => {
    const { bet, watch } = await seed(); await db.prisma.closingPriceWatch.delete({ where: { id: watch.id } }); mocks.send.mockClear();
    await maintainClosingSeries(boss); expect(await db.prisma.closingPriceWatch.count({ where: { betId: bet.id } })).toBe(1);
    expect(mocks.send).toHaveBeenCalledOnce(); expect(mocks.physical).not.toHaveBeenCalled();
  });
  it("lease expirada é retomada pela manutenção", async () => {
    const { watch } = await seed(); await db.prisma.closingPriceWatch.update({ where: { id: watch.id },
      data: { leaseUntil: at(-181), leaseToken: crypto.randomUUID() } });
    await extra(watch.id, -180); expect(mocks.physical).toHaveBeenCalledOnce();
  });
  it("purga do arquivo entre resolução e aplicação impede uso da prova removida", async () => {
    const { bet } = await seed(); vi.setSystemTime(at(-30));
    await archivePriceResponse(priceEnvelope("pinnacle17", at(-31)));
    const ctx = await context(bet.id), q = await archivedClosingQuote(ctx, new Date()); expect(q).not.toBeNull();
    await db.prisma.priceArchiveObservation.deleteMany();
    expect(await applyClosingQuote(ctx, q!, "archive")).toBe(false); expect(await db.prisma.betClosing.count()).toBe(0);
  });
  it("corpo arquivado corrompido não recupera preço", async () => {
    const { bet } = await seed(); vi.setSystemTime(at(-30)); await archivePriceResponse(priceEnvelope("pinnacle17", at(-31)));
    const raw = await db.prisma.priceArchiveObservation.findFirstOrThrow();
    await db.prisma.priceArchiveObservation.delete({ where: { id: raw.id } });
    await db.prisma.priceArchiveObservation.create({ data: { ...raw, id: crypto.randomUUID(), sha256: "0".repeat(64) } });
    expect(await archivedClosingQuote(await context(bet.id), new Date())).toBeNull();
  });
  it("desligar o provedor após a coleta permite finalizar a referência já válida", async () => {
    const { bet, watch } = await seed(); await extra(watch.id, -180); mocks.mode = "off";
    await extra(watch.id, 10); expect((await closing(bet.id)).fetchedAt).not.toBeNull(); expect((await closing(bet.id)).clvReliable).toBe(true);
    expect(mocks.physical).toHaveBeenCalledOnce();
  });
  it("limpeza remove somente controles antigos e preserva preço aplicado", async () => {
    const { bet, watch } = await seed(); await extra(watch.id, -180); const previous = await closing(bet.id);
    vi.setSystemTime(new Date(KICK.getTime() + 31 * 86_400_000)); await maintainClosingSeries(boss);
    expect(await db.prisma.closingPriceWatch.count()).toBe(0); expect(await db.prisma.closingPriceObservation.count()).toBe(0);
    expect(await db.prisma.closingPriceBudget.count()).toBe(0); expect((await closing(bet.id)).closingOdd).toEqual(previous.closingOdd);
  });
  it("contexto e observações não podem ser reescritos", async () => {
    const { watch } = await seed(); await expect(db.prisma.closingPriceWatch.update({ where: { id: watch.id }, data: { eventId: "999" } })).rejects.toThrow();
    await extra(watch.id, -180); const observation = await db.prisma.closingPriceObservation.findFirstOrThrow();
    await expect(db.prisma.closingPriceObservation.update({ where: { id: observation.id }, data: { outcome: "unavailable" } })).rejects.toThrow();
  });
  it("diagnóstico tem limite por contexto e não apaga preço quando enche", async () => {
    const { bet, watch } = await seed(); await extra(watch.id, -180);
    await db.prisma.closingPriceObservation.createMany({ data: Array.from({ length: 16 }, () => ({ watchId: watch.id, attemptedAt: at(-179), source: "extra", outcome: "unavailable" })) });
    mocks.raw = 1.8; await extra(watch.id, -30); expect(Number((await closing(bet.id)).closingRawOdd)).toBe(1.8);
  });
  it("troca de modo da banca impede replay antigo mesmo com modo final igual", async () => {
    const { bet, bankroll, watch } = await seed(); vi.setSystemTime(at(-30)); await archivePriceResponse(priceEnvelope("pinnacle17", at(-31)));
    const previous = closingContextHash(await context(bet.id));
    // Editar o nome não muda o contexto; o modo ir a OFF e voltar muda.
    await editarBankroll(bankroll.id, { nome: "Outro nome" });
    expect(closingContextHash(await context(bet.id))).toBe(previous);
    await editarBankroll(bankroll.id, { sharpMode: "OFF" }); await editarBankroll(bankroll.id, { sharpMode: "CLV_ONLY" });
    expect(closingContextHash(await context(bet.id))).not.toBe(previous); await extra(watch.id, 10);
    expect(await db.prisma.betClosing.count()).toBe(0); expect(mocks.physical).not.toHaveBeenCalled();
  });
  it("cadência guarda a tentativa final e finaliza localmente após o corte", () => {
    expect(nextClosingOpportunity(KICK, at(-600), false, 0)).toEqual(at(-300));
    expect(nextClosingOpportunity(KICK, at(-299), false, 0)).toEqual(at(-180));
    expect(nextClosingOpportunity(KICK, at(-80), true, 4)).toEqual(at(-30));
    expect(nextClosingOpportunity(KICK, at(-29), true, 5)).toEqual(at(10));
    expect(nextClosingOpportunity(KICK, at(60), true, 5)).toEqual(at(360));
  });
  it("agenda persistida sobrevive à indisponibilidade da fila", async () => {
    const { bet, watch } = await seed(); await db.prisma.closingPriceWatch.delete({ where: { id: watch.id } });
    mocks.send.mockRejectedValueOnce(new Error("synthetic queue outage"));
    const persisted = await ensureClosingWatch(bet.id, boss); expect(persisted).not.toBeNull();
    vi.setSystemTime(at(-180)); mocks.send.mockClear(); await maintainClosingSeries(boss);
    expect(mocks.send).toHaveBeenCalledWith("closing.price_series", { watchId: persisted!.id }, expect.any(Object));
  });
  it("jogos pré-kickoff têm prioridade sobre recuperações históricas", async () => {
    const { watch } = await seed(); mocks.send.mockClear();
    await enqueueClosingWatch(watch, boss, at(-30)); await enqueueClosingWatch(watch, boss, at(10));
    expect(mocks.send).toHaveBeenNthCalledWith(1, "closing.price_series", { watchId: watch.id }, expect.objectContaining({ priority: 20 }));
    expect(mocks.send).toHaveBeenNthCalledWith(2, "closing.price_series", { watchId: watch.id }, expect.objectContaining({ priority: 0 }));
  });
  it("jogo antecipado 15 min pela Pinnacle: a conferência do horário remarca e o fechamento sai confiável", async () => {
    vi.setSystemTime(at(-3600)); const { bet, watch } = await seed();
    expect(watch.nextAttemptAt).toEqual(at(-3600));
    // O feed de jogos e o corte do mercado já dão o horário novo; dali em diante o livro é live.
    mocks.startTime = at(-900).toISOString(); mocks.cutoff = at(-900).toISOString(); mocks.startedAt = at(-900);
    expect(await extra(watch.id, -3600)).toMatchObject({ status: "rescheduled" });
    expect(mocks.physical).not.toHaveBeenCalled(); expect(mocks.feed).toHaveBeenCalledOnce();
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).data).toEqual(at(-900));
    expect(await db.prisma.auditEvent.findFirst({ where: { action: "bet.kickoff_moved_by_provider", resourceId: bet.id } }))
      .toMatchObject({ details: { via: "sport/matches", anterior: KICK.toISOString(), novo: at(-900).toISOString() } });
    const moved = await db.prisma.closingPriceWatch.findFirstOrThrow({ where: { betId: bet.id, completedAt: null } });
    expect(moved.kickoff).toEqual(at(-900));
    await extra(moved.id, -3600); expect(mocks.feed).toHaveBeenCalledOnce();
    mocks.raw = 1.9; await extra(moved.id, -1200); await extra(moved.id, -890);
    const row = await closing(bet.id);
    expect(row).toMatchObject({ clvReliable: true, noOddsReason: null }); expect(Number(row.closingRawOdd)).toBe(1.9);
  });
  it("as conferências do horário, aos 90 e aos 45 min, sem mudança levam à consulta primária", async () => {
    vi.setSystemTime(at(-6000)); const { watch } = await seed();
    expect(watch.nextAttemptAt).toEqual(at(-5400));
    const next = async () => (await db.prisma.closingPriceWatch.findUniqueOrThrow({ where: { id: watch.id } })).nextAttemptAt;
    expect(await extra(watch.id, -5400)).toMatchObject({ status: "schedule_checked" }); expect(await next()).toEqual(at(-2700));
    expect(await extra(watch.id, -2700)).toMatchObject({ status: "schedule_checked" }); expect(await next()).toEqual(at(-300));
    // O cache do feed dura 15 min: a segunda conferência lê o feed de novo.
    expect(mocks.feed).toHaveBeenCalledTimes(2);
    expect(mocks.physical).not.toHaveBeenCalled(); expect(await db.prisma.closingPriceBudget.count()).toBe(0);
  });
  it("jogo antecipado 50 min: a conferência dos 90 min remarca e o fechamento sai confiável", async () => {
    vi.setSystemTime(at(-6000)); const { bet, watch } = await seed();
    mocks.startTime = at(-3000).toISOString(); mocks.cutoff = at(-3000).toISOString(); mocks.startedAt = at(-3000);
    expect(await extra(watch.id, -5400)).toMatchObject({ status: "rescheduled" });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).data).toEqual(at(-3000));
    const moved = await db.prisma.closingPriceWatch.findFirstOrThrow({ where: { betId: bet.id, completedAt: null } });
    await extra(moved.id, -5400);
    mocks.raw = 1.9; await extra(moved.id, -3300); await extra(moved.id, -2990);
    expect((await closing(bet.id)).clvReliable).toBe(true);
  });
  it("horário do feed que já passou não remarca, mesmo com o feed dizendo que o jogo não começou", async () => {
    vi.setSystemTime(at(-2800)); const { bet, watch } = await seed();
    mocks.startTime = at(-2760).toISOString();
    expect(await extra(watch.id, -2700)).toMatchObject({ status: "schedule_checked" });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).data).toEqual(KICK);
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.kickoff_moved_by_provider" } })).toBe(0);
  });
  it("aposta removida antes dos 5 min e restaurada depois deles ainda fecha com CLV confiável", async () => {
    const { bet, watch } = await seed();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { deletedAt: at(-400) } });
    expect(await extra(watch.id, -300)).toMatchObject({ status: "obsolete" });
    vi.setSystemTime(at(-240)); await db.prisma.bet.update({ where: { id: bet.id }, data: { deletedAt: null } });
    mocks.send.mockClear(); await maintainClosingSeries(boss);
    expect(mocks.send).toHaveBeenCalledWith("closing.price_series", { watchId: watch.id }, expect.any(Object));
    mocks.raw = 1.9; await extra(watch.id, -240); await extra(watch.id, 10);
    const row = await closing(bet.id);
    expect(row.clvReliable).toBe(true); expect(Number(row.closingRawOdd)).toBe(1.9);
  });
  it("a consulta primária tem 25 s por tentativa e uma retentativa, dentro da posse da agenda", async () => {
    const { watch } = await seed(); await extra(watch.id, -300); await extra(watch.id, -180);
    const [primary, following] = mocks.physical.mock.calls.map(([params]) => params as { timeoutMs: number; maxRetries: number; signal?: AbortSignal });
    expect(primary).toMatchObject({ timeoutMs: 25_000, maxRetries: 1 }); expect(primary?.signal).toBeInstanceOf(AbortSignal);
    expect(following).toMatchObject({ timeoutMs: 8_000, maxRetries: 0 });
  });
  it("reserva que some antes do consumo não conta como consulta: a extra tenta na mesma volta", async () => {
    const { bet, watch } = await seed();
    mocks.beforeAttempt = async () => { await db.prisma.providerBudgetReservation.deleteMany(); };
    mocks.raw = 1.9; await extra(watch.id, -300);
    expect(mocks.physical).toHaveBeenCalledOnce(); expect((await closing(bet.id)).clvReliable).toBe(true);
    expect((await db.prisma.closingPriceBudget.findUniqueOrThrow({ where: { day: spDayKey(KICK) } })).spent).toBe(1);
  });
  it("reserva e extras sem orçamento: a primária tenta uma vez pelo orçamento geral do dia", async () => {
    mocks.cap = 0; const { bet, watch } = await seed();
    mocks.beforeAttempt = async () => { await db.prisma.providerBudgetReservation.deleteMany(); };
    mocks.raw = 1.9; await extra(watch.id, -300);
    expect(mocks.physical).toHaveBeenCalledOnce(); expect((await closing(bet.id)).clvReliable).toBe(true);
    expect(await db.prisma.closingPriceObservation.findFirst({ where: { watchId: watch.id, outcome: "applied" } }))
      .toMatchObject({ source: "primary" });
    await extra(watch.id, -180); expect(mocks.physical).toHaveBeenCalledOnce();
  });
  it("agenda da versão anterior, marcada para os 3 min e sem consulta, volta ao começo da agenda", async () => {
    const { bet, watch } = await seed();
    await db.prisma.closingPriceWatch.update({ where: { id: watch.id }, data: { nextAttemptAt: at(-180) } });
    mocks.send.mockClear(); await maintainClosingSeries(boss);
    expect((await db.prisma.closingPriceWatch.findUniqueOrThrow({ where: { id: watch.id } })).nextAttemptAt).toEqual(at(-600));
    expect(mocks.send).toHaveBeenCalledWith("closing.price_series", { watchId: watch.id }, expect.any(Object));
    // Conferida, a agenda fica na consulta primária: a varredura não a puxa de novo.
    await extra(watch.id, -600); vi.setSystemTime(at(-590)); await maintainClosingSeries(boss);
    expect((await db.prisma.closingPriceWatch.findUniqueOrThrow({ where: { id: watch.id } })).nextAttemptAt).toEqual(at(-300));
    mocks.raw = 1.9; await extra(watch.id, -300);
    expect(mocks.physical).toHaveBeenCalledOnce(); expect((await closing(bet.id)).clvReliable).toBe(true);
  });
  it("varredura cria a agenda do horário novo quando o dono antecipa o jogo", async () => {
    vi.setSystemTime(at(-3600)); const { bet, watch } = await seed();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { data: at(-1800) } });
    mocks.startTime = at(-1800).toISOString(); mocks.cutoff = at(-1800).toISOString();
    await maintainClosingSeries(boss);
    const current = await db.prisma.closingPriceWatch.findFirstOrThrow({ where: { betId: bet.id, kickoff: at(-1800), completedAt: null } });
    expect(current.id).not.toBe(watch.id);
    await extra(current.id, -3600); mocks.raw = 1.9; await extra(current.id, -2100); await extra(current.id, -1790);
    expect((await closing(bet.id)).clvReliable).toBe(true);
  });
  it("teto de 20 mil agendas, com aviso quando bate", async () => {
    const { bet } = await seed();
    const fill = (from: number, to: number) => db.prisma.$executeRawUnsafe(`INSERT INTO closing_price_watches
      (id, "betId", "contextHash", "eventId", kickoff, "createdAt", "nextAttemptAt")
      SELECT gen_random_uuid(), $1, md5(g::text) || md5((-g)::text), '1', $2, $3, $2 FROM generate_series(${from}, ${to}) g`,
    bet.id, KICK, at(-600));
    await fill(1, 4_999);
    // Com 5 mil agendas guardadas, a aposta nova ainda ganha a dela.
    await seed("CLV_ONLY", 456);
    await fill(5_000, 19_998);
    await expect(seed("CLV_ONLY", 789)).rejects.toThrow("watch fixture");
    expect(mocks.alert).toHaveBeenCalledWith(expect.stringContaining("Agenda do fechamento cheia"),
      expect.objectContaining({ source: "closing.series", key: "watch-cap" }));
  });
  it.each(["registration", "mode-roundtrip"])("cache anterior a %s não preenche fechamento pela consulta primária", async (kind) => {
    const observedAt = at(-240);
    const { bet, watch, bankroll } = await seed("CLV_ONLY", 123, 2.5, kind === "registration" ? at(-200) : SOURCE);
    await writeProviderCache({ provider: "pinnacle17", key: "odds:123:prematch:v2",
      data: normalizePinnacle17Markets(priceEnvelope("pinnacle17", observedAt).body)! as unknown as Prisma.InputJsonValue, ttlMs: 60_000, now: observedAt });
    if (kind === "mode-roundtrip") {
      vi.setSystemTime(at(-200));
      await editarBankroll(bankroll.id, { sharpMode: "OFF" });
      await editarBankroll(bankroll.id, { sharpMode: "CLV_ONLY" });
    }
    const currentWatch = kind === "mode-roundtrip" ? await ensureClosingWatch(bet.id, boss, at(-190)) : watch;
    if (!currentWatch) throw new Error("watch fixture");
    await extra(currentWatch.id, -190);
    expect((await db.prisma.betClosing.findUnique({ where: { betId: bet.id } }))?.closingOdd ?? null).toBeNull();
    expect(mocks.physical).not.toHaveBeenCalled();
  });
  it.each(["registration", "mode-roundtrip"])("commit recusa cotação anterior a %s, mesmo fora do leitor do cache", async (kind) => {
    const { bet, bankroll } = await seed();
    const previous = await quote(bet.id, -240, 2);
    vi.setSystemTime(at(-200));
    if (kind === "registration") await db.prisma.bet.update({ where: { id: bet.id }, data: { registradoEm: at(-200) } });
    else {
      await editarBankroll(bankroll.id, { sharpMode: "OFF" });
      await editarBankroll(bankroll.id, { sharpMode: "CLV_ONLY" });
    }
    expect(await applyClosingQuote(await context(bet.id), previous, "extra")).toBe(false);
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
  });
  it("resposta pedida antes do registro da aposta não preenche fechamento", async () => {
    vi.setSystemTime(at(-601)); await archivePriceResponse(priceEnvelope("pinnacle17", at(-601)));
    vi.setSystemTime(at(-600)); const { bet, watch } = await seed("CLV_ONLY", 123, 2.5, at(-600));
    vi.setSystemTime(at(10)); expect(await archivedClosingQuote(await context(bet.id), new Date())).toBeNull();
    await runClosingWatch(watch.id, boss); expect((await closing(bet.id)).closingOdd).toBeNull();
    expect(mocks.physical).not.toHaveBeenCalled();
  });
});
