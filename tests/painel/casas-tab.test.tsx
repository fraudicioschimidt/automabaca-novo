import { describe, expect, it } from "vitest";
import { CasasTab } from "@/app/_design/screens/analyzer/casas-tab";
import { testedAnData } from "@/app/_design/lib/tested-analyzer";
import { unpackAnalyzerBet } from "@/app/_design/lib/analyzer-pack";
import { ANALYZER_MOCK_DATA } from "@/app/_design/mock/analyzer-data";
import { renderDesignMarkup } from "../helpers/design-markup";

const base = unpackAnalyzerBet(ANALYZER_MOCK_DATA.bets[0]!);

function house(name: string, openings: number, above: number) {
  return Array.from({ length: openings }, (_, i) => ({ ...base,
    id: `${name}-${i}`, casaDeAposta: name, odds: i < above ? 2.1 : 1.9, openingRawOdd: 2,
  }));
}

function render(bets: typeof base[]) {
  return renderDesignMarkup(<CasasTab P={testedAnData.P(bets)} periodCard={null} abrirRecorte={() => undefined} />);
}

const highlights = (html: string) => html.slice(0, html.indexOf("Top casas por lucro"));
const openingRank = (html: string) => html.slice(html.indexOf("Casas com mais entrada acima da abertura"), html.indexOf("Tabela completa por casa"));

describe("ranking por entrada acima da abertura", () => {
  it("ordena as barras pela taxa anunciada, não pela ordem de captura", () => {
    const html = openingRank(render([
      ...house("Casa Baixa", 10, 2), ...house("Casa Alta", 10, 8), ...house("Casa Média", 10, 5),
    ]));
    expect(html.indexOf("Casa Alta")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("Casa Alta")).toBeLessThan(html.indexOf("Casa Média"));
    expect(html.indexOf("Casa Média")).toBeLessThan(html.indexOf("Casa Baixa"));
  });

  it("uma abertura só não vence o destaque de taxa com amostra suficiente", () => {
    const html = highlights(render([...house("Anedota", 1, 1), ...house("Medida", 5, 3)]));
    const opening = html.slice(html.indexOf("Mais entrada acima da abertura"));
    expect(opening).toContain("Medida");
    expect(opening).toContain("60% de 5 aberturas");
    expect(opening).not.toContain("Anedota");
  });

  it("sem casa no piso, explica a amostra curta sem eleger vencedora", () => {
    const html = highlights(render(house("Anedota", 4, 4)));
    const opening = html.slice(html.indexOf("Mais entrada acima da abertura"));
    expect(opening).toContain("amostra curta");
    expect(opening).not.toContain("Anedota");
  });
});
