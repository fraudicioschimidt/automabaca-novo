import { describe, expect, it } from "vitest";
import { HALF_PERIOD_PHRASES, isThreeWayHandicapMarket, marketPeriodOf } from "@/src/domain/mercados/classify";
import { coerceMercadoPelaSelecao } from "@/src/domain/mercados/coerce";
import { totalDirectionOf } from "@/src/domain/mercados/total-direction";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { classifyScoreMarket } from "@/src/domain/settlement/markets";
import { resolveResultFromStatistics } from "@/src/domain/settlement/statistics";
import { matchDoubleChanceSelection, matchTeamSide } from "@/src/domain/settlement/sides";
import { ehMercadoArtilheiro } from "@/src/domain/settlement/goalscorer";

/**
 * O PERÍODO e o LADO — as duas coisas que, erradas, invertem dinheiro
 * sem parecer erro. Irmão de `settlement-markets-stat-lines.test.ts`, que cobre
 * a UNIDADE.
 *
 *  - PERÍODO: "Intervalo - Totais" / "Over 0.5" num jogo 2-0 com HT 0-0 não
 *    pode liquidar pelo agregado; `Meio Tempo`, `1ª Parte`, `First Half` e
 *    `Resultado 90 Minutos` são fase parcial.
 *  - LADO: `Home Total Goals` com o VISITANTE nomeado na seleção é ambíguo, e
 *    `Arsenal Women` não casa no placar do Arsenal masculino.
 *
 * O bloco de período é GERADO de `HALF_PERIOD_PHRASES`: frase nova entra
 * automaticamente. As regressões explícitas protegem remoções da lista.
 * Os demais casos nasceram de mecânicas diferentes e continuam explícitos.
 */

const EVENTO = "Flamengo vs Palmeiras";

/** Jogo 2-0. Quem usar o agregado indevidamente vai dizer WON e se denunciar. */
function liquidar(mercado: string, selecao: string, evento = EVENTO) {
  return resolveResultFromScore({
    mercado,
    selecao,
    evento,
    esporte: "Soccer",
    homeScore: 2,
    awayScore: 0,
    odds: 1.85,
    stake: 5,
  });
}

describe("período: fase parcial nunca liquida pelo placar agregado", () => {
  const frases = [
    ...HALF_PERIOD_PHRASES.first.map((frase) => [frase, "HT"] as const),
    ...HALF_PERIOD_PHRASES.second.map((frase) => [frase, "SECOND_HALF"] as const),
  ];

  it.each(frases)("%s identifica %s e recusa o placar do jogo inteiro", (frase, periodo) => {
    expect(marketPeriodOf(`${frase} Total`)).toBe(periodo);
    expect(liquidar(`${frase} Total`, "Over 0.5")).toMatchObject({
      ok: false,
      reason: "wrong_period",
    });
  });

  /**
   * Grafias reais que liquidariam errado pelo agregado. Ficam explícitas
   * além do bloco gerado: se alguém "simplificar" o SSOT, estas caem primeiro.
   */
  it.each([
    ["Intervalo - Totais", "Over 0.5"],
    ["Meio Tempo - 1X2", "Flamengo"],
    ["1ª Parte Total", "Over 0.5"],
    ["First Half Asian Handicap", "Flamengo -0.5"],
    ["2ª Parte Total", "Over 0.5"],
    ["1T Totais", "Over 1.5"],
    ["1T - Totais", "Over 1.5"],
    ["Totais 1T", "Over 1.5"],
    ["2T Totais", "Over 1.5"],
    ["1S Totais", "Over 1.5"],
    ["2S Totais", "Over 1.5"],
  ])("%s / %s não usa o agregado", (mercado, selecao) => {
    expect(liquidar(mercado, selecao)).toMatchObject({ ok: false, reason: "wrong_period" });
  });

  it("resultado intervalo/final exige os DOIS placares, não é meio-tempo", () => {
    expect(marketPeriodOf("Resultado Intervalo/Final")).toBe("OTHER");
    expect(liquidar("Resultado Intervalo/Final", "Flamengo")).toMatchObject({
      ok: false,
      reason: "wrong_period",
    });
  });

  it.each(["Resultado 90 Minutos", "Total 90 Min", "Vencedor 90 minutos"])(
    "%s é regulamentar e não usa agregado com prorrogação",
    (mercado) => {
      expect(marketPeriodOf(mercado)).toBe("OTHER");
    },
  );

  it("mercado de jogo inteiro continua liquidando", () => {
    expect(liquidar("Total", "Over 0.5")).toMatchObject({ ok: true, status: "WON" });
    expect(liquidar("Moneyline", "Flamengo")).toMatchObject({ ok: true, status: "WON" });
  });

  it("1st half continua HT; 1S compacto não é FT", () => {
    expect(marketPeriodOf("1st Half Total")).toBe("HT");
    expect(marketPeriodOf("1S Totais")).toBe("OTHER");
    expect(liquidar("Total Match", "Over 1.5 1S")).toMatchObject({
      ok: false,
      reason: "wrong_period",
    });
  });
});

describe("lado: rótulo do mercado × nome na seleção", () => {
  it.each([
    ["Home Total Goals", "Palmeiras Over 0.5"],
    ["Away Total Goals", "Flamengo Over 0.5"],
  ])("%s com o time contrário nomeado (%s) é ambíguo, não invertido", (mercado, selecao) => {
    expect(liquidar(mercado, selecao)).toMatchObject({
      ok: false,
      reason: "ambiguous_selection",
    });
  });

  it("sem contradição o team total segue liquidando pelos dois caminhos", () => {
    // Rótulo do mercado decide quando a seleção não nomeia time.
    expect(liquidar("Home Total Goals", "Over 0.5")).toMatchObject({ ok: true, status: "WON" });
    // Nome na seleção decide quando o mercado é genérico.
    expect(liquidar("Team Total", "Flamengo Over 0.5")).toMatchObject({ ok: true, status: "WON" });
    // E os dois concordando continua valendo.
    expect(liquidar("Home Total Goals", "Flamengo Over 0.5")).toMatchObject({
      ok: true,
      status: "WON",
    });
  });
});

describe("categoria protegida vence a menção literal", () => {
  it.each(["Women", "Ladies", "Girls", "Femminile", "Feminino"])(
    "Arsenal %s não casa no Arsenal masculino",
    (sufixo) => {
      expect(matchTeamSide(`Arsenal ${sufixo}`, "Arsenal vs Chelsea")).toBeNull();
      expect(
        liquidar("Moneyline", `Arsenal ${sufixo}`, "Arsenal vs Chelsea"),
      ).toMatchObject({ ok: false, reason: "ambiguous_selection" });
    },
  );

  it("feminino contra feminino continua resolvendo normalmente", () => {
    expect(
      liquidar("Moneyline", "Arsenal Women", "Arsenal Women vs Chelsea Women"),
    ).toMatchObject({ ok: true, status: "WON" });
    expect(matchTeamSide("Arsenal Ladies", "Arsenal Women vs Chelsea Women")).toBe("home");
  });

  it("time sem categoria protegida não regride", () => {
    expect(matchTeamSide("Arsenal", "Arsenal vs Chelsea")).toBe("home");
    expect(liquidar("Moneyline", "Arsenal", "Arsenal vs Chelsea")).toMatchObject({
      ok: true,
      status: "WON",
    });
  });

  it("subtoken unívoco em partida onde ambos times compartilham categoria resolve o lado correto", () => {
    expect(matchTeamSide("cali -0.75", "orsomarso f x deportivo cali f")).toBe("away");
    expect(matchTeamSide("orsomarso +0.75", "orsomarso f x deportivo cali f")).toBe("home");
    expect(matchTeamSide("cali -0.5", "america de cali vs deportivo cali")).toBeNull();
  });
});

describe("handicap europeu não tem push asiático", () => {
  it.each(["European Handicap", "Handicap Europeu", "Hándicap Europeo", "Handicap 3-Way"])(
    "%s é de três vias",
    (mercado) => {
      expect(isThreeWayHandicapMarket(mercado)).toBe(true);
    },
  );

  it.each(["European Handicap", "Hándicap Europeo"])(
    "%s não é reescrito como asiático nem liquida cobertura exata como VOID",
    (mercado) => {
      expect(coerceMercadoPelaSelecao(mercado, "Flamengo -1")).toBe(mercado);
      const r = resolveResultFromScore({
        mercado,
        selecao: "Flamengo -1",
        evento: EVENTO,
        esporte: "Soccer",
        homeScore: 1,
        awayScore: 0,
        odds: 2,
        stake: 10,
      });
      expect(r.ok).toBe(false);
    },
  );

  it("handicap asiático de verdade continua sendo coagido e liquidado", () => {
    expect(coerceMercadoPelaSelecao("Moneyline", "Flamengo -0.5")).toContain("Handicap");
    expect(liquidar("Asian Handicap", "Flamengo -0.5")).toMatchObject({
      ok: true,
      status: "WON",
    });
  });
});

describe("direção de total", () => {
  it.each(["Over/Under 2.5", "Mais/Menos 2.5", "Acima/Abaixo 2.5"])(
    "rótulo composto %s não escolhe lado sozinho",
    (mercado) => {
      expect(totalDirectionOf(mercado)).toBeNull();
    },
  );

  it("direção explícita continua decidindo", () => {
    expect(totalDirectionOf("Over 2.5")).toBe("over");
    expect(totalDirectionOf("Under 2.5")).toBe("under");
    expect(totalDirectionOf("Menos de 2.5")).toBe("under");
  });

  it("composto ao lado de direção explícita não anula a direção", () => {
    expect(totalDirectionOf("Mais de 2.5 (Over/Under)")).toBe("over");
    expect(totalDirectionOf("Menos de 2.5 (Over/Under)")).toBe("under");
  });

  /** `Above`/`Below` é Over/Under em inglês — sem eles o total virava handicap. */
  it("Above/Below são total, não handicap", () => {
    expect(totalDirectionOf("Above 2.5")).toBe("over");
    expect(totalDirectionOf("Below 2.5")).toBe("under");
    expect(coerceMercadoPelaSelecao("Moneyline", "Above 2.5")).toContain("Total");
  });

  /** Mercado que DECLARA total não vira handicap por conter "asian". */
  it("Asian Total sem direção falha fechado em vez de virar handicap", () => {
    expect(classifyScoreMarket("asian total", "2.5", "A vs B")).not.toBe("handicap");
  });
});

describe("empate na seleção: Dupla Chance e anti-empate não são 'apostei no empate'", () => {
  it.each([
    ["Money Line – Match", "Home or Draw"],
    ["Resultado Final", "Flamengo ou Empate"],
    ["Money Line – Match", "Draw or Away"],
  ])("%s / %s é Dupla Chance, não empate", (mercado, selecao) => {
    // Com a casa vencendo 2-0, ler isto como "empate" devolveria LOST.
    expect(liquidar(mercado, selecao)).toMatchObject({
      ok: false,
      reason: "ambiguous_selection",
    });
  });

  it.each([
    ["Money Line – Match", "No Draw"],
    ["Resultado Final", "Sem empate"],
  ])("%s / %s é anti-empate, não empate", (mercado, selecao) => {
    // Num 0-0, ler isto como "empate" devolveria WON para quem apostou CONTRA.
    const r = resolveResultFromScore({
      mercado,
      selecao,
      evento: EVENTO,
      esporte: "Soccer",
      homeScore: 0,
      awayScore: 0,
      odds: 2,
      stake: 10,
    });
    expect(r).toMatchObject({ ok: false, reason: "ambiguous_selection" });
  });

  it("empate puro continua liquidando", () => {
    const empatou = resolveResultFromScore({
      mercado: "Money Line – Match",
      selecao: "Empate",
      evento: EVENTO,
      esporte: "Soccer",
      homeScore: 1,
      awayScore: 1,
      odds: 3,
      stake: 10,
    });
    expect(empatou).toMatchObject({ ok: true, status: "WON" });
  });
});

describe("estatística por time respeita o lado", () => {
  const cantos = { corners: { home: 5, away: 4 } } as never;
  const stat = (mercado: string, selecao: string) =>
    resolveResultFromStatistics({
      mercado,
      selecao,
      evento: EVENTO,
      odds: 1.85,
      stake: 5,
      stats: cantos,
    });

  it("rótulo com lado é team total mesmo sem a palavra 'total'", () => {
    // 4 cantos do visitante não cobrem Over 4.5; somar os dois lados (9) pagava.
    expect(stat("Away Corners", "Over 4.5")).toMatchObject({ ok: true, status: "LOST" });
    expect(stat("Home Corners", "Over 4.5")).toMatchObject({ ok: true, status: "WON" });
  });

  it("rótulo do mercado contra nome na seleção é ambíguo, não invertido", () => {
    expect(stat("Home Corners", "Palmeiras Over 4.5")).toMatchObject({
      ok: false,
      reason: "ambiguous_selection",
    });
  });

  it("total do jogo sem lado continua somando os dois", () => {
    expect(stat("Total Corners", "Over 8.5")).toMatchObject({ ok: true, status: "WON" });
  });
});

describe("handicap: lado no rótulo do mercado", () => {
  const ah = (mercado: string, selecao: string) =>
    resolveResultFromScore({
      mercado,
      selecao,
      evento: EVENTO,
      esporte: "Soccer",
      homeScore: 1,
      awayScore: 0,
      odds: 2,
      stake: 10,
    });

  it("rótulo contra nome é ambíguo", () => {
    expect(ah("Away Asian Handicap", "Flamengo -0.5")).toMatchObject({
      ok: false,
      reason: "ambiguous_selection",
    });
  });

  it("linha nua usa o lado do mercado em vez de ficar sem liquidador", () => {
    expect(ah("Home Asian Handicap", "-0.5")).toMatchObject({ ok: true, status: "WON" });
    expect(ah("Away Asian Handicap", "+0.5")).toMatchObject({ ok: true, status: "LOST" });
  });
});

/**
 * `✅ Finalizado` é green: existe teste em `telegram-parse` que documenta
 * `✅ Jogo encerrado` como marcação do tipster. O comportamento é deliberado.
 */

describe("famílias de estatística: cor, prop e agregado", () => {
  const cartoes = {
    yellowCards: { home: 1, away: 0 },
    redCards: { home: 1, away: 0 },
  } as never;
  const stat = (mercado: string, selecao: string) =>
    resolveResultFromStatistics({
      mercado, selecao, evento: EVENTO, odds: 1.9, stake: 10, stats: cartoes,
    });

  /**
   * `booking_points` é a fórmula asiática (amarelo=1, vermelho=2). Mercado que
   * DECLARA a cor conta aquela cor: com 1 amarelo e 1 vermelho, "Under 1.5
   * vermelhos" ganha (1), onde a fórmula daria 3 → LOST.
   */
  it("mercado que declara a cor conta a cor, não pontos de cartão", () => {
    expect(stat("Total Red Cards", "Under 1.5")).toMatchObject({ ok: true, status: "WON" });
    expect(stat("Total Yellow Cards", "Under 1.5")).toMatchObject({ ok: true, status: "WON" });
    // Genérico continua na fórmula: 1 + 2×1 = 3.
    expect(stat("Total Cards", "Under 1.5")).toMatchObject({ ok: true, status: "LOST" });
  });

  it.each(["Player Cards", "Cartões do Jogador", "Jogador - Cartões"])(
    "prop de jogador (%s) não liquida pela linha do time",
    (mercado) => {
      expect(stat(mercado, "Over 0.5")).toMatchObject({
        ok: false,
        reason: "unsupported_market",
      });
    },
  );
});

describe("artilheiro: só ANYTIME liquida sozinho", () => {
  it.each(["Anytime Goalscorer", "Marcar a Qualquer Momento"])(
    "%s é resolvível",
    (mercado) => {
      expect(ehMercadoArtilheiro(mercado)).toBe(true);
    },
  );

  /** First/Last exigem a ORDEM do gol, que a lista de jogadores não traz. */
  it.each(["First Goalscorer", "Last Goalscorer", "Primeiro a Marcar - Goalscorer"])(
    "%s NÃO é tratado como anytime",
    (mercado) => {
      expect(ehMercadoArtilheiro(mercado)).toBe(false);
    },
  );
});

describe("grafia da linha: sinal, espaço e barra não mudam o lado", () => {
  const ah = (selecao: string) =>
    resolveResultFromScore({
      mercado: "Asian Handicap", selecao, evento: EVENTO, esporte: "Soccer",
      homeScore: 0, awayScore: 0, odds: 1.9, stake: 10,
    });

  /** Um espaço entre o sinal e o número invertia a linha e o resultado. */
  it.each(["Flamengo -0.5", "Flamengo - 0.5", "Flamengo −0.5"])(
    "%s é linha NEGATIVA e perde no 0-0",
    (selecao) => {
      expect(ah(selecao)).toMatchObject({ ok: true, status: "LOST" });
    },
  );

  it.each([
    "Flamengo +0,-0.5", "Flamengo +0 ,-0.5", "Flamengo +0,- 0.5",
    "Flamengo +0.0,-0.5", "Flamengo +0/-0.5", "Flamengo 0/-0.5",
  ])("%s é o mesmo -0.25 escrito de outro jeito", (selecao) => {
    expect(ah(selecao)).toMatchObject({ ok: true, status: "HALF_LOST" });
  });
});

describe("Dupla Chance: todos os conectivos, uma lista só", () => {
  it.each(["Home or Draw", "Home and Draw", "Flamengo e Empate", "Home+Draw", "Home & Draw"])(
    "%s não é aposta no empate",
    (selecao) => {
      const r = resolveResultFromScore({
        mercado: "Moneyline", selecao, evento: EVENTO, esporte: "Soccer",
        homeScore: 1, awayScore: 1, odds: 1.9, stake: 10,
      });
      expect(r).toMatchObject({ ok: false, reason: "ambiguous_selection" });
    },
  );

  it.each(["Home or Draw", "Home and Draw", "Home+Draw"])(
    "%s É Dupla Chance quando o mercado declara",
    (selecao) => {
      expect(matchDoubleChanceSelection(selecao, EVENTO)).not.toBeNull();
    },
  );
});

describe("combo intervalo+final exige os DOIS placares", () => {
  it.each([
    "Half Time / Full Time", "HT/FT", "Resultado Intervalo/Final",
    "Resultado Duplo", "Resultado 1T/Final", "1st Half / Full Time",
  ])("%s não liquida pelo placar final", (mercado) => {
    expect(marketPeriodOf(mercado)).toBe("OTHER");
    expect(liquidar(mercado, "1")).toMatchObject({ ok: false, reason: "wrong_period" });
  });
});

describe("split de handicap por vírgula usa AS DUAS pernas", () => {
  const split = (selecao: string, home: number, away: number) =>
    resolveResultFromScore({
      mercado: "Asian Handicap",
      selecao,
      evento: EVENTO,
      esporte: "Soccer",
      homeScore: home,
      awayScore: away,
      odds: 2,
      stake: 10,
    });

  it.each([
    ["Flamengo 0,-0.5", 0, 0, "HALF_LOST"],
    ["Flamengo +0,-0.5", 0, 0, "HALF_LOST"],
    ["Flamengo 0,0.5", 0, 0, "HALF_WON"],
    ["Flamengo 0.0,-0.5", 0, 0, "HALF_LOST"],
    ["Flamengo -1,-1.5", 1, 0, "HALF_LOST"],
    ["Flamengo +1,+1.5", 0, 1, "HALF_WON"],
  ])("%s → %s", (selecao, home, away, esperado) => {
    expect(split(selecao, home as number, away as number)).toMatchObject({
      ok: true,
      status: esperado,
    });
  });

  it("sinal solto grudado na vírgula é grafia corrompida e falha fechado", () => {
    // `1-,1.5` pode ser -1.25 ou +1.25 — lados opostos. Liquidar com +1.0
    // seria usar uma linha que ninguém escreveu.
    expect(split("Flamengo 1-,1.5", 1, 0).ok).toBe(false);
  });

  it("split sem sinal na segunda perna não declara lado e falha fechado", () => {
    // "2,2.5" podia ser 2.25 ou dois números soltos; o tokenizador lia "2,2"
    // como 2.2 — número que ninguém escreveu.
    expect(split("Flamengo 2,2.5", 1, 0).ok).toBe(false);
  });
});

describe("split de handicap SEM vírgula (só espaço) é a mesma quarter line", () => {
  const split = (selecao: string, home: number, away: number) =>
    resolveResultFromScore({
      mercado: "Asian Handicap",
      selecao,
      evento: EVENTO,
      esporte: "Soccer",
      homeScore: home,
      awayScore: away,
      odds: 2,
      stake: 10,
    });

  // Grafia de OCR/cola: o par vem sem vírgula e não pode cair no ramo de "um
  // decimal", que devolve o valor ABSOLUTO da segunda perna — `-1 -1.5`
  // (= -1.25) liquidaria como +1.5 e `+0 -0.5` como +0.5.
  it.each([
    ["Flamengo +0 -0.5", 0, 0, "HALF_LOST"],
    ["Flamengo -1 -1.5", 1, 0, "HALF_LOST"],
    ["Flamengo +1 +1.5", 0, 1, "HALF_WON"],
  ])("%s → %s", (selecao, home, away, esperado) => {
    expect(split(selecao, home as number, away as number)).toMatchObject({
      ok: true,
      status: esperado,
    });
  });

  it("pernas que não distam 0.5 não são split — linha + odd americana", () => {
    // `-0.5 -110` é linha e PREÇO. Tratar como par daria a média -55.25.
    expect(split("Flamengo -0.5 -110", 1, 0).ok).toBe(false);
  });

  it("sinais opostos que não formam quarter line falham fechado", () => {
    expect(split("Flamengo +1.5 -0.5", 1, 0).ok).toBe(false);
  });
});

describe("`mais`/`menos` por extenso: sinal no handicap, direção no total", () => {
  // A MESMA palavra decide coisas opostas conforme o mercado. Um extrator que
  // só enxergue `[+-]` leria "menos 0.5" num handicap como POSITIVO, e um 0-0
  // devolveria WON onde a casa paga LOST.
  it("no handicap é o sinal da linha", () => {
    expect(liquidar("Asian Handicap", "Palmeiras menos 0.5")).toMatchObject({
      ok: true,
      status: "LOST",
    });
    expect(liquidar("Asian Handicap", "Flamengo menos 1.5")).toMatchObject({
      ok: true,
      status: "WON",
    });
  });

  it("no total continua sendo a direção", () => {
    expect(totalDirectionOf("menos 2.5")).toBe("under");
    expect(liquidar("Total – Match", "menos 2.5")).toMatchObject({
      ok: true,
      status: "WON",
    });
  });

  it("time + direção por extenso vira TEAM total, não total de jogo", () => {
    // Coagir para `Total` apagaria o time: 0x3 pagaria "Flamengo mais de 0.5"
    // com o Flamengo sem marcar.
    const mercado = coerceMercadoPelaSelecao("Moneyline", "Palmeiras mais de 0.5", "Soccer", EVENTO);
    expect(mercado).toContain("Team Total");
    expect(liquidar(mercado, "Palmeiras mais de 0.5")).toMatchObject({
      ok: true,
      status: "LOST",
    });
  });
});

describe("token de lado nu vence nome de clube que o contém", () => {
  // "Casa"/"Home"/"Away" sozinhos nomeiam o LADO DO JOGO. Se a similaridade de
  // nome decidisse antes, inverteria o lado em eventos com Casa Pia / Home
  // United / Away FC.
  it.each([
    ["Casa", "Santos vs Casa Pia", "home"],
    ["Home", "Arsenal vs Home United", "home"],
    ["Away", "Away FC vs Town", "away"],
    ["Mandante", "Santos vs Casa Pia", "home"],
  ])("%s em %s → %s", (selecao, evento, lado) => {
    expect(matchTeamSide(selecao, evento)).toBe(lado);
  });

  it("o NOME completo continua ganhando do token embutido", () => {
    expect(matchTeamSide("Casa Pia", "Santos vs Casa Pia")).toBe("away");
    expect(matchTeamSide("Home United", "Arsenal vs Home United")).toBe("away");
  });
});

describe("combos e famílias sem resolver falham fechado", () => {
  it.each([
    "Casa vence e ambas marcam",
    "Home Win and Both Teams to Score",
    "Resultado e Ambos Marcam",
    "BTTS e Over 2.5",
    "Both Teams to Score & Over 2.5",
    // Ambas marcam em cada tempo exige o BTTS no 1º e no 2º.
    "Ambas marcam nos dois tempos",
    "Both Teams To Score In Both Halves",
  ])("%s não liquida como BTTS puro", (mercado) => {
    // Num 1-1 o combo sairia WON pela perna de "ambas marcam", com a casa não
    // tendo vencido.
    expect(
      resolveResultFromScore({
        mercado,
        selecao: "Sim",
        evento: EVENTO,
        esporte: "Soccer",
        homeScore: 1,
        awayScore: 1,
        odds: 2,
        stake: 10,
      }),
    ).toMatchObject({ ok: false });
  });

  it.each(["Ambas marcam no 1º e no 2º tempo", "Ambas marcam 1ºT e 2ºT", "Both Teams To Score 1st Half and 2nd Half"])(
    "%s pede o BTTS em cada tempo e não liquida pelo parcial do 2º tempo",
    (mercado) => {
      expect(resolveResultFromScore({
        mercado, selecao: "Sim", evento: EVENTO, esporte: "Soccer", homeScore: 1, awayScore: 1, odds: 2, stake: 10, scorePeriod: "SECOND_HALF",
      })).toEqual({ ok: false, reason: "wrong_period" });
    },
  );

  it.each(["Both Teams to Score", "Ambas Marcam", "Ambas Marcam – Jogo", "Gol/Gol"])(
    "%s continua sendo BTTS puro",
    (mercado) => {
      expect(classifyScoreMarket(mercado.toLowerCase(), "sim", EVENTO)).toBe("btts");
    },
  );

  it.each(["Race to 3 Corners", "First to 3 Corners", "Corrida ate 3 escanteios"])(
    "%s não é over/under do agregado",
    (mercado) => {
      // "Race to 3 / Under 2.5" com 1-1 daria WON pela SOMA.
      expect(
        resolveResultFromStatistics({
          mercado,
          selecao: "Under 2.5",
          evento: EVENTO,
          odds: 2,
          stake: 10,
          stats: { corners: { home: 1, away: 1 } },
        }),
      ).toMatchObject({ ok: false, reason: "unsupported_market" });
    },
  );
});

describe("prorrogação: só o rótulo que DECLARA inclusão usa o placar final", () => {
  it.each(["AET Winner", "Winner AET", "After Extra Time Winner", "ET Result"])(
    "%s é decisão humana",
    (mercado) => {
      // `\bet\b` não casa dentro de "aet": sem cuidado, "AET Winner"
      // liquidaria por FT enquanto o irmão por extenso recusa.
      expect(marketPeriodOf(mercado)).toBe("OTHER");
    },
  );

  it.each([
    "Match Winner Including OT",
    "Winner (Incl. OT)",
    "Vencedor Incluindo Prorrogação",
    "Vencedor Incluir Prorrogação",
    "Vencedor com Prorrogação",
  ])("%s usa o agregado, em qualquer flexão", (mercado) => {
    // A MESMA promessa não pode ser lida de duas formas conforme a conjugação
    // do tipster: "Incluir Prorrogação" tem de dar FT, como "Including OT".
    expect(marketPeriodOf(mercado)).toBe("FT");
  });
});
