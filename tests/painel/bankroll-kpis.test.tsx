// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BankrollScreen } from "@/app/_design/screens/BankrollScreen";
import { BANKROLL_MOCK_DATA } from "@/app/_design/mock/bankroll-data";
import { renderClickable, waitUntil } from "../helpers/click-render";

vi.mock("@/app/_design/AppSidebar", () => ({ AppSidebar: () => null }));

let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  localStorage.clear();
});

beforeAll(async () => {
  await Promise.all([
    import("@/app/_design/screens/bankroll/bet-history"),
    import("@/app/_design/screens/bankroll/profit-chart"),
    import("@/app/_design/screens/bankroll/share-content"),
  ]);
}, 60_000);

async function compartilharNaAba(rotulo: string) {
  await act(async () => {
    view = renderClickable(<BankrollScreen data={BANKROLL_MOCK_DATA} />);
  });
  const aba = await waitUntil(
    () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith(rotulo)),
    `aba ${rotulo}`,
  );
  act(() => aba.click());
  view!.click("Compartilhar");
  return waitUntil(
    () => [...document.querySelectorAll('[role="dialog"]')].find((dialog) => dialog.textContent?.includes("Copiar resumo")),
    "cartão de compartilhar",
  );
}

describe("Compartilhar desempenho", () => {
  // Banca do mock: 13 apostas, -0.88u, ROI -70%, CLV +18.4%, 10 em aberto.
  it.each(["Pendentes", "Positivas"])("na aba %s o cartão conta a banca inteira, como o N e a curva", async (aba) => {
    const cartao = await compartilharNaAba(aba);
    const texto = cartao.textContent ?? "";
    expect(texto).toContain("13 apostas");
    expect(texto).toContain("-0.88u");
    expect(texto).toContain("-70.0% ROI");
    expect(texto).toContain("+18.4%");
  });
});

describe("acerto compartilhado", () => {
  it("usa o acerto esportivo da banca inteira mesmo com histórico truncado e cash-out positivo", async () => {
    const data = { ...BANKROLL_MOCK_DATA, historyTotal: 401,
      BETS: [{ ...BANKROLL_MOCK_DATA.BETS[0]!, status: "cashout" as const, profit: 0.5 }],
      METRICS: { ...BANKROLL_MOCK_DATA.METRICS, ops: 401, acerto: 100 / 3 },
    };
    await act(async () => { view = renderClickable(<BankrollScreen data={data} />); });
    view!.click("Compartilhar");
    const card = await waitUntil(() => [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes("Copiar resumo")), "cartão");
    expect(card.textContent).toContain("401 apostas");
    expect(card.textContent).toContain("33.3%");
    expect(card.textContent).not.toContain("100.0%");
  });

  it("só cash-out não vira acerto esportivo", async () => {
    const data = { ...BANKROLL_MOCK_DATA,
      BETS: [{ ...BANKROLL_MOCK_DATA.BETS[0]!, status: "cashout" as const, profit: 0.5 }],
      METRICS: { ...BANKROLL_MOCK_DATA.METRICS, acerto: null },
    };
    await act(async () => { view = renderClickable(<BankrollScreen data={data} />); });
    view!.click("Compartilhar");
    const card = await waitUntil(() => [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes("Copiar resumo")), "cartão");
    expect(card.textContent).toContain("Acerto—");
  });
});
