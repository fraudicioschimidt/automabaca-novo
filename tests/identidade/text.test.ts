import { describe, expect, it } from "vitest";
import {
  TEAM_STOP_WORDS,
  bestSearchWord,
  canonicalizeTeamName,
  hasProtectedTeamCategoryConflict,
  matchTeamsWithCategoryContext,
  sameFixtureTeams,
  splitEventoTeams,
  TEAM_NAME_EQUIVALENTS,
  teamCategoryTokens,
  teamNameVariants,
  teamSideSimilarityCanon,
  teamSimilarity,
} from "@/src/domain/text";

describe("canonicalizeTeamName", () => {
  it("remove acentos, expande abreviações e preserva identidade numérica", () => {
    expect(canonicalizeTeamName("São Paulo FC")).toBe("sao paulo fc");
    expect(canonicalizeTeamName("Man Utd")).toBe("man united");
    expect(canonicalizeTeamName("Mainz 05")).toBe("mainz 05");
    expect(canonicalizeTeamName("Racing 01")).toBe("racing 01");
    expect(canonicalizeTeamName("Racing 02")).toBe("racing 02");
    expect(canonicalizeTeamName("Racing 01")).not.toBe(canonicalizeTeamName("Racing 02"));
    expect(teamSimilarity("Mainz 05", "Mainz")).toBeGreaterThanOrEqual(0.9);
  });

  it("trata W final como feminino sem corromper a inicial real do clube", () => {
    expect(canonicalizeTeamName("Arsenal W")).toBe("arsenal women");
    expect(canonicalizeTeamName("W Connection")).toBe("w connection");
  });

  it("trata F final como feminino sem corromper uma inicial interna", () => {
    expect(canonicalizeTeamName("Arsenal F")).toBe("arsenal women");
    expect(hasProtectedTeamCategoryConflict("Arsenal", "Arsenal F")).toBe(true);
    expect(canonicalizeTeamName("F Marinos")).toBe("f marinos");
  });

  it("preserva tokens protegidos (feminino, sub-20, time B)", () => {
    expect(canonicalizeTeamName("Corinthians Women")).toContain("women");
    expect(canonicalizeTeamName("Ajax U21")).toContain("u21");
    expect(canonicalizeTeamName("Barcelona B")).toContain("b");
  });

  it("unifica grafias equivalentes de base e feminino sem perder a categoria", () => {
    expect(canonicalizeTeamName("Flamengo Sub-20")).toBe("flamengo u20");
    expect(canonicalizeTeamName("Flamengo Sub 17")).toBe("flamengo u17");
    expect(canonicalizeTeamName("Flamengo Feminino")).toBe("flamengo women");
    expect(canonicalizeTeamName("Flamengo Femenina")).toBe("flamengo women");
    expect(teamSimilarity("Flamengo Sub-20", "Flamengo U20")).toBe(1);
    expect(teamSimilarity("Flamengo Feminino", "Flamengo Women")).toBe(1);
  });

});

describe("teamSimilarity", () => {
  it("subconjunto distintivo pontua alto: Bayern ⊂ Bayern Munich", () => {
    expect(teamSimilarity("Bayern", "Bayern Munich")).toBeGreaterThanOrEqual(0.9);
  });

  it("trata siglas de clubes em ligas secundárias como stop-words distintivas (MKS, TSV, KS)", () => {
    expect(TEAM_STOP_WORDS.has("mks")).toBe(true);
    expect(TEAM_STOP_WORDS.has("tsv")).toBe(true);
    expect(TEAM_STOP_WORDS.has("gks")).toBe(true);
    expect(teamSimilarity("MKS Piaseczno", "Piaseczno")).toBeGreaterThanOrEqual(0.9);
    expect(teamSimilarity("TSV Havelse", "Havelse")).toBeGreaterThanOrEqual(0.9);
  });

  it("stop-word compartilhada não engana: Real Madrid vs Real Betis", () => {
    expect(teamSimilarity("Real Madrid", "Real Betis")).toBeLessThan(0.5);
  });

  /**
   * Resgate por erro de digitação. O tipster escreve o nome à mão e um typo
   * dentro da palavra zera jaccard e containment, e a aposta trava com o jogo
   * encerrado e sem liquidar.
   *
   * Estes números vieram das apostas de produção. O par que DEVE casar mais
   * fraco dá 0.909; o par que NÃO PODE casar mais perigoso dá 0.818. O piso de
   * resgate (0.85) mora nessa folga — se alguém mexer nele, um destes quebra.
   */
  it("resgata erro de digitação do tipster", () => {
    for (const [errado, certo] of [
      ["Sherewsbury", "Shrewsbury"],
      ["Valladollid", "Valladolid"],
      ["Clemont Foot", "Clermont Foot"],
      ["Indepediente medelin", "Independiente Medellin"],
    ] as const) {
      expect(teamSimilarity(errado, certo), `${errado} → ${certo}`)
        .toBeGreaterThanOrEqual(0.85);
    }
  });

  it("times diferentes de nome parecido continuam reprovando", () => {
    // Os mais próximos do piso: 0.800 e 0.818 na distância de edição. Casar um
    // destes liquidaria a aposta com o placar de OUTRO jogo.
    for (const [a, b] of [
      ["America MG", "America RJ"],
      ["Atletico GO", "Atletico PR"],
      ["Real Madrid", "Real Betis"],
      ["Vasco", "Vaduz"],
    ] as const) {
      expect(teamSimilarity(a, b), `${a} vs ${b}`).toBeLessThan(0.85);
    }
  });

  it("categorias protegidas ficam longe do time principal", () => {
    for (const variante of ["Corinthians Women", "Corinthians U20", "Corinthians B"]) {
      expect(teamSimilarity(variante, "Corinthians")).toBeLessThan(0.45);
    }
    expect(teamSimilarity("Corinthians U20", "Corinthians U20")).toBe(1);
  });

  it("II / Youth / U23 são a mesma classe reserva; B não colapsa com U23", () => {
    expect(teamSimilarity("Adelaide United II", "Adelaide United Youth"))
      .toBeGreaterThanOrEqual(0.9);
    expect(teamSimilarity("Adelaide United II", "Adelaide United Reserves"))
      .toBeGreaterThanOrEqual(0.9);
    expect(teamSimilarity("Adelaide United II", "Adelaide United U23"))
      .toBeGreaterThanOrEqual(0.9);
    expect(teamSimilarity("Adelaide United II", "Adelaide United"))
      .toBeLessThan(0.45);
    expect(teamSimilarity("Adelaide United U23", "Adelaide United U20"))
      .toBeLessThan(0.45);
    // Time B ≠ U23 em várias ligas europeias — não unificar.
    expect(teamSimilarity("Barcelona B", "Barcelona U23")).toBeLessThan(0.45);
    expect(teamSimilarity("Flamengo Reservas", "Flamengo B")).toBeLessThan(0.45);
    expect(teamSimilarity("Flamengo Reserva", "Flamengo Reserves"))
      .toBeGreaterThanOrEqual(0.9);
  });

  it("idênticos = 1", () => {
    expect(teamSimilarity("Flamengo", "Flamengo")).toBe(1);
  });

  it("dicionário: o nome em português, a sigla do estado e a abreviação casam o nome do fornecedor", () => {
    // Casos das apostas do histórico que não casavam só pelo nome.
    for (const [tipster, fornecedor] of [
      ["Bayern de Munique", "Bayern Munich"],
      ["Inter de Milão", "Internazionale"],
      ["Rapid de Bucareste", "Rapid Bucuresti"],
      ["Hamburgo", "Hamburger SV"],
      ["Espanhol B", "Espanyol II"],
      ["Olympiacos", "Olympiakos BC"],
      ["Atlético-MG", "Atletico Mineiro"],
      ["Atletico-MG (Bra)", "Atletico Mineiro"],
      ["América-MG", "America Mineiro"],
      ["Athletico-PR", "Athletico Paranaense"],
      ["Operário PR", "Operario Ferroviario"],
      ["Man Utd", "Manchester United"],
      ["Man City", "Manchester City"],
      ["PSG", "Paris Saint-Germain"],
      ["Argentinos Jrs", "Argentinos Juniors"],
      ["Gimnasia LP", "Gimnasia La Plata"],
      ["FC Porto B", "Porto II"],
      ["villarreal b", "Villarreal II"],
    ] as const) {
      expect(teamSimilarity(tipster, fornecedor), `${tipster} → ${fornecedor}`).toBeGreaterThanOrEqual(0.85);
      expect(teamSimilarity(fornecedor, tipster), `${fornecedor} → ${tipster}`).toBeGreaterThanOrEqual(0.85);
    }
  });

  it("dicionário só acrescenta: o nome como veio continua valendo", () => {
    // "Atenas" é também o CA Atenas uruguaio, "Colonia" o Plaza Colonia e
    // "Brasil" o Brasil de Pelotas: o nome como veio continua casando.
    expect(teamSimilarity("Atenas", "CA Atenas")).toBeGreaterThanOrEqual(0.9);
    expect(teamSimilarity("Plaza Colonia", "Plaza Colonia")).toBe(1);
    expect(teamSimilarity("Brasil de Pelotas", "Brasil de Pelotas")).toBe(1);
    // E a forma em português do clube também: "Atenas" contido em "AEK Atenas",
    // como "Bayern" em "Bayern Munich"; o adversário decide entre os dois.
    expect(teamSimilarity("AEK Atenas", "AEK Athens")).toBeGreaterThanOrEqual(0.9);
    expect(teamSimilarity("Atenas", "AEK Athens")).toBeGreaterThanOrEqual(0.9);
    expect(teamSimilarity("Colônia", "1. FC Köln")).toBeGreaterThanOrEqual(0.9);
  });

  it("dicionário não junta categorias: o time B segue longe do sub-23 e do reserva", () => {
    expect(teamSimilarity("Barcelona B", "Barcelona II")).toBeGreaterThanOrEqual(0.9);
    expect(teamSimilarity("Barcelona B", "Barcelona U23")).toBeLessThan(0.45);
    expect(teamSimilarity("Porto B", "Porto")).toBeLessThan(0.45);
    expect(teamSimilarity("Porto II", "Porto")).toBeLessThan(0.45);
    // O Club NXT é o Club Brugge II, não o principal.
    expect(teamSimilarity("Club Brugge II", "Club NXT")).toBe(1);
    expect(teamSimilarity("Club Brugge", "Club NXT")).toBeLessThan(0.45);
    expect(teamSimilarity("Club Brugge", "Club Brugge B")).toBeLessThan(0.45);
  });

  it("dicionário: as formas de cada linha têm a mesma categoria", () => {
    for (const forms of TEAM_NAME_EQUIVALENTS) {
      const categories = forms.map((form) => [...teamCategoryTokens(form)].sort().join(","));
      expect(new Set(categories).size, forms.join(" | ")).toBe(1);
    }
  });

  it("dicionário: cidade que é nome de clube e sigla de país não criam parentesco", () => {
    expect(teamSimilarity("Juventus de Turim", "Torino")).toBeLessThan(0.5);
    expect(teamSimilarity("Sampdoria de Gênova", "Genoa")).toBeLessThan(0.5);
    expect(teamSimilarity("Crvena Zvezda", "Red Star")).toBeLessThan(0.5);
    expect(teamSimilarity("Racing (Uru)", "Racing Club")).toBeLessThan(0.85);
    expect(teamSimilarity("Sporting (Por)", "Sporting Gijon")).toBeLessThan(0.85);
  });

  it("variantes do dicionário: o trecho mais longo ganha e o nome sem regra não tem variante", () => {
    expect(teamNameVariants("inter de milao")).toEqual(["inter milao", "inter milan", "internazionale"]);
    expect(teamNameVariants("ac milao")).toEqual(["ac milan"]);
    expect(teamNameVariants("atletico mg")).toEqual(["atletico mineiro"]);
    expect(teamNameVariants("villarreal ii")).toEqual(["villarreal b"]);
    expect(teamNameVariants("villarreal b")).toEqual([]);
    expect(teamNameVariants("flamengo")).toEqual([]);
  });

  it("digitação: letras invertidas e forma jurídica a mais também são resgatadas", () => {
    expect(teamSimilarity("Astrops", "Astorps")).toBeGreaterThanOrEqual(0.85);
    expect(teamSimilarity("FK Zeleznicar Pancovo", "Zeleznicar Pancevo")).toBeGreaterThanOrEqual(0.85);
    expect(teamSimilarity("Deportivo A Coruña", "Deportivo La Coruna")).toBeGreaterThanOrEqual(0.85);
    // Formas jurídicas diferentes nos dois lados não somem: são clubes diferentes.
    expect(teamSimilarity("Barcelona SC", "FC Barcelona")).toBeLessThan(0.85);
    // Digitação em cima da forma do dicionário não conta.
    expect(teamSimilarity("Inter de Milão", "Internacional")).toBeLessThan(0.85);
  });

  it("inicial do FlashScore casa a palavra inteira quando outra palavra é igual", () => {
    for (const [flashscore, pinnacle] of [
      ["A. Italiano", "Audax Italiano"],
      ["I. Bratislava", "Inter Bratislava"],
      ["U. Catolica", "Universidad Catolica"],
      ["San Martin S.J.", "San Martin de San Juan"],
    ] as const) {
      expect(teamSimilarity(flashscore, pinnacle), `${flashscore} × ${pinnacle}`).toBeGreaterThanOrEqual(0.9);
    }
    // Sem outra palavra igual, a inicial não diz nada.
    expect(teamSimilarity("A. Italiano", "Audax Rio")).toBeLessThan(0.5);
    // Abreviação sem par não some: o que sobra pode distinguir o time.
    expect(teamSimilarity("San Martin S.J.", "San Martin de San Luis")).toBeLessThan(0.85);
    expect(teamSimilarity("A. Italiano Res", "Audax Italiano")).toBeLessThan(0.85);
    // Sigla de estado e palavra genérica não servem.
    expect(teamSimilarity("Botafogo SP", "Botafogo Sport")).toBeLessThan(0.9); // 0,85 é o trecho contido, de antes
    expect(teamSimilarity("M. City", "Melbourne City")).toBeLessThan(0.85);
    // Só a inicial de uma letra ancora; a abreviação de 2 ou 3 letras soma.
    const initial = teamSideSimilarityCanon(canonicalizeTeamName("A. Italiano"), canonicalizeTeamName("Audax Italiano"));
    expect(initial.evidence).toBeGreaterThanOrEqual(0.9);
    const prefix = teamSideSimilarityCanon(canonicalizeTeamName("Sp. Luqueno"), canonicalizeTeamName("Sportivo Luqueno"));
    expect(prefix.score).toBeGreaterThanOrEqual(0.9);
    expect(prefix.evidence).toBeLessThan(0.5);
    // Letra solta no fim é a marca de reserva, e B/W/F são categoria: não
    // viram palavra (expandidas, dariam 1).
    expect(teamSimilarity("Talleres R", "Talleres Remedios")).toBeLessThan(0.9);
    expect(teamSimilarity("Corinthians B", "Corinthians Bahia")).toBeLessThan(0.45);
  });

  it("forma expandida fica abaixo do nome igual: o clássico mantém o mando", () => {
    const result = matchTeamsWithCategoryContext({
      betHome: "Rad Beograd", betAway: "Radnicki Beograd",
      fixtureHome: "Radnicki Beograd", fixtureAway: "Rad Beograd",
    });
    expect(result.swapped).toBe(true);
    expect(result.inverted).toBe(2);
  });

  it("digitação soma no par, mas não é evidência de âncora: Juventus × Juventud", () => {
    const side = teamSideSimilarityCanon(canonicalizeTeamName("Juventus"), canonicalizeTeamName("Juventud"));
    expect(side.score).toBeGreaterThanOrEqual(0.85);
    expect(side.evidence).toBeLessThan(0.5);
    const dictionary = teamSideSimilarityCanon(canonicalizeTeamName("Bayern de Munique"), canonicalizeTeamName("Bayern Munich"));
    expect(dictionary.evidence).toBe(dictionary.score);
  });
});

describe("matchTeamsWithCategoryContext", () => {
  it("dá a evidência de cada lado da fixture na orientação escolhida, sem o resgate de digitação", () => {
    const direct = matchTeamsWithCategoryContext({
      betHome: "Tersana", betAway: "Baladiyyat Al Mehalla", fixtureHome: "Tersana", fixtureAway: "Baladiyat El Mahalla",
    });
    expect(direct.swapped).toBe(false);
    expect(direct.evidenceHome).toBe(1);
    expect(direct.evidenceAway).toBeLessThan(0.5);
    const inverted = matchTeamsWithCategoryContext({
      betHome: "Baladiyyat Al Mehalla", betAway: "Tersana", fixtureHome: "Tersana", fixtureAway: "Baladiyat El Mahalla",
    });
    expect(inverted.swapped).toBe(true);
    expect([inverted.evidenceHome, inverted.evidenceAway]).toEqual([direct.evidenceHome, direct.evidenceAway]);
    // A digitação soma no escore do lado, mas não é evidência.
    const typo = matchTeamsWithCategoryContext({
      betHome: "Sherewsbury", betAway: "Wigan", fixtureHome: "Shrewsbury", fixtureAway: "Wigan",
    });
    expect(typo.directHome).toBeGreaterThan(typo.evidenceHome);
  });
});

describe("bestSearchWord", () => {
  it("não usa descritores genéricos de time como filtro do provider", () => {
    expect(bestSearchWord("Team 1")).toBe("1");
    expect(bestSearchWord("Team A")).toBe("a");
    expect(bestSearchWord("Equipe 2")).toBe("2");
    expect(bestSearchWord("Clube do Remo")).toBe("remo");
  });

  it("ignora siglas institucionais de clubes brasileiros", () => {
    for (const token of ["cr", "se", "ec"] as const) {
      expect(TEAM_STOP_WORDS.has(token)).toBe(true);
    }
    expect(bestSearchWord("CR Flamengo")).toBe("flamengo");
    expect(bestSearchWord("SE Palmeiras")).toBe("palmeiras");
    expect(bestSearchWord("EC Juventude")).toBe("juventude");
    expect(teamSimilarity("CR Flamengo", "Flamengo")).toBeGreaterThanOrEqual(0.9);
  });
});

describe("splitEventoTeams", () => {
  it("limpa sufixo de rodada também no delimitador hífen", () => {
    // O gate `index < 2` só limpava vs/x; a legenda BR com hífen deixava
    // "Time B - 15ª rodada" como nome do visitante.
    expect(splitEventoTeams("Time A - Time B - 15ª rodada")).toEqual({
      home: "Time A",
      away: "Time B",
    });
    expect(splitEventoTeams("Time A - Time B - 3a jornada")).toEqual({
      home: "Time A",
      away: "Time B",
    });
    // Hífen que faz parte do nome continua intacto.
    expect(splitEventoTeams("Red Bull - Salzburg")).toEqual({
      home: "Red Bull",
      away: "Salzburg",
    });
  });

  it("tolera vs, x, hífen e travessão", () => {
    expect(splitEventoTeams("Flamengo vs Palmeiras")).toEqual({
      home: "Flamengo",
      away: "Palmeiras",
    });
    expect(splitEventoTeams("Santos x Grêmio")).toEqual({
      home: "Santos",
      away: "Grêmio",
    });
    expect(splitEventoTeams("Lakers - Celtics")).toEqual({
      home: "Lakers",
      away: "Celtics",
    });
    expect(splitEventoTeams("Inter – Milan")).toEqual({
      home: "Inter",
      away: "Milan",
    });
    expect(splitEventoTeams("Flamengo \n  vs \n Fluminense")).toEqual({
      home: "Flamengo",
      away: "Fluminense",
    });
    expect(splitEventoTeams("Flamengo / Palmeiras")).toEqual({
      home: "Flamengo",
      away: "Palmeiras",
    });
    expect(splitEventoTeams("Flamengo/Palmeiras")).toEqual({
      home: "Flamengo",
      away: "Palmeiras",
    });
    expect(splitEventoTeams("Team A/Team B")).toEqual({
      home: "Team A",
      away: "Team B",
    });
    expect(splitEventoTeams("Team X x Team Y")).toEqual({
      home: "Team X",
      away: "Team Y",
    });
    expect(splitEventoTeams("FLAMENGO X PALMEIRAS")).toEqual({
      home: "FLAMENGO",
      away: "PALMEIRAS",
    });
    // Em caixa mista o X isolado segue ambíguo e não trunca nome próprio.
    expect(splitEventoTeams("Team X Palmeiras")).toBeNull();
  });

  it("prioriza vs sobre hífen quando o nome da casa contém hífen com espaços", () => {
    // Um `(.+?)` não-guloso quebraria no primeiro " - " (dentro do nome).
    expect(splitEventoTeams("Red Bull - Salzburg vs Liverpool")).toEqual({
      home: "Red Bull - Salzburg",
      away: "Liverpool",
    });
    // Sem vs, o hífen com espaços segue sendo o separador (e nomes com hífen
    // colado não são afetados).
    expect(splitEventoTeams("Brighton & Hove - Man City")).toEqual({
      home: "Brighton & Hove",
      away: "Man City",
    });
    expect(splitEventoTeams("Saint-Étienne vs Lyon")).toEqual({
      home: "Saint-Étienne",
      away: "Lyon",
    });
    expect(splitEventoTeams("FC V vs Team B")).toEqual({
      home: "FC V",
      away: "Team B",
    });
    expect(splitEventoTeams("FC V Setúbal v Palmeiras")).toEqual({
      home: "FC V Setúbal",
      away: "Palmeiras",
    });
    // Em caixa mista, V maiúsculo isolado é ambíguo e falha fechado.
    expect(splitEventoTeams("Flamengo V Palmeiras")).toBeNull();
    expect(splitEventoTeams("FLAMENGO V PALMEIRAS")).toEqual({
      home: "FLAMENGO",
      away: "PALMEIRAS",
    });
    // Hífen colado é parte legítima de nomes e não fornece evidência suficiente
    // para inventar dois lados de um confronto.
    expect(splitEventoTeams("Paris-Saint Germain")).toBeNull();
    expect(splitEventoTeams("Flamengo-Palmeiras")).toBeNull();
  });

  it("não usa a barra de sufixos estaduais como delimitador do confronto", () => {
    expect(splitEventoTeams("Flamengo/RJ - Palmeiras/SP")).toEqual({
      home: "Flamengo/RJ",
      away: "Palmeiras/SP",
    });
    // Fora do formato UF/UF, a barra colada continua sendo o delimitador mais
    // forte que o hífen potencialmente pertencente ao nome.
    expect(splitEventoTeams("Red Bull - Salzburg/Team B")).toEqual({
      home: "Red Bull - Salzburg",
      away: "Team B",
    });
  });

  it("remove metadado de rodada após confronto com delimitador forte", () => {
    expect(splitEventoTeams("Time A vs Time B - 2ª Rodada")).toEqual({
      home: "Time A",
      away: "Time B",
    });
    expect(splitEventoTeams("Time A x Time B — Round 3")).toEqual({
      home: "Time A",
      away: "Time B",
    });
    expect(splitEventoTeams("Time A vs Time B - 15ª R.")).toEqual({
      home: "Time A",
      away: "Time B",
    });
    expect(splitEventoTeams("Time A / Time B - 15º J.")).toEqual({
      home: "Time A",
      away: "Time B",
    });
    expect(splitEventoTeams("Lakers - Celtics")).toEqual({ home: "Lakers", away: "Celtics" });
  });

  it("null quando não é confronto", () => {
    expect(splitEventoTeams("Total de gols da rodada")).toBeNull();
    expect(splitEventoTeams("")).toBeNull();
    expect(splitEventoTeams(undefined)).toBeNull();
  });
});

describe("categorias protegidas: U-20 / Under 20 / Under 21 e reserva numérica", () => {
  it("canonicaliza U-20, U 20, Under 20, Under 21 e Sub-20 para o token protegido u20/u21", () => {
    expect(canonicalizeTeamName("Flamengo U-20")).toBe("flamengo u20");
    expect(canonicalizeTeamName("Flamengo U 20")).toBe("flamengo u20");
    expect(canonicalizeTeamName("Flamengo Under 20")).toBe("flamengo u20");
    expect(canonicalizeTeamName("Flamengo Sub-20")).toBe("flamengo u20");
    expect(canonicalizeTeamName("Flamengo Sub 20")).toBe("flamengo u20");

    expect(canonicalizeTeamName("England Under 21")).toBe("england u21");
    expect(canonicalizeTeamName("England Under-21")).toBe("england u21");
    expect(canonicalizeTeamName("England Under-21s")).toBe("england u21");

    // Totais decimais preservam o número sem virar u21
    expect(canonicalizeTeamName("Canada Under 21.5")).toBe("canada under 21 5");

    expect(hasProtectedTeamCategoryConflict(canonicalizeTeamName("England Under-21"), canonicalizeTeamName("England"))).toBe(true);
    expect(sameFixtureTeams("England Under 21 vs France Under 21", "England vs France")).toBe(false);
    expect(teamSimilarity("England Under 21", "England U21")).toBe(1);
  });

  it("sameFixtureTeams rejeita confronto entre time reserva numérico e principal", () => {
    expect(sameFixtureTeams("River Plate 2 vs Boca", "River Plate vs Boca")).toBe(false);
    expect(sameFixtureTeams("River Plate vs Boca 2", "River Plate vs Boca")).toBe(false);
    expect(sameFixtureTeams("River Plate vs Boca", "River Plate vs Boca")).toBe(true);
    expect(sameFixtureTeams("River Plate (F) vs Boca", "River Plate vs Boca")).toBe(false);
  });
});
