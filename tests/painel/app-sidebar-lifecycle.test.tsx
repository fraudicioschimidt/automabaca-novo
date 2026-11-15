// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "@/app/_design/AppSidebar";
import { APP_COMPACT_BREAKPOINT } from "@/app/_design/layout";
import { DesignProvider } from "@/app/_design/kit/context";
import { renderClickable } from "../helpers/click-render";

const linkProps = vi.hoisted(() => [] as Array<{ href: string; prefetch?: boolean | null }>);
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean | null; children?: React.ReactNode }) => {
      linkProps.push({ href, prefetch });
      return createElement("a", { href, ...rest }, children);
    },
  };
});

class CompactMediaQueryList extends EventTarget {
  matches = true;
  readonly media = `(max-width: ${APP_COMPACT_BREAKPOINT - 1}px)`;
  onchange = null;

  setMatches(matches: boolean) {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }

  addListener(listener: EventListener) {
    this.addEventListener("change", listener);
  }

  removeListener(listener: EventListener) {
    this.removeEventListener("change", listener);
  }
}

let compactMedia: CompactMediaQueryList;

function SidebarHarness() {
  return <DesignProvider><AppSidebar active="Dashboard" /></DesignProvider>;
}

function button(label: string, root: ParentNode = document): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`botão não encontrado: ${label}`);
  return found;
}

function click(target: HTMLElement) {
  act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("ciclo de vida do menu compacto", () => {
  beforeEach(() => {
    compactMedia = new CompactMediaQueryList();
    vi.stubGlobal("matchMedia", vi.fn(() => compactMedia));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    document.body.style.overflow = "";
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("preserva foco no controle de tema após alternar e restaura o overflow no Escape", () => {
    document.body.style.overflow = "clip";
    const view = renderClickable(<SidebarHarness />);

    click(button("Abrir menu"));
    expect(button("Fechar menu")).toBe(document.activeElement);
    expect(document.body.style.overflow).toBe("hidden");

    const dialog = document.querySelector('[role="dialog"]')!;
    const theme = button("Usar tema escuro", dialog);
    theme.focus();
    click(theme);

    expect(button("Usar tema claro", dialog)).toBe(document.activeElement);
    expect(button("Usar tema claro", dialog).nextElementSibling).toBe(button("Sair", dialog));

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button("Abrir menu")).toBe(document.activeElement);
    expect(document.body.style.overflow).toBe("clip");

    view.unmount();
  });

  it("fecha ao sair do breakpoint compacto sem focar o acionador escondido nem reabrir", () => {
    document.body.style.overflow = "clip";
    const view = renderClickable(<SidebarHarness />);

    click(button("Abrir menu"));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => compactMedia.setMatches(false));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe("clip");
    expect(button("Abrir menu")).not.toBe(document.activeElement);

    act(() => compactMedia.setMatches(true));
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    view.unmount();
  });
});

describe("navegação da barra lateral", () => {
  it("não pré-carrega as páginas: cada action esvazia o cache e os links buscariam tudo de novo", () => {
    linkProps.length = 0;
    const view = renderClickable(<AppSidebar active="Dashboard" />);
    expect(linkProps.length).toBeGreaterThan(0);
    expect(linkProps.every((l) => l.prefetch === false)).toBe(true);
    view.unmount();
  });
});
