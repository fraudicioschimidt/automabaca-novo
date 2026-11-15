import { describe, expect, it } from "vitest";
import { BetStatus } from "@/src/generated/prisma/client";
import { isScoreResolvableMarket } from "@/src/domain/settlement/markets";
import {
  resolveResultFromScore,
  lineOutsideSetScore,
} from "@/src/domain/settlement/score-resolution";
import { coerceMercadoPelaSelecao } from "@/src/domain/mercados/coerce";
import { resolveLiveScoreAtTip } from "@/src/domain/live-score-at-tip";

const base = {
  evento: "Flamengo vs Palmeiras",
  odds: 2.0,
  stake: 1,
};

describe("resolveResultFromScore — compatibilidade esporte × mercado final", () => {
  it("não liquida rótulo final pertencente a outro esporte", () => {
    expect(resolveResultFromScore({
      ...base,
      esporte: "Basketball",
      mercado: "Puck Line",
      selecao: "Flamengo -1.5",
      homeScore: 100,
      awayScore: 90,
    })).toEqual({ ok: false, reason: "unsupported_market" });
  });
});

describe("resolveResultFromScore — mercados do tempo regulamentar (placar sem prorrogação)", () => {
  const lakers = { evento: "Lakers vs Celtics", odds: 3, stake: 1, esporte: "Basketball" };
  it.each([
    ["Money Line – Regulation Time", "Empate", 100, 100, "WON"],
    ["Money Line – Regulation Time", "Lakers", 100, 100, "LOST"],
    ["Money Line – Regulation Time", "Lakers", 100, 98, "WON"],
    ["Handicap – Regulation Time", "Lakers -1.5", 100, 98, "WON"],
    ["Total – Regulation Time", "Over 190.5", 100, 98, "WON"],
  ] as const)("%s / %s em %i-%i sai %s", (mercado, selecao, homeScore, awayScore, status) => {
    expect(resolveResultFromScore({ ...lakers, mercado, selecao, homeScore, awayScore, scorePeriod: "REGULATION" }))
      .toMatchObject({ ok: true, status });
  });

  it("o placar do jogo inteiro (com prorrogação) nunca decide o mercado do tempo regulamentar", () => {
    expect(resolveResultFromScore({ ...lakers, mercado: "Money Line – Regulation Time", selecao: "Lakers", homeScore: 110, awayScore: 105 }))
      .toEqual({ ok: false, reason: "wrong_period" });
  });

  it("fora do basquete e do hóquei, o rótulo do tempo regulamentar não liquida", () => {
    expect(resolveResultFromScore({ ...base, esporte: "Tennis", mercado: "Money Line – Regulation Time", selecao: "Flamengo", homeScore: 2, awayScore: 0, scorePeriod: "REGULATION" }))
      .toEqual({ ok: false, reason: "unsupported_market" });
  });
});

describe("resolveResultFromScore — AH ao vivo liquida o restante do jogo", () => {
  const awayAh = (params: {
    selecao: string;
    homeScore: number;
    awayScore: number;
    liveScoreHome?: number;
    liveScoreAway?: number;
  }) => resolveResultFromScore({
    ...base,
    esporte: "Soccer",
    mercado: "Asian Handicap",
    ...params,
  });

  it.each([
    {
      name: "tip 1-0, visitante 0.0, FT 1-0 vira push",
      input: {
        selecao: "Palmeiras 0.0",
        liveScoreHome: 1,
        liveScoreAway: 0,
        homeScore: 1,
        awayScore: 0,
      },
      status: BetStatus.VOID,
    },
    {
      name: "tip 1-0, visitante +0.25, FT 1-1 ganha pelo 0-1 restante",
      input: {
        selecao: "Palmeiras +0.25",
        liveScoreHome: 1,
        liveScoreAway: 0,
        homeScore: 1,
        awayScore: 1,
      },
      status: BetStatus.WON,
    },
    {
      name: "tip 2-0, visitante +0.25, FT 2-0 dá meia ganha",
      input: {
        selecao: "Palmeiras +0.25",
        liveScoreHome: 2,
        liveScoreAway: 0,
        homeScore: 2,
        awayScore: 0,
      },
      status: BetStatus.HALF_WON,
    },
    {
      name: "sem placar live preserva o settlement prematch",
      input: {
        selecao: "Palmeiras 0.0",
        homeScore: 1,
        awayScore: 0,
      },
      status: BetStatus.LOST,
    },
    {
      name: "placar explícito 0-0 também preserva o prematch",
      input: {
        selecao: "Palmeiras 0.0",
        liveScoreHome: 0,
        liveScoreAway: 0,
        homeScore: 1,
        awayScore: 0,
      },
      status: BetStatus.LOST,
    },
  ])("$name", ({ input, status }) => {
    expect(awayAh(input)).toMatchObject({ ok: true, status });
  });

  it("recusa remainder só com placar no texto; captura é quem grava o par estruturado", () => {
    expect(awayAh({ selecao: "(1-0) Palmeiras +0.25", homeScore: 1, awayScore: 1 }))
      .toEqual({ ok: false, reason: "incomplete_live_score" });
    expect(awayAh({
      selecao: "(1-0) Palmeiras +0.25",
      liveScoreHome: 1,
      liveScoreAway: 0,
      homeScore: 1,
      awayScore: 1,
    })).toMatchObject({ ok: true, status: BetStatus.WON });
  });

  it("remainder exige o par estruturado; placar só no texto da seleção falha fechado", () => {
    expect(awayAh({
      selecao: "Palmeiras 0.0 (0-1)",
      homeScore: 1,
      awayScore: 1,
    })).toEqual({ ok: false, reason: "incomplete_live_score" });
    expect(awayAh({
      selecao: "Palmeiras +0.25",
      liveScoreHome: 1,
      liveScoreAway: 0,
      homeScore: 1,
      awayScore: 1,
    })).toMatchObject({ ok: true, status: BetStatus.WON });
  });

  it("0-0 gravado vale sem texto que o repita: a captura já o conferiu", () => {
    expect(resolveLiveScoreAtTip({ liveScoreHome: 0, liveScoreAway: 0, requireStructured: true }))
      .toEqual({ ok: true, score: { home: 0, away: 0 } });
    // Na captura, 0-0 sem texto continua sendo ruído do parser.
    expect(resolveLiveScoreAtTip({ liveScoreHome: 0, liveScoreAway: 0 }))
      .toEqual({ ok: true, score: null });
  });

  it("falha fechado para par incompleto, FT menor que o placar tip e mercado live sem motor", () => {
    expect(awayAh({
      selecao: "Palmeiras 0.0",
      liveScoreHome: 1,
      homeScore: 1,
      awayScore: 0,
    })).toEqual({ ok: false, reason: "incomplete_live_score" });

    expect(awayAh({
      selecao: "Palmeiras 0.0",
      liveScoreHome: 2,
      liveScoreAway: 0,
      homeScore: 1,
      awayScore: 0,
    })).toEqual({ ok: false, reason: "live_score_after_final" });

    expect(resolveResultFromScore({
      ...base,
      mercado: "Total",
      selecao: "Over 2.5",
      liveScoreHome: 1,
      liveScoreAway: 0,
      homeScore: 2,
      awayScore: 1,
    })).toEqual({ ok: false, reason: "unsupported_live_score" });
  });
});

describe("resolveResultFromScore — período: 1º tempo/HT não liquida pelo placar final", () => {
  // O placar do feed é o FINAL agregado; um mercado de 1º tempo resolvido por ele
  // liquidaria errado (Over 1.5 do HT com placar 3-0 do jogo → WON indevido).
  const r = (mercado: string, selecao: string) =>
    resolveResultFromScore({ ...base, mercado, selecao, homeScore: 3, awayScore: 0 });

  it("1st Half Total/Moneyline/Total Points → wrong_period (cai p/ settlement manual)", () => {
    expect(r("1st Half Total", "Over 1.5")).toEqual({ ok: false, reason: "wrong_period" });
    expect(r("1st Half Moneyline", "Flamengo")).toEqual({ ok: false, reason: "wrong_period" });
    expect(r("1st Half Total Points", "Over 110.5")).toEqual({ ok: false, reason: "wrong_period" });
  });

  it("período declarado só na seleção também recusa o placar FT", () => {
    for (const selecao of [
      "Over 1.5 1st half",
      "Over 1.5 1º tempo",
      "Over 1.5 Q1",
      "Over 1.5 2nd Quarter",
    ]) {
      expect(r("Total – Match", selecao), selecao).toEqual({
        ok: false,
        reason: "wrong_period",
      });
      expect(isScoreResolvableMarket({
        mercado: "Total – Match",
        selecao,
        esporte: "Soccer",
      }), selecao).toBe(false);
    }
  });

  it("quarter/period/inning/regulation/extra time → wrong_period", () => {
    for (const market of [
      "1st Quarter Total",
      "1º Quarto Total",
      "3rd Period Total",
      "5 Innings Total",
      "Regulation Time Total",
      "Extra Time Winner",
    ]) {
      expect(r(market, "Over 1.5"), market).toEqual({ ok: false, reason: "wrong_period" });
      expect(isScoreResolvableMarket({ mercado: market, selecao: "Over 1.5" }), market).toBe(false);
    }
  });

  it("abreviações H1/F5/ET/OT/PEN/SO e Shootout também falham fechado", () => {
    for (const market of [
      "H1 Total",
      "1H Winner",
      "FH Total",
      "1T Totais",
      "2H Total",
      "SH Winner",
      "2T Totais",
      "F5 Total",
      "ET Winner",
      "OT Moneyline",
      "PEN Total",
      "SO Winner",
      "Shootout Winner",
    ]) {
      expect(r(market, market.includes("Winner") ? "Flamengo" : "Over 1.5"), market)
        .toEqual({ ok: false, reason: "wrong_period" });
    }
  });

  it("mercado de 1º tempo não liquida pelo placar de 90 minutos", () => {
    // "1º Tempo" normaliza para "1 tempo" (o ordinal some) e não pode virar FT:
    // Over 1.5 do 1T com jogo 3-0 (HT 0-0) pagaria WON.
    expect(resolveResultFromScore({
      evento: "A vs B", odds: 2, stake: 1,
      mercado: "1º Tempo - Totais", selecao: "Over 1.5", homeScore: 3, awayScore: 0,
    })).toMatchObject({ ok: false, reason: "wrong_period" });
    expect(resolveResultFromScore({
      evento: "A vs B", odds: 2, stake: 1,
      mercado: "1T Totais", selecao: "Over 1.5", homeScore: 3, awayScore: 0,
    })).toMatchObject({ ok: false, reason: "wrong_period" });
    expect(resolveResultFromScore({
      evento: "A vs B", odds: 2, stake: 1,
      mercado: "Total – Match", selecao: "Over 1.5 1T", homeScore: 3, awayScore: 0,
    })).toMatchObject({ ok: false, reason: "wrong_period" });
    expect(resolveResultFromScore({
      evento: "A vs B", odds: 2, stake: 1,
      mercado: "1S Totais", selecao: "Over 1.5", homeScore: 3, awayScore: 0,
    })).toMatchObject({ ok: false, reason: "wrong_period" });
    expect(resolveResultFromScore({
      evento: "A vs B", odds: 2, stake: 1,
      mercado: "Total Match", selecao: "Over 1.5 1S", homeScore: 3, awayScore: 0,
    })).toMatchObject({ ok: false, reason: "wrong_period" });
    expect(resolveResultFromScore({
      evento: "A vs B", odds: 2, stake: 1,
      mercado: "1S Winner", selecao: "A", homeScore: 3, awayScore: 0,
    })).toMatchObject({ ok: false, reason: "wrong_period" });
  });

  it("recusa abreviações parciais e labels Regulation Only", () => {
    for (const mercado of ["1Q Winner", "I1 Total", "Regulation Only Winner", "Total (Regulation)"]) {
      expect(resolveResultFromScore({
        ...base, mercado, selecao: "Flamengo", homeScore: 2, awayScore: 0,
      }), mercado).toEqual({ ok: false, reason: "wrong_period" });
    }
  });

  it("fases parciais e regulamentares nunca usam o placar final", () => {
    for (const mercado of [
      "2P Winner", "3 P Total", "Halftime Winner", "Winner (90 min)",
      "S1 Winner", "1st Set Total Points", "Round 1 Winner", "Frame1 Winner", "Leg 1 Winner",
    ]) {
      expect(resolveResultFromScore({
        ...base, mercado, selecao: "Flamengo", homeScore: 2, awayScore: 0,
      }), mercado).toEqual({ ok: false, reason: mercado.includes("Set") ? "score_unit_mismatch" : "wrong_period" });
    }
  });
});

describe("resolveResultFromScore — recusas com motivo", () => {
  it("recusa placar fracionário, negativo, stake inválida e odd inválida", () => {
    const input = {
      ...base,
      mercado: "Moneyline",
      selecao: "Flamengo",
      homeScore: 2,
      awayScore: 0,
    };
    expect(resolveResultFromScore({ ...input, homeScore: 1.5 })).toEqual({ ok: false, reason: "invalid_score" });
    expect(resolveResultFromScore({ ...input, awayScore: -1 })).toEqual({ ok: false, reason: "invalid_score" });
    expect(resolveResultFromScore({ ...input, stake: 0 })).toEqual({ ok: false, reason: "invalid_stake" });
    expect(resolveResultFromScore({ ...input, odds: 1 })).toEqual({ ok: false, reason: "invalid_odds" });
  });

  it("mercado de estatística (cartões/escanteios) → stat_qualifier", () => {
    const result = resolveResultFromScore({
      ...base,
      mercado: "Total de Escanteios",
      selecao: "Over 9.5",
      homeScore: 2,
      awayScore: 1,
    });
    expect(result).toEqual({ ok: false, reason: "stat_qualifier" });
  });

  it("qualificadores de estatística nunca usam placar do jogo", () => {
    for (const qualifier of [
      "Rebounds",
      "Rebotes",
      "Aces",
      "Bases",
      "Strikes",
      "Takedowns",
      "Submissions",
    ]) {
      const input = { ...base, mercado: `Total ${qualifier}`, selecao: "Over 9.5" };
      expect(resolveResultFromScore({ ...input, homeScore: 100, awayScore: 98 }), qualifier)
        .toEqual({ ok: false, reason: "stat_qualifier" });
      expect(isScoreResolvableMarket(input), qualifier).toBe(false);
    }
  });

  it("props de jogador/time não usam o placar agregado como sua estatística", () => {
    for (const qualifier of [
      "Steals",
      "Turnovers",
      "Blocks",
      "Hits",
      "Strikeouts",
      "Double Faults",
      "3-Pointers",
      "Three Pointers",
      "Triples",
      "Offsides",
      "Passes",
      "Touches",
      "Interceptions",
      "Crosses",
    ]) {
      const input = { ...base, mercado: `Total ${qualifier}`, selecao: "Over 9.5" };
      expect(resolveResultFromScore({ ...input, homeScore: 40, awayScore: 38 }), qualifier)
        .toEqual({ ok: false, reason: "stat_qualifier" });
      expect(isScoreResolvableMarket(input), qualifier).toBe(false);
    }
  });

  it("não confunde clube Aces United com unidade estatística", () => {
    const input = { ...base, mercado: "Moneyline", selecao: "Aces United" };
    expect(isScoreResolvableMarket(input)).toBe(true);
    expect(resolveResultFromScore({ ...input, evento: "Aces United vs Kings", homeScore: 2, awayScore: 0 }))
      .toMatchObject({ ok: true, status: "WON" });
  });

  it("método de vitória e vencedores de round/pontos não usam o vencedor FT", () => {
    for (const [mercado, reason] of [
      ["Submission Winner", "stat_qualifier"],
      ["Decision Winner", "unsupported_market"],
    ] as const) {
      expect(resolveResultFromScore({
        ...base,
        evento: "Fighter A vs Fighter B",
        mercado,
        selecao: "Fighter A",
        homeScore: 1,
        awayScore: 0,
      }), mercado).toEqual({ ok: false, reason });
    }
    for (const mercado of ["Round Winner", "Points Winner"]) {
      expect(resolveResultFromScore({
        ...base,
        evento: "Fighter A vs Fighter B",
        mercado,
        selecao: "Fighter A",
        homeScore: 1,
        awayScore: 0,
      }), mercado).toEqual({ ok: false, reason: "wrong_period" });
    }
  });

  it("totais de rounds e método KO/TKO não usam o placar de vencedor", () => {
    for (const mercado of ["Total Rounds", "Round Total"]) {
      expect(resolveResultFromScore({
        ...base,
        mercado,
        selecao: "Over 2.5",
        homeScore: 1,
        awayScore: 0,
      }), mercado).toEqual({ ok: false, reason: "score_unit_mismatch" });
    }
    expect(resolveResultFromScore({
      ...base,
      evento: "Fighter A vs Fighter B",
      mercado: "KO/TKO Winner",
      selecao: "Fighter A",
      homeScore: 1,
      awayScore: 0,
    })).toEqual({ ok: false, reason: "unsupported_market" });
  });

  it("vitória sem odd válida → invalid_odds (nunca WON com lucro 0 mudo)", () => {
    const result = resolveResultFromScore({
      mercado: "Moneyline",
      selecao: "Flamengo",
      evento: "Flamengo vs Palmeiras",
      homeScore: 2,
      awayScore: 0,
      odds: 0,
      stake: 1,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_odds" });
  });

  it("outright e Handicap Result ficam fail-closed", () => {
    expect(resolveResultFromScore({
      ...base, mercado: "Outright Winner", selecao: "Flamengo", homeScore: 2, awayScore: 0,
    })).toEqual({ ok: false, reason: "unsupported_market" });
    expect(resolveResultFromScore({
      ...base, mercado: "Handicap Result", selecao: "Flamengo -1", homeScore: 1, awayScore: 0,
    })).toEqual({ ok: false, reason: "unsupported_market" });
    expect(resolveResultFromScore({
      ...base, mercado: "Handicap 0:1", selecao: "Flamengo -1", homeScore: 2, awayScore: 1,
    })).toEqual({ ok: false, reason: "unsupported_market" });
    expect(resolveResultFromScore({
      ...base, mercado: "Resultado Exato", selecao: "2-1", homeScore: 2, awayScore: 1,
    })).toEqual({ ok: false, reason: "unsupported_market" });
    expect(resolveResultFromScore({
      ...base, mercado: "Vencedor Final", selecao: "Flamengo", homeScore: 2, awayScore: 1,
    })).toEqual({ ok: false, reason: "unsupported_market" });
    for (const mercado of [
      "Vencedor do Grupo",
      "Vencedor do Troféu",
      "Para Vencer o Torneio",
      "Para Ganhar o Torneio",
    ]) {
      expect(resolveResultFromScore({
        ...base,
        mercado,
        selecao: "Flamengo",
        homeScore: 2,
        awayScore: 1,
      }), mercado).toEqual({ ok: false, reason: "unsupported_market" });
    }
  });
});

describe("resolveResultFromScore — unidade do placar", () => {
  it("Total Points respeita a unidade do esporte", () => {
    expect(resolveResultFromScore({
      evento: "Lakers vs Celtics",
      esporte: "Basketball",
      mercado: "Total Points",
      selecao: "Over 210.5",
      homeScore: 112,
      awayScore: 105,
      odds: 1.9,
      stake: 1,
    })).toMatchObject({ ok: true, status: "WON" });

    for (const esporte of ["Volleyball", "Handball"]) {
      const input = {
        ...base,
        esporte,
        mercado: esporte === "Volleyball" ? "Match Total Points" : "Total Point",
        selecao: "Over 2.5",
      };
      expect(isScoreResolvableMarket(input), esporte).toBe(false);
      expect(resolveResultFromScore({ ...input, homeScore: 2, awayScore: 1 }), esporte)
        .toEqual({ ok: false, reason: "score_unit_mismatch" });
    }

    const volleyballTeamPoints = {
      ...base,
      esporte: "Volleyball",
      mercado: "Pontos do Time",
      selecao: "Flamengo Over 85.5",
    };
    expect(isScoreResolvableMarket(volleyballTeamPoints)).toBe(false);
    expect(resolveResultFromScore({
      ...volleyballTeamPoints,
      evento: "Flamengo vs Minas",
      homeScore: 3,
      awayScore: 1,
    })).toEqual({ ok: false, reason: "score_unit_mismatch" });
  });

  it("qualquer unidade em PONTOS é fail-closed em vôlei/handebol, não só 'Total Points'", () => {
    // O placar do feed é em sets (vôlei) e gols (handebol): 3–2 não são pontos.
    for (const esporte of ["Volleyball", "Handball"]) {
      for (const mercado of [
        "Total de Pontos",
        "Totais de Pontos",
        "Linha de Pontos",
        "Total (Points) – Match",
        "Handicap (Points) – Match",
      ]) {
        expect(
          resolveResultFromScore({
            ...base,
            esporte,
            mercado,
            selecao: "Over 4.5",
            homeScore: 3,
            awayScore: 2,
          }),
          `${esporte} ${mercado}`,
        ).toEqual({ ok: false, reason: "score_unit_mismatch" });
      }
      // O total canônico desses esportes é em sets/gols e continua liquidável.
      expect(
        resolveResultFromScore({
          ...base,
          esporte,
          mercado: "Total",
          selecao: "Over 4.5",
          homeScore: 3,
          awayScore: 2,
        }),
        esporte,
      ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    }
    // Basquete mede pontos no próprio placar — nada muda lá.
    expect(
      resolveResultFromScore({
        ...base,
        esporte: "Basketball",
        mercado: "Linha de Pontos",
        selecao: "Over 210.5",
        homeScore: 110,
        awayScore: 105,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("recusa game isolado e linhas cuja unidade é game", () => {
    expect(resolveResultFromScore({
      ...base, mercado: "Game 1 Winner", selecao: "Flamengo", homeScore: 2, awayScore: 1,
    })).toEqual({ ok: false, reason: "wrong_period" });
    for (const mercado of ["Game Handicap", "Game Total", "Total Game"]) {
      expect(resolveResultFromScore({
        ...base, mercado, selecao: "Flamengo -1.5", homeScore: 2, awayScore: 0,
      }), mercado).toEqual({ ok: false, reason: "score_unit_mismatch" });
    }
    expect(resolveResultFromScore({
      ...base, mercado: "Handicap – Game", selecao: "Flamengo -1.5", homeScore: 2, awayScore: 0,
    })).toMatchObject({ ok: true, status: "WON" });
  });

  it("corridas/runs só liquidam onde o placar É corridas", () => {
    // "Corridas" em futebol/basquete é estatística: liquidar pelo placar de
    // gols/pontos inverte dinheiro. O gate é por ESPORTE, nas duas bordas —
    // o settlement recusa e a coerção não apaga o rótulo.
    for (const esporte of ["Soccer", "Basketball"]) {
      for (const mercado of ["Linha de Corridas", "Linha de Runs", "Corridas - Jogo"]) {
        expect(
          resolveResultFromScore({
            ...base,
            esporte,
            mercado,
            selecao: "Over 4.5",
            homeScore: 3,
            awayScore: 2,
          }),
          `${esporte} ${mercado}`,
        ).toEqual({ ok: false, reason: "score_unit_mismatch" });
        expect(
          coerceMercadoPelaSelecao(mercado, "Over 4.5", esporte),
          `coerce ${esporte} ${mercado}`,
        ).toBe(mercado);
      }
    }
    // Beisebol, softbol e críquete contam corridas no próprio placar.
    for (const esporte of ["Baseball", "Softball", "Cricket"]) {
      expect(
        resolveResultFromScore({
          ...base,
          esporte,
          mercado: "Linha de Corridas",
          selecao: "Over 4.5",
          homeScore: 3,
          awayScore: 2,
        }),
        esporte,
      ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    }
  });

  it("ponto só é placar onde o painel conta pontos", () => {
    for (const [esporte, resolvivel] of [
      ["Basketball", true], ["American Football", true], ["Rugby", true],
      ["Hockey", false], ["Soccer", false], ["Volleyball", false], ["eSports", false],
    ] as const) {
      expect(
        isScoreResolvableMarket({ mercado: "Total de Pontos", selecao: "Over 5.5", esporte }),
        esporte,
      ).toBe(resolvivel);
    }
    // Hockey 4x2: o feed entrega GOLS; liquidar "pontos" por eles é inventar unidade.
    expect(
      resolveResultFromScore({ ...base, mercado: "Total de Pontos", selecao: "Over 5.5", esporte: "Hockey", homeScore: 4, awayScore: 2 }),
    ).toEqual({ ok: false, reason: "score_unit_mismatch" });
  });
});

describe("linha que não cabe num placar em sets", () => {
  // "Over 22.5" de tênis, sem a palavra "games", não pode ser liquidado contra o
  // placar em sets (2–1 → total 3).
  function settle(p: { mercado: string; selecao: string; esporte?: string; home: number; away: number }) {
    return resolveResultFromScore({
      mercado: p.mercado,
      selecao: p.selecao,
      evento: "Jogador A vs Jogador B",
      esporte: p.esporte,
      homeScore: p.home,
      awayScore: p.away,
      odds: 1.9,
      stake: 1,
    });
  }

  describe("linha que não cabe num placar em sets", () => {
    it.each([
      ["Tennis", "Over/Under", "Over 22.5"],
      ["Tennis", "Over/Under", "Under 22.5"],
      ["Volleyball", "Over/Under", "Over 180.5"],
      ["Table Tennis", "Over/Under", "Over 75.5"],
    ])("%s: %s %s contra 2–1 em sets vai para manual", (esporte, mercado, selecao) => {
      expect(settle({ mercado, selecao, esporte, home: 2, away: 1 })).toEqual({ ok: false, reason: "score_unit_mismatch" });
    });

    it("perna sem o esporte certo (múltipla) também para, pela linha alta contra placar de sets", () => {
      expect(settle({ mercado: "Over/Under", selecao: "Over 22.5", esporte: "Soccer", home: 2, away: 1 }))
        .toEqual({ ok: false, reason: "score_unit_mismatch" });
      expect(settle({ mercado: "Over/Under", selecao: "Over 22.5", home: 2, away: 1 }))
        .toEqual({ ok: false, reason: "score_unit_mismatch" });
    });

    it("handicap de games em esporte de sets vai para manual", () => {
      expect(lineOutsideSetScore({ lineQ: -4 * 4.5, kind: "handicap", esporte: "Tennis" })).toBe(true);
      expect(lineOutsideSetScore({ lineQ: -4 * 1.5, kind: "handicap", esporte: "Tennis" })).toBe(false);
      expect(lineOutsideSetScore({ lineQ: -4 * 3.5, kind: "handicap", esporte: "Table Tennis" })).toBe(false);
    });

    it("eSports: o placar é em mapas, e linha de rounds/kills vai para manual", () => {
      const esports = (mercado: string, selecao: string, home: number, away: number) => resolveResultFromScore({
        mercado, selecao, evento: "FURIA vs NAVI", esporte: "eSports", homeScore: home, awayScore: away, odds: 1.9, stake: 1,
      });
      for (const [mercado, selecao] of [
        ["Handicap – Match", "FURIA -4.5"], ["Handicap – Match", "NAVI +5.5"], ["Total – Match", "Over 5.5"],
        ["Handicap – Match", "FURIA -2.5 rounds"], ["Round Handicap", "FURIA -1.5"], ["Handicap de Rounds", "FURIA -1.5"],
      ] as const) {
        expect(esports(mercado, selecao, 2, 1), `${mercado} ${selecao}`).toEqual({ ok: false, reason: "score_unit_mismatch" });
      }
      // A diferença e o total de mapas continuam liquidando.
      expect(esports("Handicap – Match", "FURIA -1.5", 2, 0)).toMatchObject({ ok: true, status: "WON" });
      expect(esports("Handicap – Match", "FURIA -1.5", 2, 1)).toMatchObject({ ok: true, status: "LOST" });
      expect(esports("Total – Match", "Over 2.5", 2, 1)).toMatchObject({ ok: true, status: "WON" });
      // O placar mostra o formato: 2-0 é melhor de 3, 1-0 melhor de 1 e 1-1
      // melhor de 2, e ali a linha acima do que cabe não é de mapas.
      for (const [mercado, selecao, home, away] of [
        ["Handicap – Match", "FURIA -2.5", 2, 0], ["Handicap – Match", "NAVI +2.5", 2, 1], ["Total – Match", "Over 3.5", 2, 1],
        ["Handicap – Match", "FURIA -1.5", 1, 0], ["Total – Match", "Over 1.5", 1, 0], ["Total – Match", "Over 2.5", 1, 1],
      ] as const) {
        expect(esports(mercado, selecao, home, away), `${selecao} ${home}-${away}`).toEqual({ ok: false, reason: "score_unit_mismatch" });
      }
      expect(esports("Handicap – Match", "FURIA -2.5", 3, 0)).toMatchObject({ ok: true, status: "WON" });
      expect(esports("Handicap – Match", "FURIA -1.5", 1, 1)).toMatchObject({ ok: true, status: "LOST" });
      expect(esports("Total – Match", "Over 1.5", 1, 1)).toMatchObject({ ok: true, status: "WON" });
    });

    it("tênis em melhor de 3: -2.5 é de games, e o placar em sets não responde", () => {
      expect(lineOutsideSetScore({ lineQ: -4 * 2.5, kind: "handicap", esporte: "Tennis", homeScore: 2, awayScore: 0 })).toBe(true);
      expect(lineOutsideSetScore({ lineQ: -4 * 1.5, kind: "handicap", esporte: "Tennis", homeScore: 2, awayScore: 1 })).toBe(false);
      expect(lineOutsideSetScore({ lineQ: -4 * 2.5, kind: "handicap", esporte: "Tennis", homeScore: 3, awayScore: 1 })).toBe(false);
      expect(lineOutsideSetScore({ lineQ: 4 * 3.5, kind: "total", esporte: "Tennis", homeScore: 2, awayScore: 1 })).toBe(true);
      expect(lineOutsideSetScore({ lineQ: 4 * 2.5, kind: "total", esporte: "Tennis", homeScore: 2, awayScore: 1 })).toBe(false);
    });

    it("linhas legítimas continuam liquidando", () => {
      // Total de sets.
      expect(lineOutsideSetScore({ lineQ: 4 * 3.5, kind: "total", esporte: "Volleyball", homeScore: 3, awayScore: 1 })).toBe(false);
      // Beisebol: linha alta de corridas com placar baixo é um Under legítimo.
      expect(lineOutsideSetScore({ lineQ: 4 * 11.5, kind: "total", esporte: "Baseball", homeScore: 4, awayScore: 3 })).toBe(false);
      // Basquete: placar grande.
      expect(lineOutsideSetScore({ lineQ: 4 * 210.5, kind: "total", esporte: "Basketball", homeScore: 110, awayScore: 104 })).toBe(false);
      // Futebol: gols.
      expect(lineOutsideSetScore({ lineQ: 4 * 2.5, kind: "total", esporte: "Soccer", homeScore: 2, awayScore: 1 })).toBe(false);
    });
  });
});
