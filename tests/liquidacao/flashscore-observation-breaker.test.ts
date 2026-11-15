import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, CircuitOpenError, BudgetExhaustedError } = vi.hoisted(() => {
  class CircuitOpenError extends Error {
    readonly provider: string;
    constructor(name: string) {
      super(`Circuit breaker aberto para "${name}"`);
      this.name = "CircuitOpenError";
      this.provider = name;
    }
  }
  class BudgetExhaustedError extends Error {
    constructor(provider: string) {
      super(`Budget do provider ${provider} esgotado no periodo corrente.`);
      this.name = "BudgetExhaustedError";
    }
  }
  return {
    CircuitOpenError,
    BudgetExhaustedError,
    mocks: {
      isBreakerOpen: vi.fn(),
      stats: vi.fn(),
      listEligible: vi.fn(),
      listByDate: vi.fn(),
      getCatalog: vi.fn(),
      env: {},
      warn: vi.fn(),
    },
  };
});

vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));
vi.mock("@/src/infra/circuit-breaker", () => ({
  CircuitOpenError,
  isBreakerOpen: (...args: unknown[]) => mocks.isBreakerOpen(...args),
}));
vi.mock("@/src/domain/provider-error", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/domain/provider-error")>();
  return { ...actual, BudgetExhaustedError };
});
vi.mock("@/src/infra/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/src/infra/operational-metrics", () => ({
  recordOperationalMetric: vi.fn(),
}));
vi.mock("@/src/infra/prisma", () => ({ prisma: {} }));
vi.mock("@/src/providers/flashscore/client", () => ({
  flashscoreConfigured: () => true,
  getFlashscoreMatchStats: (...args: unknown[]) => mocks.stats(...args),
  listFlashscoreMatchesByDate: (...args: unknown[]) => mocks.listByDate(...args),
}));
vi.mock("@/src/providers/flashscore/catalog", () => ({
  getFlashscoreCatalog: (...args: unknown[]) => mocks.getCatalog(...args),
}));
vi.mock("@/src/providers/flashscore/sports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/providers/flashscore/sports")>()),
  flashscoreSportId: () => 1,
  flashscoreSettlesSportId: () => true,
}));
vi.mock("@/src/providers/flashscore/stats", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/providers/flashscore/stats")>()),
  normalizeFlashscoreStats: vi.fn(),
  marketNeedsFlashscoreStats: () => false,
}));
vi.mock("@/src/services/settlement/flashscore/observation-store", () => ({
  listFlashscoreEligibleBets: (...args: unknown[]) => mocks.listEligible(...args),
}));
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperationalAlert: vi.fn(),
}));

import { ProviderRequestError } from "@/src/domain/provider-error";
import { isFlashscoreUnavailable } from "@/src/services/settlement/flashscore/settle";
import { loadFlashscoreSettlementStats } from "@/src/services/settlement/flashscore/statistics";
import { runFlashscoreObservationOnce } from "@/src/services/settlement/flashscore/observation";
import { deferFlashscoreWork } from "@/src/providers/flashscore/breaker-gate";

describe("flashscore settlement respects open breaker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isBreakerOpen.mockResolvedValue(false);
    mocks.listEligible.mockResolvedValue([]);
    mocks.listByDate.mockResolvedValue([]);
    mocks.getCatalog.mockResolvedValue([]);
    mocks.stats.mockResolvedValue(null);
  });

  it("reconhece CircuitOpenError e BudgetExhausted como indisponibilidade", () => {
    expect(isFlashscoreUnavailable(new CircuitOpenError("flashscore"))).toBe(true);
    expect(isFlashscoreUnavailable(new BudgetExhaustedError("flashscore"))).toBe(true);
    expect(isFlashscoreUnavailable(new Error("boom"))).toBe(false);
  });

  it("loadFlashscoreSettlementStats repropaga CircuitOpenError sem embrulhar", async () => {
    mocks.stats.mockRejectedValue(new CircuitOpenError("flashscore"));
    const candidate = {
      swapped: false,
      score: 1,
      strategy: "name",
      match: {
        match_id: "abc",
        home_team: { red_cards: null },
        away_team: { red_cards: null },
      },
    } as never;
    try {
      await loadFlashscoreSettlementStats({
        betId: "bet-1",
        candidate,
        statsPeriod: "FT",
        cache: new Map(),
        listedRedCards: null,
      });
      expect.fail("deveria ter lançado CircuitOpenError");
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitOpenError);
      expect((error as Error).message).not.toMatch(/Falha ao consultar estatísticas/);
    }
  });

  it("adia o trabalho de liquidação com breaker aberto", async () => {
    mocks.isBreakerOpen.mockResolvedValue(true);
    await expect(deferFlashscoreWork("settlement", { processed: 3 })).resolves.toBe(true);
    expect(mocks.isBreakerOpen).toHaveBeenCalledWith("flashscore");
    expect(mocks.warn).toHaveBeenCalled();
  });

  it("runFlashscoreObservationOnce aborta sem list-by-date quando breaker aberto", async () => {
    mocks.isBreakerOpen.mockResolvedValue(true);
    mocks.listEligible.mockResolvedValue([
      {
        id: "bet-open-breaker",
        esporte: "Soccer",
        data: new Date("2026-09-18T20:00:00Z"),
        status: "PENDING",
      },
    ]);
    const result = await runFlashscoreObservationOnce(new Date("2026-09-19T12:00:00Z"));
    expect(result.processed).toBe(1);
    expect(result.failures).toBe(0);
    expect(mocks.listByDate).not.toHaveBeenCalled();
    expect(mocks.getCatalog).not.toHaveBeenCalled();
    expect(mocks.stats).not.toHaveBeenCalled();
  });

  it("catálogo fora do contrato num esporte×dia não para a liquidação dos outros grupos", async () => {
    mocks.listEligible.mockResolvedValue([
      { id: "bet-contrato", evento: "A vs B", esporte: "Soccer", data: new Date("2026-09-10T20:00:00Z"), status: "PENDING" },
      { id: "bet-20", evento: "C vs D", esporte: "Soccer", data: new Date("2026-09-20T20:00:00Z"), status: "PENDING" },
      { id: "bet-21", evento: "E vs F", esporte: "Soccer", data: new Date("2026-09-21T20:00:00Z"), status: "PENDING" },
    ]);
    mocks.getCatalog.mockImplementation(async (day: string) => {
      if (day === "2026-09-10") {
        throw new ProviderRequestError("FlashScore /matches/list-by-date", {
          status: 200, error: "payload fora do contrato esperado",
        });
      }
      return [];
    });

    await runFlashscoreObservationOnce(new Date("2026-09-22T12:00:00Z"));

    const days = mocks.getCatalog.mock.calls.map(([day]) => day);
    expect(days).toEqual(expect.arrayContaining(["2026-09-10", "2026-09-20", "2026-09-21"]));
  });

  it("HTTP recusado continua adiando os grupos seguintes", async () => {
    mocks.listEligible.mockResolvedValue([
      { id: "bet-503", evento: "A vs B", esporte: "Soccer", data: new Date("2026-09-10T20:00:00Z"), status: "PENDING" },
      { id: "bet-20", evento: "C vs D", esporte: "Soccer", data: new Date("2026-09-20T20:00:00Z"), status: "PENDING" },
    ]);
    mocks.getCatalog.mockRejectedValue(new ProviderRequestError("FlashScore /matches/list-by-date", {
      status: 503, error: "HTTP 503",
    }));

    const result = await runFlashscoreObservationOnce(new Date("2026-09-22T12:00:00Z"));

    expect(mocks.getCatalog).toHaveBeenCalledOnce();
    expect(result.failures).toBe(2);
  });
});
