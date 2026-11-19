import { describe, expect, it } from "vitest";
import { hasScoreUnitMismatch } from "@/src/domain/mercados/stat-qualifier";
import { CANONICAL_MARKETS, normalizeMercadoKey, resolveMercadoStatic } from "@/src/domain/mercados/catalog";
import { coerceMercadoPelaSelecao } from "@/src/domain/mercados/coerce";
import { pinnacleizeMercado } from "@/src/domain/mercados/finalize";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { expandAbbreviatedDirection, looksLikeTotalSelection, totalDirectionOf } from "@/src/domain/mercados/total-direction";

describe("resolveMercadoStatic / pinnacleizeMercado", () => {
  it("traduz PT legado para o canônico Pinnacle", () => {
    expect(pinnacleizeMercado("Resultado Final")).toBe("Moneyline");
    expect(pinnacleizeMercado("Resultado Final", "Soccer")).toBe("Money Line – Match");
    expect(pinnacleizeMercado("Para Ganhar", "Basketball")).toBe("Money Line – Game");
    expect(pinnacleizeMercado("Mais/Menos")).toBe("Total");
    expect(pinnacleizeMercado("Empate Anula a Aposta")).toBe("Draw No Bet");
    expect(pinnacleizeMercado("Aposta Sem Empate")).toBe("Draw No Bet");
    expect(pinnacleizeMercado("Sem Empate")).toBe("Draw No Bet");
    expect(pinnacleizeMercado("Tie No Bet")).toBe("Draw No Bet");
    expect(pinnacleizeMercado("Chance Dupla")).toBe("Double Chance");
    expect(pinnacleizeMercado("Gol/Gol")).toBe("Both Teams to Score");
    expect(pinnacleizeMercado("Ambas Equipes Marcam")).toBe("Both Teams to Score");
    expect(pinnacleizeMercado("Both Score")).toBe("Both Teams to Score");
    expect(resolveMercadoStatic("Goal Line")).toBe("Total");
    expect(resolveMercadoStatic("1T Totais")).toBe("Total – 1st Half");
    expect(resolveMercadoStatic("1T - Totais")).toBe("Total – 1st Half");
    expect(pinnacleizeMercado("Goal Line", "Soccer")).toBe("Total – Match");
    expect(pinnacleizeMercado("Linha de Gols", "Soccer")).toBe("Total – Match");
    expect(pinnacleizeMercado("Asian Goal Line", "Soccer")).toBe("Total – Match");
    expect(resolveMercadoStatic("Asian Corners")).toBe("Total (Corners) – Match");
    expect(pinnacleizeMercado("Asian Corners", "Soccer")).toBe("Total (Corners) – Match");
    // Bet365 PT → canônico Asian Handicap → label Pinnacle Soccer.
    expect(resolveMercadoStatic("Handicap Asiatico")).toBe("Asian Handicap");
    expect(pinnacleizeMercado("Handicap Asiático", "Soccer")).toBe("Handicap – Match");
  });

  it("canônico passa intocado, insensível a caixa/acento", () => {
    expect(pinnacleizeMercado("Moneyline")).toBe("Moneyline");
    expect(resolveMercadoStatic("moneyline")).toBe("Moneyline");
    expect(resolveMercadoStatic("ASIAN HANDICAP")).toBe("Asian Handicap");
  });

  it("Total em basquete vira Total Points (Pinnacle distingue por esporte)", () => {
    expect(pinnacleizeMercado("Total – Partida", "Soccer")).toBe("Total – Match");
    expect(pinnacleizeMercado("Total – Partida", "Basketball")).toBe("Total Points");
    expect(pinnacleizeMercado("Total – Partida", "Tennis")).toBe("Total (Games) – Match");
    expect(pinnacleizeMercado("Mais/Menos", "Basketball")).toBe("Total Points");
    expect(pinnacleizeMercado("Total", "Basquete")).toBe("Total Points");
    expect(pinnacleizeMercado("Total", "Soccer")).toBe("Total – Match");
    expect(pinnacleizeMercado("Mais/Menos", "Soccer")).toBe("Total – Match");
  });

  it("traduz eSports player props, basquete player props e goalscorers", () => {
    expect(resolveMercadoStatic("deaths")).toBe("Player Props");
    expect(resolveMercadoStatic("kills")).toBe("Player Props");
    expect(resolveMercadoStatic("abates")).toBe("Player Props");
    expect(resolveMercadoStatic("mortes")).toBe("Player Props");
    expect(resolveMercadoStatic("deaths HT")).toBe("Player Props");
    expect(pinnacleizeMercado("deaths HT", "eSports")).toBe("Player Props");

    expect(resolveMercadoStatic("P + A + R")).toBe("Player Points/Rebounds/Assists");
    expect(resolveMercadoStatic("pra")).toBe("Player Points/Rebounds/Assists");
    // Uma estatística só: "pontos" no PRA somaria rebotes e assistências na liquidação.
    expect(resolveMercadoStatic("pontos")).toBe("Player Points");
    expect(resolveMercadoStatic("rebotes")).toBe("Player Rebounds");
    expect(pinnacleizeMercado("Pontos", "Basketball")).toBe("Player Points");
    expect(pinnacleizeMercado("P + A + R", "Basketball")).toBe("Player Points/Rebounds/Assists");

    expect(resolveMercadoStatic("anytime")).toBe("Anytime Goalscorer");
    expect(resolveMercadoStatic("anytime goalscorer")).toBe("Anytime Goalscorer");
    expect(resolveMercadoStatic("marcar a qualquer momento")).toBe("Anytime Goalscorer");
    expect(resolveMercadoStatic("any 1° gol")).toBe("First Goalscorer");
    expect(pinnacleizeMercado("any 1° gol", "Soccer")).toBe("First Goalscorer");

    expect(resolveMercadoStatic("Shots")).toBe("Shots");
    expect(resolveMercadoStatic("chutes")).toBe("Shots");
    expect(resolveMercadoStatic("chutes do jogador")).toBe("Shots");
    expect(pinnacleizeMercado("chutes", "Soccer")).toBe("Shots");

    expect(resolveMercadoStatic("Shots On Target")).toBe("Shots On Target");
    expect(resolveMercadoStatic("chutes ao gol")).toBe("Shots On Target");
    expect(resolveMercadoStatic("chutes no gol")).toBe("Shots On Target");
    expect(pinnacleizeMercado("chutes ao gol", "Soccer")).toBe("Shots On Target");

    expect(resolveMercadoStatic("Player Assists")).toBe("Player Assists");
    expect(resolveMercadoStatic("ASS")).toBe("Player Assists");
    expect(resolveMercadoStatic("assistência")).toBe("Player Assists");
    expect(resolveMercadoStatic("assistencias")).toBe("Player Assists");
    expect(pinnacleizeMercado("assistência", "Soccer")).toBe("Player Assists");

    expect(resolveMercadoStatic("To Score 2+ Goals")).toBe("To Score 2+ Goals");
    expect(resolveMercadoStatic("2+ gols")).toBe("To Score 2+ Goals");
    expect(resolveMercadoStatic("marcar 2+ gols")).toBe("To Score 2+ Goals");
    expect(pinnacleizeMercado("2+ gols", "Soccer")).toBe("To Score 2+ Goals");
  });

  it("desconhecido devolve como veio (visível para alias novo)", () => {
    expect(pinnacleizeMercado("Mercado Inventado XYZ")).toBe("Mercado Inventado XYZ");
  });

  it("catálogo tem chaves normalizadas únicas (23 de entrada + 18 finais sport-aware)", () => {
    expect(CANONICAL_MARKETS.length).toBeGreaterThanOrEqual(40);
    const keys = CANONICAL_MARKETS.map(normalizeMercadoKey);
    expect(new Set(keys).size).toBe(CANONICAL_MARKETS.length);
  });
});

describe("pinnacleizeSelecao", () => {
  it("limpa sufixos de mercado da seleção em props de jogador (Anytime, ASS, etc.)", () => {
    expect(
      pinnacleizeSelecao({
        selecao: "Diego Tarzia Anytime",
        mercadoPinnacle: "Anytime Goalscorer",
        evento: "Vitoria vs Vasco da Gama",
      }),
    ).toBe("Diego Tarzia");

    expect(
      pinnacleizeSelecao({
        selecao: "Giancomo Calo ASS",
        mercadoPinnacle: "Player Assists",
        evento: "Sassuolo vs Frosinone",
      }),
    ).toBe("Giancomo Calo");

    expect(
      pinnacleizeSelecao({
        selecao: "John Yeboah ASS",
        mercadoPinnacle: "Player Assists",
        evento: "Udinese vs Venezia",
      }),
    ).toBe("John Yeboah");

    expect(
      pinnacleizeSelecao({
        selecao: "Mohamed Toure Anytime",
        mercadoPinnacle: "Anytime Goalscorer",
        evento: "Stoke vs Norwich",
      }),
    ).toBe("Mohamed Toure");

    expect(
      pinnacleizeSelecao({
        selecao: "Erling Haaland - Marcar a qualquer momento",
        mercadoPinnacle: "Anytime Goalscorer",
        evento: "Man City vs Arsenal",
      }),
    ).toBe("Erling Haaland");
  });

  it("linha é o primeiro número; token de período/estatística não entra na média", () => {
    const total = { mercadoPinnacle: "Total - Match", evento };
    // Varrer TODOS os números do resto e tirar média corrompe a linha: estes
    // dois dariam "Over 5.25" e "Over 1.75".
    expect(pinnacleizeSelecao({ selecao: "Over 9.5 corners 1st half", ...total })).toBe("Over 9.5 corners 1st half");
    expect(pinnacleizeSelecao({ selecao: "Over 2.5 - 1st Half", ...total })).toBe("Over 2.5 - 1st Half");
    expect(pinnacleizeSelecao({ selecao: "Mais de 2 gols no 1o tempo", ...total })).toBe("Mais de 2 gols no 1o tempo");
    // Split line da Bet365 (números colados por vírgula) CONTINUA virando média.
    expect(pinnacleizeSelecao({ selecao: "Mais de 2.0,2.5", ...total })).toBe("Over 2.25");
    expect(pinnacleizeSelecao({ selecao: "Menos de 2,0/2,5", ...total })).toBe("Under 2.25");
    expect(pinnacleizeSelecao({ selecao: "Mais de 2.0-2.5", ...total })).toBe("Over 2.25");
    expect(pinnacleizeSelecao({ selecao: "Mais de 1.5-2.0", ...total })).toBe("Over 1.75");
    expect(pinnacleizeSelecao({ selecao: "Abaixo de 2.5-3.0", ...total })).toBe("Under 2.75");
    expect(pinnacleizeSelecao({ selecao: "under 3,5 carteos", ...total })).toBe("under 3,5 carteos");
    expect(pinnacleizeSelecao({ selecao: "under 2.5 carteos", ...total })).toBe("under 2.5 carteos");
    expect(pinnacleizeSelecao({ selecao: "over 5,5 carteos", ...total })).toBe("over 5,5 carteos");
  });

  const evento = "Coquimbo Unido vs Colo Colo";

  it("Casa/Fora viram o nome real do time; Empate vira Draw", () => {
    expect(
      pinnacleizeSelecao({ selecao: "Casa", mercadoPinnacle: "Moneyline", evento }),
    ).toBe("Coquimbo Unido");
    expect(
      pinnacleizeSelecao({ selecao: "Fora", mercadoPinnacle: "Moneyline", evento }),
    ).toBe("Colo Colo");
    expect(
      pinnacleizeSelecao({ selecao: "Empate", mercadoPinnacle: "Moneyline", evento }),
    ).toBe("Draw");
  });

  it("Sim/Não viram Yes/No no BTTS", () => {
    expect(
      pinnacleizeSelecao({
        selecao: "Sim",
        mercadoPinnacle: "Both Teams to Score",
        evento,
      }),
    ).toBe("Yes");
    expect(
      pinnacleizeSelecao({
        selecao: "Não",
        mercadoPinnacle: "Both Teams to Score",
        evento,
      }),
    ).toBe("No");
  });

  it("canonicaliza rótulos completos e períodos de BTTS", () => {
    for (const selecao of ["Ambas Marcam Sim", "Ambos Marcam - Sim"]) {
      expect(pinnacleizeSelecao({
        selecao,
        mercadoPinnacle: "Both Teams to Score",
        evento,
      })).toBe("Yes");
    }
    expect(pinnacleizeSelecao({
      selecao: "Ambas Marcam Não",
      mercadoPinnacle: "Both Teams to Score",
      evento,
    })).toBe("No");
    expect(pinnacleizeSelecao({
      selecao: "Sim",
      mercadoPinnacle: "Both Teams to Score - 1st Half",
      evento,
    })).toBe("Yes");
  });

  it("o 'no' preposição não nega o BTTS; no fim ou antes do negado, nega", () => {
    const btts = (selecao: string) => pinnacleizeSelecao({ selecao, mercadoPinnacle: "Both Teams to Score", evento });
    for (const selecao of [
      "Ambas marcam no jogo", "Ambos marcam no confronto", "Ambas as equipes marcam no jogo", "Sim, ambas marcam no jogo",
      "Ambas marcam", "GG",
      // Outras flexões do verbo e o "no" antes do nome do jogo.
      "Ambas as equipes marcarão no jogo", "Ambos os times marcarão no jogo", "Gol/Gol no jogo",
    ]) {
      expect(btts(selecao), selecao).toBe("Yes");
    }
    for (const selecao of [
      "BTTS no", "Ambas NO", "No BTTS", "Ambas marcam - Não", "Both teams to score - No", "NG",
      // Fora do "marcam no ..." e do "no jogo", o "no" com qualificador depois continua o Não.
      "BTTS No FT", "Both Teams to Score - No (FT)", "Ambas Marcam - No (FT)", "Ambas marcam no", "BTTS - No (1.85)",
      "BTTS No Match", "Ambas marcam: não no jogo",
    ]) {
      expect(btts(selecao), selecao).toBe("No");
    }
    // Sobra que a frase não conhece ("gol", "dos dois") ou "no" antes do tempo por extenso não decide.
    for (const selecao of ["Ambas marcam gol no jogo", "Ambas marcam gols no jogo", "Gol dos dois no jogo", "Gol/Gol no 1º tempo", "BTTS No 1º Tempo"]) {
      expect(btts(selecao), selecao).toBe(selecao);
    }
    const bttsFirstHalf = (selecao: string) =>
      pinnacleizeSelecao({ selecao, mercadoPinnacle: "Both Teams to Score – 1st Half", evento });
    // O tempo pela sigla também: "Gol/Gol no 1T" é o Sim, e "BTTS No 1T" pode ser o Não.
    for (const selecao of [
      "Gol/Gol no 1T", "Gol/Gol no 1ºT", "Gol/Gol no HT", "Gol/Gol no 2T", "BTTS no 1T", "BTTS no 2ºT", "Ambas no 1T",
      "Gol dos dois no 1T", "BTTS No 1T", "Gol/Gol no 1st half", "BTTS no H1", "Gol/Gol no 2° T",
    ]) {
      expect(bttsFirstHalf(selecao), selecao).toBe(selecao);
    }
    // Com pontuação entre o "No" e o tempo, ou o Não escrito, continua o Não.
    for (const selecao of ["BTTS - No - 1T", "BTTS No (1T)", "BTTS No - HT", "BTTS - No - 1º Tempo", "Ambas marcam: Não", "Ambas marcam: não no 1T"]) {
      expect(bttsFirstHalf(selecao), selecao).toBe("No");
    }
    expect(bttsFirstHalf("Ambas marcam no 1º tempo")).toBe("Yes");
    expect(bttsFirstHalf("Ambas marcam no 1ºT")).toBe("Yes");
    // Sim com negação, ou ambas marcam combinado com outra perna, não decide.
    for (const selecao of ["Sim e Não", "Ambas marcam e Over 2.5"]) {
      expect(btts(selecao), selecao).toBe(selecao);
    }
  });

  it("ambas marcam em cada tempo é outro mercado e fica como veio", () => {
    const btts = (selecao: string) => pinnacleizeSelecao({ selecao, mercadoPinnacle: "Both Teams to Score", evento });
    for (const selecao of [
      "Ambas marcam nos dois tempos", "Ambas marcam em ambos os tempos", "Both teams to score in both halves",
      "Ambas marcam em cada tempo", "Ambas marcam nos dois tempos - Sim", "Nos 2 tempos - Não",
      // O 1º e o 2º tempo nomeados juntos.
      "Ambas marcam no 1º e no 2º tempo", "Ambas marcam no primeiro e no segundo tempo", "Ambas marcam no 1T e no 2T",
      "Ambas marcam 1ºT e 2ºT", "Both teams to score 1st and 2nd half",
    ]) {
      expect(btts(selecao), selecao).toBe(selecao);
    }
    const bttsSecondHalf = (selecao: string) =>
      pinnacleizeSelecao({ selecao, mercadoPinnacle: "Both Teams to Score – 2nd Half", evento });
    expect(bttsSecondHalf("Ambas marcam no 1º e no 2º tempo")).toBe("Ambas marcam no 1º e no 2º tempo");
    // A frase só vira Sim com o escopo ou um tempo só; outra sobra não decide.
    expect(btts("Ambas marcam - Jogo")).toBe("Yes");
    expect(btts("Ambas marcam (tempo extra)")).toBe("Ambas marcam (tempo extra)");
  });

  it("canonicaliza Dupla Chance para os nomes reais dos times", () => {
    expect(pinnacleizeSelecao({
      selecao: "Casa ou Empate",
      mercadoPinnacle: "Double Chance",
      evento,
    })).toBe("Coquimbo Unido or Draw");
    expect(pinnacleizeSelecao({
      selecao: "Empate ou Visitante",
      mercadoPinnacle: "Double Chance",
      evento,
    })).toBe("Draw or Colo Colo");
    expect(pinnacleizeSelecao({
      selecao: "Casa ou Fora",
      mercadoPinnacle: "Double Chance",
      evento,
    })).toBe("Coquimbo Unido or Colo Colo");
    expect(pinnacleizeSelecao({
      selecao: "1X (Dupla Chance)",
      mercadoPinnacle: "Double Chance",
      evento,
    })).toBe("Coquimbo Unido or Draw");
    expect(pinnacleizeSelecao({
      selecao: "X/2 (Chance Dupla)",
      mercadoPinnacle: "Double Chance",
      evento,
    })).toBe("Draw or Colo Colo");
  });

  it("remove rótulo e normaliza separador de placar exato", () => {
    for (const selecao of ["Placar Exato 2-1", "2x1", "Resultado exato 02:01"]) {
      expect(pinnacleizeSelecao({
        selecao,
        mercadoPinnacle: "Correct Score",
        evento,
      }), selecao).toBe("2-1");
    }
  });

  it("'Mais de 2,5' vira 'Over 2.5'; split Bet365 vira média Pinnacle", () => {
    expect(
      pinnacleizeSelecao({ selecao: "Mais de 2,5", mercadoPinnacle: "Total", evento }),
    ).toBe("Over 2.5");
    expect(
      pinnacleizeSelecao({
        selecao: "Menos de 2.0, 2.5",
        mercadoPinnacle: "Total",
        evento,
      }),
    ).toBe("Under 2.25");
    expect(
      pinnacleizeSelecao({
        selecao: "Mais de 2.0,2.5",
        mercadoPinnacle: "Total – Match",
        evento,
      }),
    ).toBe("Over 2.25");
    expect(
      pinnacleizeSelecao({ selecao: "Acima de 2.5", mercadoPinnacle: "Total", evento }),
    ).toBe("Over 2.5");
    expect(
      pinnacleizeSelecao({ selecao: "Abaixo de 3.5", mercadoPinnacle: "Total", evento }),
    ).toBe("Under 3.5");
  });

  it("Bet365 'Gols + -' reconhece como Total – Match (Soccer)", () => {
    expect(resolveMercadoStatic("Gols + -")).toBe("Total");
    expect(pinnacleizeMercado("Gols + -", "Soccer")).toBe("Total – Match");
    expect(pinnacleizeMercado("Gols +/-", "Soccer")).toBe("Total – Match");
  });

  it("não apresenta Handicap Europeu como mercado oficial Pinnacle", () => {
    expect(resolveMercadoStatic("Handicap Europeu")).toBeNull();
    expect(resolveMercadoStatic("Asian Handicap")).toBe("Asian Handicap");
  });

  it("nome de time com código U/O+dígito em mercado de lado NÃO vira total", () => {
    // "U21 Spain"/"U23 Sporting" em Moneyline/Match Winner não viram "Under 21/23".
    expect(
      pinnacleizeSelecao({ selecao: "U21 Spain", mercadoPinnacle: "Moneyline", evento: "France vs U21 Spain" }),
    ).toBe("U21 Spain");
    expect(
      pinnacleizeSelecao({ selecao: "U23 Sporting", mercadoPinnacle: "Match Winner", evento: "Benfica vs U23 Sporting" }),
    ).toBe("U23 Sporting");
    // Total legítimo segue convertendo (não é mercado de lado).
    expect(pinnacleizeSelecao({ selecao: "U 21", mercadoPinnacle: "Total", evento })).toBe("Under 21.0");
  });

  it("no total do time com categoria (U20/U21/U23), a linha é a do fim, não a da categoria", () => {
    const teamTotal = (selecao: string, evento: string) =>
      pinnacleizeSelecao({ selecao, mercadoPinnacle: "Team Total – Match", evento });
    expect(teamTotal("Palmeiras U20 U 1.5", "Flamengo U20 x Palmeiras U20")).toBe("Palmeiras U20 Under 1.5");
    expect(teamTotal("Flamengo U20 O 2.5", "Flamengo U20 x Palmeiras U20")).toBe("Flamengo U20 Over 2.5");
    expect(teamTotal("U21 Spain U 2.5", "U21 Spain x U21 France")).toBe("U21 Spain Under 2.5");
    expect(teamTotal("Sporting U23 U 1.5", "Benfica B x Sporting U23")).toBe("Sporting U23 Under 1.5");
    // No total do jogo a seleção que nomeia o time fica crua, sem inventar a linha 21.
    expect(pinnacleizeSelecao({ selecao: "U21 Spain U 2.5", mercadoPinnacle: "Total – Match", evento: "U21 Spain x U21 France" }))
      .toBe("U21 Spain U 2.5");
  });

  it("padroniza total inteiro e total de equipe com prefixo nominal", () => {
    expect(
      pinnacleizeSelecao({ selecao: "Mais de 2.0", mercadoPinnacle: "Total – Match", evento }),
    ).toBe("Over 2.0");
    expect(
      pinnacleizeSelecao({ selecao: "Coquimbo Unido Mais de 1.5", mercadoPinnacle: "Team Total", evento }),
    ).toBe("Coquimbo Unido Over 1.5");
    expect(
      pinnacleizeSelecao({ selecao: "Colo Colo Abaixo de 0.5", mercadoPinnacle: "Team Total", evento }),
    ).toBe("Colo Colo Under 0.5");
    expect(
      pinnacleizeSelecao({ selecao: "Coquimbo Unido O 1.5", mercadoPinnacle: "Team Total – Match", evento }),
    ).toBe("Coquimbo Unido Over 1.5");
    expect(
      pinnacleizeSelecao({ selecao: "Colo Colo U 0,5", mercadoPinnacle: "Team Total – Match", evento }),
    ).toBe("Colo Colo Under 0.5");
  });

  it("DNB permanece identificável até a captura convertê-lo em handicap zero", () => {
    const mercado = pinnacleizeMercado("Empate Anula a Aposta");
    expect(mercado).toBe("Draw No Bet");
    expect(pinnacleizeSelecao({ selecao: "Casa", mercadoPinnacle: mercado, evento })).toBe("Coquimbo Unido");
    expect(pinnacleizeSelecao({
      selecao: "Coquimbo Unido DNB",
      mercadoPinnacle: "Draw No Bet",
      evento,
    })).toBe("Coquimbo Unido");
    expect(pinnacleizeSelecao({
      selecao: "Coquimbo Unido (Empate Anula)",
      mercadoPinnacle: "Draw No Bet",
      evento,
    })).toBe("Coquimbo Unido");
    expect(pinnacleizeSelecao({
      selecao: "Empate cancela - 1",
      mercadoPinnacle: "Draw No Bet",
      evento,
    })).toBe("Coquimbo Unido");
    expect(pinnacleizeSelecao({
      selecao: "2 (Empate nulo)",
      mercadoPinnacle: "Draw No Bet",
      evento,
    })).toBe("Colo Colo");
  });

  it("padroniza vírgula decimal de handicap sem corromper split com ponto", () => {
    expect(pinnacleizeSelecao({
      selecao: "Coquimbo Unido -0,25",
      mercadoPinnacle: "Asian Handicap",
      evento,
    })).toBe("Coquimbo Unido -0.25");
    expect(pinnacleizeSelecao({
      selecao: "Coquimbo Unido 0.0,0.5",
      mercadoPinnacle: "Asian Handicap",
      evento,
    })).toBe("Coquimbo Unido 0.0,0.5");
  });

  it("resolve lados genéricos em handicap asiático e europeu", () => {
    expect(pinnacleizeSelecao({
      selecao: "Time 1 -0.5",
      mercadoPinnacle: "Spread – Match",
      evento,
    })).toBe("Coquimbo Unido -0.5");
    expect(pinnacleizeSelecao({
      selecao: "Equipe 2 +0,5",
      mercadoPinnacle: "Asian Handicap",
      evento,
    })).toBe("Colo Colo +0.5");
    expect(pinnacleizeSelecao({
      selecao: "Casa -1",
      mercadoPinnacle: "European Handicap",
      evento,
    })).toBe("Coquimbo Unido -1");
    expect(pinnacleizeSelecao({
      selecao: "Visitante +1",
      mercadoPinnacle: "Handicap Europeu",
      evento,
    })).toBe("Colo Colo +1");
  });

  it("resolve lados genéricos em Moneyline, DNB e Dupla Chance", () => {
    expect(pinnacleizeSelecao({
      selecao: "Time 1",
      mercadoPinnacle: "Moneyline",
      evento,
    })).toBe("Coquimbo Unido");
    expect(pinnacleizeSelecao({
      selecao: "Equipe 2 - DNB",
      mercadoPinnacle: "Draw No Bet",
      evento,
    })).toBe("Colo Colo");
    expect(pinnacleizeSelecao({
      selecao: "Time 1 ou Empate",
      mercadoPinnacle: "Double Chance",
      evento,
    })).toBe("Coquimbo Unido or Draw");
    expect(pinnacleizeSelecao({
      selecao: "Empate ou Equipe 2",
      mercadoPinnacle: "Double Chance",
      evento,
    })).toBe("Draw or Colo Colo");
    expect(pinnacleizeSelecao({
      selecao: "Primeiro Time",
      mercadoPinnacle: "Moneyline",
      evento,
    })).toBe("Coquimbo Unido");
    expect(pinnacleizeSelecao({
      selecao: "First Team",
      mercadoPinnacle: "Moneyline",
      evento,
    })).toBe("Coquimbo Unido");
    expect(pinnacleizeSelecao({
      selecao: "Second Team -0.5",
      mercadoPinnacle: "Asian Handicap",
      evento,
    })).toBe("Colo Colo -0.5");
  });

  it("resolve prefixos genéricos em totais por equipe", () => {
    for (const selection of [
      "Time da Casa Over 1.5",
      "Home Over 1.5",
      "Home Team Over 1.5",
      "Mandante Over 1.5",
      "Time 1 Over 1.5",
      "Clube 1 Over 1.5",
      "Primeira Equipe Over 1.5",
      "Local Team Over 1.5",
    ]) {
      expect(pinnacleizeSelecao({
        selecao: selection,
        mercadoPinnacle: "Team Total Goals",
        evento,
      }), selection).toBe("Coquimbo Unido Over 1.5");
    }
    for (const selection of [
      "Time Visitante Under 2.5",
      "Away Team Under 2.5",
      "Visitante Under 2.5",
      "Equipe 2 Under 2.5",
      "Club 2 Under 2.5",
      "Segunda Equipe Under 2.5",
      "Visitor Team Under 2.5",
      "Visiting Team Under 2.5",
    ]) {
      expect(pinnacleizeSelecao({
        selecao: selection,
        mercadoPinnacle: "Team Total Goals",
        evento,
      }), selection).toBe("Colo Colo Under 2.5");
    }
  });

  it("remove rótulo de mercado e sinal positivo redundante em totais", () => {
    for (const selection of [
      "Total de Gols - Over 2.5",
      "Gols: Over 2.5",
      "Over +2.5",
      "Mais de +2.5",
    ]) {
      expect(pinnacleizeSelecao({
        selecao: selection,
        mercadoPinnacle: "Total Goals",
        evento,
      }), selection).toBe("Over 2.5");
    }
  });

  it("canonicaliza os rótulos de Moneyline já aceitos pelo resolvedor", () => {
    expect(pinnacleizeSelecao({
      selecao: "Resultado da Partida: 1",
      mercadoPinnacle: "Moneyline",
      evento,
    })).toBe("Coquimbo Unido");
    expect(pinnacleizeSelecao({
      selecao: "Vencedor do Confronto: 1",
      mercadoPinnacle: "Moneyline",
      evento,
    })).toBe("Coquimbo Unido");
    expect(pinnacleizeSelecao({
      selecao: "Vencedor do Encontro: 2",
      mercadoPinnacle: "Moneyline",
      evento,
    })).toBe("Colo Colo");
  });
});

describe("totalDirectionOf", () => {
  it("reconhece comparativos PT com de ou que", () => {
    expect(totalDirectionOf("Mais que 2.5")).toBe("over");
    expect(totalDirectionOf("Menos que 2.5")).toBe("under");
    expect(totalDirectionOf("Acima de 3.5")).toBe("over");
    expect(totalDirectionOf("Abaixo de 3.5")).toBe("under");
    expect(totalDirectionOf("Mais de + 2.5")).toBe("over");
    expect(totalDirectionOf("Menos de + 3,5")).toBe("under");
    expect(totalDirectionOf("Menos de - 2.5")).toBe("under");
    // O parêntese é só o rótulo da família; sem linha depois de "Under" não
    // cria uma segunda direção nem conflito.
    expect(totalDirectionOf("Mais de 2.5 (Over/Under)")).toBe("over");
    expect(totalDirectionOf("Menos de 2.5 (Over/Under)")).toBe("under");
  });

  it("aceita direção isolada quando a linha está no mercado", () => {
    for (const selection of ["Over", "Acima", "Mais"]) {
      expect(totalDirectionOf(selection), selection).toBe("over");
    }
    for (const selection of ["Under", "Abaixo", "Menos"]) {
      expect(totalDirectionOf(selection), selection).toBe("under");
    }
    expect(totalDirectionOf("Overland")).toBeNull();
  });

  it("reconhece abreviações com unidade/período sem confundir categoria de time", () => {
    expect(totalDirectionOf("O 2.5 Cantos")).toBe("over");
    expect(totalDirectionOf("U 4.5 Cartões")).toBe("under");
    expect(totalDirectionOf("OV 2.5 (1º Tempo)")).toBe("over");
    expect(totalDirectionOf("U23 Spain")).toBeNull();
  });

  it("reconhece O/U abreviado com o time na frente (Wolves O.1,5 cards)", () => {
    expect(totalDirectionOf("Wolves O.1,5 cards")).toBe("over");
    expect(totalDirectionOf("Wolves O.1,5")).toBe("over");
    expect(totalDirectionOf("Cadiz U 2.5 cards")).toBe("under");
    expect(totalDirectionOf("Sporting U23")).toBeNull();
    expect(totalDirectionOf("Mogi ML H5 FT + Mogi O89,5")).toBeNull();
  });
});

describe("expandAbbreviatedDirection", () => {
  it("troca só a sigla da direção e mantém time, unidade e período", () => {
    expect(expandAbbreviatedDirection("Mogi O89,5")).toBe("Mogi Over 89,5");
    expect(expandAbbreviatedDirection("Flamengo U 1.5")).toBe("Flamengo Under 1.5");
    expect(expandAbbreviatedDirection("Wolves O.1,5 cards")).toBe("Wolves Over 1,5 cards");
    expect(expandAbbreviatedDirection("o2.5")).toBe("Over 2.5");
    expect(expandAbbreviatedDirection("OV 2.5 (1º Tempo)")).toBe("Over 2.5 (1º Tempo)");
    expect(expandAbbreviatedDirection("O'Higgins O 1.5")).toBe("O'Higgins Over 1.5");
  });

  it("com a categoria do time (U20/U21/U23), troca a sigla da linha, não a do nome", () => {
    expect(expandAbbreviatedDirection("Palmeiras U20 U 1.5")).toBe("Palmeiras U20 Under 1.5");
    expect(expandAbbreviatedDirection("Palmeiras U20 U1.5")).toBe("Palmeiras U20 Under 1.5");
    expect(expandAbbreviatedDirection("Sporting U23 U 1.5")).toBe("Sporting U23 Under 1.5");
    expect(expandAbbreviatedDirection("U21 Spain U 2.5")).toBe("U21 Spain Under 2.5");
    expect(expandAbbreviatedDirection("Brasil U21 U 0.5 (1º tempo)")).toBe("Brasil U21 Under 0.5 (1º tempo)");
    expect(expandAbbreviatedDirection("Flamengo U20 O 2.5 gols")).toBe("Flamengo U20 Over 2.5 gols");
  });

  it("não mexe em nome de time nem em seleção por extenso", () => {
    for (const selection of ["Sporting U23", "U21 Spain", "Over 0.5 1T", "Flamengo", "Mais de 2.5"]) {
      expect(expandAbbreviatedDirection(selection), selection).toBe(selection);
    }
  });
});

describe("coerceMercadoPelaSelecao (coerência mercado×seleção)", () => {
  it("seleção O/U abreviada com mercado Moneyline vira Total", () => {
    expect(coerceMercadoPelaSelecao("Moneyline", "U 4.5", "Soccer")).toBe("Total – Match");
    expect(coerceMercadoPelaSelecao("Moneyline", "U 2.25", "Soccer")).toBe("Total – Match");
    expect(coerceMercadoPelaSelecao("Moneyline", "O 1.5", "Soccer")).toBe("Total – Match");
    expect(coerceMercadoPelaSelecao("Moneyline", "u2.5", "Soccer")).toBe("Total – Match");
  });

  it("time + O/U de cartões não fica Moneyline", () => {
    expect(coerceMercadoPelaSelecao("Moneyline", "Wolves O.1,5 cards", "Soccer")).toBe(
      "Total (Bookings) – Match",
    );
  });

  it("palavras over/under/mais/menos com linha também coagem", () => {
    expect(coerceMercadoPelaSelecao("Moneyline", "Under 4.5 gols", "Soccer")).toBe("Total – Match");
    expect(coerceMercadoPelaSelecao("Moneyline", "mais de 2.5", "Soccer")).toBe("Total – Match");
    expect(coerceMercadoPelaSelecao("Moneyline", "Acima de 2.5", "Soccer")).toBe("Total – Match");
    expect(coerceMercadoPelaSelecao("Moneyline", "Abaixo 3.5", "Soccer")).toBe("Total – Match");
  });

  it("mercado desconhecido Bet365 'Gols + -' com seleção O/U vira Total – Match", () => {
    expect(coerceMercadoPelaSelecao("Gols + -", "Mais de 2.0,2.5", "Soccer")).toBe("Total – Match");
    expect(coerceMercadoPelaSelecao("XYZ Inventado", "Over 2.5", "Soccer")).toBe("Total – Match");
  });

  it("finaliza por esporte (basquete → Total Points)", () => {
    expect(coerceMercadoPelaSelecao("Moneyline", "O 215.5", "Basketball")).toBe("Total Points");
  });

  it("time de base NÃO é total: 'Sporting U23' segue Moneyline", () => {
    expect(coerceMercadoPelaSelecao("Moneyline", "Sporting U23", "Soccer")).toBe("Moneyline");
  });

  it("não mexe em mercado que não é Moneyline/other nem em seleção sem cara de O/U", () => {
    expect(coerceMercadoPelaSelecao("Total", "Under 2.5", "Soccer")).toBe("Total");
    expect(coerceMercadoPelaSelecao("Handicap – Match", "Casa -0.5", "Soccer")).toBe(
      "Handicap – Match",
    );
    expect(coerceMercadoPelaSelecao("Moneyline", "Coquimbo Unido", "Soccer")).toBe("Moneyline");
    expect(coerceMercadoPelaSelecao("Moneyline", "Draw", "Soccer")).toBe("Moneyline");
  });

  it("coage seleção nominal com linha assinada ou decimal para handicap sem aceitar linha nua", () => {
    expect(coerceMercadoPelaSelecao("Moneyline", "Flamengo -0.5", "Soccer")).toBe(
      "Handicap – Match",
    );
    expect(coerceMercadoPelaSelecao("Moneyline", "Bauru Basket SP -18.5", "Basketball")).toBe(
      "Handicap – Game",
    );
    expect(coerceMercadoPelaSelecao("Outros", "Palmeiras +1.25", "Soccer")).toBe(
      "Handicap – Match",
    );
    expect(coerceMercadoPelaSelecao("Outros", "Flamengo 0.5", "Soccer")).toBe(
      "Handicap – Match",
    );
    expect(coerceMercadoPelaSelecao("Outros", "Flamengo 0.0,0.5", "Soccer")).toBe(
      "Handicap – Match",
    );
    expect(coerceMercadoPelaSelecao("Outros", "+2.5", "Soccer")).toBe("Outros");
    expect(coerceMercadoPelaSelecao("Outros", "Racing 01", "Soccer")).toBe("Outros");
  });

  it("unidade na seleção promove Total/Moneyline já finalizados para o rótulo Pinnacle", () => {
    expect(coerceMercadoPelaSelecao("Total – Match", "Over 8.5 asian corners", "Soccer")).toBe(
      "Total (Corners) – Match",
    );
    expect(coerceMercadoPelaSelecao("Asian Corners", "Over 9.5", "Soccer")).toBe(
      "Total (Corners) – Match",
    );
    expect(coerceMercadoPelaSelecao("Asian Corners", "Over 4.5 1st half", "Soccer")).toBe(
      "Total (Corners) – 1st Half",
    );
    expect(coerceMercadoPelaSelecao("Total", "Over 8.5 escanteios", "Soccer")).toBe(
      "Total (Corners) – Match",
    );
    expect(coerceMercadoPelaSelecao("Moneyline", "Under 5.5 cards", "Soccer")).toBe(
      "Total (Bookings) – Match",
    );
    expect(coerceMercadoPelaSelecao("Total – Match", "Over 4.5 corners 1st half", "Soccer")).toBe(
      "Total (Corners) – 1st Half",
    );
    expect(coerceMercadoPelaSelecao("Moneyline", "Ambas 2+ cartões", "Soccer")).toBe(
      "Both Teams Cards – Match",
    );
    expect(coerceMercadoPelaSelecao("Total – Match", "Under 2.5", "Soccer")).toBe("Total – Match");
    expect(coerceMercadoPelaSelecao("Cartões Amarelos", "Over 1.5", "Soccer")).toBe(
      "Cartões Amarelos",
    );
    expect(coerceMercadoPelaSelecao("Asian Handicap", "Coquimbo Unido +3.5 A Cantos", "Soccer")).toBe(
      "Handicap (Corners) – Match",
    );
    expect(coerceMercadoPelaSelecao("Asian Handicap", "Olimpia Asuncion +3 Cantos", "Soccer")).toBe(
      "Handicap (Corners) – Match",
    );
    expect(coerceMercadoPelaSelecao("Corners", "Over 8 Cantos", "Soccer")).toBe(
      "Total (Corners) – Match",
    );
    expect(coerceMercadoPelaSelecao("Corners", "Under 9 Cantos", "Soccer")).toBe(
      "Total (Corners) – Match",
    );
    expect(coerceMercadoPelaSelecao("Total", "under 3,5 carteos", "Soccer")).toBe(
      "Total (Bookings) – Match",
    );
    expect(coerceMercadoPelaSelecao("Total", "under 2.5 carteos", "Soccer")).toBe(
      "Total (Bookings) – Match",
    );
    expect(coerceMercadoPelaSelecao("Total", "over 5,5 carteos", "Soccer")).toBe(
      "Total (Bookings) – Match",
    );
  });

  it("looksLikeTotalSelection reconhece abreviações e palavras, e rejeita nomes", () => {
    expect(looksLikeTotalSelection("U 4.5")).toBe(true);
    expect(looksLikeTotalSelection("Over 2.5")).toBe(true);
    expect(looksLikeTotalSelection("Acima de 2.5")).toBe(true);
    expect(looksLikeTotalSelection("+2.5 gols")).toBe(true);
    expect(looksLikeTotalSelection("Boca Juniors")).toBe(false);
    expect(looksLikeTotalSelection("Sporting U23")).toBe(false);
  });
});

describe("pinnacleizeSelecao — abreviações de total", () => {
  const evento = "Coquimbo Unido vs Colo Colo";
  it("U./O com linha viram Under/Over canônicos", () => {
    expect(pinnacleizeSelecao({ selecao: "U. 4.5", mercadoPinnacle: "Total", evento })).toBe("Under 4.5");
    expect(pinnacleizeSelecao({ selecao: "U 2.25", mercadoPinnacle: "Total", evento })).toBe("Under 2.25");
    expect(pinnacleizeSelecao({ selecao: "o2,5", mercadoPinnacle: "Total", evento })).toBe("Over 2.5");
    expect(pinnacleizeSelecao({ selecao: "Ov 215.5", mercadoPinnacle: "Total Points", evento })).toBe("Over 215.5");
  });
  it("nomes que começam com a letra não viram total", () => {
    expect(pinnacleizeSelecao({ selecao: "Uruguai", mercadoPinnacle: "Moneyline", evento })).toBe("Uruguai");
  });
});

describe("pinnacleizeSelecao — handicap entre parênteses, DNB/Dupla Chance e prefixo de total", () => {
  const evento = "Flamengo vs Palmeiras";

  it("handicap com linha entre parênteses vira nome do clube + linha canônica", () => {
    for (const [selecao, esperado] of [
      ["Time 1 (+0.5)", "Flamengo +0.5"],
      ["Equipe 2 (-0.5)", "Palmeiras -0.5"],
      ["First Team (+0.5)", "Flamengo +0.5"],
      ["Segundo Time (-0.5)", "Palmeiras -0.5"],
      ["Time 1 (+0,5)", "Flamengo +0.5"],
    ] as const) {
      expect(
        pinnacleizeSelecao({ selecao, mercadoPinnacle: "Asian Handicap", evento }),
        selecao,
      ).toBe(esperado);
    }
    // Split asiático continua preservado (não vira um lado com linha única).
    expect(
      pinnacleizeSelecao({ selecao: "Flamengo -0,5,-1", mercadoPinnacle: "Asian Handicap", evento }),
    ).toBe("Flamengo -0.5,-1");
  });

  it("DNB e Dupla Chance em novas grafias viram nomes reais", () => {
    expect(
      pinnacleizeSelecao({ selecao: "Empate reembolsa - 1", mercadoPinnacle: "Empate Reembolsa", evento }),
    ).toBe("Flamengo");
    expect(
      pinnacleizeSelecao({ selecao: "2 (Devolução no Empate)", mercadoPinnacle: "Devolução no Empate", evento }),
    ).toBe("Palmeiras");
    expect(
      pinnacleizeSelecao({ selecao: "Dupla Oportunidade: 1X", mercadoPinnacle: "Dupla Oportunidade", evento }),
    ).toBe("Flamengo or Draw");
  });

  it("prefixo 'Linha de Gols - ' sai da seleção de total", () => {
    expect(
      pinnacleizeSelecao({ selecao: "Linha de Gols - Over 2.5", mercadoPinnacle: "Linha de Gols", evento }),
    ).toBe("Over 2.5");
    expect(
      pinnacleizeSelecao({ selecao: "Linha de Escanteios: Mais de 9.5", mercadoPinnacle: "Linha de Escanteios", evento }),
    ).toBe("Over 9.5");
    // Sem direção logo após o rótulo, nada é removido (vocabulário restrito).
    expect(
      pinnacleizeSelecao({ selecao: "Linha de Gols - Flamengo", mercadoPinnacle: "Linha de Gols", evento }),
    ).toBe("Linha de Gols - Flamengo");
  });
});

describe("coerceMercadoPelaSelecao — mercado de estatística não é reescrito", () => {
  it("preserva o rótulo que declara a estatística em vez de virar Total", () => {
    // "Linha de Finalizações / Over 4.5" virava `Total – Match`: sem a palavra
    // "finalizações" o gate de estatística do settlement não tinha mais o que
    // detectar e a aposta liquidava pelo placar de GOLS.
    for (const [mercado, selecao, esporte] of [
      ["Linha de Finalizações", "Over 4.5", "Soccer"],
      ["Linha de Chutes", "Over 9.5", "Soccer"],
      ["Linha de Faltas", "Over 20.5", "Soccer"],
      ["Linha de Rebotes", "Over 40.5", "Basketball"],
      ["Linha de Assistências", "Over 20.5", "Basketball"],
      ["Desarmes do Jogo", "Mais de 15.5", "Soccer"],
    ] as const) {
      expect(
        coerceMercadoPelaSelecao(mercado, selecao, esporte),
        `${mercado} | ${selecao}`,
      ).toBe(mercado);
    }
  });

  it("mercado sem estatística declarada continua sendo coagido", () => {
    // O motivo original da coerção (Bet365 "Gols + -") não pode regredir.
    expect(coerceMercadoPelaSelecao("Gols + -", "Mais de 2.5", "Soccer")).toBe("Total – Match");
    expect(coerceMercadoPelaSelecao("XYZ Inventado", "Over 2.5", "Soccer")).toBe("Total – Match");
    // Beisebol: "corridas" é o próprio placar, não estatística fora dele.
    expect(coerceMercadoPelaSelecao("Corridas - Jogo", "Over 8.5", "Baseball")).toBe("Total – Game");
  });
});

describe("pinnacleizeSelecao — lado DEPOIS da linha", () => {
  const evento = "Flamengo vs Palmeiras";
  const casos = [
    "Over 1.5 Flamengo Gols",
    "Mais de 1.5 Gols Flamengo",
    "Mais de 1.5 Gols do Flamengo",
    "Over 1.5 Time 1",
    "Over 1.5 Casa",
    "Over 1.5 Home",
    "Over 1.5 1º Time",
    "Over 1.5 First Team",
    "Over 1.5 Local Team",
  ] as const;

  it("preserva o time em Team Total e no total genérico em PT", () => {
    for (const mercadoPinnacle of ["Team Total Goals", "Total de Gols"]) {
      for (const selecao of casos) {
        expect(
          pinnacleizeSelecao({ selecao, mercadoPinnacle, evento }),
          `${mercadoPinnacle} | ${selecao}`,
        ).toBe("Flamengo Over 1.5");
      }
    }
    expect(
      pinnacleizeSelecao({ selecao: "Under 2.5 Palmeiras Gols", mercadoPinnacle: "Team Total Goals", evento }),
    ).toBe("Palmeiras Under 2.5");
  });

  it("sufixo que não é time continua sem virar lado", () => {
    // Período e estatística no sufixo não podem corromper a linha nem inventar
    // um lado.
    expect(
      pinnacleizeSelecao({ selecao: "Over 9.5 corners 1st half", mercadoPinnacle: "Total (Corners) – 1st Half", evento }),
    ).toBe("Over 9.5");
    expect(
      pinnacleizeSelecao({ selecao: "Over 2.5 - 1st Half", mercadoPinnacle: "Total – 1st Half", evento }),
    ).toBe("Over 2.5");
    expect(pinnacleizeSelecao({ selecao: "Over 2.5", mercadoPinnacle: "Total", evento })).toBe("Over 2.5");
    // Evento sem times reconhecíveis não inventa prefixo.
    expect(
      pinnacleizeSelecao({ selecao: "Over 1.5 Flamengo Gols", mercadoPinnacle: "Total de Gols", evento: "" }),
    ).toBe("Over 1.5");
  });

  it("prefixo de beisebol sai da seleção", () => {
    expect(
      pinnacleizeSelecao({ selecao: "Linha de Runs - Over 8.5", mercadoPinnacle: "Total Runs", evento: "Yankees vs Red Sox" }),
    ).toBe("Over 8.5");
    expect(
      pinnacleizeSelecao({ selecao: "Linha de Corridas: Mais de 8.5", mercadoPinnacle: "Total Runs", evento: "Yankees vs Red Sox" }),
    ).toBe("Over 8.5");
  });
});


describe("pinnacleizeSelecao — placar exato e rótulos numerados de vencedor", () => {
  const evento = "Flamengo vs Palmeiras";

  it("placar exato aceita conectores em português", () => {
    for (const selecao of ["Placar Exato - 2 a 1", "2 por 1", "2 a 1", "2x1"]) {
      expect(
        pinnacleizeSelecao({ selecao, mercadoPinnacle: "Correct Score", evento }),
        selecao,
      ).toBe("2-1");
    }
    // Fora de placar exato as letras seguem pertencendo ao texto.
    expect(
      pinnacleizeSelecao({ selecao: "Sub 20 a 1", mercadoPinnacle: "Moneyline", evento }),
    ).toBe("Sub 20 a 1");
  });

  it.each([
    ["Palmeiras 2x1", "1-2"],
    ["Palmeiras 2-0", "0-2"],
    ["Placar exato: Palmeiras 2x1", "1-2"],
    ["Visitante 3-1", "1-3"],
    ["Flamengo 2x1", "2-1"],
    ["Empate 1x1", "1-1"],
    ["Palmeiras 1x1", "1-1"],
    ["2x1", "2-1"],
    ["Palmeiras 2x1 Flamengo", "1-2"],
    ["Flamengo 2x1 Palmeiras", "2-1"],
    // O visitante com o placar menor na frente não diz de quem é cada gol.
    ["Palmeiras 1x2", "Palmeiras 1x2"],
  ])("placar exato com o time citado fica na ordem do evento: %s → %s", (selecao, expected) => {
    expect(pinnacleizeSelecao({ selecao, mercadoPinnacle: "Correct Score", evento })).toBe(expected);
  });

  it("rótulos numerados de vencedor viram o clube em handicap e moneyline", () => {
    expect(
      pinnacleizeSelecao({ selecao: "Vencedor 1 +0.5", mercadoPinnacle: "Asian Handicap", evento }),
    ).toBe("Flamengo +0.5");
    expect(
      pinnacleizeSelecao({ selecao: "Match Winner 2 -0.5", mercadoPinnacle: "Asian Handicap", evento }),
    ).toBe("Palmeiras -0.5");
    expect(
      pinnacleizeSelecao({ selecao: "Vencedor do Duelo - 1", mercadoPinnacle: "Moneyline", evento }),
    ).toBe("Flamengo");
    expect(
      pinnacleizeSelecao({ selecao: "Dupla Escolha: 1X", mercadoPinnacle: "Double Chance", evento }),
    ).toBe("Flamengo or Draw");
  });
});

/**
 * Ao ligar liquidação em esporte novo, o perigo não é o detector de fim — é a
 * UNIDADE do placar. O FlashScore devolve `scores` em sets no vôlei, legs nos
 * dardos, frames no snooker e runs no críquete. Um "Total de Pontos Over 5.5"
 * liquidado pelo 3x1 de sets daria WON num jogo que somou 180 pontos (mesma
 * família de hockey liquidando por gols).
 *
 * A trava de unidade cobre os esportes novos sem config adicional; este teste
 * existe para que isso não regrida em silêncio.
 */
describe("unidade do placar nos esportes que o FlashScore vai liquidar", () => {
  const bloqueia = (m: string, s: string, e: string) => hasScoreUnitMismatch(m, s, e);

  it("recusa mercado cuja unidade NÃO é o placar daquele esporte", () => {
    expect(bloqueia("Total de Pontos", "Over 5.5", "Volleyball")).toBe(true);
    expect(bloqueia("Total de Pontos", "Over 180.5", "Darts")).toBe(true);
    expect(bloqueia("Total de Pontos", "Over 200.5", "Cricket")).toBe(true);
    expect(bloqueia("Total de Pontos", "Over 55.5", "Handball")).toBe(true);
  });

  /**
   * `legs` e `frames` são recusados porque a unidade do `scores` de dardos e
   * snooker NUNCA foi medida. Registrar como permissão o que é só
   * desconhecimento é como se liquida pelo número errado. Quando houver corpus,
   * medir e reabrir, com o número na mão.
   */
  it("recusa unidade cujo placar nunca foi medido — fail-closed", () => {
    expect(bloqueia("Total de Legs", "Over 8.5", "Darts")).toBe(true);
    expect(bloqueia("Total de Frames", "Over 9.5", "Snooker")).toBe(true);
    expect(bloqueia("Total de Mapas", "Over 2.5", "eSports")).toBe(true);
  });

  it("permite mercado cuja unidade É o placar daquele esporte", () => {
    expect(bloqueia("Total de Runs", "Over 250.5", "Cricket")).toBe(false);
    expect(bloqueia("Total de Gols", "Over 2.5", "Handball")).toBe(false);
    // Handicap de vôlei É em sets — o placar do feed serve.
    expect(bloqueia("Handicap – Match", "Time A -1.5", "Volleyball")).toBe(false);
    expect(bloqueia("Moneyline", "Time A", "Volleyball")).toBe(false);
  });
});


describe("seleção preserva regras ausentes no mercado", () => {
  it.each(["Including OT", "Incluindo Prorrogação", "Com Prorrogação", "Tempo Regular", "Tempo Normal", "(TR)"])("não remove %s de um total", rule => {
    const selecao = `Over 2.5 – ${rule}`;
    expect(pinnacleizeSelecao({ selecao, mercadoPinnacle: "Total", evento: "Alpha vs Beta" })).toBe(selecao);
  });
});
