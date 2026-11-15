import { describe, expect, it } from "vitest";
import {
  channelMarketGrid,
  OTHER_MARKETS,
  suggestedCuts,
  type PortfolioBetInput,
} from "@/src/domain/analyzer/portfolio";
import { AMOSTRA_MINIMA_CLV } from "@/src/domain/analyzer/shared";

/** Carteira: canal × mercado e os cortes sugeridos — lógica pura. */

type Bet = PortfolioBetInput & { canal: string };
const FECHADO = new Date("2026-09-20T12:00:00Z");

function bet(canal: string, mercado: string, p: Partial<Bet> = {}): Bet {
  return {
    canal, mercado, status: "WON", stake: 10, lucro: 9,
    clv: null, clvReliable: null, closingFetchedAt: null, ...p,
  };
}

/** `n` apostas com CLV confiável alternando entre `a` e `b` (desvio não nulo). */
function comClv(canal: string, mercado: string, n: number, a: number, b: number, p: Partial<Bet> = {}): Bet[] {
  return Array.from({ length: n }, (_, i) => bet(canal, mercado, {
    clv: i % 2 ? a : b, clvReliable: true, closingFetchedAt: FECHADO, ...p,
  }));
}

const canalDe = (b: Bet) => b.canal;

describe("matriz canal × mercado", () => {
  it("ordena canais e mercados por volume e deixa vazia a célula sem aposta", () => {
    const bets = [
      bet("Alfa", "Total"), bet("Alfa", "Total"), bet("Alfa", "Money Line"),
      bet("Beta", "Total"), bet("Beta", "Total"), bet("Beta", "Total"),
    ];
    const grid = channelMarketGrid(bets, canalDe);
    expect(grid.markets).toEqual(["Total", "Money Line"]);
    expect(grid.rows.map((r) => r.channel)).toEqual(["Alfa", "Beta"]);
    const [alfa, beta] = grid.rows;
    expect(alfa?.cells.map((c) => c?.bets ?? null)).toEqual([2, 1]);
    expect(beta?.cells.map((c) => c?.bets ?? null)).toEqual([3, null]);
    expect(alfa?.total.bets).toBe(3);
  });

  it("junta os mercados depois dos mais apostados numa coluna, mas não um mercado sozinho", () => {
    const mercados = ["A", "A", "A", "B", "B", "C", "D"];
    const bets = mercados.map((m) => bet("Alfa", m));
    expect(channelMarketGrid(bets, canalDe, { maxMarkets: 3 }).markets).toEqual(["A", "B", "C", "D"]);
    const grid = channelMarketGrid(bets, canalDe, { maxMarkets: 2 });
    expect(grid.markets).toEqual(["A", "B", OTHER_MARKETS]);
    const outros = grid.rows[0]?.cells[2];
    expect(outros?.membros.map((b) => b.mercado)).toEqual(["C", "D"]);
    // Os cortes olham cada mercado, não a coluna juntada.
    expect(grid.pairs.map((c) => c.market).sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("a célula soma o dinheiro das liquidadas e o CLV só dos fechamentos confiáveis", () => {
    const bets = [
      bet("Alfa", "Total", { status: "LOST", lucro: -10, clv: -4, clvReliable: true, closingFetchedAt: FECHADO }),
      bet("Alfa", "Total", { status: "WON", lucro: 9, clv: 2, clvReliable: true, closingFetchedAt: FECHADO }),
      // Pendente com CLV provisório: conta como aposta, não entra no dinheiro nem no CLV.
      bet("Alfa", "Total", { status: "PENDING", lucro: 0, clv: 50, clvReliable: true, closingFetchedAt: null }),
    ];
    const cell = channelMarketGrid(bets, canalDe).rows[0]!.cells[0]!;
    expect(cell).toMatchObject({ bets: 3, resolvedBets: 2, stake: 20, lucro: -1, nClv: 2, avgClv: -1 });
    expect(cell.membros).toHaveLength(3);
  });
});

describe("cortes sugeridos", () => {
  it("corta pelo CLV significativamente negativo, mesmo com ROI positivo", () => {
    const bets = [
      ...comClv("Alfa", "Money Line", AMOSTRA_MINIMA_CLV, -3, -5, { status: "WON", lucro: 9 }),
      ...comClv("Alfa", "Total", AMOSTRA_MINIMA_CLV, 3, 5),
    ];
    const cuts = suggestedCuts(bets, channelMarketGrid(bets, canalDe));
    expect(cuts.cuts.map((c) => `${c.channel} · ${c.market}`)).toEqual(["Alfa · Money Line"]);
    expect(cuts.cuts[0]!.roi).toBeGreaterThan(0);
    expect(cuts.cuts[0]!.tStat).toBeLessThan(0);
  });

  it("não corta por ROI ruim quando o CLV é positivo nem com amostra abaixo do mínimo", () => {
    const bets = [
      ...comClv("Alfa", "Total", AMOSTRA_MINIMA_CLV, 1, 3, { status: "LOST", lucro: -10 }),
      ...comClv("Beta", "Total", AMOSTRA_MINIMA_CLV - 1, -8, -10, { status: "LOST", lucro: -10 }),
    ];
    const cuts = suggestedCuts(bets, channelMarketGrid(bets, canalDe));
    expect(cuts.cuts).toEqual([]);
    expect(cuts).toMatchObject({ testedPairs: 1, totalPairs: 2 });
  });

  it("não corta CLV negativo que o teste ainda não distingue de zero", () => {
    const bets = comClv("Alfa", "Total", 40, 9, -10);
    expect(suggestedCuts(bets, channelMarketGrid(bets, canalDe)).cuts).toEqual([]);
  });

  it("mede o impacto: CLV e lucro da carteira com e sem os cortes", () => {
    const ruim = comClv("Alfa", "Money Line", AMOSTRA_MINIMA_CLV, -2, -4, { status: "LOST", lucro: -10 });
    const bom = comClv("Beta", "Total", AMOSTRA_MINIMA_CLV, 2, 4, { status: "WON", lucro: 9 });
    const cuts = suggestedCuts([...ruim, ...bom], channelMarketGrid([...ruim, ...bom], canalDe));
    expect(cuts.cut).toMatchObject({ bets: 30, lucro: -300, avgClv: -3, nClv: 30 });
    expect(cuts.portfolio).toMatchObject({ bets: 60, lucro: -30, avgClv: 0, nClv: 60 });
    expect(cuts.withoutCuts).toMatchObject({ bets: 30, lucro: 270, avgClv: 3, nClv: 30 });
  });

  it("ordena do mais negativo (menor t) ao menos", () => {
    const bets = [
      ...comClv("Alfa", "Total", AMOSTRA_MINIMA_CLV, -1, -3),
      ...comClv("Beta", "Total", AMOSTRA_MINIMA_CLV, -5, -7),
    ];
    const { cuts } = suggestedCuts(bets, channelMarketGrid(bets, canalDe));
    expect(cuts.map((c) => c.channel)).toEqual(["Beta", "Alfa"]);
  });
});


describe("preservação dos mercados reais na matriz", () => {
  it.each([
    ["sem agrupamento", [OTHER_MARKETS, "Total"], 8],
    ["mercado homônimo entre os mais apostados", [OTHER_MARKETS, OTHER_MARKETS, OTHER_MARKETS, "Total", "Total", "Gols", "Handicap"], 2],
    ["mercado homônimo entre os agrupados", ["Total", "Total", "Total", "Gols", "Gols", "Handicap", OTHER_MARKETS], 2],
    ["mais de um rótulo reservado ocupado", [OTHER_MARKETS, OTHER_MARKETS, OTHER_MARKETS, "Outros mercados (agrupados)", "Outros mercados (agrupados)", "Gols", "Handicap"], 2],
  ] as const)("conserva todas as apostas: %s", (_, markets, maxMarkets) => {
    const bets = markets.map((market, index) => bet("Alfa", market, { status: "LOST", lucro: -index - 1 }));
    const grid = channelMarketGrid(bets, canalDe, { maxMarkets });
    const row = grid.rows[0]!;
    const shown = row.cells.flatMap((cell) => cell?.membros ?? []);
    expect(new Set(grid.markets).size).toBe(grid.markets.length);
    expect(shown).toHaveLength(bets.length);
    expect(new Set(shown)).toEqual(new Set(bets));
    expect(row.cells.reduce((sum, cell) => sum + (cell?.lucro ?? 0), 0)).toBe(row.total.lucro);
  });
});
