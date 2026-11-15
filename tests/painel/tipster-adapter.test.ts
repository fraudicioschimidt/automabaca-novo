import { describe, expect, it } from "vitest";
import { baseTipster } from "@/app/_design/adapters/_tipster";
import type { BankrollSummary } from "@/src/services/painel/queries/bankrolls";

const summary: BankrollSummary = {
  id: "bankroll-1",
  nome: "Big Data",
  slug: "main",
  sharpMode: "CLV_ONLY",
  temCanal: true,
  valorUnidade: 100.4,
  capitalInicial: 10_000,
  apostas: 12,
  pendentes: 2,
  stakePendente: 1.5,
  stakeFinalizada: 8.25,
  lucro: 1.234,
  profitBrl: 123.8936,
  stakedBrl: 828.3,
  roi: 14.95,
  acerto: 62.4,
  resolvidas: 10,
  wins: 6,
  losses: 4,
  halfWins: 0,
  halfLosses: 0,
  clv: 3.2,
  clvSamples: 8,
  clvBase: 10,
  ultimaAtividade: null,
  logoUrl: null,
};

describe("adapter comum de tipsters", () => {
  it("empacota os números e fallbacks usados pelas telas", () => {
    expect(baseTipster(summary)).toMatchObject({
      id: "main",
      name: "Big Data",
      sharpMode: "CLV_ONLY",
      unit: "R$100,4/u",
      n: 12,
      open: 2,
      lucro: 1.234,
      profitBrl: 123.8936,
      stakedBrl: 828.3,
      staked: 8.25,
      hasClv: true,
      last: "sem apostas ainda",
      main: true,
    });
    expect(baseTipster({ ...summary, slug: "secondary", valorUnidade: 0 }))
      .toMatchObject({ unit: "R$0/u", main: false });
  });
});

it("conserva as meias decisões ao consolidar tipsters", async () => {
  const { aggregateTipsterMetrics } = await import("@/app/_design/lib/tipster-metrics");
  const tipster = baseTipster({ ...summary, wins: 1, losses: 1, halfWins: 1, halfLosses: 0 });
  expect(aggregateTipsterMetrics([tipster]).winrate).toBeCloseTo(100 / 3);
});
