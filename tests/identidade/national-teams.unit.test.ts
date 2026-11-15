import { describe, expect, it } from "vitest";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { matchDoubleChanceSelection } from "@/src/domain/settlement/sides";
import {
  canonicalCompetition,
  canonicalCountry,
  rewriteNationalTeamsInText,
  rewriteSelecaoWithMatchedTeams,
  translateNationalTeamPtToEn,
} from "@/src/domain/national-teams";

describe("translateNationalTeamPtToEn & canonicalCountry", () => {
  it("traduz seleções e países BR → Pinnacle EN", () => {
    expect(translateNationalTeamPtToEn("França")).toBe("France");
    expect(translateNationalTeamPtToEn("Marrocos")).toBe("Morocco");
    expect(translateNationalTeamPtToEn("Brasil")).toBe("Brazil");
    expect(translateNationalTeamPtToEn("Estados Unidos")).toBe("USA");
    expect(translateNationalTeamPtToEn("Países Baixos")).toBe("Netherlands");
  });

  it("canonicalCountry normaliza termos globais e países", () => {
    expect(canonicalCountry("Brasil")).toBe("Brazil");
    expect(canonicalCountry("Brazil")).toBe("Brazil");
    expect(canonicalCountry("BR")).toBe("Brazil");
    expect(canonicalCountry("Alemanha")).toBe("Germany");
    expect(canonicalCountry("Inglaterra")).toBe("England");
    expect(canonicalCountry("UK")).toBe("England");
    expect(canonicalCountry("United Kingdom")).toBe("England");
    expect(canonicalCountry("United States")).toBe("USA");
    expect(canonicalCountry("USA")).toBe("USA");
    expect(canonicalCountry("US")).toBe("USA");
    expect(canonicalCountry("Estados Unidos")).toBe("USA");
    expect(canonicalCountry("EUA")).toBe("USA");
    expect(canonicalCountry("South Korea")).toBe("South Korea");
    expect(canonicalCountry("Coreia do Sul")).toBe("South Korea");
    expect(canonicalCountry("Korea Republic")).toBe("South Korea");
    expect(canonicalCountry("UAE")).toBe("UAE");
    expect(canonicalCountry("United Arab Emirates")).toBe("UAE");
    expect(canonicalCountry("Mundo")).toBe("World");
    expect(canonicalCountry("Internacional")).toBe("International");
    expect(canonicalCountry("Não especificado")).toBe("Not specified");
  });

  it("é insensível a acento/caixa", () => {
    expect(translateNationalTeamPtToEn("FRANCA")).toBe("France");
    expect(translateNationalTeamPtToEn("marrocos")).toBe("Morocco");
  });

  it("não inventa clube", () => {
    expect(translateNationalTeamPtToEn("Flamengo")).toBeNull();
    expect(translateNationalTeamPtToEn("")).toBeNull();
  });
});

describe("canonicalCompetition", () => {
  it.each([
    ["BÉLGICA: Challenger Pro League", "Challenger Pro League"],
    ["COLÔMBIA: Primera A - Play Offs", "Primera A"],
    ["SUÍÇA: Super League", "Super League"],
  ])("normaliza prefixo de país com acento: %s", (input, expected) => {
    expect(canonicalCompetition(input)).toBe(expected);
    expect(canonicalCompetition(input.normalize("NFD"))).toBe(expected);
  });

  it("normaliza competições para o padrão Pinnacle/EN", () => {
    expect(canonicalCompetition("MLS")).toBe("Major League Soccer");
    expect(canonicalCompetition("Major League Soccer")).toBe("Major League Soccer");
    expect(canonicalCompetition("USA - Major League Soccer", "USA")).toBe("Major League Soccer");
    expect(canonicalCompetition("Campeonato Paulista")).toBe("Paulista A1");
    expect(canonicalCompetition("Campeonato Brasileiro")).toBe("Serie A");
    expect(canonicalCompetition("PORTUGAL: Liga Portugal Betclic")).toBe("Primeira Liga");
    expect(canonicalCompetition("PORTUGAL: Liga Portugal 2")).toBe("Liga Portugal 2");
    expect(canonicalCompetition("Copa do Brasil")).toBe("Copa do Brasil");
    expect(canonicalCompetition("Campeonato Europeu Feminino")).toBe("EuroVolley Women");
    expect(canonicalCompetition("Copa Sul-Americana")).toBe("Copa Sudamericana");
    expect(canonicalCompetition("Brazil - Serie A")).toBe("Serie A");
    expect(canonicalCompetition("Elite - Championship")).toBe("Elite - Championship");
  });

  it("país com caractere de regex vale como texto literal", () => {
    // O país pode vir cru da busca web; um parêntese solto não pode derrubar a resolução.
    for (const pais of ["Korea (Rep.", "?", "C++", "*"]) {
      expect(canonicalCompetition("K League 1", pais), pais).toBe("K League 1");
    }
    expect(canonicalCompetition("Korea (Rep.) - K League 1", "Korea (Rep.)")).toBe("K League 1");
  });
});

describe("rewriteSelecaoWithMatchedTeams", () => {
  it("reescreve AH com nomes locais → Pinnacle", () => {
    expect(
      rewriteSelecaoWithMatchedTeams({
        selecao: "França -1.0",
        localHome: "França",
        localAway: "Marrocos",
        pinnacleHome: "France",
        pinnacleAway: "Morocco",
      }),
    ).toBe("France -1.0");
  });

  it("em re-enrich (evento já EN) ainda traduz nação PT na seleção", () => {
    expect(
      rewriteSelecaoWithMatchedTeams({
        selecao: "França -1.0",
        localHome: "France",
        localAway: "Morocco",
        pinnacleHome: "France",
        pinnacleAway: "Morocco",
      }),
    ).toBe("France -1.0");
  });

  it("rewriteNationalTeamsInText cobre multi-palavra", () => {
    expect(rewriteNationalTeamsInText("Estados Unidos +0.5")).toBe("USA +0.5");
    expect(rewriteNationalTeamsInText("Coreia do Sul -1")).toBe("South Korea -1");
  });

  it("não substitui alias dentro de outra palavra", () => {
    expect(
      rewriteSelecaoWithMatchedTeams({
        selecao: "Internacional +0.5",
        localHome: "Inter",
        localAway: "Milan",
        pinnacleHome: "Inter Milan",
        pinnacleAway: "AC Milan",
      }),
    ).toBe("Internacional +0.5");
  });

  it("não troca nome curto que é prefixo de outro clube", () => {
    const params = {
      localHome: "Real",
      localAway: "Barcelona",
      pinnacleHome: "Real Madrid",
      pinnacleAway: "FC Barcelona",
    };
    expect(rewriteSelecaoWithMatchedTeams({
      ...params,
      selecao: "Real Sociedad -0.5",
    })).toBe("Real Sociedad -0.5");
    expect(rewriteSelecaoWithMatchedTeams({
      ...params,
      selecao: "Real -0.5",
    })).toBe("Real Madrid -0.5");
  });

  describe("dupla chance depois do casamento com a Pinnacle", () => {
    const tipster = { home: "Verdao", away: "Santos" };
    const pinnacle = { home: "Palmeiras SP", away: "Santos FC" };
    /** A reescrita do casamento, com os times na ordem do fornecedor ou invertidos. */
    const afterMatch = (selecao: string, swapped: boolean) => rewriteSelecaoWithMatchedTeams({
      selecao,
      localHome: swapped ? tipster.away : tipster.home,
      localAway: swapped ? tipster.home : tipster.away,
      pinnacleHome: swapped ? pinnacle.away : pinnacle.home,
      pinnacleAway: swapped ? pinnacle.home : pinnacle.away,
    });

    it.each([false, true])("\"12\" (casa ou fora) troca os dois times, com os times invertidos: %s", (swapped) => {
      const captured = pinnacleizeSelecao({ selecao: "12", mercadoPinnacle: "Double Chance", evento: "Verdao vs Santos" });
      expect(captured).toBe("Verdao or Santos");
      expect(afterMatch(captured, swapped)).toBe("Palmeiras SP or Santos FC");
      expect(afterMatch("Verdao ou Santos", swapped)).toBe("Palmeiras SP ou Santos FC");
      expect(matchDoubleChanceSelection(afterMatch(captured, swapped), "Palmeiras SP vs Santos FC")).toEqual(["home", "away"]);
    });

    it.each([false, true])("1X e X2 continuam como eram, com os times invertidos: %s", (swapped) => {
      expect(afterMatch("Verdao or Draw", swapped)).toBe("Palmeiras SP or Draw");
      expect(afterMatch("Draw or Santos", swapped)).toBe("Draw or Santos FC");
    });

    it("o nome seguido de um time que não é o do jogo não é trocado", () => {
      expect(afterMatch("Verdao or Corinthians", false)).toBe("Verdao or Corinthians");
    });
  });

  it("só traduz na seleção a nação que é um dos times do jogo", () => {
    // Franca é clube de basquete: o jogo não tem a França.
    expect(rewriteSelecaoWithMatchedTeams({
      selecao: "Franca -5.5", localHome: "Mogi", localAway: "Franca", pinnacleHome: "Mogi das Cruzes", pinnacleAway: "Franca",
    })).toBe("Franca -5.5");
    expect(rewriteSelecaoWithMatchedTeams({
      selecao: "Brasil de Pelotas -0.5", localHome: "Brasil de Pelotas", localAway: "Pelotas",
      pinnacleHome: "Brasil de Pelotas", pinnacleAway: "Pelotas",
    })).toBe("Brasil de Pelotas -0.5");
    // Seleção de verdade continua traduzida, também no basquete.
    expect(rewriteSelecaoWithMatchedTeams({
      selecao: "França -5.5", localHome: "France", localAway: "Brazil", pinnacleHome: "France", pinnacleAway: "Brazil",
    })).toBe("France -5.5");
  });
});

describe("tradução de seleções nacionais e conflitos regionais", () => {
  it("reescreve Nova Inglaterra para New England sem quebrar Inglaterra isolada", () => {
    expect(rewriteNationalTeamsInText("Nova Inglaterra -1.5")).toBe("New England -1.5");
    expect(rewriteNationalTeamsInText("Inglaterra -1")).toBe("England -1");
  });
});
