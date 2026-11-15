import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getBetSettlementCard } from "@/app/_design/adapters/aposta";
import { createTestDb, type TestDb } from "../helpers/db";
import { halfFixture, HALF_NOW } from "../helpers/basketball-half";
import type { DetailsCache } from "@/src/services/settlement/flashscore/settle";
import type * as FlashscoreClient from "@/src/providers/flashscore/client";

const mocks = vi.hoisted(() => ({ details: vi.fn(), notify: vi.fn(async () => true) }));
vi.mock("@/src/providers/flashscore/client", async (original) => ({
  ...await original<typeof FlashscoreClient>(), getFlashscoreMatchDetails: mocks.details,
}));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperatorNotification: mocks.notify, sendOperationalAlert: vi.fn(async () => {}) }));
vi.mock("@/src/services/bets/settle-effects", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/services/bets/settle-effects")>(),
  finishBetStatusChange: vi.fn(async () => {}),
}));
const { processFlashscoreMatchOutcome } = await import("@/src/services/settlement/flashscore/match-outcome");
const { applyManualBetStatusChange } = await import("../helpers/settle");

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { vi.useRealTimers(); await db.dispose(); });
beforeEach(async () => { vi.useRealTimers(); await db.reset(); vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(HALF_NOW); });

async function seed(options: { mercado?: string; selecao?: string; swapped?: boolean } = {}) {
  const fixture = halfFixture(); fixture.candidate.swapped = options.swapped ?? false;
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "C41", slug: `c41-${crypto.randomUUID()}`, valorUnidade: 200 } });
  const conta = await db.prisma.conta.create({ data: { titular: "Sintético C41", casaDeAposta: "Betano", saldoInicial: 500, saldoAtual: 500 } });
  await db.prisma.contaBankroll.create({ data: { contaId: conta.id, bankrollId: bankroll.id } });
  const bet = await db.prisma.bet.create({ data: { bankrollId: bankroll.id, contaId: conta.id, casaDeAposta: "Betano",
    sportResolutionStatus: "CONFIRMED", sportResolvedAt: HALF_NOW, data: new Date(fixture.body.timestamp * 1_000),
    registradoEm: new Date((fixture.body.timestamp - 600) * 1_000),
    evento: options.swapped ? "Beta vs Alpha" : "Alpha vs Beta", esporte: "Basketball", competicao: "Synthetic 4Q", pais: "World",
    mercado: options.mercado ?? "Total de Pontos - 1º Tempo", selecao: options.selecao ?? "Over 82.5",
    odds: 2, stake: 1, valorUnidade: 100, status: "PENDING" }, include: { closing: true, result: true, sharp: true, captureEvidence: true } });
  mocks.details.mockResolvedValue(fixture.body);
  return { ...fixture, bet, conta };
}
function settle(f: Awaited<ReturnType<typeof seed>>, cache: DetailsCache = new Map()) {
  return processFlashscoreMatchOutcome({ bet: f.bet, candidate: f.candidate, sportId: 3,
    statsCache: new Map(), playerStatsCache: new Map(), summaryCache: new Map(), basketballDetailsCache: cache, now: HALF_NOW });
}

describe("basquete no 1º tempo: integração financeira e proteção contra falhas", () => {
  it("liquida, conserva unidade histórica e prova HT, sem gravar parcial como FT", async () => {
    const f = await seed(); const result = await settle(f);
    expect(result).toMatchObject({ settled: true, settlementOutcome: "settled_from_basketball_first_half" });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } })).toMatchObject({ status: "WON" });
    const conta = await db.prisma.conta.findUniqueOrThrow({ where: { id: f.conta.id } });
    expect(Number(conta.saldoAtual)).toBe(600);
    expect(await getBetSettlementCard(f.bet.id)).toMatchObject({
      score: { value: "47-39", kind: "decided", period: "HT" },
      outcome: "pelo placar do 1º tempo",
    });
    const stored = await db.prisma.betResult.findUniqueOrThrow({ where: { betId: f.bet.id } });
    expect(stored).toMatchObject({ scoreHome: null, scoreAway: null, resultFinal: true,
      resultSnapshot: { basketballFirstHalf: { period: "HT", score: { home: 47, away: 39 } } } });
    expect(await db.prisma.settlementEvent.count({ where: { betId: f.bet.id } })).toBe(1);
    await settle(f);
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: f.conta.id } })).saldoAtual)).toBe(600);
    expect(await db.prisma.settlementEvent.count({ where: { betId: f.bet.id } })).toBe(1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });
  it("a prova do 1º tempo grava a primeira olhada na aposta só quando ela ainda não tem", async () => {
    const fresh = await seed();
    await settle(fresh);
    const proofAt = (await db.prisma.betResult.findUniqueOrThrow({ where: { betId: fresh.bet.id } })).resultCheckedAt;
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: fresh.bet.id } })).flashscoreFirstCheckedAt).toEqual(proofAt);

    const looked = await seed();
    const firstLook = new Date(HALF_NOW.getTime() - 60 * 60_000);
    await db.prisma.$executeRaw`UPDATE bets SET "flashscoreFirstCheckedAt" = ${firstLook} WHERE id = ${looked.bet.id}`;
    await settle(looked);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: looked.bet.id } })).flashscoreFirstCheckedAt).toEqual(firstLook);
  });
  it.each([["Over 86", "VOID", 500], ["Under 82.5", "LOST", 400], ["Over 85.75", "HALF_WON", 550], ["Over 86.25", "HALF_LOST", 450]])("financeiro %s", async (selecao, status, saldo) => {
    const f = await seed({ selecao }); await settle(f);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } })).status).toBe(status);
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: f.conta.id } })).saldoAtual)).toBe(saldo);
  });
  it("handicap com ordem invertida usa o lado certo", async () => {
    const f = await seed({ mercado: "Handicap Asiático - 1º Tempo", selecao: "Beta +5.5", swapped: true });
    expect(await settle(f)).toMatchObject({ settled: true, basketballFirstHalf: { score: { home: 39, away: 47 } } });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } })).status).toBe("LOST");
  });
  it("compartilha detalhes entre duas apostas da mesma partida", async () => {
    const a = await seed(), b = await seed(); const cache: DetailsCache = new Map();
    await settle(a, cache); await settle(b, cache);
    expect(mocks.details).toHaveBeenCalledTimes(1);
  });
  it("parcial ausente mantém saldo e permite nova observação", async () => {
    const f = await seed(); Object.assign(f.body.scores, { home_2nd_quarter: null });
    expect(await settle(f)).toMatchObject({ settled: false, observationFinal: false });
    expect(await db.prisma.settlementEvent.count()).toBe(0);
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: f.conta.id } })).saldoAtual)).toBe(500);
  });
  it("término confirmado é obrigatório: não consulta nem liquida no intervalo", async () => {
    const f = await seed(); f.candidate.match.match_status.is_finished = false; f.candidate.match.match_status.is_in_progress = true;
    expect(await settle(f)).toMatchObject({ settled: false }); expect(mocks.details).not.toHaveBeenCalled();
  });
  it.each([
    { mercado: "Total - 1º Tempo incluindo OT" },
    { mercado: "Total incluindo OT", selecao: "Over 82.5 HT including overtime" },
  ])("contradição de período não cai no liquidador FT: %j", async (terms) => {
    const f = await seed(terms);
    expect(await settle(f)).toMatchObject({ settled: false, unsupported: true,
      settlementOutcome: "manual_basketball_half_unsupported_contract" });
    expect(mocks.details).not.toHaveBeenCalled();
    expect(await db.prisma.settlementEvent.count()).toBe(0);
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: f.conta.id } })).saldoAtual)).toBe(500);
  });
  it("entrada posterior ao início é recusada antes da consulta", async () => {
    const f = await seed(); f.bet.registradoEm = HALF_NOW;
    expect(await settle(f)).toMatchObject({ settled: false, unsupported: true }); expect(mocks.details).not.toHaveBeenCalled();
  });
  it("OCR tardio conserva o instante comprovado da postagem pré-jogo", async () => {
    const f = await seed();
    const updated = await db.prisma.bet.update({ where: { id: f.bet.id },
      data: { sourcePostedAt: f.bet.registradoEm, registradoEm: HALF_NOW } });
    Object.assign(f.bet, updated);
    expect(await settle(f)).toMatchObject({ settled: true });
  });
  it("aposta removida durante a consulta não recebe lançamento", async () => {
    const f = await seed(); mocks.details.mockImplementationOnce(async () => {
      await db.prisma.bet.update({ where: { id: f.bet.id }, data: { deletedAt: HALF_NOW } }); return f.body;
    });
    await expect(settle(f)).rejects.toThrow();
    expect(await db.prisma.settlementEvent.count()).toBe(0);
    expect(await db.prisma.movimentacao.count({ where: { betId: f.bet.id } })).toBe(0);
  });
  it("mudança de odd durante a consulta recusa a prova antiga", async () => {
    const f = await seed(); mocks.details.mockImplementationOnce(async () => {
      await db.prisma.bet.update({ where: { id: f.bet.id }, data: { odds: 3 } }); return f.body;
    });
    await expect(settle(f)).rejects.toThrow("mutação material");
    expect(await db.prisma.settlementEvent.count()).toBe(0);
    expect(await db.prisma.movimentacao.count({ where: { betId: f.bet.id } })).toBe(0);
  });
  it("decisão manual concorrente é preservada", async () => {
    const f = await seed(); mocks.details.mockImplementationOnce(async () => {
      await applyManualBetStatusChange({ betId: f.bet.id, newStatus: "VOID", source: "web" }); return f.body;
    });
    expect(await settle(f)).toMatchObject({ settled: false, settlementOutcome: "already_settled" });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } })).status).toBe("VOID");
    expect(await db.prisma.settlementEvent.count()).toBe(1);
  });
  it("falha ao persistir prova desfaz resultado e ledger na mesma transação", async () => {
    const f = await seed();
    await db.prisma.$executeRawUnsafe("CREATE FUNCTION c41_fail_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'c41 proof write failed'; END $$");
    await db.prisma.$executeRawUnsafe("CREATE TRIGGER c41_fail_proof BEFORE INSERT ON bet_result FOR EACH ROW EXECUTE FUNCTION c41_fail_proof()");
    try {
      await expect(settle(f)).rejects.toThrow();
      expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } })).status).toBe("PENDING");
      expect(await db.prisma.settlementEvent.count()).toBe(0);
      expect(await db.prisma.movimentacao.count({ where: { betId: f.bet.id } })).toBe(0);
      expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: f.conta.id } })).saldoAtual)).toBe(500);
    } finally {
      await db.prisma.$executeRawUnsafe("DROP TRIGGER c41_fail_proof ON bet_result");
      await db.prisma.$executeRawUnsafe("DROP FUNCTION c41_fail_proof()");
    }
  });
});
