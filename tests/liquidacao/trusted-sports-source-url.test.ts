import { describe, expect, it } from "vitest";
import {
  citationSupportingResult,
  isGoogleGroundingRedirectUrl,
  sameTrustedSource,
  sportsSourceForDisplay,
  sanitizeTrustedSportsSourceUrl,
  verifySportsGrounding,
} from "@/src/domain/trusted-sports-source-url";

describe("sanitizeTrustedSportsSourceUrl", () => {
  it("aceita HTTPS de fontes conhecidas e remove fragmento", () => {
    expect(sanitizeTrustedSportsSourceUrl("https://www.bbc.com/sport/football#placar"))
      .toBe("https://www.bbc.com/sport/football");
    expect(sanitizeTrustedSportsSourceUrl("https://sub.sofascore.com/event"))
      .toBe("https://sub.sofascore.com/event");
  });

  it("aceita fontes oficiais de eSports (HLTV, Liquipedia, VLR)", () => {
    expect(sanitizeTrustedSportsSourceUrl("https://www.hltv.org/matches/2375123/vitality-vs-natus-vincere#boxscore"))
      .toBe("https://www.hltv.org/matches/2375123/vitality-vs-natus-vincere");
    expect(sanitizeTrustedSportsSourceUrl("https://liquipedia.net/counterstrike/PGL/Major/2026"))
      .toBe("https://liquipedia.net/counterstrike/PGL/Major/2026");
    expect(sanitizeTrustedSportsSourceUrl("https://www.vlr.gg/12345/sentinels-vs-fnatic"))
      .toBe("https://www.vlr.gg/12345/sentinels-vs-fnatic");
    expect(sanitizeTrustedSportsSourceUrl("https://ge.globo.com/futebol/copa-do-brasil/jogo/123.ghtml"))
      .toBe("https://ge.globo.com/futebol/copa-do-brasil/jogo/123.ghtml");
    expect(sanitizeTrustedSportsSourceUrl("https://www.cbf.com.br/competicoes/sumula/123"))
      .toBe("https://www.cbf.com.br/competicoes/sumula/123");
  });

  it("recusa HTTP, host parecido, credencial, porta e URL inválida", () => {
    for (const value of [
      "http://www.bbc.com/sport",
      "https://bbc.com.attacker.test/sport",
      "https://user:pass@bbc.com/sport",
      "https://bbc.com:444/sport",
      "not-a-url",
      null,
    ]) {
      expect(sanitizeTrustedSportsSourceUrl(value)).toBe("");
    }
  });
});

describe("sportsSourceForDisplay", () => {
  const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/placar";

  it("exibe o redirecionamento citado com o domínio esportivo atestado", () => {
    expect(sportsSourceForDisplay(redirect, [{ url: redirect, title: "www.sofascore.com" }]))
      .toEqual({ url: redirect, domain: "sofascore.com" });
  });

  it.each([
    [],
    [{ url: `${redirect}-outro`, title: "sofascore.com" }],
    [{ url: redirect, title: "sofascore.com.attacker.test" }],
    [{ url: redirect, title: "Resultado em sofascore.com" }],
    [{ url: redirect, title: 123 }],
    [null, 123, { url: 123 }],
    { url: redirect, title: "sofascore.com" },
    null,
  ].map((sources) => [sources]))("recusa redirecionamento sem uma citação válida: %j", (sources) => {
    expect(sportsSourceForDisplay(redirect, sources)).toBeNull();
  });

  it("não troca citação inválida por um link direto permitido", () => {
    expect(sportsSourceForDisplay("https://sofascore.com/jogo", [{ url: "https://bbc.com/sport" }])).toBeNull();
    expect(sportsSourceForDisplay("https://sofascore.com/jogo", [])).toBeNull();
  });

  it("mantém o link direto seguro quando não há citações gravadas", () => {
    expect(sportsSourceForDisplay("https://www.sofascore.com/jogo#placar", null))
      .toEqual({ url: "https://www.sofascore.com/jogo", domain: "sofascore.com" });
    for (const url of ["http://sofascore.com/jogo", "https://user:pass@sofascore.com/jogo", "javascript:alert(1)"]) {
      expect(sportsSourceForDisplay(url, null)).toBeNull();
    }
  });
});

describe("verifySportsGrounding", () => {
  it("vincula a URL escolhida a uma citação grounded confiável", () => {
    expect(verifySportsGrounding(
      "https://www.bbc.com/sport/football#resultado",
      [
        { url: "https://www.espn.com/game", title: "ESPN" },
        { url: "https://www.bbc.com/sport/football", title: "BBC" },
      ],
    )).toEqual({
      citations: [
        { url: "https://www.espn.com/game", title: "ESPN" },
        { url: "https://www.bbc.com/sport/football", title: "BBC" },
      ],
      sourceUrl: "https://www.bbc.com/sport/football",
      sourceDomain: "www.bbc.com",
    });
  });

  it("falha fechado sem citação aceita pelo SSOT", () => {
    expect(verifySportsGrounding(
      "https://www.bbc.com/sport/football",
      [{ url: "https://example.com/result" }, { url: "http://www.bbc.com/result" }],
    )).toEqual({
      citations: [{ url: "https://example.com/result" }],
      sourceUrl: null,
      sourceDomain: null,
    });
  });

  const redirect = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;

  it("lê o domínio do redirecionamento do Google pelo title (formato real do Gemini)", () => {
    const sources = [
      { url: redirect("AUZIYQ1"), title: "sofascore.com" },
      { url: redirect("AUZIYQ2"), title: "noticias-esportivas.example" },
      { url: redirect("AUZIYQ3"), title: "livesport.cz" },
    ];
    expect(verifySportsGrounding(redirect("AUZIYQ1"), sources))
      .toMatchObject({ sourceUrl: redirect("AUZIYQ1"), sourceDomain: "sofascore.com" });
    expect(verifySportsGrounding("https://www.sofascore.com/match/1", sources))
      .toMatchObject({ sourceUrl: "https://www.sofascore.com/match/1", sourceDomain: "sofascore.com" });
    expect(verifySportsGrounding(redirect("AUZIYQ2"), sources))
      .toMatchObject({ sourceUrl: null });
    expect(verifySportsGrounding(redirect("AUZIYQ3"), sources))
      .toMatchObject({ sourceUrl: redirect("AUZIYQ3"), sourceDomain: "livesport.cz" });
  });

  it("title só vale como domínio no redirecionamento do Google, e só se for um domínio", () => {
    expect(verifySportsGrounding("https://www.sofascore.com/match/1", [
      { url: "https://evil.test/page", title: "sofascore.com" },
    ])).toMatchObject({ sourceUrl: null });
    expect(verifySportsGrounding(redirect("X"), [
      { url: redirect("X"), title: "Sofascore — resultado ao vivo" },
    ])).toMatchObject({ sourceUrl: null });
    expect(verifySportsGrounding("https://vertexaisearch.cloud.google.com/outra/rota", [
      { url: "https://vertexaisearch.cloud.google.com/outra/rota", title: "sofascore.com" },
    ])).toMatchObject({ sourceUrl: null });
  });

  it("não troca a fonte afirmada por outra citação confiável", () => {
    expect(verifySportsGrounding("https://www.espn.com/game/1", [
      { url: "https://www.bbc.com/sport/football", title: "BBC" },
    ])).toMatchObject({ sourceUrl: null, sourceDomain: null });
    expect(verifySportsGrounding("", [
      { url: redirect("AUZIYQ1"), title: "sofascore.com" },
    ])).toMatchObject({ sourceUrl: null });
  });
});

describe("placar final amarrado à citação confiável (groundingSupports)", () => {
  const redirect = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
  const sofascore = { url: redirect("A"), title: "sofascore.com" };
  const sofascoreOutra = { url: redirect("C"), title: "sofascore.com" };
  const outra = { url: redirect("B"), title: "noticias-esportivas.example" };
  const trecho = (text: string, sources = [sofascore]) => ({ text, sources });
  const supported = (valueFound: string, supports: Array<ReturnType<typeof trecho>>, evento = "Flamengo vs Vasco") =>
    citationSupportingResult({ valueFound, supports, domain: "sofascore.com", evento });

  it("devolve o placar provado e de que lado é o primeiro número, só na forma de placar", () => {
    expect(supported("2-1", [trecho("Flamengo 2-1 Vasco.")]))
      .toMatchObject({ score: { first: 2, second: 1 }, firstSide: "home" });
    expect(supported("1 x 2", [trecho("Fim de jogo: Vasco 1 x 2 Flamengo.")]))
      .toMatchObject({ score: { first: 1, second: 2 }, firstSide: "away" });
    // Frase corrida: o primeiro número é do vencedor, não do time citado antes.
    for (const text of ["Flamengo venceu o Vasco por 2 a 1.", "Flamengo perdeu por 2-1 para o Vasco."]) {
      expect(supported("2-1", [trecho(text)]), text).toMatchObject({ firstSide: null });
    }
  });

  it("o placar precisa estar no mesmo trecho, na ordem do resultado", () => {
    expect(supported("2-2", [trecho("Dumbarton e Celtic B empataram por 2 a 2.")], "Dumbarton vs Celtic B"))
      .toMatchObject({ citation: sofascore });
    expect(supported("placar 2-1 no tempo regulamentar", [trecho("Flamengo 2-1 Vasco.")]))
      .toMatchObject({ citation: sofascore });
    expect(supported("1-2", [trecho("Flamengo venceu o Vasco por 2 a 1.")]))
      .toEqual({ refusal: "result_not_supported" });
    expect(supported("3-0", [trecho("Flamengo tem 0 derrotas em 3 jogos contra o Vasco.")]))
      .toEqual({ refusal: "result_not_supported" });
    expect(supported("2-1", [trecho("Flamengo e Vasco: terminou 2"), trecho("a 1 para os visitantes")]))
      .toEqual({ refusal: "result_not_supported" });
  });

  it("resultado sem um placar só não se prova", () => {
    expect(supported("Empate", [trecho("Flamengo e Vasco terminaram empatados.")]))
      .toEqual({ refusal: "result_not_supported" });
    expect(supported("escanteios 6+5=11", [trecho("Flamengo e Vasco somaram 11 escanteios.")]))
      .toEqual({ refusal: "result_not_supported" });
    expect(supported("2-1 (1-0 no intervalo)", [trecho("Flamengo 2-1 Vasco.")]))
      .toEqual({ refusal: "result_not_supported" });
  });

  it("'in the first' que não é parte do jogo não recusa o placar final", () => {
    for (const text of [
      "In the first meeting between them this season, Flamengo beat Vasco 1-0.",
      "Flamengo scored in the first minute and beat Vasco 1-0.",
      "In the first semi-final, Flamengo beat Vasco 1-0.",
    ]) {
      expect(supported("placar 1-0", [trecho(text)]), text).toMatchObject({ citation: sofascore });
    }
  });

  it("o trecho que cita qualquer parte do jogo não prova o placar final", () => {
    for (const text of [
      "At the break, Flamengo led Vasco 1-0.",
      "Flamengo held a 1-0 first-half lead over Vasco.",
      "Flamengo led Vasco 1-0 at the half.",
      "After the break, Flamengo made it 1-0 against Vasco.",
      "O Flamengo venceu a etapa inicial por 1 a 0 contra o Vasco.",
      "O Flamengo foi para o vestiário vencendo o Vasco por 1 a 0.",
      "Na volta do intervalo, o Flamengo fez 1 a 0 no Vasco.",
      "Flamengo 1 a 0 Vasco na etapa complementar.",
      "Placar final do 1T: Flamengo 1-0 Vasco.",
      "Placar final do HT: Flamengo 1-0 Vasco.",
      "No intervalo, Flamengo 1-0 Vasco.",
      "No final do primeiro tempo, Flamengo 1-0 Vasco.",
      "Placar final do primeiro tempo: Flamengo 1-0 Vasco.",
      "Flamengo 1 a 0 Vasco no primeiro tempo.",
      "No segundo tempo, o Flamengo fez 1 a 0 no Vasco.",
      "Flamengo led Vasco 1-0 in the opening half.",
      "Flamengo were 1-0 up against Vasco after the first 45 minutes.",
      "O Flamengo fez 1 a 0 no Vasco nos primeiros 45 minutos.",
      "Flamengo went into the dressing room 1-0 up on Vasco.",
      "Flamengo led Vasco 1-0 heading to the locker room.",
      "Flamengo won the final quarter 1-0 against Vasco.",
      "Flamengo outscored Vasco 1-0 in the fourth.",
      "Flamengo took the opening set 1-0 against Vasco.",
    ]) {
      expect(supported("placar 1-0", [trecho(text)]), text).toEqual({ refusal: "period_not_supported" });
    }
    expect(supported("placar 85-80", [trecho("Lakers led Celtics 85-80 through three quarters.")], "Lakers vs Celtics"))
      .toEqual({ refusal: "period_not_supported" });
    expect(supported("placar 1-0", [trecho("NAVI 1-0 FaZe no mapa 1.")], "NAVI vs FaZe"))
      .toEqual({ refusal: "period_not_supported" });
  });

  it("o final da fase da competição não é parte do jogo; o placar final e o apito final são o jogo inteiro", () => {
    expect(supported("placar 2-1", [trecho("Na final da Copa do Brasil, Flamengo 2-1 Vasco.")]))
      .toMatchObject({ citation: sofascore });
    expect(supported("placar 2-1", [trecho("Pelas quartas de final, Flamengo venceu o Vasco por 2 a 1 no apito final.")]))
      .toMatchObject({ citation: sofascore });
    expect(supported("placar 1-0", [trecho("Na final da Copa do Brasil, Flamengo vencia o Vasco por 1-0 no intervalo.")]))
      .toEqual({ refusal: "period_not_supported" });
    expect(supported("placar 1-0", [trecho("In the grand final, Flamengo led Vasco 1-0 at half-time.")]))
      .toEqual({ refusal: "period_not_supported" });
  });

  it("trecho com dois placares não diz qual é o do jogo", () => {
    for (const [valueFound, text] of [
      ["placar 1-0", "Flamengo vs Vasco: FT 2-1 (HT 1-0)."],
      ["placar 2-1", "Flamengo vs Vasco: FT 2-1 (HT 1-0)."],
      ["placar 2-1", "No intervalo, Flamengo 1-0 Vasco; placar final 2-1."],
      ["placar 2-1", "Pelas quartas de final, Flamengo 2-1 Vasco no apito final, depois de 1-0 no primeiro tempo."],
      ["placar 1-0", "O Flamengo abriu 1 a 0 sobre o Vasco no primeiro tempo, e o placar final foi 2 a 1."],
      ["placar 1-0", "Flamengo 2:1 (1:0) Vasco."],
      ["placar 2-1", "Flamengo 2:1 (1:0) Vasco."],
      ["placar 1-0", "Na rodada, Flamengo 2-1 Vasco e Botafogo 1-0 Santos."],
    ] as const) {
      expect(supported(valueFound, [trecho(text)]), text).toEqual({ refusal: "period_not_supported" });
    }
    expect(supported("placar 110-105", [trecho("Lakers led Celtics 55-50 at halftime; final score 110-105.")], "Lakers vs Celtics"))
      .toEqual({ refusal: "period_not_supported" });
  });

  it("frase anterior com o placar de uma parte não impede o placar do jogo no trecho seguinte", () => {
    expect(supported("placar 1-0", [
      trecho("O primeiro tempo entre Flamengo e Vasco terminou 0 a 0."),
      trecho("Pedro marcou aos 65 minutos, e o Flamengo venceu por 1 a 0."),
    ])).toMatchObject({ citation: sofascore });
  });

  it("frase anterior sem placar que fala de uma parte faz do placar seguinte o dessa parte", () => {
    const intervalo = [
      trecho("Flamengo e Vasco foram para o intervalo depois de um primeiro tempo movimentado."),
      trecho("Terminou 1-0."),
    ];
    expect(supported("placar 1-0", intervalo)).toEqual({ refusal: "period_not_supported" });
    expect(supported("placar 1-0", [
      trecho("No primeiro tempo, Flamengo e Vasco fizeram um jogo truncado."),
      trecho("O Flamengo foi para o vestiário vencendo por 1 a 0."),
    ])).toEqual({ refusal: "period_not_supported" });
    // A frase muda a leitura do trecho qualquer que seja a fonte dela.
    expect(supported("placar 1-0", [
      trecho("Flamengo e Vasco foram para o intervalo depois de um primeiro tempo movimentado.", [outra]),
      trecho("Flamengo e Vasco: terminou 1-0."),
    ])).toEqual({ refusal: "period_not_supported" });
    // O trecho que diz ser o placar final não é o da parte.
    expect(supported("placar 1-0", [
      trecho("Flamengo e Vasco foram para o intervalo depois de um primeiro tempo movimentado."),
      trecho("Placar final: Flamengo 1-0 Vasco."),
    ])).toMatchObject({ citation: sofascore });
  });

  it("o trecho precisa nomear os dois lados da partida", () => {
    expect(supported("placar 2-1 no tempo regulamentar", [trecho("Palmeiras 2-1 Santos.")]))
      .toEqual({ refusal: "event_not_supported" });
    expect(supported("placar 2-1", [trecho("O Flamengo venceu por 2-1.")]))
      .toEqual({ refusal: "event_not_supported" });
  });

  it("devolve a citação que sustenta o trecho, com os times na frase anterior", () => {
    expect(supported("2-2", [
      trecho("Dumbarton recebeu o Celtic B."),
      trecho("Terminou 2-2.", [sofascoreOutra]),
    ], "Dumbarton vs Celtic B")).toMatchObject({ citation: sofascoreOutra });
  });

  it("a frase anterior só nomeia a partida quando a citação dela é do mesmo domínio", () => {
    expect(supported("2-2", [
      trecho("Dumbarton recebeu o Celtic B.", [outra]),
      trecho("Terminou 2-2."),
    ], "Dumbarton vs Celtic B")).toEqual({ refusal: "event_not_supported" });
  });

  it("recusa quando o placar só aparece em trecho de outro domínio", () => {
    expect(supported("2-2", [trecho("Dumbarton e Celtic B empataram por 2 a 2.", [outra])], "Dumbarton vs Celtic B"))
      .toEqual({ refusal: "result_not_supported" });
  });

  it("reconhece o redirecionamento do Google e compara domínios pela lista confiável", () => {
    expect(isGoogleGroundingRedirectUrl(redirect("A"))).toBe(true);
    expect(isGoogleGroundingRedirectUrl("https://www.sofascore.com/x")).toBe(false);
    expect(sameTrustedSource("www.sofascore.com", "sofascore.com")).toBe(true);
    expect(sameTrustedSource("sofascore.com.evil.test", "sofascore.com")).toBe(false);
  });
});
