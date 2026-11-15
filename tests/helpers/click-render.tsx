import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";
import { DesignProvider } from "@/app/_design/kit/context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const buttons = [...container.querySelectorAll("button")];
  const exact = buttons.find((button) => button.textContent?.trim() === label);
  const partial = buttons.find((button) => button.textContent?.includes(label));
  const found = exact ?? partial;
  if (!found) {
    throw new Error(`botão não encontrado: ${label}\n${container.textContent}`);
  }
  return found;
}

/**
 * Espera `find` achar o que o passo precisa (a seção carregada, o diálogo
 * aberto, o aviso na tela), dando a vez ao React e aos timers entre as
 * tentativas. Seção adiada para o ócio e carregada por `React.lazy` leva o
 * tempo que a máquina deixar: uma espera fixa vira falha com a CI cheia. O
 * prazo é deste passo, não o do teste.
 */
export async function waitUntil<T>(find: () => T | null | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`${what}: não apareceu em ${timeoutMs} ms\n${document.body.textContent ?? ""}`);
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
}

/** Monta `ui` dentro do `DesignProvider` (tema claro), como o DesignScreen faz. */
export function renderClickable(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(<DesignProvider>{ui}</DesignProvider>);
  });
  return {
    container,
    click(label: string) {
      const button = buttonByLabel(container, label);
      act(() => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    submit(label: string) {
      const button = buttonByLabel(container, label);
      act(() => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    /** A tela recebe props novas (a página revalidada), sem desmontar o que está aberto. */
    rerender(next: ReactElement) {
      act(() => {
        root.render(<DesignProvider>{next}</DesignProvider>);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}
