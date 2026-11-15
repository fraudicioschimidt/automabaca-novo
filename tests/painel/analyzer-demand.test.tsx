// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzerScreen } from "@/app/_design/screens/AnalyzerScreen";
import * as periods from "@/src/domain/analyzer/periodo";
import { testedAnData } from "@/app/_design/lib/tested-analyzer";
import { ANALYZER_MOCK_DATA } from "@/app/_design/mock/analyzer-data";
import { renderClickable, waitUntil } from "../helpers/click-render";

vi.mock("@/app/_design/AppSidebar", () => ({ AppSidebar: () => null }));
let view: ReturnType<typeof renderClickable> | undefined;
const names = ["D", "E", "S", "Z", "P", "segData", "K"] as const;

beforeEach(() => {
  localStorage.clear();
  for (const name of names) vi.spyOn(testedAnData, name);
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
});

/**
 * Cada aba é `lazy`: o teste espera ela montar, dentro do `act`. Sem isso o
 * import terminava depois do teste, e o aviso do React sobre o recurso que
 * carregou fora do `act` chegava com o ambiente já fechando.
 */
async function tabLoaded(): Promise<void> {
  await waitUntil(() => view && !view.container.querySelector('[aria-busy="true"]'), "aba carregada");
}

async function mount() {
  await act(async () => {
    view = renderClickable(<AnalyzerScreen data={ANALYZER_MOCK_DATA} slug="treino" />);
  });
  await tabLoaded();
}

describe("cálculos do Analyzer sob demanda", () => {

  it("a visão geral usa os meses sem calcular semanas e dias do Período", async () => {
    const fullPeriods = vi.spyOn(periods, "computePeriodoV1");
    await mount();
    expect(view!.container.textContent).toContain("Lucro mensal");
    expect(fullPeriods).not.toHaveBeenCalled();
  });

  it("abre a visão geral sem calcular as outras abas", async () => {
    await mount();
    expect(testedAnData.D).toHaveBeenCalled();
    for (const name of ["E", "S", "Z", "P", "segData", "K"] as const) {
      expect(testedAnData[name]).not.toHaveBeenCalled();
    }
  });

  it("calcula apenas a aba selecionada e o comparativo correspondente", async () => {
    localStorage.setItem("automabaca:ui:analyzer:range", JSON.stringify("7d"));
    await mount();
    for (const name of names) vi.mocked(testedAnData[name]).mockClear();
    const mounted = view;
    if (!mounted) throw new Error("Tela não montada");

    await act(async () => mounted.click("CLV"));
    await tabLoaded();
    // Janela atual e janela anterior, sem refazer overview/steam/liquidez.
    expect(testedAnData.E).toHaveBeenCalledTimes(2);
    for (const name of ["D", "S", "Z", "P", "segData"] as const) {
      expect(testedAnData[name]).not.toHaveBeenCalled();
    }

    await act(async () => mounted.click("Casas"));
    await tabLoaded();
    expect(testedAnData.P).toHaveBeenCalledOnce();
    expect(testedAnData.Z).not.toHaveBeenCalled();
    expect(testedAnData.E).toHaveBeenCalledTimes(2);

    await act(async () => mounted.click("Segmentos"));
    await tabLoaded();
    expect(testedAnData.Z).toHaveBeenCalledOnce();
    expect(testedAnData.segData).toHaveBeenCalledOnce();
    expect(testedAnData.K).not.toHaveBeenCalled();

    // O simulador não tem comparativo: roda uma vez, só sobre a janela atual.
    await act(async () => mounted.click("Simulador"));
    await tabLoaded();
    expect(testedAnData.K).toHaveBeenCalledOnce();
  });
});

describe("recorte do Analyzer pelo dia do jogo", () => {
  it("o cartão diz o eixo e conta a pendente de jogo futuro no recorte com prazo", async () => {
    localStorage.setItem("automabaca:ui:analyzer:range", JSON.stringify("hoje"));
    const { bets, today } = ANALYZER_MOCK_DATA;
    const future = bets.filter((bet) => bet[0] > today && bet[10] === "PENDING").length;
    const played = bets.filter((bet) => bet[0] === today).length;
    expect(future).toBeGreaterThan(1);
    expect(bets.some((bet) => bet[0] > today && bet[10] !== "PENDING")).toBe(false);
    await mount();
    const text = view!.container.textContent ?? "";
    expect(text).toContain(`${played + future} apostas no recorte · pelo dia do jogo`);
    expect(text).toContain(`inclui ${future} pendentes de jogos futuros`);
  });
});

describe("Analyzer sem dado", () => {
  // A aba que mostra o período carrega sob demanda: compilada antes do caso,
  // com a CI cheia a compilação sozinha passava do prazo do teste.
  beforeAll(async () => {
    await import("@/app/_design/screens/analyzer/overview-tab");
  }, 60_000);

  it("o \"hoje\" do seletor é o dia corrente de São Paulo, não uma data fixa", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 02:30 UTC de 24/09 ainda é 23/09 em São Paulo.
    vi.setSystemTime(new Date("2026-09-24T02:30:00Z"));
    try {
      await act(async () => {
        view = renderClickable(<AnalyzerScreen data={null} />);
      });
      // A aba carrega sob demanda: espera o cartão de período aparecer.
      await waitUntil(() => view!.container.textContent?.includes("Hoje ("), "cartão de período");
      expect(view!.container.textContent).toContain("Hoje (23/09)");
    } finally {
      vi.useRealTimers();
    }
  });
});


describe("períodos encerrados com reembolso", () => {
  it.each(["overview", "periodo"])("%s não declara pendência por apostas anuladas", async (tab) => {
    localStorage.setItem("automabaca:ui:analyzer:range", JSON.stringify("tudo"));
    localStorage.setItem("automabaca:ui:analyzer:tab", JSON.stringify(tab));
    const data = { ...ANALYZER_MOCK_DATA, bets: ANALYZER_MOCK_DATA.bets.slice(0, 3).map((bet, i) => {
      const copy = [...bet] as typeof bet;
      copy[10] = i === 0 ? "WON" : i === 1 ? "VOID" : "CANCELED";
      copy[11] = i === 0 ? 1 : 0;
      copy[21] = copy[1];
      return copy;
    }) };
    await act(async () => { view = renderClickable(<AnalyzerScreen data={data} slug="treino" />); });
    await tabLoaded();
    const text = view!.container.textContent ?? "";
    expect(text).toContain(tab === "overview" ? "Lucro total" : "Lucro diário acumulado");
    expect(text).not.toContain("A curva ainda não terminou");
    expect(text).not.toContain("ainda não liquid");
    if (tab === "overview") expect(text).toContain("0 pendentes");
  });
});
