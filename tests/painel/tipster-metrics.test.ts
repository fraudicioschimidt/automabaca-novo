import { describe, expect, it } from "vitest";
import {
  aggregateTipsterMetrics,
  compareTipsterMetric,
  compareTipstersByKey,
} from "@/app/_design/lib/tipster-metrics";

const row = (over: Record<string, unknown> = {}) => ({
  lucro: 0,
  staked: 0,
  profitBrl: 0,
  stakedBrl: 0,
  wins: 0,
  losses: 0,
  clv: 0,
  clvSamples: 0,
  hasRoi: false,
  hasClv: false,
  hasAcerto: false,
  ...over,
});

describe("métricas agregadas de bankrolls", () => {
  it("preserva precisão no ROI e pondera o CLV pela sua própria amostra", () => {
    const result = aggregateTipsterMetrics([
      row({ lucro: 0.105, staked: 1.25, profitBrl: 0.105, stakedBrl: 1.25, wins: 1, clv: 4, clvSamples: 2 }),
      row({ lucro: -0.005, staked: 0.75, profitBrl: -0.005, stakedBrl: 0.75, losses: 1, clv: -2, clvSamples: 1 }),
    ]);
    expect(result.lucro).toBe(0.1);
    expect(result.staked).toBe(2);
    expect(result.roi).toBeCloseTo(5, 8);
    expect(result.clv).toBeCloseTo(2, 8);
    expect(result.winrate).toBeCloseTo(50, 8);
  });

  it("não inventa zero quando não existe amostra e ordena ausentes por último", () => {
    const missing = row({ clv: 0, hasClv: false });
    const negative = row({ clv: -3, clvSamples: 2, hasClv: true });
    const aggregate = aggregateTipsterMetrics([missing]);
    expect(aggregate.roi).toBeNull();
    expect(aggregate.clv).toBeNull();
    expect(aggregate.winrate).toBeNull();
    expect([missing, negative].sort((a, b) => compareTipsterMetric(a, b, "clv"))[0]).toBe(negative);
  });

  it("chave CLV do ranking usa o piso do veredito, não um fecho só", () => {
    const curta = row({ name: "curta", clv: 18, clvSamples: 1, hasClv: true, veredito: "AMOSTRA_CURTA", tStat: null });
    const edge = row({ name: "edge", clv: 1, clvSamples: 40, hasClv: true, veredito: "EDGE", tStat: 2.4 });
    expect([curta, edge].sort((a, b) => compareTipstersByKey(a, b, "clv"))[0]).toBe(edge);
  });
});

describe("consolidação monetária", () => {
  it("não confunde lucro em unidades com dinheiro e pondera o ROI pelo capital apostado", () => {
    const result = aggregateTipsterMetrics([
      row({ lucro: 2, staked: 2, profitBrl: 20, stakedBrl: 20, wins: 1 }),
      row({ lucro: -1, staked: 1, profitBrl: -100, stakedBrl: 100, losses: 1 }),
    ]);
    expect(result.lucro).toBe(-80);
    expect(result.staked).toBe(120);
    expect(result.roi).toBeCloseTo(-66.66666667);
  });
});

describe("ausência de evidência no ranking", () => {
  it.each(["decisao", "clv"])("o zero de exibição não vence CLV negativo medido: %s", (key) => {
    const empty = row({ name: "Sem fechamento", clv: 0, veredito: "AMOSTRA_CURTA", tStat: null });
    const measured = row({ name: "Com fechamento", clv: -2, clvSamples: 1, hasClv: true, veredito: "AMOSTRA_CURTA", tStat: null });
    expect([empty, measured].sort((a, b) => compareTipstersByKey(a, b, key))[0]).toBe(measured);
  });

  it("decisão sem CLV não empresta a média do resumo financeiro", () => {
    const empty = row({ clv: 20, clvSamples: 1, hasClv: true,
      dec: { veredito: "AMOSTRA_CURTA", tStat: null, clv: null },
    });
    const measured = row({ clv: -2, clvSamples: 1, hasClv: true,
      dec: { veredito: "AMOSTRA_CURTA", tStat: null, clv: -2 },
    });
    expect([empty, measured].sort((a, b) => compareTipstersByKey(a, b, "decisao"))[0]).toBe(measured);
  });
});
