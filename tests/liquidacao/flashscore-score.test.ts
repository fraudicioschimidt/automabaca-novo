import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "@/src/domain/provider-error";
import { BetStatus } from "@/src/generated/prisma/enums";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";

/**
 * Os parciais de 1º/2º tempo vêm na ordem do FEED e precisam passar pelo
 * `swapped` do casamento: com o FlashScore listando o Flamengo de mandante, a
 * aposta "Palmeiras vs Flamengo · 1º tempo Palmeiras" não pode ler o 1–0 do
 * Flamengo como gol do Palmeiras.
 */
const mocks = vi.hoisted(() => ({
  settle: vi.fn(async (..._args: unknown[]) => true),
  playerStats: vi.fn(),
  details: vi.fn(),
}));

vi.mock("@/src/providers/flashscore/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/providers/flashscore/client")>()),
  getFlashscoreMatchPlayerStats: mocks.playerStats,
}));

vi.mock("@/src/services/settlement/flashscore/settle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/settlement/flashscore/settle")>()),
  fetchMatchDetails: mocks.details,
}));
vi.mock("@/src/services/settlement/flashscore/score-settle", () => ({ settleFromFlashscoreScore: mocks.settle }));

const { settleFlashscoreScore } = await import("@/src/services/settlement/flashscore/score");

const defaultDetails = { body: {
  match_id: "M1",
  sport: { sport_id: 1 },
  match_status: {
    stage: "Finished", is_started: true, is_finished: true, is_in_progress: false,
    is_cancelled: false, is_postponed: false, live_time: null, live_minute: null,
  },
  // Feed: Flamengo (mandante) 1–0 no 1º tempo, 0–0 no 2º.
  scores: {
    home: 1, away: 0, home_total: 1, away_total: 0,
    home_1st_half: 1, away_1st_half: 0, home_2nd_half: 0, away_2nd_half: 0,
    home_extra_time: null, away_extra_time: null,
  },
} };

const aposta = {
  id: "bet-1", evento: "Palmeiras vs Flamengo", esporte: "Soccer",
  mercado: "Resultado 1º Tempo", selecao: "Palmeiras", odds: 2.5, stake: 10,
  status: BetStatus.PENDING, legsJson: null, liveScoreHome: null, liveScoreAway: null,
} as unknown as EligibleBet;

describe("parciais seguem o lado da aposta", () => {
  beforeEach(() => { mocks.settle.mockClear(); mocks.details.mockResolvedValue(defaultDetails); });

  it("casamento invertido inverte o 1º e o 2º tempo", async () => {
    await settleFlashscoreScore({
      bet: aposta, score: { home: 0, away: 1 }, regulation: { regulationEvidence: null, extraTimePlayed: false }, viaInferencia: false,
      matchId: "M1", halfScoresPublished: true, detailsCache: new Map(), swapped: true, now: new Date(),
    });
    const opts = mocks.settle.mock.calls[0]?.[2] as { periodScores: unknown };
    expect(opts.periodScores).toEqual({ ht: { home: 0, away: 1 }, sh: { home: 0, away: 0 } });
  });

  it("sem inversão, mantém a ordem do feed", async () => {
    await settleFlashscoreScore({
      bet: { ...aposta, evento: "Flamengo vs Palmeiras" } as EligibleBet,
      score: { home: 1, away: 0 }, regulation: { regulationEvidence: null, extraTimePlayed: false }, viaInferencia: false,
      matchId: "M1", halfScoresPublished: true, detailsCache: new Map(), swapped: false, now: new Date(),
    });
    const opts = mocks.settle.mock.calls[0]?.[2] as { periodScores: unknown };
    expect(opts.periodScores).toEqual({ ht: { home: 1, away: 0 }, sh: { home: 0, away: 0 } });
  });
});

describe("parciais precisam da partida solicitada e podem chegar depois", () => {
  beforeEach(() => { mocks.settle.mockClear(); mocks.settle.mockResolvedValue(false); });
  it.each(["other_match", "missing"])("não usa parciais %s e mantém a observação na graça", async (kind) => {
    mocks.details.mockResolvedValue(kind === "missing" ? { body: null } : defaultDetails);
    const now = new Date("2026-10-09T22:00:00Z");
    const result = await settleFlashscoreScore({ bet: { ...aposta, data: new Date("2026-10-09T18:00:00Z") },
      score: { home: 0, away: 1 }, regulation: { regulationEvidence: null, extraTimePlayed: false }, viaInferencia: false,
      matchId: "M2", halfScoresPublished: true, detailsCache: new Map(), swapped: true, now });
    expect(mocks.settle.mock.calls[0]?.[2]).toMatchObject({ periodScores: null, awaitingData: true });
    expect(result).toMatchObject({ settled: false, observationFinal: false, settlementOutcome: "score_extras_pending" });
  });

  it("partida sem parciais publicados não espera nem consulta os detalhes: a recusa sai na hora", async () => {
    mocks.details.mockClear();
    const now = new Date("2026-10-09T22:00:00Z");
    const result = await settleFlashscoreScore({ bet: { ...aposta, data: new Date("2026-10-09T18:00:00Z") },
      score: { home: 0, away: 1 }, regulation: { regulationEvidence: null, extraTimePlayed: false }, viaInferencia: false,
      matchId: "M2", halfScoresPublished: false, detailsCache: new Map(), swapped: true, now });
    expect(mocks.details).not.toHaveBeenCalled();
    expect(mocks.settle.mock.calls[0]?.[2]).toMatchObject({ periodScores: null, awaitingData: false });
    expect(result).toMatchObject({ settled: false, unsupported: false, settlementOutcome: "manual_or_already_settled" });
    expect(result).not.toHaveProperty("observationFinal");
  });
});

describe("criar-aposta com perna de jogador espera a lista de jogadores", () => {
  const kickoff = new Date("2026-09-20T15:00:00Z");
  const hours = (n: number) => new Date(kickoff.getTime() + n * 3_600_000);
  const criarAposta = {
    ...aposta, evento: "Fleetwood Town vs Sheffield United", mercado: "Criar Aposta",
    selecao: "Over 2.5 + Jordan Ayew", data: kickoff,
    legsJson: { kind: "same_game", legs: [
      { evento: "Fleetwood Town vs Sheffield United", mercado: "Total – Match", selecao: "Over 2.5" },
      { evento: "Fleetwood Town vs Sheffield United", mercado: "Marcar a Qualquer Momento", selecao: "Jordan Ayew" },
    ] },
  } as unknown as EligibleBet;
  const params = (now: Date) => ({
    bet: criarAposta, score: { home: 1, away: 2 }, regulation: { regulationEvidence: null, extraTimePlayed: false }, viaInferencia: false,
    matchId: "M2", halfScoresPublished: true, swapped: false, playerStatsCache: new Map(), now,
  });
  beforeEach(() => { mocks.settle.mockClear(); mocks.playerStats.mockReset(); });

  it("lista que ainda não saiu: a recusa espera, e a observação segue aberta", async () => {
    mocks.playerStats.mockResolvedValue({ players: [] });
    mocks.settle.mockResolvedValueOnce(false);

    const result = await settleFlashscoreScore(params(hours(4)));

    expect(mocks.settle.mock.calls[0]?.[2]).toMatchObject({ players: null, awaitingData: true, alertStatQualifier: true });
    expect(result).toMatchObject({ settled: false, observationFinal: false, settlementOutcome: "score_extras_pending" });
  });

  it("lista que não saiu até o fim da graça: a recusa segue para o dono e a observação fecha", async () => {
    mocks.playerStats.mockResolvedValue({ players: [] });
    mocks.settle.mockResolvedValueOnce(false);

    const result = await settleFlashscoreScore(params(hours(7)));

    expect(mocks.settle.mock.calls[0]?.[2]).toMatchObject({ awaitingData: false, alertStatQualifier: true });
    expect(result).not.toHaveProperty("observationFinal");
  });

  it("falha inesperada na lista não é 'lista vazia': sobe com a aposta no texto e nada é gravado", async () => {
    mocks.playerStats.mockRejectedValue(new Error("resposta sem o campo players"));

    await expect(settleFlashscoreScore(params(hours(4)))).rejects.toThrow(/jogadores do FlashScore para a aposta bet-1/);
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it("provider fora do ar sobe com o erro original, que o ciclo reconhece como indisponibilidade", async () => {
    const unavailable = new ProviderRequestError("flashscore", { error: "temporariamente indisponível", status: 503 });
    mocks.playerStats.mockRejectedValue(unavailable);

    await expect(settleFlashscoreScore(params(hours(4)))).rejects.toBe(unavailable);
    expect(mocks.settle).not.toHaveBeenCalled();
  });
});
