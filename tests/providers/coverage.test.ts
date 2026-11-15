import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_RESULT_PROVIDER,
  bridgeOddsIsAuthoritative,
  identityProviders,
  isStatQualifierMarket,
  marketHasNoSharpReference,
  marketFamily,
  oddsProviders,
  providerCoversBet,
  providerCoversSport,
} from "@/src/providers/coverage";
import { isMercadoFinal } from "@/src/domain/mercados/catalog";
import { pinnacleizeMercado } from "@/src/domain/mercados/finalize";
import {
  BRIDGEODDS_COVERAGE,
  bridgeSportFromEsporte,
} from "@/src/providers/bridgeodds/coverage-contract";

/**
 * SSOT de capacidade — o racional do dono: providers se complementam por
 * esporte E mercado. Tênis não pode morrer em UNSUPPORTED; escanteio tem
 * que rotear para quem TEM escanteio.
 */

describe("marketFamily", () => {
  it("Bridge não usa o total FT para períodos/unidades declarados só na seleção", () => {
    for (const selecao of ["Over 2.5 1st Half", "Over 2.5 Q1", "Over 2.5 pontos"]) {
      expect(providerCoversBet("bridgeodds", { esporte: "Soccer", mercado: "Total", selecao })).toBe(false);
    }
  });

  it("classifica mercados canônicos", () => {
    expect(marketFamily("Moneyline")).toBe("game_line");
    expect(marketFamily("Total", "Under 4.75")).toBe("game_line");
    expect(marketFamily("Asian Handicap", "Flamengo -0.5")).toBe("game_line");
    expect(marketFamily("Asian Total Corners", "Over 8.5")).toBe("corners");
    expect(marketFamily("Corners O/U", "Under 9")).toBe("corners");
    expect(marketFamily("Asian Handicap Corners", "Qatar -3.5")).toBe("corners");
    expect(marketFamily("Total Cards", "Over 3.5")).toBe("cards");
    expect(marketFamily("Cards O/U", "Under 4")).toBe("cards");
    // "Amarelos"/"Vermelhos" são estatísticas específicas, não sinônimos da
    // contagem asiática Total Cards (amarelo=1, vermelho=2) do mercado asiático.
    expect(marketFamily("Amarelos", "Over 3.5")).toBe("other");
    expect(marketFamily("Vermelhos", "Over 0.5")).toBe("other");
    expect(oddsProviders({
      esporte: "Soccer",
      mercado: "Amarelos",
      selecao: "Over 3.5",
    })).toEqual([]);
    expect(marketFamily("Both Teams to Score", "Sim")).toBe("btts");
    expect(marketFamily("Ambos Marcam", "Sim")).toBe("btts");
    // Team total tem família PRÓPRIA — não pode cair no total da partida.
    expect(marketFamily("Team Total", "Qatar Over 1.5")).toBe("team_total");
    expect(marketFamily("Home Team Total Goals", "Over 1.5")).toBe("team_total");
    expect(marketFamily("Away Total Goals", "Under 1.5")).toBe("team_total");
    expect(marketFamily("Total Goals", "Qatar Over 1.5")).toBe("team_total");
    expect(marketFamily("Total Points", "Lakers Over 110.5")).toBe("team_total");
    expect(marketFamily("3-Way Handicap", "Qatar -1")).toBe("other");
    expect(marketFamily("Draw No Bet", "Canada")).toBe("game_line");
    expect(marketFamily("1st Half Moneyline", "Casa")).toBe("ht_line");
    expect(marketFamily("Player Shots", "Vini Jr over 2.5")).toBe("other");
    expect(marketFamily("Player Cards", "Over 0.5")).toBe("other");
    expect(marketFamily("Cartões do Jogador", "Over 0.5")).toBe("other");
    expect(marketFamily("Total Rebounds", "Over 45.5")).toBe("other");
    expect(marketFamily("Total Steals", "Over 10.5")).toBe("other");
    expect(isStatQualifierMarket("Total Hits", "Over 7.5")).toBe(true);
    expect(marketFamily("H1 Total", "Over 1.5")).toBe("ht_line");
    expect(marketFamily("Total (Corners) – 2nd Half", "Over 4.5")).toBe("other");
    expect(marketFamily("F5 Total", "Over 4.5")).toBe("other");
    expect(marketFamily("Moneyline", "Aces United")).toBe("game_line");
    expect(marketFamily("Total de Abates – Mapa 1", "Over 22.5")).toBe("map_line");
    expect(marketFamily("Handicap de Abates – Mapa 2", "Time A -2.5")).toBe("map_line");
    expect(marketFamily("Game 1 - Winner", "Time A", "eSports")).toBe("map_period");
    expect(marketFamily("Jogo 2 - Vencedor", "Time B", "eSports")).toBe("map_period");
    expect(marketFamily("Game 1 - Winner", "Jogador A", "Tennis")).toBe("other");
    expect(marketFamily("Money Line – 1st Set", "Jogador A", "Tennis")).toBe("other");
    expect(marketFamily("Money Line – 1st Period", "Casa", "Hockey")).toBe("other");
    expect(marketFamily("Money Line – 1st Quarter", "Casa", "American Football")).toBe("other");
    expect(marketFamily("Money Line – 1st Inning", "Casa", "Baseball")).toBe("other");
    expect(isStatQualifierMarket("Moneyline", "Aces United")).toBe(false);
    for (const market of ["Total Dragons", "Total Barons", "Total Inhibitors"]) {
      expect(isStatQualifierMarket(market, "Over 2.5"), market).toBe(true);
      expect(marketFamily(market, "Over 2.5"), market).toBe("other");
    }
  });

  it("HT é precificado pela Pinnacle17", () => {
    expect(providerCoversBet("pinnacle17", { esporte: "Soccer", mercado: "1st Half Total" })).toBe(
      true,
    );
    expect(providerCoversBet("bridgeodds", { esporte: "Soccer", mercado: "1st Half Total" })).toBe(
      false,
    );
    expect(providerCoversBet("pinnacle17", { esporte: "Soccer", mercado: "1st Half Total" })).toBe(
      true,
    );
  });
});

describe("papel exclusivo de resultado externo", () => {
  it("autoriza somente FlashScore e recusa toda a cascata sharp", () => {
    expect(AUTOMATIC_RESULT_PROVIDER).toBe("flashscore");
  });
});

describe("cobertura por esporte", () => {
  it("bridge só cobre futebol e basquete", () => {
    expect(providerCoversSport("bridgeodds", "Soccer")).toBe(true);
    expect(providerCoversSport("bridgeodds", "Basketball")).toBe(true);
    expect(providerCoversSport("bridgeodds", "Tennis")).toBe(false);
    expect(providerCoversSport("bridgeodds", "Volleyball")).toBe(false);
    expect(bridgeSportFromEsporte("Tennis")).toBeNull();
    expect(bridgeSportFromEsporte("Baseball")).toBeNull();
    expect(bridgeSportFromEsporte("Hockey")).toBeNull();
    expect(bridgeSportFromEsporte("American Football")).toBeNull();
  });

  it("tênis usa só o catálogo Pinnacle17", () => {
    expect(providerCoversSport("pinnacle17", "Tennis")).toBe(true);
    expect(providerCoversSport("bridgeodds", "Tennis")).toBe(false);
  });

  it("futebol está nos dois catálogos", () => {
    expect(providerCoversSport("pinnacle17", "Soccer")).toBe(true);
    expect(providerCoversSport("bridgeodds", "Soccer")).toBe(true);
  });

  it("esporte desconhecido → nenhum provider (UNSUPPORTED honesto)", () => {
    expect(providerCoversSport("pinnacle17", "Chess")).toBe(false);
    expect(providerCoversSport("bridgeodds", "Chess")).toBe(false);
  });
});

describe("cobertura por mercado", () => {
  it("escanteios de futebol usam Pinnacle17", () => {
    const params = { esporte: "Soccer", mercado: "Asian Total Corners", selecao: "Over 8.5" };
    expect(providerCoversBet("bridgeodds", params)).toBe(false);
    expect(providerCoversBet("pinnacle17", params)).toBe(true);
    expect(providerCoversBet("pinnacle17", params)).toBe(true);
    expect(oddsProviders(params)).toEqual(["pinnacle17",]);
  });

  it("cartões idem", () => {
    expect(oddsProviders({ esporte: "Soccer", mercado: "Total Cards", selecao: "Over 3.5" })).toEqual([
      "pinnacle17",
    ]);
  });

  it("subperíodos nomeados são roteáveis; innings sem contrato continuam recusados", () => {
    for (const params of [
      { esporte: "Tennis", mercado: "Money Line – 1st Set", selecao: "Fritz" },
      { esporte: "Hockey", mercado: "Total – 1st Period", selecao: "Over 1.5" },
      { esporte: "Volleyball", mercado: "Handicap – 1st Set", selecao: "Minas -1.5" },
      { esporte: "American Football", mercado: "Total – 1st Quarter", selecao: "Over 10.5" },
    ]) {
      expect(oddsProviders(params), `${params.esporte}/${params.mercado}`).toEqual(["pinnacle17"]);
    }
    for (const params of [{ esporte: "Baseball", mercado: "Money Line – 1st Inning", selecao: "Yankees" }]) {
      expect(oddsProviders(params), `${params.esporte}/${params.mercado}`).toEqual([]);
    }
  });

  it("team total usa Pinnacle17 nos esportes cobertos", () => {
    const soccer = { esporte: "Soccer", mercado: "Team Total", selecao: "Qatar Over 1.5" };
    expect(providerCoversBet("pinnacle17", soccer)).toBe(true);
    expect(oddsProviders(soccer)).toEqual(["pinnacle17",]);
    expect(
      oddsProviders({ esporte: "Basketball", mercado: "Team Total", selecao: "Lakers Over 110.5" }),
    ).toEqual(["pinnacle17",]);
    expect(
      oddsProviders({
        esporte: "Baseball",
        mercado: "Total de Corridas",
        selecao: "Yankees Over 4.5",
      }),
    ).toEqual(["pinnacle17",]);
  });

  it("game-line de futebol: BridgeOdds vem primeiro (primeira autoridade) e Pinnacle17 é o fallback", () => {
    const total = { esporte: "Soccer", mercado: "Total", selecao: "Under 2.5" };
    expect(providerCoversBet("pinnacle17", total)).toBe(true);
    expect(bridgeOddsIsAuthoritative(total)).toBe(true);
    expect(oddsProviders({ esporte: "Soccer", mercado: "Total", selecao: "Under 2.5" })).toEqual([
      "bridgeodds", "pinnacle17",
    ]);
    for (const mercado of ["Quem Vencerá", "Quem Vence", "Quem Ganhará", "Quem Ganha"]) {
      expect(oddsProviders({ esporte: "Soccer", mercado, selecao: "Casa" }), mercado).toEqual([
        "bridgeodds", "pinnacle17",
      ]);
    }
  });

  it("identidade coberta tenta Bridge e depois Pinnacle17", () => {
    expect(identityProviders({
      esporte: "Soccer",
      mercado: "Money Line – Match",
      selecao: "Home",
    })).toEqual(["bridgeodds", "pinnacle17",]);
    expect(identityProviders({
      esporte: "Soccer",
      mercado: "Total (Bookings) – Match",
      selecao: "Over 3.5",
    })).toEqual(["pinnacle17", "bridgeodds"]);
    expect(identityProviders({
      esporte: "Soccer",
      mercado: "Both Teams to Score",
      selecao: "Sim",
    })).toEqual(["pinnacle17", "bridgeodds"]);
  });

  it("matriz Bridge comprovada cobre todos os rótulos de produto declarados", () => {
    for (const mercado of BRIDGEODDS_COVERAGE.soccer.productMarkets) {
      expect(bridgeOddsIsAuthoritative({
        esporte: "Soccer",
        mercado,
        selecao: mercado === "Double Chance" ? "Home or Draw" :
          mercado.startsWith("Total") ? "Over 2.5" :
            mercado.startsWith("Handicap") ? "Home -0.5" : "Home",
      }), `Soccer/${mercado}`).toBe(true);
    }
    for (const mercado of BRIDGEODDS_COVERAGE.basketball.productMarkets) {
      expect(bridgeOddsIsAuthoritative({
        esporte: "Basketball",
        mercado,
        selecao: mercado === "Total Points" ? "Over 210.5" :
          mercado.startsWith("Handicap") ? "Home -4.5" : "Home",
      }), `Basketball/${mercado}`).toBe(true);
    }
  });

  it("não amplia autoridade Bridge para período, estatística ou team total", () => {
    for (const params of [
      { esporte: "Soccer", mercado: "Money Line – 1st Half", selecao: "Home" },
      { esporte: "Soccer", mercado: "Total (Corners) – Match", selecao: "Over 9.5" },
      { esporte: "Soccer", mercado: "Team Total – Match", selecao: "Home Over 1.5" },
      { esporte: "Basketball", mercado: "Total Points", selecao: "Lakers Over 110.5" },
      { esporte: "Tennis", mercado: "Match Winner", selecao: "Fritz" },
    ]) {
      expect(bridgeOddsIsAuthoritative(params), `${params.esporte}/${params.mercado}`).toBe(false);
    }
  });

  it("game-line de tênis usa Pinnacle17", () => {
    expect(oddsProviders({ esporte: "Tennis", mercado: "Moneyline", selecao: "Fritz" })).toEqual([
      "pinnacle17",
    ]);
  });

  it("[SHP-001/SHP-004] normalização não apaga cobertura nem inventa rótulo final", () => {
    for (const esporte of [
      "Volleyball", "Rugby", "MMA", "Boxing", "Golf", "Darts", "Snooker",
      "Cricket", "Handball", "Futsal", "Table Tennis", "Beach Volleyball",
    ]) {
      const before = oddsProviders({ esporte, mercado: "Moneyline" });
      const mercado = pinnacleizeMercado("Moneyline", esporte);
      expect(before.length, esporte).toBeGreaterThan(0);
      expect(oddsProviders({ esporte, mercado }), esporte).toEqual(before);
      expect(isMercadoFinal(mercado), `${esporte}:${mercado}`).toBe(false);
    }
  });

  it("BTTS permanece sem referência de odds", () => {
    expect(oddsProviders({ esporte: "Soccer", mercado: "Both Teams to Score", selecao: "Sim" })).toEqual([]);
    expect(oddsProviders({ esporte: "Tennis", mercado: "Both Teams to Score", selecao: "Sim" })).toEqual([]);
  });

  it("props/scorer seguem sem provider de linha", () => {
    expect(oddsProviders({ esporte: "Soccer", mercado: "Anytime Goalscorer", selecao: "Vini Jr" })).toEqual([]);
    expect(oddsProviders({ esporte: "Basketball", mercado: "Total Steals", selecao: "Over 10.5" })).toEqual([]);
    expect(oddsProviders({ esporte: "Baseball", mercado: "Total Hits", selecao: "Over 7.5" })).toEqual([]);
  });

  it("props sem cobertura permanecem sem odds", () => {
    expect(oddsProviders({
      esporte: "Basketball",
      mercado: "LeBron James Points",
      selecao: "Over 22.5",
    })).toEqual([]);
    expect(oddsProviders({
      esporte: "Baseball",
      mercado: "Shohei Ohtani Strikeouts",
      selecao: "Under 6.5",
    })).toEqual([]);
    expect(oddsProviders({
      esporte: "Basketball",
      mercado: "Total Rebounds",
      selecao: "Over 45.5",
    })).toEqual([]);
    expect(oddsProviders({
      esporte: "Baseball",
      mercado: "Yankees Team Total Runs",
      selecao: "Yankees Over 4.5",
    })).toEqual(["pinnacle17",]);
  });

  it("remates de futebol têm identidade, mas nenhuma referência sharp", () => {
    for (const mercado of ["Total (Shots) – Match", "Team Total (Shots) – Match"]) {
      const params = { esporte: "Soccer", mercado, selecao: "Under 21.5" };
      expect(identityProviders(params)).toEqual(["pinnacle17", "bridgeodds",]);
      expect(oddsProviders(params)).toEqual([]);
      expect(marketHasNoSharpReference(params)).toBe(true);
    }
    expect(marketHasNoSharpReference({
      esporte: "Basketball",
      mercado: "Total (Shots) – Match",
    })).toBe(false);
  });

  it("escanteio fora do futebol não existe", () => {
    expect(
      providerCoversBet("pinnacle17", { esporte: "Basketball", mercado: "Corners O/U", selecao: "Over 8" }),
    ).toBe(false);
  });
});
