import { describe, expect, it } from "vitest";
import { renderDesignMarkup } from "../helpers/design-markup";
import { LiquidezTab } from "@/app/_design/screens/analyzer/liquidez-tab";
import { OddsTrajectory } from "@/app/_design/screens/aposta/odds-trajectory";
import { testedAnData } from "@/app/_design/lib/tested-analyzer";
import { unpackAnalyzerBet } from "@/app/_design/lib/analyzer-pack";
import { ANALYZER_MOCK_DATA } from "@/app/_design/mock/analyzer-data";

it("explica a métrica e mostra cobertura zero quando só o CLV está disponível", () => {
  const bet = { ...unpackAnalyzerBet(ANALYZER_MOCK_DATA.bets[0]!), closingMaxBet: null, clv: 2, clvReliable: true,
    closingFetchedAt: new Date("2026-10-10T12:00:00Z"), noOddsReason: null, closingNoOddsReason: null };
  const html = renderDesignMarkup(<LiquidezTab periodCard={null} Z={testedAnData.Z([bet])} abrirRecorte={() => undefined} />);
  expect(html).toContain("Limite máximo informado pelo fornecedor");
  expect(html).toContain("cobertura 0% — 0 de 1 alcançável");
  expect(html).toContain("Variação do limite cotado");
});

describe("limite da trajetória", () => {
  it("exibe as frações do limite cotado", () => {
    const html = renderDesignMarkup(<OddsTrajectory lineColor="#111111" steps={[
      { key: "closing", label: "Fechamento", odd: 2, liq: 499.75 },
    ]} />);
    expect(html).toContain("Limite cotado · $499.75");
  });
});
