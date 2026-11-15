import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Pinnacle17Client from "@/src/providers/pinnacle17/client";
import type { Pinnacle17Event } from "@/src/providers/pinnacle17/types";
import { BudgetExhaustedError } from "@/src/domain/provider-error";

const mocks = vi.hoisted(() => ({
  events: vi.fn(),
  fetchJson: vi.fn(),
  charge: vi.fn(async () => {}),
  reserve: vi.fn(async () => ({ ok: true, created: true })),
}));
vi.mock("@/src/providers/pinnacle17/client", async (original) => ({
  ...await original<typeof Pinnacle17Client>(),
  pinnacle17Enabled: () => true,
  fetchPinnacle17EventsOutcome: async (...args: unknown[]) => {
    const observed = await mocks.events(...args);
    return "kind" in observed ? observed : { kind: "observed", observed };
  },
}));
// A consulta de odds passa pelo cliente de verdade até o transporte.
vi.mock("@/src/infra/env", async (original) => {
  const actual = await original<typeof import("@/src/infra/env")>();
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), PINNACLE17_MODE: "on", PINNACLE17_RAPIDAPI_KEY: "pinnacle17-test-key" }) };
});
vi.mock("@/src/infra/circuit-breaker", () => ({
  withBreaker: (_name: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/src/providers/budget", () => ({
  chargeProviderRequest: mocks.charge,
  reconcileProviderBudgetFromProvider: vi.fn(async () => {}),
}));
vi.mock("@/src/providers/budget-reservations", () => ({
  reserveProviderBudget: mocks.reserve,
  consumeProviderBudgetReservation: vi.fn(async () => true),
  releaseProviderBudgetReservation: vi.fn(async () => {}),
}));
vi.mock("@/src/providers/request-cadence", () => ({ awaitProviderCadence: vi.fn(async () => {}) }));
vi.mock("@/src/providers/provider-cache", () => ({
  readProviderCache: vi.fn(async () => null),
  writeProviderCache: vi.fn(async () => {}),
}));
vi.mock("@/src/providers/price-archive/store", () => ({ archivePriceResponse: vi.fn(async () => {}) }));
vi.mock("@/src/providers/core/http", async (original) => ({
  ...await original<typeof import("@/src/providers/core/http")>(),
  fetchJsonWithRetry: mocks.fetchJson,
}));
import { resolvePinnacle17SharpForBet } from "@/src/providers/pinnacle17/sharp";

const KICKOFF = new Date("2026-09-24T19:00:00Z");
function event(id: number, home: string, away: string, startTime = KICKOFF): Pinnacle17Event {
  return {
    id, name: `${home} vs ${away}`, startTime: startTime.toISOString(),
    status: { isStarted: false, isInProgress: false, isInterrupted: false },
    sport: { id: 29, name: "Soccer" }, league: { id: 1, name: "Serie A", country: "Brazil" },
    homeTeam: { name: home }, awayTeam: { name: away }, units: "Regular",
  };
}
const request = {
  home: "Santos", away: "Palmeiras", esporte: "Soccer", mercado: "Money Line – Match", selecao: "Santos",
  kickoffUtc: KICKOFF, registradoEm: new Date(KICKOFF.getTime() - 3_600_000), competicao: "Serie A", pais: "Brazil",
  needOdds: false,
};

describe("resolvePinnacle17SharpForBet com id de evento conhecido", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("usa o evento do id conhecido mesmo com outro candidato de nome igual", async () => {
    mocks.events.mockResolvedValue({ observedAt: new Date(), data: [
      event(111, "Santos", "Palmeiras"),
      event(222, "Santos", "Palmeiras", new Date(KICKOFF.getTime() + 2 * 60_000)),
    ] });
    const result = await resolvePinnacle17SharpForBet({ ...request, pinnedEventId: 222 });
    expect(result).toMatchObject({ matched: true, swapped: false });
    expect(result.mainEvent?.id).toBe(222);
  });

  it("id conhecido em outro horário não casa, e não cai na busca por nome", async () => {
    mocks.events.mockResolvedValue({ observedAt: new Date(), data: [
      event(111, "Santos", "Palmeiras"),
      event(222, "Santos B", "Palmeiras B", new Date(KICKOFF.getTime() + 2 * 3_600_000)),
    ] });
    // Sem o id, a busca por nome casaria o 111.
    expect((await resolvePinnacle17SharpForBet(request)).mainEvent?.id).toBe(111);
    expect((await resolvePinnacle17SharpForBet({ ...request, pinnedEventId: 222 })).matched).toBe(false);
    expect((await resolvePinnacle17SharpForBet({ ...request, pinnedEventId: 333 })).matched).toBe(false);
  });

  it("id conhecido no mesmo horário, mas de outra categoria, não casa", async () => {
    mocks.events.mockResolvedValue({ observedAt: new Date(), data: [event(222, "Santos (W)", "Palmeiras (W)")] });
    expect((await resolvePinnacle17SharpForBet({ ...request, pinnedEventId: 222 })).matched).toBe(false);
  });
});

describe("resolvePinnacle17SharpForBet quando a lista de jogos não responde", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each([
    [{ kind: "failed", budget: false }, "consulta_pinnacle_falhou"],
    [{ kind: "failed", budget: true }, "cota_pinnacle_esgotada"],
  ])("a falha da consulta sai com o motivo, e não como jogo que a Pinnacle não tem", async (outcome, reason) => {
    mocks.events.mockResolvedValue(outcome);
    await expect(resolvePinnacle17SharpForBet(request)).resolves.toMatchObject({ matched: false, unresolvedReason: reason });
  });

  it("o dia sem o jogo continua sem motivo de falha", async () => {
    mocks.events.mockResolvedValue({ observedAt: new Date(), data: [] });
    await expect(resolvePinnacle17SharpForBet(request)).resolves.toMatchObject({ matched: false, unresolvedReason: null });
  });
});

describe("resolvePinnacle17SharpForBet quando a consulta de odds não responde", () => {
  const kickoff = new Date(Date.now() + 2 * 86_400_000);
  const priced = { ...request, kickoffUtc: kickoff, registradoEm: new Date(kickoff.getTime() - 3_600_000), needOdds: true };
  const moneyline = {
    name: "Money Line – Match", type: "moneyline", period: 0, periodName: "Match", team: null, units: "Regular",
    special: null, isLive: false, line: null, status: "open", cutoffAt: kickoff.toISOString(), limits: [],
    outcomes: [
      { designation: "home", name: "Santos", line: null, oddsAmerican: -124, oddsDecimal: 1.806 },
      { designation: "draw", name: "Draw", line: null, oddsAmerican: 257, oddsDecimal: 3.57 },
      { designation: "away", name: "Palmeiras", line: null, oddsAmerican: 356, oddsDecimal: 4.56 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.mockResolvedValue({ observedAt: new Date(), data: [event(111, "Santos", "Palmeiras", kickoff)] });
    mocks.charge.mockResolvedValue(undefined);
    mocks.reserve.mockResolvedValue({ ok: true, created: true });
  });

  it.each([
    ["503", async () => ({ ok: false, status: 503, error: "HTTP 503" })],
    ["429", async () => ({ ok: false, status: 429, error: "quota" })],
    ["timeout", async () => { throw new Error("timeout"); }],
  ])("%s é falha da consulta, não linha sem preço do fornecedor", async (_label, respond) => {
    mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      return respond();
    });
    const result = await resolvePinnacle17SharpForBet(priced);
    expect(result).toMatchObject({ matched: true, current: null, unresolvedReason: "consulta_pinnacle_falhou" });
  });

  it("cota esgotada antes da consulta é motivo de cota, não do fornecedor", async () => {
    mocks.charge.mockRejectedValue(new BudgetExhaustedError("pinnacle17", "match/odds"));
    mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      return { ok: true, status: 200, data: [moneyline] };
    });
    const result = await resolvePinnacle17SharpForBet(priced);
    expect(result).toMatchObject({ matched: true, current: null, unresolvedReason: "cota_pinnacle_esgotada" });
  });

  it("sem cota para reservar o fechamento, o motivo é a cota", async () => {
    mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      return { ok: true, status: 200, data: [moneyline] };
    });
    mocks.reserve.mockResolvedValue({ ok: false, created: false });
    const result = await resolvePinnacle17SharpForBet(priced);
    expect(result).toMatchObject({ matched: true, current: null, unresolvedReason: "cota_pinnacle_esgotada" });
    expect(result.priceReference).not.toBeNull();
  });

  it("resposta que chegou sem a linha continua sendo do fornecedor", async () => {
    mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      return { ok: true, status: 200, data: [{ ...moneyline, name: "Handicap – Match", type: "spread", line: -0.5,
        outcomes: moneyline.outcomes.filter((o) => o.designation !== "draw").map((o) => ({ ...o, line: -0.5 })) }] };
    });
    const result = await resolvePinnacle17SharpForBet(priced);
    expect(result.current).toBeNull();
    expect(result.unresolvedReason).not.toBe("consulta_pinnacle_falhou");
    expect(result.unresolvedReason).not.toBe("cota_pinnacle_esgotada");
  });
});
