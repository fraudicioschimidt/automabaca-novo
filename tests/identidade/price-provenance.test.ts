import { describe, expect, it } from "vitest";
import {
  assertPriceProvenance,
  hasRecomputablePriceEvidence,
  hasRecomputableClvEvidence,
  isPriceSnapshotComponent,
  quarterPriceSnapshot,
  recomputePriceSnapshot,
  singlePriceSnapshot,
} from "@/src/domain/price-provenance";

describe("proveniência recalculável de preço", () => {
  const observedAt = new Date("2026-08-24T10:00:00Z");
  it("recalcula book de três vias sem cache/provider", () => {
    const snapshot = singlePriceSnapshot({
      rawOdds: [1.91, 3.4, 4.2],
      selectedIndex: 1,
      devig: "auto",
    });
    const recalculated = recomputePriceSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(recalculated?.raw).toBe(3.4);
    expect(recalculated?.fair).toBeGreaterThan(3.4);
  });

  it("recalcula a quarter line pela conta exata de cada lado", () => {
    // Books sem margem: o devig power devolve as próprias odds, e a justa de
    // cada componente é 1 + perde/ganha da distribuição de gols do teste de odds.
    const ah0 = [1 + 0.28 / 0.45, 1 + 0.45 / 0.28];
    const ahHalf = [1 + 0.55 / 0.45, 1 + 0.45 / 0.55];
    const home = recomputePriceSnapshot(quarterPriceSnapshot("spread", [
      { lineQ: -2, rawOdds: ahHalf, selectedIndex: 0, devig: "power" },
      { lineQ: 0, rawOdds: ah0, selectedIndex: 0, devig: "power" },
    ]));
    // Casa −0,25: meia linha mais difícil → média das justas.
    expect(home?.fair).toBeCloseTo(1 + (0.28 + 0.55) / 0.9, 9);
    expect(home?.raw).toBeCloseTo(1 + (0.28 + 0.55) / 0.9, 9);
    // Fora +0,25 no mesmo book: a linha da casa troca de sinal.
    const away = recomputePriceSnapshot(quarterPriceSnapshot("spread", [
      { lineQ: -2, rawOdds: ahHalf, selectedIndex: 1, devig: "power" },
      { lineQ: 0, rawOdds: ah0, selectedIndex: 1, devig: "power" },
    ]));
    expect(away?.fair).toBeCloseTo(1 + (0.45 + 0.45) / (0.28 + 0.55), 9);
  });

  it("não recalcula a combinação por média de probabilidades", () => {
    const snapshot = quarterPriceSnapshot("total", [
      { lineQ: 8, rawOdds: [1.5, 3], selectedIndex: 0, devig: "power" },
      { lineQ: 10, rawOdds: [2, 2], selectedIndex: 0, devig: "power" },
    ]);
    expect(recomputePriceSnapshot(snapshot)?.fair).toBeCloseTo(1.75, 9);
    expect(recomputePriceSnapshot({ ...snapshot, combination: "quarter-average" } as never)).toBeNull();
    expect(recomputePriceSnapshot({ ...snapshot, market: undefined })).toBeNull();
  });

  it.each([
    ["total", 8, 10, 0], ["total", 8, 10, 1],
    ["spread", 0, -2, 0], ["spread", 0, -2, 1],
  ] as const)("recusa componentes de quarto incompatíveis com uma distribuição de resultados (%s, %s, %s, %s)",
    (market, firstLine, secondLine, selectedIndex) => {
      // Sem margem: a linha mais difícil paga MENOS. Implicaria probabilidade
      // negativa no resultado que anula o componente inteiro.
      const price = quarterPriceSnapshot(market, [
        { lineQ: firstLine, rawOdds: [2.5, 5 / 3], selectedIndex, devig: "power" },
        { lineQ: secondLine, rawOdds: [2, 2], selectedIndex, devig: "power" },
      ]);
      expect(recomputePriceSnapshot(price)).toBeNull();
    });

  it("a coerência do quarto compara justas e permite margens diferentes nas brutas", () => {
    const snapshot = quarterPriceSnapshot("total", [
      { lineQ: 8, rawOdds: [1.5, 3], selectedIndex: 0, devig: "power" },
      { lineQ: 10, rawOdds: [1.49, 2], selectedIndex: 0, devig: "power" },
    ]);
    // Bruta da linha mais difícil menor, mas a justa dela é maior: distribuição válida.
    expect(recomputePriceSnapshot(snapshot)?.fair).toBeGreaterThan(1.5);
    const reversed = { ...snapshot, components: [...snapshot.components].reverse() };
    expect(recomputePriceSnapshot(reversed)).toEqual(recomputePriceSnapshot(snapshot));
    const withoutPush = quarterPriceSnapshot("total", [
      { lineQ: 8, rawOdds: [2, 2], selectedIndex: 0, devig: "power" },
      { lineQ: 10, rawOdds: [2, 2], selectedIndex: 0, devig: "power" },
    ]);
    expect(recomputePriceSnapshot(withoutPush)).toEqual({ raw: 2, fair: 2 });
  });

  it("linha de quarto combinada continua recalculável depois de gravada nas escalas das colunas", () => {
    // Over 2,75: a meia linha é o componente mais fácil, e a conta harmônica dá
    // uma bruta com dízima que a coluna de 4 casas arredonda.
    const snapshot = quarterPriceSnapshot("total", [
      { lineQ: 10, rawOdds: [1.87, 2.03], selectedIndex: 0, devig: "power" },
      { lineQ: 12, rawOdds: [2.36, 1.63], selectedIndex: 0, devig: "power" },
    ]);
    const recomputed = recomputePriceSnapshot(snapshot)!;
    const round = (value: number, places: number) => Number(value.toFixed(places));
    expect(round(recomputed.raw, 4)).not.toBe(recomputed.raw);
    const stored = { fair: round(recomputed.fair, 6), raw: round(recomputed.raw, 4) };
    const base = { snapshot, provider: "bridgeodds", observedAt };
    expect(hasRecomputablePriceEvidence({ ...stored, ...base })).toBe(true);
    expect(hasRecomputablePriceEvidence({ ...stored, raw: stored.raw + 0.001, ...base })).toBe(false);
    expect(hasRecomputablePriceEvidence({ ...stored, fair: stored.fair + 0.00001, ...base })).toBe(false);
  });

  it("recusa versão ou seleção que não pode ser reproduzida", () => {
    const snapshot = singlePriceSnapshot({ rawOdds: [1.9, 1.9], selectedIndex: 0, devig: "power" });
    expect(recomputePriceSnapshot({ ...snapshot, version: 2 as 1 })).toBeNull();
    expect(recomputePriceSnapshot({
      ...snapshot,
      components: [{ ...snapshot.components[0]!, selectedIndex: 9 }],
    })).toBeNull();
    expect(() => recomputePriceSnapshot({ components: null } as never)).not.toThrow();
    expect(recomputePriceSnapshot({ components: null } as never)).toBeNull();
  });

  it("bloqueia writer com snapshot divergente ou atribuição incompleta", () => {
    const snapshot = singlePriceSnapshot({
      rawOdds: [1.9, 2.05],
      selectedIndex: 0,
      devig: "power",
    });
    const recomputed = recomputePriceSnapshot(snapshot)!;
    expect(() => assertPriceProvenance({
      ...recomputed,
      snapshot,
      provider: "bridgeodds",
      reference: "bridgeodds:v1:42",
      requireReference: true,
      observedAt,
    })).not.toThrow();
    expect(() => assertPriceProvenance({
      fair: recomputed.fair + 0.01,
      raw: recomputed.raw,
      snapshot,
      provider: "bridgeodds",
      observedAt,
    })).toThrow(/divergem/);
    expect(() => assertPriceProvenance({
      ...recomputed,
      snapshot: null,
      provider: "bridgeodds",
      observedAt,
    })).toThrow(/snapshot/);
    expect(() => assertPriceProvenance({
      ...recomputed,
      snapshot,
      provider: "bridgeodds",
      reference: null,
      requireReference: true,
      observedAt,
    })).toThrow(/referência tipada/);
    expect(() => assertPriceProvenance({
      ...recomputed,
      snapshot,
      provider: "evil",
      reference: "evil:anything",
      requireReference: true,
      observedAt,
    })).toThrow(/referência tipada/);
    expect(() => assertPriceProvenance({
      ...recomputed,
      snapshot,
      provider: "pinnacle17",
      reference: "pinnacle17:garbage",
      requireReference: true,
      observedAt,
    })).toThrow(/referência tipada/);
    expect(() => assertPriceProvenance({
      ...recomputed,
      snapshot,
      provider: "bridgeodds",
      reference: "bridgeodds:v1:42",
      requireReference: true,
    })).toThrow(/instante real/);
  });
});

describe("isPriceSnapshotComponent e imutabilidade", () => {
  it("snapshots de preço exigem lineQ inteiro e validam limites de selectedIndex", () => {
    const single = singlePriceSnapshot({
      rawOdds: [1.95, 1.95],
      selectedIndex: 0,
      devig: "power",
    });
    expect(Object.isFrozen(single)).toBe(true);
    expect(Object.isFrozen(single.components)).toBe(true);
    expect(Object.isFrozen(single.components[0]?.rawOdds)).toBe(true);

    const quarter = quarterPriceSnapshot("total", [
      { lineQ: 10, rawOdds: [1.9, 2.0], selectedIndex: 0, devig: "power" },
      { lineQ: 11, rawOdds: [1.85, 2.05], selectedIndex: 1, devig: "power" },
    ]);
    expect(Object.isFrozen(quarter)).toBe(true);
    expect(Object.isFrozen(quarter.components)).toBe(true);
    expect(Object.isFrozen(quarter.components[0]?.rawOdds)).toBe(true);

    // Validação de lineQ inteiro
    expect(
      isPriceSnapshotComponent({
        lineQ: 35.5, // Não é inteiro!
        rawOdds: [1.9, 2.0],
        selectedIndex: 0,
        devig: "power",
      })
    ).toBe(false);

    // Validação de limites do selectedIndex
    expect(
      isPriceSnapshotComponent({
        lineQ: null,
        rawOdds: [1.9, 2.0],
        selectedIndex: 5, // Fora do array!
        devig: "power",
      })
    ).toBe(false);
  });
});

describe("prova da fórmula do CLV", () => {
  const snapshot = singlePriceSnapshot({ rawOdds: [1.91, 1.87], selectedIndex: 0, devig: "power" });
  const exact = recomputePriceSnapshot(snapshot)!;
  const proof = { snapshot, fair: Number(exact.fair.toFixed(6)), raw: exact.raw, provider: "bridgeodds",
    reference: "bridgeodds:v1:clv", requireReference: true, observedAt: new Date("2026-10-09T12:00:00Z"), odds: 2 };
  it("aceita a precisão persistida do CLV e a base arredondada usada pela edição", () => {
    expect(hasRecomputableClvEvidence({ ...proof, clv: -1.1524 })).toBe(true);
    expect(hasRecomputableClvEvidence({ ...proof, clv: -1.1525 })).toBe(true);
    expect(hasRecomputableClvEvidence({ ...proof, clv: -1.1526 })).toBe(false);
  });
  it.each([0, 5, null, Number.NaN, Number.POSITIVE_INFINITY])("recusa CLV ausente ou divergente (%s)", (clv) => {
    expect(hasRecomputableClvEvidence({ ...proof, clv })).toBe(false);
  });
  it("recusa a odd inválida e a divergência entre o preço persistido e o book", () => {
    expect(hasRecomputableClvEvidence({ ...proof, odds: 1, clv: -1.1524 })).toBe(false);
    expect(hasRecomputableClvEvidence({ ...proof, fair: proof.fair + 0.001, clv: -1.1524 })).toBe(false);
  });
});


describe("coerência entre referência Pinnacle17 e snapshot", () => {
  const observedAt = new Date("2026-10-09T12:00:00Z");
  it.each([
    ["moneyline:ml:home", null, 1, [2, 3, 4]],
    ["moneyline:ml:draw", null, 1, [2, 2]],
    ["moneyline:ml:home", 10, 0, [2, 2]],
    ["total:10:over", 12, 0, [2, 2]],
    ["total:10:under", 10, 0, [2, 2]],
    ["spread:-2:away", 2, 1, [2, 2]],
    ["total:10:over", 10, 0, [2, 3, 4]],
    ["team_total:10:away_under", 10, 0, [2, 2]],
  ] as const)("não publica um book de outros termos (%s)", (terms, lineQ, selectedIndex, rawOdds) => {
    const snapshot = singlePriceSnapshot({ lineQ, selectedIndex, rawOdds, devig: "auto" });
    const price = recomputePriceSnapshot(snapshot)!;
    expect(price).not.toBeNull();
    expect(hasRecomputablePriceEvidence({ ...price, snapshot, provider: "pinnacle17",
      reference: `pinnacle17:v2:123:0:${terms}:goals`, requireReference: true, observedAt })).toBe(false);
  });
  it.each([
    ["moneyline:ml:home", null, 0, [2, 3, 4]],
    ["moneyline:ml:draw", null, 1, [2, 3, 4]],
    ["moneyline:ml:away", null, 2, [2, 3, 4]],
    ["moneyline:ml:away", null, 1, [2, 2]],
    ["spread:-2:away", -2, 1, [2, 2]],
    ["total:11:over", 11, 0, [2, 2]],
    ["team_total:10:home_under", 10, 1, [2, 2]],
  ] as const)("preserva a referência legítima (%s)", (terms, lineQ, selectedIndex, rawOdds) => {
    const snapshot = singlePriceSnapshot({ lineQ, selectedIndex, rawOdds, devig: "auto" });
    const price = recomputePriceSnapshot(snapshot)!;
    expect(hasRecomputablePriceEvidence({ ...price, snapshot, provider: "pinnacle17",
      reference: `pinnacle17:v2:123:0:${terms}:goals`, requireReference: true, observedAt })).toBe(true);
  });
});
