import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

const cancelPendingSharpEnrich = vi.fn().mockResolvedValue(0);
const cancelPendingSportResolution = vi.fn().mockResolvedValue(0);
const getSharedBoss = vi.fn().mockResolvedValue({ cancel: vi.fn() });

vi.mock("@/src/infra/boss", () => ({
  getSharedBoss: (...args: unknown[]) => getSharedBoss(...args),
}));

vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({
  cancelPendingSharpEnrich: (...args: unknown[]) => cancelPendingSharpEnrich(...args),
}));

vi.mock("@/src/services/scheduling/enqueue-sport-resolution", () => ({
  cancelPendingSportResolution: (...args: unknown[]) =>
    cancelPendingSportResolution(...args),
}));

const { applyAutomaticBetStatusChange } = await import("@/src/services/bets/settle");
const { softDeleteBet } = await import("@/src/services/bets/remove");

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  vi.clearAllMocks();
  cancelPendingSharpEnrich.mockResolvedValue(0);
  cancelPendingSportResolution.mockResolvedValue(0);
  getSharedBoss.mockResolvedValue({ cancel: vi.fn() });
});

async function seedPending() {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Banca", slug: `cancel-wire-${Date.now()}`, valorUnidade: 50 },
  });
  const conta = await db.prisma.conta.create({
    data: { casaDeAposta: "Betano", titular: "T", saldoInicial: 500, saldoAtual: 500 },
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      contaId: conta.id,
      data: new Date("2026-08-02T19:00:00Z"),
      evento: "Santos vs Grêmio",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Santos",
      odds: 1.8,
      stake: 2,
      valorUnidade: 50,
      status: "PENDING",
    },
  });
  return { bet };
}

describe("cancelPendingSharpEnrich wiring", () => {
  it("settle PENDING→WON chama cancelPendingSharpEnrich", async () => {
    const { bet } = await seedPending();
    await applyAutomaticBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "flashscore" },
      { client: db.prisma },
    );
    expect(getSharedBoss).toHaveBeenCalled();
    expect(cancelPendingSharpEnrich).toHaveBeenCalledWith(expect.anything(), bet.id, "settled");
  });

  it("softDeleteBet chama cancelPendingSharpEnrich", async () => {
    const { bet } = await seedPending();
    await softDeleteBet(
      { betId: bet.id, actor: "test", motivo: "não peguei", origin: "reacao" },
      { client: db.prisma },
    );
    expect(getSharedBoss).toHaveBeenCalled();
    expect(cancelPendingSharpEnrich).toHaveBeenCalledWith(expect.anything(), bet.id, "removed");
    expect(cancelPendingSportResolution).toHaveBeenCalledWith(
      expect.anything(),
      bet.id,
      "removed",
    );
  });
});
