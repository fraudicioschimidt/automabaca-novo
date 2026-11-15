// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigScreen } from "@/app/_design/screens/ConfigScreen";
import { CFG } from "@/app/_design/mock/config";
import { renderClickable } from "../helpers/click-render";

vi.mock("@/app/_design/AppSidebar", () => ({ AppSidebar: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/config",
}));

let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); view = undefined; });

const abaAtiva = () => document.querySelector('[role="tab"][aria-selected="true"]')?.id;

describe("Config", () => {
  it("'Nova banca' de outra seção leva à seção Bancas com o formulário aberto", () => {
    view = renderClickable(<ConfigScreen data={CFG} canManage />);
    act(() => { document.querySelector<HTMLButtonElement>("#segmento-tab-seguranca")!.click(); });
    expect(abaAtiva()).toBe("segmento-tab-seguranca");
    view.click("Novo tipster");
    expect(abaAtiva()).toBe("segmento-tab-bancas");
    expect(document.querySelector('input[placeholder="Nome do tipster"]')).not.toBeNull();
  });
});
