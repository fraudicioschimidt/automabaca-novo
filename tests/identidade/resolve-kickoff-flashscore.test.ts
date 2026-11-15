import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlashscoreMatch } from "@/src/providers/flashscore/types";

const mocks = vi.hoisted(() => ({
  env: {
    SHARP_AUTO_MATCH_MIN_SCORE: 1.5,
  },
  flashscoreConfigured: vi.fn(() => true),
  getFlashscoreCatalog: vi.fn(),
  listFlashscoreMatchesByDate: vi.fn(),
  getFlashscoreMatchStats: vi.fn(),
  getFlashscoreMatchPlayerStats: vi.fn(),
  getFlashscoreMatchSummary: vi.fn(),
  prisma: {
    bet: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    betResult: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    betSharp: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    iaJudgeCooldown: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  recordOperationalMetric: vi.fn(),
  reopenSharpIdentityAfterKickoffChange: vi.fn(),
  recordKickoffResolveAttempt: vi.fn(),
  resolveSharpIdentity: vi.fn(),
  applyBridgeIdentity: vi.fn(),
  applyBridgeOdds: vi.fn(),
  resolveTeamsForProvider: vi.fn(),
  settleScore: vi.fn().mockResolvedValue(true),
  settleStatus: vi.fn(),
  notify: vi.fn(),
  operationalAlert: vi.fn(),
}));

vi.mock("@/src/infra/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/src/infra/circuit-breaker", () => ({
  CircuitOpenError: class CircuitOpenError extends Error {
    readonly provider: string;
    constructor(name: string) {
      super(`Circuit breaker aberto para "${name}"`);
      this.name = "CircuitOpenError";
      this.provider = name;
    }
  },
  isBreakerOpen: vi.fn().mockResolvedValue(false),
  withBreaker: async (_name: string, fn: () => Promise<unknown>) => fn(),
  closeExpiredBreaker: vi.fn(),
  tripBreaker: vi.fn(),
}));
vi.mock("@/src/infra/prisma", () => {
  let rows: Array<{ id: string }> = [];
  const prisma = {
    ...mocks.prisma,
    // A primeira olhada gravada na aposta (`recordFlashscoreFirstCheckTx`).
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
    bet: {
      ...mocks.prisma.bet,
      findMany: async (...args: unknown[]) => {
        rows = await mocks.prisma.bet.findMany(...args);
        return rows;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = rows.find((bet) => bet.id === where.id) ?? await mocks.prisma.bet.findUnique({ where });
        if (!row) throw new Error("Aposta não encontrada na fixture.");
        return row;
      },
    },
  };
  return { prisma: {
    ...prisma,
    // Nenhuma liquidação do IA-Judge para conferir.
    $queryRaw: async () => [],
    $transaction: async (operation: (tx: typeof prisma) => Promise<unknown>) => operation(prisma),
  } };
});
vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/src/infra/operational-metrics", () => ({
  recordOperationalMetric: mocks.recordOperationalMetric,
}));
vi.mock("@/src/services/sharp/kickoff-revive", () => ({
  reopenSharpIdentityAfterKickoffChange: mocks.reopenSharpIdentityAfterKickoffChange,
}));
vi.mock("@/src/services/sharp/enrich/kickoff-attempts", async (original) => ({
  ...await original<typeof import("@/src/services/sharp/enrich/kickoff-attempts")>(),
  recordKickoffResolveAttempt: mocks.recordKickoffResolveAttempt,
}));
vi.mock("@/src/services/settlement/flashscore/score-settle", () => ({
  settleFromFlashscoreScore: mocks.settleScore,
}));
vi.mock("@/src/providers/flashscore/client", () => ({
  flashscoreConfigured: mocks.flashscoreConfigured,
  listFlashscoreMatchesByDate: mocks.listFlashscoreMatchesByDate,
  getFlashscoreMatchStats: mocks.getFlashscoreMatchStats,
  getFlashscoreMatchPlayerStats: mocks.getFlashscoreMatchPlayerStats,
  getFlashscoreMatchSummary: mocks.getFlashscoreMatchSummary,
}));
vi.mock("@/src/providers/flashscore/client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    flashscoreConfigured: mocks.flashscoreConfigured,
    listFlashscoreMatchesByDate: mocks.listFlashscoreMatchesByDate,
    getFlashscoreMatchStats: mocks.getFlashscoreMatchStats,
    getFlashscoreMatchPlayerStats: mocks.getFlashscoreMatchPlayerStats,
    getFlashscoreMatchSummary: mocks.getFlashscoreMatchSummary,
  };
});
vi.mock("@/src/services/sharp/enrich/identity-cache", () => ({
  applyTeamAliases: async (teams: unknown) => teams,
  pinnacleTeamsFrom: async (teams: unknown) => teams,
}));
vi.mock("@/src/services/teams/resolve", () => ({
  resolveTeamsForProvider: mocks.resolveTeamsForProvider,
  resolveTeamsForProviders: (teams: unknown, providers: readonly string[], context: unknown) =>
    Promise.all(providers.map((provider) => mocks.resolveTeamsForProvider(teams, provider, context))),
}));
vi.mock("@/src/services/sharp/enrich/sharp-identity", () => ({
  resolveSharpIdentity: mocks.resolveSharpIdentity,
}));
vi.mock("@/src/services/sharp/enrich/apply-identity", () => ({
  applyBridgeIdentity: mocks.applyBridgeIdentity,
}));
vi.mock("@/src/services/sharp/enrich/apply-odds", () => ({
  applyBridgeOdds: mocks.applyBridgeOdds,
}));
vi.mock("@/src/services/bets/settle", () => ({
  applyAutomaticBetStatusChange: mocks.settleStatus,
  BetNotPendingError: class BetNotPendingError extends Error {},
}));
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperatorNotification: mocks.notify,
  sendOperationalAlert: mocks.operationalAlert,
}));
vi.mock("@/src/providers/provider-cache", () => ({
  readProviderCache: async () => null,
  writeProviderCache: async () => {},
  deleteProviderCache: async () => {},
}));

import {
  findFlashscoreMatchIdForBet,
  resolveKickoffViaFlashscoreSchedule,
} from "@/src/services/sharp/enrich/resolve-kickoff-flashscore";
import { enrichBetSharp } from "@/src/services/sharp/enrich/enrich-bet";
import { resolveProvisionalKickoff } from "@/src/services/sharp/enrich/kickoff-provisional";
import { runFlashscoreObservationOnce } from "@/src/services/settlement/flashscore/observation";
import { clearFlashscoreCatalogCache } from "@/src/providers/flashscore/catalog";

function makeMatch(
  id: string,
  home: string,
  away: string,
  at: Date,
  stage = "Finished",
): FlashscoreMatch {
  return {
    match_id: id,
    timestamp: Math.floor(at.getTime() / 1_000),
    home_team: { team_id: `${id}-h`, name: home },
    away_team: { team_id: `${id}-a`, name: away },
    scores: { home: 2, away: 1 },
    match_status: {
      stage,
      is_cancelled: false,
      is_postponed: false,
      is_started: true,
      is_in_progress: stage === "Live",
      is_finished: stage === "Finished",
    },
  };
}

describe("vinculação precoce do match id do FlashScore", () => {
  const matchDate = new Date("2026-07-25T16:00:00Z");

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearFlashscoreCatalogCache();
    mocks.flashscoreConfigured.mockReturnValue(true);
    mocks.prisma.iaJudgeCooldown.findUnique.mockResolvedValue(null);
    mocks.prisma.iaJudgeCooldown.upsert.mockResolvedValue({});
    mocks.prisma.iaJudgeCooldown.deleteMany.mockResolvedValue({ count: 0 });
    mocks.prisma.betResult.findUnique.mockResolvedValue(null);
    mocks.prisma.betResult.upsert.mockResolvedValue({});
    mocks.prisma.betSharp.findUnique.mockResolvedValue(null);
    mocks.prisma.betSharp.upsert.mockResolvedValue({});
    mocks.prisma.bet.update.mockResolvedValue({});
    mocks.prisma.bet.updateMany.mockResolvedValue({ count: 1 });
    mocks.resolveTeamsForProvider.mockImplementation(async (teams: { home: string; away: string }) => ({
      home: teams.home,
      away: teams.away,
      homeResolution: {
        inputName: teams.home,
        resolvedName: teams.home,
        cardId: null,
        providerTeamId: null,
        strategy: "original",
        alternativeNames: [],
      },
      awayResolution: {
        inputName: teams.away,
        resolvedName: teams.away,
        cardId: null,
        providerTeamId: null,
        strategy: "original",
        alternativeNames: [],
      },
    }));
  });

  describe("resolveKickoffViaFlashscoreSchedule & findFlashscoreMatchIdForBet", () => {
    it("resolveKickoffViaFlashscoreSchedule inclui matchId unívoco no resultado", async () => {
      const match = makeMatch("fs-match-101", "Arsenal", "Chelsea", matchDate);
      mocks.listFlashscoreMatchesByDate.mockResolvedValue([
        {
          tournament_id: "t1",
          name: "Premier League",
          country_name: "England",
          matches: [match],
        },
      ]);

      const res = await resolveKickoffViaFlashscoreSchedule({
        evento: "Arsenal vs Chelsea",
        esporte: "Futebol",
        pais: "England",
        competicao: "Premier League",
        data: new Date("2026-07-25T03:00:00Z"), // Horário provisório (00:00 SP)
      });

      expect(res).not.toBeNull();
      expect(res?.matchId).toBe("fs-match-101");
      expect(res?.kickoff.toISOString()).toBe(matchDate.toISOString());
      expect(res?.competition).toBe("Premier League");
      expect(res?.country).toBe("England");
    });

    it("findFlashscoreMatchIdForBet retorna matchId diretamente a partir do catálogo", async () => {
      const match = makeMatch("fs-match-202", "Real Madrid", "Barcelona", matchDate);
      mocks.listFlashscoreMatchesByDate.mockResolvedValue([
        {
          tournament_id: "t2",
          name: "La Liga",
          country_name: "Spain",
          matches: [match],
        },
      ]);

      const matchId = await findFlashscoreMatchIdForBet({
        evento: "Real Madrid vs Barcelona",
        esporte: "Futebol",
        pais: "Spain",
        competicao: "La Liga",
        data: matchDate,
      });

      expect(matchId).toBe("fs-match-202");
    });

    it("findFlashscoreMatchIdForBet identifica times com lados invertidos", async () => {
      const match = makeMatch("fs-match-303", "Liverpool", "Everton", matchDate);
      mocks.listFlashscoreMatchesByDate.mockResolvedValue([
        {
          tournament_id: "t3",
          name: "Premier League",
          country_name: "England",
          matches: [match],
        },
      ]);

      const matchId = await findFlashscoreMatchIdForBet({
        evento: "Everton vs Liverpool",
        esporte: "Futebol",
        data: matchDate,
      });

      expect(matchId).toBe("fs-match-303");
    });

    it("retorna null quando Flashscore não está configurado", async () => {
      mocks.flashscoreConfigured.mockReturnValue(false);

      const matchId = await findFlashscoreMatchIdForBet({
        evento: "Arsenal vs Chelsea",
        esporte: "Futebol",
        data: matchDate,
      });

      expect(matchId).toBeNull();
    });

    it("retorna null quando evento não possui formato A vs B", async () => {
      const matchId = await findFlashscoreMatchIdForBet({
        evento: "QualquerTextoSemVersus",
        esporte: "Futebol",
        data: matchDate,
      });

      expect(matchId).toBeNull();
    });
  });

  /**
   * A BridgeOdds guarda o horário com que listou o jogo e não acompanha a
   * remarcação; o FlashScore e a Pinnacle17 acompanham. Com horário real, o
   * vínculo antecipado segue a trava da liquidação: a partida a até 3 h dele.
   */
  describe("vínculo antecipado com o horário real da aposta", () => {
    const serieA = (...matches: FlashscoreMatch[]) => [
      { tournament_id: "serie-a", name: "BRAZIL: Serie A Betano", country_name: "Brazil", matches },
    ];

    it("jogo antecipado em 3 h depois do casamento (Palmeiras × São Paulo): mesmo jogo, vincula", async () => {
      // A Bridge listou 21:30 de SP; o jogo passou para 18:30.
      mocks.listFlashscoreMatchesByDate.mockResolvedValue(serieA(
        makeMatch("pal-sao", "Palmeiras", "Sao Paulo", new Date("2026-09-12T21:30:00Z")),
      ));

      await expect(findFlashscoreMatchIdForBet({
        evento: "Palmeiras vs Sao Paulo",
        esporte: "Soccer",
        pais: "Brazil",
        competicao: "Serie A",
        data: new Date("2026-09-13T00:30:00Z"),
      })).resolves.toBe("pal-sao");
    });

    it("partida a 8 h do horário da aposta: sem vínculo, como a liquidação recusaria", async () => {
      mocks.listFlashscoreMatchesByDate.mockResolvedValue(serieA(
        makeMatch("cam-flu", "Atletico-MG", "Fluminense", new Date("2026-09-13T03:00:00Z")),
      ));

      await expect(findFlashscoreMatchIdForBet({
        evento: "Atletico-MG vs Fluminense",
        esporte: "Soccer",
        pais: "Brazil",
        competicao: "Serie A",
        data: new Date("2026-09-12T19:00:00Z"),
      })).resolves.toBeNull();
    });

    it("sem horário no post, o calendário acha o jogo remarcado (Bahia × Remo) e dá o horário à aposta", async () => {
      // Listado para domingo, 17h de SP; jogado na segunda, às 20h.
      mocks.listFlashscoreMatchesByDate.mockResolvedValue(serieA(
        makeMatch("bah-rem", "Bahia", "Remo", new Date("2026-09-14T23:00:00Z")),
      ));

      const res = await resolveKickoffViaFlashscoreSchedule({
        evento: "Bahia vs Remo",
        esporte: "Soccer",
        pais: "Brazil",
        competicao: "Serie A",
        data: new Date("2026-09-14T03:00:00Z"),
      });

      expect(res).toMatchObject({ matchId: "bah-rem", kickoff: new Date("2026-09-14T23:00:00Z") });
    });
  });

  describe("Enrichment: vinculação e persistência em bet_result", () => {
    it("resolveProvisionalKickoff persiste resultMatchId e resultProvider em bet_result ao resolver via FlashScore", async () => {
      const match = makeMatch("fs-match-provisional", "Palmeiras", "Corinthians", matchDate);
      mocks.listFlashscoreMatchesByDate.mockResolvedValue([
        {
          tournament_id: "t4",
          name: "Paulista",
          country_name: "Brazil",
          matches: [match],
        },
      ]);

      const bet = {
        id: "bet-prov-1",
        evento: "Palmeiras vs Corinthians",
        esporte: "Futebol",
        pais: "Brazil",
        competicao: "Paulista",
        data: new Date("2026-07-25T03:00:00Z"),
        kickoffInferido: true,
      };

      await resolveProvisionalKickoff(bet, { now: new Date("2026-07-25T10:00:00Z") });

      expect(mocks.prisma.bet.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "bet-prov-1", deletedAt: null, data: new Date("2026-07-25T03:00:00Z"),
          evento: "Palmeiras vs Corinthians", esporte: "Futebol" },
        data: expect.objectContaining({ data: matchDate, kickoffInferido: false }),
      }));
      expect(mocks.prisma.betResult.upsert).toHaveBeenCalledWith({
        where: { betId: "bet-prov-1" },
        create: {
          betId: "bet-prov-1",
          resultProvider: "flashscore",
          resultMatchId: "fs-match-provisional",
        },
        update: {
          resultProvider: "flashscore",
          resultMatchId: "fs-match-provisional",
        },
      });
      expect(bet.kickoffInferido).toBe(false);
      expect(bet.data.toISOString()).toBe(matchDate.toISOString());
    });

    it("enrichBetSharp vincula precocemente resultMatchId quando bet_result ainda não tem", async () => {
      mocks.prisma.bet.findUnique.mockResolvedValue({
        id: "bet-enrich-1",
        deletedAt: null,
        status: "PENDING",
        evento: "Flamengo vs Fluminense",
        esporte: "Futebol",
        sportResolutionStatus: "CONFIRMED",
        competicao: "Carioca",
        pais: "Brazil",
        mercado: "Moneyline",
        selecao: "Flamengo",
        legsJson: null,
        odds: 1.95,
        data: matchDate,
        kickoffInferido: false,
        registradoEm: new Date("2026-07-25T12:00:00Z"),
        sharp: null,
        bankroll: { sharpMode: "CLV_ONLY" },
      });
      mocks.prisma.betResult.findUnique.mockResolvedValue(null);
      mocks.resolveSharpIdentity.mockResolvedValue({ status: "unsupported" });

      const findFlashscoreMatchId = vi.fn().mockResolvedValue("fs-match-enrich-404");

      await enrichBetSharp(
        { betId: "bet-enrich-1" },
        {
          findFlashscoreMatchId,
          now: new Date("2026-07-25T12:00:00Z"),
        },
      );

      expect(findFlashscoreMatchId).toHaveBeenCalledWith({
        evento: "Flamengo vs Fluminense",
        esporte: "Futebol",
        pais: "Brazil",
        competicao: "Carioca",
        data: matchDate,
      });

      expect(mocks.prisma.betResult.upsert).toHaveBeenCalledWith({
        where: { betId: "bet-enrich-1" },
        create: {
          betId: "bet-enrich-1",
          resultProvider: "flashscore",
          resultMatchId: "fs-match-enrich-404",
        },
        update: {
          resultProvider: "flashscore",
          resultMatchId: "fs-match-enrich-404",
        },
      });
    });

    it("enrichBetSharp não refaz busca quando resultMatchId já está preenchido", async () => {
      mocks.prisma.bet.findUnique.mockResolvedValue({
        id: "bet-enrich-2",
        deletedAt: null,
        status: "PENDING",
        evento: "Flamengo vs Fluminense",
        esporte: "Futebol",
        sportResolutionStatus: "CONFIRMED",
        competicao: "Carioca",
        pais: "Brazil",
        mercado: "Moneyline",
        selecao: "Flamengo",
        legsJson: null,
        odds: 1.95,
        data: matchDate,
        kickoffInferido: false,
        registradoEm: new Date("2026-07-25T12:00:00Z"),
        sharp: null,
        bankroll: { sharpMode: "CLV_ONLY" },
      });
      mocks.prisma.betResult.findUnique.mockResolvedValue({
        resultMatchId: "already-bound-id",
      });
      mocks.resolveSharpIdentity.mockResolvedValue({ status: "unsupported" });

      const findFlashscoreMatchId = vi.fn();

      await enrichBetSharp(
        { betId: "bet-enrich-2" },
        {
          findFlashscoreMatchId,
          now: new Date("2026-07-25T12:00:00Z"),
        },
      );

      expect(findFlashscoreMatchId).not.toHaveBeenCalled();
    });
  });

  describe("Settlement: rota direta por resultMatchId", () => {
    it("runFlashscoreObservationOnce usa match direto por resultMatchId sem busca fuzzy", async () => {
      const match = makeMatch("fs-direct-999", "Cruzeiro", "Atletico-MG", matchDate);
      mocks.listFlashscoreMatchesByDate.mockResolvedValue([
        {
          tournament_id: "tour-mineiro",
          name: "Campeonato Mineiro",
          country_name: "Brazil",
          matches: [match],
        },
      ]);

      mocks.prisma.bet.findMany.mockResolvedValue([
        {
          id: "bet-settle-1",
          evento: "Cruzeiro vs Atletico-MG",
          esporte: "Futebol",
          competicao: "Campeonato Mineiro",
          pais: "Brazil",
          mercado: "Moneyline",
          selecao: "Cruzeiro",
          legsJson: null,
          liveScoreHome: null,
          liveScoreAway: null,
          odds: 2.1,
          stake: 1,
          status: "PENDING",
          data: matchDate,
          registradoEm: new Date("2026-07-25T12:00:00Z"),
          kickoffInferido: false,
          captureEvidence: null,
          sharp: null,
          closing: { fetchedAt: null, clv: null, closingOdd: null, lateRefreshedAt: null },
          result: {
            scoreHome: null,
            resultSnapshot: null,
            resultCheckedAt: null,
            resultProvider: "flashscore",
            resultMatchId: "fs-direct-999", // Já vinculado precocemente!
            resultFinal: false,
          },
        },
      ]);

      const run = await runFlashscoreObservationOnce(new Date("2026-07-25T20:00:00Z"));

      expect(run.processed).toBe(1);
      expect(run.matched).toBe(1);
      expect(mocks.prisma.betResult.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { betId: "bet-settle-1" },
          update: expect.objectContaining({
            resultProvider: "flashscore",
            resultMatchId: "fs-direct-999",
          }),
        }),
      );
    });

    it("localiza o match por ID em dia adjacente quando não estiver no dia exato", async () => {
      const matchAdjacent = makeMatch("fs-adjacent-777", "Gremio", "Internacional", matchDate);
      mocks.listFlashscoreMatchesByDate.mockImplementation(async (dayKey: string) => {
        if (dayKey === "2026-07-26") {
          return [
            {
              tournament_id: "tour-gaucho",
              name: "Gaucho",
              country_name: "Brazil",
              matches: [matchAdjacent],
            },
          ];
        }
        return [];
      });

      mocks.prisma.bet.findMany.mockResolvedValue([
        {
          id: "bet-settle-adj",
          evento: "Gremio vs Internacional",
          esporte: "Futebol",
          competicao: "Gaucho",
          pais: "Brazil",
          mercado: "Moneyline",
          selecao: "Gremio",
          legsJson: null,
          liveScoreHome: null,
          liveScoreAway: null,
          odds: 2.0,
          stake: 1,
          status: "PENDING",
          data: matchDate,
          registradoEm: new Date("2026-07-25T12:00:00Z"),
          kickoffInferido: false,
          captureEvidence: null,
          sharp: null,
          closing: { fetchedAt: null, clv: null, closingOdd: null, lateRefreshedAt: null },
          result: {
            scoreHome: null,
            resultSnapshot: null,
            resultCheckedAt: null,
            resultProvider: "flashscore",
            resultMatchId: "fs-adjacent-777",
            resultFinal: false,
          },
        },
      ]);

      const run = await runFlashscoreObservationOnce(new Date("2026-07-25T20:00:00Z"));

      expect(run.processed).toBe(1);
      expect(run.matched).toBe(1);
      expect(mocks.prisma.betResult.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { betId: "bet-settle-adj" },
          update: expect.objectContaining({
            resultMatchId: "fs-adjacent-777",
          }),
        }),
      );
    });
  });
});
