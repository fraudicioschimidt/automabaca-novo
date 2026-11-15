import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANCHOR_SIDE_FLOOR,
  betDeclaresCategoryFixtureLacks,
  canonicalizeTeamName,
  categoryTokensFromLeague,
  leagueCoversBetCategory,
  teamSimilarity,
  teamSimilarityCanon,
} from "@/src/domain/text";
import { prepareBridgeMatches, scorePreparedCandidates } from "@/src/providers/bridgeodds/scoring";
import type { BridgeMatch, BridgeQueryPage } from "@/src/providers/bridgeodds/types";

const score = (results: BridgeMatch[], home: string, away: string, kickoffUtc?: Date) =>
  scorePreparedCandidates(prepareBridgeMatches(results), home, away, kickoffUtc);

/** Fixture REAL capturada da API BridgeOdds. */
const page = JSON.parse(
  readFileSync(new URL("../fixtures/bridgeodds/connecticut-match.json", import.meta.url), "utf8"),
) as BridgeQueryPage;
const connecticut = page.results.find((m) => m.away === "Vermont Green")!;

describe("pontuação com dados reais", () => {
  it("casa o post do tipster COM TYPO ('Vermont Grenn') no match real ('Vermont Green')", () => {
    const scored = score(page.results, "AC Connecticut", "Vermont Grenn");
    expect(scored.length).toBeGreaterThan(0);
    expect(scored[0]!.match.away).toBe("Vermont Green");
    expect(scored[0]!.score).toBeGreaterThan(1.5);
    expect(scored[0]!.swapped).toBe(false);
  });

  it("não confunde com o outro jogo do Connecticut na mesma página", () => {
    const scored = score(page.results, "Connecticut Rush", "Boston Bolts");
    expect(scored[0]!.match.home).toBe("Connecticut Rush");
  });

  it("times sem relação ficam abaixo do piso", () => {
    expect(score(page.results, "Flamengo", "Palmeiras")).toHaveLength(0);
  });

  it("com kickoff confiável, fixture sem data válida não compete por nome", () => {
    const semData = { ...connecticut, match_date: "" } as BridgeMatch;
    const kickoff = new Date(connecticut.match_date);
    // Sem âncora de kickoff continua entrando (é o caminho de quem não tem hora).
    expect(score([semData], "AC Connecticut", "Vermont Green")).toHaveLength(1);
    // Com âncora, o que não dá para datar sai: homônimo em outra data venceria.
    expect(
      score([semData], "AC Connecticut", "Vermont Green", kickoff),
    ).toHaveLength(0);
    expect(
      score([connecticut], "AC Connecticut", "Vermont Green", kickoff),
    ).toHaveLength(1);
  });

  it("detecta home/away invertidos no post", () => {
    const scored = score(page.results, "Vermont Green", "AC Connecticut");
    expect(scored[0]!.swapped).toBe(true);
  });
});

/**
 * Time de CATEGORIA diferente não é candidato. A similaridade de categorias
 * protegidas diferentes é cravada em 0,35, que passa no piso de lado (0,3) e,
 * nos dois lados, soma exatamente o piso de soma (0,7): sem a recusa explícita,
 * o jogo feminino casava com o masculino.
 *
 * A regra é ASSIMÉTRICA: categoria escrita na APOSTA é informação do tipster, e
 * casar assim mesmo com fixture que não declara nada troca o time. O inverso é
 * variação de nome ("Celta Fortuna" é o "Celta Vigo II" do provider), e recusar
 * ali mandaria para a fila humana um casamento correto.
 */

const fixture = (home: string, away: string, league = "Liga: Teste"): BridgeMatch => ({
  match_id: 1,
  home,
  away,
  league,
  sport: "soccer",
  match_date: "2026-08-19T18:00:00Z",
} as BridgeMatch);

const casa = (aposta: [string, string], fix: [string, string], league?: string) =>
  score([fixture(fix[0], fix[1], league)], aposta[0], aposta[1]).length > 0;

/** Pares reais: a aposta declara a categoria, a fixture não. */
const APOSTA_DECLARA: ReadonlyArray<readonly [[string, string], [string, string]]> = [
  [["Botafogo (F)", "São Paulo (F)"], ["Botafogo FR RJ", "Sao Paulo"]],
  [["Uppsala F", "Malmo F"], ["Uppsala", "Malmo"]],
  [["River Plate 2", "Independiente 2"], ["River Plate", "Independiente"]],
  [["River Plate", "Independiente"], ["River Plate 2", "Independiente 2"]],
  [["Corinthians (F)", "Palmeiras (F)"], ["Corinthians", "Palmeiras"]],
];

/** O contra-peso: casamentos legítimos que NÃO podem cair junto. */
const CONTINUA_CASANDO: ReadonlyArray<readonly [[string, string], [string, string]]> = [
  // Feminino contra feminino: as duas pontas declaram, não há conflito.
  [["Botafogo (F)", "São Paulo (F)"], ["Botafogo FR RJ W", "Sao Paulo W"]],
  // A fixture é que declara — variação de NOME do time B, não do principal.
  [["Celta Fortuna", "Cadiz"], ["Celta Vigo II", "Cadiz"]],
  [["Espanyol B", "CE Manresa"], ["Espanyol II", "Manresa"]],
  // Canonização agressiva e correta, sem categoria envolvida.
  [["Fluminense (Bra)", "Ind. Rivadavia (Arg)"], ["Fluminense", "Independiente Rivadavia"]],
  [["Borussia M Gladbach", "Aston Villa"], ["Borussia Monchengladbach", "Aston Villa"]],
  [["Internacional", "Atletico-MG"], ["Internacional", "Atletico Mineiro"]],
];

describe("categoria declarada na aposta recusa a fixture do time principal", () => {
  it.each(APOSTA_DECLARA)("%j não casa com %j", (aposta, fix) => {
    expect(casa(aposta, fix), `"${aposta[0]}" casou com "${fix[0]}"`).toBe(false);
  });

  it.each(CONTINUA_CASANDO)("%j continua casando com %j", (aposta, fix) => {
    expect(casa(aposta, fix), `perdeu o casamento legítimo "${aposta[0]}"`).toBe(true);
  });

  /** Sem esta aritmética fixada, mexer num dos pisos reabriria o furo em silêncio. */
  it("o teto do mismatch cabe exatamente nos pisos do scoring — por isso a regra não é numérica", () => {
    const lado = teamSimilarity("Botafogo (F)", "Botafogo FR RJ");
    expect(lado).toBeCloseTo(0.35, 5);
    expect(lado, "0,35 passa pelo piso de lado (0,3)").toBeGreaterThanOrEqual(0.3);
    expect(lado * 2, "dois lados somam o piso de soma (0,7)").toBeGreaterThanOrEqual(0.7);
  });

  it("a regra é assimétrica: quem declara é a aposta", () => {
    const canon = canonicalizeTeamName;
    expect(betDeclaresCategoryFixtureLacks(canon("Botafogo (F)"), canon("Botafogo FR RJ"))).toBe(true);
    expect(betDeclaresCategoryFixtureLacks(canon("Celta Fortuna"), canon("Celta Vigo II"))).toBe(false);
    expect(betDeclaresCategoryFixtureLacks(canon("Botafogo (F)"), canon("Botafogo W"))).toBe(false);
    expect(betDeclaresCategoryFixtureLacks(canon("Botafogo"), canon("Botafogo"))).toBe(false);
  });
});

/**
 * A categoria pode estar na COMPETIÇÃO em vez do nome do time: "Gimnasia L.P. 2
 * vs San Lorenzo 2" está no feed como "Gimnasia La Plata x San Lorenzo" dentro
 * de "Argentina - Liga Pro Reserves".
 *
 * A liga levanta só o descarte por categoria; os pisos de similaridade
 * continuam valendo, e por isso o feminino não volta pela janela: contra
 * fixture que não declara, `teamSimilarity` crava 0,35 por lado, abaixo do
 * piso de âncora (0,5).
 */
describe("categoria declarada pela liga da fixture", () => {
  const reservas: [string, string] = ["Gimnasia L.P. 2", "San Lorenzo 2"];
  const principais: [string, string] = ["Gimnasia La Plata", "San Lorenzo"];

  it("liga de reservas cobre o sufixo numérico da aposta", () => {
    expect(casa(reservas, principais, "Argentina - Liga Pro Reserves")).toBe(true);
  });

  it("liga do campeonato principal continua recusando", () => {
    expect(casa(reservas, principais, "Argentina - Liga Profesional")).toBe(false);
    expect(casa(reservas, principais)).toBe(false);
  });

  it("liga de OUTRA categoria não cobre: feminina não vale por reserva", () => {
    expect(casa(reservas, principais, "Argentina - Liga Femenina")).toBe(false);
  });

  it("divisão com numeral não é liga de reservas (Liga II romena, Liga 2 portuguesa)", () => {
    expect(casa(reservas, principais, "Romania - Liga II")).toBe(false);
    expect(casa(reservas, principais, "Portugal - Liga 2")).toBe(false);
  });

  it("liga feminina cobre a aposta feminina e casa os times limpos do feed", () => {
    expect(casa(["Botafogo (F)", "São Paulo (F)"], ["Botafogo FR RJ", "Sao Paulo"], "Brazil - Brasileiro Women"))
      .toBe(true);
  });

  it("liga masculina continua recusando a aposta feminina", () => {
    expect(casa(["Botafogo (F)", "São Paulo (F)"], ["Botafogo FR RJ", "Sao Paulo"], "Brazil - Serie A"))
      .toBe(false);
  });

  it("liga feminina recusa aposta masculina (anti-men isolation)", () => {
    expect(casa(["Botafogo", "São Paulo"], ["Botafogo FR RJ", "Sao Paulo"], "Brazil - Brasileiro Women"))
      .toBe(false);
  });

  it("vocabulário da liga: reservas, base por idade e feminino", () => {
    expect(categoryTokensFromLeague("Argentina - Liga Pro Reserves")).toEqual(new Set(["reserve_class"]));
    expect(categoryTokensFromLeague("USA - MLS Next Pro")).toEqual(new Set(["reserve_class"]));
    expect(categoryTokensFromLeague("Italy - Primavera 1")).toEqual(new Set(["reserve_class"]));
    expect(categoryTokensFromLeague("Argentina - Torneo Sub 20")).toEqual(new Set(["u20"]));
    expect(categoryTokensFromLeague("England - U21 Premier League")).toEqual(new Set(["reserve_class"]));
    expect(categoryTokensFromLeague("Brazil - Brasileiro Women")).toEqual(new Set(["women"]));
    expect(categoryTokensFromLeague("Romania - Liga II")).toEqual(new Set());
    expect(categoryTokensFromLeague("Brazil - Serie A")).toEqual(new Set());
  });

  it("a liga só fala quando o NOME da fixture cala", () => {
    const canon = canonicalizeTeamName;
    // Nome da fixture declara: quem decide volta a ser a comparação de nomes.
    expect(leagueCoversBetCategory(canon("Gimnasia L.P. 2"), canon("Gimnasia La Plata II"), "Argentina - Liga Pro Reserves"))
      .toBe(false);
    // Aposta sem categoria: não há o que cobrir.
    expect(leagueCoversBetCategory(canon("Gimnasia La Plata"), canon("Gimnasia La Plata"), "Argentina - Liga Pro Reserves"))
      .toBe(false);
  });
});

/**
 * Lado âncora: `teamSimilarityCanon` devolve o escore de uma ramificação de
 * EVIDÊNCIA (igualdade, containment, substring canônica, dicionário, sempre
 * ≥ 0,85), o do resgate de digitação (≥ 0,85, que soma mas não ancora) ou o da
 * mistura jaccard/dice/containment, que mede parecença de texto e não afirma
 * identidade. Somar os dois lados
 * perde essa distinção: "Osset United vs Matlock Town" casava com "Ashton
 * United vs Whitby Town" (0,418 + 0,370). Lista de palavras genéricas
 * (united/town) não separa, porque recusaria typos e abreviações legítimos;
 * o que separa é exigir um lado ≥ `ANCHOR_SIDE_FLOOR`, que mora na faixa
 * vazia entre o pior caso fuzzy e a menor evidência real.
 */

function lado(providerName: string, betName: string): number {
  return teamSimilarityCanon(canonicalizeTeamName(providerName), canonicalizeTeamName(betName));
}

function anchorFixture(matchId: number, home: string, away: string): BridgeMatch {
  return {
    match_id: matchId,
    home,
    away,
    match_date: "2026-08-18T18:45:00Z",
    league: "England - Northern Premier League",
    sport: "Soccer",
  };
}

function candidatos(f: BridgeMatch, home: string, away: string) {
  return scorePreparedCandidates(
    [{
      match: f,
      homeCanon: canonicalizeTeamName(f.home),
      awayCanon: canonicalizeTeamName(f.away),
    }],
    home,
    away,
  );
}

describe("um confronto precisa de pelo menos um lado âncora", () => {
  it("recusa dois lados fuzzy somando acima do piso", () => {
    const hs = lado("Ashton United", "Osset United");
    const as = lado("Whitby Town", "Matlock Town");

    // A aritmética do caso, fixada: os dois lados fuzzy passam dos pisos e só a
    // âncora recusa. Sem estes números o portão vira opinião, e mexer em
    // SIDE_FLOOR/SUM_FLOOR reabriria o buraco calado.
    expect(hs).toBeGreaterThan(0.3);
    expect(as).toBeGreaterThan(0.3);
    expect(hs + as).toBeGreaterThan(0.7);
    expect(Math.max(hs, as)).toBeLessThan(ANCHOR_SIDE_FLOOR);

    expect(
      candidatos(anchorFixture(1633793705, "Ashton United", "Whitby Town"), "Osset United", "Matlock Town"),
      "quatro clubes diferentes aceitos por compartilharem United/Town",
    ).toEqual([]);
  });

  it("aceita o legítimo mais próximo da linha — typo dos DOIS lados", () => {
    // `Tvaaker vs Atvidaberg` × `Tvaakers vs Aatvidabergs`: o lado mais forte
    // vale 0,862, contra 0,418 do caso errado. Ancora pela substring (um nome
    // contido no outro), não pelo resgate de digitação.
    const hs = lado("Tvaakers", "Tvaaker");
    const as = lado("Aatvidabergs", "Atvidaberg");
    expect(Math.max(hs, as)).toBeGreaterThanOrEqual(ANCHOR_SIDE_FLOOR);
    expect(candidatos(anchorFixture(1, "Tvaakers", "Aatvidabergs"), "Tvaaker", "Atvidaberg")).toHaveLength(1);
  });

  it("aceita um lado forte carregando um lado fraco — a forma NORMAL", () => {
    // `Corinthians vs Basquete Unifae\\Sao Joao` × `Corinthians Paulista vs Sao
    // Jose`: lados 0,900 e 0,311. O lado fraco fica abaixo do âncora e deve
    // continuar passando — apelido, patrocinador e cidade omitida são a regra,
    // não a exceção. Exigir os dois lados fortes trocaria um bug por muitos.
    const as = lado("Sao Jose", "Basquete Unifae\\Sao Joao");
    expect(as).toBeLessThan(ANCHOR_SIDE_FLOOR);
    expect(
      candidatos(anchorFixture(2, "Corinthians Paulista", "Sao Jose"), "Corinthians", "Basquete Unifae\\Sao Joao"),
    ).toHaveLength(1);
  });

  it("o resgate de digitação soma, mas não ancora: Juventus × Juventud", () => {
    // O lado de digitação (0,875) com um lado fuzzy (0,418) passaria nos pisos
    // de candidato; sem evidência de nenhum lado, o par não entra.
    expect(lado("Juventud", "Juventus")).toBeGreaterThanOrEqual(0.85);
    expect(lado("Ashton United", "Osset United")).toBeLessThan(ANCHOR_SIDE_FLOOR);
    expect(candidatos(anchorFixture(3, "Juventud", "Ashton United"), "Juventus", "Osset United")).toEqual([]);
    // Com o outro lado casando por evidência, a digitação acompanha.
    expect(candidatos(anchorFixture(4, "Juventud", "Ashton United"), "Juventus", "Ashton United")).toHaveLength(1);
  });

  it("o piso mora na faixa que nenhuma ramificação de evidência alcança", () => {
    // Toda ramificação que AFIRMA identidade devolve ≥0.85. Se um dia alguma
    // passar a devolver menos, este piso deixa de significar "casou por
    // evidência" e vira número solto — é isto que a asserção protege.
    const evidencias: Array<[string, string]> = [
      ["Leeds United", "Leeds"],            // containment
      ["Newcastle Utd", "Newcastle United"], // igualdade após sinônimo
      ["Manchester City", "Manchester City"], // exato
    ];
    for (const [a, b] of evidencias) {
      expect(lado(a, b), `${a} × ${b}`).toBeGreaterThanOrEqual(0.85);
    }
    expect(ANCHOR_SIDE_FLOOR).toBeGreaterThan(0.418);
    expect(ANCHOR_SIDE_FLOOR).toBeLessThan(0.85);
  });
});

describe("BridgeOdds: gêmeo sub-19 no mesmo dia", () => {
  it("\"Porto vs Man City\" fica só com o jogo da Champions (caso real que ia ao Vincular)", () => {
    const base = { sport: "Futebol", home: "Porto", away: "Manchester City" };
    const scored = score([
      { ...base, match_id: 1, league: "UEFA - Youth League U19", match_date: "2026-09-08T11:00:00Z" },
      { ...base, match_id: 2, league: "UEFA - Champions League", match_date: "2026-09-08T19:00:00Z" },
    ] as BridgeMatch[], "Porto", "Manchester City", new Date("2026-09-08T19:00:00Z"));
    expect(scored.map((c) => c.match.match_id)).toEqual([2]);
  });
});

