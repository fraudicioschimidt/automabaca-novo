// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/ferramentas",
}));
vi.mock("@/app/_design/AppSidebar", () => ({ AppSidebar: () => null }));

import { FerramentasScreen } from "@/app/_design/screens/FerramentasScreen";
import { renderClickable } from "../helpers/click-render";
import type { FerramentasScreenProps } from "@/app/_design/screen-types";

type Data = FerramentasScreenProps["data"];
let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.clearAllMocks();
});

function data(clvCanal: Data["clvCanal"]): Data {
  return {
    bankrolls: [{ id: "b1", slug: "ana", nome: "Ana" }, { id: "b2", slug: "luis", nome: "Luis" }],
    selectedBankrollId: "b1",
    selectedBankrollNome: "Ana",
    clvCanal,
  };
}

const vantagem = () => view!.container.querySelectorAll("input")[1] as HTMLInputElement;

describe("CLV do canal no Kelly", () => {
  it("abaixo da amostra mínima não oferece o CLV como vantagem", () => {
    view = renderClickable(<FerramentasScreen data={data({ nome: "Luis", media: 28.4, n: 1, verdict: "amostra curta", faltam: 29 })} />);
    const texto = view.container.textContent ?? "";
    expect(texto).toContain("+28.4%");
    expect(texto).toContain("Faltam 29 fechamentos para usar como vantagem.");
    expect([...view.container.querySelectorAll("button")].some((b) => b.textContent?.includes("usar como vantagem"))).toBe(false);
    expect(vantagem().value).toBe("5");
  });

  it("com amostra, o botão preenche a vantagem com o CLV médio", () => {
    view = renderClickable(<FerramentasScreen data={data({ nome: "Ana", media: 2.44, n: 40, verdict: "monitorar", faltam: 0 })} />);
    view.click("usar como vantagem");
    expect(vantagem().value).toBe("2.4");
  });
});

describe("troca de canal", () => {
  it("navega pelo router sem recarregar o documento e mantém os campos digitados", () => {
    view = renderClickable(<FerramentasScreen data={data(null)} />);
    const odd = view.container.querySelectorAll("input")[0] as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(odd, "2.10");
      odd.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const select = view.container.querySelector("select")!;
    act(() => {
      select.value = "b2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(router.replace).toHaveBeenCalledWith("/?bankroll=b2", { scroll: false });
    expect(odd.value).toBe("2.10");
  });
});
