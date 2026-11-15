import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { describe, expect, it } from "vitest";
import { effectiveSharpBet, sharpEquivalentBet } from "@/src/domain/mercados/sharp-equivalent";

/**
 * Equivalência sharp (racional do dono): DnB e DC têm a
 * MESMA resolução que linhas AH — o tipster manda "Draw No Bet" mas a
 * Pinnacle quota o handicap 0.0. A aposta PERSISTE como o tipster mandou;
 * só a precificação traduz.
 */

const EVENTO = "Canada vs Bosnia and Herzegovina";

describe("sharpEquivalentBet", () => {
  it("DnB no time → AH 0.0 do time", () => {
    expect(sharpEquivalentBet({ mercado: "Draw No Bet", selecao: "Canada", evento: EVENTO })).toEqual({
      mercado: "Asian Handicap",
      selecao: "Canada 0.0",
      nota: "dnb→ah_0.0",
    });
    expect(
      sharpEquivalentBet({ mercado: "Draw No Bet", selecao: "Fora", evento: EVENTO })?.selecao,
    ).toBe("Bosnia and Herzegovina 0.0");
    for (const selecao of ["1", "1 (DNB)", "1 - Empate Anula"] as const) {
      expect(
        sharpEquivalentBet({ mercado: "Draw No Bet", selecao, evento: EVENTO })?.selecao,
        selecao,
      ).toBe("Canada 0.0");
    }
    for (const selecao of ["2", "2 (DNB)", "2 - Empate Devolve"] as const) {
      expect(
        sharpEquivalentBet({ mercado: "Draw No Bet", selecao, evento: EVENTO })?.selecao,
        selecao,
      ).toBe("Bosnia and Herzegovina 0.0");
    }
    // Reprodução de produção: o capturador persistiu o rótulo genérico e
    // preservou DNB apenas na seleção. Ainda é a mesma linha AH 0.0.
    expect(
      sharpEquivalentBet({ mercado: "Moneyline", selecao: "Canada DNB", evento: EVENTO }),
    ).toEqual({
      mercado: "Asian Handicap",
      selecao: "Canada 0.0",
      nota: "dnb→ah_0.0",
    });
  });

  it("DC 1X/X2 e formas em texto → AH +0.5 do lado", () => {
    expect(sharpEquivalentBet({ mercado: "Double Chance", selecao: "1X", evento: EVENTO })).toEqual({
      mercado: "Asian Handicap",
      selecao: "Canada +0.5",
      nota: "dc→ah_+0.5",
    });
    expect(
      sharpEquivalentBet({ mercado: "Double Chance", selecao: "X2", evento: EVENTO })?.selecao,
    ).toBe("Bosnia and Herzegovina +0.5");
    expect(
      sharpEquivalentBet({ mercado: "Double Chance", selecao: "Canada ou Empate", evento: EVENTO })
        ?.selecao,
    ).toBe("Canada +0.5");
    expect(
      sharpEquivalentBet({ mercado: "Double Chance", selecao: "Empate ou Fora", evento: EVENTO })
        ?.selecao,
    ).toBe("Bosnia and Herzegovina +0.5");
    expect(
      sharpEquivalentBet({ mercado: "Double Chance", selecao: "1 OU EMPATE", evento: EVENTO })
        ?.selecao,
    ).toBe("Canada +0.5");
    expect(
      sharpEquivalentBet({ mercado: "Double Chance", selecao: "1 ou X", evento: EVENTO })
        ?.selecao,
    ).toBe("Canada +0.5");
  });

  it("DC 12 não tem equivalente de 2 vias", () => {
    expect(sharpEquivalentBet({ mercado: "Double Chance", selecao: "12", evento: EVENTO })).toBeNull();
    expect(
      sharpEquivalentBet({ mercado: "Double Chance", selecao: "Casa ou Fora x", evento: EVENTO }),
    ).toBeNull();
  });

  it("mercados normais passam intactos", () => {
    expect(effectiveSharpBet({ mercado: "Total", selecao: "Over 2.5", evento: EVENTO })).toEqual({
      mercado: "Total",
      selecao: "Over 2.5",
    });
  });
});

describe("sharpEquivalentBet — DC formas invertidas", () => {
  it("DC 2X → AH +0.5 do fora (= X2, ordem invertida)", () => {
    expect(
      sharpEquivalentBet({ mercado: "Double Chance", selecao: "2X", evento: EVENTO }),
    ).toEqual({
      mercado: "Asian Handicap",
      selecao: "Bosnia and Herzegovina +0.5",
      nota: "dc→ah_+0.5",
    });
  });

  it("DC X1 → AH +0.5 da casa (= 1X, ordem invertida)", () => {
    expect(
      sharpEquivalentBet({ mercado: "Double Chance", selecao: "X1", evento: EVENTO }),
    ).toEqual({
      mercado: "Asian Handicap",
      selecao: "Canada +0.5",
      nota: "dc→ah_+0.5",
    });
  });

  it("DC 21 não tem equivalente de 2 vias (= 12, ordem invertida)", () => {
    expect(
      sharpEquivalentBet({ mercado: "Double Chance", selecao: "21", evento: EVENTO }),
    ).toBeNull();
  });
});


describe("equivalência preserva as regras do resultado", () => {
  it.each(["Including OT", "Incluindo Prorrogação", "Com Prorrogação"])("preserva %s na conversão DNB", rule => {
    expect(sharpEquivalentBet({ mercado: `Draw No Bet – ${rule}`, selecao: "Canada", evento: EVENTO }))
      .toMatchObject({ mercado: "Asian Handicap – Including Overtime", selecao: "Canada 0.0" });
  });

  it.each(["Tempo Regular", "Tempo Normal", "(TR)"])("não apaga %s ao converter DNB", rule => {
    expect(sharpEquivalentBet({ mercado: `Draw No Bet – ${rule}`, selecao: "Canada", evento: EVENTO })).toBeNull();
  });

  it.each(["Draw No Bet", "Double Chance"])("%s e AH têm o mesmo resultado em todos os placares simulados", mercado => {
    for (const selecao of mercado === "Draw No Bet" ? ["Canada", "Fora"] : ["1X", "X2"]) {
      const original = { mercado, selecao, evento: EVENTO };
      const equivalent = sharpEquivalentBet(original)!;
      expect(equivalent).not.toBeNull();
      for (let homeScore = 0; homeScore <= 5; homeScore++) {
        for (let awayScore = 0; awayScore <= 5; awayScore++) {
          const terms = { evento: EVENTO, esporte: "Soccer", homeScore, awayScore, stake: 3.25, odds: 1.97 };
          const entry = resolveResultFromScore({ ...terms, ...original });
          expect(entry.ok).toBe(true);
          expect(resolveResultFromScore({ ...terms, ...equivalent })).toEqual(entry);
        }
      }
    }
  });
});


it.each(["Draw No Bet", "Double Chance"])("%s no tênis não tem equivalência comprovada de games/retirada", mercado => {
  // Alpha vence por 2 sets a 1 (0-6, 6-4, 6-4), mas perde em games (12-14).
  // Mesmo AH de sets não prova as regras distintas de retirada da partida.
  const bet = { esporte: "Tennis", evento: "Alpha vs Beta", mercado, selecao: mercado === "Draw No Bet" ? "Alpha" : "1X" };
  expect(sharpEquivalentBet(bet)).toBeNull();
});


it.each(["Unknown", "Table Tennis", "Tênis de mesa"])("não converte DNB com equivalência não comprovada em %s", esporte => {
  expect(sharpEquivalentBet({ esporte, evento: EVENTO, mercado: "Draw No Bet", selecao: "Canada" })).toBeNull();
});


describe("menção ao tempo regulamentar, por esporte", () => {
  const FLAMENGO = "Flamengo vs Palmeiras";

  it.each([
    ["Dupla Chance - 1X2", "Flamengo or Draw", "Flamengo +0.5"],
    ["Resultado Final 1X2 - Dupla Chance", "Flamengo or Draw", "Flamengo +0.5"],
    ["Draw No Bet", "Flamengo (TR)", "Flamengo 0.0"],
  ])("no futebol o regulamentar é o padrão: %s / %s tem equivalência", (mercado, selecao, equivalente) => {
    expect(sharpEquivalentBet({ esporte: "Soccer", evento: FLAMENGO, mercado, selecao }))
      .toMatchObject({ mercado: "Asian Handicap", selecao: equivalente });
  });

  it.each(["Basketball", "Hockey", undefined])("onde o jogo inclui a prorrogação, ou sem esporte, a menção recusa (%s)", (esporte) => {
    expect(sharpEquivalentBet({ esporte, evento: FLAMENGO, mercado: "Dupla Chance - 1X2", selecao: "Flamengo or Draw" })).toBeNull();
  });
});
