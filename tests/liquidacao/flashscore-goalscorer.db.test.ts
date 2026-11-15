import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import type { FlashscoreMatchCandidate } from "@/src/providers/flashscore/match";
import { seedMercados } from "@/prisma/seed-mercados";
import { MERCADO_CATALOG } from "@/src/domain/mercados/catalog-data";

const providerMocks = vi.hoisted(() => ({
  summary: vi.fn(),
  playerStats: vi.fn(),
}));

vi.mock("@/src/providers/flashscore/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/providers/flashscore/client")>()),
  getFlashscoreMatchSummary: providerMocks.summary,
  getFlashscoreMatchPlayerStats: providerMocks.playerStats,
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
const NOW = new Date("2026-08-12T21:30:00Z");

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  vi.clearAllMocks();
  providerMocks.playerStats.mockResolvedValue({
    players: [
      { player_id: "p1", name: "Haaland Erling", stats: { GOALS: { raw_value: "1" } } },
      { player_id: "p2", name: "Foden Phil", stats: { GOALS: { raw_value: "1" } } },
    ],
  });
  providerMocks.summary.mockResolvedValue([
    { minutes: "12", team: "home", players: [{ type: "Goal", name: "Foden P.", player_id: "p2" }] },
    { minutes: "90+2", team: "away", players: [{ type: "Goal", name: "Haaland E.", player_id: "p1" }] },
  ]);
});

async function setup(mercado = "First Goalscorer", selecao = "Phil Foden") {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Ordered GS", slug: `ordered-gs-${Math.random()}`, valorUnidade: 100 },
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      data: KICKOFF,
      evento: "Manchester City vs Real Madrid",
      esporte: "Soccer",
      competicao: "Friendly",
      pais: "World",
      mercado,
      selecao,
      odds: 2.5,
      stake: 1,
      status: "PENDING",
    },
    include: { sharp: true, closing: true, result: true, captureEvidence: true },
  });
  const candidate: FlashscoreMatchCandidate = {
    score: 2,
    swapped: false,
    strategy: "provider_id",
    match: {
      match_id: "ordered-1",
      timestamp: Math.floor(KICKOFF.getTime() / 1_000),
      home_team: { team_id: "city", name: "Manchester City" },
      away_team: { team_id: "real", name: "Real Madrid" },
      scores: { home: 1, away: 1 },
      match_status: {
        stage: "Finished",
        is_cancelled: false,
        is_postponed: false,
        is_started: true,
        is_in_progress: false,
        is_finished: true,
      },
    },
  };
  return { bet, candidate };
}

async function settle(
  bet: Awaited<ReturnType<typeof setup>>["bet"],
  candidate: FlashscoreMatchCandidate,
) {
  return processFlashscoreMatchOutcome({
    bet,
    candidate,
    sportId: 1,
    statsCache: new Map(),
    playerStatsCache: new Map(),
    summaryCache: new Map(),
    now: NOW,
  });
}

describe("settlement First/Last Goalscorer em PostgreSQL", () => {
  it("materializa First/Last e seus aliases no catálogo", async () => {
    await seedMercados(db.prisma);
    const mercados = await db.prisma.mercadoPadrao.findMany({
      where: { nome: { in: ["First Goalscorer", "Last Goalscorer"] } },
      include: { aliases: true },
      orderBy: { nome: "asc" },
    });
    expect(mercados.map((mercado) => mercado.nome)).toEqual([
      "First Goalscorer",
      "Last Goalscorer",
    ]);
    expect(mercados.map((mercado) => mercado.aliases.length)).toEqual([
      MERCADO_CATALOG["First Goalscorer"].length,
      MERCADO_CATALOG["Last Goalscorer"].length,
    ]);
  });

  it("aplica WON e lucro pelo primeiro gol comprovado", async () => {
    const { bet, candidate } = await setup();
    const result = await settle(bet, candidate);

    expect(result).toMatchObject({
      settled: true,
      unsupported: false,
      settlementOutcome: "settled_from_ordered_goalscorer",
      orderedGoalscorer: { resolvido: true, ordem: "first", playerIdDoGol: "p2" },
    });
    const settled = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(settled.status).toBe("WON");
    expect(settled.lucro.toNumber()).toBe(1.5);
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id } })).toBe(1);
  });

  it("reserva que pode ter entrado depois do primeiro gol não sai LOST: vai ao operador", async () => {
    // Bernardo entrou do banco e jogou 20 minutos; o primeiro gol foi aos 12'.
    providerMocks.playerStats.mockResolvedValue({
      players: [
        { player_id: "p1", name: "Haaland Erling", in_base_lineup: true, stats: { GOALS: { raw_value: "1" }, MATCH_MINUTES_PLAYED: { raw_value: "90" } } },
        { player_id: "p2", name: "Foden Phil", in_base_lineup: true, stats: { GOALS: { raw_value: "1" }, MATCH_MINUTES_PLAYED: { raw_value: "90" } } },
        { player_id: "p3", name: "Silva Bernardo", in_base_lineup: false, stats: { GOALS: { raw_value: "0" }, MATCH_MINUTES_PLAYED: { raw_value: "20" } } },
      ],
    });
    const { bet, candidate } = await setup("First Goalscorer", "Bernardo Silva");

    const result = await processFlashscoreMatchOutcome({
      bet, candidate, sportId: 1, statsCache: new Map(), playerStatsCache: new Map(), summaryCache: new Map(),
      // Passada a carência: o feed não vai publicar o minuto de entrada.
      now: new Date(KICKOFF.getTime() + 7 * 3_600_000),
    });

    expect(result).toMatchObject({
      settled: false,
      unsupported: true,
      settlementOutcome: "manual_entrada_apos_primeiro_gol_nao_descartada",
    });
    const pending = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(pending.status).toBe("PENDING");
    expect(sendOperationalAlert).toHaveBeenCalledWith(
      expect.stringContaining("a casa anula a aposta (VOID)"),
      expect.objectContaining({ source: "settlement.flashscore-ordered-goalscorer", key: bet.id }),
    );
  });

  it("summary vazio não muda status nem dinheiro", async () => {
    const { bet, candidate } = await setup("Last Goalscorer", "Erling Haaland");
    providerMocks.summary.mockResolvedValue([]);

    const result = await settle(bet, candidate);

    expect(result).toMatchObject({
      settled: false,
      unsupported: false,
      observationFinal: false,
      settlementOutcome: "ordered_goalscorer_pending",
    });
    const pending = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(pending.status).toBe("PENDING");
    expect(pending.lucro.toNumber()).toBe(0);
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id } })).toBe(0);
  });
});
