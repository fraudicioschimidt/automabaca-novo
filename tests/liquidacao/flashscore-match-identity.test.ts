import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlashscoreDateWindowError } from "@/src/providers/flashscore/date-window";
import type { FlashscoreMatch } from "@/src/providers/flashscore/types";

const mocks = vi.hoisted(() => ({ warn: vi.fn(), resolveTeams: vi.fn(), applyTeamAliases: vi.fn() }));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => ({ warn: mocks.warn }) }));
// A busca pede o FlashScore e a Pinnacle numa consulta só: o mesmo mock responde aos dois.
vi.mock("@/src/services/teams/resolve", () => ({
  resolveTeamsForProviders: async (teams: unknown, providers: readonly string[], context: unknown) =>
    Promise.all(providers.map((provider) => mocks.resolveTeams(teams, provider, context))),
}));
vi.mock("@/src/services/sharp/enrich/identity-cache", () => ({
  pinnacleTeamsFrom: (teams: unknown) => mocks.applyTeamAliases(teams),
}));

import {
  expectedFlashscoreTeamIds,
  findFlashscoreCandidateWithAdjacentDays,
  findFlashscoreMatchByIdWithAdjacentDays,
  prepareFlashscoreIdentitySearch,
} from "@/src/services/settlement/flashscore/match-identity";
import type { ResolvedProviderTeam, ResolvedTeamsForProvider } from "@/src/services/teams/types";

beforeEach(() => {
  mocks.warn.mockReset();
});

describe("dias vizinhos do catálogo", () => {
  const base = { matches: [], sportId: 12, day: "2026-09-19" };

  it("pula o dia fora do horizonte do provider nas duas buscas, sem alertar", async () => {
    const loadMatches = vi.fn(async (_sport: number, day: string) => {
      if (day === "2026-09-20") throw new FlashscoreDateWindowError(day, new Date("2026-09-13T03:00:00Z"));
      return [];
    });
    expect(await findFlashscoreCandidateWithAdjacentDays({ ...base, loadMatches, home: "A", away: "B", kickoffUtc: new Date(), minScore: 1.5, expectedTeamIds: { home: null, away: null } })).toEqual({ ok: false, reason: "no_candidate" });
    expect(await findFlashscoreMatchByIdWithAdjacentDays({ ...base, loadMatches, matchId: "match" })).toBeNull();
    expect(loadMatches).toHaveBeenCalledTimes(4);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("avisa a falha de um dia vizinho uma vez por busca, não por passada", async () => {
    const failure = new Error("network unavailable");
    const loadMatches = vi.fn(async () => { throw failure; });
    await findFlashscoreCandidateWithAdjacentDays({
      ...base, loadMatches, home: "A", away: "B", kickoffUtc: new Date("2026-09-19T18:00:00Z"), minScore: 1.5,
      expectedTeamIds: { home: "id-a", away: null },
    });
    // Passada pelo id e passada pelos nomes: cada dia vizinho é consultado e avisado uma vez.
    expect(loadMatches).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledTimes(2);
  });

  it("mantém visível a falha real ao consultar um dia vizinho", async () => {
    const failure = new Error("network unavailable");
    await findFlashscoreMatchByIdWithAdjacentDays({ ...base, matchId: "match", loadMatches: async () => { throw failure; } });
    expect(mocks.warn).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ err: failure }), expect.any(String));
  });
});

describe("kickoff provisório (horário do post no lugar do jogo)", () => {
  const match = (id: string, kickoff: string) => ({
    match_id: id, timestamp: new Date(kickoff).getTime() / 1000,
    home_team: { name: "Palmeiras", team_id: "home" }, away_team: { name: "Sao Paulo", team_id: "away" },
  }) as FlashscoreMatch;
  const base = { matches: [], home: "Palmeiras", away: "São Paulo", day: "2026-09-11", sportId: 1,
    kickoffUtc: new Date("2026-09-11T15:00:00Z"), minScore: 1.5, expectedTeamIds: { home: null, away: null } };

  it("encontra o jogo de amanhã quando o horário foi substituído pelo do post", async () => {
    const tomorrow = match("next", "2026-09-12T21:30:00Z");
    const loadMatches = async (_sport: number, day: string) => day === "2026-09-12" ? [tomorrow] : [];
    expect(await findFlashscoreCandidateWithAdjacentDays({ ...base, kickoffInferido: true, loadMatches })).toMatchObject({ ok: true, best: { match: { match_id: "next" } } });
    expect(await findFlashscoreCandidateWithAdjacentDays({ ...base, kickoffInferido: false, loadMatches })).toMatchObject({ ok: false });
  });

  it("não escolhe pelo horário provisório entre dois confrontos dos mesmos times", async () => {
    const today = match("today", "2026-09-11T21:30:00Z");
    const tomorrow = match("next", "2026-09-12T21:30:00Z");
    expect(await findFlashscoreCandidateWithAdjacentDays({ ...base, matches: [today], kickoffInferido: true,
      expectedTeamIds: { home: "home", away: "away" }, loadMatches: async (_sport, day) => day === "2026-09-12" ? [tomorrow] : [],
    })).toEqual({ ok: false, reason: "ambiguous" });
  });
});

/**
 * O id FlashScore que a ficha dá, no caminho real da busca (ids em todos os
 * dias, depois os nomes). Com um id só, ele é dica: sem partida decidida por
 * ele, os nomes decidem, como sem ficha. Com os dois, o id que aparece no
 * catálogo sem o jogo certo deixa a aposta para o dono; nenhum dos dois na
 * janela, os nomes decidem com o piso do pareamento.
 */
describe("id do store como dica", () => {
  const game = (id: string, ids: [string, string], kickoff: string, names = ["Nacional", "Liverpool"]) => ({
    match_id: id, timestamp: new Date(kickoff).getTime() / 1000,
    home_team: { name: names[0], team_id: ids[0] }, away_team: { name: names[1], team_id: ids[1] },
  }) as FlashscoreMatch;
  const base = { home: "Nacional", away: "Liverpool", day: "2026-09-11", sportId: 1, minScore: 1.5,
    kickoffUtc: new Date("2026-09-11T23:30:00Z") };
  const semVizinhos = async () => [];

  it("o id acha o jogo no dia vizinho antes de o nome escolher o homônimo do dia", async () => {
    const homonimo = game("homonimo", ["nacional-xx", "liverpool-xx"], "2026-09-11T20:00:00Z");
    const certo = game("certo", ["nacional-uy", "liverpool-uy"], "2026-09-12T00:30:00Z");
    const loadMatches = async (_sport: number, day: string) => day === "2026-09-12" ? [certo] : [];
    await expect(findFlashscoreCandidateWithAdjacentDays({
      ...base, matches: [homonimo], loadMatches, expectedTeamIds: { home: "nacional-uy", away: "liverpool-uy" },
    })).resolves.toMatchObject({ ok: true, best: { match: { match_id: "certo" }, strategy: "provider_id" } });
  });

  it("com os dois ids, a partida com os dois no dia vizinho vem antes da parcial do dia", async () => {
    const parcial = game("parcial", ["nacional-uy", "liverpool-xx"], "2026-09-11T19:30:00Z");
    const certo = game("certo", ["nacional-uy", "liverpool-uy"], "2026-09-12T00:30:00Z");
    const ids = { home: "nacional-uy", away: "liverpool-uy" };
    const loadMatches = async (_sport: number, day: string) => day === "2026-09-12" ? [certo] : [];
    await expect(findFlashscoreCandidateWithAdjacentDays({ ...base, matches: [parcial], loadMatches, expectedTeamIds: ids }))
      .resolves.toMatchObject({ ok: true, best: { match: { match_id: "certo" }, strategy: "provider_id" } });
    await expect(findFlashscoreCandidateWithAdjacentDays({ ...base, matches: [parcial], loadMatches: semVizinhos, expectedTeamIds: ids }))
      .resolves.toMatchObject({ ok: true, best: { match: { match_id: "parcial" }, strategy: "provider_id_partial" } });
  });

  it("id certo escolhe o certo entre homônimos no mesmo dia", async () => {
    const outro = game("xx", ["nacional-xx", "liverpool-xx"], "2026-09-11T23:30:00Z");
    const uruguai = game("uy", ["nacional-uy", "liverpool-uy"], "2026-09-11T23:30:00Z");
    const params = { ...base, matches: [outro, uruguai], loadMatches: semVizinhos };
    await expect(findFlashscoreCandidateWithAdjacentDays({ ...params, expectedTeamIds: { home: null, away: null } }))
      .resolves.toEqual({ ok: false, reason: "ambiguous" });
    await expect(findFlashscoreCandidateWithAdjacentDays({ ...params, expectedTeamIds: { home: "nacional-uy", away: "liverpool-uy" } }))
      .resolves.toMatchObject({ ok: true, best: { match: { match_id: "uy" }, strategy: "provider_id" } });
    await expect(findFlashscoreCandidateWithAdjacentDays({ ...params, expectedTeamIds: { home: null, away: "liverpool-uy" } }))
      .resolves.toMatchObject({ ok: true, best: { match: { match_id: "uy" }, strategy: "provider_id_partial" } });
  });

  it("com um id só, errado, os nomes acham o jogo como com o store vazio", async () => {
    const semId = game("sem-id", ["nacional-xx", "liverpool-xx"], "2026-09-11T23:30:00Z");
    await expect(findFlashscoreCandidateWithAdjacentDays({
      ...base, matches: [semId], loadMatches: semVizinhos, expectedTeamIds: { home: "nacional-uy", away: null },
    })).resolves.toMatchObject({ ok: true, best: { match: { match_id: "sem-id" }, strategy: "fuzzy" } });
  });

  it("com os dois ids fora de toda partida da janela, a ficha não veta: os nomes decidem com o piso do pareamento", async () => {
    const semId = game("sem-id", ["nacional-xx", "liverpool-xx"], "2026-09-11T23:30:00Z");
    const ids = { home: "nacional-uy", away: "liverpool-uy" };
    await expect(findFlashscoreCandidateWithAdjacentDays({ ...base, matches: [semId], loadMatches: semVizinhos, expectedTeamIds: ids }))
      .resolves.toMatchObject({ ok: true, best: { match: { match_id: "sem-id" }, strategy: "fuzzy" } });
    // Dois jogos com os mesmos nomes: sem folga, ninguém liquida.
    const outro = game("outro", ["nacional-yy", "liverpool-yy"], "2026-09-11T22:30:00Z");
    await expect(findFlashscoreCandidateWithAdjacentDays({ ...base, matches: [semId, outro], loadMatches: semVizinhos, expectedTeamIds: ids }))
      .resolves.toEqual({ ok: false, reason: "ambiguous" });
    // Os dois nomes só contidos nos do FlashScore (0,90 cada, nenhum lado idêntico): não liquida.
    const parecido = game("parecido", ["n", "l"], "2026-09-11T23:30:00Z", ["Nacional Potosi", "Liverpool Montevideo"]);
    await expect(findFlashscoreCandidateWithAdjacentDays({ ...base, matches: [parecido], loadMatches: semVizinhos, expectedTeamIds: ids }))
      .resolves.toMatchObject({ ok: false });
  });

  it("com os dois ids e um deles numa partida da janela, a falta do jogo certo fica para o dono", async () => {
    const semId = game("sem-id", ["nacional-xx", "liverpool-xx"], "2026-09-11T23:30:00Z");
    const doNacional = game("do-nacional", ["nacional-uy", "penarol"], "2026-09-11T18:00:00Z", ["Nacional", "Penarol"]);
    await expect(findFlashscoreCandidateWithAdjacentDays({
      ...base, matches: [semId, doNacional], loadMatches: semVizinhos, expectedTeamIds: { home: "nacional-uy", away: "liverpool-uy" },
    })).resolves.toEqual({ ok: false, reason: "no_candidate" });
  });

  it("na parcial, o lado sem âncora vale pelo mais parecido entre o nome traduzido, o cru e as alternativas", async () => {
    const jogo = game("jogo", ["nacional-uy", "liverpool-uy"], "2026-09-11T23:30:00Z", ["Nacional", "Liverpool Montevideo"]);
    const params = {
      ...base, away: "Reds", matches: [jogo], loadMatches: semVizinhos, expectedTeamIds: { home: "nacional-uy", away: null },
    };
    await expect(findFlashscoreCandidateWithAdjacentDays(params)).resolves.toMatchObject({ ok: false });
    await expect(findFlashscoreCandidateWithAdjacentDays({ ...params, alternatives: { home: [], away: ["Liverpool Montevideo"] } }))
      .resolves.toMatchObject({ ok: true, best: { match: { match_id: "jogo" }, strategy: "provider_id_partial" } });
  });

  /**
   * Caso da produção: o alias FlashScore "Inter" (PROMOTED, Iw7eKK25) é a
   * Internazionale; o do Grêmio é certo. Inter de Limeira × Grêmio Novorizontino
   * é o homônimo que o nome acharia se o Gre-Nal faltasse no catálogo.
   */
  describe("Inter vs Grêmio com o id da Internazionale", () => {
    const greNal = game("gre-nal", ["internacional", "gremio"], "2026-09-11T23:30:00Z", ["Internacional", "Gremio"]);
    const limeira = game("limeira", ["inter-limeira", "novorizontino"], "2026-09-12T00:30:00Z",
      ["Inter de Limeira", "Gremio Novorizontino"]);
    const internazionale = game("inter-genoa", ["Iw7eKK25", "genoa"], "2026-09-11T19:00:00Z", ["Inter", "Genoa"]);
    const buscar = (matches: FlashscoreMatch[], expectedTeamIds: { home: string | null; away: string | null }) =>
      findFlashscoreCandidateWithAdjacentDays({
        ...base, home: "Inter", away: "Grêmio", matches, loadMatches: semVizinhos, expectedTeamIds,
      });

    it("com a ficha da Inter errada, nem o Gre-Nal liquida pelo nome parecido: fica para o dono", async () => {
      // O lado sem âncora tem outro id ("Inter" × "Internacional" não é quase
      // idêntico): pelos ids, é o mesmo quadro de Inter de Limeira × Grêmio
      // Novorizontino, que liquidaria o jogo errado.
      await expect(buscar([greNal, limeira, internazionale], { home: "Iw7eKK25", away: "gremio" }))
        .resolves.toMatchObject({ ok: false });
    });

    it("sem o Gre-Nal no catálogo, não liquida o homônimo: fica para o dono", async () => {
      await expect(buscar([limeira, internazionale], { home: "Iw7eKK25", away: "gremio" }))
        .resolves.toEqual({ ok: false, reason: "no_candidate" });
      // Nem sem a Internazionale: pelos nomes, "Inter" × "Inter de Limeira" não passa do piso de 0,85.
      await expect(buscar([limeira], { home: "Iw7eKK25", away: "gremio" }))
        .resolves.toMatchObject({ ok: false });
    });

    it("só com o id errado da Inter, os nomes decidem: acham o Gre-Nal", async () => {
      await expect(buscar([greNal, internazionale], { home: "Iw7eKK25", away: null }))
        .resolves.toMatchObject({ ok: true, best: { match: { match_id: "gre-nal" }, strategy: "fuzzy" } });
    });
  });

  it("a categoria continua dura nas duas passadas", async () => {
    const feminino = {
      ...game("w", ["chelsea", "arsenal"], "2026-09-11T23:30:00Z", ["Chelsea W", "Arsenal W"]),
      tournament: { id: "wsl", name: "ENGLAND: WSL", countryName: "England" },
    } as FlashscoreMatch;
    for (const expectedTeamIds of [{ home: "chelsea", away: "arsenal" }, { home: "chelsea", away: null }]) {
      await expect(findFlashscoreCandidateWithAdjacentDays({
        ...base, home: "Chelsea", away: "Arsenal", competition: "Premier League",
        matches: [feminino], loadMatches: semVizinhos, expectedTeamIds,
      })).resolves.toEqual({ ok: false, reason: "no_candidate" });
    }
  });
});

describe("id FlashScore da ficha só na categoria da aposta", () => {
  function viaAlias(inputName: string, providerName: string, providerTeamId: string): ResolvedProviderTeam {
    return {
      inputName,
      resolvedName: providerName,
      cardId: `card-${providerName}`,
      providerTeamId,
      strategy: "pinnacle_name",
      alternativeNames: [],
    };
  }
  function resolved(home: ResolvedProviderTeam, away: ResolvedProviderTeam): ResolvedTeamsForProvider {
    return {
      home: home.resolvedName,
      away: away.resolvedName,
      homeResolution: home,
      awayResolution: away,
    };
  }
  // As fichas da produção: os ids são dos times MASCULINOS.
  const chelsea = resolved(
    viaAlias("Chelsea", "Chelsea", "4fGZN2oK"),
    viaAlias("Austria Vienna", "Austria Vienna", "lvnOzIkE"),
  );
  const teams = { home: "Chelsea", away: "Austria Vienna" };

  it("a aposta da Champions feminina não usa o id do masculino", () => {
    expect(expectedFlashscoreTeamIds({ teams, resolved: chelsea, competicao: "Champions League Women" }))
      .toEqual({ home: null, away: null });
  });

  it("a aposta do masculino usa o id que a ficha conhece", () => {
    expect(expectedFlashscoreTeamIds({ teams, resolved: chelsea, competicao: "Champions League" }))
      .toEqual({ home: "4fGZN2oK", away: "lvnOzIkE" });
  });

  it("o id da ficha feminina vale na aposta feminina, e o do reserva na liga de reservas", () => {
    // "Arsenal W" traduzido para o "Arsenal" masculino: esse id não vale.
    expect(expectedFlashscoreTeamIds({
      teams: { home: "Chelsea W", away: "Arsenal W" },
      resolved: resolved(viaAlias("Chelsea W", "Chelsea W", "Q7Hu2UDD"), viaAlias("Arsenal W", "Arsenal", "men-ars")),
      competicao: "",
    })).toEqual({ home: "Q7Hu2UDD", away: null });
    expect(expectedFlashscoreTeamIds({
      teams: { home: "Gimnasia La Plata", away: "Aldosivi" },
      resolved: resolved(
        viaAlias("Gimnasia La Plata", "Gimnasia L.P. 2", "gim-2"),
        viaAlias("Aldosivi", "Aldosivi", "ald"),
      ),
      competicao: "Liga Pro Reserves",
    })).toEqual({ home: "gim-2", away: null });
  });
});

/**
 * O nome com mais de uma ficha busca pela tradução Pinnacle (seleções
 * nacionais), e o lado sem ficha também.
 */
it("o lado ambíguo ou sem ficha busca pela tradução Pinnacle", async () => {
  const resolution = (inputName: string, strategy: "ambiguous" | "original"): ResolvedProviderTeam => ({
    inputName, resolvedName: inputName, cardId: null, providerTeamId: null, strategy, alternativeNames: [],
  });
  mocks.resolveTeams.mockResolvedValue({
    home: "Brasil", away: "Gremio",
    homeResolution: resolution("Brasil", "ambiguous"), awayResolution: resolution("Gremio", "original"),
  });
  mocks.applyTeamAliases.mockResolvedValue({ home: "Brazil", away: "Gremio" });

  const search = await prepareFlashscoreIdentitySearch({
    teams: { home: "Brasil", away: "Gremio" },
    bet: { esporte: "Soccer", pais: "Brazil", competicao: "Serie A", data: new Date("2026-09-24T22:00:00Z") },
  });

  expect(search.searchTeams).toEqual({ home: "Brazil", away: "Gremio" });
  expect(search.resolved.homeResolution).toMatchObject({ strategy: "pinnacle_translation", resolvedName: "Brazil" });
  expect(search.resolved.awayResolution.strategy).toBe("original");
});
