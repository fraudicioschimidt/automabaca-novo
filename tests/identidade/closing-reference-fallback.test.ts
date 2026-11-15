import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePinn: vi.fn(),
}));

vi.mock("@/src/providers/coverage", () => ({
  oddsProviders: () => ["pinnacle17"],
}));
const spend = vi.hoisted(() => ({ allow: true }));
vi.mock("@/src/providers/pinnacle17/client", async (original) => ({
  ...await original<object>(),
  pinnacle17Enabled: () => spend.allow,
}));
vi.mock("@/src/providers/pinnacle17/types", async (original) => ({
  ...await original<object>(),
  encodePinnacle17PriceReference: () => "pinnacle17:v1:1234:0:total:10:under",
}));
vi.mock("@/src/providers/pinnacle17/sharp", () => ({
  resolvePinnacle17SharpForBet: mocks.resolvePinn,
  releasePinnacle17ClosingIfCreated: vi.fn(),
}));
vi.mock("@/src/services/teams/resolve", () => ({
  resolveTeamsForProvider: async (teams: { home: string; away: string }) => ({ ...teams }),
}));

const { tryClosingReferenceFallback } = await import(
  "@/src/services/sharp/enrich/pinnacle17-identity"
);

/**
 * Mercado que a Bridge não precifica (cartões): a referência de fechamento vem
 * da Pinnacle17, porque a série de CLV só roda para provider pinnacle17. Só a
 * referência é gravada; o preço fica para o fechamento.
 */
describe("referência de fechamento na Pinnacle17 após identidade Bridge", () => {
  beforeEach(() => {
    mocks.resolvePinn.mockReset();
    spend.allow = true;
  });

  it("não consulta Pinnacle17 quando a integração está desativada", async () => {
    spend.allow = false;
    mocks.resolvePinn.mockResolvedValue({ matched: true });
    const upsertSharp = vi.fn(async () => undefined);
    const done = await tryClosingReferenceFallback({
      betId: "bet-1",
      matchId: 1234,
      home: "France",
      away: "England",
      esporte: "Soccer",
      competicao: "World Cup",
      pais: "FIFA",
      mercado: "Total (Bookings) – Match",
      selecao: "Under 2.5",
      kickoffUtc: new Date("2026-07-19T19:00:00Z"),
      registradoEm: new Date(),
      confidence: 100,
      upsertSharp,
    });
    expect(done).toEqual({ done: false, reason: null });
    expect(mocks.resolvePinn).not.toHaveBeenCalled();
    expect(upsertSharp).not.toHaveBeenCalled();
  });

  it("entrega ao fechamento o provider e o evento da referência, com motivo clv_only", async () => {
    const observedAt = new Date();
    mocks.resolvePinn.mockResolvedValue({
      matched: true,
      current: { fair: 1.8, raw: 1.85, maxBet: 500 },
      mainEvent: { id: 1234, homeTeam: { name: "France" }, awayTeam: { name: "England" },
        league: { name: "World Cup", country: "FIFA" }, startTime: "2026-07-19T19:00:00Z" },
      priceReference: { provider: "pinnacle17", eventId: 1234, period: 0, marketType: "total", line: "10", outcome: "under" },
      currentObservedAt: observedAt, score: 2, swapped: false, closingReservationCreated: true,
    });
    const upsertSharp = vi.fn(async () => undefined);

    const done = await tryClosingReferenceFallback({
      betId: "bet-1",
      matchId: 1234,
      home: "France",
      away: "England",
      esporte: "Soccer",
      competicao: "World Cup",
      pais: "FIFA",
      mercado: "Total (Bookings) – Match",
      selecao: "Under 2.5",
      kickoffUtc: new Date("2026-07-19T19:00:00Z"),
      registradoEm: new Date(observedAt.getTime() - 60_000),
      confidence: 100,
      upsertSharp,
    });

    expect(done).toEqual({ done: true });
    // O evento é o de mesmo id da Bridge, não o que a busca por nome achar.
    expect(mocks.resolvePinn).toHaveBeenCalledWith(expect.objectContaining({ pinnedEventId: 1234 }));
    expect(upsertSharp).toHaveBeenCalledWith(
      "bet-1",
      expect.objectContaining({
        provider: "pinnacle17",
        providerMatchId: "1234",
        priceReference: "pinnacle17:v1:1234:0:total:10:under",
        noOddsReason: "clv_only",
      }),
    );
  });

  it.each([
    [{ matched: true, mainEvent: { id: 1234 }, priceReference: null, unresolvedReason: "line_mismatch" }, "line_mismatch"],
    [{ matched: true, mainEvent: { id: 1234 }, priceReference: null, unresolvedReason: null }, "no_prices"],
    [{ matched: false, mainEvent: null, priceReference: null, unresolvedReason: null }, "market_not_listed"],
  ])("sem a referência devolve o motivo da Pinnacle17 e não grava", async (result, reason) => {
    mocks.resolvePinn.mockResolvedValue({ ...result, closingReservationCreated: false });
    const upsertSharp = vi.fn(async () => undefined);
    const outcome = await tryClosingReferenceFallback({
      betId: "bet-1", matchId: 1234, home: "France", away: "England", esporte: "Soccer", competicao: "World Cup",
      pais: "FIFA", mercado: "Total (Bookings) – Match", selecao: "Under 2.5",
      kickoffUtc: new Date("2026-07-19T19:00:00Z"), registradoEm: new Date(), confidence: 100, upsertSharp,
    });
    expect(outcome).toEqual({ done: false, reason });
    expect(upsertSharp).not.toHaveBeenCalled();
  });
});
