// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzerScreen } from "@/app/_design/screens/AnalyzerScreen";
import { ANALYZER_MOCK_DATA, ANALYZER_PORTFOLIO_MOCK_DATA } from "@/app/_design/mock/analyzer-data";
import { ChannelMarketCard, SuggestedCutsCard } from "@/app/_design/screens/analyzer/portfolio-cards";
import { testedAnData } from "@/app/_design/lib/tested-analyzer";
import { unpackAnalyzerBet } from "@/app/_design/lib/analyzer-pack";
import { renderDesignMarkup } from "../helpers/design-markup";
import { renderClickable, waitUntil } from "../helpers/click-render";

/** O Analyzer da carteira: dinheiro em reais, dimensão Canal, matriz e cortes. */

vi.mock("@/app/_design/AppSidebar", () => ({ AppSidebar: () => null }));
let view: ReturnType<typeof renderClickable> | undefined;

beforeAll(async () => {
  // As abas carregam sob demanda: compiladas antes, para o prazo ser o do passo.
  await import("@/app/_design/screens/analyzer/segmentos-tab");
  await import("@/app/_design/screens/analyzer/overview-tab");
  await import("@/app/_design/screens/analyzer/gaveta-de-apostas");
  await import("@/app/_design/kit/overlay-sheet");
}, 60_000);
beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  view?.unmount();
  view = undefined;
  document.body.innerHTML = "";
});

async function mount(data: typeof ANALYZER_MOCK_DATA, tab: string) {
  localStorage.setItem("automabaca:ui:analyzer:tab", JSON.stringify(tab));
  await act(async () => {
    view = renderClickable(<AnalyzerScreen data={data} slug={data.bk.slug} />);
  });
  return view!;
}

describe("Analyzer da carteira", () => {
  it("escreve o dinheiro em reais e volta para as bancas", async () => {
    const tela = await mount(ANALYZER_PORTFOLIO_MOCK_DATA, "overview");
    await waitUntil(() => tela.container.textContent?.includes("Lucro total"), "visão geral");
    const texto = tela.container.textContent ?? "";
    expect(texto).toContain("R$");
    expect(texto).toContain("Barras: lucro em reais.");
    expect(texto).not.toMatch(/\d\.\d\du\b/);
    expect(tela.container.querySelector('a[aria-label="Voltar para os tipsters"]')?.getAttribute("href")).toBe("/tipsters");
  });

  it("abre os segmentos em Canal, com os cortes decididos pelo CLV e a matriz canal × mercado", async () => {
    const tela = await mount(ANALYZER_PORTFOLIO_MOCK_DATA, "segmentos");
    await waitUntil(() => tela.container.textContent?.includes("Cortes sugeridos"), "cartão de cortes");
    const chips = [...tela.container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(chips).toEqual(expect.arrayContaining(["Canal", "Esporte", "Mercado"]));
    // O canal × mercado com CLV claramente negativo e amostra de sobra é o corte;
    // o de CLV negativo sem significância (Handicap BR) não é.
    const cortes = tela.container.querySelector('[aria-label="Tabela de dados"]');
    expect(cortes?.textContent).toContain("Tênis Pro · Money Line – Match");
    expect(cortes?.textContent).not.toContain("Handicap BR");
    const matriz = tela.container.querySelector('[aria-label="Matriz canal × mercado"]');
    expect(matriz?.textContent).toContain("Gols & Cantos");
    const celulaDoCorte = matriz?.querySelector('button[aria-label*="Tênis Pro · Money Line – Match"]');
    expect(celulaDoCorte?.getAttribute("aria-label")).toContain("corte sugerido");
    expect(celulaDoCorte?.textContent).toContain("corte");
  });

  it("a célula abre a gaveta com as apostas dela e o resumo em reais", async () => {
    const tela = await mount(ANALYZER_PORTFOLIO_MOCK_DATA, "segmentos");
    const celula = await waitUntil(
      () => document.querySelector<HTMLButtonElement>('button[aria-label^="Ver as 40 apostas de Tênis Pro · Money Line – Match"]'),
      "célula do corte",
    );
    act(() => { celula.click(); });
    const gaveta = await waitUntil(() => document.querySelector('[role="dialog"]'), "gaveta");
    await waitUntil(() => gaveta.textContent?.includes("Stake"), "resumo da gaveta");
    expect(gaveta.textContent).toContain("Tênis Pro · Money Line – Match");
    expect(gaveta.textContent).toContain("R$");
    // Cada aposta da lista diz de qual banca veio.
    expect(gaveta.querySelector('[aria-label^="Apostas do recorte"]')?.textContent).toContain("Tênis Pro");
    expect(tela.container.textContent).toContain("Canal × mercado");
  });
});

describe("Analyzer da banca", () => {
  it("continua em unidades e sem a dimensão Canal", async () => {
    const tela = await mount(ANALYZER_MOCK_DATA, "segmentos");
    await waitUntil(() => tela.container.textContent?.includes("Ranking por lucro"), "aba segmentos");
    const chips = [...tela.container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(chips).not.toContain("Canal");
    expect(tela.container.textContent).not.toContain("Cortes sugeridos");
    expect(tela.container.textContent).not.toContain("R$");
    expect(tela.container.textContent).toMatch(/\d\.\d\du/);
  });
});


describe("identidade e base dos cortes", () => {
  function portfolio() {
    const base = unpackAnalyzerBet(ANALYZER_PORTFOLIO_MOCK_DATA.bets[0]!);
    const bets = Array.from({ length: 60 }, (_, i) => ({
      ...base, id: `cut-${i}`, bankrollName: i < 30 ? "Canal · Total" : "Canal",
      mercado: i < 30 ? "Gols" : "Total · Gols", status: i < 30 ? "LOST" : "WON",
      lucro: i < 30 ? -1 : 1, stake: 1, clv: i < 30 ? -4 : 4, clvReliable: true,
      evento: `Time ${i} vs Rival`, data: new Date("2026-09-01T12:00:00Z"), settledAt: new Date("2026-09-01T15:00:00Z"),
      sourcePostedAt: new Date("2026-09-01T10:00:00Z"), registradoEm: new Date("2026-09-01T10:00:00Z"),
      closingFetchedAt: new Date("2026-09-01T12:00:00Z"),
    }));
    return testedAnData.C(bets);
  }

  it("rótulos iguais não transferem o corte a outra combinação de canal e mercado", () => {
    const carteira = portfolio();
    expect(carteira.cuts).toHaveLength(1);
    const root = document.createElement("div");
    root.innerHTML = renderDesignMarkup(<ChannelMarketCard carteira={carteira} abrirRecorte={() => undefined} />);
    const cells = [...root.querySelectorAll('button[aria-label^="Ver as"]')];
    expect(cells).toHaveLength(2);
    const positive = cells.find((cell) => cell.getAttribute("aria-label")?.includes("CLV médio +4.0%"));
    const negative = cells.find((cell) => cell.getAttribute("aria-label")?.includes("CLV médio -4.0%"));
    expect(positive).toBeDefined();
    expect(negative?.getAttribute("aria-label")).toContain("corte sugerido");
    expect(positive?.getAttribute("aria-label")).not.toContain("corte sugerido");
  });

  it("declara a seleção retrospectiva quando o mesmo histórico escolhe e avalia os cortes", () => {
    const carteira = portfolio();
    // Nenhum fechamento existia no post; excluir os perdedores ainda eleva o lucro histórico.
    expect(carteira.portfolio.lucro).toBe(0);
    expect(carteira.withoutCuts.lucro).toBe(30);
    const html = renderDesignMarkup(<SuggestedCutsCard carteira={carteira} abrirRecorte={() => undefined} />);
    expect(html).toContain("Comparação retrospectiva");
    expect(html).toContain("observações independentes");
    expect(html).toContain("sem ajuste para múltiplas comparações");
    expect(html).toContain("CLVs constantes usam o sinal");
    expect(html).toContain("mesmo recorte");
    expect(html).toContain("apostas removidas");
  });
});
