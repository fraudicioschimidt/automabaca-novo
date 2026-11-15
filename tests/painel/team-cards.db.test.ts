import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeTeamName } from "@/src/domain/text-normalization";
import { listTeamCards, TEAM_CARDS_PAGE_SIZE } from "@/src/services/painel/team-cards";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Config › Times lê as fichas do pareamento dos catálogos: cada ficha com os
 * nomes distintos da Pinnacle17 (quantos jogos cada um), o do FlashScore e os
 * dos tipsters, e a busca acha a ficha por qualquer um deles.
 */
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
beforeEach(async () => { await db.reset(); });
afterAll(async () => { await db.dispose(); });

const day = (n: number) => new Date(Date.UTC(2026, 8, n, 18));

function card(flashscoreTeamId: string, flashscoreName: string, data: { sport?: string; country?: string; category?: string; lastSeenAt?: Date } = {}) {
  return db.prisma.teamCard.create({ data: {
    sport: data.sport ?? "Soccer", flashscoreTeamId, flashscoreName, country: data.country ?? "",
    category: data.category ?? "principal", lastSeenAt: data.lastSeenAt ?? day(20),
  } });
}

function evidence(cardId: string, pinnacleEventId: string, pinnacleName: string, createdAt: Date, leagueKey = "uruguay|segunda division") {
  return db.prisma.teamCardEvidence.create({ data: {
    cardId, pinnacleEventId, pinnacleName, nameNorm: canonicalizeTeamName(pinnacleName), category: "principal", leagueKey, createdAt,
  } });
}

function tipsterName(cardId: string, name: string, status: "pending" | "confirmed", createdAt: Date) {
  return db.prisma.teamTipsterName.create({ data: {
    cardId, sport: "Soccer", name, nameNorm: canonicalizeTeamName(name), status, firstBetId: `bet-${name}`, firstDay: "2026-09-10", category: "principal", firstPinnacleEventId: `p17-${name}`,
    createdAt, ...(status === "confirmed" ? { confirmedAt: createdAt } : {}),
  } });
}

/** A ligação do jogo guarda a liga e o país como a Pinnacle17 escreve. */
function link(pinnacleEventId: string, pinnacleLeague: string, pinnacleCountry: string) {
  return db.prisma.catalogGameLink.create({ data: {
    sport: "Soccer", pinnacleEventId, flashscoreMatchId: `fs-${pinnacleEventId}`, kickoffPinnacle: day(10), kickoffFlashscore: day(10),
    pinnacleHome: "A", pinnacleAway: "B", pinnacleLeague, pinnacleCountry, flashscoreHome: "A", flashscoreAway: "B",
    flashscoreHomeTeamId: "fa", flashscoreAwayTeamId: "fb", swapped: false, score: 1.9, lastSeenAt: day(10), lastPairedAt: day(10),
  } });
}

async function seedFenix() {
  const fenix = await card("8hWKNqzL", "Fénix", { country: "Uruguay" });
  await evidence(fenix.id, "p1", "Fenix", day(1));
  await evidence(fenix.id, "p2", "Fenix", day(2));
  await evidence(fenix.id, "p3", "Atletico Fenix", day(3));
  await link("p3", "Segunda División", "Uruguay");
  await tipsterName(fenix.id, "Fenix MVD", "pending", day(4));
  await tipsterName(fenix.id, "Fénix Montevidéu", "confirmed", day(5));
  return fenix;
}

describe("listTeamCards", () => {
  it("agrupa os nomes da Pinnacle17 por jogo, o mais recente primeiro, com a liga do último jogo", async () => {
    const fenix = await seedFenix();

    const page = await listTeamCards();

    expect(page.cards).toEqual([{
      id: fenix.id,
      sport: "Soccer",
      name: "Atletico Fenix",
      country: "Uruguay",
      league: "Segunda División",
      category: "principal",
      flashscoreTeamId: "8hWKNqzL",
      flashscoreName: "Fénix",
      pinnacleNames: [{ name: "Atletico Fenix", games: 1 }, { name: "Fenix", games: 2 }],
      // Confirmado antes do pendente, mesmo tendo aparecido depois.
      tipsterNames: [
        { id: expect.any(String), name: "Fénix Montevidéu", confirmed: true },
        { id: expect.any(String), name: "Fenix MVD", confirmed: false },
      ],
    }]);
    expect(page).toMatchObject({ total: 1, nextOffset: null, sports: [{ sport: "Soccer", count: 1 }] });
  });

  it("sem a ligação do jogo, a liga e o país saem da chave da evidência; sem jogo, o nome é o do FlashScore", async () => {
    const reserva = await card("rsv1", "Nacional II", { category: "reserva", lastSeenAt: day(21) });
    await evidence(reserva.id, "p9", "Nacional Reserves", day(6), "uruguay|primera division reserves");
    await card("solo", "Sem Jogo", { lastSeenAt: day(19) });

    const [withKey, withoutGames] = (await listTeamCards()).cards;

    expect(withKey).toMatchObject({ name: "Nacional Reserves", country: "uruguay", league: "primera division reserves", category: "reserva" });
    expect(withoutGames).toMatchObject({ name: "Sem Jogo", country: "", league: "", pinnacleNames: [], tipsterNames: [] });
  });

  it.each([
    ["nome de tipster", "montevideu"],
    ["nome de tipster pendente", "MVD"],
    ["nome do FlashScore, com acento", "fénix"],
    ["nome da Pinnacle17", "atletico"],
    ["id do FlashScore", "8hWKNqzL"],
  ])("acha a ficha pelo %s", async (_, query) => {
    await seedFenix();
    const other = await card("zz1", "Penarol");
    await evidence(other.id, "p20", "Penarol", day(3));

    const page = await listTeamCards({ query });

    expect(page.cards.map((row) => row.flashscoreTeamId)).toEqual(["8hWKNqzL"]);
    expect(page.total).toBe(1);
  });

  it("busca sem resultado devolve a lista vazia, e o filtro de esporte conta todos os esportes", async () => {
    await seedFenix();
    await card("bk1", "Flamengo", { sport: "Basketball" });

    expect(await listTeamCards({ query: "inexistente" })).toMatchObject({ cards: [], total: 0, nextOffset: null });
    const basketball = await listTeamCards({ sport: "Basketball", query: "" });
    expect(basketball.cards.map((row) => row.flashscoreName)).toEqual(["Flamengo"]);
    expect(basketball.sports).toEqual([{ sport: "Basketball", count: 1 }, { sport: "Soccer", count: 1 }]);
  });

  it("pagina pelas fichas vistas mais recentemente, sem repetir nem pular", async () => {
    const total = TEAM_CARDS_PAGE_SIZE + 5;
    for (let n = 0; n < total; n += 1) {
      await card(`t${n}`, `Time ${n}`, { lastSeenAt: new Date(day(1).getTime() + n * 60_000) });
    }

    const first = await listTeamCards();
    expect(first.cards).toHaveLength(TEAM_CARDS_PAGE_SIZE);
    expect(first.cards[0]!.flashscoreTeamId).toBe(`t${total - 1}`);
    expect(first).toMatchObject({ total, nextOffset: TEAM_CARDS_PAGE_SIZE });

    const second = await listTeamCards({ offset: first.nextOffset! });
    expect(second.cards).toHaveLength(5);
    expect(second.nextOffset).toBeNull();
    const ids = new Set([...first.cards, ...second.cards].map((row) => row.id));
    expect(ids.size).toBe(total);
  });
});
