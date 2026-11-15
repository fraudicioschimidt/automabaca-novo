import { describe, expect, it } from "vitest";
import { marketIncludesExtraTime, marketKindOf, marketPeriodOf } from "@/src/domain/mercados/classify";
import { isMercadoFinalForSport } from "@/src/domain/mercados/compatibility";
import { parseBetLegs } from "@/src/domain/bet-legs";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { resolveResultFromStatistics } from "@/src/domain/settlement/statistics";
import { coerceMercadoPelaSelecao } from "@/src/domain/mercados/coerce";
import { inferPinnacleStatMarket } from "@/src/domain/mercados/stat-unit";
import { enrichParsedBetFromCaption } from "@/src/services/capture/preparation/parse-caption-enrich";
import { normalizeMercado } from "@/src/services/mercados/normalize";
import { normalizeBetFields, normalizeTicketLegs } from "@/src/services/bets/normalize-fields";
import { oddsProviders } from "@/src/providers/coverage";
import { PRODUCTION_MARKET_ALIASES, productionMarketCatalogClient } from "../fixtures/mercados-alias-producao";

const evento = "Flamengo vs Palmeiras";
const client = productionMarketCatalogClient();
const normalize = (mercado: string, selecao: string, esporte = "Soccer") =>
  normalizeBetFields({ evento, mercado, selecao, esporte, client });

/** Legendas que declaram a estatística do total, lidas pelo enrich da captura. */
const CAPTIONS = ["", "Over 9.5 escanteios", "Over 3.5 cartões"];

/** Seleções de todas as famílias, sem período próprio: o período vem só do mercado. */
const SELECTIONS = [
  "Over 0.5", "Under 1.5", "Mais de 2.5", "Flamengo -0.5", "Flamengo", "1X", "Ambas marcam",
  "Over 9.5 escanteios", "Over 3.5 cartões", "Flamengo over 1.5", "Pedro",
];

describe("normalizeBetFields — a coerção nunca muda o período do mercado", () => {
  // Cada alias é normalizado uma vez; a coerção e a estatística da legenda
  // rodam sobre os rótulos distintos que saem daí.
  it.each(["Soccer", "Basketball", "Unknown"])("vale para todos os aliases de produção (%s)", async (esporte) => {
    const violations: string[] = [];
    const labels = new Map<string, ReturnType<typeof marketPeriodOf>>();
    for (const [destino, alias] of PRODUCTION_MARKET_ALIASES) {
      const expected = marketPeriodOf(destino, esporte);
      const { mercado } = await normalizeMercado(alias, { esporte, client });
      if (marketPeriodOf(mercado, esporte) !== expected) violations.push(`alias ${alias} (${destino}) → ${mercado}`);
      labels.set(destino, expected).set(mercado, expected).set(alias, marketPeriodOf(alias, esporte));
    }
    for (const [label, expected] of labels) {
      for (const selecao of SELECTIONS) {
        const coerced = coerceMercadoPelaSelecao(label, selecao, esporte, evento);
        if (marketPeriodOf(coerced, esporte) !== expected) violations.push(`coerção ${label} + ${selecao} → ${coerced}`);
        for (const caption of CAPTIONS) {
          const inferred = inferPinnacleStatMarket(label, selecao, caption, evento, esporte);
          if (marketPeriodOf(inferred, esporte) !== expected) violations.push(`legenda "${caption}" ${label} + ${selecao} → ${inferred}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("'Mercado: 1º tempo - escanteios / Over 4.5' pela legenda continua no 1º tempo", async () => {
    const caption = "Jogo: Flamengo x Palmeiras\nMercado: 1º tempo - escanteios\nEntrada: Over 4.5\n@1.90\n1u";
    const bet = {
      evento, esporte: "Soccer", competicao: "", pais: "", mercado: "1º tempo - escanteios", selecao: "Over 4.5",
      odds: 1.9, stake: 1, data: null, casaDeAposta: "",
    };
    const enriched = enrichParsedBetFromCaption(bet, caption);
    expect(enriched.mercado).toBe("Total (Corners) – 1st Half");
    expect((await normalize(enriched.mercado, enriched.selecao)).mercado).toBe("Total (Corners) – 1st Half");
  });

  it.each([
    ["Primeiro tempo", "Over 0.5", "Total – 1st Half"],
    ["Gols - 1º tempo", "Over 0.5", "Total – 1st Half"],
    ["Primeiro tempo", "Flamengo -0.5", "Handicap – 1st Half"],
  ])("'Mercado: %s / Entrada: %s' fica no 1º tempo (%s)", async (mercado, selecao, final) => {
    expect((await normalize(mercado, selecao)).mercado).toBe(final);
  });

  it.each([
    ["Total", "Over 0.5 1ºT"],
    ["Total", "Over 1.5 2ºT"],
    ["Total", "Over 0.5 (1°T)"],
    ["Total", "Over 0.5 PT"],
    ["Total", "Over 0.5 primeira metade"],
    ["Total", "Over 0.5 gols 0-10 min"],
    ["Asian Handicap", "Flamengo -0.5 1ºT"],
    ["Moneyline", "Flamengo 1ºT"],
    ["Gols 1ºT", "Over 0.5"],
  ])("'%s / %s' não vira aposta de jogo inteiro nem liquida pelo placar final", async (mercado, selecao) => {
    const gravada = await normalize(mercado, selecao);
    const resultado = resolveResultFromScore({
      ...gravada, evento, esporte: "Soccer", homeScore: 2, awayScore: 0, odds: 1.4, stake: 1,
    });
    expect(resultado, `${gravada.mercado} / ${gravada.selecao}`).toEqual({ ok: false, reason: "wrong_period" });
  });

  it.each([
    ["Total", "Over 0.5 1T e 2T"],
    ["Total", "Over 0.5 1ºT e 2ºT"],
    ["Total", "Over 0.5 1º e 2ºT"],
    ["Gols", "Mais de 0.5 gols no 1º e no 2º tempo"],
    ["Total", "Over 0.5 1st and 2nd half"],
    ["Total", "Over 0.5 nos dois tempos"],
    ["Total", "Over 0.5 em cada tempo"],
    ["Total", "Over 0.5 both halves"],
    ["Total", "Over 0.5 PT e ST"],
    ["Total 1T e 2T", "Over 0.5"],
    ["Handicap Asiático", "Flamengo -0.5 1T e 2T"],
    ["Handicap Asiático", "Flamengo -0.5 nos dois tempos"],
    ["Moneyline", "Flamengo vence os dois tempos"],
  ])("'%s / %s' pede cada tempo: não liquida por um placar só", async (mercado, selecao) => {
    // Gol ou vitória em cada tempo: com o intervalo 0-0 e o 2º tempo 1-0 a
    // aposta perde, e nenhum placar sozinho (1º, 2º ou final) responde.
    const gravada = await normalize(mercado, selecao);
    expect(marketPeriodOf(gravada.mercado) === "OTHER" || marketPeriodOf(gravada.selecao) === "OTHER",
      `${gravada.mercado} / ${gravada.selecao}`).toBe(true);
    for (const [scorePeriod, homeScore] of [["HT", 0], ["SECOND_HALF", 1], ["FT", 1]] as const) {
      expect(resolveResultFromScore({
        ...gravada, evento, esporte: "Soccer", homeScore, awayScore: 0, odds: 1.4, stake: 1, scorePeriod,
      }), `${scorePeriod}: ${gravada.mercado} / ${gravada.selecao}`).toEqual({ ok: false, reason: "wrong_period" });
    }
  });

  // O rótulo que não declara período vira "– Match"; com o 1º tempo só na
  // seleção, o contrato de preço via "match" contra "half:1" e recusava.
  it.each([
    ["Total de Gols", "Over 0.5 HT", "Total – 1st Half"],
    ["Gols", "Over 0.5 1ºT", "Total – 1st Half"],
    ["Total", "Over 0.5 1º tempo", "Total – 1st Half"],
    ["Handicap Asiático", "Flamengo -0.5 HT", "Handicap – 1st Half"],
    ["Escanteios", "Over 4.5 HT", "Total (Corners) – 1st Half"],
  ])("'%s / %s': o 1º tempo só na seleção vai para o mercado (%s), com preço", async (mercado, selecao, final) => {
    const gravada = await normalize(mercado, selecao);
    expect(gravada.mercado).toBe(final);
    expect(oddsProviders({ esporte: "Soccer", mercado: gravada.mercado, selecao: gravada.selecao })).toContain("pinnacle17");
  });

  it("2º tempo sem variante no catálogo mantém o rótulo recebido em vez de virar jogo inteiro", async () => {
    const { mercado } = await normalize("Gols 2º tempo", "Over 0.5");
    expect(marketPeriodOf(mercado)).toBe("SECOND_HALF");
  });
});

describe("normalizeBetFields — total do time", () => {
  it.each(["Flamengo over 1.5 gols", "Over 1.5 gols do Flamengo", "Palmeiras under 0.5", "Flamengo O 1.5", "Palmeiras U 0.5"])(
    "Total genérico com o time na seleção vira Team Total: %s", async (selecao) => {
      expect((await normalize("Total", selecao)).mercado).toBe("Team Total – Match");
    },
  );

  it("total do jogo continua total do jogo", async () => {
    expect((await normalize("Total", "Over 2.5 gols")).mercado).toBe("Total – Match");
  });

  it("com a categoria no nome (U20/U21/U23), grava a linha da sigla do fim e liquida pelo time", async () => {
    // Placar 1-3 em todos: o visitante fez 3, o mandante 1.
    for (const [evento, mercado, selecao, final, status] of [
      ["Flamengo U20 x Palmeiras U20", "Total", "Palmeiras U20 U 1.5", "Palmeiras U20 Under 1.5", "LOST"],
      ["Flamengo U20 x Palmeiras U20", "Total", "Flamengo U20 U 2.5", "Flamengo U20 Under 2.5", "WON"],
      ["Brasil U21 x Argentina U21", "Team Total", "Argentina U21 O 2.5", "Argentina U21 Over 2.5", "WON"],
      ["Benfica B x Sporting U23", "Team Total", "Sporting U23 U 1.5", "Sporting U23 Under 1.5", "LOST"],
      ["Benfica B x Sporting U23", "Total", "Sporting U23 U 3.5", "Sporting U23 Under 3.5", "WON"],
    ] as const) {
      const gravada = await normalizeBetFields({ evento, mercado, selecao, esporte: "Soccer", client });
      expect(gravada, selecao).toMatchObject({ mercado: "Team Total – Match", selecao: final });
      expect(resolveResultFromScore({ ...gravada, evento, esporte: "Soccer", homeScore: 1, awayScore: 3, odds: 1.4, stake: 1 }), selecao)
        .toMatchObject({ ok: true, status });
    }
  });

  it("com a categoria na frente do nome e a direção por extenso, a categoria não vira a direção", async () => {
    // Placar 1-3 em todos: o visitante fez 3, o mandante 1.
    for (const [evento, mercado, selecao, final, status] of [
      ["U21 Spain vs U21 Italy", "Team Total", "U21 Spain Over 2.5", "U21 Spain Over 2.5", "LOST"],
      ["U21 Spain vs U21 Italy", "Total", "U21 Spain Mais de 2.5", "U21 Spain Over 2.5", "LOST"],
      ["U21 Spain vs U21 Italy", "Team Total", "U21 Italy Under 3.5", "U21 Italy Under 3.5", "WON"],
      ["U23 Sporting vs U23 Benfica", "Team Total", "U23 Sporting Over 1.5", "U23 Sporting Over 1.5", "LOST"],
    ] as const) {
      const gravada = await normalizeBetFields({ evento, mercado, selecao, esporte: "Soccer", client });
      expect(gravada, selecao).toMatchObject({ mercado: "Team Total – Match", selecao: final });
      expect(resolveResultFromScore({ ...gravada, evento, esporte: "Soccer", homeScore: 1, awayScore: 3, odds: 1.9, stake: 1 }), selecao)
        .toMatchObject({ ok: true, status });
    }
  });
});

describe("normalizeBetFields — handicap europeu dito na seleção", () => {
  it.each(["Flamengo -1 (Handicap Europeu)", "Handicap 3 vias Flamengo -1"])(
    "'%s' não vira handicap asiático", async (selecao) => {
      const { mercado, selecao: final } = await normalize("Asian Handicap", selecao);
      expect(mercado).toBe("European Handicap");
      expect(final).toBe("Flamengo -1");
    },
  );

  it("'Resultado com Handicap' é o europeu de 3 vias: não liquida como asiático", () => {
    expect(marketKindOf("Resultado com Handicap")).toBe("other");
    expect(resolveResultFromScore({
      evento, mercado: "Resultado com Handicap", selecao: "Flamengo -1", odds: 1.9, stake: 1, homeScore: 1, awayScore: 0,
    })).toEqual({ ok: false, reason: "unsupported_market" });
  });
});

describe("normalizeBetFields — vocabulário de artilheiro e moneyline", () => {
  it("alias 'gol' com Over/Under é total de gols, não artilheiro", async () => {
    expect((await normalize("Gol", "Over 0.5")).mercado).toBe("Total – Match");
    expect((await normalize("Gol", "Pedro")).mercado).toBe("Anytime Goalscorer");
  });

  it("'Pedro para marcar' grava o jogador, sem o 'para'", async () => {
    expect((await normalize("Anytime Goalscorer", "Pedro para marcar")).selecao).toBe("Pedro");
  });

  it.each(["Ambas marcam", "Over2.5", "2.5+ gols", "Placar exato 2x1"])(
    "Moneyline com '%s' não conta como mercado reconhecido", async (selecao) => {
      expect(await normalize("Moneyline", selecao)).toMatchObject({ mercado: "Money Line – Match", mercadoMatched: false });
    },
  );

  it("'Ambas marcam no jogo' grava o Sim do BTTS", async () => {
    expect(await normalize("Ambas marcam", "Ambas marcam no jogo")).toMatchObject({ mercado: "Both Teams to Score", selecao: "Yes" });
  });

  it.each(["BTTS No FT", "Ambas Marcam - No (FT)", "Both Teams to Score - No (FT)", "BTTS - No (1.85)"])(
    "'Ambas marcam' + '%s' grava o Não e perde num 1-1", async (selecao) => {
      const gravada = await normalize("Ambas marcam", selecao);
      expect(gravada).toMatchObject({ mercado: "Both Teams to Score", selecao: "No" });
      expect(resolveResultFromScore({ ...gravada, evento, esporte: "Soccer", homeScore: 1, awayScore: 1, odds: 1.4, stake: 1 }))
        .toMatchObject({ ok: true, status: "LOST" });
    },
  );

  it.each([["Ambas marcam No FT"], ["Ambas Marcam No FT"], ["AMBAS MARCAM NO FT"], ["Ambas marcam No 1T", "HT"]] as const)(
    "'Ambas marcam' + '%s': o 'No' maiúsculo antes do tempo pode ser o Não e não decide", async (selecao, scorePeriod?: "HT") => {
      const gravada = await normalize("Ambas marcam", selecao);
      expect(gravada.selecao).toBe(selecao);
      expect(resolveResultFromScore({ ...gravada, evento, esporte: "Soccer", homeScore: 1, awayScore: 1, odds: 1.4, stake: 1, scorePeriod }))
        .toEqual({ ok: false, reason: "ambiguous_selection" });
    },
  );

  it("'Ambas marcam no FT' com a preposição minúscula segue o Sim", async () => {
    expect(await normalize("Ambas marcam", "Ambas marcam no FT")).toMatchObject({ mercado: "Both Teams to Score", selecao: "Yes" });
  });

  it.each(["BTTS - No - 1T", "BTTS No (1T)"])("'%s' guarda o 1º tempo e perde num 1-1 no intervalo", async (selecao) => {
    for (const mercado of ["Ambas marcam", "Ambas marcam 1º tempo"]) {
      const gravada = await normalize(mercado, selecao);
      const liquidar = (scorePeriod?: "HT") =>
        resolveResultFromScore({ ...gravada, evento, esporte: "Soccer", homeScore: 1, awayScore: 1, odds: 1.4, stake: 1, scorePeriod });
      expect(liquidar("HT"), mercado).toMatchObject({ ok: true, status: "LOST" });
      expect(liquidar(), mercado).toEqual({ ok: false, reason: "wrong_period" });
    }
  });

  it.each([
    ["Gol/Gol no 1T", "HT"], ["Gol/Gol no 1ºT", "HT"], ["Gol/Gol no HT", "HT"], ["BTTS no 1T", "HT"], ["Ambas no 1T", "HT"],
    ["Gol dos dois no 1T", "HT"], ["BTTS No 1T", "HT"], ["Gol/Gol no 2T", "SECOND_HALF"], ["BTTS no 2ºT", "SECOND_HALF"],
  ] as const)("'Ambas marcam' + '%s' não vira o Não nem perde num 1-1 no parcial", async (selecao, scorePeriod) => {
    // O tipster pode ter apostado no Sim e ganhado; lido como o Não, sairia LOST.
    const gravada = await normalize("Ambas marcam", selecao);
    expect(gravada.selecao).toBe(selecao);
    expect(resolveResultFromScore({ ...gravada, evento, esporte: "Soccer", homeScore: 1, awayScore: 1, odds: 1.4, stake: 1, scorePeriod }))
      .toEqual({ ok: false, reason: "ambiguous_selection" });
  });

  it.each(["Ambas marcam nos dois tempos", "Both teams to score in both halves"])(
    "'Ambas marcam' + '%s' fica como veio e não liquida pelo placar final", async (selecao) => {
      const gravada = await normalize("Ambas marcam", selecao);
      expect(gravada.selecao).toBe(selecao);
      expect(resolveResultFromScore({ ...gravada, evento, esporte: "Soccer", homeScore: 1, awayScore: 1, odds: 1.4, stake: 1 }))
        .toEqual({ ok: false, reason: "wrong_period" });
    },
  );

  it("'Ambas marcam no 1º e no 2º tempo' fica como veio e não liquida pelo parcial do 2º tempo", async () => {
    const gravada = await normalize("Ambas marcam", "Ambas marcam no 1º e no 2º tempo");
    expect(gravada.selecao).toBe("Ambas marcam no 1º e no 2º tempo");
    expect(resolveResultFromScore({
      ...gravada, evento, esporte: "Soccer", homeScore: 1, awayScore: 1, odds: 1.4, stake: 1, scorePeriod: "SECOND_HALF",
    })).toEqual({ ok: false, reason: "wrong_period" });
  });

  it.each(["Ambas as equipes marcarão no jogo", "Gol/Gol no jogo"])(
    "'Ambas marcam' + '%s' grava o Sim e ganha num 1-1", async (selecao) => {
      const gravada = await normalize("Ambas marcam", selecao);
      expect(gravada).toMatchObject({ mercado: "Both Teams to Score", selecao: "Yes" });
      expect(resolveResultFromScore({ ...gravada, evento, esporte: "Soccer", homeScore: 1, awayScore: 1, odds: 1.4, stake: 1 }))
        .toMatchObject({ ok: true, status: "WON" });
    },
  );

  it("Moneyline com o time segue reconhecido", async () => {
    expect(await normalize("Moneyline", "Flamengo")).toMatchObject({ selecao: "Flamengo", mercadoMatched: true });
  });
});

/**
 * Tempo regulamentar num esporte com prorrogação. Os quatro textos são os que
 * a captura recebe de verdade; todos viravam Money Line – Game, que o
 * FlashScore paga pelo placar com prorrogação.
 */
describe("normalizeBetFields — tempo regulamentar no basquete e no hóquei", () => {
  const lakers = "Lakers vs Celtics";
  const normalizeIn = (mercado: string, selecao: string, esporte: string, evento = lakers) =>
    normalizeBetFields({ evento, mercado, selecao, esporte, client });

  it.each([
    ["1X2", "Lakers"],
    ["Tempo Regular", "Lakers"],
    ["Resultado Final 1x2", "1"],
    ["Resultado Final", "1 (TR)"],
  ])("basquete '%s' / '%s' grava o Money Line do tempo regulamentar", async (mercado, selecao) => {
    expect((await normalizeIn(mercado, selecao, "Basketball")).mercado).toBe("Money Line – Regulation Time");
  });

  it("'Tempo Regular - Handicap de Pontos' grava o handicap do tempo regulamentar", async () => {
    expect((await normalizeIn("Tempo Regular - Handicap de Pontos", "Lakers -5.5", "Basketball")).mercado)
      .toBe("Handicap – Regulation Time");
  });

  it("aposta no empate do basquete só existe no tempo regulamentar", async () => {
    expect((await normalizeIn("Money Line", "Empate", "Basketball")).mercado).toBe("Money Line – Regulation Time");
  });

  it("\"(1x2)\" que é o placar ao vivo não vira tempo regulamentar", async () => {
    const hockey = (liveScore: { home: number; away: number } | null) => normalizeBetFields({
      evento: "Rangers vs Bruins", mercado: "Money Line", selecao: "Rangers (1x2)", esporte: "Ice Hockey", client, liveScore,
    });
    expect((await hockey({ home: 1, away: 2 })).mercado).toBe("Money Line");
    // Sem placar estruturado, "(1x2)" é o mercado de 3 vias.
    expect((await hockey(null)).mercado).toBe("Money Line – Regulation Time");
  });

  it("hóquei também guarda o tempo regulamentar", async () => {
    expect((await normalizeIn("1X2", "Rangers", "Ice Hockey", "Rangers vs Bruins")).mercado)
      .toBe("Money Line – Regulation Time");
  });

  it("esporte desconhecido na captura: a confirmação mantém no basquete e devolve ao 1X2 no futebol", async () => {
    const captured = await normalizeIn("1X2", "Lakers", "Unknown");
    expect(captured.mercado).toBe("Money Line – Regulation Time");
    expect((await normalizeIn(captured.mercado, captured.selecao, "Basketball")).mercado)
      .toBe("Money Line – Regulation Time");
    expect((await normalizeIn(captured.mercado, captured.selecao, "Soccer", evento)).mercado)
      .toBe("Money Line – Match");
  });

  it("sem declaração, o basquete e o futebol seguem como antes", async () => {
    expect((await normalizeIn("Money Line", "Lakers", "Basketball")).mercado).toBe("Money Line – Game");
    expect((await normalizeIn("Handicap (incl. prorrogação)", "Lakers -5.5", "Basketball")).mercado)
      .toBe("Handicap – Game");
    expect((await normalize("1X2", "Flamengo")).mercado).toBe("Money Line – Match");
    expect((await normalize("Resultado Final", "1 (TR)")).mercado).toBe("Money Line – Match");
  });
});

describe("normalizeBetFields — gols de jogador acima de dois", () => {
  it.each(["To Score a Hat-trick", "Hat-trick", "3+ Gols", "Marcar 3 ou mais gols", "To Score 3 or More Goals"])(
    "'%s' vira To Score 3+ Goals, não o anytime",
    async (mercado) => {
      expect((await normalize(mercado, "Pedro")).mercado).toBe("To Score 3+ Goals");
    },
  );
});

describe("normalizeBetFields — placar exato com o time citado", () => {
  it.each([["Palmeiras 2x1", "1-2"], ["Flamengo 2x1", "2-1"], ["2x1", "2-1"], ["Palmeiras 1x2", "Palmeiras 1x2"]])(
    "'Placar exato / %s' grava %s, na ordem do evento", async (selecao, final) => {
      expect(await normalize("Placar exato", selecao)).toMatchObject({ mercado: "Correct Score", selecao: final });
    },
  );
});

describe("normalizeBetFields — jogador depois da linha", () => {
  it.each([
    ["Real Madrid vs Barcelona", "Chutes no gol", "Over 0.5 - Mbappé", "Soccer"],
    ["Real Madrid vs Barcelona", "Cartões", "Over 0.5 (Casemiro)", "Soccer"],
    ["Real Madrid vs Barcelona", "Total de Chutes", "Over 2.5 Mbappé", "Soccer"],
    ["Aces vs Liberty", "Total de pontos", "Menos de 27.5 [A'ja Wilson]", "Basketball"],
  ])("%s · %s / %s não perde o jogador", async (evento, mercado, selecao, esporte) => {
    const { selecao: final } = await normalizeBetFields({ evento, mercado, selecao, esporte, client });
    expect(final).toBe(selecao);
  });

  it.each([
    ["Over 1.5 Flamengo gols", "Flamengo Over 1.5"],
    ["Over 2.5 gols @1.90", "Over 2.5"],
    ["Over 2.5 - Odds 1.90", "Over 2.5"],
    ["Over 2.5 gols do jogo", "Over 2.5"],
    ["Mais de 2.5 gols na partida", "Over 2.5"],
    ["Over 2.5 incluindo prorrogação", "Over 2.5 incluindo prorrogação"],
    ["Over 2.5 (Asiático)", "Over 2.5"],
  ])("unidade, escopo, odd e time depois da linha seguem normalizados: %s → %s", async (selecao, final) => {
    expect((await normalize("Total", selecao)).selecao).toBe(final);
  });

  it.each([
    "Over 2.5 gols tempo normal", "Mais de 2.5 gols no jogo todo", "Over 2.5 gols partida inteira",
    "Over 2.5 goles", "Over 2.5 gols ambos os times",
    "Over 2.5 AH", "Over 2.5 gls", "Over 2.5 gols jogo completo", "Over 2.5 - Tempo Integral",
    "Over 2.5 gols pré-jogo", "Over 2.5 linha principal", "Over 2.5 linha alternativa", "Over 2.5 (alternativo)", "Over 2.5 (cheio)",
    "Over 2.5 Brasileirão", "Over 2.5 Serie A", "Over 2.5 Betano", "Over 2.5 hoje",
    // O país da competição é o lugar do jogo, não quem faz a estatística.
    "Over 2.5 Copa do Brasil", "Over 2.5 Copa Itália", "Over 2.5 Liga de Portugal",
    "Over 2.5 - Italy Serie A", "Over 2.5 World Cup", "Over 2.5 Copa da Irlanda do Norte",
  ])("o escopo do jogo depois da linha não é jogador e liquida pelo placar: %s", async (selecao) => {
    const gravada = await normalize("Total", selecao);
    expect(gravada.selecao).toBe("Over 2.5");
    expect(resolveResultFromScore({ ...gravada, evento, esporte: "Soccer", homeScore: 2, awayScore: 1, odds: 1.9, stake: 1 }))
      .toMatchObject({ ok: true, status: "WON" });
  });

  it("o país sem a competição continua sujeito e fica com o dono", async () => {
    expect((await normalize("Total", "Over 1.5 Brasil")).selecao).toBe("Over 1.5 Brasil");
  });

  // O país que é um lado do jogo de seleções é o time, em qualquer língua do
  // evento: tirá-lo liquidaria pelo total da partida o total do time.
  it.each([
    ["Brazil vs Argentina", "Over 1.5 Brasil Copa do Mundo"],
    ["Brazil vs Argentina", "Over 1.5 Brasil Copa"],
    ["Italy vs Spain", "Over 1.5 Italia Copa do Mundo"],
    ["Germany vs France", "Over 1.5 Alemanha Copa do Mundo"],
    ["Brazil vs Argentina", "Over 1.5 Copa do Brasil"],
  ])("%s / %s: a seleção do evento em inglês fica com o dono", async (eventName, selecao) => {
    const gravada = await normalizeBetFields({ evento: eventName, mercado: "Total", selecao, esporte: "Soccer", client });
    expect(gravada.selecao).toBe(selecao);
    expect(resolveResultFromScore({ ...gravada, evento: eventName, esporte: "Soccer", homeScore: 1, awayScore: 1, odds: 1.9, stake: 1 }))
      .toEqual({ ok: false, reason: "unsupported_market" });
  });

  it("região que também é time não sai como país: 'New England' continua sujeito", async () => {
    const gravada = await normalizeBetFields({
      evento: "Patriots vs Bills", mercado: "Total", selecao: "Over 24.5 New England NFL", esporte: "American Football", client,
    });
    expect(resolveResultFromScore({ ...gravada, evento: "Patriots vs Bills", esporte: "American Football", homeScore: 20, awayScore: 10, odds: 1.9, stake: 1 }))
      .toEqual({ ok: false, reason: "unsupported_market" });
  });

  it("com o evento em português, a mesma seleção vira o total do time", async () => {
    const gravada = await normalizeBetFields({
      evento: "Brasil vs Argentina", mercado: "Total", selecao: "Over 1.5 Brasil Copa do Mundo", esporte: "Soccer", client,
    });
    expect(gravada).toMatchObject({ mercado: "Team Total – Match", selecao: "Brasil Over 1.5" });
    expect(resolveResultFromScore({ ...gravada, evento: "Brasil vs Argentina", esporte: "Soccer", homeScore: 1, awayScore: 1, odds: 1.9, stake: 1 }))
      .toMatchObject({ ok: true, status: "LOST" });
  });

  it.each([
    ["Lakers vs Celtics", "Over 210.5 (reg. time)", "Basketball"],
    ["Flamengo vs Palmeiras", "Over 0.5 gols nos acréscimos", "Soccer"],
  ])("%s / %s: o recorte do jogo que o período não lê fica com o dono", async (eventName, selecao, esporte) => {
    const gravada = await normalizeBetFields({ evento: eventName, mercado: "Total", selecao, esporte, client });
    expect(gravada.selecao).toBe(selecao);
    expect(resolveResultFromScore({ ...gravada, evento: eventName, esporte, homeScore: 110, awayScore: 105, odds: 1.9, stake: 1 }))
      .toEqual({ ok: false, reason: "unsupported_market" });
  });

  it.each([
    ["Real Madrid vs Barcelona", "Impedimentos", "Over 4.5 impedimentos", "Soccer", "offsides"],
    ["Real Madrid vs Barcelona", "Impedimentos", "Over 4.5 offsides", "Soccer", "offsides"],
    ["Real Madrid vs Barcelona", "Interceptações", "Over 15.5 interceptações", "Soccer", "interceptions"],
    ["Lakers vs Celtics", "Roubos de bola", "Over 12.5 roubos de bola", "Basketball", "steals"],
    ["Sinner vs Alcaraz", "Duplas faltas", "Over 5.5 duplas faltas", "Tennis", "double_faults"],
    ["Real Madrid vs Barcelona", "Chutes no gol", "Over 8.5 chutes certos", "Soccer", "shots_on_target"],
    ["Real Madrid vs Barcelona", "Escanteios", "Over 9.5 escanteios ambos os times", "Soccer", "corners"],
    ["Real Madrid vs Barcelona", "Cartões", "Over 3.5 cartões - ambos os times", "Soccer", "booking_points"],
  ])("%s · %s / %s: a estatística depois da linha não é jogador e liquida", async (evento, mercado, selecao, esporte, statistic) => {
    const gravada = await normalizeBetFields({ evento, mercado, selecao, esporte, client });
    expect(gravada.selecao).toMatch(/^Over \d+\.5$/);
    const pair = { home: 20, away: 25 };
    const stats = { offsides: pair, interceptions: pair, steals: pair, doubleFaults: pair, shotsOnTarget: pair, corners: pair, yellowCards: pair, redCards: { home: 0, away: 0 } };
    expect(resolveResultFromStatistics({ evento, mercado: gravada.mercado, selecao: gravada.selecao, odds: 1.9, stake: 1, stats }))
      .toMatchObject({ ok: true, status: "WON", statistic });
  });
});

describe("normalizeBetFields — total do time com o time no rótulo do mercado", () => {
  it.each([
    ["Total de gols - Flamengo", "Over 1.5", "Flamengo Over 1.5"],
    ["Total de gols do Flamengo", "Mais de 1.5", "Flamengo Over 1.5"],
    ["Flamengo - Total de Gols", "Over 1.5", "Flamengo Over 1.5"],
    ["Gols do Palmeiras", "Under 0.5", "Palmeiras Under 0.5"],
  ])("'%s' + '%s' é total do time, não do jogo", async (mercado, selecao, expected) => {
    const normalized = await normalize(mercado, selecao);
    expect(normalized.selecao).toBe(expected);
    expect(marketKindOf(normalized.mercado, normalized.selecao, evento)).toBe("team_total");
  });

  it.each([
    "Total de gols", "Total – Match", "Total – 1st Half", "Gols 2º tempo", "Total de gols 0-15 min",
    "Total (Corners) – Match", "Total de gols do jogo",
  ])("rótulo sem time ('%s') continua total do jogo", async (mercado) => {
    expect((await normalize(mercado, "Over 1.5")).selecao).toBe("Over 1.5");
  });

  it("o time da seleção vale quando o rótulo nomeia o outro", async () => {
    expect((await normalize("Total de gols - Flamengo", "Palmeiras Over 1.5")).selecao).toBe("Palmeiras Over 1.5");
  });
});

describe("normalizeBetFields — seleção combinada fica inteira", () => {
  it.each([
    ["Both Teams to Score", "Sim e Over 2.5"],
    ["Money Line – Match", "Flamengo e Over 1.5"],
    ["Resultado Final e Total de Gols", "Flamengo e Over 2.5"],
  ])("'%s' + '%s' não perde uma das condições nem troca de família", async (mercado, selecao) => {
    const normalized = await normalize(mercado, selecao);
    expect(normalized.selecao).toBe(selecao);
    expect(marketKindOf(normalized.mercado)).toBe(marketKindOf((await normalize(mercado, "Flamengo")).mercado));
  });
});


describe("normalizeTicketLegs — promessa do bilhete", () => {
  it("mantém a prorrogação mesmo quando o catálogo normaliza o rótulo da perna", async () => {
    const ticket = parseBetLegs(evento, "Flamengo + Over 1.5", "Vencedor incluindo prorrogação")!;
    const normalized = await normalizeTicketLegs(ticket, "Soccer", "", client);
    expect(normalized.legs.every((leg) => [leg.mercado, leg.selecao].some(marketIncludesExtraTime))).toBe(true);
  });

  it.each([
    ["Total (Corners) – Match", "Over 0.5 + Under 3.5"],
    ["Handicap Europeu", "Flamengo -1 + Over 1.5"],
  ])("%s mantém a regra depois de normalizar cada perna", async (mercado, selecao) => {
    const normalized = await normalizeTicketLegs(parseBetLegs(evento, selecao, mercado)!, "Soccer", "", client);
    const leg = normalized.legs[0]!;
    expect(resolveResultFromScore({ ...leg, esporte: "Soccer", homeScore: 2, awayScore: 0, odds: 3, stake: 1 }).ok).toBe(false);
  });
});

describe("normalizeBetFields — natureza e unidade da estatística", () => {
  it.each([
    ["Total", "Under 1.5 cartões vermelhos", "red_cards", "WON"],
    ["Total", "Under 1.5 red cards", "red_cards", "WON"],
    ["Total", "Under 2.5 cartões amarelos", "yellow_cards", "WON"],
    ["Total de Cartões", "Under 2.5 yellow cards", "yellow_cards", "WON"],
    ["Total de Cartões Amarelos", "Under 2.5 cartões", "yellow_cards", "WON"],
    ["Total de Cartões Vermelhos", "Under 1.5 cards", "red_cards", "WON"],
    ["Total de Chutes", "Under 4.5 shots on target", "shots_on_target", "WON"],
  ])("%s / %s conserva o resultado específico após normalizar", async (mercado, selecao, statistic, status) => {
    const normalized = await normalize(mercado, selecao);
    expect(resolveResultFromStatistics({
      ...normalized, odds: 2, stake: 1,
      stats: { yellowCards: { home: 1, away: 1 }, redCards: { home: 1, away: 0 },
        shotsTotal: { home: 8, away: 7 }, shotsOnTarget: { home: 1, away: 2 } },
    })).toMatchObject({ ok: true, statistic, status, lucro: 1 });
    expect(oddsProviders({ ...normalized, esporte: "Soccer" })).toEqual([]);
  });

  it("não escolhe uma das unidades quando mercado e seleção se contradizem", async () => {
    const normalized = await normalize("Total (Corners) – Match", "Under 2.5 cards");
    expect(resolveResultFromStatistics({ ...normalized, odds: 2, stake: 1,
      stats: { corners: { home: 6, away: 4 }, yellowCards: { home: 1, away: 0 }, redCards: { home: 0, away: 0 } },
    }).ok).toBe(false);
  });

  it.each([
    ["Total", "Under 8.5 runs", "Soccer"],
    ["Total", "Under 2.5 gols", "Basketball"],
    ["Total de Gols", "Under 2.5", "Basketball"],
    ["Total de Gols", "Under 2.5", "Futebol americano"],
  ])("%s / %s em %s não perde a unidade e não liquida por outro placar", async (mercado, selecao, esporte) => {
    const normalized = await normalize(mercado, selecao, esporte);
    expect(resolveResultFromScore({ ...normalized, esporte, homeScore: 1, awayScore: 1, odds: 2, stake: 1 }))
      .toEqual({ ok: false, reason: "score_unit_mismatch" });
    expect(oddsProviders({ ...normalized, esporte })).toEqual([]);
  });
});

describe("natureza da estatística declarada só na legenda", () => {
  it.each([
    ["cartões amarelos", "yellow_cards"], ["red cards", "red_cards"], ["shots on target", "shots_on_target"],
  ])("a legenda com %s não vira um total de gols", async (unit, statistic) => {
    const bet = { evento, esporte: "Soccer", competicao: "", pais: "", mercado: "Total", selecao: "Under 3.5",
      odds: 2, stake: 1, data: null, casaDeAposta: "" };
    const enriched = enrichParsedBetFromCaption(bet, `Jogo: Flamengo x Palmeiras\nUnder 3.5 ${unit}\nOdd 2.00\nStake 1u`);
    const normalized = await normalize(enriched.mercado, enriched.selecao);
    expect(resolveResultFromStatistics({ ...normalized, odds: 2, stake: 1,
      stats: { yellowCards: { home: 1, away: 1 }, redCards: { home: 1, away: 0 }, shotsOnTarget: { home: 1, away: 2 } },
    })).toMatchObject({ ok: true, statistic, status: "WON" });
    expect(resolveResultFromScore({ ...normalized, esporte: "Soccer", odds: 2, stake: 1, homeScore: 2, awayScore: 2 }).ok).toBe(false);
    expect(oddsProviders({ ...normalized, esporte: "Soccer" })).toEqual([]);
  });
});


describe("normalizeBetFields — prorrogação declarada no rótulo da aposta simples", () => {
  it("onde o jogo já inclui a prorrogação, declará-la não muda o mercado nem a seleção", async () => {
    const basketball = await normalizeBetFields({
      evento: "Lakers vs Celtics", mercado: "Handicap (incl. prorrogação)", selecao: "Lakers -5.5", esporte: "Basketball", client,
    });
    expect(basketball).toMatchObject({ mercado: "Handicap – Game", selecao: "Lakers -5.5", mercadoMatched: true });
    expect(isMercadoFinalForSport(basketball.mercado, "Basketball")).toBe(true);
    expect(oddsProviders({ ...basketball, esporte: "Basketball" })).toEqual(["bridgeodds", "pinnacle17"]);
  });

  it("nos outros esportes a regra vai para a seleção, e o mercado continua o do catálogo", async () => {
    const chiefs = "Chiefs vs Bills";
    const entry = await normalizeBetFields({
      evento: chiefs, mercado: "Handicap (incl. prorrogação)", selecao: "Chiefs -3.5", esporte: "American Football", client,
    });
    expect(entry).toMatchObject({ mercado: "Point Spread", selecao: "Chiefs -3.5 incluindo prorrogação", mercadoMatched: true });
    expect(isMercadoFinalForSport(entry.mercado, "American Football")).toBe(true);
    // Reeditar a aposta gravada não muda nada.
    expect(await normalizeBetFields({ ...entry, evento: chiefs, esporte: "American Football", client })).toMatchObject(entry);
    expect(resolveResultFromScore({ ...entry, evento: chiefs, esporte: "American Football", homeScore: 27, awayScore: 20, odds: 2, stake: 1 }))
      .toMatchObject({ ok: true, status: "WON" });
  });

  it("no futebol a aposta com prorrogação segue sem preço de 90 minutos e sem rótulo inventado", async () => {
    const entry = await normalize("Handicap (incl. prorrogação)", "Flamengo -0.5");
    expect(marketIncludesExtraTime(entry.mercado)).toBe(false);
    expect(marketIncludesExtraTime(entry.selecao)).toBe(true);
    expect(oddsProviders({ ...entry, esporte: "Soccer" })).toEqual([]);
  });
});
