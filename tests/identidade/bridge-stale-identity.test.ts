import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeMatchCandidate } from "@/src/providers/bridgeodds/scoring";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  refresh: vi.fn(),
  pinnacle17Configured: vi.fn(),
  identityProviders: vi.fn(),
  bridgeOddsIsAuthoritative: vi.fn(),
  pinnacle17: vi.fn(),
  recordTrainingCase: vi.fn(),
}));

vi.mock("@/src/infra/env", () => ({
  getEnv: () => ({ SHARP_AUTO_MATCH_MIN_SCORE: 1.6 }),
}));
vi.mock("@/src/providers/bridgeodds/match", () => ({
  findBridgeMatch: mocks.find,
  findBridgeMatchById: mocks.refresh,
  findBridgeMatchByIdWithEvidence: async (...args: unknown[]) => {
    const match = await mocks.refresh(...args);
    return match ? { match, observedAt: new Date("2026-08-13T19:00:00Z") } : null;
  },
}));
vi.mock("@/src/providers/bridgeodds/coverage-contract", async (original) => ({
  ...await original<object>(),
  bridgeSportFromEsporte: () => "soccer",
}));
vi.mock("@/src/providers/bridgeodds/client", () => ({
  bridgeConfigured: () => true,
}));
vi.mock("@/src/providers/pinnacle17/client", () => ({
  pinnacle17Configured: mocks.pinnacle17Configured,
}));
vi.mock("@/src/providers/coverage", () => ({
  identityProviders: mocks.identityProviders,
  marketHasNoSharpReference: () => false,
  bridgeOddsIsAuthoritative: mocks.bridgeOddsIsAuthoritative,
}));
vi.mock("@/src/services/sharp/segment-policy", () => ({
  isSegmentSharpOff: vi.fn(async () => false),
}));
vi.mock("@/src/services/sharp/judge", () => ({
  judgeMatchCandidates: vi.fn(),
}));
vi.mock("@/src/services/sharp/enrich/pinnacle17-identity", () => ({
  tryPinnacle17Identity: mocks.pinnacle17,
}));
vi.mock("@/src/services/sharp/enrich/identity-cache", () => ({
  applyTeamAliases: async (teams: { home: string; away: string }) => ({
    ...teams,
    homeResolution: { resolvedName: teams.home, alternativeNames: ["Alpha FC"] },
    awayResolution: { resolvedName: teams.away, alternativeNames: ["Bravo FC"] },
  }),
}));
vi.mock("@/src/services/sharp/enrich/training-cases", () => ({
  autoMatchAmbiguous: () => false,
  AUTO_MATCH_MIN_GAP: 0.1,
  closeOpenTrainingCase: vi.fn(),
  dedupeCandidates: (items: unknown[]) => items,
  recordTrainingCase: mocks.recordTrainingCase,
}));

const { BRIDGE_ENTRY_SEARCH_BUDGET_MS, resolveSharpIdentity } = await import(
  "@/src/services/sharp/enrich/sharp-identity"
);

describe("identidade Bridge separa frescor do preço", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pinnacle17Configured.mockReturnValue(false);
    mocks.identityProviders.mockReturnValue(["bridgeodds", "pinnacle17"]);
    mocks.bridgeOddsIsAuthoritative.mockReturnValue(true);
    mocks.pinnacle17.mockResolvedValue({ resolved: false });
  });

  it("devolve identidade sem esperar revalidação do catálogo stale", async () => {
    const best: BridgeMatchCandidate = {
      match: {
        match_id: 700,
        sport: "soccer",
        league: "Brasil - Série A",
        home: "Alpha",
        away: "Bravo",
        match_date: "2026-08-13T20:00:00Z",
        moneyline: { closing: { home: 1.8, draw: 3.4, away: 4.2 } },
      },
      score: 2,
      swapped: false,
    };
    mocks.find.mockResolvedValueOnce({
      ok: true,
      best,
      candidates: [best],
      stalePrices: true,
    });
    mocks.refresh.mockResolvedValueOnce(null);

    const outcome = await resolveSharpIdentity(
      {
        id: "bet-bridge-stale",
        evento: "Alpha vs Bravo",
        esporte: "Soccer",
        competicao: "Série A",
        pais: "Brasil",
        mercado: "Moneyline",
        selecao: "Alpha",
        odds: 2,
        data: new Date("2026-08-13T20:00:00Z"),
        registradoEm: new Date("2026-08-13T19:00:00Z"),
        bankroll: { sharpMode: "CLV_ONLY" },
      },
      { home: "Alpha", away: "Bravo" },
      {},
      vi.fn(async () => undefined),
    );

    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "bridge_resolved",
      result: { best: { match: { match_id: 700 } }, priceFresh: false },
    });
  });

  it("não mistura preço de refresh ainda não executado com identidade do cache", async () => {
    const best: BridgeMatchCandidate = {
      match: {
        match_id: 701,
        sport: "soccer",
        league: "Brasil - Série A",
        home: "Alpha",
        away: "Bravo",
        match_date: "2026-08-13T20:00:00Z",
      },
      score: 2,
      swapped: false,
    };
    mocks.find.mockResolvedValueOnce({
      ok: true,
      best,
      candidates: [best],
      stalePrices: true,
      priceObservedAt: new Date("2026-08-13T18:00:00Z"),
    });
    mocks.refresh.mockResolvedValueOnce({
      ...best.match,
      moneyline: { closing: { home: 1.9, draw: 3.2, away: 4.1 } },
    });

    const outcome = await resolveSharpIdentity(
      {
        id: "bet-bridge-refreshed",
        evento: "Alpha vs Bravo",
        esporte: "Soccer",
        competicao: "Série A",
        pais: "Brasil",
        mercado: "Moneyline",
        selecao: "Alpha",
        odds: 2,
        data: new Date("2026-08-13T20:00:00Z"),
        registradoEm: new Date("2026-08-13T19:00:00Z"),
        bankroll: { sharpMode: "CLV_ONLY" },
      },
      { home: "Alpha", away: "Bravo" },
      {},
      vi.fn(async () => undefined),
    );

    expect(outcome).toMatchObject({
      status: "bridge_resolved",
      result: {
        priceFresh: false,
        priceObservedAt: new Date("2026-08-13T18:00:00Z"),
        best: { match: { match_id: 701 } },
      },
    });
  });

  it("na janela de entrada preserva orçamento para a Pinnacle17 antes dos aliases", async () => {
    const now = new Date();
    mocks.pinnacle17Configured.mockReturnValue(true);
    mocks.find.mockResolvedValueOnce({
      ok: true,
      best: {
        match: {
          match_id: 702,
          sport: "soccer",
          league: "Brasil - Série A",
          home: "Alpha",
          away: "Bravo",
          match_date: now.toISOString(),
        },
        score: 2,
        swapped: false,
      },
      candidates: [],
      stalePrices: false,
      priceObservedAt: now,
    });

    await resolveSharpIdentity(
      {
        id: "bet-bridge-fallback-budget",
        evento: "Alpha vs Bravo",
        esporte: "Soccer",
        competicao: "Série A",
        pais: "Brasil",
        mercado: "Moneyline",
        selecao: "Alpha",
        odds: 2,
        data: new Date(now.getTime() + 60 * 60_000),
        registradoEm: now,
        bankroll: { sharpMode: "CLV_ONLY" },
      },
      { home: "Alpha", away: "Bravo" },
      {},
      vi.fn(async () => undefined),
    );

    const search = mocks.find.mock.calls[0]?.[0] as {
      alternativeNameMode?: string;
      maxSearchDurationMs?: number;
    };
    expect(search.alternativeNameMode).toBeUndefined();
    expect(BRIDGE_ENTRY_SEARCH_BUDGET_MS).toBe(5_000);
    expect(search.maxSearchDurationMs).toBeGreaterThan(0);
    expect(search.maxSearchDurationMs).toBeLessThanOrEqual(BRIDGE_ENTRY_SEARCH_BUDGET_MS);
  });

  it("Pinnacle17 entra na primeira espera e a continuação preserva o cursor", async () => {
    const now = new Date();
    const retryAt = new Date(now.getTime() + 40_000);
    const resume = { signature: "search", nextSearchAt: 2, candidates: [], sawResults: false, sawTruncated: false };
    mocks.pinnacle17Configured.mockReturnValue(true);
    mocks.find.mockResolvedValueOnce({ ok: false, reason: "search_budget", candidates: [], retryAt, resume });
    const bet = { id: "bet-resume", evento: "Alpha vs Bravo", esporte: "Soccer", competicao: "Série A", pais: "Brasil",
      mercado: "Moneyline", selecao: "Alpha", odds: 2, data: new Date(now.getTime() + 3_600_000), registradoEm: now,
      bankroll: { sharpMode: "CLV_ONLY" } };
    await expect(resolveSharpIdentity(bet, { home: "Alpha", away: "Bravo" }, {}, vi.fn()))
      .rejects.toMatchObject({ name: "SharpContinuationError", retryAt, continuation: { bridge: resume } });
    expect(mocks.pinnacle17).toHaveBeenCalledOnce();
    expect(mocks.find).toHaveBeenCalledOnce();
    expect(mocks.recordTrainingCase).not.toHaveBeenCalled();
  });

  it("Pinnacle17 resolve antes de qualquer busca na Bridge", async () => {
    const now = new Date();
    mocks.pinnacle17Configured.mockReturnValue(true);
    mocks.pinnacle17.mockResolvedValueOnce({ resolved: true });
    await expect(resolveSharpIdentity({ id: "bet-fast", evento: "Alpha vs Bravo", esporte: "Soccer", competicao: "", pais: "",
      mercado: "Moneyline", selecao: "Alpha", odds: 2, data: new Date(now.getTime() + 3_600_000), registradoEm: now,
      bankroll: { sharpMode: "CLV_ONLY" } }, { home: "Alpha", away: "Bravo" }, {}, vi.fn())).resolves.toEqual({ status: "pinnacle17_resolved" });
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.pinnacle17).toHaveBeenCalledOnce();
  });

  it.each(["CLV_ONLY", "IDENTITY_ONLY"] as const)(
    "%s preserva aliases imediatos porque não busca preço de entrada",
    async (sharpMode) => {
      const now = new Date();
      mocks.pinnacle17Configured.mockReturnValue(true);
      mocks.find.mockResolvedValueOnce({
        ok: true,
        best: {
          match: {
            match_id: 704,
            sport: "soccer",
            league: "Brasil - Série A",
            home: "Alpha",
            away: "Bravo",
            match_date: now.toISOString(),
          },
          score: 2,
          swapped: false,
        },
        candidates: [],
        stalePrices: false,
        priceObservedAt: now,
      });

      await resolveSharpIdentity(
        {
          id: `bet-bridge-${sharpMode.toLowerCase()}`,
          evento: "Alpha vs Bravo",
          esporte: "Soccer",
          competicao: "Série A",
          pais: "Brasil",
          mercado: "Moneyline",
          selecao: "Alpha",
          odds: 2,
          data: new Date(now.getTime() + 60 * 60_000),
          registradoEm: now,
          bankroll: { sharpMode },
        },
        { home: "Alpha", away: "Bravo" },
        {},
        vi.fn(async () => undefined),
      );

      expect(mocks.find).toHaveBeenCalledWith(expect.not.objectContaining({
        alternativeNameMode: "deferred",
      }));
    },
  );

  it("Bridge como última chance mantém aliases depois da cascata já tentada", async () => {
    const now = new Date();
    mocks.identityProviders.mockReturnValue(["pinnacle17", "bridgeodds"]);
    mocks.bridgeOddsIsAuthoritative.mockReturnValue(false);
    mocks.pinnacle17Configured.mockReturnValue(true);
    mocks.find.mockResolvedValueOnce({
      ok: true,
      best: {
        match: {
          match_id: 705,
          sport: "soccer",
          league: "Brasil - Série A",
          home: "Alpha",
          away: "Bravo",
          match_date: now.toISOString(),
        },
        score: 2,
        swapped: false,
      },
      candidates: [],
      stalePrices: false,
      priceObservedAt: now,
    });

    await resolveSharpIdentity(
      {
        id: "bet-bridge-last-chance",
        evento: "Alpha vs Bravo",
        esporte: "Soccer",
        competicao: "Série A",
        pais: "Brasil",
        mercado: "Moneyline",
        selecao: "Alpha",
        odds: 2,
        data: new Date(now.getTime() + 60 * 60_000),
        registradoEm: now,
        bankroll: { sharpMode: "CLV_ONLY" },
      },
      { home: "Alpha", away: "Bravo" },
      {},
      vi.fn(async () => undefined),
    );

    expect(mocks.pinnacle17).toHaveBeenCalledOnce();
    expect(mocks.find).toHaveBeenCalledWith(expect.not.objectContaining({
      alternativeNameMode: "deferred",
    }));
  });
});
