import { describe, expect, it } from "vitest";
import { analyzeKelly, kellyStake } from "@/src/domain/kelly";
import { lerCapDeStake } from "@/app/_design/screens/ferramentas/kelly-panel";

describe("kellyStake", () => {
  it("expõe a mesma decomposição usada pela calculadora", () => {
    expect(analyzeKelly(2, 10)).toMatchObject({
      impliedProbability: 0.5,
      estimatedProbability: 0.55,
      fullFraction: expect.closeTo(0.1, 8),
    });
    expect(analyzeKelly(1.1, 10)).toBeNull();
  });
  it("calcula o Kelly fracionário sobre banca de 100u: p=(1+vantagem)/odds", () => {
    // odds 2.0, EV 10% → p = 1.1/2 = 0.55; kelly = (1×0.55 − 0.45)/1 = 0.10
    // fração 0.25 × 0.10 × 100u = 2.5u.
    expect(kellyStake({ odds: 2.0, vantagemPct: 10, fraction: 0.25, capUnits: 5 })).toBeCloseTo(2.5, 6);
  });

  it("aplica o cap de unidades", () => {
    expect(kellyStake({ odds: 2.0, vantagemPct: 50, fraction: 1, capUnits: 5 })).toBe(5);
  });

  it("sem vantagem (≤ 0) ou odds inválida → stake 0", () => {
    expect(kellyStake({ odds: 2.0, vantagemPct: 0, fraction: 0.25, capUnits: 5 })).toBe(0);
    expect(kellyStake({ odds: 2.0, vantagemPct: -5, fraction: 0.25, capUnits: 5 })).toBe(0);
    expect(kellyStake({ odds: 1.0, vantagemPct: 10, fraction: 0.25, capUnits: 5 })).toBe(0);
    expect(kellyStake({ odds: 2, vantagemPct: Number.NaN, fraction: 0.25, capUnits: 5 })).toBe(0);
    expect(kellyStake({ odds: 2, vantagemPct: 10, fraction: -1, capUnits: 5 })).toBe(0);
    expect(kellyStake({ odds: 2, vantagemPct: 10, fraction: 0.25, capUnits: Number.POSITIVE_INFINITY })).toBe(0);
  });
});

/**
 * Cap da calculadora: entrada inválida não vira "sem teto" em silêncio, senão
 * o cabeçalho anunciaria um teto que o cálculo descartou.
 */
describe("cap de stake da Calculadora Kelly", () => {
  it("campo vazio é ausência de teto, não erro", () => {
    for (const vazio of ["", "   ", null, undefined]) {
      expect(lerCapDeStake(vazio)).toEqual({ cap: null, semTeto: true, invalido: false });
    }
  });

  it("zero é teto ausente explícito", () => {
    expect(lerCapDeStake("0")).toEqual({ cap: 0, semTeto: true, invalido: false });
  });

  it("texto e negativo são recusados, nunca 'sem teto'", () => {
    for (const ruim of ["abc", "-5", "-0.01", "1e9", "--", "R$ 10"]) {
      const lido = lerCapDeStake(ruim);
      expect(lido.invalido, `"${ruim}" deveria ser recusado`).toBe(true);
      expect(lido.semTeto, `"${ruim}" não pode virar 'sem teto'`).toBe(false);
    }
  });

  it("valor válido passa inteiro, inclusive com vírgula PT-BR", () => {
    expect(lerCapDeStake("10")).toEqual({ cap: 10, semTeto: false, invalido: false });
    expect(lerCapDeStake("2,5")).toEqual({ cap: 2.5, semTeto: false, invalido: false });
  });
});
