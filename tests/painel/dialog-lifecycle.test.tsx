// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModalForm } from "@/app/_design/kit/ModalForm";
import { Sheet } from "@/app/_design/kit/overlay-sheet";
import { renderClickable } from "../helpers/click-render";

const views: ReturnType<typeof renderClickable>[] = [];

function Harness() {
  const [sheet, setSheet] = useState(false);
  const [form, setForm] = useState(false);
  return <>
    <button onClick={() => setSheet(true)}>Abrir gaveta</button>
    <button onClick={() => setSheet(false)}>Remover gaveta</button>
    {sheet && <Sheet title="Gaveta" cardPad={20} onClose={() => setSheet(false)}
      sub={null} wide={false} height={undefined} focoDeVolta={undefined}>
      <button onClick={() => setForm(true)}>Abrir formulário</button>
    </Sheet>}
    {form && <ModalForm title="Formulário" onClose={() => setForm(false)}
      sub={null} onSubmit={() => {}} submitLabel="Salvar" submitTone={undefined}>
      <input aria-label="Nome" />
      <button hidden>Escondido</button>
      <button tabIndex={-1}>Fora da sequência</button>
    </ModalForm>}
  </>;
}

function mount() {
  const view = renderClickable(<Harness />);
  views.push(view);
  return view;
}
function press(key: string, shiftKey = false) {
  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })));
}
function focusButton(label: string) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!button) throw new Error(`Botão ausente: ${label}`);
  button.focus();
  return button;
}
function frame() { act(() => vi.advanceTimersByTime(20)); }
function openBoth(view: ReturnType<typeof mount>) {
  focusButton("Abrir gaveta");
  view.click("Abrir gaveta");
  frame();
  focusButton("Abrir formulário");
  view.click("Abrir formulário");
  frame();
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.style.overflow = "clip";
});
afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.useRealTimers();
});

describe("ciclo de vida compartilhado de modais", () => {
  it("Escape fecha só o modal superior e restaura foco e rolagem em ordem", () => {
    const view = mount();
    openBoth(view);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Nome");
    expect(document.body.style.overflow).toBe("hidden");
    press("Escape");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe("Abrir formulário");
    expect(document.body.style.overflow).toBe("hidden");
    press("Escape");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(document.activeElement?.textContent).toBe("Abrir gaveta");
    expect(document.body.style.overflow).toBe("clip");
  });

  it("mantém o foco no modal ao tabular a partir de fora ou de suas bordas", () => {
    const view = mount();
    openBoth(view);
    focusButton("Abrir gaveta");
    press("Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Fechar");
    press("Tab", true);
    expect(document.activeElement?.textContent).toBe("Salvar");
    press("Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Fechar");
  });

  it("preserva o bloqueio de rolagem quando a gaveta inferior desmonta primeiro", () => {
    const view = mount();
    openBoth(view);
    view.click("Remover gaveta");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Nome");
    press("Escape");
    expect(document.body.style.overflow).toBe("clip");
    expect(document.activeElement?.textContent).toBe("Abrir gaveta");
  });
});
