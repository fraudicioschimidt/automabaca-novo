import { describe, expect, it } from "vitest";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { FINAL_MARKET_SPORTS, isMercadoFinalForSport } from "@/src/domain/mercados/compatibility";
import { marketMapNumberOf, isDoubleChanceMarket, isDrawNoBetMarket, isMethodOfVictoryMarket, isThreeWayHandicapMarket, marketKindOf, marketPeriodOf } from "@/src/domain/mercados/classify";
import { MERCADOS_FINAIS } from "@/src/domain/mercados/catalog";
import { finalizePinnacleMarket, pinnacleizeMercado } from "@/src/domain/mercados/finalize";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { marketFamily, providerCoversBet } from "@/src/providers/coverage";
import { resolveBridgeOddsForBet } from "@/src/providers/bridgeodds/odds";

/**
 * Taxonomia Pinnacle sport-aware: "vitória" e "total" têm nomes diferentes
 * por esporte, e o label final é a chave de segmento da probation (Total
 * futebol ≠ Total Points basquete ≠ Total (Games) tênis — ênfase do dono).
 */

describe("finalizePinnacleMarket — labels por esporte", () => {
  it("a matriz cobre todo final e recusa rótulos finais de outro esporte", () => {
    expect(Object.keys(FINAL_MARKET_SPORTS).sort()).toEqual([...MERCADOS_FINAIS].sort());

    const invalidPairs = [
      ["Total Points", "Soccer"],
      ["Point Spread", "Soccer"],
      ["Puck Line", "Basketball"],
      ["Handicap (Games) – Match", "Soccer"],
    ] as const;
    for (const [market, sport] of invalidPairs) {
      expect(isMercadoFinalForSport(market, sport), `${market} × ${sport}`).toBe(false);
      expect(pinnacleizeMercado(market, sport), `${market} × ${sport}`).toBe(market);
      expect(
        providerCoversBet("pinnacle17", {
          esporte: sport,
          mercado: market,
          selecao: "Home -1.5",
        }),
        `${market} × ${sport}`,
      ).toBe(false);
    }
  });

  it("Moneyline usa o rótulo Pinnacle final de cada esporte", () => {
    expect(finalizePinnacleMarket("Moneyline", "Tennis")).toBe("Match Winner");
    expect(finalizePinnacleMarket("Moneyline", "eSports")).toBe("Money Line – Match");
    expect(finalizePinnacleMarket("Moneyline", "Soccer")).toBe("Money Line – Match");
    expect(finalizePinnacleMarket("Moneyline", "Basketball")).toBe("Money Line – Game");
    expect(finalizePinnacleMarket("Moneyline", "Baseball")).toBe("Money Line – Game");
    expect(finalizePinnacleMarket("Moneyline", "Hockey")).toBe("Money Line");
  });

  it("Asian Handicap: label Pinnacle por esporte (Soccer = Handicap – Match)", () => {
    expect(finalizePinnacleMarket("Asian Handicap", "Baseball")).toBe("Handicap – Game");
    expect(finalizePinnacleMarket("Run Line", "Baseball")).toBe("Handicap – Game");
    expect(finalizePinnacleMarket("Asian Handicap", "Hockey")).toBe("Puck Line");
    expect(finalizePinnacleMarket("Asian Handicap", "American Football")).toBe("Point Spread");
    expect(finalizePinnacleMarket("Asian Handicap", "Basketball")).toBe("Handicap – Game");
    expect(finalizePinnacleMarket("Point Spread", "Basketball")).toBe("Handicap – Game");
    expect(finalizePinnacleMarket("Point Spread", "American Football")).toBe("Point Spread");
    expect(finalizePinnacleMarket("Asian Handicap", "Tennis")).toBe("Handicap (Games) – Match");
    expect(finalizePinnacleMarket("Asian Handicap", "Soccer")).toBe("Handicap – Match");
  });

  it("Superbet baseball: Handicap (incl. entradas extras) → Handicap – Game", () => {
    expect(pinnacleizeMercado("Handicap (incl. entradas extras)", "Baseball")).toBe(
      "Handicap – Game",
    );
    expect(marketKindOf("Handicap – Game")).toBe("spread");
    expect(marketFamily("Handicap – Game", "Tigres +1.5")).toBe("game_line");
  });

  it("Betboom LoL: Primeiro mapa - total kills → Total (Kills) – Map 1", () => {
    expect(pinnacleizeMercado("Primeiro mapa - total kills", "eSports")).toBe(
      "Total (Kills) – Map 1",
    );
    expect(marketPeriodOf("Total (Kills) – Map 1")).toBe("MAP");
    expect(marketFamily("Total (Kills) – Map 1", "Under 32.5")).toBe("map_line");
  });

  it("Total: Soccer = Total – Match; Total Points no basquete; Total (Games) no tênis", () => {
    expect(finalizePinnacleMarket("Total", "Basketball")).toBe("Total Points");
    expect(finalizePinnacleMarket("Total", "Tennis")).toBe("Total (Games) – Match");
    expect(finalizePinnacleMarket("Total", "Soccer")).toBe("Total – Match");
  });

  it("corners/cards têm label fixo (só futebol); cartões = 'Bookings' (vocabulário Pinnacle)", () => {
    expect(finalizePinnacleMarket("Asian Total Corners", "Soccer")).toBe("Total (Corners) – Match");
    expect(finalizePinnacleMarket("Asian Handicap Corners", "Soccer")).toBe("Handicap (Corners) – Match");
    // Cartões normaliza para "Bookings" (nome da Pinnacle), não "Cards".
    expect(finalizePinnacleMarket("Total Cards", "Soccer")).toBe("Total (Bookings) – Match");
    expect(finalizePinnacleMarket("Asian Handicap Cards", "Soccer")).toBe("Handicap (Bookings) – Match");
  });

  it("pinnacleizeMercado aplica tradução PT + finalização", () => {
    expect(pinnacleizeMercado("Mais/Menos", "Basquete")).toBe("Total Points");
    expect(pinnacleizeMercado("Resultado Final", "Tênis")).toBe("Match Winner");
    expect(pinnacleizeMercado("Escanteios", "Soccer")).toBe("Total (Corners) – Match");
    expect(pinnacleizeMercado("Linha de Escanteios", "Soccer")).toBe("Total (Corners) – Match");
    expect(pinnacleizeMercado("Handicap de Pontos", "Basketball")).toBe("Handicap – Game");
    expect(pinnacleizeMercado("Handicap de Pontos", "Soccer")).toBe("Handicap – Match");
    expect(pinnacleizeMercado("Match Winner", "Soccer")).toBe("Money Line – Match");
    expect(pinnacleizeMercado("Match Winner", "Tennis")).toBe("Match Winner");
    expect(pinnacleizeMercado("1st Half Total Corners", "Soccer")).toBe(
      "Total (Corners) – 1st Half",
    );
  });
});

describe("marketKindOf / marketPeriodOf — SSOT de mecânica", () => {
  it("kinds dos labels finais", () => {
    expect(marketKindOf("Match Winner")).toBe("moneyline");
    expect(marketKindOf("Money Line – Match")).toBe("moneyline");
    expect(marketKindOf("Run Line")).toBe("spread");
    expect(marketKindOf("Handicap – Game")).toBe("spread");
    expect(marketKindOf("Puck Line")).toBe("spread");
    expect(marketKindOf("Point Spread")).toBe("spread");
    expect(marketKindOf("Handicap (Games) – Match")).toBe("spread");
    expect(marketKindOf("Total Points")).toBe("total");
    expect(marketKindOf("Total (Corners) – Match")).toBe("total");
    expect(marketKindOf("Total (Bookings) – Match")).toBe("total");
    expect(marketKindOf("Handicap (Bookings) – Match")).toBe("spread");
    expect(marketKindOf("Handicap (Cards) – Match")).toBe("spread"); // dado legado segue reconhecido
    expect(marketKindOf("Team Total (Games) – Match")).toBe("team_total");
    expect(marketKindOf("Draw No Bet")).toBe("draw_no_bet");
    expect(marketKindOf("Empate Devolve")).toBe("draw_no_bet");
    expect(marketKindOf("Both Teams to Score")).toBe("btts");
    expect(marketKindOf("Ambos Marcam")).toBe("btts");
    expect(marketKindOf("Gol/Gol")).toBe("btts");
    expect(marketKindOf("Ambas Equipes Marcam")).toBe("btts");
    expect(marketKindOf("Both Score")).toBe("btts");
    expect(marketKindOf("Aposta Sem Empate")).toBe("draw_no_bet");
    expect(marketKindOf("Sem Empate")).toBe("draw_no_bet");
    expect(marketKindOf("Tie No Bet")).toBe("draw_no_bet");
    expect(marketKindOf("Home Team Total")).toBe("team_total");
    expect(marketKindOf("Away Total Goals")).toBe("team_total");
    expect(marketKindOf("Total Goals", "Flamengo Over 1.5")).toBe("team_total");
    expect(marketKindOf("Total Points", "Lakers Over 110.5")).toBe("team_total");
    for (const market of [
      "3-Way Handicap",
      "Three Way Handicap",
      "Handicap 3 Vias",
      "Handicap 3 Opções",
      "Handicap 3 Seleções",
    ]) {
      expect(marketKindOf(market), market).toBe("other");
    }
  });

  it("períodos: 1st half = HT; 2nd half tem período próprio sem cobertura de odds", () => {
    expect(marketPeriodOf("Total")).toBe("FT");
    expect(marketPeriodOf("1st Half Moneyline")).toBe("HT");
    expect(marketPeriodOf("2nd Half Moneyline")).toBe("SECOND_HALF");
    expect(marketPeriodOf("Second Half Total")).toBe("SECOND_HALF");
    expect(marketPeriodOf("Total (Corners) – 1st Half")).toBe("HT");
    expect(marketPeriodOf("Half Time Result")).toBe("HT");
    expect(marketPeriodOf("Total – Map 2")).toBe("MAP");
    expect(marketPeriodOf("Total (Kills) – Map 1")).toBe("MAP");
    expect(marketPeriodOf("Primeiro mapa - total kills")).toBe("MAP");
    for (const market of ["1ª mapa", "1a mapa", "primeira mapa", "M1", "m9"]) {
      expect(marketPeriodOf(market), market).toBe("MAP");
    }
  });

  it("não trata quartos, períodos, innings ou fases isoladas como placar FT", () => {
    for (const market of [
      "1st Quarter Total",
      "Q3 Moneyline",
      "1º Quarto Total",
      "3rd Period Total",
      "P2 Winner",
      "5 Innings Total",
      "Inning 7 Moneyline",
      "1Q Winner",
      "I1 Total",
      "Game 1 Winner",
      "Extra Time Winner",
      "Regulation Time Total",
      "Regulation Only Winner",
      "Total (Regulation)",
      "Resultado Final (Tempo Regulamentar)",
      "Penalty Shootout Winner",
    ]) {
      expect(marketPeriodOf(market), market).toBe("OTHER");
    }
  });

  it("recusa aliases digit-first e subunidades adicionais", () => {
    for (const market of [
      "2P Winner",
      "3P Total",
      "2 P Winner",
      "S1 Winner",
      "S2 Total",
      "1st Set Total Points",
      "Round 1 Winner",
      "Frame1 Winner",
      "Leg 1 Winner",
      "R1 Winner",
      "Winner (90 min)",
      "90 Minutes Total",
    ]) {
      expect(marketPeriodOf(market), market).toBe("OTHER");
    }
    expect(marketPeriodOf("Halftime Winner")).toBe("HT");
  });

  it("outright e Handicap Result não viram game-line asiática", () => {
    expect(marketKindOf("Outright Winner")).toBe("other");
    expect(marketKindOf("Tournament Winner (Futures)")).toBe("other");
    expect(marketKindOf("Tournament Winner")).toBe("other");
    expect(marketKindOf("Group Winner")).toBe("other");
    expect(marketKindOf("Handicap Result")).toBe("other");
    expect(marketKindOf("Handicap 0:1")).toBe("other");
    expect(marketKindOf("Vencedor Final")).toBe("other");
    expect(marketKindOf("Campeão")).toBe("other");
    expect(marketKindOf("Resultado Exato")).toBe("correct_score");
    expect(marketKindOf("KO/TKO Winner")).toBe("other");
    expect(marketKindOf("Method of Victory")).toBe("other");
    expect(marketKindOf("Submission Winner")).toBe("other");
    expect(marketKindOf("Decision Winner")).toBe("other");
    for (const mercado of [
      "Vencedor do Grupo",
      "Vencedor do Troféu",
      "Para Vencer o Torneio",
      "Para Ganhar o Torneio",
    ]) {
      expect(marketKindOf(mercado), mercado).toBe("other");
    }
  });

  it("o pedido em cada tempo não é o 2º tempo nem o jogo inteiro", () => {
    for (const text of [
      "Over 0.5 1T e 2T", "Over 0.5 1ºT e 2ºT", "Over 0.5 1º e 2ºT", "Over 0.5 1T/2T", "Over 0.5 PT e ST",
      "Mais de 0.5 gols no 1º e no 2º tempo", "Over 0.5 1st and 2nd half", "Over 0.5 1H & 2H",
      "Flamengo vence os dois tempos", "Marcar em cada tempo", "Win Both Halves", "Score in each half",
      "Over 0.5 nos dois tempos incluindo prorrogação",
    ]) {
      expect(marketPeriodOf(text), text).toBe("OTHER");
    }
    // Um tempo só continua lido como ele.
    expect(marketPeriodOf("Over 0.5 1T")).toBe("HT");
    expect(marketPeriodOf("Over 0.5 2ºT")).toBe("SECOND_HALF");
    expect(marketPeriodOf("Over 0.5 ST")).toBe("SECOND_HALF");
  });

  it("resultado combinado HT/FT é período composto, não intervalo", () => {
    expect(marketPeriodOf("Half Time/Full Time")).toBe("OTHER");
    expect(marketPeriodOf("HT/FT")).toBe("OTHER");
    expect(marketPeriodOf("Mogi ML H5 FT")).toBe("OTHER");
    expect(marketPeriodOf("H5")).toBe("OTHER");
  });

  it("winner de round/pontos é parcial, mas Game Winner nu continua ML da partida", () => {
    expect(marketPeriodOf("Round Winner")).toBe("OTHER");
    expect(marketPeriodOf("Points Winner")).toBe("OTHER");
    expect(marketPeriodOf("Set Winner")).toBe("OTHER");
    expect(marketPeriodOf("Frame Winner")).toBe("OTHER");
    expect(marketPeriodOf("Leg Winner")).toBe("OTHER");
    expect(marketPeriodOf("Game Winner")).toBe("FT");
    expect(marketKindOf("Game Winner")).toBe("moneyline");
  });

  it("reconhece team totals estatísticos por mercado ou seleção nominal", () => {
    expect(marketKindOf("Total Corners", "Athletic Club Over 4.5")).toBe("team_total");
    expect(marketKindOf("Total Cards", "Operario Ferroviario Under 2.5")).toBe("team_total");
    expect(marketKindOf("Home Corner Total", "Over 4.5")).toBe("team_total");
    expect(marketKindOf("Away Card Total", "Under 2.5")).toBe("team_total");
    expect(marketKindOf("Total Corners", "Over 9.5")).toBe("total");
    expect(marketKindOf("Total de Gols do Mandante", "Over 1.5")).toBe("team_total");
    expect(marketKindOf("Total de Pontos do Visitante", "Under 95.5")).toBe("team_total");
    expect(marketKindOf("Total Gols Mandante", "Over 1.5")).toBe("team_total");
    expect(marketKindOf("Total de Gols - Fora", "Under 1.5")).toBe("team_total");
    expect(marketKindOf("Total de Gols por Time", "Flamengo Over 1.5")).toBe("team_total");
    expect(marketKindOf("Total de Gols da Equipe", "Flamengo Over 1.5")).toBe("team_total");
    expect(marketKindOf("Total por Time", "Flamengo Over 1.5")).toBe("team_total");
    expect(marketKindOf("Pontos do Time", "Over 85.5")).toBe("team_total");
    expect(marketKindOf("Pontos da Equipe", "Under 85.5")).toBe("team_total");
    expect(marketKindOf("Runs do Time", "Over 4.5")).toBe("team_total");
    expect(marketKindOf("Corridas da Equipe", "Under 4.5")).toBe("team_total");
    expect(marketKindOf("Total Runs", "Yankees Over 4.5")).toBe("team_total");
    expect(marketKindOf("Total de Corridas", "Yankees Over 4.5")).toBe("team_total");
  });

  it("classifica eSports Player Props, Basquete Player Props e Futebol Goalscorers sem confundir com Moneyline", () => {
    // eSports Player Props
    expect(marketKindOf("deaths")).toBe("player_props");
    expect(marketKindOf("kills")).toBe("player_props");
    expect(marketKindOf("abates")).toBe("player_props");
    expect(marketKindOf("mortes")).toBe("player_props");
    expect(marketKindOf("deaths HT")).toBe("player_props");
    expect(marketKindOf("kills HT")).toBe("player_props");
    expect(marketKindOf("Player Props")).toBe("player_props");

    // Basquete Player Props
    expect(marketKindOf("P + A + R")).toBe("player_props");
    expect(marketKindOf("pra")).toBe("player_props");
    expect(marketKindOf("pontos")).toBe("player_props");
    expect(marketKindOf("rebotes")).toBe("player_props");
    expect(marketKindOf("assistências")).toBe("player_props");
    expect(marketKindOf("Player Points/Rebounds/Assists")).toBe("player_props");

    // Futebol Goalscorer
    expect(marketKindOf("anytime")).toBe("scorer");
    expect(marketKindOf("anytime goalscorer")).toBe("scorer");
    expect(marketKindOf("marcar a qualquer momento")).toBe("scorer");
    expect(marketKindOf("any 1° gol")).toBe("scorer");
    expect(marketKindOf("First Goalscorer")).toBe("scorer");
  });

  it("reconhece total de abates pela seleção e mapas em numerais romanos", () => {
    expect(marketKindOf("Abates - Mapa 1", "Over 25.5")).toBe("total");
    expect(marketFamily("Abates - Mapa 1", "Over 25.5")).toBe("map_line");
    expect(marketFamily("Abates - Mapa II", "Over 25.5")).toBe("map_line");
    for (const [mercado, numero] of [
      ["Mapa I", 1],
      ["Mapa II", 2],
      ["Mapa III", 3],
      ["Mapa IV", 4],
      ["Mapa V", 5],
    ] as const) {
      expect(marketMapNumberOf(mercado), mercado).toBe(numero);
      expect(marketPeriodOf(mercado), mercado).toBe("MAP");
    }
  });

  it("reconhece ordinais ingleses e Game/Jogo N somente no contexto eSports", () => {
    for (const [mercado, numero] of [
      ["1st Map", 1],
      ["2nd Map", 2],
      ["3rd Map", 3],
      ["4th Map", 4],
      ["5th Map", 5],
    ] as const) {
      expect(marketMapNumberOf(mercado), mercado).toBe(numero);
      expect(marketPeriodOf(mercado), mercado).toBe("MAP");
    }
    expect(marketMapNumberOf("Game 1", "eSports")).toBe(1);
    expect(marketMapNumberOf("Jogo 2", "eSports")).toBe(2);
    expect(marketPeriodOf("Game 1 - Winner", "eSports")).toBe("MAP");
    expect(marketPeriodOf("Jogo 2 - Vencedor", "eSports")).toBe("MAP");
    expect(marketMapNumberOf("Game 1", "Tennis")).toBeNull();
    expect(marketPeriodOf("Game 1 - Winner", "Tennis")).toBe("OTHER");
    expect(marketPeriodOf("Jogo 1 - Vencedor", "Soccer")).toBe("OTHER");
  });

  it("entende abreviações de tempo, innings, prorrogação e shootout", () => {
    for (const market of ["H1 Total", "1H Winner", "FH Total", "1T Totais", "Totais 1T"]) {
      expect(marketPeriodOf(market), market).toBe("HT");
    }
    expect(marketPeriodOf("2T Totais")).toBe("SECOND_HALF");
    expect(marketPeriodOf("1T/FT")).toBe("OTHER");
    for (const market of [
      "F5 Total",
      "ET Winner",
      "OT Moneyline",
      "PEN Total",
      "SO Winner",
      "Shootout Winner",
    ]) {
      expect(marketPeriodOf(market), market).toBe("OTHER");
    }
    for (const market of ["H2 Total", "2H Winner", "SH Total"]) {
      expect(marketPeriodOf(market), market).toBe("SECOND_HALF");
    }
    expect(marketKindOf("1H Winner")).toBe("moneyline");
  });

  it("lê o tempo com ordinal colado (1ºT/2°T), 'metade', PT/ST depois da linha e janela de minutos", () => {
    for (const text of [
      "Over 0.5 1ºT", "Over 0.5 1°T", "Over 0.5 (1°T)", "Over 0.5 1º T", "Gols 1ºT", "1ºT Totais",
      "Flamengo -0.5 1ºT", "Flamengo 1ºT", "Over 0.5 primeira metade", "Over 0.5 PT", "Flamengo -0.5 PT",
    ]) {
      expect(marketPeriodOf(text), text).toBe("HT");
    }
    for (const text of ["Over 1.5 2ºT", "Over 1.5 2°T", "Over 1.5 segunda metade", "Over 1.5 ST", "Over 1.5 gols ST"]) {
      expect(marketPeriodOf(text), text).toBe("SECOND_HALF");
    }
    // Janela de minutos não é tempo nenhum: nem o 1º tempo nem o jogo respondem.
    for (const text of [
      "Over 0.5 0-10 min", "Over 0.5 gols até 15 min", "Primeiros 10 minutos - Total", "Over 0.5 first 10 minutes",
      "1ºT/Final",
    ]) {
      expect(marketPeriodOf(text), text).toBe("OTHER");
    }
    // "St"/"Pt" de nome de time, e o tempo escrito por extenso, continuam como antes.
    for (const text of ["St Pauli -0.5", "Over 1.5 St Pauli", "St Mirren", "Over 2.5"]) {
      expect(marketPeriodOf(text), text).toBe("FT");
    }
    expect(marketPeriodOf("Over 0.5 1º tempo")).toBe("HT");
    expect(marketPeriodOf("1º Tempo - Totais")).toBe("HT");
  });

  it("PT/ST soltos depois da linha só são tempo nos esportes de dois tempos", () => {
    // No basquete "Over 110.5 PT" pode ser de pontos: o tempo não se presume.
    for (const esporte of ["Basketball", "Tennis", "Hockey"]) {
      expect(marketPeriodOf("Over 110.5 PT", esporte), esporte).toBe("OTHER");
      expect(marketPeriodOf("Lakers -4.5 ST", esporte), esporte).toBe("OTHER");
    }
    // Futsal e handebol também se jogam em dois tempos; esporte não lido vale como futebol.
    for (const esporte of ["Soccer", "Futebol", "Futsal", "Handball", "Unknown", undefined]) {
      expect(marketPeriodOf("Over 0.5 PT", esporte), esporte).toBe("HT");
      expect(marketPeriodOf("Over 1.5 ST", esporte), esporte).toBe("SECOND_HALF");
    }
    expect(resolveResultFromScore({
      evento: "Brasil vs Argentina", esporte: "Futsal", mercado: "Total", selecao: "Over 0.5 PT",
      homeScore: 1, awayScore: 0, scorePeriod: "HT", odds: 1.9, stake: 1,
    })).toMatchObject({ ok: true, status: "WON" });
    // O tempo escrito por extenso ou pela sigla própria continua valendo em qualquer esporte.
    expect(marketPeriodOf("Over 110.5 1º tempo", "Basketball")).toBe("HT");
    expect(marketPeriodOf("Over 110.5 1T", "Basketball")).toBe("HT");
    expect(resolveResultFromScore({
      evento: "Lakers vs Celtics", esporte: "Basketball", mercado: "Total", selecao: "Over 110.5 PT",
      homeScore: 60, awayScore: 55, scorePeriod: "HT", odds: 1.9, stake: 1,
    })).toEqual({ ok: false, reason: "wrong_period" });
  });

  it("mantém FT quando o mercado declara que inclui prorrogação", () => {
    expect(marketPeriodOf("Total Including Overtime")).toBe("FT");
    expect(marketPeriodOf("Moneyline Incl OT")).toBe("FT");
    expect(marketPeriodOf("Handicap Including Extra Time")).toBe("FT");
    expect(marketPeriodOf("Total incluindo prolongamento")).toBe("FT");
    expect(marketPeriodOf("Total incluindo prorrogação")).toBe("FT");
  });

  it("European Handicap não é spread asiático", () => {
    expect(marketKindOf("European Handicap")).toBe("other");
    expect(marketFamily("3-Way Handicap", "Flamengo -1")).toBe("other");
    expect(isThreeWayHandicapMarket("Handicap Europeu")).toBe(true);
    expect(isThreeWayHandicapMarket("European Handicap")).toBe(true);
  });

  it("reconhece vocabulário alternativo de DNB, Dupla Chance e método de vitória", () => {
    expect(isDrawNoBetMarket("Empate não conta")).toBe(true);
    expect(isDrawNoBetMarket("Empate não vale")).toBe(true);
    expect(isDrawNoBetMarket("Empate cancela a aposta")).toBe(true);
    expect(isDrawNoBetMarket("Empate nulo")).toBe(true);
    expect(marketKindOf("Empate não conta")).toBe("draw_no_bet");
    expect(marketKindOf("Empate cancela a aposta")).toBe("draw_no_bet");
    expect(marketKindOf("Empate nulo")).toBe("draw_no_bet");
    expect(isDoubleChanceMarket("Hipótese Dupla")).toBe(true);
    expect(marketKindOf("Hipótese Dupla")).toBe("double_chance");
    expect(isMethodOfVictoryMarket("Forma da Vitória")).toBe(true);
    expect(isMethodOfVictoryMarket("Modo de Vitória")).toBe(true);
    expect(isMethodOfVictoryMarket("Tipo de Vitória")).toBe(true);
    expect(isMethodOfVictoryMarket("Tipo de Finalização")).toBe(true);
    expect(marketKindOf("Forma da Vitória")).toBe("other");
    expect(marketKindOf("Tipo de Vitória")).toBe("other");
  });

  it("reconhece aliases brasileiros de BTTS, moneyline e totais", () => {
    for (const mercado of [
      "Ambas as Equipes Marcarão",
      "Ambos os Times Marcarão",
      "Para Ambos Marcarem",
    ]) {
      expect(marketKindOf(mercado), mercado).toBe("btts");
    }
    expect(marketKindOf("Ganhador da Partida")).toBe("moneyline");
    expect(marketKindOf("Ganhador do Confronto")).toBe("moneyline");
    expect(marketKindOf("Mais/Menos Gols")).toBe("total");
    expect(marketKindOf("Acima/Abaixo Cartões")).toBe("total");
    expect(marketKindOf("Mais de Gols")).toBe("total");
    expect(marketKindOf("Menos de Cartões")).toBe("total");
  });

  it("pistol round e round com ordinal são parte do jogo, não o jogo inteiro", () => {
    for (const texto of [
      "Money Line – Pistol Round", "Money Line – 1st Pistol Round", "Vencedor do Pistol Round", "Pistol round vencedor",
      "Vencedor do Pistol", "Vencedor do Primeiro Round", "Money Line – Last Round", "FURIA - Pistol Round",
    ]) {
      expect(marketPeriodOf(texto, "eSports"), texto).toBe("OTHER");
    }
    expect(marketPeriodOf("Money Line – Match", "eSports")).toBe("FT");
  });

  it("método da vitória dito com 'por' ou com 'método' não é o vencedor da luta", () => {
    for (const mercado of [
      "Vencedor por Decisão", "Vencedor por Finalização", "Vencedor por nocaute", "Vitória por Submissão",
      "Vence por pontos", "Vencedor e Método", "Método", "Winner and Method",
    ]) {
      expect(isMethodOfVictoryMarket(mercado), mercado).toBe(true);
      expect(marketKindOf(mercado, "Jon Jones"), mercado).toBe("other");
    }
    expect(marketKindOf("Vencedor da Luta", "Jon Jones")).toBe("moneyline");
  });

  it("reconhece DNB por reembolso, Dupla Chance por oportunidade e método por 'como termina'", () => {
    for (const mercado of [
      "Empate Reembolsa",
      "Empate Estorna",
      "Reembolso no Empate",
      "Devolução no Empate",
      "Estorno em Empate",
    ]) {
      expect(isDrawNoBetMarket(mercado), mercado).toBe(true);
      expect(marketKindOf(mercado), mercado).toBe("draw_no_bet");
    }
    for (const mercado of [
      "Dupla Oportunidade",
      "Oportunidade Dupla",
      "Dupla Possibilidade",
      "Possibilidade Dupla",
    ]) {
      expect(isDoubleChanceMarket(mercado), mercado).toBe(true);
      expect(marketKindOf(mercado), mercado).toBe("double_chance");
    }
    for (const mercado of [
      "Como o Combate Terminará",
      "Como a Luta vai Terminar",
      "Método de Encerramento",
    ]) {
      expect(isMethodOfVictoryMarket(mercado), mercado).toBe(true);
      expect(marketKindOf(mercado), mercado).toBe("other");
    }
  });

  it("Goal Line / Linha de Gols é total, e a família de escanteios continua acima do kind", () => {
    expect(marketKindOf("Goal Line", "Over 2.5")).toBe("total");
    expect(marketKindOf("Linha de Gols", "Over 2.5")).toBe("total");
    expect(marketKindOf("Linha de Pontos", "Over 210.5")).toBe("total");
    expect(marketKindOf("Linha de Gols", "Flamengo Over 1.5")).toBe("team_total");
    // Escanteios/cartões continuam na família estatística, nunca no placar.
    expect(marketFamily("Linha de Escanteios", "Over 9.5")).toBe("corners");
    expect(marketFamily("Linha de Cartões", "Over 3.5")).toBe("cards");
    expect(marketFamily("Linha de Gols", "Over 2.5")).toBe("game_line");
  });

  it("DNB aceita qualificador de valor/investimento", () => {
    for (const mercado of [
      "Empate devolve o investimento",
      "Empate anula o dinheiro",
      "Devolução do valor no empate",
      "Reembolso do valor em caso de empate",
      "Estorno da aposta em empate",
    ]) {
      expect(isDrawNoBetMarket(mercado), mercado).toBe(true);
      expect(marketKindOf(mercado), mercado).toBe("draw_no_bet");
    }
  });

  it("Linha de Runs/Corridas é total de beisebol; prop de runs não", () => {
    expect(marketKindOf("Linha de Runs", "Over 8.5")).toBe("total");
    expect(marketKindOf("Linha de Corridas", "Over 8.5")).toBe("total");
    expect(marketFamily("Linha de Runs", "Over 8.5", "Baseball")).toBe("game_line");
    expect(marketKindOf("Home Runs", "Over 1.5")).toBe("other");
    expect(marketFamily("Home Runs", "Over 1.5", "Baseball")).toBe("other");
  });

  it("total de gols em PT usa o placar do lado quando a seleção nomeia o time", () => {
    // "Total Goals" (EN) já resolvia como team_total; a forma PT caía em total
    // de JOGO e liquidava pelo placar agregado.
    expect(marketKindOf("Total de Gols", "Flamengo Over 1.5")).toBe("team_total");
    expect(marketKindOf("Total de Gols", "Over 2.5")).toBe("total");
    // `Total` canônico sem substantivo estatístico continua agregado.
    expect(marketKindOf("Total", "Flamengo Over 1.5")).toBe("total");
  });

  it("família entende os labels finais (segmento do dono: mercado×esporte)", () => {
    expect(marketFamily("Total Points", "Over 215.5")).toBe("game_line");
    expect(marketFamily("Match Winner", "Fritz")).toBe("game_line");
    expect(marketFamily("Total (Corners) – Match", "Over 8.5")).toBe("corners");
    expect(marketFamily("Total (Bookings) – Match", "Over 4")).toBe("cards");
    expect(marketFamily("Total (Cards) – 1st Half", "Over 2.5")).toBe("cards"); // legado
    // HT game-line → Pinnacle17 (ht_line); Bridge/Pinnacle17 ficam de fora.
    expect(marketFamily("1st Half Moneyline", "Casa")).toBe("ht_line");
    expect(marketFamily("2nd Half Total", "Over 1.5")).toBe("other");
    expect(marketFamily("H1 Winner", "Casa")).toBe("ht_line");
    expect(marketFamily("F5 Total", "Over 4.5")).toBe("other");
    expect(marketFamily("Total (Kills) – Map 1", "Under 32.5")).toBe("map_line");
  });

  it("seleção de lado funciona com Match Winner", () => {
    expect(
      pinnacleizeSelecao({
        selecao: "casa",
        mercadoPinnacle: "Match Winner",
        evento: "Sinner vs Fritz",
      }),
    ).toBe("Sinner");
  });
});

describe("gates de período/família nos resolvers", () => {
  const bridgeMatch = {
    match_id: 1,
    home: "Qatar",
    away: "Switzerland",
    league: "FIFA - World Cup",
    sport: "Futebol",
    match_date: "2026-06-13T19:00:00Z",
    home_score: null,
    away_score: null,
    moneyline: {
      opening: { home: 12.0, draw: 6.5, away: 1.25, max_bet: 100 },
      closing: { home: 12.83, draw: 6.84, away: 1.2288, max_bet: 600 },
    },
    total: [],
    spread: [],
  };

  it("bridge recusa corners e 1º tempo (nunca precificar com FT de gols)", () => {
    expect(
      resolveBridgeOddsForBet(bridgeMatch, {
        mercado: "Total (Corners) – Match",
        selecao: "Over 8.5",
      }),
    ).toEqual({ ok: false, reason: "unsupported_market" });
    expect(
      resolveBridgeOddsForBet(bridgeMatch, { mercado: "1st Half Moneyline", selecao: "Draw" }),
    ).toEqual({ ok: false, reason: "unsupported_market" });
  });
});

/**
 * Grafias que a captura traz e que, sem reconhecimento, gravam a aposta com o
 * mercado CRU, fora do vocabulário Pinnacle.
 *
 * Vão para o INTERMEDIÁRIO de propósito. Cravar o rótulo final do futebol
 * ("Handicap – Match") acertaria no futebol e erraria calado no basquete, onde
 * o mesmo mercado é "Handicap – Game" (UI Pinnacle).
 */
describe("grafias PT que caíam fora do catálogo", () => {
  it.each([
    ["Handicap - Partida", "Soccer", "Handicap – Match"],
    ["Handicap - Partida", "Basketball", "Handicap – Game"],
    ["Handicap - Partida", "Hockey", "Puck Line"],
    ["Handicap da Partida", "Soccer", "Handicap – Match"],
    ["Total (Gols) – Match", "Soccer", "Total – Match"],
    ["Total (Gols) – Match", "Basketball", "Total Points"],
    ["Total de Gols", "Soccer", "Total – Match"],
    ["Ambos Marcam", "Soccer", "Both Teams to Score"],
    ["Ambas Marcam", "Soccer", "Both Teams to Score"],
  ])("%s (%s) → %s", (bruto, esporte, esperado) => {
    expect(pinnacleizeMercado(bruto, esporte)).toBe(esperado);
  });

  it("o hífen e o travessão dão no mesmo — a chave de alias tira pontuação", () => {
    expect(pinnacleizeMercado("Handicap – Partida", "Soccer")).toBe("Handicap – Match");
    expect(pinnacleizeMercado("Total (Gols) - Match", "Soccer")).toBe("Total – Match");
  });
});
