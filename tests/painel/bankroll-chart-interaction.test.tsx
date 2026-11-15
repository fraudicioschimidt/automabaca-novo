// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BankrollScreen } from "@/app/_design/screens/BankrollScreen";
import { DesignProvider } from "@/app/_design/kit/context";
import { getTheme } from "@/app/_design/theme";
import { BANKROLL_MOCK_DATA } from "@/app/_design/mock/bankroll-data";
import * as summaries from "@/app/_design/lib/resumo-de-apostas";
import { renderClickable, waitUntil } from "../helpers/click-render";

vi.mock("@/app/_design/AppSidebar", () => ({ AppSidebar: () => null }));
let view: ReturnType<typeof renderClickable> | undefined;

// As seções que a tela carrega sob demanda, compiladas antes dos casos: com a
// CI cheia, a compilação sozinha passava do prazo de um teste.
beforeAll(async () => {
  await Promise.all([
    import("@/app/_design/screens/bankroll/profit-chart"),
    import("@/app/_design/screens/bankroll/bet-history"),
  ]);
}, 60_000);

/** Gráfico e histórico são seções adiadas e preguiçosas: espera as duas carregarem. */
async function montar(data: typeof BANKROLL_MOCK_DATA) {
  await act(async () => {
    view = renderClickable(<DesignProvider>
      <BankrollScreen data={data} />
    </DesignProvider>);
  });
  await waitUntil(() => view!.container.querySelector(".design-section-loading") === null, "seções da banca");
}
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("interação com a curva de lucro da banca", () => {
  // Renderizar 121 apostas é o caso caro do arquivo: com a máquina ocupada passa do prazo padrão.
  it("histórico grande começa com um lote visível e preserva busca e todas as pendentes", async () => {
    const base = BANKROLL_MOCK_DATA.BETS[0]!;
    const BETS = Array.from({ length: 121 }, (_, i) => ({ ...base, id: `history-${i}`, home: `Mandante ${i}`, day: base.day, status: "pending" as const, profit: null }));
    await montar({ ...BANKROLL_MOCK_DATA, BETS });
    const visible = () => new Set([...view!.container.querySelectorAll("button[aria-controls]")].map((b) => b.getAttribute("aria-controls")));
    expect(visible().size).toBeLessThanOrEqual(50);
    expect(view!.container.textContent).toContain("121");
    view!.click("Mostrar mais apostas");
    expect(visible().size).toBe(100);
    view!.rerender(<DesignProvider><BankrollScreen data={{ ...BANKROLL_MOCK_DATA, BETS: BETS.map((b) => ({ ...b })) }} /></DesignProvider>);
    await waitUntil(() => view!.container.querySelector(".design-section-loading") === null, "histórico atualizado");
    expect(visible().size).toBe(100);
    view!.click("Mostrar mais apostas");
    expect(visible().size).toBe(121);
  }, 60_000);


  it("a busca encontra uma pendente além do primeiro lote sem exigir carregar a lista inteira", async () => {
    const base = BANKROLL_MOCK_DATA.BETS[0]!;
    const BETS = Array.from({ length: 121 }, (_, i) => ({ ...base, id: `search-${i}`, home: `Mandante ${i}`, day: base.day, status: "pending" as const, profit: null }));
    await montar({ ...BANKROLL_MOCK_DATA, BETS });
    expect(view!.container.textContent).not.toContain("Mandante 120");
    const input = view!.container.querySelector<HTMLInputElement>('input[aria-label="Buscar no histórico de apostas"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Mandante 120");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitUntil(() => view!.container.textContent?.includes("Mandante 120"), "aposta encontrada pela busca");
    expect(new Set([...view!.container.querySelectorAll("button[aria-controls]")].map((b) => b.getAttribute("aria-controls"))).size).toBe(1);
  }, 60_000);

  it("atualiza a leitura do gráfico sem recalcular o histórico", async () => {
    const summarize = vi.spyOn(summaries, "resumirApostas");
    await montar(BANKROLL_MOCK_DATA);
    expect(summarize).toHaveBeenCalled();
    summarize.mockClear();

    const chart = view?.container.querySelector<SVGSVGElement>("svg[data-responsive-chart='true']");
    if (!chart) throw new Error("Gráfico não montado");
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, right: 800, top: 0, bottom: 230, width: 800, height: 230, toJSON() {},
    });
    act(() => window.dispatchEvent(new Event("resize")));
    for (const clientX of [40, 300, 700]) {
      act(() => chart.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX })));
    }
    expect(chart.nextElementSibling?.textContent).toContain("Realizado");
    expect(chart.nextElementSibling?.textContent).not.toContain("EV esperado");
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe("curva de lucro com a lista recortada", () => {
  it("o lucro ao lado da curva é o da banca inteira, como a curva", async () => {
    // A aba fica salva entre visitas; a curva é sempre a da banca (-0.88u no mock).
    localStorage.setItem("automabaca:ui:refino:tab", JSON.stringify("pendentes"));
    await montar(BANKROLL_MOCK_DATA);
    const chart = view?.container.querySelector<SVGSVGElement>("svg[data-responsive-chart='true']");
    expect(chart?.getAttribute("aria-label")).toBe("Evolução do lucro: -0.88u");
  });
});

describe("curva de lucro com poucos pontos", () => {
  it.each([
    ["um dia", [{ label: "10/06", realized: 3 }]],
    ["dois dias", [{ label: "10/06", realized: 3 }, { label: "11/06", realized: -1 }]],
  ])("com %s, todo path do gráfico começa por M", async (_caso, CHART) => {
    await montar({ ...BANKROLL_MOCK_DATA, CHART });
    const chart = view?.container.querySelector<SVGSVGElement>("svg[data-responsive-chart='true']");
    if (!chart) throw new Error("Gráfico não montado");
    const paths = [...chart.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? "");
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) expect(d).toMatch(/^M/);
  });

  it("sem curva, mostra o estado vazio em vez de um gráfico", async () => {
    await montar({ ...BANKROLL_MOCK_DATA, CHART: [] });
    expect(view?.container.querySelector("svg[data-responsive-chart='true']")).toBeNull();
  });
});

describe("cor da curva de lucro", () => {
  const T = getTheme("light");
  const corDaLinha = () => view?.container
    .querySelector<SVGSVGElement>("svg[data-responsive-chart='true']")
    ?.querySelector("path[fill='none']")?.getAttribute("stroke");

  it.each([
    ["positivo", 5, T.posDisplay],
    ["negativo", -0.88, T.negDisplay],
  ])("segue o sinal do lucro (%s), como a curva do Dashboard", async (_caso, lucro, cor) => {
    await montar({ ...BANKROLL_MOCK_DATA, METRICS: { ...BANKROLL_MOCK_DATA.METRICS, lucro } });
    expect(corDaLinha()).toBe(cor);
  });
});


describe("base declarada ao selecionar um histórico parcial", () => {
  it.each(["todas", "ganhas", "perdidas"])("a aba %s e uma busca com resultado mantêm o aviso da janela carregada", async (tab) => {
    localStorage.setItem("automabaca:ui:refino:tab", JSON.stringify(tab));
    const base = BANKROLL_MOCK_DATA.BETS[0]!;
    const BETS = [
      { ...base, id: "recent-win", home: "Mandante comum", status: "won" as const, profit: 1 },
      { ...base, id: "recent-loss", home: "Mandante comum", status: "lost" as const, profit: -1 },
    ];
    await montar({ ...BANKROLL_MOCK_DATA, BETS, historyTotal: 401 });
    const input = view!.container.querySelector<HTMLInputElement>('input[aria-label="Buscar no histórico de apostas"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Mandante comum");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitUntil(() => view!.container.textContent?.includes("Mandante comum"), "busca com resultado");
    const note = view!.container.querySelector('[aria-label="Base do histórico"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("2 apostas carregadas de 401");
    expect(note?.textContent).toContain("Busca e filtros");
    expect(note?.querySelector('a')?.getAttribute("href")).toBe("/tipsters/main/analyzer?periodo=tudo");
  });
});
