// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettlementCard } from "@/app/_design/screens/operacoes/settlement-card";
import { FOCUS_QUEUE_KEY } from "@/app/_design/lib/atalhos";
import { renderClickable } from "../helpers/click-render";
import { renderDesignMarkup } from "../helpers/design-markup";
import foco from "@/app/_design/screens/operacoes/focus-queue.module.css";

const aposta = (id: string, allowsHalfResult = false, pick = "Over 1.5") => ({
  id, version: 1, home: `Casa ${id}`, away: "B", region: "NBA", market: "Total", pick, odds: 1.9, stake: 1,
  bankrollNome: "Banca", tipster: "Banca", when: "começou há 1 h", reason: "o FlashScore não achou o jogo",
  allowsHalfResult, result: null,
});
type Aposta = ReturnType<typeof aposta>;
type Resolve = (id: string, result: string, onUndone?: () => void) => Promise<boolean>;

let view: ReturnType<typeof renderClickable> | undefined;
// O jsdom não faz layout: sem isto todo caso estaria "fora da tela" e a tecla só rolaria até ele.
let now = 0;
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 100, width: 600, height: 300 }));
  // Cada leitura do relógio anda 1 s: o caso em foco já teve tempo de ser lido quando a ação chega.
  now = 1_790_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
});
afterEach(() => { view?.unmount(); view = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); });

function montar(apostas: Aposta[], { canManage = true, resolve = vi.fn<Resolve>(() => Promise.resolve(true)) } = {}) {
  view = renderClickable(<SettlementCard pendingSettle={apostas} resolveSettle={resolve} canManage={canManage} />);
  const texto = () => view!.container.textContent ?? "";
  const tecla = (key: string, target: EventTarget = document.body) => {
    act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  };
  const opcoes = () => [...view!.container.querySelectorAll<HTMLButtonElement>(`.${foco.options} button`)];
  return { resolve, texto, tecla, opcoes };
}

/** Deixa as promessas do `resolveSettle` assentarem. */
const assentar = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("Liquidar em modo foco", () => {
  it("mostra uma aposta por vez, com a posição na fila e a aposta inteira", () => {
    const { texto } = montar([aposta("a"), aposta("b")]);
    expect(texto()).toContain("1 de 2");
    expect(texto()).toContain("Casa a");
    expect(texto()).not.toContain("Casa b");
    // O horário da aposta é o kickoff: dizer "encerrou" com o jogo rolando induz a liquidar cedo.
    expect(texto()).toContain("começou há 1 h");
    expect(texto()).not.toContain("encerrou");
    expect(view!.container.querySelector('[role="status"]')?.textContent).toBe("Caso 1 de 2: Casa a contra B");
  });

  it("sem seleção em lote: não há caixa de marcar, 'Selecionar todas' nem barra do lote", () => {
    montar([aposta("a"), aposta("b")]);
    expect(view!.container.textContent).not.toContain("Selecionar todas");
    expect(view!.container.querySelector('[role="toolbar"]')).toBeNull();
    expect(view!.container.querySelector("[aria-pressed]")).toBeNull();
  });

  it("as opções são os resultados que o mercado permite, sem tecla", () => {
    const { opcoes } = montar([aposta("quarto", true, "Over 9.25"), aposta("inteira", false, "Over 9.5")]);
    expect(opcoes().map((b) => b.textContent?.replace(/^½/, ""))).toEqual(["Ganhou", "½ ganha", "Perdeu", "½ perda", "Reembolso"]);
    expect(opcoes().some((b) => b.hasAttribute("aria-keyshortcuts"))).toBe(false);
    act(() => { view!.container.querySelector<HTMLButtonElement>(`[aria-keyshortcuts="${FOCUS_QUEUE_KEY.next}"]`)!.click(); });
    expect(opcoes().map((b) => b.textContent)).toEqual(["Ganhou", "Perdeu", "Reembolso"]);
  });

  it("escolher não liquida no primeiro gesto; confirmado, a aposta sai e a próxima entra", () => {
    const { resolve, texto } = montar([aposta("a"), aposta("b")]);
    view!.click("Ganhou");
    expect(resolve).not.toHaveBeenCalled();
    expect(texto()).toContain("Esta ação marca a aposta como ganhou");
    view!.submit("Confirmar ganhou");
    expect(resolve).toHaveBeenCalledWith("a", "won", expect.any(Function));
    expect(texto()).toContain("Casa b");
    expect(texto()).toContain("2 de 2");
  });

  it("liquidar é só no clique: as letras não abrem a confirmação nem liquidam", () => {
    const { resolve, tecla, texto } = montar([aposta("a"), aposta("b")]);
    for (const letra of ["g", "p", "r", "G"]) tecla(letra);
    expect(view!.container.querySelector('[role="dialog"]')).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    // As setas continuam trocando de caso, como em todas as filas.
    tecla(FOCUS_QUEUE_KEY.next);
    expect(texto()).toContain("Casa b");
  });

  it("com a confirmação aberta, as setas da fila não agem", () => {
    const { resolve, tecla } = montar([aposta("a"), aposta("b")]);
    view!.click("Ganhou");
    const dialogo = view!.container.querySelector('[role="dialog"]')!;
    tecla(FOCUS_QUEUE_KEY.next, dialogo);
    expect(view!.container.textContent).toContain("Confirmar ganhou");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("se a liquidação falha, a aposta volta à fila", async () => {
    const resolve = vi.fn<Resolve>(() => Promise.resolve(false));
    const { texto } = montar([aposta("a")], { resolve });
    view!.click("Perdeu");
    view!.submit("Confirmar perdeu");
    expect(texto()).toContain("Fila zerada");
    await assentar();
    expect(texto()).toContain("Casa a");
    expect(texto()).toContain("1 de 1");
  });

  it("o desfazer do toast traz a aposta de volta à fila", async () => {
    const resolve = vi.fn<Resolve>(() => Promise.resolve(true));
    const { texto } = montar([aposta("a"), aposta("b")], { resolve });
    view!.click("Ganhou");
    view!.submit("Confirmar ganhou");
    await assentar();
    expect(texto()).not.toContain("Casa a");
    act(() => { resolve.mock.calls[0]![2]!(); });
    expect(texto()).toContain("2 de 2");
    view!.click("anterior");
    expect(texto()).toContain("Casa a");
  });

  it("liquidada a última, a fila zera", () => {
    const { texto } = montar([aposta("a")]);
    view!.click("Reembolso");
    view!.submit("Confirmar reembolso");
    expect(texto()).toContain("Fila zerada");
    expect(texto()).toContain("Nenhuma aposta esperando liquidação manual.");
  });

  it("sem apostas desde o início, o mesmo estado final", () => {
    const html = renderDesignMarkup(<SettlementCard pendingSettle={[]} resolveSettle={() => Promise.resolve(true)} canManage />);
    expect(html).toContain("Liquidação manual");
    expect(html).toContain("Fila zerada");
  });

  it("sem permissão, os resultados aparecem sem ação", () => {
    const { resolve, opcoes } = montar([aposta("a")], { canManage: false });
    expect(opcoes().every((b) => b.disabled)).toBe(true);
    view!.click("Ganhou");
    expect(view!.container.querySelector('[role="dialog"]')).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
