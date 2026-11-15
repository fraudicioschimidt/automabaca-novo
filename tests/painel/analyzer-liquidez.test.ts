import { describe, expect, it } from "vitest";
import { singlePriceSnapshot, quarterPriceSnapshot } from "@/src/domain/price-provenance";
import { comparableUsdLiquidity, quotedLiquidityLimit } from "@/src/domain/liquidity";
import { computeLiquidezV1 } from "@/src/domain/analyzer/liquidez";
import { maxBetCurrencyForProvider } from "@/src/services/sharp/liquidity-currency";
import type { Env } from "@/src/infra/env";
import type { BetRowData } from "@/src/domain/bet-read-model";

function bet(overrides: Partial<BetRowData> = {}): BetRowData {
  return {
    id: "bet",
    data: new Date("2026-08-23T18:00:00Z"),
    evento: "Casa vs Fora",
    competicao: "Liga",
    pais: "Brasil",
    esporte: "Soccer",
    mercado: "Money Line – Match",
    selecao: "Casa",
    casaDeAposta: "Bet365",
    tipster: "Canal",
    odds: 2,
    stake: 1,
    status: "WON",
    lucro: 1,
    closingOdd: 1.9,
    closingMaxBet: 3_000,
    openingMaxBet: 2_000,
    closingMaxBetCurrency: "USD",
    openingMaxBetCurrency: "USD",
    openingOdd: 2,
    openingRawOdd: 1.95,
    closingRawOdd: 1.9,
    registradoEm: new Date("2026-08-23T15:00:00Z"),
    settledAt: new Date("2026-08-23T20:00:00Z"),
    clv: 5,
    clvReliable: true,
    closingFetchedAt: new Date("2026-08-23T18:00:00Z"),
    identityStatus: "MATCHED",
    noOddsReason: null,
    closingNoOddsReason: null,
    source: "test",
    sourceExternalId: null,
    contaTitular: null,
    ...overrides,
  };
}

describe("liquidez com unidade comprovada", () => {
  it("não transforma valor bruto sem moeda conhecida em dólares", () => {
    expect(comparableUsdLiquidity(3_000, null)).toBeNull();
    expect(comparableUsdLiquidity(3_000, "BRL")).toBeNull();
    expect(comparableUsdLiquidity(3_000, "USD")).toBe(3_000);

    const result = computeLiquidezV1([
      bet({ closingMaxBetCurrency: null, openingMaxBetCurrency: null }),
    ]);
    expect(result.totalWithClosingLiq).toBe(0);
    expect(result.totalWithOpeningLiq).toBe(0);
    expect(result.byClosingLiq).toEqual([]);
  });

  it("mantém maxRiskStake Pinnacle17 bruto até a moeda ser confirmada", () => {
    const env = { PINNACLE17_MAX_BET_CURRENCY: undefined } as unknown as Env;
    expect(maxBetCurrencyForProvider("pinnacle17", env)).toBeNull();
    expect(maxBetCurrencyForProvider("pinnacle17", {
      ...env,
      PINNACLE17_MAX_BET_CURRENCY: "USD",
    })).toBe("USD");
  });

  it("agrega USD e só calcula momentum entre snapshots comparáveis", () => {
    const result = computeLiquidezV1([
      bet({ id: "usd", openingMaxBet: 1_000, closingMaxBet: 1_200 }),
      bet({
        id: "mixed",
        openingMaxBet: 1_000,
        openingMaxBetCurrency: "BRL",
        closingMaxBet: 1_200,
        closingMaxBetCurrency: "USD",
      }),
    ]);

    expect(result.totalWithOpeningLiq).toBe(1);
    expect(result.totalWithClosingLiq).toBe(2);
    expect(result.byClosingLiq.map((row) => row.label)).toEqual(["$500–2k"]);
    expect(result.momentum.find((row) => row.key === "crescendo")?.bets).toBe(1);
  });
});

describe("limite cotado e precisão", () => {
  it("usa o limite exato do snapshot e mantém a leitura de snapshots sem limite", () => {
    const base = { rawOdds: [2, 2], selectedIndex: 0, devig: "power" as const };
    expect(quotedLiquidityLimit(singlePriceSnapshot({ ...base, maxBet: 499.75 }), 499)).toBe(499.75);
    expect(quotedLiquidityLimit(singlePriceSnapshot(base), 500)).toBe(500);
    expect(quotedLiquidityLimit(singlePriceSnapshot({ ...base, lineQ: 9, maxBet: 80 }), 80)).toBe(80);
    expect(quotedLiquidityLimit(singlePriceSnapshot({ ...base, maxBet: 0 }), 500)).toBeNull();
  });

  it("limite antigo de quarter sintética não vira liquidez de uma linha cotada", () => {
    const a = singlePriceSnapshot({ rawOdds: [2, 2], selectedIndex: 0, devig: "power", lineQ: 8 });
    const b = singlePriceSnapshot({ rawOdds: [2, 2], selectedIndex: 0, devig: "power", lineQ: 10 });
    expect(quotedLiquidityLimit(quarterPriceSnapshot("total", [a.components[0]!, b.components[0]!]), 80)).toBeNull();
  });

  it("as frações do limite preservam a classificação perto do corte de 15%", () => {
    const result = computeLiquidezV1([bet({ openingMaxBet: 1_000.75, closingMaxBet: 1_150.75 })]);
    expect(result.momentum.find(row => row.key === "estavel")?.bets).toBe(1);
    expect(result.momentum.find(row => row.key === "crescendo")?.bets).toBe(0);
  });
});
