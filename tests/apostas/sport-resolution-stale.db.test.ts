import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

const mocks = vi.hoisted(() => ({ collect: vi.fn(), learn: vi.fn() }));
vi.mock("@/src/services/bets/sport-resolution/collect-candidates", () => ({ collectSportCandidates: mocks.collect }));
vi.mock("@/src/services/teams/tipster-names", () => ({ learnTipsterTeamNames: mocks.learn }));

const { resolvePendingBetSport } = await import("@/src/services/bets/sport-resolution/resolve");

const candidate = { sport: "Soccer", confidence: 100, source: "PROVIDER", provider: "flashscore", matchId: "old-fixture" };
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });

async function seedPendingSportBet() {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Stale", slug: "stale", valorUnidade: 100 } });
  return db.prisma.bet.create({
    data: {
      bankrollId: bankroll.id, evento: "Old Home vs Old Away", esporte: "Unknown",
      sportResolutionStatus: "PENDING", sportConfidence: 0, sportSource: "UNRESOLVED",
      data: new Date(Date.now() + 3_600_000), mercado: "Total", selecao: "Over 2.5",
      odds: 2, stake: 1, casaDeAposta: "Book A", valorUnidade: 100, source: "telegram",
      captureEvidence: { create: { parser: "test", parsedJson: {}, expiresAt: new Date(Date.now() + 86_400_000) } },
    },
  });
}

beforeEach(async () => {
  await db.reset();
  vi.clearAllMocks();
});

it.each(["PENDING", "WON"] as const)("descarta decisão antiga após correção manual com status %s", async (status) => {
  const bet = await seedPendingSportBet();
  const corrected = {
    evento: "New Home vs New Away", esporte: "Basketball", sportResolutionStatus: "CONFIRMED" as const,
    sportSource: "MANUAL" as const, sportResolvedAt: new Date(), mercado: "Total de Pontos", selecao: "Over 180.5",
    data: new Date(Date.now() - 7_200_000), status, lucro: status === "WON" ? 1 : 0,
    settledAt: status === "WON" ? new Date() : null,
  };
  mocks.collect.mockImplementation(async () => {
    await db.prisma.bet.update({ where: { id: bet.id }, data: corrected });
    return [candidate];
  });

  const result = await resolvePendingBetSport(bet.id);

  expect(result).toMatchObject({ status: "pending", reason: "stale_bet", retryAt: expect.any(Date) });
  const row = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, include: { captureEvidence: true } });
  expect(row).toMatchObject({ evento: corrected.evento, esporte: "Basketball", mercado: corrected.mercado, status, sportSource: "MANUAL" });
  expect(row.captureEvidence?.candidatesJson).toBeNull();
  expect(await db.prisma.movimentacao.count()).toBe(0);
  expect(await db.prisma.auditEvent.count({ where: { action: "bet.edit" } })).toBe(0);
  expect(mocks.learn).not.toHaveBeenCalled();
});

it.each(["pending", "conflict"] as const)("descarta evidência %s obtida para termos anteriores", async (mode) => {
  const bet = await seedPendingSportBet();
  mocks.collect.mockImplementation(async () => {
    await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: "Other Home vs Other Away" } });
    return mode === "pending" ? [] : [candidate, { ...candidate, sport: "Basketball" }];
  });

  expect(await resolvePendingBetSport(bet.id, { attempt: 0 })).toMatchObject({ status: "pending", reason: "stale_bet" });
  const row = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, include: { captureEvidence: true } });
  expect(row).toMatchObject({ evento: "Other Home vs Other Away", sportResolutionStatus: "PENDING", sportEvidence: null });
  expect(row.captureEvidence?.candidatesJson).toBeNull();
  expect(mocks.learn).not.toHaveBeenCalled();
});

it("aplica a modalidade quando a versão original continua vigente", async () => {
  const bet = await seedPendingSportBet();
  mocks.collect.mockResolvedValue([candidate]);

  expect(await resolvePendingBetSport(bet.id)).toMatchObject({ status: "resolved" });
  const row = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, include: { captureEvidence: true } });
  expect(row).toMatchObject({ evento: "Old Home vs Old Away", esporte: "Soccer", sportResolutionStatus: "CONFIRMED" });
  expect(row.captureEvidence?.candidatesJson).toMatchObject({ selected: expect.objectContaining({ sport: "Soccer" }) });
});
