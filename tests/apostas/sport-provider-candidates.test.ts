import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFlashscoreCatalog: vi.fn(),
  findFlashscoreCandidate: vi.fn(),
  findBridgeMatch: vi.fn(),
  fetchPinnacle17Events: vi.fn(),
  findPinnacle17Event: vi.fn(),
  resolveKickoffViaWebSearch: vi.fn(),
  geminiSearch: vi.fn(),
  warn: vi.fn(),
  ambiguous: false,
}));

vi.mock("@/src/infra/env", () => ({
  getEnv: () => ({ SHARP_AUTO_MATCH_MIN_SCORE: 0.8 }),
}));
vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ warn: mocks.warn }),
}));
vi.mock("@/src/providers/flashscore/sports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/providers/flashscore/sports")>()),
  // Só os canônicos participam da resolução de esporte: o FlashScore publica 34
  // modalidades e o AutomaBACA modela 19. A lista aqui é grande de propósito —
  // é ela que deixa o teto de sondagem ser testável.
  FLASHSCORE_CANONICAL_SPORTS: [
    { sport: "Soccer", sportId: 1, modo: "flag" },
    { sport: "Tennis", sportId: 2, modo: "flag" },
    { sport: "Basketball", sportId: 3, modo: "flag" },
    { sport: "Hockey", sportId: 4, modo: "flag" },
    { sport: "Baseball", sportId: 6, modo: "inferido" },
    { sport: "Handball", sportId: 7, modo: "inferido" },
    { sport: "Volleyball", sportId: 12, modo: "inferido" },
    { sport: "Darts", sportId: 14, modo: "inferido" },
    { sport: "Snooker", sportId: 15, modo: "inferido" },
    { sport: "eSports", sportId: 36, modo: "inferido" },
  ],
}));
vi.mock("@/src/providers/flashscore/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/providers/flashscore/client")>()),
  flashscoreConfigured: () => true,
}));
vi.mock("@/src/providers/flashscore/catalog", () => ({ getFlashscoreCatalog: mocks.getFlashscoreCatalog }));
vi.mock("@/src/providers/bridgeodds/client", () => ({
  bridgeConfigured: () => true,
}));
vi.mock("@/src/providers/bridgeodds/match", () => ({
  findBridgeMatch: mocks.findBridgeMatch,
}));
vi.mock("@/src/providers/bridgeodds/coverage-contract", async (original) => ({
  ...await original<object>(),
  bridgeSportFromEsporte: (sport: string) =>
    sport === "Soccer" ? "Futebol" : sport === "Basketball" ? "Basquete" : null,
}));
vi.mock("@/src/providers/bridgeodds/types", () => ({
  parseBridgeLeague: (league: string) => {
    const [pais = "", competicao = ""] = league.split(" - ");
    return { pais, competicao };
  },
}));
vi.mock("@/src/services/settlement/flashscore/match-identity", () => ({
  findFlashscoreCandidateWithAdjacentDays: mocks.findFlashscoreCandidate,
  expectedFlashscoreTeamIds: () => ({ home: null, away: null }),
  flashscoreSearchAlternatives: () => ({ home: [], away: [] }),
}));
vi.mock("@/src/providers/pinnacle17/client", () => ({
  fetchPinnacle17Events: mocks.fetchPinnacle17Events,
  pinnacle17Configured: () => true,
}));
vi.mock("@/src/providers/pinnacle17/feed", () => ({
  findPinnacle17Event: mocks.findPinnacle17Event,
}));
vi.mock("@/src/services/teams/resolve", () => ({
  resolveTeamsForProvider: async (teams: { home: string; away: string }) => ({
    home: teams.home,
    away: teams.away,
    homeResolution: { providerTeamId: null, alternativeNames: [], strategy: mocks.ambiguous ? "ambiguous" : "original" },
    awayResolution: { providerTeamId: null, alternativeNames: [] },
  }),
}));
vi.mock("@/src/services/sharp/enrich/resolve-kickoff-web", () => ({
  resolveKickoffViaWebSearch: mocks.resolveKickoffViaWebSearch,
}));
vi.mock("@/src/infra/llm/gemini-search", async (original) => ({
  ...await original<typeof import("@/src/infra/llm/gemini-search")>(),
  geminiGenerateJsonWithSearch: mocks.geminiSearch,
}));

import { findBridgeSportCandidates } from "@/src/services/bets/sport-resolution/bridge-candidate";
import { findFlashscoreSportCandidates } from "@/src/services/bets/sport-resolution/flashscore-candidates";
import {
  findPinnacle17SportCandidates,
  searchWebSportCandidate,
} from "@/src/services/bets/sport-resolution/provider-candidates";

const bet = {
  evento: "Time A vs Time B",
  data: new Date("2026-07-29T15:00:00.000Z"),
  kickoffInferido: true,
  pais: "",
  competicao: "",
};

describe("fontes do resolvedor de esporte", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ambiguous = false;
  });

  it("continua sem candidato quando o FlashScore falha", async () => {
    mocks.getFlashscoreCatalog.mockRejectedValue(
      new Error("Circuit breaker aberto para flashscore"),
    );

    await expect(findFlashscoreSportCandidates(bet)).resolves.toEqual([]);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "flashscore",
        sports: expect.arrayContaining(["Soccer"]),
      }),
      expect.stringContaining("fonte indisponível"),
    );
  });

  it("sem pistas, inclui futebol e basquete dentro do teto do Pinnacle17", async () => {
    mocks.fetchPinnacle17Events.mockResolvedValue({ data: [] });
    await findPinnacle17SportCandidates({ bet, hints: [], flashCandidates: [] });
    const ids = mocks.fetchPinnacle17Events.mock.calls.map(([params]) => params.sportId);
    expect(ids).toContain(29);
    expect(ids).toContain(4);
    expect(ids.length).toBeLessThanOrEqual(6);
  });

  it("modalidade distante pula FlashScore sem abrir o breaker", async () => {
    await expect(findFlashscoreSportCandidates({ ...bet, data: new Date("2026-09-19T03:00:00Z") }, [], new Date("2026-09-08T15:00:00Z"))).resolves.toEqual([]);
    expect(mocks.getFlashscoreCatalog).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  /**
   * Uma chamada de catálogo por esporte sondado. Sem teto, cada modalidade com
   * id do FlashScore no registro vira um catálogo por aposta não resolvida, ×3
   * dias adjacentes, e isso esgota a cota diária do provider.
   */
  describe("teto de sondagem por aposta", () => {
    beforeEach(() => {
      mocks.getFlashscoreCatalog.mockResolvedValue([]);
    });

    it("sem pista, sonda só as modalidades com volume real", async () => {
      await findFlashscoreSportCandidates(bet);
      const sondados = mocks.getFlashscoreCatalog.mock.calls.map(([, sportId]) => sportId);
      // Soccer, Tennis, Basketball, Hockey, Baseball, Volleyball.
      expect(sondados.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 12]);
    });

    it("hint leva a modalidade improvável para dentro da sondagem", async () => {
      // É isto que mantém handebol/dardos encontráveis sem abrir tudo: a pista
      // que o resolvedor já juntou entra na frente.
      await findFlashscoreSportCandidates(bet, ["Handball", "Darts"]);
      const sondados = mocks.getFlashscoreCatalog.mock.calls.map(([, sportId]) => sportId);
      expect(sondados.slice(0, 2)).toEqual([7, 14]);
      expect(sondados).toHaveLength(8);
    });

    it("nunca passa do teto, por mais pistas que cheguem", async () => {
      await findFlashscoreSportCandidates(bet, [
        "Handball", "Darts", "Snooker", "eSports", "Tennis", "Hockey",
        "Baseball", "Volleyball", "Soccer", "Basketball",
      ]);
      expect(mocks.getFlashscoreCatalog).toHaveBeenCalledTimes(8);
    });

    /**
     * O teto limita QUANTOS esportes, não quantos ao mesmo tempo, e o limite
     * que dói no FlashScore é por MINUTO. Disparar os 8 juntos é o formato
     * exato que o estoura, e quando estoura o breaker fecha o provider por 15min
     * para todo o sistema, settlement incluído.
     */
    it("sonda em lotes, não em rajada — o limite do provider é por minuto", async () => {
      let simultaneas = 0;
      let pico = 0;
      mocks.getFlashscoreCatalog.mockImplementation(async () => {
        simultaneas += 1;
        pico = Math.max(pico, simultaneas);
        await new Promise((resolve) => setTimeout(resolve, 5));
        simultaneas -= 1;
        return [];
      });

      await findFlashscoreSportCandidates(bet, [
        "Handball", "Darts", "Snooker", "eSports", "Tennis", "Hockey",
        "Baseball", "Volleyball",
      ]);

      expect(mocks.getFlashscoreCatalog).toHaveBeenCalledTimes(8);
      expect(pico).toBeLessThanOrEqual(3);
    });

    it("interrompe lotes seguintes (early-exit) ao encontrar candidato inequívoco com alta confiança", async () => {
      mocks.getFlashscoreCatalog.mockResolvedValue([
        { match_id: "fs-1", home_team: { name: "Time A", team_id: "t1" }, away_team: { name: "Time B", team_id: "t2" } },
      ]);
      mocks.findFlashscoreCandidate.mockImplementation(async ({ sportId }) => {
        if (sportId === 7) {
          return {
            ok: true,
            best: {
              strategy: "provider_id",
              swapped: false,
              match: {
                match_id: "fs-123",
                timestamp: 1785340800,
                home_team: { name: "Time A", team_id: "t1" },
                away_team: { name: "Time B", team_id: "t2" },
                tournament: { name: "Handball Champions", countryName: "Europe" },
              },
            },
          };
        }
        return { ok: false, reason: "not_found" };
      });

      const candidates = await findFlashscoreSportCandidates(bet, ["Handball"]);
      // Handball estava no 1º lote de 3 (Handball, Soccer, Tennis/Basketball)
      // Encontrando candidato inequívoco de provider_id, não deve consultar os outros 5 esportes
      expect(mocks.getFlashscoreCatalog).toHaveBeenCalledTimes(3);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.sport).toBe("Handball");
      expect(candidates[0]?.confidence).toBe(100);
    });
  });

  it("confirma basquete encontrado no catálogo BridgeOdds", async () => {
    mocks.findBridgeMatch.mockImplementation(async ({ bridgeSport }: { bridgeSport: string }) =>
      bridgeSport === "Basquete"
        ? {
            ok: true,
            best: {
              score: 1.9,
              swapped: false,
              match: {
                match_id: 123,
                home: "Meralco Bolts",
                away: "Barangay Ginebra",
                match_date: "2026-07-30T16:00:00.000Z",
                league: "Philippines - PBA",
              },
            },
          }
        : { ok: false, reason: "below_threshold", candidates: [] },
    );

    await expect(
      findBridgeSportCandidates({
        ...bet,
        evento: "Meralco Bolts vs Barangay Ginebra",
      }, ["Soccer"]),
    ).resolves.toEqual([
      expect.objectContaining({
        sport: "Basketball",
        confidence: 95,
        provider: "bridgeodds",
        matchId: "123",
      }),
    ]);
  });

  it("continua sondando esportes quando o Pinnacle17 está indisponível", async () => {
    mocks.fetchPinnacle17Events.mockRejectedValue(
      Object.assign(new Error("Circuit breaker aberto para pinnacle17"), {
        name: "CircuitOpenError",
      }),
    );

    await expect(
      findPinnacle17SportCandidates({
        bet,
        hints: ["Basketball"],
        flashCandidates: [],
      }),
    ).resolves.toEqual([]);
    expect(mocks.fetchPinnacle17Events).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "pinnacle17", sports: ["Soccer"] }),
      expect.stringContaining("fonte indisponível"),
    );
  });

  it("trata indisponibilidade da busca web como ausência de candidato", async () => {
    mocks.resolveKickoffViaWebSearch.mockRejectedValue(
      new Error("quota temporariamente indisponível"),
    );

    await expect(searchWebSportCandidate(bet)).resolves.toEqual({ answered: false, candidate: null });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "web" }),
      expect.stringContaining("fonte indisponível"),
    );
  });

  it("a busca web só responde quando o Gemini devolveu resultado", async () => {
    // O resolvedor real chama a busca que recebe e devolve null sem achado.
    mocks.resolveKickoffViaWebSearch.mockImplementation(async (params: { search: (request: unknown) => Promise<unknown> }) => {
      await params.search({ query: "q" });
      return null;
    });
    mocks.geminiSearch.mockResolvedValueOnce(null);
    await expect(searchWebSportCandidate(bet)).resolves.toEqual({ answered: false, candidate: null });
    mocks.geminiSearch.mockResolvedValueOnce({ data: { found: false }, sources: [] });
    await expect(searchWebSportCandidate(bet)).resolves.toEqual({ answered: true, candidate: null });
    mocks.resolveKickoffViaWebSearch.mockRejectedValueOnce(new Error("429"));
    await expect(searchWebSportCandidate(bet)).resolves.toEqual({ answered: false, candidate: null });
  });

  it("candidato WEB grounded_search preserva a confiança observada sem elevá-la ao limiar", async () => {
    mocks.resolveKickoffViaWebSearch.mockResolvedValue({
      sport: "Basketball",
      kickoff: new Date("2026-07-29T18:00:00.000Z"),
      confidence: 0.91,
      competition: "LNB",
      country: "Chile",
      sourceUrl: "https://example.test/lnb",
    });

    await expect(searchWebSportCandidate(bet).then((web) => web.candidate)).resolves.toMatchObject({
      sport: "Basketball",
      source: "WEB",
      provider: "web",
      confidence: 91,
      strategy: "grounded_search",
    });
  });

  it("repassa mercado e selecao para resolveKickoffViaWebSearch", async () => {
    mocks.resolveKickoffViaWebSearch.mockResolvedValue({
      sport: "Soccer",
      kickoff: new Date("2026-07-29T18:00:00.000Z"),
      confidence: 0.95,
      sourceUrl: "https://example.test",
    });

    await searchWebSportCandidate({
      ...bet,
      mercado: "Ambas Marcam",
      selecao: "Sim",
    });

    expect(mocks.resolveKickoffViaWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        evento: bet.evento,
        mercado: "Ambas Marcam",
        selecao: "Sim",
      }),
    );
  });

  it("rejeita candidato Pinnacle17 com modalidade incompatível (volleyball→handball)", async () => {
    mocks.fetchPinnacle17Events.mockImplementation(async ({ sportId }) =>
      sportId === 34 ? { data: [{ id: 99 }] } : null,
    );
    mocks.findPinnacle17Event.mockReturnValue({
      swapped: false,
      event: {
        id: 99,
        homeTeam: { name: "Team A" },
        awayTeam: { name: "Team B" },
        league: { name: "Handball Champions League" },
        startTime: "2026-07-29T18:00:00.000Z",
      },
    });

    await expect(
      findPinnacle17SportCandidates({
        bet: { ...bet, evento: "Team A vs Team B" },
        hints: ["Volleyball"],
        flashCandidates: [],
      }),
    ).resolves.toEqual([]);
  });

  /**
   * As fichas só ajudam: nome com duas fichas segue com a grafia original, e a
   * busca acontece nos dois catálogos.
   */
  it("nome ambíguo nas fichas não impede a busca no FlashScore nem na BridgeOdds", async () => {
    mocks.ambiguous = true;
    mocks.getFlashscoreCatalog.mockResolvedValue([]);
    mocks.findFlashscoreCandidate.mockImplementation(async ({ sportId }: { sportId: number }) => sportId === 1
      ? {
          ok: true,
          best: {
            strategy: "fuzzy",
            swapped: false,
            match: {
              match_id: "fs-1",
              timestamp: 1785340800,
              home_team: { name: "Time A", team_id: "t1" },
              away_team: { name: "Time B", team_id: "t2" },
              tournament: { name: "Liga", countryName: "Brazil" },
            },
          },
        }
      : { ok: false, reason: "no_candidate" });
    await expect(findFlashscoreSportCandidates(bet, ["Soccer"])).resolves.toEqual([
      expect.objectContaining({ sport: "Soccer", provider: "flashscore", matchId: "fs-1" }),
    ]);

    mocks.findBridgeMatch.mockResolvedValue({
      ok: true,
      best: {
        score: 2,
        swapped: false,
        match: { match_id: 7, home: "Time A", away: "Time B", match_date: "2026-07-29T15:00:00.000Z", league: "Brazil - Liga" },
      },
    });
    await expect(findBridgeSportCandidates(bet, ["Soccer"])).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: "bridgeodds", matchId: "7" })]),
    );
  });

  /**
   * A Pinnacle escreve "Hapoel Jerusalem" e põe o feminino na liga; o tipster
   * escreve "(F)". A trava de categoria lê a liga dos dois lados.
   */
  it("candidato Pinnacle17 feminino vale quando as ligas explicam a categoria", async () => {
    mocks.fetchPinnacle17Events.mockImplementation(async ({ sportId }: { sportId: number }) =>
      sportId === 29 ? { data: [{ id: 1637159068 }] } : null);
    mocks.findPinnacle17Event.mockReturnValue({
      swapped: false,
      score: 2,
      event: {
        id: 1637159068,
        homeTeam: { name: "Hapoel Jerusalem" },
        awayTeam: { name: "Kiryat Gat" },
        league: { name: "Premier League Women", country: "Israel" },
        startTime: "2026-09-24T13:30:00.000Z",
      },
    });
    const feminino = {
      ...bet,
      evento: "Hapoel Jerusalem F vs Kiryat Gat F",
      pais: "Israel",
      kickoffInferido: false,
      data: new Date("2026-09-24T13:30:00.000Z"),
    };

    await expect(findPinnacle17SportCandidates({
      bet: { ...feminino, competicao: "Ligat Al, Women" },
      hints: [],
      flashCandidates: [],
    })).resolves.toEqual([expect.objectContaining({ sport: "Soccer", provider: "pinnacle17", matchId: "1637159068" })]);
    // O mesmo nome na liga masculina é outro time: o "(F)" do tipster vale.
    mocks.findPinnacle17Event.mockReturnValue({
      swapped: false,
      score: 2,
      event: {
        id: 1637000001,
        homeTeam: { name: "Hapoel Jerusalem" },
        awayTeam: { name: "Kiryat Gat" },
        league: { name: "Ligat ha'Al", country: "Israel" },
        startTime: "2026-09-24T13:30:00.000Z",
      },
    });
    await expect(findPinnacle17SportCandidates({
      bet: { ...feminino, competicao: "" },
      hints: [],
      flashCandidates: [],
    })).resolves.toEqual([]);
  });
});
