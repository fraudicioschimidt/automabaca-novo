// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardScreen } from "@/app/_design/screens/DashboardScreen";
import { TIP } from "@/app/_design/mock/dashboard";
import { renderClickable } from "../helpers/click-render";

vi.mock("@/app/_design/AppSidebar", () => ({ AppSidebar: () => null }));

let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  localStorage.clear();
});

const since = { sinceLabel: "22/09 20:10", newBets: 3, settled: 2, lucroUnits: 1.5, lucroReais: 150, closings: 1, clvMean: 2.2, openAlerts: 1 };

async function montar(visit: (typeof TIP)["visit"], onMarkVisit?: (readAt: string) => Promise<unknown>) {
  await act(async () => {
    view = renderClickable(<DashboardScreen data={{ ...TIP, visit }} onMarkVisit={onMarkVisit} />);
  });
}

describe("desde a última visita no dashboard", () => {
  it("mostra o que mudou e só depois avança a visita até o instante da leitura", async () => {
    const onMarkVisit = vi.fn().mockResolvedValue({ ok: true });
    await montar({ readAt: "2026-09-23T15:00:00.000Z", since }, onMarkVisit);
    const resumo = view!.container.querySelector('[aria-label="Desde a sua última visita"]')!;
    const texto = resumo.textContent ?? "";
    expect(texto).toContain("22/09 20:10");
    expect(texto).toContain("3 apostas novas");
    expect(texto).toContain("2 liquidadas");
    expect(texto).toContain("+R$ 150,00");
    expect(texto).toContain("1 fechamento com CLV");
    expect(texto).toContain("média +2.2%");
    expect(texto).toContain("1 alerta aberto");
    expect(onMarkVisit).toHaveBeenCalledExactlyOnceWith("2026-09-23T15:00:00.000Z");
  });

  it("primeira visita não mostra nada, mas registra a visita", async () => {
    const onMarkVisit = vi.fn().mockResolvedValue({ ok: true });
    await montar({ readAt: "2026-09-23T15:00:00.000Z", since: null }, onMarkVisit);
    expect(view!.container.querySelector('[aria-label="Desde a sua última visita"]')).toBeNull();
    expect(onMarkVisit).toHaveBeenCalledWith("2026-09-23T15:00:00.000Z");
  });

  it("sem mudança nenhuma, o resumo não aparece", async () => {
    await montar({ readAt: "2026-09-23T15:00:00.000Z", since: { ...since, newBets: 0, settled: 0, closings: 0, openAlerts: 0 } });
    expect(view!.container.querySelector('[aria-label="Desde a sua última visita"]')).toBeNull();
  });
});

it("o resumo usa o sinal do dinheiro quando unidades de tipsters diferentes se anulam", async () => {
  await montar({ readAt: "2026-09-23T15:00:00.000Z", since: { ...since, lucroUnits: 1, lucroReais: -80 } });
  const resumo = view!.container.querySelector('[aria-label="Desde a sua última visita"]')!;
  expect(resumo.textContent).toContain("-R$ 80,00");
  expect(resumo.textContent).not.toContain("+1.00u");
});
