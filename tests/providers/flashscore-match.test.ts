import { describe, expect, it } from "vitest";
import { findFlashscoreMatch } from "@/src/providers/flashscore/match";
import type { FlashscoreCatalogMatch, FlashscoreMatch } from "@/src/providers/flashscore/types";

const kickoff = new Date("2026-07-22T18:00:00Z");

function match(
  id: string,
  home: string,
  away: string,
  at = kickoff,
): FlashscoreMatch {
  return {
    match_id: id,
    timestamp: Math.floor(at.getTime() / 1_000),
    home_team: { team_id: `${id}-h`, name: home },
    away_team: { team_id: `${id}-a`, name: away },
    scores: { home: 1, away: 0 },
    match_status: {
      stage: "Finished",
      is_cancelled: false,
      is_postponed: false,
      is_started: true,
      is_in_progress: false,
      is_finished: true,
    },
  };
}

/** Partida do catálogo do dia, com o torneio que o FlashScore agrupa. */
function catalogMatch(
  id: string,
  home: { name: string; id: string },
  away: { name: string; id: string },
  tournament: string,
): FlashscoreCatalogMatch {
  return {
    ...match(id, home.name, away.name),
    home_team: { team_id: home.id, name: home.name },
    away_team: { team_id: away.id, name: away.name },
    tournament: { id: `t-${id}`, name: tournament, countryName: tournament.split(":")[0] ?? null },
  };
}

describe("pareamento FlashScore", () => {
  it("encontra nomes equivalentes e identifica lados invertidos", () => {
    const found = findFlashscoreMatch({
      matches: [match("m1", "Operario Ferroviario", "Athletic Club")],
      home: "Athletic Club",
      away: "Operario Ferroviario",
      kickoffUtc: kickoff,
      minScore: 1.5,
    });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.best.match.match_id).toBe("m1");
      expect(found.best.swapped).toBe(true);
      expect(found.best.score).toBeGreaterThanOrEqual(1.9);
    }
  });

  it("recusa dois candidatos praticamente empatados", () => {
    const found = findFlashscoreMatch({
      matches: [
        match("m1", "France", "England"),
        match("m2", "France", "England"),
      ],
      home: "France",
      away: "England",
      kickoffUtc: kickoff,
      minScore: 1.5,
    });
    expect(found).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("ignora partida semelhante fora da janela de kickoff", () => {
    const found = findFlashscoreMatch({
      matches: [match("m1", "France", "England", new Date("2026-07-24T18:00:00Z"))],
      home: "France",
      away: "England",
      kickoffUtc: kickoff,
      minScore: 1.5,
    });
    expect(found).toEqual({ ok: false, reason: "no_candidate" });
  });

  it("normaliza abreviação, país e erro simples no Independiente Medellin", () => {
    const found = findFlashscoreMatch({
      matches: [match("m1", "Ind. Medellin (Col)", "Vasco (Bra)")],
      home: "Indepediente medelin",
      away: "Vasco",
      kickoffUtc: kickoff,
      minScore: 1.5,
    });
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.best.match.match_id).toBe("m1");
  });

  it("remove sufixo estadual do FlashScore sem colapsar o adversário", () => {
    const found = findFlashscoreMatch({
      matches: [match("m1", "Operario-PR", "Ponte Preta")],
      home: "Operario Ferroviario",
      away: "Ponte Preta",
      kickoffUtc: kickoff,
      minScore: 1.5,
    });
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.best.match.match_id).toBe("m1");
  });

  it("prioriza ids já aprendidos mesmo quando os nomes mudam", () => {
    const found = findFlashscoreMatch({
      matches: [
        match("m1", "Nome completamente novo", "Outro nome"),
        match("m2", "Operario Ferroviario", "Ponte Preta"),
      ],
      home: "Operario Ferroviario",
      away: "Ponte Preta",
      kickoffUtc: kickoff,
      minScore: 1.5,
      expectedTeamIds: { home: "m1-h", away: "m1-a" },
    });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.best.match.match_id).toBe("m1");
      expect(found.best.strategy).toBe("provider_id");
    }
  });

  it("usa um único team_id conhecido sem dispensar a validação do adversário", () => {
    const renamed = match("m1", "Nome novo do Operario", "Ponte Preta");
    const found = findFlashscoreMatch({
      matches: [
        renamed,
        match("m2", "Operario Ferroviario", "Ponte Preta"),
      ],
      home: "Operario Ferroviario",
      away: "Ponte Preta",
      kickoffUtc: kickoff,
      minScore: 1.5,
      expectedTeamIds: { home: renamed.home_team.team_id, away: null },
    });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.best.match.match_id).toBe("m1");
      expect(found.best.strategy).toBe("provider_id_partial");
    }
  });

  it("não volta ao fuzzy quando o team_id conhecido contradiz os candidatos", () => {
    // Uma passada só: a volta aos nomes, quando o id é dica, é de
    // `findFlashscoreCandidateWithAdjacentDays`.
    const found = findFlashscoreMatch({
      matches: [match("m1", "Operario Ferroviario", "Ponte Preta")],
      home: "Operario Ferroviario",
      away: "Ponte Preta",
      kickoffUtc: kickoff,
      minScore: 1.5,
      expectedTeamIds: { home: "outro-team-id", away: null },
    });
    expect(found).toEqual({ ok: false, reason: "no_candidate" });
  });

  it("com os dois ids esperados e só um batendo, o que bateu ancora e o outro lado vale pelo nome", () => {
    const found = findFlashscoreMatch({
      matches: [match("m1", "Operario Ferroviario", "Ponte Preta")],
      home: "Operario Ferroviario",
      away: "Ponte Preta",
      kickoffUtc: kickoff,
      minScore: 1.5,
      expectedTeamIds: { home: "outro-team-id", away: "m1-a" },
    });
    expect(found).toMatchObject({ ok: true, best: { match: { match_id: "m1" }, strategy: "provider_id_partial" } });
  });

  it("com os dois ids esperados, o outro lado com outro id só passa com nome quase idêntico", () => {
    // Ficha do Inter errada (aponta o Inter de Limeira), a do Grêmio certa; o
    // Gre-Nal não está no catálogo: o homônimo não pode liquidar a aposta.
    const found = findFlashscoreMatch({
      matches: [{
        ...match("m1", "Inter de Limeira", "Gremio Novorizontino"),
        home_team: { team_id: "limeira", name: "Inter de Limeira" },
        away_team: { team_id: "novorizontino", name: "Gremio Novorizontino" },
      }],
      home: "Inter",
      away: "Gremio",
      kickoffUtc: kickoff,
      minScore: 1.5,
      expectedTeamIds: { home: "limeira", away: "gremio" },
    });
    expect(found.ok).toBe(false);
  });

  it("mantém pendente quando um team_id parcial ainda encontra dois jogos ambíguos", () => {
    const first = match("m1", "Operario Ferroviario", "Ponte Preta");
    const second = match("m2", "Operario Ferroviario", "Ponte Preta");
    second.home_team.team_id = first.home_team.team_id;
    const found = findFlashscoreMatch({
      matches: [first, second],
      home: "Operario Ferroviario",
      away: "Ponte Preta",
      kickoffUtc: kickoff,
      minScore: 1.5,
      expectedTeamIds: { home: first.home_team.team_id, away: null },
    });
    expect(found).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("não casa o time reserva (sufixo 2) com o principal por similaridade", () => {
    const found = findFlashscoreMatch({
      matches: [match("m1", "River Plate 2", "Independiente 2")],
      home: "River Plate",
      away: "Independiente",
      kickoffUtc: kickoff,
      minScore: 1.5,
    });
    expect(found).toEqual({ ok: false, reason: "no_candidate" });
  });

  it("o II da Pinnacle na aposta acha o B do FlashScore, e o time B não vira o principal", () => {
    const reserve = findFlashscoreMatch({
      matches: [match("m1", "FC Porto B", "Vizela"), match("m2", "FC Porto", "Vizela")],
      home: "Porto II",
      away: "Vizela",
      kickoffUtc: kickoff,
      minScore: 1.5,
    });
    expect(reserve.ok && reserve.best.match.match_id).toBe("m1");
    const main = findFlashscoreMatch({
      matches: [match("m1", "FC Porto B", "Vizela")],
      home: "Porto",
      away: "Vizela",
      kickoffUtc: kickoff,
      minScore: 1.5,
    });
    expect(main).toEqual({ ok: false, reason: "no_candidate" });
  });

  it("a aposta com os nomes da Pinnacle acha o jogo que o FlashScore abrevia pela inicial", () => {
    const found = findFlashscoreMatch({
      matches: [match("m1", "Colo Colo", "A. Italiano"), match("m2", "Colo Colo", "Cobreloa")],
      home: "Colo Colo",
      away: "Audax Italiano",
      kickoffUtc: kickoff,
      minScore: 1.5,
    });
    expect(found.ok && found.best.match.match_id).toBe("m1");
  });

  it("digitação num lado com o outro lado sem evidência não é candidato", () => {
    const found = findFlashscoreMatch({
      matches: [match("m1", "Juventud", "Ashton United")],
      home: "Juventus",
      away: "Osset United",
      kickoffUtc: kickoff,
      minScore: 1,
    });
    expect(found).toEqual({ ok: false, reason: "no_candidate" });
  });

  it("não casa reserva no lado desconhecido quando só um team_id é conhecido", () => {
    const found = findFlashscoreMatch({
      matches: [match("m1", "River Plate", "Independiente 2")],
      home: "River Plate",
      away: "Independiente",
      kickoffUtc: kickoff,
      minScore: 1.5,
      expectedTeamIds: { home: "m1-h", away: null },
    });
    expect(found).toEqual({ ok: false, reason: "no_candidate" });
  });
});

/**
 * A categoria lida na competição. A Pinnacle chama de "Chelsea" o time da
 * "Champions League Women" (é assim que o evento da aposta fica depois da
 * identidade), e o FlashScore, de "Chelsea W". Os dois jogos reais abaixo
 * (23/09) ficaram sem candidato: sem a liga, "Chelsea" × "Chelsea W" vale 0,35.
 */
describe("categoria da aposta na busca do FlashScore", () => {
  const liga = "EUROPE: UEFA Champions League Women - League phase";
  const championsFeminina = [
    catalogMatch("f1NKO2mg", { name: "Chelsea W", id: "Q7Hu2UDD" }, { name: "Austria Vienna W", id: "21HejI2E" }, liga),
    catalogMatch("CvejSdBr", { name: "Barcelona W", id: "YFBOvfnB" }, { name: "Paris FC W", id: "djTazozI" }, liga),
  ];

  it.each([
    ["Chelsea", "Austria Vienna", "f1NKO2mg"],
    ["FC Barcelona", "Paris FC", "CvejSdBr"],
  ] as const)("%s × %s da liga feminina acha o jogo feminino", (home, away, id) => {
    const found = findFlashscoreMatch({
      matches: championsFeminina,
      home,
      away,
      kickoffUtc: kickoff,
      minScore: 1.5,
      competition: "Champions League Women",
    });
    expect(found).toMatchObject({ ok: true, best: { match: { match_id: id }, strategy: "fuzzy" } });
    if (found.ok) expect(found.best.score).toBeGreaterThanOrEqual(1.9);
  });

  it("sem a liga, ou com a liga masculina, o jogo feminino não é candidato", () => {
    for (const competition of [undefined, "Premier League"]) {
      expect(findFlashscoreMatch({
        matches: championsFeminina,
        home: "Chelsea",
        away: "Austria Vienna",
        kickoffUtc: kickoff,
        minScore: 1.5,
        competition,
      })).toEqual({ ok: false, reason: "no_candidate" });
    }
  });

  it("o id do time masculino não liquida o jogo feminino listado com ele", () => {
    const comIdsDoMasculino = catalogMatch(
      "fs-w",
      { name: "Tottenham W", id: "male-tot" },
      { name: "Arsenal W", id: "male-ars" },
      "ENGLAND: WSL",
    );
    for (const competition of ["Premier League", ""]) {
      expect(findFlashscoreMatch({
        matches: [comIdsDoMasculino],
        home: "Tottenham",
        away: "Arsenal",
        kickoffUtc: kickoff,
        minScore: 1.5,
        expectedTeamIds: { home: "male-tot", away: "male-ars" },
        competition,
      })).toEqual({ ok: false, reason: "no_candidate" });
    }
  });

  it("a liga de reservas da aposta acha o time com o dígito do FlashScore", () => {
    const reservas = [catalogMatch(
      "r1",
      { name: "Gimnasia L.P. 2", id: "gim-2" },
      { name: "Aldosivi 2", id: "ald-2" },
      "ARGENTINA: Reserve League - Clausura",
    )];
    expect(findFlashscoreMatch({
      matches: reservas,
      home: "Gimnasia L.P.",
      away: "Aldosivi",
      kickoffUtc: kickoff,
      minScore: 1.5,
      competition: "Liga Pro Reserves",
    })).toMatchObject({ ok: true, best: { match: { match_id: "r1" } } });
    expect(findFlashscoreMatch({
      matches: reservas,
      home: "Gimnasia L.P.",
      away: "Aldosivi",
      kickoffUtc: kickoff,
      minScore: 1.5,
      competition: "Liga Profesional",
    })).toEqual({ ok: false, reason: "no_candidate" });
  });

  it("o amador (Am) não é o principal, e o sufixo de país continua saindo", () => {
    const austria = [
      catalogMatch("principal", { name: "Austria Vienna", id: "aw" }, { name: "Rapid Vienna", id: "rw" }, "AUSTRIA: Bundesliga"),
      catalogMatch("amador", { name: "Austria Vienna (Am)", id: "aw-am" }, { name: "Rapid Vienna (Am)", id: "rw-am" }, "AUSTRIA: 2. Liga"),
    ];
    expect(findFlashscoreMatch({
      matches: austria,
      home: "Austria Vienna",
      away: "Rapid Vienna",
      kickoffUtc: kickoff,
      minScore: 1.5,
      competition: "Bundesliga",
    })).toMatchObject({ ok: true, best: { match: { match_id: "principal" } } });
    expect(findFlashscoreMatch({
      matches: [catalogMatch("fr", { name: "Lyon W (Fra)", id: "l" }, { name: "PSG W (Fra)", id: "p" }, "WORLD: Club Friendly Women")],
      home: "Lyon",
      away: "PSG",
      kickoffUtc: kickoff,
      minScore: 1.5,
      competition: "Club Friendly Women",
    })).toMatchObject({ ok: true, best: { match: { match_id: "fr" } } });
  });
});

describe("FlashScore: principal × feminino no mesmo dia", () => {
  it("sem marca no post, o jogo principal vence o feminino dos mesmos clubes", () => {
    const found = findFlashscoreMatch({
      matches: [
        catalogMatch("fem", { name: "Juventus W", id: "juv-w" }, { name: "Inter W", id: "int-w" }, "ITALY: Serie A Women"),
        catalogMatch("masc", { name: "Juventus", id: "juv" }, { name: "Inter", id: "int" }, "ITALY: Serie A"),
      ],
      home: "Juventus",
      away: "Inter",
      kickoffUtc: kickoff,
      minScore: 1.5,
    });
    expect(found.ok && found.best.match.match_id).toBe("masc");
  });
});

