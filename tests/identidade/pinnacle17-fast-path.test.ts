import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tryPinnacle17Identity: vi.fn(),
  applyTeamAliases: vi.fn(),
  findBridgeMatch: vi.fn(),
  findBridgeMatchByIdWithEvidence: vi.fn(),
  recordOperationalMetric: vi.fn(),
  closeOpenTrainingCase: vi.fn(),
  upsertSharp: vi.fn(),
  applyBridgeOdds: vi.fn(),
}));

vi.mock("@/src/providers/bridgeodds/client", () => ({
  bridgeConfigured: () => true,
}));

vi.mock("@/src/providers/pinnacle17/client", () => ({
  pinnacle17Configured: () => true,
}));

vi.mock("@/src/services/sharp/enrich/pinnacle17-identity", () => ({
  tryPinnacle17Identity: mocks.tryPinnacle17Identity,
}));

vi.mock("@/src/services/sharp/enrich/identity-cache", () => ({
  applyTeamAliases: mocks.applyTeamAliases,
}));

vi.mock("@/src/providers/bridgeodds/match", () => ({
  findBridgeMatch: mocks.findBridgeMatch,
  findBridgeMatchByIdWithEvidence: mocks.findBridgeMatchByIdWithEvidence,
}));

vi.mock("@/src/infra/operational-metrics", () => ({
  recordOperationalMetric: mocks.recordOperationalMetric,
}));

vi.mock("@/src/services/sharp/enrich/training-cases", () => ({
  autoMatchAmbiguous: () => false,
  AUTO_MATCH_MIN_GAP: 0.1,
  closeOpenTrainingCase: mocks.closeOpenTrainingCase,
  dedupeCandidates: (c: unknown) => c,
  recordTrainingCase: vi.fn(),
}));

vi.mock("@/src/services/sharp/enrich/apply-odds", () => ({
  applyBridgeOdds: mocks.applyBridgeOdds,
}));

vi.mock("@/src/infra/prisma", () => ({
  prisma: {
    betSharp: {
      findUnique: vi.fn(async () => null),
    },
    marketSegmentPolicy: {
      findMany: vi.fn(async () => []),
    },
  },
}));

import { resolveSharpIdentity } from "@/src/services/sharp/enrich/sharp-identity";
import { findPinnacle17Event, rankPinnacle17Candidates } from "@/src/providers/pinnacle17/feed";
import type { Pinnacle17Event } from "@/src/providers/pinnacle17/types";
import type { EnrichDeps } from "@/src/services/sharp/enrich/continuation";

const KICKOFF = new Date("2026-09-15T18:00:00Z");

const sampleBet = {
  id: "bet-fast-path-1",
  evento: "Chelsea vs Arsenal",
  esporte: "Soccer",
  pais: "Inglaterra",
  competicao: "Premier League",
  mercado: "Money Line – Match",
  selecao: "Chelsea",
  odds: 2.1,
  data: KICKOFF,
  registradoEm: new Date(),
  bankroll: { sharpMode: "CLV_ONLY" },
};

const sampleTeams = { home: "Chelsea", away: "Arsenal" };

const dummyDeps = { query: undefined } as unknown as EnrichDeps;

describe("Fast-Path Híbrido com Pinnacle17", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyTeamAliases.mockResolvedValue({
      home: "Chelsea",
      away: "Arsenal",
      homeResolution: { alternativeNames: [] },
      awayResolution: { alternativeNames: [] },
    });
  });

  const bridgeMatch = (id: number) => ({
    ok: true,
    best: {
      match: { match_id: id, home: "Chelsea", away: "Arsenal", league: "Premier League", match_date: KICKOFF.toISOString() },
      score: 1.9,
      swapped: false,
    },
    candidates: [],
    stalePrices: false,
    priceObservedAt: new Date(),
  });

  // A Pinnacle17 é a identidade principal; a Bridge (100/h)
  // só entra quando a Pinnacle17 não acha o jogo.
  describe("resolveSharpIdentity: Pinnacle17 primeiro", () => {
    it("Pinnacle17 acha o jogo: não consulta a Bridge", async () => {
      mocks.tryPinnacle17Identity.mockResolvedValue({ resolved: true, provider: "pinnacle17" });

      const outcome = await resolveSharpIdentity(sampleBet, sampleTeams, dummyDeps, mocks.upsertSharp);

      expect(outcome).toEqual({ status: "pinnacle17_resolved" });
      expect(mocks.tryPinnacle17Identity).toHaveBeenCalledTimes(1);
      expect(mocks.closeOpenTrainingCase).toHaveBeenCalledWith("bet-fast-path-1", "AUTO_APPLIED");
      expect(mocks.findBridgeMatch).not.toHaveBeenCalled();
      expect(mocks.recordOperationalMetric).toHaveBeenCalledWith(expect.objectContaining({
        name: "sharp.pinnacle17_first", outcome: "success",
      }));
    });

    it("Pinnacle17 não acha: cai para a Bridge sem repetir a Pinnacle17", async () => {
      mocks.tryPinnacle17Identity.mockResolvedValue({ resolved: false });
      mocks.findBridgeMatch.mockResolvedValue(bridgeMatch(554433));

      const outcome = await resolveSharpIdentity(sampleBet, sampleTeams, dummyDeps, mocks.upsertSharp);

      expect(outcome.status).toBe("bridge_resolved");
      expect(mocks.tryPinnacle17Identity).toHaveBeenCalledTimes(1);
      expect(mocks.findBridgeMatch).toHaveBeenCalledTimes(1);
      expect(mocks.recordOperationalMetric).toHaveBeenCalledWith(expect.objectContaining({
        name: "sharp.pinnacle17_first", outcome: "expected_retry",
      }));
    });
  });

  describe("Zona Cinzenta e Suporte ao IA-Judge na Pinnacle17", () => {
    const mockEvent: Pinnacle17Event = {
      id: 17891234,
      name: "CR Belouizdad vs USM Alger",
      startTime: KICKOFF.toISOString(),
      status: { isStarted: false, isInProgress: false, isInterrupted: false },
      sport: { id: 29, name: "Soccer" },
      league: { id: 1001, name: "Ligue 1", country: "Algeria" },
      homeTeam: { name: "CR Belouizdad" },
      awayTeam: { name: "USM Alger" },
      units: "regular",
    };

    it("rankPinnacle17Candidates retorna candidatos da zona cinzenta com minScore customizado", () => {
      // Nomes com pequenas diferenças (sem prefixo CR e grafia abreviada)
      const rankedDefault = rankPinnacle17Candidates({
        events: [mockEvent],
        home: "Belouizdad",
        away: "Alger",
        kickoffUtc: KICKOFF,
      });
      const rankedGray = rankPinnacle17Candidates({
        events: [mockEvent],
        home: "Belouizdad",
        away: "Alger",
        kickoffUtc: KICKOFF,
        minScore: 0.8,
      });

      expect(rankedDefault.length).toBeLessThanOrEqual(rankedGray.length);
      expect(rankedGray.length).toBeGreaterThanOrEqual(1);
      expect(rankedGray[0]!.event.id).toBe(17891234);
    });

    it("findPinnacle17Event casa perfeitamente quando os nomes batem acima do piso padrão", () => {
      const match = findPinnacle17Event({
        events: [mockEvent],
        home: "CR Belouizdad",
        away: "USM Alger",
        kickoffUtc: KICKOFF,
        competition: "Ligue 1",
        country: "Algeria",
      });

      expect(match).not.toBeNull();
      expect(match!.event.id).toBe(17891234);
      expect(match!.score).toBeGreaterThanOrEqual(1.5);
    });
  });
});
