import { describe, expect, it } from "vitest";
import {
  autoFairOdds,
  autoFairProbs,
  combineQuarterLineOdds,
  percentualContraFair,
  powerFairOdds,
  powerFairProbs,
  shinFairOdds,
  shinFairProbs,
} from "@/src/domain/odds";

describe("powerFairOdds", () => {
  it("mercado 2-way simétrico devigado vira moeda justa (2.00/2.00)", () => {
    const fair = powerFairOdds([1.91, 1.91]);
    expect(fair).not.toBeNull();
    expect(fair![0]).toBeCloseTo(2.0, 6);
    expect(fair![1]).toBeCloseTo(2.0, 6);
  });

  it("probabilidades devigadas somam exatamente 1", () => {
    const probs = powerFairProbs([1.85, 3.6, 4.8]);
    expect(probs).not.toBeNull();
    expect(probs!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("preserva a solução numérica de referência da bisseção", () => {
    expect(powerFairProbs([1.85, 3.6, 4.8])).toEqual([
      0.5317475023729468,
      0.2684518765268272,
      0.19980062110022592,
    ]);
  });

  it("rejeita odds inválidas e overround absurdo", () => {
    expect(powerFairOdds([1.0, 2.0])).toBeNull();
    expect(powerFairOdds([1.2, 1.2])).toBeNull(); // soma implícita ~1.67 > 1.35
    // Underround NÃO é recusado: livro com Σ 1/odds abaixo de 1 tem preço
    // válido e é normalizado (decisão do dono; recusar deixaria a aposta sem
    // CLV). Só o dado podre fica fora.
    expect(powerFairOdds([2.1, 2.1])).toEqual([2, 2]);
    expect(powerFairOdds([2.5, 2.5])).toBeNull(); // soma 0.8 < piso de 0.90
    expect(powerFairOdds([2])).toBeNull();
    expect(powerFairOdds([Number.NaN, 2])).toBeNull();
    expect(powerFairOdds([Number.POSITIVE_INFINITY, 2])).toBeNull();
  });

  it("aceita mercado exatamente justo, sem overround", () => {
    expect(powerFairOdds([2, 2])).toEqual([2, 2]);
    const unevenFair = [1 / 0.8632010943912448, 1 / 0.13679890560875513];
    expect(powerFairProbs(unevenFair)?.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });

  it("aceita o teto de juice e recusa imediatamente acima", () => {
    const atLimit = [1 / (0.5 * 1.35), 1 / (0.5 * 1.35)];
    const aboveLimit = [1 / (0.5 * 1.350001), 1 / (0.5 * 1.350001)];
    expect(powerFairOdds(atLimit)).not.toBeNull();
    expect(powerFairOdds(aboveLimit)).toBeNull();
  });

  it("aceita exatamente o piso de underround e recusa abaixo", () => {
    const atLimit = [2, 2.5];
    const belowLimit = [1 / 0.449999, 1 / 0.449999];
    // O livro normalizado já é justo: n = 1 devolve as próprias probabilidades.
    expect(powerFairProbs(atLimit)).toEqual([0.5 / 0.9, 0.4 / 0.9]);
    expect(powerFairOdds(belowLimit)).toBeNull();
  });

  it("livro underround cuja soma normalizada sai 1 − ε em ponto flutuante ainda tem fair", () => {
    for (const book of [
      [1.96, 2.05],
      [1.9, 2.12],
    ]) {
      const probs = powerFairProbs(book);
      expect(probs).not.toBeNull();
      expect(probs!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(powerFairOdds(book)).not.toBeNull();
      expect(autoFairOdds(book)).not.toBeNull();
    }
    expect(powerFairOdds([1.96, 2.05])![0]).toBeCloseTo(1.9561, 4);
    expect(autoFairOdds([1.16, 11.45, 20])).not.toBeNull();
  });
});

describe("shinFairOdds", () => {
  it("probabilidades somam 1 e preservam ordem favorito→azarão", () => {
    const odds = [1.5, 4.2, 6.5];
    const probs = shinFairProbs(odds);
    expect(probs).not.toBeNull();
    expect(probs!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(probs![0]).toBeGreaterThan(probs![1]!);
    expect(probs![1]).toBeGreaterThan(probs![2]!);
  });

  it("fair odds ficam acima das odds com juice", () => {
    const odds = [1.5, 4.2, 6.5];
    const fair = shinFairOdds(odds);
    expect(fair).not.toBeNull();
    for (let i = 0; i < odds.length; i++) {
      expect(fair![i]).toBeGreaterThan(odds[i]!);
    }
  });

  it("preserva a solução Shin de referência", () => {
    expect(shinFairProbs([1.5, 4.2, 6.5])).toEqual([
      0.6426559863815999,
      0.22010054712840912,
      0.13724346648999108,
    ]);
  });
});

describe("autoFairOdds", () => {
  it("2-way usa power; 3-way com favorito resolve por shin/power", () => {
    expect(autoFairOdds([1.91, 1.91])).not.toBeNull();
    expect(autoFairOdds([1.5, 4.2, 6.5])).not.toBeNull();
  });

  it("seleciona Shin com favorito claro e Power em mercado equilibrado", () => {
    const favorite = [1.5, 4.2, 6.5];
    const balanced = [2.4, 3.2, 3.2];
    expect(autoFairProbs(favorite)).toEqual(shinFairProbs(favorite));
    expect(autoFairProbs(balanced)).toEqual(powerFairProbs(balanced));
    expect(autoFairOdds(favorite)).toEqual(shinFairOdds(favorite));
    expect(autoFairOdds(balanced)).toEqual(powerFairOdds(balanced));
  });

  it("trata odd mínima exatamente 2 como favorito claro", () => {
    const atBoundary = [2, 3.4, 3.4];
    expect(autoFairProbs(atBoundary)).toEqual(shinFairProbs(atBoundary));
    expect(autoFairOdds(atBoundary)).toEqual(shinFairOdds(atBoundary));
  });
});

describe("combineQuarterLineOdds", () => {
  // Diferença de gols (casa − fora): P(≥2)=0,20, P(1)=0,25, P(0)=0,27,
  // P(−1)=0,18, P(≤−2)=0,10. Cada componente é uma aposta de meia stake; a
  // justa exata da linha de quarto zera o EV das duas metades juntas:
  // F = 1 + (perde₁ + perde₂) / (ganha₁ + ganha₂).
  const exact = (c1: { w: number; l: number }, c2: { w: number; l: number }) => 1 + (c1.l + c2.l) / (c1.w + c2.w);
  const fair = (c: { w: number; l: number }) => 1 + c.l / c.w;
  const homeAh0 = { w: 0.45, l: 0.28 };
  const homeAhMinusHalf = { w: 0.45, l: 0.55 };
  const homeAhMinusOne = { w: 0.2, l: 0.55 };
  const awayAh0 = { w: 0.28, l: 0.45 };
  const awayAhPlusHalf = { w: 0.55, l: 0.45 };

  it("AH −0,25: a meia linha é a mais difícil e a justa é a média das justas", () => {
    const f = combineQuarterLineOdds({ side: "handicap", components: [
      { lineQ: 0, odd: fair(homeAh0) }, { lineQ: -2, odd: fair(homeAhMinusHalf) },
    ] });
    expect(f).toBeCloseTo(exact(homeAh0, homeAhMinusHalf), 12);
    expect(f).toBeCloseTo(1.922222, 6);
    // Uma odd 2% acima da justa exata tem CLV de +2% (a média de
    // probabilidades dava 1,8754 e um CLV de +4,5%).
    expect(percentualContraFair(1.922222 * 1.02, f!)).toBeCloseTo(2, 4);
  });

  it("AH −0,75: a meia linha é a mais fácil e a média é a de 1/(F−1)", () => {
    const f = combineQuarterLineOdds({ side: "handicap", components: [
      { lineQ: -2, odd: fair(homeAhMinusHalf) }, { lineQ: -4, odd: fair(homeAhMinusOne) },
    ] });
    expect(f).toBeCloseTo(exact(homeAhMinusHalf, homeAhMinusOne), 12);
    expect(f).toBeCloseTo(2.692308, 6);
  });

  it("AH +0,25 do visitante, na linha dele", () => {
    const f = combineQuarterLineOdds({ side: "handicap", components: [
      { lineQ: 0, odd: fair(awayAh0) }, { lineQ: 2, odd: fair(awayAhPlusHalf) },
    ] });
    expect(f).toBeCloseTo(exact(awayAh0, awayAhPlusHalf), 12);
    expect(f).toBeCloseTo(2.084337, 6);
  });

  it("over e under 2,25 com a mesma distribuição de gols", () => {
    // Total: P(≤1)=0,25, P(2)=0,25, P(3)=0,22, P(≥4)=0,28.
    const over2 = { w: 0.5, l: 0.25 };
    const over25 = { w: 0.5, l: 0.5 };
    const under2 = { w: 0.25, l: 0.5 };
    const under25 = { w: 0.5, l: 0.5 };
    const over = combineQuarterLineOdds({ side: "over", components: [
      { lineQ: 8, odd: fair(over2) }, { lineQ: 10, odd: fair(over25) },
    ] });
    const under = combineQuarterLineOdds({ side: "under", components: [
      { lineQ: 10, odd: fair(under25) }, { lineQ: 8, odd: fair(under2) },
    ] });
    expect(over).toBeCloseTo(exact(over2, over25), 12);
    expect(over).toBeCloseTo(1.75, 12);
    expect(under).toBeCloseTo(exact(under2, under25), 12);
    expect(under).toBeCloseTo(7 / 3, 12);
  });

  it("null sem dois componentes vizinhos, um inteiro e um de meio ponto", () => {
    expect(combineQuarterLineOdds({ side: "over", components: [{ lineQ: 8, odd: 1.5 }, { lineQ: 12, odd: 2 }] })).toBeNull();
    expect(combineQuarterLineOdds({ side: "over", components: [{ lineQ: 9, odd: 1.5 }, { lineQ: 11, odd: 2 }] })).toBeNull();
    expect(combineQuarterLineOdds({ side: "over", components: [{ lineQ: 8, odd: 1 }, { lineQ: 10, odd: 2 }] })).toBeNull();
    expect(combineQuarterLineOdds({ side: "over", components: [{ lineQ: 8, odd: Number.NaN }, { lineQ: 10, odd: 2 }] })).toBeNull();
  });
});

describe("percentualContraFair", () => {
  it("odd cravada acima da fair = diferença positiva", () => {
    expect(percentualContraFair(2.1, 2.0)).toBeCloseTo(5, 6);
    expect(percentualContraFair(1.9, 2.0)).toBeCloseTo(-5, 6);
    expect(percentualContraFair(0, 2)).toBeNull();
    expect(percentualContraFair(1, 2)).toBeNull();
    expect(percentualContraFair(2, 1)).toBeNull();
    expect(percentualContraFair(2, Number.NaN)).toBeNull();
    expect(percentualContraFair(Number.POSITIVE_INFINITY, 2)).toBeNull();
    expect(percentualContraFair(1000, 1.01)).toBeGreaterThan(98_000);
  });
});

describe("referências analíticas independentes para o CLV", () => {
  it.each([0.9, 0.97, 1])("Power recupera probabilidades conhecidas com expoente %s", (exponent) => {
    const probabilities = [0.5, 0.3, 0.2];
    const book = probabilities.map((p) => 1 / p ** exponent);
    const result = powerFairProbs(book)!;
    probabilities.forEach((p, index) => expect(result[index]).toBeCloseTo(p, 10));
    const fair = powerFairOdds(book)![0]!;
    expect(percentualContraFair(fair * 1.03, fair)).toBeCloseTo(3, 10);
  });
  it.each([0, 0.01, 0.04])("Shin recupera probabilidades conhecidas com z=%s", (z) => {
    const probabilities = [0.65, 0.22, 0.13];
    // Inverte a equação de Shin: q_i / sqrt(Σq) = sqrt((1−z)p_i² + zp_i).
    const roots = probabilities.map((p) => Math.sqrt((1 - z) * p * p + z * p));
    const sumRoots = roots.reduce((sum, r) => sum + r, 0);
    const book = roots.map((r) => 1 / (r * sumRoots));
    const result = shinFairProbs(book)!;
    probabilities.forEach((p, index) => expect(result[index]).toBeCloseTo(p, 10));
    expect(autoFairOdds(book)![0]).toBeCloseTo(1 / probabilities[0]!, 10);
  });
  it("CLV mede o preço relativo; devolução impede interpretá-lo como lucro esperado exato", () => {
    // DNB: 20% vitória, 60% devolução, 20% derrota. Justa 2, e não 1/20%.
    const win = 0.2, push = 0.6, loss = 0.2;
    const fair = 1 + loss / win;
    const taken = 2.1;
    expect(win * (fair - 1) + push * 0 - loss).toBeCloseTo(0, 12);
    expect(percentualContraFair(taken, fair)).toBeCloseTo(5, 12);
    expect((win * (taken - 1) - loss) * 100).toBeCloseTo(2, 12);
  });
});
