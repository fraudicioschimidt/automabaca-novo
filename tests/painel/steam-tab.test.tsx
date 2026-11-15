import { renderDesignMarkup } from "../helpers/design-markup";
import { describe, expect, it } from "vitest";
import { testedAnData } from "@/app/_design/lib/tested-analyzer";
import { SteamTab } from "@/app/_design/screens/analyzer/steam-tab";
import type { BetRowData } from "@/src/domain/bet-read-model";

/** Setas da coluna "Tomada" (`Arrow` em analyzer/shared). */
const SETA_PARA_CIMA = "M10 5v10m0-10l-4 4m4-4l4 4";
const SETA_PARA_BAIXO = "M10 15V5m0 10l-4-4m4 4l4-4";

function aposta(over: Partial<BetRowData>): BetRowData {
  const data = new Date("2026-06-15T19:00:00Z");
  return {
    id: "b1", data, settledAt: data,
    evento: "Flamengo vs Palmeiras", competicao: "Brasileirão", pais: "Brasil",
    esporte: "futebol", mercado: "Total de gols", selecao: "Mais de 2.5",
    casaDeAposta: "Bet365", tipster: "Canal X",
    odds: 1.95, stake: 2, status: "WON", lucro: 1.9,
    closingOdd: 1.95, closingRawOdd: 1.95, closingMaxBet: 500,
    openingOdd: 2.0, openingRawOdd: 2.0, openingMaxBet: 300,
    registradoEm: new Date("2026-06-15T15:00:00Z"),
    clv: 0, clvReliable: true, closingFetchedAt: data,
    identityStatus: "MATCHED", noOddsReason: null, closingNoOddsReason: null,
    source: "telegram-channel:-100123", sourceExternalId: "1", contaTitular: null,
    ...over,
  };
}

function trajetoria(bet: BetRowData): string {
  return renderDesignMarkup(
    <SteamTab
      periodCard={null}
      S={testedAnData.S([bet])}
      anterior={null}
      emCursoAtual={{ pendentes: 0, total: 1 }}
      abrirRecorte={() => undefined}
    />,
  );
}

describe("trajetórias de preço", () => {
  // Fechamento igual à odd tomada: a segunda seta é neutra, e qualquer seta
  // desenhada vem da abertura.
  it("sem abertura, a tomada não ganha direção", () => {
    const html = trajetoria(aposta({ openingOdd: null, openingRawOdd: null, openingMaxBet: null }));
    expect(html).toContain("1.950");
    expect(html).not.toContain(SETA_PARA_CIMA);
    expect(html).not.toContain(SETA_PARA_BAIXO);
  });

  it("com abertura, a seta segue o movimento até a tomada", () => {
    expect(trajetoria(aposta({ openingRawOdd: 1.8 }))).toContain(SETA_PARA_CIMA);
    expect(trajetoria(aposta({ openingRawOdd: 2.1 }))).toContain(SETA_PARA_BAIXO);
  });
});


describe("comparação bruta e CLV", () => {
  it("explicita a referência quando a entrada supera a bruta, mas perde para a fair", () => {
    const bet = aposta({ odds: 1.95, closingRawOdd: 1.9, closingOdd: 2, clv: -2.5,
      openingRawOdd: 2, openingOdd: 2 });
    const data = testedAnData.S([bet]);
    expect(data.meanEF).toBeCloseTo(2.63157895, 8);
    expect(testedAnData.E([bet]).clvMean).toBe(-2.5);
    const html = trajetoria(bet);
    expect(html).toContain("Comparação de odds brutas");
    expect(html).toContain("Fechamento bruto");
    expect(html).toContain("Abertura bruta");
    expect(html).toContain("+2.6%");
    expect(html).not.toContain("o preço já tinha caído");
  });
});
