import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findTeamIdentitySportCandidates: vi.fn(),
  findBridgeSportCandidates: vi.fn(),
  findFlashscoreSportCandidates: vi.fn(),
  findPinnacle17SportCandidates: vi.fn(),
}));

vi.mock("@/src/services/bets/sport-resolution/team-candidates", () => ({
  findTeamIdentitySportCandidates: mocks.findTeamIdentitySportCandidates,
}));
vi.mock("@/src/services/bets/sport-resolution/bridge-candidate", () => ({
  findBridgeSportCandidates: mocks.findBridgeSportCandidates,
}));
vi.mock("@/src/services/bets/sport-resolution/flashscore-candidates", () => ({
  findFlashscoreSportCandidates: mocks.findFlashscoreSportCandidates,
}));
vi.mock("@/src/services/bets/sport-resolution/provider-candidates", () => ({
  findPinnacle17SportCandidates: mocks.findPinnacle17SportCandidates,
}));

import { collectSportCandidates } from "@/src/services/bets/sport-resolution/collect-candidates";
import { candidateHints, chooseSportCandidate } from "@/src/services/bets/sport-resolution/decision";

const bet = {
  evento: "De Minaur A. vs Nakashima B.",
  data: new Date("2026-07-29T15:00:00.000Z"),
  kickoffInferido: true,
  pais: "",
  competicao: "",
};

describe("collectSportCandidates waterfall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findTeamIdentitySportCandidates.mockResolvedValue([]);
    mocks.findBridgeSportCandidates.mockResolvedValue([]);
    mocks.findFlashscoreSportCandidates.mockResolvedValue([]);
    mocks.findPinnacle17SportCandidates.mockResolvedValue([]);
  });

  /** Os dois nomes nas fichas do futebol: pista, abaixo de 70. */
  const soccerNames = { sport: "Soccer", confidence: 60, source: "TEAM_ID", provider: "team_identity", strategy: "team_cards" };

  it("a identidade dos times não encerra a busca: os catálogos procuram o jogo", async () => {
    mocks.findTeamIdentitySportCandidates.mockResolvedValue([soccerNames]);

    const out = await collectSportCandidates(bet, ["Soccer"]);
    expect(out).toEqual([soccerNames]);
    expect(mocks.findFlashscoreSportCandidates).toHaveBeenCalled();
    expect(mocks.findPinnacle17SportCandidates).toHaveBeenCalled();
    expect(mocks.findBridgeSportCandidates).toHaveBeenCalled();
  });

  it("o esporte dos nomes, que o post não desmente, orienta a busca nos catálogos", async () => {
    const handballNames = { ...soccerNames, sport: "Handball" };
    mocks.findTeamIdentitySportCandidates.mockResolvedValue([handballNames]);
    await collectSportCandidates(bet, ["Soccer"]);
    expect(mocks.findFlashscoreSportCandidates).toHaveBeenLastCalledWith(bet, ["Soccer", "Handball"], undefined);
    expect(mocks.findPinnacle17SportCandidates).toHaveBeenLastCalledWith(expect.objectContaining({ hints: ["Soccer", "Handball"] }));
    expect(mocks.findBridgeSportCandidates).toHaveBeenLastCalledWith(bet, ["Soccer", "Handball"], {});

    // O post que aponta outro esporte desmente a identidade: ela sai das pistas.
    await collectSportCandidates(bet, [], { postSports: ["Basketball"] });
    expect(mocks.findFlashscoreSportCandidates).toHaveBeenLastCalledWith(bet, [], undefined);
  });

  it("o jogo achado no catálogo vale sobre os nomes em outro esporte", async () => {
    mocks.findTeamIdentitySportCandidates.mockResolvedValue([soccerNames]);
    mocks.findFlashscoreSportCandidates.mockResolvedValue([
      { sport: "Basketball", confidence: 95, source: "PROVIDER", provider: "flashscore", matchId: "fs-basket" },
    ]);

    const out = await collectSportCandidates(bet, []);
    expect(chooseSportCandidate(out)).toMatchObject({ reason: "confirmed", candidate: { sport: "Basketball", provider: "flashscore" } });
    expect(mocks.findPinnacle17SportCandidates).not.toHaveBeenCalled();
  });

  it("short-circuit: encerra após FlashScore com match confiável sem chamar BridgeOdds nem Pinnacle17", async () => {
    mocks.findFlashscoreSportCandidates.mockResolvedValue([
      {
        sport: "Tennis",
        confidence: 95,
        source: "PROVIDER",
        provider: "flashscore",
        matchId: "fs1",
      },
    ]);

    const out = await collectSportCandidates(bet, ["Tennis"]);
    expect(out).toHaveLength(1);
    expect(out[0]?.provider).toBe("flashscore");
    expect(mocks.findBridgeSportCandidates).not.toHaveBeenCalled();
    expect(mocks.findPinnacle17SportCandidates).not.toHaveBeenCalled();
  });

  it("chama BridgeOdds após os catálogos mais baratos", async () => {
    mocks.findBridgeSportCandidates.mockResolvedValue([
      {
        sport: "Soccer",
        confidence: 95,
        source: "PROVIDER",
        provider: "bridgeodds",
        matchId: "b1",
      },
    ]);

    const out = await collectSportCandidates(bet, ["Soccer"]);
    expect(mocks.findFlashscoreSportCandidates).toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0]?.provider).toBe("bridgeodds");
    expect(mocks.findPinnacle17SportCandidates.mock.invocationCallOrder[0]).toBeLessThan(mocks.findBridgeSportCandidates.mock.invocationCallOrder[0]!);
  });

  it("encerra no Pinnacle17 sem consumir BridgeOdds", async () => {
    mocks.findPinnacle17SportCandidates.mockResolvedValue([
      {
        sport: "Baseball",
        confidence: 95,
        source: "PROVIDER",
        provider: "pinnacle17",
        matchId: "p1",
      },
    ]);

    const out = await collectSportCandidates(bet, ["Baseball"]);
    expect(mocks.findFlashscoreSportCandidates).toHaveBeenCalled();
    expect(mocks.findBridgeSportCandidates).not.toHaveBeenCalled();
    expect(mocks.findPinnacle17SportCandidates).toHaveBeenCalled();
    expect(out.some((c) => c.provider === "pinnacle17")).toBe(true);
  });

  it("o placar do post fora da escala do futebol desmente os nomes do futebol", async () => {
    const botafogo = { ...bet, evento: "Botafogo vs Flamengo", mercado: "Moneyline", selecao: "Flamengo" };
    mocks.findTeamIdentitySportCandidates.mockResolvedValue([soccerNames]);
    const out = await collectSportCandidates(botafogo, [], { postScores: [{ home: 77, away: 97 }] });
    expect(out).toEqual([expect.objectContaining({ sport: "Soccer", confidence: 60, strategy: "team_cards_contradicted" })]);
    expect(mocks.findFlashscoreSportCandidates).toHaveBeenCalled();
  });

  it("candidateHints extrai modalidades a partir de sinais de competição", () => {
    const hints = candidateHints({
      competicao: "Premier League 2026",
    });
    expect(hints).toContain("Soccer");

    const hintsNba = candidateHints({
      competicao: "NBA Regular Season",
    });
    expect(hintsNba).toContain("Basketball");
  });

  it("short-circuit: encerra com TEXT quando mercado ou selecao contem vocabulario deterministico", async () => {
    const marketBet = {
      ...bet,
      mercado: "Asian Handicap Corners",
      selecao: "Over 9.5",
    };
    const out = await collectSportCandidates(marketBet, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sport: "Soccer",
      source: "TEXT",
      strategy: "deterministic_market_text",
    });
    expect(out[0]?.confidence).toBeGreaterThanOrEqual(92);
    expect(mocks.findTeamIdentitySportCandidates).not.toHaveBeenCalled();
    expect(mocks.findFlashscoreSportCandidates).not.toHaveBeenCalled();
    expect(mocks.findPinnacle17SportCandidates).not.toHaveBeenCalled();
    expect(mocks.findBridgeSportCandidates).not.toHaveBeenCalled();
  });

  describe("clube multiesportivo: a linha que o futebol não tem desmente o jogo de futebol achado", () => {
    const classico = { ...bet, evento: "Real Madrid vs Barcelona", mercado: "Asian Handicap", selecao: "Real Madrid -4.5" };
    const found = (sport: "Soccer" | "Basketball", confidence: number) =>
      ({ sport, confidence, source: "PROVIDER", provider: "flashscore", matchId: `fs-${sport}` });
    beforeEach(() => {
      mocks.findFlashscoreSportCandidates.mockResolvedValue([found("Soccer", 100), found("Basketball", 95)]);
    });

    it.each([
      ["a unidade lida do post", classico, { readTerms: { mercado: "Handicap de Pontos", selecao: "Real Madrid -4.5" } }],
      ["a unidade na seleção", { ...classico, selecao: "Real Madrid -4.5 Pontos" }, {}],
      ["o total fora da escala do futebol", { ...classico, mercado: "Total", selecao: "Over 160.5" }, {}],
    ])("%s: basquete", async (_label, terms, options) => {
      const out = await collectSportCandidates(terms, [], options);
      expect(chooseSportCandidate(out)).toMatchObject({ reason: "confirmed", candidate: { sport: "Basketball" } });
      // O jogo de futebol fica na evidência, sem voto.
      expect(out).toContainEqual(expect.objectContaining({ sport: "Soccer", confidence: 60, strategy: "flashscore_contradicted" }));
    });

    it("sem unidade nem total, os dois jogos seguem em conflito", async () => {
      expect(chooseSportCandidate(await collectSportCandidates(classico, []))).toMatchObject({ conflict: true, reason: "strong_candidates_disagree" });
    });

    it("o futebol achado sozinho para uma linha de pontos não confirma", async () => {
      mocks.findFlashscoreSportCandidates.mockResolvedValue([found("Soccer", 100)]);
      const out = await collectSportCandidates({ ...classico, mercado: "Total", selecao: "Over 160.5" }, []);
      expect(chooseSportCandidate(out)).toMatchObject({ candidate: null, reason: "no_strong_candidate" });
      expect(mocks.findBridgeSportCandidates).toHaveBeenCalled();
    });

    it("a estatística do futebol tem outra escala e não desmente o jogo", async () => {
      mocks.findFlashscoreSportCandidates.mockResolvedValue([found("Soccer", 100)]);
      const out = await collectSportCandidates({ ...classico, mercado: "Booking Points", selecao: "Over 55.5" }, []);
      expect(chooseSportCandidate(out)).toMatchObject({ reason: "confirmed", candidate: { sport: "Soccer" } });
    });
  });

  describe("liga compartilhada no fast-path ('Serie A' também é de basquete e vôlei)", () => {
    const serieA = { ...bet, evento: "Perugia vs Trento", competicao: "Serie A", mercado: "Moneyline", selecao: "Perugia" };
    const fastPath = expect.objectContaining({ strategy: "deterministic_market_text" });

    it("sem leitura contrária, a Serie A encerra no futebol", async () => {
      expect(await collectSportCandidates(serieA, [])).toEqual([expect.objectContaining({ sport: "Soccer", strategy: "deterministic_market_text" })]);
      expect(await collectSportCandidates(serieA, [], { postSports: ["Soccer"] })).toEqual([fastPath]);
    });

    it("a leitura do post em outro esporte manda procurar o jogo", async () => {
      mocks.findFlashscoreSportCandidates.mockResolvedValue([
        { sport: "Volleyball", confidence: 95, source: "PROVIDER", provider: "flashscore", matchId: "fs-volley" },
      ]);
      const out = await collectSportCandidates(serieA, ["Volleyball"], { postSports: ["Volleyball"] });
      expect(out).not.toContainEqual(fastPath);
      expect(chooseSportCandidate(out)).toMatchObject({ reason: "confirmed", candidate: { sport: "Volleyball" } });
    });

    it("a linha fora da escala do futebol manda procurar o jogo", async () => {
      for (const terms of [{ mercado: "Total", selecao: "Over 158.5" }, { mercado: "Handicap", selecao: "Perugia -8.5" }]) {
        mocks.findFlashscoreSportCandidates.mockClear();
        expect(await collectSportCandidates({ ...serieA, ...terms }, []), terms.selecao).not.toContainEqual(fastPath);
        expect(mocks.findFlashscoreSportCandidates).toHaveBeenCalled();
      }
      // A liga só do futebol encerra, como o texto de estatística.
      expect(await collectSportCandidates({ ...serieA, competicao: "Brasileirão", mercado: "Total", selecao: "Over 158.5" }, []))
        .toEqual([fastPath]);
    });
  });
});

