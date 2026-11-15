// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderDesignMarkup } from "../helpers/design-markup";
import { renderClickable } from "../helpers/click-render";
import { SharpCard, sharpCadenceLabel } from "@/app/_design/screens/operacoes/sharp-card";
import { FOCUS_QUEUE_KEY, SHARP_KEY } from "@/app/_design/lib/atalhos";

const linha = (id: string, state: "aguardando" | "sem par", inLinkQueue = false) => ({
  id, home: `Casa ${id}`, away: "B", region: "Soccer", kickoff: "hoje", tried: "ontem", state, inLinkQueue,
  identityStatus: state === "aguardando" ? "PENDING" as const : "UNMATCHED" as const,
});
type Linha = ReturnType<typeof linha>;

let view: ReturnType<typeof renderClickable> | undefined;
// O jsdom não faz layout: sem isto todo caso estaria "fora da tela" e a tecla só rolaria até ele.
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 100, width: 600, height: 300 }));
  // Cada leitura do relógio anda 1 s: o caso em foco já teve tempo de ser lido quando a ação chega.
  let now = 1_790_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
});
afterEach(() => { view?.unmount(); view = undefined; vi.restoreAllMocks(); });

function montar(linhas: Linha[], { canManage = true, sharpTotal = linhas.length, retry = vi.fn((_id: string) => Promise.resolve(true)) } = {}) {
  view = renderClickable(<SharpCard pendingSharp={linhas} sharpTotal={sharpTotal} retrySharp={retry} canManage={canManage} />);
  const texto = () => view!.container.textContent ?? "";
  const tecla = (key: string) => {
    act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  };
  return { retry, texto, tecla };
}

/** Deixa as promessas do `retrySharp` assentarem. */
const assentar = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("Sharp sem par em modo foco", () => {
  it("deriva o rótulo de cadência dos thresholds canônicos", () => {
    expect(sharpCadenceLabel()).toBe("CAÇA AUTOMÁTICA PERTO DO KICKOFF: a cada 60 MIN");
    const html = renderDesignMarkup(<SharpCard pendingSharp={[]} sharpTotal={0} retrySharp={() => Promise.resolve(true)} canManage={false} />);
    expect(html).toContain("a cada 60 MIN");
    expect(html).toContain("Fila zerada");
  });

  it("o trabalho do operador vem primeiro; o resto aparece depois, com o motivo", () => {
    const { texto, tecla } = montar([linha("p1", "aguardando"), linha("p2", "sem par", true), linha("p3", "sem par")]);
    expect(texto()).toContain("Casa p3");
    expect(texto()).toContain("1 de 3");
    tecla(FOCUS_QUEUE_KEY.next);
    expect(texto()).toContain("Casa p1");
    expect(texto()).toContain("O motor tenta de novo sozinho");
    tecla(FOCUS_QUEUE_KEY.next);
    expect(texto()).toContain("Casa p2");
    expect(texto()).toContain("resolva lá");
  });

  it("R reprocessa o caso em foco e passa ao próximo", () => {
    const { retry, texto, tecla } = montar([linha("p1", "sem par"), linha("p2", "sem par")]);
    tecla(SHARP_KEY.retry.toUpperCase());
    expect(retry).toHaveBeenCalledWith("p1");
    expect(texto()).toContain("Casa p2");
    expect(texto()).toContain("2 de 2");
  });

  it("se o pedido falha, o caso volta à fila", async () => {
    const retry = vi.fn((_id: string) => Promise.resolve(false));
    const { texto } = montar([linha("p1", "sem par")], { retry });
    view!.click("Reprocessar agora");
    expect(texto()).toContain("Fila zerada");
    await assentar();
    expect(texto()).toContain("Casa p1");
  });

  it("o reprocessamento em massa alcança só o trabalho do operador ainda na fila", () => {
    const { retry, texto } = montar([linha("p1", "sem par"), linha("p2", "sem par"), linha("p3", "aguardando"), linha("p4", "sem par", true)]);
    view!.click("Reprocessar agora");
    expect(texto()).toContain("Reprocessar esta 1");
    view!.click("Reprocessar esta 1");
    expect(retry.mock.calls.map(([id]) => id)).toEqual(["p1", "p2"]);
    expect(texto()).toContain("Casa p3");
    expect(texto()).not.toContain("Reprocessar esta");
  });

  it("reprocessado o último, a fila zera; o total além da página vira aviso", () => {
    const { texto, tecla } = montar([linha("p1", "sem par")], { sharpTotal: 12 });
    expect(texto()).toContain("+11 mais na fila além desta página");
    tecla(SHARP_KEY.retry);
    expect(texto()).toContain("Fim desta página");
  });

  it("sem permissão, não há reprocessar pela tecla nem em massa", () => {
    const { retry, texto, tecla } = montar([linha("p1", "sem par")], { canManage: false });
    tecla(SHARP_KEY.retry);
    expect(retry).not.toHaveBeenCalled();
    expect(texto()).not.toContain("Reprocessar esta");
  });
});
