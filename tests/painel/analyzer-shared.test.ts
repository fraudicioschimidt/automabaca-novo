import { describe, expect, it } from "vitest";
import { agregaGrupo, clvConfiavel, desvioPadraoAmostral, media, mediana, roiPct } from "@/src/domain/analyzer/shared";
import type { BetRowData } from "@/src/domain/bet-read-model";

/**
 * Estatística pura que DECIDE saída do analyzer (CLV mediano
 * mostrados ao operador no AnalyzerScreen). Asserções de valor, sem DB.
 */

describe("clvConfiavel (gate de fechamento CONGELADO)", () => {
  const congelado = { clv: 5, clvReliable: true, closingFetchedAt: new Date("2026-06-15T19:00:00Z") };
  it("fechamento congelado + confiável → o CLV", () => {
    expect(clvConfiavel(congelado)).toBe(5);
  });
  it("provisório (closingFetchedAt null) → null, mesmo com clvReliable=true", () => {
    // O CLV provisório pré-kickoff ainda se move; incluí-lo poluiria as métricas
    // do analyzer/canais.
    expect(clvConfiavel({ ...congelado, closingFetchedAt: null })).toBeNull();
  });
  it("congelado mas clvReliable=false → null", () => {
    expect(clvConfiavel({ ...congelado, clvReliable: false })).toBeNull();
  });
  it("clvReliable=null (sem prova) com fechamento congelado → null", () => {
    expect(clvConfiavel({ ...congelado, clvReliable: null })).toBeNull();
  });
});

describe("media", () => {
  it("média simples; vazio → null", () => {
    expect(media([2, 4])).toBe(3);
    expect(media([5])).toBe(5);
    expect(media([])).toBeNull();
  });
});

describe("mediana", () => {
  it("ímpar = do meio; par = média dos dois centrais; ordena antes", () => {
    expect(mediana([3, 1, 2])).toBe(2);
    expect(mediana([1, 2, 3, 4])).toBe(2.5);
    expect(mediana([10])).toBe(10);
    expect(mediana([])).toBeNull();
  });
});

describe("roiPct", () => {
  it("é lucro sobre stake em %, e null sem stake", () => {
    expect(roiPct(9, 10)).toBe(90);
    expect(roiPct(-5, 20)).toBe(-25);
    expect(roiPct(3, 0)).toBeNull();
  });
});

describe("robustez a entrada suja", () => {
  it("clvConfiavel valida finitude e prova do fechamento", () => {
    const now = new Date();
    expect(clvConfiavel({ clv: 2.5, clvReliable: true, closingFetchedAt: now })).toBe(2.5);
    expect(clvConfiavel({ clv: NaN, clvReliable: true, closingFetchedAt: now })).toBeNull();
    expect(clvConfiavel({ clv: Infinity, clvReliable: true, closingFetchedAt: now })).toBeNull();
    expect(clvConfiavel({ clv: 2.5, clvReliable: false, closingFetchedAt: now })).toBeNull();
  });

  it("agregaGrupo normaliza status com trim e blinda CLVs não-finitos", () => {
    const bets: Partial<BetRowData>[] = [
      { status: " WON ", stake: 10, lucro: 9, clv: 2.5, clvReliable: true, closingFetchedAt: new Date() },
      { status: "LOST", stake: 10, lucro: -10, clv: -1.0, clvReliable: true, closingFetchedAt: new Date() },
    ];
    const agg = agregaGrupo(bets as BetRowData[]);
    expect(agg.resolvedBets).toBe(2);
    expect(agg.lucro).toBe(-1);
    expect(agg.stake).toBe(20);
    expect(agg.sucessoPct).toBe(50);
    expect(agg.avgClv).toBe(0.75);
  });

  it("media soma com compensação: parcelas pequenas não somem ao lado de uma grande", () => {
    // 1 + dez parcelas de 1e-16: a soma ingênua fica em 1 (cada parcela se
    // perde no arredondamento); a compensada chega a 1.000000000000001.
    const valores = [1, ...Array<number>(10).fill(1e-16)];
    expect(media(valores)).toBe(1.000000000000001 / 11);
    expect(media(valores)).not.toBe(1 / 11);
    expect(media([2, Number.NaN, 4, Number.POSITIVE_INFINITY])).toBe(3);
    expect(media([Number.NaN])).toBeNull();
  });

  it("desvioPadraoAmostral divide por n−1", () => {
    // Soma dos quadrados 32 sobre 8 valores: amostral √(32/7), populacional 2.
    expect(desvioPadraoAmostral([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(desvioPadraoAmostral([2, 4, 4, 4, 5, 5, 7, 9])).not.toBeCloseTo(2, 3);
    expect(desvioPadraoAmostral([3])).toBeNull();
    expect(desvioPadraoAmostral([1, 3, Number.NaN])).toBeCloseTo(Math.SQRT2, 12);
  });
});
