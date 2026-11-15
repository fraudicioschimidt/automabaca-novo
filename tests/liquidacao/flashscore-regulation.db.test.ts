import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import type { FlashscoreMatchCandidate } from "@/src/providers/flashscore/match";

const providerMocks = vi.hoisted(() => ({ summary: vi.fn() }));
vi.mock("@/src/providers/flashscore/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/providers/flashscore/client")>()),
  getFlashscoreMatchSummary: providerMocks.summary,
}));
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperatorNotification: vi.fn(async () => true),
  sendOperationalAlert: vi.fn(async () => undefined),
}));

const { processFlashscoreMatchOutcome } = await import(
  "@/src/services/settlement/flashscore/match-outcome"
);
const { sendOperationalAlert } = await import("@/src/services/ops/alerts");

let db: TestDb;
const KICKOFF = new Date("2026-08-12T18:30:00Z");

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  vi.clearAllMocks();
});

async function setup() {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Regulation", slug: `regulation-${Math.random()}`, valorUnidade: 100 },
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      data: KICKOFF,
      evento: "Manchester United vs Leeds United",
      esporte: "Soccer",
      competicao: "Friendly",
      pais: "World",
      mercado: "Total – Match",
      selecao: "Under 3.25",
      odds: 1.95,
      stake: 0.5,
      status: "PENDING",
    },
    include: { sharp: true, closing: true, result: true, captureEvidence: true },
  });
  const candidate: FlashscoreMatchCandidate = {
    score: 2,
    swapped: false,
    strategy: "provider_id",
    match: {
      match_id: "4YByEeMF",
      timestamp: Math.floor(KICKOFF.getTime() / 1_000),
      home_team: { team_id: "man", name: "Manchester Utd (Eng)" },
      away_team: { team_id: "lee", name: "Leeds (Eng)" },
      scores: { home: 1, away: 1 },
      match_status: {
        stage: "After Penalties",
        is_cancelled: false,
        is_postponed: false,
        is_started: true,
        is_in_progress: false,
        is_finished: true,
        is_finished_after_penalties: true,
      },
    },
  };
  return { bet, candidate };
}

async function settle(
  bet: Awaited<ReturnType<typeof setup>>["bet"],
  candidate: FlashscoreMatchCandidate,
  now = new Date("2026-08-12T21:00:00Z"),
) {
  return processFlashscoreMatchOutcome({
    bet,
    candidate,
    sportId: 1,
    statsCache: new Map(),
    playerStatsCache: new Map(),
    summaryCache: new Map(),
    now,
  });
}

describe("settlement regulamentar após prorrogação", () => {
  it("liquida Under 3.25 como WON pelo 1-1 dos 90 minutos", async () => {
    const { bet, candidate } = await setup();
    providerMocks.summary.mockResolvedValueOnce([
      { minutes: "16", team: "home", players: [{ type: "Goal" }] },
      { minutes: "29", team: "away", players: [{ type: "Goal" }] },
    ]);

    const result = await settle(bet, candidate);

    expect(result).toMatchObject({
      settled: true,
      unsupported: false,
      regulationScore: { home: 1, away: 1 },
      settlementOutcome: "settled_from_regulation_score",
    });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .toMatchObject({ status: "WON" });
    expect(await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ scoreHome: 1, scoreAway: 1 });
  });

  it("summary incompleto logo depois do jogo: espera o resumo, sem alerta e com a observação aberta", async () => {
    const { bet, candidate } = await setup();
    providerMocks.summary.mockResolvedValueOnce([
      { minutes: "16", team: "home", players: [{ type: "Goal" }] },
    ]);

    const result = await settle(bet, candidate);

    expect(result).toMatchObject({
      settled: false,
      unsupported: false,
      observationFinal: false,
      regulationScore: null,
      settlementOutcome: "regulation_pending",
    });
    expect(sendOperationalAlert).not.toHaveBeenCalled();
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .toMatchObject({ status: "PENDING" });
    expect(await db.prisma.betResult.findUnique({ where: { betId: bet.id } })).toBeNull();
  });

  it("summary ainda incompleto depois da graça: manual, com alerta, e não ingere placar", async () => {
    const { bet, candidate } = await setup();
    providerMocks.summary.mockResolvedValueOnce([
      { minutes: "16", team: "home", players: [{ type: "Goal" }] },
    ]);

    const result = await settle(bet, candidate, new Date("2026-08-13T01:00:00Z"));

    expect(result).toMatchObject({
      settled: false,
      unsupported: true,
      observationFinal: true,
      regulationScore: null,
      settlementOutcome: "manual_extra_time",
    });
    expect(sendOperationalAlert).toHaveBeenCalledWith(
      expect.stringContaining("prorrogação"),
      expect.objectContaining({ source: "settlement.flashscore-extra-time", key: bet.id }),
    );
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .toMatchObject({ status: "PENDING" });
    expect(await db.prisma.betResult.findUnique({ where: { betId: bet.id } })).toBeNull();
  });
});


it("não paga por 120 minutos uma perna de 90 quando a primeira inclui prorrogação", async () => {
  const { bet, candidate } = await setup();
  const mixed = await db.prisma.bet.update({ where: { id: bet.id }, data: {
    mercado: "Vencedor incluindo prorrogação", selecao: "Manchester United + Over 2.5", legsJson: { kind: "same_game", legs: [
      { evento: bet.evento, mercado: "Vencedor incluindo prorrogação", selecao: "Manchester United" },
      { evento: bet.evento, mercado: "Total – Match", selecao: "Over 2.5" },
    ] },
  }, include: { sharp: true, closing: true, result: true, captureEvidence: true } });
  candidate.match.scores = { home: 2, away: 1 };
  candidate.match.match_status = { ...candidate.match.match_status, stage: "After Extra Time",
    is_finished_after_extra_time: true, is_finished_after_penalties: false };

  const result = await settle(mixed, candidate);

  expect(result.settled).toBe(false);
  await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).resolves.toMatchObject({ status: "PENDING", settledAt: null });
  expect(providerMocks.summary).not.toHaveBeenCalled();
  expect(vi.mocked(sendOperationalAlert)).toHaveBeenCalled();
});
