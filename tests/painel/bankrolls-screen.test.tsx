// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderClickable } from "../helpers/click-render";
import { BankrollsScreen } from "@/app/_design/screens/BankrollsScreen";
import { BANKROLLS_TIP } from "@/app/_design/mock/dashboard";

vi.mock("@/app/_design/AppSidebar", () => ({ AppSidebar: () => null }));
let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); view = undefined; localStorage.clear(); });
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

it("Tipsters usa ROI monetário no consolidado e mantém as linhas individuais em unidades", async () => {
  const tipsters = [
    { ...BANKROLLS_TIP.tipsters[0]!, lucro: 2, staked: 2, profitBrl: 20, stakedBrl: 20 },
    { ...BANKROLLS_TIP.tipsters[1]!, lucro: -1, staked: 1, profitBrl: -100, stakedBrl: 100 },
  ];
  await act(async () => { view = renderClickable(<BankrollsScreen data={{ tipsters }} />); });
  expect(view!.container.textContent).toContain("-R$ 80,00");
  expect(view!.container.textContent).toContain("-66.7%");
  expect(view!.container.textContent).toContain("+2.00u");
  expect(view!.container.textContent).toContain("-1.00u");
});

it("o acerto consolidado declara a base ponderada, sem sugerir média simples dos tipsters", async () => {
  const tipsters = [
    { ...BANKROLLS_TIP.tipsters[0]!, wins: 1, losses: 0, halfWins: 0, halfLosses: 0, acerto: 100 },
    { ...BANKROLLS_TIP.tipsters[1]!, wins: 0, losses: 9, halfWins: 0, halfLosses: 0, acerto: 0 },
  ];
  await act(async () => { view = renderClickable(<BankrollsScreen data={{ tipsters }} />); });
  expect(view!.container.textContent).toContain("10.0%");
  expect(view!.container.textContent).toContain("Acerto consolidado");
});
