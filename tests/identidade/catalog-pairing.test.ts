import { describe, expect, it } from "vitest";
import fixture from "../fixtures/catalog-pairing-20260925.json";
import { flashscoreDateResponseSchema, flattenFlashscoreMatches, type FlashscoreCatalogMatch } from "@/src/providers/flashscore/types";
import { normalizePinnacle17Events, type Pinnacle17Event } from "@/src/providers/pinnacle17/types";
import {
  catalogPairingSports,
  flashscoreDaysFor,
  flashscoreDaysOf,
  pairablePinnacleEvents,
  pairCatalogEvent,
  pairingWindow,
  pinnacleDaysOf,
  type CatalogDecision,
} from "@/src/services/teams/catalog-pairing";

/**
 * O pareamento com jogos da sonda de 25/09: a Pinnacle17 como ela lista o dia
 * UTC e o FlashScore como ele lista o dia de São Paulo, pelos normalizadores
 * dos clientes.
 */
const EVENTS = normalizePinnacle17Events(fixture.pinnacle17) ?? [];
const MATCHES = flattenFlashscoreMatches(flashscoreDateResponseSchema.parse(fixture.flashscore).groups);
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

function paired(decision: CatalogDecision) {
  if (decision.outcome !== "paired") throw new Error(`esperava par, veio ${decision.outcome}`);
  return decision.pair;
}

describe("par do evento da Pinnacle17 com o jogo do FlashScore", () => {
  it("liga o jogo certo entre os do dia e grava a ficha dos dois lados", () => {
    const pair = paired(pairCatalogEvent(event("Havelse vs Fortuna Koln"), MATCHES));
    expect(pair.match.match_id).toBe("IDXOLS2U");
    expect(pair.swapped).toBe(false);
    expect(pair.score).toBeGreaterThanOrEqual(1.5);
    expect(pair.cards).toEqual([
      expect.objectContaining({ flashscoreTeamId: pair.match.home_team.team_id, flashscoreName: "TSV Havelse",
        pinnacleName: "Havelse", pinnacleNameNorm: "havelse", category: "principal", pinnacleCategory: "principal",
        country: "Germany", leagueKey: "germany|3. liga" }),
      expect.objectContaining({ flashscoreTeamId: pair.match.away_team.team_id, pinnacleName: "Fortuna Koln",
        category: "principal" }),
    ]);
  });

  it("com o mando trocado no FlashScore, cada nome da Pinnacle17 vai para o time dele", () => {
    const original = match("IDXOLS2U");
    const inverted = match("IDXOLS2U", { home_team: original.away_team, away_team: original.home_team });
    const pair = paired(pairCatalogEvent(event("Havelse vs Fortuna Koln"), [inverted]));
    expect(pair.swapped).toBe(true);
    expect(pair.cards.map((side) => [side.flashscoreName, side.pinnacleName])).toEqual([
      ["Fortuna Koln", "Fortuna Koln"],
      ["TSV Havelse", "Havelse"],
    ]);
  });

  it("feminino e reserva pela liga da Pinnacle17 casam o time com W e com 2 do FlashScore, na categoria dele", () => {
    const women = paired(pairCatalogEvent(event("Bodo Glimt vs Roa IL"), MATCHES));
    expect(women.match.match_id).toBe("SYMZQvy9");
    expect(women.cards.map((side) => [side.flashscoreName, side.pinnacleName, side.category, side.pinnacleCategory])).toEqual([
      ["Bodo/Glimt W", "Bodo Glimt", "feminino", "feminino"],
      ["Roa W", "Roa IL", "feminino", "feminino"],
    ]);
    const reserves = paired(pairCatalogEvent(event("Colon de Santa Fe vs Union de Santa Fe"), MATCHES));
    expect(reserves.match.match_id).toBe("YDZz3eJE");
    expect(reserves.cards.map((side) => [side.flashscoreName, side.category, side.pinnacleCategory])).toEqual([
      ["Colon Santa Fe 2", "reserva", "reserva"],
      ["Union de Santa Fe 2", "reserva", "reserva"],
    ]);
  });

  it("o lado que só casou pela soma do par não ganha ficha", () => {
    // "Baladiyat El Mahalla" é o Baladiyyat Al Mehalla, mas o nome sozinho não prova.
    const pair = paired(pairCatalogEvent(event("Tersana vs Baladiyyat Al Mehalla"), MATCHES));
    expect(pair.match.match_id).toBe("jXEJ4p8F");
    expect(pair.cards.map((side) => side.pinnacleName)).toEqual(["Tersana"]);
  });

  it("a abreviação expandida do FlashScore liga o jogo e dá ficha", () => {
    // "I. Bratislava" e "A. Italiano" casam a palavra inteira com evidência 0,95.
    const bratislava = paired(pairCatalogEvent(event("Pohronie vs Inter Bratislava"), MATCHES));
    expect(bratislava.cards.map((side) => [side.pinnacleName, side.flashscoreName])).toEqual([
      ["Pohronie", "Pohronie"],
      ["Inter Bratislava", "I. Bratislava"],
    ]);
    const italiano = paired(pairCatalogEvent(event("Colo Colo vs Audax Italiano"), MATCHES));
    expect(italiano.match.match_id).toBe("0OPnB2V6");
    expect(italiano.cards.map((side) => side.flashscoreName)).toEqual(["Colo Colo", "A. Italiano"]);
  });

  it("jogo do FlashScore na janela com outros times não liga", () => {
    const havelse = event("Havelse vs Fortuna Koln");
    const otherGame = match("GOe1DccM", { timestamp: Date.parse(havelse.startTime) / 1_000 });
    expect(pairCatalogEvent(havelse, [otherGame]).outcome).toBe("weak");
  });

  it("sem jogo do FlashScore a até 15 min, nem adiado nem cancelado, não há candidato", () => {
    const havelse = event("Havelse vs Fortuna Koln");
    const kickoff = Date.parse(havelse.startTime);
    const late = match("IDXOLS2U", { timestamp: (kickoff + 16 * MIN) / 1_000 });
    expect(pairCatalogEvent(havelse, [late]).outcome).toBe("no_candidate");
    const onTime = match("IDXOLS2U", { timestamp: (kickoff + 15 * MIN) / 1_000 });
    expect(pairCatalogEvent(havelse, [onTime]).outcome).toBe("paired");
    for (const flag of ["is_postponed", "is_cancelled"] as const) {
      const off = match("IDXOLS2U", { match_status: { ...match("IDXOLS2U").match_status, [flag]: true } });
      expect(pairCatalogEvent(havelse, [off]).outcome, flag).toBe("no_candidate");
    }
  });

  it("duas partidas do FlashScore no mesmo horário com o mesmo nome empatam e nenhuma liga", () => {
    const twin = match("IDXOLS2U", { match_id: "twin0001" });
    expect(pairCatalogEvent(event("Havelse vs Fortuna Koln"), [match("IDXOLS2U"), twin]).outcome).toBe("ambiguous");
  });

  it("a folga de 0,3 é sobre qualquer jogo compatível na janela, mesmo o de nome fraco", () => {
    const havelse = match("IDXOLS2U");
    // Um lado igual e o outro parecido: compatível, abaixo de 1,5, mas a menos de 0,3 do melhor.
    const close = match("IDXOLS2U", { match_id: "close001", away_team: { ...havelse.away_team, team_id: "x", name: "Fortuna Koln II" } });
    const decision = pairCatalogEvent(event("Havelse vs Fortuna Koln"), [havelse, close]);
    expect(decision.outcome).toBe("paired");
    const same = match("IDXOLS2U", { match_id: "same0001", away_team: { ...havelse.away_team, team_id: "y", name: "SC Fortuna Koln" } });
    expect(pairCatalogEvent(event("Havelse vs Fortuna Koln"), [havelse, same]).outcome).toBe("ambiguous");

    // O melhor com 1,62 e o segundo com 1,39: o segundo nem passaria do piso de
    // 1,5, e contar só os que passam aceitaria o par. A folga é contra ele também.
    const south = event("Havelse vs Fortuna Koln", { awayTeam: { name: "Fortuna Koln Sud" } });
    const home = { ...havelse.home_team, name: "Havelse" };
    const north = match("IDXOLS2U", { match_id: "north001", home_team: home, away_team: { ...havelse.away_team, name: "Fortuna Koln Nord" } });
    const bonn = match("IDXOLS2U", { match_id: "bonn0001", home_team: home,
      away_team: { ...havelse.away_team, team_id: "z", name: "Fortuna Bonn" } });
    expect(paired(pairCatalogEvent(south, [north])).score).toBeCloseTo(1.62, 2);
    expect(pairCatalogEvent(south, [bonn]).outcome).toBe("weak");
    expect(pairCatalogEvent(south, [north, bonn]).outcome).toBe("ambiguous");
  });

  it("jogo de base fica de fora dos dois lados", () => {
    // A Pinnacle17 declara pela liga ("Friendlies U20").
    expect(pairCatalogEvent(event("Italy vs England"), MATCHES).outcome).toBe("base");
    // O FlashScore declara pelo nome: o jogo principal com os mesmos nomes não casa com o sub-19.
    const principal = event("France vs Italy", { league: { id: 1, name: "Friendlies", country: "World" } });
    expect(pairCatalogEvent(principal, [match("0jQlqmVI")]).outcome).toBe("no_candidate");
  });

  it("dois países da tabela diferentes recusam; grafia fora da tabela não conflita", () => {
    // A Pinnacle17 põe a Premiership da Irlanda do Norte em "Ireland".
    expect(pairCatalogEvent(event("Coleraine vs Linfield"), MATCHES).outcome).toBe("country");
    const russian = event("Havelse vs Fortuna Koln", { league: { id: 1, name: "3. Liga", country: "Russian Federation" } });
    const inRussia = match("IDXOLS2U", { tournament: { id: "r", name: "RUSSIA: FNL", countryName: "Russia" } });
    expect(pairCatalogEvent(russian, [inRussia]).outcome).toBe("paired");
  });

  it("a mesma macro-região dos dois lados liga clube e seleção; a tabela fixa só tira a ficha", () => {
    const havelse = event("Havelse vs Fortuna Koln");
    const cup = (league: string, country: string, tournament: string, tournamentCountry: string) =>
      pairCatalogEvent({ ...havelse, league: { id: 1, name: league, country } },
        [match("IDXOLS2U", { tournament: { id: "c", name: tournament, countryName: tournamentCountry } })]);
    const libertadores = cup("Copa Libertadores", "South America", "SOUTH AMERICA: Copa Libertadores", "South America");
    expect(paired(libertadores).cards.map((side) => [side.flashscoreName, side.country])).toEqual([
      ["TSV Havelse", ""], ["Fortuna Koln", ""],
    ]);
    expect(cup("UEFA Champions League", "Europe", "EUROPE: Champions League", "Europe").outcome).toBe("paired");
    expect(cup("Leagues Cup", "North America", "NORTH & CENTRAL AMERICA: Leagues Cup", "North & Central America").outcome)
      .toBe("paired");
    // Macro-regiões diferentes não conferem.
    expect(cup("Champions League", "Europe", "ASIA: AFC Champions League", "Asia").outcome).toBe("country");

    // Seleção fora da tabela liga pela região e fica com ficha; a da tabela, sem.
    const tanzania = paired(pairCatalogEvent(event("Tanzania vs Guinea-Bissau"), MATCHES));
    expect(tanzania.match.match_id).toBe("hbhUj0Pk");
    expect(tanzania.cards.map((side) => side.pinnacleName)).toEqual(["Tanzania", "Guinea-Bissau"]);
    const nations = paired(pairCatalogEvent(event("Italy vs Belgium"), MATCHES));
    expect(nations.match.match_id).toBe("tdpJ30MO");
    expect(nations.cards).toEqual([]);
  });

  it("na região, os dois lados precisam de evidência própria de 0,85", () => {
    const tersana = event("Tersana vs Baladiyyat Al Mehalla");
    const regional = { ...tersana, league: { ...tersana.league, country: "Africa" } };
    const inAfrica = match("jXEJ4p8F", { tournament: { id: "a", name: "AFRICA: CAF Confederation Cup", countryName: "Africa" } });
    expect(pairCatalogEvent(regional, [inAfrica]).outcome).toBe("weak");
  });

  it("região de um lado e país do outro, ou lugar indefinido, não ligam", () => {
    const havelse = event("Havelse vs Fortuna Koln");
    const withCountry = (country: string | null) => pairCatalogEvent({ ...havelse, league: { id: 1, name: "3. Liga", country } }, MATCHES);
    expect(withCountry("Europe").outcome).toBe("country");
    for (const country of ["Undefined", "Unknown", "Not specified", "Americas", "", null]) {
      expect(withCountry(country).outcome, String(country)).toBe("country");
    }
    const noCountry = match("IDXOLS2U", { tournament: { id: "x", name: "GERMANY: 3. Liga", countryName: null } });
    expect(pairCatalogEvent(havelse, [noCountry]).outcome).toBe("country");
  });

  it("no mundo, seleção liga e clube não (amistoso de pré-temporada)", () => {
    const friendly = event("Italy vs Belgium", { league: { id: 1, name: "Friendlies", country: "World" } });
    const international = match("tdpJ30MO", { tournament: { id: "w", name: "WORLD: Friendly International", countryName: "World" } });
    expect(paired(pairCatalogEvent(friendly, [international])).cards).toEqual([]);
    const clubs = event("Havelse vs Fortuna Koln", { league: { id: 1, name: "Club Friendlies", country: "World" } });
    const clubFriendly = match("IDXOLS2U", { tournament: { id: "w", name: "WORLD: Club Friendly", countryName: "World" } });
    expect(pairCatalogEvent(clubs, [clubFriendly]).outcome).toBe("country");
  });

  it("amistoso de clubes liga o jogo sem ensinar o time", () => {
    const friendly = event("Havelse vs Fortuna Koln", { league: { id: 1, name: "Club Friendlies", country: "Germany" } });
    const pair = paired(pairCatalogEvent(friendly, MATCHES));
    expect(pair.match.match_id).toBe("IDXOLS2U");
    expect(pair.cards).toEqual([]);
    const flashscoreFriendly = match("IDXOLS2U", { tournament: { id: "f", name: "WORLD: Club Friendly", countryName: "Germany" } });
    expect(paired(pairCatalogEvent(event("Havelse vs Fortuna Koln"), [flashscoreFriendly])).cards).toEqual([]);
  });
});

describe("eventos e catálogos da rodada", () => {
  it("a janela vai até o fim do dia de São Paulo ou 12 h à frente, o que for mais longe", () => {
    // 08:37 de São Paulo: o fim do dia está 15 h à frente.
    const morning = pairingWindow(new Date("2026-09-25T11:37:00Z"));
    expect(morning.end.toISOString()).toBe("2026-09-26T03:00:00.000Z");
    expect(pinnacleDaysOf(morning).map((day) => day.toISOString().slice(0, 10))).toEqual(["2026-09-25", "2026-09-26"]);
    // 20:37: a madrugada até as 08:37 do dia seguinte.
    const night = pairingWindow(new Date("2026-09-25T23:37:00Z"));
    expect(night.end.toISOString()).toBe("2026-09-26T11:37:00.000Z");
    expect(pinnacleDaysOf(night).map((day) => day.toISOString().slice(0, 10))).toEqual(["2026-09-25", "2026-09-26"]);
  });

  it("tenta só o que está na janela, ainda não começou e conta em tempo normal", () => {
    const havelse = event("Havelse vs Fortuna Koln");
    const window = pairingWindow(new Date("2026-09-25T23:37:00Z"));
    const dawn = { ...havelse, id: 4, startTime: "2026-09-26T05:00:00.000Z" }; // 02:00 de São Paulo
    const started = { ...havelse, id: 5, startTime: "2026-09-26T01:00:00.000Z",
      status: { isStarted: true, isInProgress: false, isInterrupted: false } };
    const corners = { ...dawn, id: 2, units: "Corners" };
    const past = havelse; // 17:00 UTC, antes de agora
    const afterWindow = { ...havelse, id: 3, startTime: "2026-09-26T12:00:00.000Z" };
    expect(pairablePinnacleEvents([dawn, dawn, started, corners, past, afterWindow], window).map((row) => row.id))
      .toEqual([4]);
  });

  it("perto da meia-noite o candidato vem também do catálogo do dia seguinte", () => {
    // 23:55 de São Paulo, e o FlashScore marca 00:05 do dia 26.
    const late = event("Havelse vs Fortuna Koln", { startTime: "2026-09-26T02:55:00.000Z" });
    expect(flashscoreDaysOf(late)).toEqual(["2026-09-25", "2026-09-26"]);
    expect(flashscoreDaysFor([late, event("Havelse vs Fortuna Koln")])).toEqual(["2026-09-25", "2026-09-26"]);
    expect(flashscoreDaysFor([event("Havelse vs Fortuna Koln")])).toEqual(["2026-09-25"]);
    const afterMidnight = match("IDXOLS2U", { timestamp: Date.parse("2026-09-26T03:05:00Z") / 1_000 });
    expect(paired(pairCatalogEvent(late, [afterMidnight])).match.match_id).toBe("IDXOLS2U");
  });

  it("futebol sempre; os outros coletivos da lista só com aposta recente; tênis e eSports nunca", () => {
    expect(catalogPairingSports([]).map((row) => row.sport)).toEqual(["Soccer"]);
    expect(catalogPairingSports(["Basketball", "Tennis", "eSports", "Handebol", "Baseball"]))
      .toEqual([
        { sport: "Soccer", pinnacleSportId: 29, flashscoreSportId: 1 },
        { sport: "Basketball", pinnacleSportId: 4, flashscoreSportId: 3 },
        { sport: "Handball", pinnacleSportId: 18, flashscoreSportId: 7 },
      ]);
  });
});
