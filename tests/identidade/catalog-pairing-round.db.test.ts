import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/catalog-pairing-20260925.json";
import { pgPool } from "@/src/infra/prisma";
import { flashscoreDateResponseSchema, flattenFlashscoreMatches, type FlashscoreCatalogMatch } from "@/src/providers/flashscore/types";
import { normalizePinnacle17Events, type Pinnacle17Event } from "@/src/providers/pinnacle17/types";
import { runCatalogPairingRound } from "@/src/services/teams/catalog-pairing-round";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@/src/services/ops/alerts", () => ({ raiseOperationalAlertOnce: vi.fn(async () => undefined) }));

/**
 * A rodada de `teams.catalog_pairing` com os fornecedores trocados por
 * funções: o que ela pede, em que ordem, e quando não pede nada.
 */

let db: TestDb;
beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
});

const EVENTS = normalizePinnacle17Events(fixture.pinnacle17) ?? [];
const MATCHES = flattenFlashscoreMatches(flashscoreDateResponseSchema.parse(fixture.flashscore).groups);
/** 09:00 de São Paulo de 25/09, antes de todos os jogos da fixture menos o das 09:30 UTC. */
const NOW = new Date("2026-09-25T12:00:00Z");

type Calls = { events: string[]; catalogs: string[] };

function providers(over: {
  now?: Date;
  events?: (sportId: number, day: string) => Pinnacle17Event[] | null;
  catalog?: (sportId: number, day: string) => FlashscoreCatalogMatch[] | null;
} = {}) {
  const calls: Calls = { events: [], catalogs: [] };
  return {
    calls,
    deps: {
      now: () => over.now ?? NOW,
      providersEnabled: () => true,
      fetchEvents: async ({ sportId, kickoffUtc }: { sportId: number; kickoffUtc: Date }) => {
        const day = kickoffUtc.toISOString().slice(0, 10);
        calls.events.push(`${sportId}:${day}`);
        const data = over.events ? over.events(sportId, day) : sportId === 29 && day === "2026-09-25" ? EVENTS : [];
        return data ? { data } : null;
      },
      fetchCatalog: async (day: string, sportId: number) => {
        calls.catalogs.push(`${sportId}:${day}`);
        return over.catalog ? over.catalog(sportId, day) : sportId === 1 && day === "2026-09-25" ? MATCHES : [];
      },
    },
  };
}

async function recentBet(esporte: string) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: `Canal ${esporte}`, slug: `canal-${esporte.toLowerCase()}`, valorUnidade: 100, capitalInicial: 100 },
  });
  await db.prisma.bet.create({
    data: {
      bankrollId: bankroll.id, data: new Date("2026-09-20T20:00:00Z"), evento: "Casa vs Fora", esporte,
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date("2026-09-20T12:00:00Z"),
      mercado: "Moneyline", selecao: "Casa", odds: 2, stake: 1, valorUnidade: 100,
    },
  });
}

describe("rodada do pareamento dos catálogos", () => {
  it("busca os dois dias UTC da Pinnacle17 e o dia de São Paulo do FlashScore, em série, e grava os pares", async () => {
    const { calls, deps } = providers();
    const round = await runCatalogPairingRound(deps);

    expect(calls).toEqual({ events: ["29:2026-09-25", "29:2026-09-26"], catalogs: ["1:2026-09-25"] });
    // O sub-20 das 09:30 UTC já começou; o sub-19 é base; Coleraine cai no país
    // (Ireland × Northern Ireland). Tersana liga com ficha de um lado só, Itália x
    // Bélgica sem ficha, Tanzânia x Guiné-Bissau pela região da África.
    expect(round).toMatchObject({
      day: "2026-09-25", until: "2026-09-26T03:00:00.000Z", stoppedBy: null, sports: 1, pinnacleEvents: 11,
      paired: 9, base: 1, weak: 0, country: 1, noCandidate: 0, ambiguous: 0, withoutCatalog: 0, conflicts: 0,
      newCards: 15,
    });
    expect((await db.prisma.catalogGameLink.findMany()).map((link) => link.flashscoreMatchId).sort()).toEqual([
      "0OPnB2V6", "GOe1DccM", "IDXOLS2U", "SYMZQvy9", "YDZz3eJE", "hbhUj0Pk", "jXEJ4p8F", "tCSQMwV8", "tdpJ30MO",
    ]);

    // A rodada seguinte não duplica nada.
    const again = await runCatalogPairingRound(providers().deps);
    expect(again).toMatchObject({ paired: 9, newCards: 0 });
    expect(await db.prisma.catalogGameLink.count()).toBe(9);
    expect(await db.prisma.teamCardEvidence.count()).toBe(15);
  });

  it("o jogo que a rodada liga ensina o nome do tipster que esperava por ele", async () => {
    const havelse = EVENTS.find((event) => event.name === "Havelse vs Fortuna Koln")!;
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Espera", slug: "espera", valorUnidade: 100 } });
    await db.prisma.bet.create({ data: {
      id: "bet-havelse", bankrollId: bankroll.id, data: new Date(havelse.startTime), evento: "Havelse vs Fortuna Koln",
      esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: NOW,
      mercado: "Moneyline", selecao: "Havelse", odds: 2, stake: 1, valorUnidade: 100,
      sharp: { create: { identityStatus: "MATCHED", provider: "pinnacle17", providerMatchId: String(havelse.id), confidence: 100 } },
    } });
    // A identidade automática veio antes da ligação: o nome ficou esperando.
    await db.prisma.teamTipsterNameWait.create({ data: {
      betId: "bet-havelse", pinnacleEventId: String(havelse.id), tipsterHome: "Die Havelser", tipsterAway: "Die Kolner",
      pinnacleHome: havelse.homeTeam.name, pinnacleAway: havelse.awayTeam.name, kickoff: new Date(havelse.startTime),
    } });

    const round = await runCatalogPairingRound(providers().deps);

    expect(round.delayedTipsterNames).toBe(1);
    expect(await db.prisma.teamTipsterName.findMany({ select: { name: true, status: true, firstBetId: true }, orderBy: { name: "asc" } }))
      .toEqual([
        { name: "Die Havelser", status: "pending", firstBetId: "bet-havelse" },
        { name: "Die Kolner", status: "pending", firstBetId: "bet-havelse" },
      ]);
    expect(await db.prisma.teamTipsterNameWait.count()).toBe(0);
  });

  it("a rodada da noite liga a madrugada, pedindo o catálogo do dia seguinte", async () => {
    const havelse = EVENTS.find((row) => row.name === "Havelse vs Fortuna Koln");
    const flashscore = MATCHES.find((row) => row.match_id === "IDXOLS2U");
    if (!havelse || !flashscore) throw new Error("fixture sem o Havelse");
    // 20:37 de São Paulo; jogo às 02:00 do dia 26, um às 09:00 (fora da janela) e um já começado.
    const dawn = { ...havelse, startTime: "2026-09-26T05:00:00.000Z" };
    const morning = { ...havelse, id: 900000010, startTime: "2026-09-26T12:00:00.000Z" };
    const night = providers({
      now: new Date("2026-09-25T23:37:00Z"),
      events: (sportId, day) => (sportId !== 29 ? [] : day === "2026-09-26" ? [dawn, morning] : EVENTS),
      catalog: (sportId, day) => (sportId === 1 && day === "2026-09-26"
        ? [{ ...flashscore, timestamp: Date.parse(dawn.startTime) / 1_000 }]
        : []),
    });
    const round = await runCatalogPairingRound(night.deps);

    expect(night.calls).toEqual({ events: ["29:2026-09-25", "29:2026-09-26"], catalogs: ["1:2026-09-26"] });
    expect(round).toMatchObject({ day: "2026-09-25", until: "2026-09-26T11:37:00.000Z", pinnacleEvents: 1, paired: 1 });
    expect(await db.prisma.catalogGameLink.findMany({ select: { pinnacleEventId: true, kickoffPinnacle: true } }))
      .toEqual([{ pinnacleEventId: String(havelse.id), kickoffPinnacle: new Date(dawn.startTime) }]);
  });

  it("catálogo vazio do FlashScore não pareia os eventos que dependem dele", async () => {
    const { deps } = providers({ catalog: () => [] });
    const round = await runCatalogPairingRound(deps);
    expect(round).toMatchObject({ stoppedBy: null, emptyCatalogs: 1, withoutCatalog: 11, paired: 0 });
    expect(await db.prisma.catalogGameLink.count()).toBe(0);
  });

  it("circuito aberto pula o fornecedor sem chamá-lo, e o resto da rodada", async () => {
    await db.prisma.providerCircuit.create({ data: { provider: "pinnacle17", state: "OPEN", failures: 5, openedAt: new Date() } });
    const pinnacle = providers();
    expect(await runCatalogPairingRound(pinnacle.deps))
      .toMatchObject({ stoppedBy: "breaker", stoppedAt: "pinnacle17", sportsSkippedBreaker: 1 });
    expect(pinnacle.calls).toEqual({ events: [], catalogs: [] });

    await db.prisma.providerCircuit.update({ where: { provider: "pinnacle17" }, data: { state: "CLOSED", openedAt: null } });
    await db.prisma.providerCircuit.create({ data: { provider: "flashscore", state: "OPEN", failures: 5, openedAt: new Date() } });
    const flashscore = providers();
    expect(await runCatalogPairingRound(flashscore.deps)).toMatchObject({ stoppedBy: "breaker", stoppedAt: "flashscore" });
    expect(flashscore.calls.catalogs).toEqual([]);
    expect(await db.prisma.catalogGameLink.count()).toBe(0);
  });

  it("com o gasto do dia acima de 60% do teto, não chama o fornecedor", async () => {
    await db.prisma.providerBudget.create({ data: { provider: "flashscore", periodKey: "2026-09-25", spent: 5_000, reserved: 800 } });
    const over = providers();
    expect(await runCatalogPairingRound(over.deps))
      .toMatchObject({ stoppedBy: "budget", stoppedAt: "flashscore", sportsSkippedBudget: 1 });
    expect(over.calls.catalogs).toEqual([]);

    // A janela do fornecedor já virou: o gasto antigo não conta.
    await db.prisma.providerBudget.update({
      where: { provider_periodKey: { provider: "flashscore", periodKey: "2026-09-25" } },
      data: { windowResetAt: new Date(NOW.getTime() - 60_000) },
    });
    expect(await runCatalogPairingRound(providers().deps)).toMatchObject({ stoppedBy: null, paired: 9 });
  });

  it("a primeira falha para a rodada: nada mais é pedido nem gravado", async () => {
    await recentBet("Basketball");
    const failing = providers({ events: (sportId, day) => (sportId === 29 && day === "2026-09-26" ? null : EVENTS) });
    const round = await runCatalogPairingRound(failing.deps);
    expect(round).toMatchObject({ sports: 2, stoppedBy: "failure", stoppedAt: "pinnacle17" });
    // Futebol vem primeiro; o basquete nem começa.
    expect(failing.calls).toEqual({ events: ["29:2026-09-25", "29:2026-09-26"], catalogs: [] });

    const thrown = providers({ catalog: () => { throw new Error("HTTP 500"); } });
    expect(await runCatalogPairingRound(thrown.deps)).toMatchObject({ stoppedBy: "failure", stoppedAt: "flashscore" });
    expect(thrown.calls.catalogs).toEqual(["1:2026-09-25"]);
    expect(await db.prisma.catalogGameLink.count()).toBe(0);
  });

  it("uma rodada por vez: com a trava tomada, não chama ninguém", async () => {
    const holder = await pgPool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended('teams.catalog_pairing', 0))");
      const locked = providers();
      expect(await runCatalogPairingRound(locked.deps)).toMatchObject({ stoppedBy: "locked" });
      expect(locked.calls).toEqual({ events: [], catalogs: [] });
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtextextended('teams.catalog_pairing', 0))");
      holder.release();
    }
    // Solta a trava, a rodada seguinte roda.
    expect(await runCatalogPairingRound(providers().deps)).toMatchObject({ stoppedBy: null, paired: 9 });
  });

  it("a métrica da rodada que parou é espera, não sucesso", async () => {
    const previous = process.env.OBSERVABILITY_METRICS_IN_TEST;
    process.env.OBSERVABILITY_METRICS_IN_TEST = "true";
    try {
      await runCatalogPairingRound(providers({ events: () => null }).deps);
      await runCatalogPairingRound(providers().deps);
    } finally {
      if (previous === undefined) delete process.env.OBSERVABILITY_METRICS_IN_TEST;
      else process.env.OBSERVABILITY_METRICS_IN_TEST = previous;
    }
    const rows = await db.prisma.operationalMetric.findMany({
      where: { kind: "action", name: "teams.catalog_pairing" }, orderBy: { occurredAt: "asc" },
    });
    expect(rows.map((row) => [row.outcome, (row.labels as { stoppedBy: string | null }).stoppedBy])).toEqual([
      ["expected_retry", "failure"],
      ["success", null],
    ]);
  });

  it("sem os dois fornecedores ligados, não faz nada", async () => {
    const off = providers();
    expect(await runCatalogPairingRound({ ...off.deps, providersEnabled: () => false })).toMatchObject({ stoppedBy: "disabled" });
    expect(off.calls).toEqual({ events: [], catalogs: [] });
  });
});
