// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderClickable } from "../helpers/click-render";
import { MetricaComDefinicao } from "@/app/_design/kit/MetricaComDefinicao";
import { agregaGrupo } from "@/src/domain/analyzer/shared";
import { renderDesignMarkup } from "../helpers/design-markup";
import { DashboardScreen } from "@/app/_design/screens/DashboardScreen";
import { TIP } from "@/app/_design/mock/dashboard";

vi.mock("@/app/_design/AppSidebar", () => ({ AppSidebar: () => null }));
let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); view = undefined; localStorage.clear(); });

it("Dashboard consolida em reais os KPIs e a curva com unidades diferentes", async () => {
  const tipsters = [
    { ...TIP.tipsters[0]!, lucro: 2, staked: 2, profitBrl: 20, stakedBrl: 20, equity: [0, 2], equityBrl: [0, 20] },
    { ...TIP.tipsters[1]!, lucro: -1, staked: 1, profitBrl: -100, stakedBrl: 100, equity: [0, -1], equityBrl: [0, -100] },
  ];
  await act(async () => {
    view = renderClickable(<DashboardScreen data={{ ...TIP, tipsters, visit: { ...TIP.visit, since: null } }} />);
  });
  expect(view!.container.textContent).toContain("-R$ 80,00");
  expect(view!.container.textContent).toContain("-66.7%");
  expect(view!.container.querySelector('svg[aria-label="Lucro acumulado de -R$ 80,00"]')).not.toBeNull();
});


it("a definição de pendentes permite CLV congelado antes da liquidação", () => {
  const agg = agregaGrupo([{ status: "PENDING", stake: 1, lucro: 0, clv: 3, clvReliable: true, closingFetchedAt: new Date("2026-09-01T18:00:00Z") }]);
  expect(agg).toMatchObject({ lucro: 0, roi: null, avgClv: 3, nClv: 1 });
  const html = renderDesignMarkup(<MetricaComDefinicao metrica="tipsEmAberto" />);
  expect(html).toContain("Podem ter CLV após o fechamento confiável");
  expect(html).not.toContain("nem CLV");
});

it.each([-1, 1, 0])("os destaques seguem o sinal do lucro, inclusive se todos têm %s u", async (profit) => {
  const tipsters = TIP.tipsters.slice(0, 2).map((t) => ({ ...t, lucro: profit, hasRoi: true }));
  await act(async () => { view = renderClickable(<DashboardScreen data={{ ...TIP, tipsters }} />); });
  const { getTheme } = await import("@/app/_design/theme");
  const theme = getTheme("light");
  const probe = document.createElement("span");
  probe.style.color = profit > 0 ? theme.pos : profit < 0 ? theme.neg : theme.text;
  for (const label of ["Mais lucrativo", "Precisa de atenção"]) {
    const caption = [...view!.container.querySelectorAll("*")].find((el) => el.textContent === label)!;
    const row = caption.parentElement!.parentElement!;
    const value = [...row.querySelectorAll("span")].find((el) => el.children.length === 0 && el.textContent === `${profit > 0 ? "+" : ""}${profit.toFixed(2)}u`)!;
    expect(value.style.color).toBe(probe.style.color);
  }
});

it("destaque sem amostra não navega para outro tipster", async () => {
  const tipsters = TIP.tipsters.slice(0, 1).map((t) => ({ ...t, id: "unico", hasRoi: false, hasClv: false, clvSamples: 0 }));
  await act(async () => { view = renderClickable(<DashboardScreen data={{ ...TIP, tipsters }} />); });
  expect(view!.container.querySelector('a[href="/tipsters/main"]')).toBeNull();
  const caption = [...view!.container.querySelectorAll("*")].find((el) => el.textContent === "Melhor CLV médio")!;
  expect(caption.closest("a")).toBeNull();
});

it("histórico sem liquidação mostra ausência de curva, sem inventar um resultado", async () => {
  const tipsters = TIP.tipsters.slice(0, 1).map((t) => ({ ...t, resolved: 0, lucro: 0, profitBrl: 0, staked: 0, stakedBrl: 0, hasRoi: false, equity: [0, 0], equityBrl: [0, 0] }));
  await act(async () => { view = renderClickable(<DashboardScreen data={{ ...TIP, tipsters }} />); });
  expect(view!.container.textContent).toContain("O histórico aparecerá após a primeira movimentação.");
  expect(view!.container.querySelector('svg[aria-label^="Lucro acumulado de"]')).toBeNull();
});

it("lucro zero com liquidação conserva a curva real e o destino do destaque", async () => {
  const tipsters = TIP.tipsters.slice(0, 1).map((t) => ({ ...t, id: "zerado", lucro: 0, profitBrl: 0, staked: 1, stakedBrl: 10, hasRoi: true, equity: [0, 0], equityBrl: [0, 0] }));
  await act(async () => { view = renderClickable(<DashboardScreen data={{ ...TIP, tipsters }} />); });
  expect(view!.container.querySelector('svg[aria-label="Lucro acumulado de R$ 0,00"]')).not.toBeNull();
  const caption = [...view!.container.querySelectorAll("*")].find((el) => el.textContent === "Mais lucrativo")!;
  expect(caption.closest("a")?.getAttribute("href")).toBe("/tipsters/zerado");
});
