import { describe, expect, it } from "vitest";
import { BetStatus } from "@/src/generated/prisma/client";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { resolveResultFromStatistics } from "@/src/domain/settlement/statistics";

const base = {
  evento: "Athletic Club vs Operario Ferroviario",
  odds: 1.9,
  stake: 1,
};

describe("liquidação por estatísticas", () => {
  it("período só na seleção não liquida estatística de 90 minutos", () => {
    const stats = {
      corners: { home: 6, away: 4 },
      yellowCards: null,
      redCards: null,
    };
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Corners) – Match",
      selecao: "Over 4.5 1T",
      stats,
    })).toEqual({ ok: false, reason: "wrong_period" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Corners) – 1st Half",
      selecao: "Over 4.5",
      statsPeriod: "HT",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "corners" });
  });

  it("resolve total e handicap asiático de escanteios", () => {
    const stats = {
      corners: { home: 6, away: 4 },
      yellowCards: null,
      redCards: null,
    };
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Corners) – Match",
      selecao: "Under 10.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Corners) – Match",
      selecao: "Acima de 9.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Corners) – Match",
      selecao: "+9.5 corners",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Handicap (Corners) – Match",
      selecao: "Operario Ferroviario +2.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Asian Handicap Corners – Match",
      selecao: "Athletic Club -1.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Asian Corners",
      selecao: "Over 10.0",
      stats: {
        corners: { home: 7, away: 4 },
        yellowCards: null,
        redCards: null,
      },
    })).toMatchObject({ ok: true, status: "WON", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Asian Corners",
      selecao: "Over 10.0",
      stats: {
        corners: { home: 6, away: 4 },
        yellowCards: null,
        redCards: null,
      },
    })).toMatchObject({ ok: true, status: "VOID", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Asian Corners Over 10.0",
      selecao: "Over 10.0",
      stats: {
        corners: { home: 7, away: 4 },
        yellowCards: null,
        redCards: null,
      },
    })).toMatchObject({ ok: true, status: "WON", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Cantos Asiáticos",
      selecao: "Over 10.0",
      stats: {
        corners: { home: 7, away: 4 },
        yellowCards: null,
        redCards: null,
      },
    })).toMatchObject({ ok: true, status: "WON", statistic: "corners" });
  });

  it("aceita linha no sufixo do mercado sem promover números de unidade a linha", () => {
    const corners = { corners: { home: 6, away: 5 } };
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total de Escanteios 9.5",
      selecao: "Over",
      stats: corners,
    })).toMatchObject({ ok: true, status: "WON", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      evento: "Mainz 05 vs Schalke 04",
      mercado: "Mainz 05 Corners 5.5",
      selecao: "Over",
      stats: corners,
    })).toMatchObject({ ok: true, status: "WON", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Handicap (Corners) -1.5",
      selecao: "Athletic Club",
      stats: corners,
    })).toMatchObject({ ok: true, status: "LOST", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Yellow Cards 4.5",
      selecao: "Under",
      stats: { yellowCards: { home: 2, away: 1 } },
    })).toMatchObject({ ok: true, status: "WON", statistic: "yellow_cards" });

    const threePointers = { threePointers: { home: 8, away: 7 } };
    expect(resolveResultFromStatistics({
      evento: "Lakers vs Celtics",
      mercado: "Total de Cestas de 3",
      selecao: "Over",
      odds: 1.9,
      stake: 1,
      stats: threePointers,
    })).toEqual({ ok: false, reason: "missing_line" });
    expect(resolveResultFromStatistics({
      evento: "Lakers vs Celtics",
      mercado: "Total de Cestas de 3 10.5",
      selecao: "Over",
      odds: 1.9,
      stake: 1,
      stats: threePointers,
    })).toMatchObject({ ok: true, status: "WON", statistic: "three_pointers" });

    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total de Escanteios 9.3",
      selecao: "Over",
      stats: corners,
    })).toEqual({ ok: false, reason: "invalid_line" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total de Escanteios 9.5",
      selecao: "Athletic Club",
      stats: corners,
    })).toEqual({ ok: false, reason: "ambiguous_selection" });
  });

  it("team total usa somente a estatística do lado selecionado", () => {
    const stats = {
      corners: { home: 2, away: 8 },
      yellowCards: { home: 1, away: 5 },
      redCards: null,
    };
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Team Total Corners – Match",
      selecao: "Athletic Club Over 3.5",
      stats,
    })).toMatchObject({ ok: true, status: "LOST", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Team Total Cards – Match",
      selecao: "Operario Ferroviario Under 5.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "booking_points" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Team Total Corners – Match",
      selecao: "Over 3.5",
      stats,
    })).toEqual({ ok: false, reason: "ambiguous_selection" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total Corners",
      selecao: "Athletic Club Over 4.5",
      stats,
    })).toMatchObject({ ok: true, status: "LOST", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Home Corner Total",
      selecao: "Over 4.5",
      stats,
    })).toMatchObject({ ok: true, status: "LOST", statistic: "corners" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total Cards",
      selecao: "Athletic Club Over 1.5",
      stats,
    })).toMatchObject({ ok: true, status: "LOST", statistic: "booking_points" });
  });

  it("conta amarelo como 1 e vermelho como 2 pontos", () => {
    const result = resolveResultFromStatistics({
      ...base,
      mercado: "Total (Bookings) – Match",
      selecao: "Under 5.5",
      stats: {
        corners: null,
        yellowCards: { home: 2, away: 3 },
        redCards: { home: 0, away: 1 },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      status: "LOST",
      statistic: "booking_points",
      values: { home: 2, away: 5 },
    });
  });

  it("seleção específica vence a família genérica sem inverter dinheiro", () => {
    const stats = {
      yellowCards: { home: 1, away: 0 },
      redCards: { home: 1, away: 0 },
      shotsTotal: { home: 9, away: 4 },
      shotsOnTarget: { home: 2, away: 1 },
      fouls: { home: 8, away: 7 },
      doubleFaults: { home: 1, away: 0 },
    };
    for (const [mercado, selecao, statistic] of [
      ["Total de Cartões", "Cartões Amarelos Over 1.5", "yellow_cards"],
      ["Total de Chutes", "Chutes no Gol Over 3.5", "shots_on_target"],
      ["Faltas", "Duplas Faltas Over 2.5", "double_faults"],
    ] as const) {
      expect(resolveResultFromStatistics({
        ...base,
        mercado,
        selecao,
        stats,
      }), `${mercado} / ${selecao}`).toMatchObject({
        ok: true,
        status: "LOST",
        statistic,
      });
    }
  });

  it("resolve ambas as equipes com 2+ cartões pelo mínimo de cada lado", () => {
    const common = {
      ...base,
      mercado: "Both Teams Cards – Match",
      selecao: "Ambas recebem +2 cards",
    };
    expect(resolveResultFromStatistics({
      ...common,
      stats: {
        corners: null,
        yellowCards: { home: 2, away: 3 },
        redCards: null,
      },
    })).toMatchObject({ ok: true, status: "WON", statistic: "booking_points" });
    expect(resolveResultFromStatistics({
      ...common,
      stats: {
        corners: null,
        yellowCards: { home: 1, away: 6 },
        redCards: { home: 0, away: 1 },
      },
    })).toMatchObject({ ok: true, status: "LOST", statistic: "booking_points" });

    // Forma compacta de captura real, lida como "cada time". Sem isso, 1+6
    // cairia no total agregado ou ficaria preso em manual, embora um dos lados
    // não tenha alcançado o mínimo.
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Moneyline",
      selecao: "Ambas 2+ cartões",
      stats: {
        yellowCards: { home: 1, away: 6 },
        redCards: null,
      },
    })).toMatchObject({ ok: true, status: "LOST", statistic: "booking_points" });
  });

  it("trata linha de vermelho ausente como zero, mas nunca inventa amarelos", () => {
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Bookings) – Match",
      selecao: "Under 5.5",
      stats: {
        corners: null,
        yellowCards: { home: 2, away: 3 },
        redCards: null,
      },
    })).toMatchObject({ ok: true, status: "WON" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Bookings) – Match",
      selecao: "Under 5.5",
      stats: { corners: null, yellowCards: null, redCards: { home: 0, away: 1 } },
    })).toEqual({ ok: false, reason: "missing_stat" });
  });

  it("recusa estatística FT em mercado de primeiro tempo", () => {
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Corners) – 1st Half",
      selecao: "Over 4.5",
      stats: { corners: { home: 6, away: 4 }, yellowCards: null, redCards: null },
    })).toEqual({ ok: false, reason: "wrong_period" });
  });

  it("resolve estatísticas quando o bloco e o período do mercado coincidem", () => {
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Corners) – 1st Half",
      selecao: "Over 4.5",
      statsPeriod: "HT",
      stats: { corners: { home: 3, away: 2 }, yellowCards: null, redCards: null },
    })).toMatchObject({ ok: true, status: "WON" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Corners) – 2nd Half",
      selecao: "Under 5.5",
      statsPeriod: "SECOND_HALF",
      stats: { corners: { home: 2, away: 2 }, yellowCards: null, redCards: null },
    })).toMatchObject({ ok: true, status: "WON" });
  });

  it("nome de jogador no over/under de rebotes não herda o par do time", () => {
    const evento = "Boston Celtics vs Miami Heat";
    const stats = { rebounds: { home: 40, away: 38 } };
    expect(resolveResultFromStatistics({
      evento,
      mercado: "Moneyline",
      selecao: "Tatum over 10.5 rebounds",
      odds: 1.9,
      stake: 100,
      stats,
    }).ok).toBe(false);
    expect(resolveResultFromStatistics({
      evento,
      mercado: "Team Total Rebounds",
      selecao: "Boston Celtics Over 10.5",
      odds: 1.9,
      stake: 100,
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "rebounds" });
  });

  it.each([
    ["Chutes no Gol", "Over 0.5 - Mbappé"],
    ["Shots On Target", "Over 0.5 Mbappé"],
    ["Total (Bookings) – Match", "Over 0.5 (Casemiro)"],
  ])("jogador depois da linha também não herda o total da partida: %s / %s", (mercado, selecao) => {
    const stats = { shotsOnTarget: { home: 5, away: 3 }, yellowCards: { home: 2, away: 1 }, redCards: { home: 0, away: 0 } };
    expect(resolveResultFromStatistics({ evento: "Real Madrid vs Barcelona", mercado, selecao, odds: 3, stake: 1, stats }).ok).toBe(false);
  });

  it.each([
    "Over 9.5 escanteios - FT", "Over 9.5 escanteios no jogo", "Over 9.5 (Asian Corners)",
    "Over 9.5 escanteios ambos os times", "Over 9.5 escanteios tempo normal", "Over 9.5 escanteios jogo todo",
  ])(
    "unidade e escopo depois da linha seguem liquidando: %s", (selecao) => {
      const stats = { corners: { home: 6, away: 4 } };
      expect(resolveResultFromStatistics({ ...base, mercado: "Total (Corners) – Match", selecao, stats }))
        .toMatchObject({ ok: true, status: "WON", statistic: "corners" });
    },
  );

  // O vocabulário de estatística é o de `stat-qualifier`: a unidade escrita
  // depois da linha, de qualquer família, não é o sujeito da aposta.
  it.each([
    ["Impedimentos", "Over 4.5 impedimentos", "offsides"],
    ["Impedimentos", "Over 4.5 offsides", "offsides"],
    ["Interceptações", "Over 15.5 interceptações", "interceptions"],
    ["Cortes", "Over 40.5 cortes", "clearances"],
    ["Roubos de bola", "Over 12.5 roubos de bola", "steals"],
    ["Turnovers", "Over 20.5 turnovers", "turnovers"],
    ["Tocos", "Over 8.5 tocos", "blocks"],
    ["Duplas faltas", "Over 5.5 duplas faltas", "double_faults"],
    ["Double Faults", "Over 5.5 double faults", "double_faults"],
    ["Three Pointers", "Over 25.5 three pointers", "three_pointers"],
    ["Chutes no gol", "Over 8.5 chutes certos", "shots_on_target"],
    ["Chutes no gol", "Over 8.5 finalizações enquadradas", "shots_on_target"],
    ["Total (Bookings) – Match", "Over 3.5 cartões - ambos os times", "booking_points"],
    ["Total (Bookings) – Match", "Over 3.5 cartões (ambas equipes)", "booking_points"],
  ])("a estatística depois da linha segue liquidando: %s / %s", (mercado, selecao, statistic) => {
    const pair = { home: 8, away: 9 };
    const stats = {
      offsides: pair, interceptions: pair, clearances: { home: 20, away: 25 }, steals: pair, turnovers: { home: 12, away: 11 },
      blocks: pair, doubleFaults: { home: 3, away: 4 }, threePointers: { home: 14, away: 15 }, shotsOnTarget: pair,
      yellowCards: { home: 2, away: 2 }, redCards: { home: 0, away: 0 },
    };
    expect(resolveResultFromStatistics({ ...base, mercado, selecao, stats }))
      .toMatchObject({ ok: true, status: "WON", statistic });
  });
});

describe("faltas, impedimentos, defesas e chutes do feed de futebol", () => {
  const stats = {
    shotsTotal: { home: 18, away: 8 },
    shotsOnTarget: { home: 9, away: 3 },
    fouls: { home: 11, away: 12 },
    offsides: { home: 4, away: 0 },
    saves: { home: 1, away: 2 },
  };

  it("resolve total de faltas, impedimentos e defesas", () => {
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total de Faltas",
      selecao: "Over 22.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "fouls" });
    // 4 impedimentos somados contra linha 3.5: Under perde.
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total de Impedimentos",
      selecao: "Under 3.5",
      stats,
    })).toMatchObject({ ok: true, status: "LOST", statistic: "offsides" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total de Defesas",
      selecao: "Over 2.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "saves" });
  });

  it("chute NO GOL e chute TOTAL são linhas diferentes do feed", () => {
    // 27 finalizações contra 12 no gol: trocar uma pela outra inverte a aposta.
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total de Finalizações",
      selecao: "Over 25.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "shots_total" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Finalizações no Gol",
      selecao: "Over 25.5",
      stats,
    })).toMatchObject({ ok: true, status: "LOST", statistic: "shots_on_target" });
  });

  it("liquida os rótulos canônicos de remates do jogo e por equipe", () => {
    expect(resolveResultFromStatistics({
      ...base,
      evento: "Santos vs Macara",
      mercado: "Total (Shots) – Match",
      selecao: "Over 25.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "shots_total" });
    expect(resolveResultFromStatistics({
      ...base,
      evento: "Santos vs Macara",
      mercado: "Team Total (Shots) – Match",
      selecao: "Santos Under 21.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "shots_total" });
    expect(resolveResultFromStatistics({
      ...base,
      evento: "Santos vs Macara",
      mercado: "Team Total (Shots) – Match",
      selecao: "Santos Under 18.0",
      stats,
    })).toMatchObject({ ok: true, status: "VOID", statistic: "shots_total" });
    expect(resolveResultFromStatistics({
      ...base,
      evento: "Santos vs Macara",
      mercado: "Team Total (Shots) – Match",
      selecao: "Santos Under 17.5",
      stats,
    })).toMatchObject({ ok: true, status: "LOST", statistic: "shots_total" });
  });

  it("remates à baliza usam shotsOnTarget e nunca shotsTotal", () => {
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total de Remates à Baliza",
      selecao: "Under 12.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "shots_on_target" });
  });

  it("team shots sem lado fica fail-closed", () => {
    expect(resolveResultFromStatistics({
      ...base,
      evento: "Santos vs Macara",
      mercado: "Team Total (Shots) – Match",
      selecao: "Under 21.5",
      stats,
    })).toEqual({ ok: false, reason: "ambiguous_selection" });
    expect(resolveResultFromStatistics({
      ...base,
      evento: "Santos vs Macara",
      mercado: "Team Total (Shots) – Match",
      selecao: "Santos Macara Under 21.5",
      stats,
    })).toEqual({ ok: false, reason: "ambiguous_selection" });
  });

  it("remates falham fechado sem estatística, em parcial FT incompatível ou linha válida", () => {
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Shots) – Match",
      selecao: "Over 25.5",
      stats: { ...stats, shotsTotal: null },
    })).toEqual({ ok: false, reason: "missing_stat" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Shots) – 1st Half",
      selecao: "Over 12.5",
      stats,
    })).toEqual({ ok: false, reason: "wrong_period" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total (Shots) – Match",
      selecao: "Over 25.3",
      stats,
    })).toEqual({ ok: false, reason: "invalid_line" });
  });

  it("chute sem qualificador falha fechado, em vez de escolher uma das duas", () => {
    for (const mercado of ["Chutes", "Shots"]) {
      expect(resolveResultFromStatistics({
        ...base,
        mercado,
        selecao: "Over 25.5",
        stats,
      })).toEqual({ ok: false, reason: "unsupported_market" });
    }
  });

  it("handicap e team total funcionam nas famílias novas", () => {
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Handicap Asiático de Faltas",
      selecao: "Athletic Club -2.5",
      stats,
    })).toMatchObject({ ok: true, status: "LOST", statistic: "fouls" });
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total da Equipe - Impedimentos",
      selecao: "Athletic Club Over 3.5",
      stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "offsides" });
  });

  it("linha ausente é missing_stat, nunca zero", () => {
    expect(resolveResultFromStatistics({
      ...base,
      mercado: "Total de Faltas",
      selecao: "Under 22.5",
      stats: { corners: { home: 5, away: 5 } },
    })).toEqual({ ok: false, reason: "missing_stat" });
  });
});

/**
 * Famílias que o vocabulário (`NON_SCORE_STAT_TERMS`) reconhece como mercado e
 * que o resolvedor liquida porque o feed publica todas em INTEIRO PURO; a
 * fixture do adapter preserva essa evidência.
 */
describe("famílias que o feed publica em inteiro puro", () => {
  const nba = { evento: "Lakers vs Celtics", odds: 1.9, stake: 1 };

  it("resolve rebotes, assistências, tocos, roubos e turnovers do basquete", () => {
    const stats = {
      rebounds: { home: 50, away: 56 },
      assists: { home: 16, away: 19 },
      blocks: { home: 7, away: 3 },
      steals: { home: 6, away: 6 },
      turnovers: { home: 13, away: 15 },
    };
    expect(resolveResultFromStatistics({
      ...nba, mercado: "Total de Rebotes", selecao: "Over 100.5", stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "rebounds" });
    expect(resolveResultFromStatistics({
      ...nba, mercado: "Total de Assistências", selecao: "Under 40.5", stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "assists" });
    expect(resolveResultFromStatistics({
      ...nba, mercado: "Total da Equipe - Tocos", selecao: "Lakers Over 5.5", stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "blocks" });
    expect(resolveResultFromStatistics({
      ...nba, mercado: "Total de Roubos", selecao: "Over 11.5", stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "steals" });
    expect(resolveResultFromStatistics({
      ...nba, mercado: "Total de Turnovers", selecao: "Under 30.5", stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "turnovers" });
  });

  it("resolve aces e duplas faltas do tênis sem confundir as duas linhas", () => {
    const tenis = { evento: "Alcaraz vs Sinner", odds: 1.9, stake: 1 };
    const stats = { aces: { home: 4, away: 1 }, doubleFaults: { home: 2, away: 2 } };
    expect(resolveResultFromStatistics({
      ...tenis, mercado: "Total de Aces", selecao: "Over 4.5", stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "aces" });
    // "dupla falta" é o termo mais específico e não pode cair em `aces`.
    expect(resolveResultFromStatistics({
      ...tenis, mercado: "Total de Duplas Faltas", selecao: "Under 5.5", stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "double_faults" });
  });

  it("resolve interceptações e cortes do futebol", () => {
    const stats = {
      interceptions: { home: 9, away: 12 },
      clearances: { home: 13, away: 16 },
    };
    expect(resolveResultFromStatistics({
      ...base, mercado: "Total de Interceptações", selecao: "Over 20.5", stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "interceptions" });
    expect(resolveResultFromStatistics({
      ...base, mercado: "Total de Cortes", selecao: "Under 30.5", stats,
    })).toMatchObject({ ok: true, status: "WON", statistic: "clearances" });
  });

  /**
   * A armadilha: `Tackles`, `Crosses` e `Passes` existem
   * no feed E no vocabulário, mas em PERCENTUAL ("12% (2/17)"). O normalizador
   * recusa e a família nem chega a existir — o mercado sai como não suportado,
   * que é o desfecho honesto. Mapeá-los criaria mercado que nunca liquida.
   */
  it("desarmes e cruzamentos seguem sem família — o feed só publica percentual", () => {
    for (const mercado of ["Total de Desarmes", "Total de Cruzamentos"]) {
      expect(resolveResultFromStatistics({
        ...base, mercado, selecao: "Over 10.5", stats: { corners: { home: 5, away: 5 } },
      })).toEqual({ ok: false, reason: "unsupported_market" });
    }
  });
});

describe("resolveResultFromStatistics — time depois da linha é total por equipe", () => {
  const base = {
    evento: "Flamengo vs Palmeiras",
    odds: 2.0,
    stake: 1,
  };

  it("time DEPOIS da linha é total por EQUIPE, não do jogo (placar e estatística)", () => {
    // A canonicalização preserva o lado no registro; o settlement também tem de
    // tratar a aposta como total por equipe: com 0x3, "Over 1.5 Flamengo" não
    // pode devolver WON para quem apostou no time que não marcou.
    for (const selecao of ["Flamengo Over 1.5", "Over 1.5 Flamengo", "Over 1.5 Gols do Flamengo"]) {
      expect(
        resolveResultFromScore({ ...base, mercado: "Total de Gols", selecao, homeScore: 0, awayScore: 3 }),
        selecao,
      ).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    }
    // Mesmo risco no resolver de estatística: Flamengo fez 2 escanteios de 7.
    const stats = { corners: { home: 2, away: 5 }, yellowCards: null, redCards: null };
    for (const selecao of ["Flamengo Over 4.5", "Over 4.5 Flamengo", "Flamengo O 4.5"]) {
      const r = resolveResultFromStatistics({
        mercado: "Total Escanteios", selecao, evento: base.evento, odds: 2, stake: 1, stats,
      });
      expect(r.ok && r.status, selecao).toBe(BetStatus.LOST);
    }
    // O rótulo que a captura grava (total do jogo) com a direção abreviada.
    expect(resolveResultFromStatistics({
      mercado: "Total (Corners) – Match", selecao: "Flamengo O 4.5", evento: base.evento, odds: 2, stake: 1, stats,
    })).toMatchObject({ ok: true, status: BetStatus.LOST });
    // Total do JOGO sem time continua agregado, e ruído de unidade/período não
    // vira lado (o candidato ainda precisa casar contra o evento).
    expect(
      resolveResultFromStatistics({
        mercado: "Total Escanteios", selecao: "Over 4.5", evento: base.evento, odds: 2, stake: 1, stats,
      }),
    ).toMatchObject({ ok: true, status: BetStatus.WON });
    expect(
      resolveResultFromScore({ ...base, mercado: "Total de Gols", selecao: "Over 1.5 gols no jogo", homeScore: 0, awayScore: 3 }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("o time com a unidade na seleção ('Flamengo mais de 4.5 escanteios') conta só os do time", () => {
    const stats = { corners: { home: 3, away: 5 }, yellowCards: { home: 2, away: 1 }, redCards: { home: 0, away: 0 } };
    const resolve = (mercado: string, selecao: string) =>
      resolveResultFromStatistics({ mercado, selecao, evento: base.evento, odds: 2, stake: 1, stats });
    // O Flamengo fez 3 escanteios e o Palmeiras 5: o jogo somou 8.
    for (const selecao of [
      "Flamengo mais de 4.5 escanteios", "Flamengo Over 4.5 escanteios", "Flamengo Over 4.5 corners",
      "Flamengo Escanteios Over 4.5",
    ]) {
      expect(resolve("Total (Corners) – Match", selecao), selecao).toMatchObject({ ok: true, status: BetStatus.LOST });
    }
    expect(resolve("Total (Corners) – Match", "Palmeiras Under 5.5 corners")).toMatchObject({ ok: true, status: BetStatus.WON });
    // Cartões 2 x 1: o Palmeiras levou 1.
    expect(resolve("Total (Bookings) – Match", "Palmeiras Over 1.5 cartões")).toMatchObject({ ok: true, status: BetStatus.LOST });
    // Sem time, ou com os dois, continua o total do jogo. A unidade antes da
    // direção abreviada ("Escanteios O 7.5") é a estatística, não um time.
    for (const selecao of ["Over 7.5 escanteios", "Flamengo x Palmeiras Over 7.5 escanteios", "Escanteios Over 7.5", "Escanteios O 7.5"]) {
      expect(resolve("Total (Corners) – Match", selecao), selecao).toMatchObject({ ok: true, status: BetStatus.WON });
    }
  });
});


describe("contrato de linhas e condições de estatística", () => {
  it.each([
    ["Over 0,5 1ºT", "HT", 1, "WON"],
    ["Under 0,5 2ºT", "SECOND_HALF", 0, "WON"],
  ] as const)("o numeral do tempo não altera %s", (selecao, statsPeriod, home, status) => {
    expect(resolveResultFromStatistics({ ...base, mercado: "Total Corners", selecao, statsPeriod,
      stats: { corners: { home, away: 0 } } })).toMatchObject({ ok: true, status, lucro: 0.9 });
  });

  it.each([
    ["Total Corners & Both Teams to Score", "Over 9.5"],
    ["Total Corners and Cards", "Over 9.5"],
    ["Total Corners", "Over 9.5 e Athletic Club vence"],
  ])("não decide uma só condição de %s / %s", (mercado, selecao) => {
    expect(resolveResultFromStatistics({ ...base, mercado, selecao,
      stats: { corners: { home: 6, away: 4 }, yellowCards: { home: 1, away: 0 } } }))
      .toEqual({ ok: false, reason: "unsupported_market" });
  });

  it("conectivo no nome do time e rótulo Over/Under não criam segunda condição", () => {
    expect(resolveResultFromStatistics({ ...base, evento: "Brighton & Hove Albion vs West Ham",
      mercado: "Over/Under Corners", selecao: "Brighton & Hove Albion Over 4.5",
      stats: { corners: { home: 5, away: 0 } } })).toMatchObject({ ok: true, status: "WON" });
  });

  it.each([
    ["Both Teams Under 1.5 cards", 2, 3, "LOST"],
    ["Both Teams Under 2 cards", 1, 1, "WON"],
    ["Both Teams Over 2.5 cards", 3, 4, "WON"],
  ] as const)("respeita a direção e a linha de cada equipe: %s", (selecao, home, away, status) => {
    expect(resolveResultFromStatistics({ ...base, mercado: "Both Teams Cards", selecao,
      stats: { yellowCards: { home, away } } })).toMatchObject({ ok: true, status });
  });

  it("devolução em uma condição de ambas as equipes exige conferência", () => {
    expect(resolveResultFromStatistics({ ...base, mercado: "Both Teams Cards", selecao: "Both Teams Under 2 cards",
      stats: { yellowCards: { home: 2, away: 1 } } })).toEqual({ ok: false, reason: "unsupported_market" });
  });
});


it("ambas as equipes com cartões de uma cor não usa a soma do jogo", () => {
  expect(resolveResultFromStatistics({ ...base, mercado: "Both Teams Cards", selecao: "Cartões Amarelos Over 0.5",
    stats: { yellowCards: { home: 0, away: 5 }, redCards: { home: 1, away: 0 } } }))
    .toMatchObject({ ok: true, status: "LOST", statistic: "yellow_cards" });
});


it.each(["Mais ou Menos Corners", "Under/Over Corners"])("rótulo de duas direções permanece válido: %s", (mercado) => {
  expect(resolveResultFromStatistics({ ...base, mercado, selecao: "Over 9.5", stats: { corners: { home: 6, away: 4 } } }))
    .toMatchObject({ ok: true, status: "WON" });
});
it("mínimo por extenso continua sendo o mínimo de ambas as equipes", () => {
  expect(resolveResultFromStatistics({ ...base, mercado: "Both Teams Cards", selecao: "Ambas recebem 2 ou mais cartões",
    stats: { yellowCards: { home: 2, away: 3 } } })).toMatchObject({ ok: true, status: "WON" });
});
