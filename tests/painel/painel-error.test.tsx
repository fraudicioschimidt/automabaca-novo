// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import PainelError from "@/app/(painel)/error";
import { renderClickable } from "../helpers/click-render";

vi.mock("@/app/_components/browser-error-reporter", () => ({ reportBrowserError: vi.fn() }));

let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); view = undefined; vi.restoreAllMocks(); });

describe("prancha de erro do painel", () => {
  it("'Tentar de novo' relê o servidor, porque o erro veio no payload da tela", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();
    view = renderClickable(<PainelError error={new Error("pool esgotado")} retry={retry} />);
    view.click("Tentar de novo");
    expect(retry).toHaveBeenCalledOnce();
  });
});
