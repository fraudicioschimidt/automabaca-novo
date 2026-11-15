import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import type { FlashscoreCatalogMatch } from "@/src/providers/flashscore/types";
import { matchFlashscoreFixture } from "@/src/services/settlement/flashscore/match-identity";
import { seedCatalogLink, seedTeamCard } from "../helpers/team-cards";

/**
 * As fichas dos times e a ligação dos catálogos só AJUDAM a casar a aposta com
 * a partida do FlashScore: sem ficha nenhuma, o casamento é o do matcher; com
 * ficha errada ou ambígua, também. O caso é o da produção em 23/09: as apostas
 * da Champions feminina 3cc59b85 e ab0cad15 ficaram sem candidato porque o
 * store antigo dava o id FlashScore dos times MASCULINOS.
 */

let db: TestDb;
const KICKOFF = new Date("2026-09-23T19:00:00Z");
const LIGA = "EUROPE: UEFA Champions League Women - League phase";

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
});

function catalogMatch(
  id: string,
  home: { name: string; id: string },
  away: { name: string; id: string },
): FlashscoreCatalogMatch {
  return {
    match_id: id,
    timestamp: Math.floor(KICKOFF.getTime() / 1_000),
    home_team: { team_id: home.id, name: home.name },
    away_team: { team_id: away.id, name: away.name },
    scores: { home: 1, away: 0 },
    match_status: {
      stage: "Finished",
      is_cancelled: false,
      is_postponed: false,
      is_started: true,
      is_in_progress: false,
      is_finished: true,
    },
    tournament: { id: "champions-women", name: LIGA, countryName: "Europe" },
  };
}

/** O catálogo de futebol de 23/09 no horário das duas apostas, com os ids reais. */
const CATALOGO = [
  catalogMatch("f1NKO2mg", { name: "Chelsea W", id: "Q7Hu2UDD" }, { name: "Austria Vienna W", id: "21HejI2E" }),
  catalogMatch("CvejSdBr", { name: "Barcelona W", id: "YFBOvfnB" }, { name: "Paris FC W", id: "djTazozI" }),
];

/** A aposta depois da identidade pela Pinnacle17: nomes sem marcador, feminino na liga. */
const APOSTA = { esporte: "Soccer", pais: "Europe", competicao: "Champions League Women", data: KICKOFF };

function casar(home: string, away: string) {
  return matchFlashscoreFixture({
    teams: { home, away },
    bet: APOSTA,
    matches: CATALOGO,
    sportId: 1,
    day: "2026-09-23",
    loadMatches: async () => [],
  });
}

/** Ficha do time com o id e o nome do FlashScore e o nome da Pinnacle em 2 jogos. */
async function comFicha(params: {
  name: string;
  country: string;
  flashscoreId: string;
  category?: "principal" | "feminino";
  tipsterNames?: string[];
}): Promise<void> {
  await seedTeamCard(db.prisma, {
    flashscoreTeamId: params.flashscoreId, flashscoreName: params.name, country: params.country,
    category: params.category ?? "principal", pinnacleNames: [{ name: params.name }],
    tipsterNames: (params.tipsterNames ?? []).map((name) => ({ name })),
  });
}

describe("casamento FlashScore com as fichas dos times", () => {
  it("sem ficha é a linha de base: o jogo feminino é achado pelo nome e pela liga", async () => {
    await expect(casar("Chelsea", "Austria Vienna")).resolves.toMatchObject({
      kind: "matched",
      candidate: { match: { match_id: "f1NKO2mg" }, strategy: "fuzzy" },
    });
    await expect(casar("FC Barcelona", "Paris FC")).resolves.toMatchObject({
      kind: "matched",
      candidate: { match: { match_id: "CvejSdBr" } },
    });
  });

  it("as fichas do masculino não traduzem a aposta feminina, e o jogo é o mesmo", async () => {
    await comFicha({ name: "Chelsea", country: "England", flashscoreId: "4fGZN2oK" });
    await comFicha({ name: "Austria Vienna", country: "Austria", flashscoreId: "lvnOzIkE" });

    await expect(casar("Chelsea", "Austria Vienna")).resolves.toMatchObject({
      kind: "matched",
      candidate: { match: { match_id: "f1NKO2mg" } },
      search: {
        expectedTeamIds: { home: null, away: null },
        resolved: { homeResolution: { strategy: "original" }, awayResolution: { strategy: "original" } },
      },
    });
  });

  it("nome com duas fichas segue com a grafia original e casa", async () => {
    for (const [country, id] of [["England", "chelsea-eng"], ["Chile", "chelsea-chi"]] as const) {
      await comFicha({ name: "Chelsea", country, flashscoreId: id, category: "feminino" });
    }

    await expect(casar("Chelsea", "Austria Vienna")).resolves.toMatchObject({
      kind: "matched",
      candidate: { match: { match_id: "f1NKO2mg" } },
      search: { resolved: { homeResolution: { strategy: "ambiguous" } }, searchTeams: { home: "Chelsea" } },
    });
  });

  /**
   * A ficha "Inter" (Iw7eKK25, sem país) é a Internazionale; a do Grêmio
   * (E1EFmhVh) é certa. Com o id como filtro, o
   * Gre-Nal ficava sem candidato. Como dica, o id do Grêmio ancora o jogo e o
   * "Inter" vale pelo nome; sem o Gre-Nal no catálogo, com os dois ids
   * conhecidos, o nome não escolhe o homônimo Inter de Limeira × Grêmio
   * Novorizontino: a aposta fica para o dono.
   */
  describe("Inter vs Grêmio com uma ficha errada", () => {
    const tournament = (name: string, countryName: string) => ({ id: name, name, countryName });
    const greNal = { ...catalogMatch("int-gre", { name: "Internacional", id: "tSCiHj0I" }, { name: "Gremio", id: "E1EFmhVh" }),
      tournament: tournament("BRAZIL: Serie A Betano", "Brazil") };
    const limeira = { ...catalogMatch("limeira", { name: "Inter de Limeira", id: "inter-limeira" },
      { name: "Gremio Novorizontino", id: "novorizontino" }),
      timestamp: Math.floor(KICKOFF.getTime() / 1_000) + 3_600, tournament: tournament("BRAZIL: Serie B", "Brazil") };
    const internazionale = { ...catalogMatch("inter-genoa", { name: "Inter", id: "Iw7eKK25" }, { name: "Genoa", id: "genoa" }),
      tournament: tournament("ITALY: Serie A", "Italy") };

    beforeEach(async () => {
      await comFicha({ name: "Inter", country: "", flashscoreId: "Iw7eKK25" });
      await comFicha({ name: "Gremio", country: "Brazil", flashscoreId: "E1EFmhVh" });
    });

    const casarInterGremio = (matches: FlashscoreCatalogMatch[]) => matchFlashscoreFixture({
      teams: { home: "Inter", away: "Grêmio" },
      bet: { esporte: "Soccer", pais: "Brazil", competicao: "Serie A", data: KICKOFF },
      matches,
      sportId: 1,
      day: "2026-09-23",
      loadMatches: async () => [],
    });

    it("com a ficha da Inter errada, o Gre-Nal fica para o dono em vez de liquidar pelo nome parecido", async () => {
      await expect(casarInterGremio([greNal, limeira, internazionale])).resolves.toMatchObject({
        kind: "not_found",
      });
    });

    it("sem o Gre-Nal no catálogo, o homônimo não liquida", async () => {
      await expect(casarInterGremio([limeira, internazionale])).resolves.toMatchObject({
        kind: "not_found",
        reason: "no_candidate",
      });
    });
  });
});

/**
 * A trava de horário é da PARTIDA, não do store: o jogo que liquida começa a no
 * máximo 3 h do horário da aposta. A busca por nome aceita até 18 h, e o
 * vínculo já gravado (`resultMatchId`) olha o dia e os vizinhos.
 */
describe("o jogo que liquida está no horário da aposta", () => {
  const HORA = 3_600_000;
  const at = (offsetMs: number) => Math.floor((KICKOFF.getTime() + offsetMs) / 1_000);
  function jogo(id: string, home: string, away: string, tournament: string, offsetMs: number): FlashscoreCatalogMatch {
    return {
      ...catalogMatch(id, { name: home, id: `${id}-h` }, { name: away, id: `${id}-a` }),
      timestamp: at(offsetMs),
      tournament: { id: tournament, name: tournament, countryName: "Argentina" },
    };
  }
  const principal = (offsetMs: number) =>
    jogo("principal", "River Plate", "Boca Juniors", "ARGENTINA: Liga Profesional - Clausura", offsetMs);
  const reserva = jogo("reserva", "River Plate 2", "Boca Juniors 2", "ARGENTINA: Reserve League - Clausura", 0);

  function casarReserva(params: {
    teams?: { home: string; away: string };
    competicao: string;
    matches: FlashscoreCatalogMatch[];
    knownMatchId?: string;
    vizinho?: FlashscoreCatalogMatch[];
  }) {
    return matchFlashscoreFixture({
      teams: params.teams ?? { home: "River Plate", away: "Boca Juniors" },
      bet: { esporte: "Soccer", pais: "Argentina", competicao: params.competicao, data: KICKOFF },
      matches: params.matches,
      sportId: 1,
      day: "2026-09-23",
      loadMatches: async (_sport, day) => (day === "2026-09-24" ? params.vizinho ?? [] : []),
      knownMatchId: params.knownMatchId,
    });
  }

  it("aposta da reserva vinculada ao jogo do principal 6 h depois fica com o jogo da reserva", async () => {
    await expect(casarReserva({
      competicao: "Liga Pro Reserves",
      matches: [reserva, principal(6 * HORA)],
      knownMatchId: "principal",
    })).resolves.toMatchObject({ kind: "matched", candidate: { match: { match_id: "reserva" } } });
  });

  it("vínculo com o jogo do mesmo par no dia seguinte (+30 h) não liquida", async () => {
    await expect(casarReserva({
      competicao: "Liga Profesional",
      matches: [],
      knownMatchId: "principal",
      vizinho: [principal(30 * HORA)],
    })).resolves.toMatchObject({ kind: "not_found" });
  });

  it("o jogo já vinculado que o FlashScore adiou para o dia seguinte continua vinculado, para o reembolso", async () => {
    const remarcado = principal(26 * HORA);
    const adiado = { ...remarcado, match_status: { ...remarcado.match_status, is_postponed: true, is_finished: false } };
    await expect(casarReserva({ competicao: "Liga Profesional", matches: [], knownMatchId: "principal", vizinho: [adiado] }))
      .resolves.toMatchObject({ kind: "matched", source: "result_match", candidate: { match: { match_id: "principal" } } });
    // Sem vínculo anterior, o jogo adiado fora do horário não é o da aposta.
    await expect(casarReserva({ competicao: "Liga Profesional", matches: [], vizinho: [adiado] }))
      .resolves.toMatchObject({ kind: "not_found" });
  });

  it("nomes crus com o \"R\" do tipster e só o jogo do principal a +8 h: não liquida", async () => {
    await expect(casarReserva({
      teams: { home: "River Plate R", away: "Boca Juniors R" },
      competicao: "",
      matches: [principal(8 * HORA)],
    })).resolves.toMatchObject({ kind: "not_found", reason: "kickoff_mismatch" });
  });
});

describe("mando da aposta no jogo já vinculado, sem ligação dos catálogos", () => {
  const classico = {
    ...catalogMatch("classico", { name: "Cruzeiro", id: "fs-cruzeiro" }, { name: "Atletico-MG", id: "fs-galo" }),
    tournament: { id: "bra", name: "BRAZIL: Serie A Betano", countryName: "Brazil" },
  };
  const vinculado = (home: string, away: string) => matchFlashscoreFixture({
    teams: { home, away },
    bet: { esporte: "Soccer", pais: "Brazil", competicao: "Brazil - Serie A", data: KICKOFF },
    matches: [classico],
    sportId: 1,
    day: "2026-09-23",
    loadMatches: async () => [],
    knownMatchId: "classico",
  });

  it("o apelido do mandante não parece com nenhum time: o visitante diz que a aposta está invertida", async () => {
    await expect(vinculado("Galo", "Cruzeiro")).resolves.toMatchObject({
      kind: "matched", source: "result_match", candidate: { match: { match_id: "classico" }, swapped: true },
    });
    await expect(vinculado("Cruzeiro", "Galo")).resolves.toMatchObject({
      kind: "matched", source: "result_match", candidate: { swapped: false },
    });
  });

  it("nomes que não dizem o mando não ficam com o jogo vinculado: a busca decide", async () => {
    const fixture = await vinculado("Galo", "Raposa");
    expect(fixture.kind === "matched" ? fixture.source : fixture.kind).not.toBe("result_match");
  });

  it("com a ficha de um dos times, o id dele diz o mando", async () => {
    await comFicha({ name: "Atletico-MG", country: "Brazil", flashscoreId: "fs-galo", tipsterNames: ["Galo"] });
    await expect(vinculado("Galo", "Raposa")).resolves.toMatchObject({
      kind: "matched", source: "result_match", candidate: { swapped: true },
    });
  });
});

/**
 * A categoria vale pelo nome da aposta, não pela tradução da ficha: uma ficha
 * errada que leva o "Chelsea W" ao "Chelsea" não pode liquidar a aposta
 * feminina com o jogo masculino.
 */
it("tradução da ficha que atravessa a categoria: a busca refaz pelo nome cru", async () => {
  // Fichas femininas com o nome e o id do FlashScore do time masculino.
  for (const [time, flashscoreId] of [["Chelsea", "4fGZN2oK"], ["Arsenal", "arsenal"]] as const) {
    await comFicha({ name: time, country: "England", flashscoreId, category: "feminino", tipsterNames: [`${time} W`] });
  }
  const masculino = {
    ...catalogMatch("masculino", { name: "Chelsea", id: "4fGZN2oK" }, { name: "Arsenal", id: "arsenal" }),
    tournament: { id: "pl", name: "ENGLAND: Premier League", countryName: "England" },
  };
  const feminino = {
    ...catalogMatch("feminino", { name: "Chelsea W", id: "Q7Hu2UDD" }, { name: "Arsenal W", id: "arsenal-w" }),
    tournament: { id: "wsl", name: "ENGLAND: WSL", countryName: "England" },
  };

  const fixture = await matchFlashscoreFixture({
    teams: { home: "Chelsea W", away: "Arsenal W" },
    bet: { esporte: "Soccer", pais: "England", competicao: "", data: KICKOFF },
    matches: [masculino, feminino],
    sportId: 1,
    day: "2026-09-23",
    loadMatches: async () => [],
  });

  expect(fixture).toMatchObject({
    kind: "matched",
    candidate: { match: { match_id: "feminino" } },
    search: { searchTeams: { home: "Chelsea", away: "Arsenal" }, expectedTeamIds: { home: null, away: null } },
  });
});

/**
 * O jogo que o pareamento dos catálogos ligou ao evento da identidade entra
 * como id conhecido, pelas mesmas travas do vínculo por id: 3 h do horário da
 * aposta, categoria, ligação `ok` e 1:1. Recusada, a busca por nome decide.
 */
describe("liquidação com o jogo ligado pelo pareamento", () => {
  const HORA = 3_600_000;
  const liga = { id: "bra", name: "BRAZIL: Serie A Betano", countryName: "Brazil" };
  /** No FlashScore o mando é o inverso do da Pinnacle17, e os nomes pouco se parecem com os dela. */
  const ligado = (offsetMs = 0): FlashscoreCatalogMatch => ({
    ...catalogMatch("fs-ligado", { name: "Vasco", id: "fs-vasco" }, { name: "Flamengo", id: "fs-fla" }),
    timestamp: Math.floor((KICKOFF.getTime() + offsetMs) / 1_000),
    tournament: liga,
  });
  const APOSTA_BR = { esporte: "Soccer", pais: "Brazil", competicao: "Brazil - Serie A", data: KICKOFF };

  async function ligar(params: { pinnacleEventId?: string; flashscoreMatchId?: string; status?: "ok" | "conflict"; sport?: string } = {}) {
    await seedCatalogLink(db.prisma, {
      pinnacleEventId: params.pinnacleEventId ?? "p17-1", flashscoreMatchId: params.flashscoreMatchId ?? "fs-ligado",
      pinnacleHome: "Flamengo RJ", pinnacleAway: "Vasco da Gama RJ", flashscoreHome: "Vasco", flashscoreAway: "Flamengo",
      flashscoreHomeTeamId: "fs-vasco", flashscoreAwayTeamId: "fs-fla", swapped: true, kickoff: KICKOFF,
      ...(params.status ? { status: params.status } : {}), ...(params.sport ? { sport: params.sport } : {}),
    });
  }

  function casarLigado(matches: FlashscoreCatalogMatch[], extra: { knownMatchId?: string; bet?: typeof APOSTA_BR; teams?: { home: string; away: string } } = {}) {
    return matchFlashscoreFixture({
      teams: extra.teams ?? { home: "Flamengo RJ", away: "Vasco da Gama RJ" },
      bet: extra.bet ?? APOSTA_BR,
      matches,
      sportId: 1,
      day: "2026-09-23",
      loadMatches: async () => [],
      knownMatchId: extra.knownMatchId,
      catalogLinkEventId: "p17-1",
    });
  }

  it("a ligação ok e 1:1 dá o jogo, com o mando que ela registrou", async () => {
    await ligar();
    await expect(casarLigado([ligado()])).resolves.toMatchObject({
      kind: "matched",
      source: "catalog_link",
      candidate: { match: { match_id: "fs-ligado" }, strategy: "provider_id", swapped: true },
    });
  });

  it("jogo ligado a mais de 3 h do horário da aposta: a busca por nome decide", async () => {
    await ligar();
    await expect(casarLigado([ligado(5 * HORA)])).resolves.toMatchObject({ kind: "not_found", reason: "kickoff_mismatch" });
  });

  it("jogo ligado de outra categoria: a busca por nome acha o da aposta", async () => {
    await ligar();
    const feminino = {
      ...catalogMatch("fs-fem", { name: "Flamengo W", id: "fla-w" }, { name: "Vasco W", id: "vasco-w" }),
      tournament: { id: "bra-w", name: "BRAZIL: Brasileiro Women", countryName: "Brazil" },
    };
    await expect(casarLigado([ligado(), feminino], {
      teams: { home: "Flamengo RJ W", away: "Vasco da Gama RJ W" },
      bet: { ...APOSTA_BR, competicao: "Brazil - Brasileiro Women" },
    })).resolves.toMatchObject({ kind: "matched", source: "search", candidate: { match: { match_id: "fs-fem" } } });
  });

  it.each([
    ["dois eventos da Pinnacle17 no mesmo jogo", () => ligar({ pinnacleEventId: "p17-2" })],
    ["a ligação em conflito", async () => {
      await db.prisma.catalogGameLink.update({ where: { pinnacleEventId: "p17-1" }, data: { status: "conflict" } });
    }],
    ["a ligação de outro esporte", async () => {
      await db.prisma.catalogGameLink.update({ where: { pinnacleEventId: "p17-1" }, data: { sport: "Basketball" } });
    }],
  ] as const)("%s: a ligação não vale, e a busca por nome decide", async (_caso, preparar) => {
    await ligar();
    await preparar();
    const fixture = await casarLigado([ligado()]);
    expect(fixture).toMatchObject({ search: expect.anything() });
    expect(fixture.kind === "matched" ? fixture.source : "not_found").not.toBe("catalog_link");
  });

  it("o jogo já vinculado que é o da ligação fica com o mando dela, mesmo com nomes que não se parecem", async () => {
    await ligar();
    // No FlashScore o jogo tem nomes que nada dizem; o mandante dele é o visitante da Pinnacle17.
    const semNome = { ...ligado(), home_team: { team_id: "fs-vasco", name: "Alfa" }, away_team: { team_id: "fs-fla", name: "Beta" } };
    await expect(casarLigado([semNome], { knownMatchId: "fs-ligado" })).resolves.toMatchObject({
      kind: "matched", source: "result_match", candidate: { match: { match_id: "fs-ligado" }, swapped: true },
    });
  });

  it("o jogo ligado com outros times que os da ligação não vale: a busca por nome decide", async () => {
    await ligar();
    const outrosTimes = { ...ligado(), home_team: { team_id: "fs-outro", name: "Vasco" }, away_team: { team_id: "fs-fla", name: "Flamengo" } };
    const fixture = await casarLigado([outrosTimes]);
    expect(fixture.kind === "matched" ? fixture.source : fixture.kind).not.toBe("catalog_link");
  });

  it("aposta cujos nomes não dizem a orientação contra os da Pinnacle17 não usa a ligação", async () => {
    await ligar();
    const fixture = await casarLigado([ligado()], { teams: { home: "Alfa", away: "Beta" } });
    expect(fixture.kind === "matched" ? fixture.source : fixture.kind).not.toBe("catalog_link");
  });

  it("aposta com o jogo já vinculado fica com ele, não com o da ligação", async () => {
    await ligar();
    const outro = { ...ligado(), match_id: "fs-vinculado" };
    await expect(casarLigado([ligado(), outro], { knownMatchId: "fs-vinculado" })).resolves.toMatchObject({
      kind: "matched", source: "result_match", candidate: { match: { match_id: "fs-vinculado" } },
    });
  });
});
