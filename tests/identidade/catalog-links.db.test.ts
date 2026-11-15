import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fixture from "../fixtures/catalog-pairing-20260925.json";
import { flashscoreDateResponseSchema, flattenFlashscoreMatches, type FlashscoreCatalogMatch } from "@/src/providers/flashscore/types";
import { normalizePinnacle17Events, type Pinnacle17Event } from "@/src/providers/pinnacle17/types";
import {
  findUsableCatalogLink,
  purgeOldCatalogGameLinks,
  readCatalogDay,
  saveCatalogRound,
  type SeenCatalogEvent,
} from "@/src/services/teams/catalog-links";
import { pairCatalogEvent, type CatalogPair } from "@/src/services/teams/catalog-pairing";
import { createTestDb, type TestDb } from "../helpers/db";

/** A gravação do pareamento dos catálogos no Postgres real: ligação, ficha e evidência. */

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
const DAY = { start: new Date("2026-09-25T03:00:00Z"), end: new Date("2026-09-26T03:00:00Z") };
const ROUND_1 = new Date("2026-09-25T11:37:00Z");
const ROUND_2 = new Date("2026-09-25T15:37:00Z");
const MIN = 60_000;

function event(name: string, over: Partial<Pinnacle17Event> = {}): Pinnacle17Event {
  const found = EVENTS.find((row) => row.name === name);
  if (!found) throw new Error(`evento fora da fixture: ${name}`);
  return { ...found, ...over };
}

function match(id: string, over: Partial<FlashscoreCatalogMatch> = {}): FlashscoreCatalogMatch {
  const found = MATCHES.find((row) => row.match_id === id);
  if (!found) throw new Error(`partida fora da fixture: ${id}`);
  return { ...found, ...over };
}

function pairOf(pinnacle: Pinnacle17Event, matches: readonly FlashscoreCatalogMatch[] = MATCHES): CatalogPair {
  const decision = pairCatalogEvent(pinnacle, matches);
  if (decision.outcome !== "paired") throw new Error(`esperava par, veio ${decision.outcome}`);
  return decision.pair;
}

function save(pairs: CatalogPair[], now: Date, seen: SeenCatalogEvent[] = [], kickoffs = new Map<string, Date>()) {
  return saveCatalogRound({ sport: "Soccer", pairs, seen, flashscoreKickoffs: kickoffs, now });
}

const HAVELSE = event("Havelse vs Fortuna Koln");

describe("ligação do jogo", () => {
  it("a rodada repetida não duplica ligação, ficha nem evidência", async () => {
    const pairs = [pairOf(HAVELSE), pairOf(event("Bodo Glimt vs Roa IL"))];
    const first = await save(pairs, ROUND_1);
    const second = await save(pairs, ROUND_2);

    expect(first).toEqual({ conflicts: 0, moved: 0, newCards: 4, divergences: [] });
    expect(second).toEqual({ conflicts: 0, moved: 0, newCards: 0, divergences: [] });
    // Bodø às 16:00 UTC, Havelse às 17:00.
    const links = await db.prisma.catalogGameLink.findMany({ orderBy: { kickoffPinnacle: "asc" } });
    expect(links).toEqual([
      expect.objectContaining({ flashscoreMatchId: "SYMZQvy9", status: "ok" }),
      expect.objectContaining({ pinnacleEventId: String(HAVELSE.id), flashscoreMatchId: "IDXOLS2U", status: "ok",
        decidedBy: "catalog", sport: "Soccer", pinnacleHome: "Havelse", flashscoreHome: "TSV Havelse", swapped: false,
        pinnacleCountry: "Germany", flashscoreCountry: "Germany", flashscoreTournament: "GERMANY: 3. Liga",
        kickoffPinnacle: new Date(HAVELSE.startTime), kickoffFlashscore: new Date(match("IDXOLS2U").timestamp * 1_000),
        firstSeenAt: ROUND_1, lastSeenAt: ROUND_2, lastPairedAt: ROUND_2, moved: false, conflictFlashscoreMatchId: null }),
    ]);
    expect(links[1]?.score.toNumber()).toBeCloseTo(pairs[0]?.score ?? 0, 4);
    const cards = await db.prisma.teamCard.findMany({ include: { evidence: true }, orderBy: { flashscoreName: "asc" } });
    expect(cards.map((card) => [card.flashscoreName, card.category, card.country, card.evidence.length])).toEqual([
      ["Bodo/Glimt W", "feminino", "Norway", 1],
      ["Fortuna Koln", "principal", "Germany", 1],
      ["Roa W", "feminino", "Norway", 1],
      ["TSV Havelse", "principal", "Germany", 1],
    ]);
    expect(cards[3]).toMatchObject({ firstSeenAt: ROUND_1, lastSeenAt: ROUND_2 });
    expect(cards[3]?.evidence[0]).toMatchObject({ pinnacleEventId: String(HAVELSE.id), pinnacleName: "Havelse",
      nameNorm: "havelse", category: "principal", leagueKey: "germany|3. liga" });
  });

  it("outro jogo do FlashScore para o mesmo evento vira conflito e não troca o gravado", async () => {
    await save([pairOf(HAVELSE)], ROUND_1);
    const other = match("IDXOLS2U", { match_id: "other001",
      home_team: { team_id: "otherHome", name: "Havelse" }, away_team: { team_id: "otherAway", name: "Fortuna Koln" } });
    const write = await save([pairOf(HAVELSE, [other])], ROUND_2);

    expect(write.conflicts).toBe(1);
    expect(await db.prisma.catalogGameLink.findUniqueOrThrow({ where: { pinnacleEventId: String(HAVELSE.id) } }))
      .toMatchObject({ flashscoreMatchId: "IDXOLS2U", status: "conflict", conflictFlashscoreMatchId: "other001",
        flashscoreHomeTeamId: match("IDXOLS2U").home_team.team_id, lastSeenAt: ROUND_2, lastPairedAt: ROUND_1 });
    // O par contestado não ensina time.
    expect(await db.prisma.teamCard.count({ where: { flashscoreTeamId: { in: ["otherHome", "otherAway"] } } })).toBe(0);

    // Voltar ao jogo gravado não desfaz o conflito sozinho, e o conflito que
    // continua não conta de novo: a contagem é da virada de `ok` para `conflict`.
    const back = await save([pairOf(HAVELSE)], new Date(ROUND_2.getTime() + 60 * MIN));
    expect(back.conflicts).toBe(0);
    expect(await db.prisma.catalogGameLink.findUniqueOrThrow({ where: { pinnacleEventId: String(HAVELSE.id) } }))
      .toMatchObject({ flashscoreMatchId: "IDXOLS2U", status: "conflict" });
    expect((await save([pairOf(HAVELSE, [other])], new Date(ROUND_2.getTime() + 120 * MIN))).conflicts).toBe(0);
  });

  it("marca o jogo que mudou de horário mais de 15 min, pareado ou só visto", async () => {
    await save([pairOf(HAVELSE)], ROUND_1);
    const tenLater = new Date(Date.parse(HAVELSE.startTime) + 10 * MIN);
    const tenMinutes = await save([pairOf({ ...HAVELSE, startTime: tenLater.toISOString() })], ROUND_2);
    expect(tenMinutes.moved).toBe(0);
    const link = () => db.prisma.catalogGameLink.findUniqueOrThrow({ where: { pinnacleEventId: String(HAVELSE.id) } });
    expect(await link()).toMatchObject({ moved: false, kickoffPinnacle: tenLater });

    // Na rodada seguinte o evento não pareou (sem o FlashScore na janela), mas foi visto 30 min depois.
    const later = new Date(Date.parse(HAVELSE.startTime) + 40 * MIN);
    const seenOnly = await save([], new Date(ROUND_2.getTime() + 60 * MIN),
      [{ pinnacleEventId: String(HAVELSE.id), kickoffPinnacle: later }]);
    expect(seenOnly.moved).toBe(1);
    expect(await link()).toMatchObject({ moved: true, kickoffPinnacle: later, lastPairedAt: ROUND_2 });

    // Pareado de novo com as duas fontes 20 min depois: conta uma vez, na rodada em que mudou.
    const colon = event("Colon de Santa Fe vs Union de Santa Fe");
    await save([pairOf(colon)], ROUND_1);
    const shift = (at: number) => at + 20 * MIN;
    const shifted = pairOf({ ...colon, startTime: new Date(shift(Date.parse(colon.startTime))).toISOString() },
      [match("YDZz3eJE", { timestamp: shift(match("YDZz3eJE").timestamp * 1_000) / 1_000 })]);
    expect((await save([shifted], ROUND_2)).moved).toBe(1);
    expect((await save([shifted], new Date(ROUND_2.getTime() + MIN))).moved).toBe(0);
    expect(await db.prisma.catalogGameLink.findUniqueOrThrow({ where: { pinnacleEventId: String(colon.id) } }))
      .toMatchObject({ moved: true, status: "ok" });

    // O FlashScore que muda o horário do jogo gravado também conta.
    const bodo = event("Bodo Glimt vs Roa IL");
    await save([pairOf(bodo)], ROUND_1);
    const moved = new Date((match("SYMZQvy9").timestamp * 1_000) + 20 * MIN);
    const write = await save([], ROUND_2, [{ pinnacleEventId: String(bodo.id), kickoffPinnacle: new Date(bodo.startTime) }],
      new Map([["SYMZQvy9", moved]]));
    expect(write.moved).toBe(1);
    expect(await db.prisma.catalogGameLink.findUniqueOrThrow({ where: { pinnacleEventId: String(bodo.id) } }))
      .toMatchObject({ moved: true, kickoffFlashscore: moved });
  });

  it("jogo do FlashScore com dois eventos da Pinnacle17: grava os dois, não ensina time e a leitura descarta", async () => {
    const twin = { ...HAVELSE, id: 900000001, name: "Havelse vs Fortuna Koeln", awayTeam: { name: "Fortuna Koeln" } };
    const write = await save([pairOf(HAVELSE), pairOf(twin), pairOf(event("Bodo Glimt vs Roa IL"))], ROUND_1);

    expect(await db.prisma.catalogGameLink.count({ where: { flashscoreMatchId: "IDXOLS2U", status: "ok" } })).toBe(2);
    expect(write.newCards).toBe(2);
    expect((await db.prisma.teamCard.findMany()).map((card) => card.flashscoreName).sort()).toEqual(["Bodo/Glimt W", "Roa W"]);
    expect(await readCatalogDay(DAY)).toEqual({ linkedGames: 1, teamCards: 2, newTeamCards: 2 });
  });
});

describe("ficha do time", () => {
  it("avisa quando o id do FlashScore ganha um nome da Pinnacle17 que não se parece com os anteriores", async () => {
    await save([pairOf(HAVELSE)], ROUND_1);
    // Outro jogo do mesmo time: no mesmo jogo do FlashScore seria dobro, que não ensina time.
    const base = pairOf({ ...HAVELSE, id: 900000002 }, [match("IDXOLS2U", { match_id: "next0002" })]);
    const renamed: CatalogPair = {
      ...base,
      cards: base.cards.map((side) => side.flashscoreName === "TSV Havelse"
        ? { ...side, pinnacleName: "Inter Toronto", pinnacleNameNorm: "inter toronto" }
        : side),
    };
    const write = await save([renamed], ROUND_2);
    expect(write.divergences).toEqual([expect.objectContaining({
      sport: "Soccer", flashscoreName: "TSV Havelse", pinnacleName: "Inter Toronto", previousNames: ["Havelse"],
      pinnacleEventId: "900000002",
    })]);
    // O nome fica gravado: o aviso não bloqueia.
    expect(await db.prisma.teamCardEvidence.count({ where: { nameNorm: "inter toronto" } })).toBe(1);

    const similar: CatalogPair = {
      ...base,
      event: { ...base.event, id: 900000003 },
      match: { ...base.match, match_id: "next0003" },
      cards: base.cards.map((side) => ({ ...side, pinnacleName: `TSV ${side.pinnacleName}`, pinnacleNameNorm: `tsv ${side.pinnacleNameNorm}` })),
    };
    expect((await save([similar], ROUND_2)).divergences).toEqual([]);
  });

  it("conta os jogos de um nome pelas evidências, uma por evento", async () => {
    const other = { ...HAVELSE, id: 900000004 };
    await save([pairOf(HAVELSE)], ROUND_1);
    await save([pairOf(HAVELSE), pairOf(other, [match("IDXOLS2U", { match_id: "next0001" })])], ROUND_2);
    const card = await db.prisma.teamCard.findFirstOrThrow({ where: { flashscoreName: "TSV Havelse" }, include: { evidence: true } });
    expect(card.evidence.map((row) => row.pinnacleEventId).sort()).toEqual([String(HAVELSE.id), "900000004"]);
  });
  it("a ficha que ganha o país leva junto os nomes do tipster; o já confirmado noutra ficha do país volta a pendente", async () => {
    const pair = pairOf(HAVELSE);
    const continental: CatalogPair = { ...pair, cards: pair.cards.map((side) => ({ ...side, country: "" })) };
    await save([continental], ROUND_1);
    const card = await db.prisma.teamCard.findFirstOrThrow({ where: { flashscoreName: "TSV Havelse" } });
    expect(card.country).toBe("");
    const country = pair.cards.find((side) => side.flashscoreName === "TSV Havelse")!.country;
    expect(country).not.toBe("");
    const other = await db.prisma.teamCard.create({ data: {
      sport: "Soccer", flashscoreTeamId: "outro", flashscoreName: "Outro", country, category: card.category, lastSeenAt: ROUND_1,
    } });
    const name = (cardId: string, nameNorm: string, status: string, scope: string) => ({
      cardId, sport: "Soccer", country: scope, category: card.category, name: nameNorm, nameNorm, status,
      firstBetId: "b", firstPinnacleEventId: "e", firstDay: "2026-09-25",
      ...(status === "confirmed" ? { confirmedAt: ROUND_1, confirmedByBetId: "b" } : {}),
    });
    await db.prisma.teamTipsterName.createMany({ data: [
      name(card.id, "havelse", "confirmed", ""), name(card.id, "tsv", "confirmed", ""), name(card.id, "hav", "pending", ""),
      name(other.id, "tsv", "confirmed", country),
    ] });

    await save([pair], ROUND_2);

    expect((await db.prisma.teamCard.findUniqueOrThrow({ where: { id: card.id } })).country).toBe(country);
    const names = await db.prisma.teamTipsterName.findMany({ where: { cardId: card.id }, orderBy: { nameNorm: "asc" } });
    expect(names.map((row) => [row.nameNorm, row.country, row.status, row.confirmedAt !== null])).toEqual([
      ["hav", country, "pending", false], ["havelse", country, "confirmed", true], ["tsv", country, "pending", false],
    ]);
    expect(await db.prisma.teamTipsterName.findFirstOrThrow({ where: { cardId: other.id } })).toMatchObject({ status: "confirmed" });
    const audit = await db.prisma.auditEvent.findMany({ where: { action: "team_tipster_name.conflict", resourceId: card.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ nameNorm: "tsv", confirmedCardId: other.id, country });

    // A rodada seguinte não tem mais o que mover nem registrar.
    await save([pair], new Date(ROUND_2.getTime() + 60_000));
    expect(await db.prisma.auditEvent.count({ where: { action: "team_tipster_name.conflict" } })).toBe(1);
  });
});

describe("leitura e retenção", () => {
  it("o dia conta jogos ok 1:1 pelo início e fichas pela primeira vez vistas", async () => {
    await save([pairOf(HAVELSE)], new Date("2026-09-24T12:00:00Z"));
    await save([pairOf(event("Bodo Glimt vs Roa IL"))], ROUND_1);
    // Conflito não conta.
    const other = match("SYMZQvy9", { match_id: "other002" });
    await save([pairOf(event("Bodo Glimt vs Roa IL"), [other])], ROUND_2);

    expect(await readCatalogDay(DAY)).toEqual({ linkedGames: 1, teamCards: 4, newTeamCards: 2 });
    const previousDay = { start: new Date("2026-09-24T03:00:00Z"), end: DAY.start };
    expect(await readCatalogDay(previousDay)).toEqual({ linkedGames: 0, teamCards: 2, newTeamCards: 2 });
  });

  it("a ligação sai 90 dias depois do jogo; fichas e evidências ficam", async () => {
    await save([pairOf(HAVELSE)], ROUND_1);
    const kickoff = Date.parse(HAVELSE.startTime);
    expect(await purgeOldCatalogGameLinks(new Date(kickoff + 89 * 86_400_000))).toBe(0);
    expect(await purgeOldCatalogGameLinks(new Date(kickoff + 91 * 86_400_000))).toBe(1);
    expect(await db.prisma.catalogGameLink.count()).toBe(0);
    expect(await db.prisma.teamCard.count()).toBe(2);
    expect(await db.prisma.teamCardEvidence.count()).toBe(2);
  });
});

describe("o que a liquidação e o aprendizado leem", () => {
  it("a ligação usável é a ok e 1:1, com o mando que o par gravou", async () => {
    const pair = pairOf(HAVELSE);
    await save([pair], ROUND_1);
    await expect(findUsableCatalogLink(String(HAVELSE.id))).resolves.toMatchObject({
      sport: "Soccer", flashscoreMatchId: pair.match.match_id, swapped: pair.swapped,
      pinnacleHome: HAVELSE.homeTeam.name, pinnacleAway: HAVELSE.awayTeam.name,
    });
    await expect(findUsableCatalogLink("evento-sem-ligacao")).resolves.toBeNull();

    // Outro evento no mesmo jogo do FlashScore: nenhum dos dois vale.
    const twin = { ...HAVELSE, id: 900000099 };
    await save([pairOf(twin)], ROUND_2);
    await expect(findUsableCatalogLink(String(HAVELSE.id))).resolves.toBeNull();
    await expect(findUsableCatalogLink("900000099")).resolves.toBeNull();
  });

  it("o mesmo jogo pareado de novo com o mando invertido no FlashScore atualiza mando, times e ids", async () => {
    const pair = pairOf(HAVELSE);
    await save([pair], ROUND_1);
    const original = match(pair.match.match_id);
    const invertido = { ...original, home_team: original.away_team, away_team: original.home_team };
    const repaired = pairOf(HAVELSE, [invertido]);
    expect(repaired.swapped).toBe(!pair.swapped);
    await save([repaired], ROUND_2);
    await expect(findUsableCatalogLink(String(HAVELSE.id))).resolves.toMatchObject({
      swapped: !pair.swapped,
      flashscoreHomeTeamId: original.away_team.team_id,
      flashscoreAwayTeamId: original.home_team.team_id,
    });
    expect(await db.prisma.catalogGameLink.findUniqueOrThrow({ where: { pinnacleEventId: String(HAVELSE.id) } }))
      .toMatchObject({ flashscoreHome: original.away_team.name, flashscoreAway: original.home_team.name, status: "ok" });
  });

  it("a ligação em conflito não vale", async () => {
    await save([pairOf(event("Bodo Glimt vs Roa IL"))], ROUND_1);
    const bodo = event("Bodo Glimt vs Roa IL");
    await save([pairOf(bodo, [match("SYMZQvy9", { match_id: "other002" })])], ROUND_2);
    await expect(findUsableCatalogLink(String(bodo.id))).resolves.toBeNull();
  });

  it("a ficha guarda o nome do FlashScore normalizado, e a rodada preenche o das fichas antigas", async () => {
    await save([pairOf(HAVELSE)], ROUND_1);
    const havelse = await db.prisma.teamCard.findFirstOrThrow({ where: { flashscoreName: "TSV Havelse" } });
    expect(havelse.flashscoreNameNorm).toBe("tsv havelse");

    const old = await db.prisma.teamCard.create({ data: {
      sport: "Soccer", flashscoreTeamId: "antiga", flashscoreName: "Hamburger SV II", category: "reserva", lastSeenAt: ROUND_1,
    } });
    expect(old.flashscoreNameNorm).toBe("");
    await save([pairOf(event("Bodo Glimt vs Roa IL"))], ROUND_2);
    expect((await db.prisma.teamCard.findUniqueOrThrow({ where: { id: old.id } })).flashscoreNameNorm).not.toBe("");
  });
});
