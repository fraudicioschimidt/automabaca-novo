import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
const details = vi.hoisted(() => vi.fn());
vi.mock("@/src/providers/flashscore/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/providers/flashscore/client")>(),
  flashscoreConfigured: () => true,
  listFlashscoreMatchesByDate: list,
  getFlashscoreMatchDetails: details,
}));

import { applyManualBetStatusChange } from "../helpers/settle";
import { clearFlashscoreCatalogCache } from "@/src/providers/flashscore/catalog";
import { runFlashscoreObservationOnce } from "@/src/services/settlement/flashscore/observation";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalogLink } from "../helpers/team-cards";

/**
 * A observação do FlashScore de ponta a ponta, com o dinheiro: a aposta sem jogo
 * vinculado liquida pelo jogo que o pareamento dos catálogos ligou ao evento da
 * identidade, e o mando vem dos ids dos times que o FlashScore devolve na hora,
 * não do que a ligação gravou.
 */

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => {
  await db.reset();
  await clearFlashscoreCatalogCache();
  list.mockReset();
  details.mockReset();
});

const KICKOFF = new Date("2026-09-20T19:00:00Z");
const NOW = new Date("2026-09-20T22:00:00Z");

/** Aposta no Flamengo, identidade automática no evento da Pinnacle17 ligado. */
async function apostaNoFlamengo() {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Banca", slug: "banca", valorUnidade: 100 } });
  return db.prisma.bet.create({ data: {
    bankrollId: bankroll.id, data: KICKOFF, evento: "Flamengo RJ vs Vasco da Gama RJ", esporte: "Soccer",
    pais: "Brazil", competicao: "Brazil - Serie A", mercado: "Money Line – Match", selecao: "Flamengo RJ",
    odds: 2, stake: 1, status: "PENDING", sportResolutionStatus: "CONFIRMED", sportResolvedAt: KICKOFF,
    registradoEm: new Date(KICKOFF.getTime() - 3_600_000),
    sharp: { create: { identityStatus: "MATCHED", provider: "pinnacle17", providerMatchId: "1637000001", confidence: 100 } },
  } });
}

/** O jogo no FlashScore, com nomes que nada dizem: só os ids dos times apontam quem é quem. */
function jogo(home: { id: string; score: number }, away: { id: string; score: number }) {
  return [{
    tournament_id: "bra", name: "Serie A Betano", country_name: "Brazil",
    matches: [{
      match_id: "fs-ligado", timestamp: Math.floor(KICKOFF.getTime() / 1_000),
      home_team: { team_id: home.id, name: "Alfa" }, away_team: { team_id: away.id, name: "Beta" },
      scores: { home: home.score, away: away.score },
      match_status: { stage: "Finished", is_cancelled: false, is_postponed: false, is_started: true, is_in_progress: false, is_finished: true },
    }],
  }];
}

describe("liquidação pelo jogo ligado", () => {
  it("o FlashScore inverteu o mando depois da ligação: a aposta no Flamengo que venceu fora de casa sai WON", async () => {
    // Na rodada do pareamento o Flamengo era o mandante no FlashScore.
    await seedCatalogLink(db.prisma, {
      pinnacleEventId: "1637000001", flashscoreMatchId: "fs-ligado", pinnacleHome: "Flamengo RJ", pinnacleAway: "Vasco da Gama RJ",
      flashscoreHome: "Flamengo", flashscoreAway: "Vasco", flashscoreHomeTeamId: "fs-fla", flashscoreAwayTeamId: "fs-vasco",
      swapped: false, kickoff: KICKOFF,
    });
    const bet = await apostaNoFlamengo();
    // Agora o FlashScore lista o Vasco em casa: Vasco 0 × 2 Flamengo.
    list.mockResolvedValue(jogo({ id: "fs-vasco", score: 0 }, { id: "fs-fla", score: 2 }));

    const run = await runFlashscoreObservationOnce(NOW);

    expect(run).toMatchObject({ matched: 1, settled: 1 });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { status: true } })).toEqual({ status: "WON" });
    expect(await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } })).toMatchObject({
      resultMatchId: "fs-ligado",
      resultSnapshot: expect.objectContaining({
        providerTeams: expect.objectContaining({ swapped: true }),
        identityResolution: expect.objectContaining({ source: "catalog_link" }),
      }),
    });
  });

  it("o jogo ligado com outros times que os da ligação não liquida", async () => {
    await seedCatalogLink(db.prisma, {
      pinnacleEventId: "1637000001", flashscoreMatchId: "fs-ligado", pinnacleHome: "Flamengo RJ", pinnacleAway: "Vasco da Gama RJ",
      flashscoreHome: "Flamengo", flashscoreAway: "Vasco", flashscoreHomeTeamId: "fs-fla", flashscoreAwayTeamId: "fs-vasco",
      swapped: false, kickoff: KICKOFF,
    });
    const bet = await apostaNoFlamengo();
    list.mockResolvedValue(jogo({ id: "fs-outro", score: 0 }, { id: "fs-fla", score: 2 }));

    await runFlashscoreObservationOnce(NOW);

    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { status: true } })).toEqual({ status: "PENDING" });
  });
});


it("consulta iniciada antes de reabrir é descartada; o ciclo seguinte lê a revisão nova", async () => {
  await seedCatalogLink(db.prisma, {
    pinnacleEventId: "1637000001", flashscoreMatchId: "fs-ligado", pinnacleHome: "Flamengo RJ", pinnacleAway: "Vasco da Gama RJ",
    flashscoreHome: "Flamengo", flashscoreAway: "Vasco", flashscoreHomeTeamId: "fs-fla", flashscoreAwayTeamId: "fs-vasco",
    swapped: false, kickoff: KICKOFF,
  });
  const bet = await apostaNoFlamengo();
  const response = jogo({ id: "fs-fla", score: 2 }, { id: "fs-vasco", score: 0 });
  list.mockImplementationOnce(async () => {
    await applyManualBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual:teste" });
    await applyManualBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual:teste" });
    return response;
  }).mockResolvedValue(response);
  expect(await runFlashscoreObservationOnce(NOW)).toMatchObject({ settled: 0, failures: 0 });
  expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "PENDING" });
  expect(await db.prisma.betResult.findUnique({ where: { betId: bet.id } })).toBeNull();
  expect(await runFlashscoreObservationOnce(NOW)).toMatchObject({ settled: 1, failures: 0 });
  expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "WON" });
});


it("parciais de outra partida não pagam; a observação nova retoma e credita uma vez", async () => {
  await seedCatalogLink(db.prisma, {
    pinnacleEventId: "1637000001", flashscoreMatchId: "fs-ligado", pinnacleHome: "Flamengo RJ", pinnacleAway: "Vasco da Gama RJ",
    flashscoreHome: "Flamengo", flashscoreAway: "Vasco", flashscoreHomeTeamId: "fs-fla", flashscoreAwayTeamId: "fs-vasco",
    swapped: false, kickoff: KICKOFF,
  });
  const created = await apostaNoFlamengo();
  const conta = await db.prisma.conta.create({ data: { casaDeAposta: "Betano", titular: "Teste", saldoInicial: 500, saldoAtual: 500 } });
  const bet = await db.prisma.bet.update({ where: { id: created.id }, data: {
    mercado: "Total – 1st Half", selecao: "Over 0.5", contaId: conta.id, casaDeAposta: "Betano", valorUnidade: 100,
  } });
  list.mockResolvedValue(jogo({ id: "fs-fla", score: 2 }, { id: "fs-vasco", score: 0 }));
  const body = {
    match_id: "outra-partida", sport: { sport_id: 1 },
    match_status: { stage: "Finished", is_started: true, is_finished: true, is_in_progress: false,
      is_cancelled: false, is_postponed: false, live_time: null, live_minute: null },
    scores: { home: 2, away: 0, home_total: 2, away_total: 0,
      home_1st_half: 1, away_1st_half: 0, home_2nd_half: 1, away_2nd_half: 0,
      home_extra_time: null, away_extra_time: null },
  };
  details.mockResolvedValue(body);
  expect(await runFlashscoreObservationOnce(NOW)).toMatchObject({ settled: 0, failures: 0 });
  expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "PENDING" });
  expect(await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } })).toMatchObject({ resultFinal: false });
  expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(500);

  details.mockResolvedValue({ ...body, match_id: "fs-ligado" });
  const retry = new Date(NOW.getTime() + 30 * 60_000);
  expect(await runFlashscoreObservationOnce(retry)).toMatchObject({ settled: 1, failures: 0 });
  expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "WON" });
  expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(600);
  expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(1);
  await runFlashscoreObservationOnce(new Date(retry.getTime() + 30 * 60_000));
  expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(1);
});
