import { describe, expect, it } from "vitest";
import { isBaseCategoryFixture } from "@/src/domain/team-category";
import {
  betDeclaresCategoryFixtureLacks,
  canonicalizeTeamName,
  hasProtectedTeamCategoryConflict,
  markSoccerReserveTeams,
  refineCategoryCandidates,
  sameTeamCategory,
  teamCategoryConflictInContext,
  teamCategoryInContext,
  teamSimilarity,
} from "@/src/domain/text";

/**
 * Time reserva cujo nome não usa o vocabulário da categoria. Antes, "Jong Ajax"
 * × "Ajax" e "Real Madrid Castilla" × "Real Madrid" davam 0,90 sem conflito, e
 * "(Am)" era cortado como sufixo de país: o reserva casava o principal.
 */
describe("time reserva com nome próprio", () => {
  const RESERVA_E_PRINCIPAL: ReadonlyArray<readonly [string, string]> = [
    ["Jong Ajax", "Ajax"],
    ["Jong PSV", "PSV"],
    ["Real Madrid Castilla", "Real Madrid"],
    ["Celta Fortuna", "Celta Vigo"],
    ["Bilbao Athletic", "Athletic Bilbao"],
    ["Juventus Next Gen", "Juventus"],
    ["Milan Futuro", "AC Milan"],
    ["Austria Vienna (Am)", "Austria Vienna"],
    ["LASK (Am)", "LASK"],
  ];

  it.each(RESERVA_E_PRINCIPAL)("%s não é o %s", (reserva, principal) => {
    expect(hasProtectedTeamCategoryConflict(reserva, principal)).toBe(true);
    expect(teamSimilarity(reserva, principal)).toBeLessThan(0.5);
  });

  /** A grafia de cada feed para o MESMO time reserva continua casando. */
  it.each([
    ["Jong Ajax", "Ajax II"],
    ["Real Madrid Castilla", "Real Madrid B"],
    ["Celta Fortuna", "Celta Vigo B"],
    ["Bilbao Athletic", "Ath Bilbao B"],
    ["Juventus Next Gen", "Juventus U23"],
    ["Milan Futuro", "AC Milan U23"],
    ["Austria Vienna (Am)", "Austria Vienna Amateure"],
  ] as const)("%s é o %s", (umFeed, outroFeed) => {
    expect(hasProtectedTeamCategoryConflict(umFeed, outroFeed)).toBe(false);
    expect(teamSimilarity(umFeed, outroFeed)).toBeGreaterThanOrEqual(0.85);
  });

  /** A palavra só é reserva na forma do time reserva. */
  it.each([
    ["Fortuna Düsseldorf", "Fortuna Dusseldorf"],
    ["Futuro Kings", "Futuro Kings FC"],
    ["Castilla", "CD Castilla"],
    ["Nacional (AM)", "Nacional AM"],
    ["Jong S.", "S. Jong"],
  ] as const)("%s continua sendo %s", (umaGrafia, outraGrafia) => {
    expect(hasProtectedTeamCategoryConflict(umaGrafia, outraGrafia)).toBe(false);
    expect(teamSimilarity(umaGrafia, outraGrafia)).toBeGreaterThanOrEqual(0.9);
  });

  /** O nome que é só a palavra própria continua casando o time da exceção. */
  it("Castilla sozinho é o Real Madrid Castilla, não o Real Madrid", () => {
    expect(hasProtectedTeamCategoryConflict("Castilla", "Real Madrid Castilla")).toBe(false);
    expect(teamSimilarity("Castilla", "Real Madrid Castilla")).toBeGreaterThanOrEqual(0.9);
    expect(teamSimilarity("RM Castilla", "Real Madrid Castilla")).toBeGreaterThanOrEqual(0.4);
    expect(teamSimilarity("Castilla", "Real Madrid")).toBeLessThan(0.5);
  });

  it("canonicalizar de novo não muda o nome", () => {
    for (const [reserva] of RESERVA_E_PRINCIPAL) {
      const canon = canonicalizeTeamName(reserva);
      expect(canonicalizeTeamName(canon)).toBe(canon);
    }
  });
});

/**
 * A categoria pode estar na COMPETIÇÃO em vez do nome: a Pinnacle escreve
 * "Chelsea" e põe o feminino em "Champions League Women"; o FlashScore escreve
 * "Chelsea W". A comparação tira a categoria que as ligas explicam.
 */
describe("categoria lida no nome e na competição", () => {
  it("Chelsea na liga feminina é o Chelsea W; sem a liga, não", () => {
    expect(teamCategoryConflictInContext({
      betName: "Chelsea",
      fixtureName: "Chelsea W",
      betLeague: "Champions League Women",
      fixtureLeague: "EUROPE: UEFA Champions League Women - League phase",
    })).toBe(false);
    expect(teamCategoryConflictInContext({ betName: "Chelsea", fixtureName: "Chelsea W" })).toBe(true);
    expect(teamCategoryConflictInContext({
      betName: "Chelsea",
      fixtureName: "Chelsea W",
      betLeague: "Premier League",
      fixtureLeague: "ENGLAND: WSL",
    })).toBe(true);
  });

  it("o II da Pinnacle é o B do FlashScore, mas o B continua longe do sub-23 e do principal", () => {
    expect(teamCategoryConflictInContext({ betName: "Porto II", fixtureName: "FC Porto B" })).toBe(false);
    expect(teamCategoryConflictInContext({ betName: "Club Brugge II", fixtureName: "Club NXT" })).toBe(false);
    expect(teamCategoryConflictInContext({ betName: "Barcelona B", fixtureName: "Barcelona U23" })).toBe(true);
    expect(teamCategoryConflictInContext({ betName: "Porto II", fixtureName: "FC Porto" })).toBe(true);
    // O Club Brugge principal continua longe do reserva, com qualquer grafia.
    expect(teamCategoryConflictInContext({ betName: "Club Brugge II", fixtureName: "Club Brugge" })).toBe(true);
    expect(teamCategoryConflictInContext({ betName: "Club Brugge", fixtureName: "Club Brugge B" })).toBe(true);
    expect(teamCategoryConflictInContext({ betName: "Club Brugge", fixtureName: "Club NXT" })).toBe(true);
  });

  it("o (F) do tipster na liga feminina é o time da Pinnacle sem marcador", () => {
    expect(teamCategoryConflictInContext({
      betName: "Hapoel Jerusalem F",
      fixtureName: "Hapoel Jerusalem",
      betLeague: "Ligat Al, Women",
      fixtureLeague: "Premier League Women",
    })).toBe(false);
    // Sem a liga da fixture, o "Hapoel Jerusalem" pode ser o masculino.
    expect(teamCategoryConflictInContext({
      betName: "Hapoel Jerusalem F",
      fixtureName: "Hapoel Jerusalem",
      betLeague: "Ligat Al, Women",
    })).toBe(true);
  });

  /**
   * O espelho da regra da liga da fixture: a liga da APOSTA declara reserva ou
   * base e nenhum nome declara nada. O time de mesmo nome numa liga conhecida
   * sem categoria é o principal.
   */
  it("a aposta da liga de reservas ou de base não é o principal de mesmo nome", () => {
    expect(teamCategoryConflictInContext({
      betName: "River Plate",
      fixtureName: "River Plate",
      betLeague: "Liga Pro Reserves",
      fixtureLeague: "ARGENTINA: Liga Profesional - Clausura",
    })).toBe(true);
    expect(teamCategoryConflictInContext({
      betName: "Chelsea",
      fixtureName: "Chelsea",
      betLeague: "UEFA Youth League",
      fixtureLeague: "ENGLAND: Premier League",
    })).toBe(true);
    // A Pinnacle põe a reserva só na liga: a mesma categoria dos dois lados.
    expect(teamCategoryConflictInContext({
      betName: "River Plate",
      fixtureName: "River Plate",
      betLeague: "Liga Pro Reserves",
      fixtureLeague: "Argentina - Liga Pro Reserves",
    })).toBe(false);
  });

  it("a liga de reservas da aposta cobre o dígito do FlashScore", () => {
    expect(teamCategoryConflictInContext({
      betName: "Gimnasia La Plata",
      fixtureName: "Gimnasia L.P. 2",
      betLeague: "Liga Pro Reserves",
      fixtureLeague: "ARGENTINA: Reserve League - Clausura",
    })).toBe(false);
    expect(teamCategoryConflictInContext({
      betName: "Gimnasia La Plata",
      fixtureName: "Gimnasia L.P. 2",
      betLeague: "Liga Profesional",
    })).toBe(true);
  });

  it("sem categoria em lugar nenhum, só o nome decide", () => {
    expect(teamCategoryConflictInContext({
      betName: "Palmeiras",
      fixtureName: "Palmeiras",
      betLeague: "Serie A",
      fixtureLeague: "BRAZIL: Serie A Betano",
    })).toBe(false);
  });

  it("a categoria do time é a do nome ou, sem ela, a da competição", () => {
    const feminino = teamCategoryInContext("Chelsea", "Champions League Women");
    expect([...feminino]).toEqual(["women"]);
    expect(sameTeamCategory(feminino, teamCategoryInContext("Chelsea W"))).toBe(true);
    expect(sameTeamCategory(feminino, teamCategoryInContext("Chelsea"))).toBe(false);
    // O nome manda quando declara: "Chelsea U19" numa liga qualquer é base.
    expect(sameTeamCategory(
      teamCategoryInContext("Chelsea U19", "UEFA Youth League"),
      teamCategoryInContext("Chelsea U19"),
    )).toBe(true);
    // O dígito de reserva é a classe que a liga de reservas declara.
    expect(sameTeamCategory(
      teamCategoryInContext("Gimnasia La Plata", "Liga Pro Reserves"),
      teamCategoryInContext("Gimnasia L.P. 2"),
    )).toBe(true);
  });
});

describe("base, marca de reserva do tipster e gêmeos de categoria", () => {
  it.each([
    ["UEFA - Youth League U19", "Real Madrid", "Internazionale", true],
    ["Turkey - Super Lig U19", "Galatasaray", "Kocaelispor", true],
    ["Italy - Primavera 1", "Inter", "Milan", true],
    ["U23 Championship", "Rio Ave", "Penafiel", true],
    ["Africa - COSAFA Championship U20", "Mozambique U20", "Zambia U20", true],
    ["Argentina - Liga Pro Reserves", "Talleres de Cordoba", "Gimnasia Mendoza", false],
    ["Netherlands - Eerste Divisie", "Jong PSV", "Vitesse", false],
    ["USA - MLS Next Pro", "Toronto FC II", "Columbus Crew 2", false],
    ["England - Women Super League", "Liverpool", "Tottenham Hotspur", false],
    ["Portugal - Liga 2", "Porto B", "Benfica B", false],
    ["Argentina - Liga Profesional", "Argentinos Juniors", "Boca Juniors", false],
    // Sub-21/sub-23 em liga adulta é reserva e vale (aposta real: Virton x Genk II).
    ["Belgium - Challenger Pro League", "Royal Excelsior Virton", "Genk U23", false],
    ["Italy - Serie C", "Juventus Next Gen", "Albinoleffe", false],
    ["England - EFL Trophy", "Exeter", "Tottenham U21", false],
    ["Brazil - Copa Sao Paulo de Futebol Junior", "Corinthians", "Gremio", true],
  ])("%s · %s x %s: base = %s", (league, home, away, base) => {
    expect(isBaseCategoryFixture({ home, away, league })).toBe(base);
  });

  it("\"R\" nos dois times vira Reserva, pelo nome inteiro de cada um", () => {
    expect(markSoccerReserveTeams({ evento: "Talleres R vs Gimnasia Mendoza Res.", selecao: "Talleres R +0.5" }))
      .toEqual({ evento: "Talleres Reserva vs Gimnasia Mendoza Reserva", selecao: "Talleres Reserva +0.5" });
    // Um nome começa como o outro: a troca não cai dentro do mais longo.
    expect(markSoccerReserveTeams({ evento: "Estudiantes Rio Cuarto R vs Estudiantes R", selecao: "Estudiantes R" }))
      .toEqual({ evento: "Estudiantes Rio Cuarto Reserva vs Estudiantes Reserva", selecao: "Estudiantes Reserva" });
    // Um time só com "R" é nome ("Bristol R" é o Rovers), não reserva.
    const bristol = { evento: "Bristol R vs Walsall", selecao: "Bristol R" };
    expect(markSoccerReserveTeams(bristol)).toBe(bristol);
  });

  type F = { id: string; home: string; away: string; league: string; at: string; swapped?: boolean };
  const refine = (betHome: string, betAway: string, fixtures: F[], betLeague?: string, betAt?: string) =>
    refineCategoryCandidates({
      betHome, betAway, betLeague, betKickoffMs: betAt ? Date.parse(betAt) : null, candidates: fixtures,
      fixture: (f) => ({
        home: f.home, away: f.away, league: f.league, country: f.league.split(" - ")[0], kickoffMs: Date.parse(f.at),
        swapped: f.swapped ?? false,
      }),
      collapseDuplicateListings: true,
    }).map((f) => f.id);

  it("o gêmeo sub-19 sai, e o jogo principal fica (Youth League × Champions)", () => {
    expect(refine("Real Madrid", "Inter", [
      { id: "youth", home: "Real Madrid", away: "Internazionale", league: "UEFA - Youth League U19", at: "2026-09-08T14:00:00Z" },
      { id: "champions", home: "Real Madrid", away: "Internazionale", league: "UEFA - Champions League", at: "2026-09-08T19:00:00Z" },
    ])).toEqual(["champions"]);
  });

  it("sem categoria no post, o principal vence o gêmeo reserva ou feminino; com a marca, fica a categoria", () => {
    const fixtures: F[] = [
      { id: "reservas", home: "Talleres de Cordoba", away: "Gimnasia Mendoza", league: "Argentina - Liga Pro Reserves", at: "2026-09-12T15:00:00Z" },
      { id: "principal", home: "Talleres de Cordoba", away: "Gimnasia Mendoza", league: "Argentina - Liga Profesional", at: "2026-09-13T20:00:00Z" },
    ];
    expect(refine("Talleres", "Gimnasia Mendoza", fixtures)).toEqual(["principal"]);
    expect(refine("Talleres Reserva", "Gimnasia Mendoza Reserva", fixtures)).toEqual(["reservas", "principal"]);
    expect(refine("Liverpool", "Tottenham", [
      { id: "fem", home: "Liverpool", away: "Tottenham Hotspur", league: "England - Women Super League", at: "2026-09-14T11:00:00Z" },
      { id: "masc", home: "Liverpool", away: "Tottenham Hotspur", league: "England - Premier League", at: "2026-09-14T15:00:00Z" },
    ])).toEqual(["masc"]);
  });

  it("o principal não vence o feminino quando o mando ou o horário do post apontam o feminino", () => {
    // PSV W x Twente W tem o mando do post; Twente x PSV, não.
    expect(refine("PSV", "Twente", [
      { id: "fem", home: "PSV", away: "Twente", league: "Netherlands - Eredivisie Women", at: "2026-09-14T11:00:00Z" },
      { id: "masc", home: "Twente", away: "PSV", league: "Netherlands - Eredivisie", at: "2026-09-14T15:00:00Z", swapped: true },
    ])).toEqual(["fem", "masc"]);
    // Nice x Lille às 11:00 no post: o feminino é o do horário.
    expect(refine("Nice", "Lille", [
      { id: "fem", home: "Nice", away: "Lille", league: "France - Premiere Ligue Women", at: "2026-09-14T11:00:00Z" },
      { id: "masc", home: "Nice", away: "Lille", league: "France - Ligue 1", at: "2026-09-14T15:15:00Z" },
    ], undefined, "2026-09-14T11:00:00Z")).toEqual(["fem", "masc"]);
  });

  it("par que só existe numa categoria fica, mesmo sem marca (Arsenal x HB Køge)", () => {
    expect(refine("Arsenal", "HB Koge", [
      { id: "fem", home: "Arsenal", away: "HB Koge", league: "Europe - Champions League Women", at: "2026-09-10T17:00:00Z" },
    ])).toEqual(["fem"]);
  });

  it("homônimos de países diferentes no mesmo horário não são o mesmo jogo", () => {
    expect(refine("Agua Santa", "Palmeiras", [
      { id: "br", home: "Agua Santa", away: "Palmeiras", league: "Brazil - Paulista A1", at: "2026-09-08T21:00:00Z" },
      { id: "cl", home: "Agua Santa", away: "Palmeiras", league: "Chile - Other", at: "2026-09-08T21:00:00Z" },
    ])).toEqual(["br", "cl"]);
  });

  it("o mesmo jogo listado duas vezes conta uma; com o mando trocado, são jogos diferentes", () => {
    expect(refine("Fredrikstad", "Sarpsborg", [
      { id: "a", home: "Fredrikstad", away: "Sarpsborg 08", league: "Norway - Eliteserien", at: "2026-09-13T16:00:00Z" },
      { id: "b", home: "Fredrikstad", away: "Sarpsborg", league: "Norway - Eliteserien", at: "2026-09-13T16:00:00Z" },
    ])).toEqual(["a"]);
    // Mando trocado no mesmo horário é outro jogo (pré-temporada da NHL): os dois ficam.
    expect(refine("Montreal", "Toronto", [
      { id: "a", home: "Montreal Canadiens", away: "Toronto Maple Leafs", league: "USA - NHL Preseason", at: "2026-09-19T23:00:00Z" },
      { id: "b", home: "Toronto Maple Leafs", away: "Montreal Canadiens", league: "USA - NHL Preseason", at: "2026-09-19T23:00:00Z", swapped: true },
    ])).toEqual(["a", "b"]);
  });
});

/**
 * A guarda de CATEGORIA fala de identidade, não de confiança: aposta que
 * declara feminino, base ou reserva não resolve para fixture que não declara
 * nada, por maior que seja a semelhança, e o nome distante sem categoria
 * (a seleção escrita em português) não é recusado por ela. Pares reais da
 * produção, com o veredito que cada um deve receber.
 */
const LINHAS_DA_PRODUCAO: Array<{
  aposta: [string, string];
  fixture: [string, string];
  recusar: boolean;
  porque: string;
}> = [
  {
    aposta: ["botafogo women", "sao paulo women"],
    fixture: ["Botafogo FR RJ", "Sao Paulo"],
    recusar: true,
    porque: "futebol feminino resolvendo para o masculino",
  },
  {
    aposta: ["gremio women", "cruzeiro women"],
    fixture: ["Gremio", "Cruzeiro"],
    recusar: true,
    porque: "futebol feminino resolvendo para o masculino",
  },
  {
    aposta: ["uppsala women", "malmo women"],
    fixture: ["Uppsala", "Malmo"],
    recusar: true,
    porque: "futebol feminino resolvendo para o masculino",
  },
  {
    aposta: ["bahia f", "botafogo f"],
    fixture: ["Bahia", "Botafogo FR RJ"],
    recusar: true,
    porque: "o `(F)` do tipster é informação que ele deu",
  },
  {
    aposta: ["franca", "marrocos"],
    fixture: ["France", "Morocco"],
    recusar: false,
    porque: "nome de seleção em PT não declara categoria",
  },
  {
    aposta: ["espanha", "argentina"],
    fixture: ["Spain", "Argentina"],
    recusar: false,
    porque: "similaridade 0,12 e correto",
  },
  {
    aposta: ["lok leipzig", "hertha berlim"],
    fixture: ["Lokomotive Leipzig", "Hertha BSC"],
    recusar: false,
    porque: "abreviação + grafia PT",
  },
  {
    aposta: ["osset united", "matlock town"],
    fixture: ["Ashton United", "Whitby Town"],
    recusar: false,
    porque: "errado, mas por AUSÊNCIA DE ÂNCORA — o scorer é quem recusa, não a categoria",
  },
];

function recusadoPelaCategoria(aposta: [string, string], fixture: [string, string]): boolean {
  const [ah, aa] = aposta.map((t) => canonicalizeTeamName(t)) as [string, string];
  const [fh, fa] = fixture.map((t) => canonicalizeTeamName(t)) as [string, string];
  const direto = teamSimilarity(fh, ah) + teamSimilarity(fa, aa);
  const invertido = teamSimilarity(fh, aa) + teamSimilarity(fa, ah);
  const inv = invertido > direto;
  return (
    betDeclaresCategoryFixtureLacks(inv ? aa : ah, fh)
    || betDeclaresCategoryFixtureLacks(inv ? ah : aa, fa)
  );
}

describe("a guarda de categoria em pares reais", () => {
  for (const linha of LINHAS_DA_PRODUCAO) {
    it(`${linha.recusar ? "recusa" : "aceita"} ${linha.aposta.join(" × ")} — ${linha.porque}`, () => {
      expect(recusadoPelaCategoria(linha.aposta, linha.fixture)).toBe(linha.recusar);
    });
  }

  it("a guarda de categoria não depende da semelhança dos nomes", () => {
    // Seleções escritas em português ficam longe do nome em inglês, e a guarda
    // de categoria não as recusa por isso.
    for (const [pt, en] of [["franca", "France"], ["espanha", "Spain"], ["uruguai", "Uruguay Montevideo"]]) {
      expect(teamSimilarity(pt!, en!), `${pt} × ${en}`).toBeLessThan(0.3);
      expect(recusadoPelaCategoria([pt!, "x"], [en!, "x"])).toBe(false);
    }
  });
});

describe("“Academy” nem sempre é categoria", () => {
  /**
   * `Puskas Akademia` é o nome PRÓPRIO de um clube da 1ª divisão húngara. Se
   * `academy` é classe protegida e `akademia` fica fora do vocabulário, a guarda
   * de categoria recusa `Puskas Academy` (como o tipster escreve) contra ele: o
   * time principal parece base.
   */
  it("as três grafias da mesma palavra são a mesma classe", () => {
    expect(betDeclaresCategoryFixtureLacks(
      canonicalizeTeamName("Puskas Academy"), canonicalizeTeamName("Puskas Akademia"),
    )).toBe(false);
    expect(teamSimilarity("Puskas Academy", "Puskas Akademia")).toBeGreaterThanOrEqual(0.9);
  });

  it("e o academy de VERDADE continua barrado contra o principal", () => {
    for (const [base, principal] of [["KuPS Akatemia", "KuPS"], ["SJK Akademia", "SJK"]]) {
      expect(betDeclaresCategoryFixtureLacks(
        canonicalizeTeamName(base!), canonicalizeTeamName(principal!),
      ), `${base} × ${principal}`).toBe(true);
    }
  });
});
