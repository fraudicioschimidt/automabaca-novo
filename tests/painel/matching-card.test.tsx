// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatchingCard } from "@/app/_design/screens/operacoes/matching-card";
import { FOCUS_QUEUE_ACTION_DELAY_MS, FOCUS_QUEUE_KEY, TECLA_MATCHING } from "@/app/_design/lib/atalhos";
import { renderDesignMarkup } from "../helpers/design-markup";
import { renderClickable } from "../helpers/click-render";

const caso = (id: string, candidatos: number, extra: { betId?: string | null; matchingReason?: string | null } = {}) => ({
  id, betId: extra.betId === undefined ? `bet-${id}` : extra.betId, home: `Casa ${id}`, away: `Fora ${id}`,
  region: "Soccer · Liga", kickoff: "14/06 15:30",
  candidates: Array.from({ length: candidatos }, (_, i) => ({
    id: `${id}-c${i}`, index: i, candidateHash: "a".repeat(64), label: `Cand ${id}.${i + 1}`, league: `País · Liga ${i + 1}`, score: 0.9 - i * 0.2,
    kickoff: i === 0 ? "14/06 15:30" : "21/06 15:30" as string | null, dayShift: i === 0 ? null : "7 dias depois do kickoff", swapped: i === 1,
  })),
  llmReason: null, matchingReason: extra.matchingReason ?? null, motivo: null, resolved: null,
});
type Caso = ReturnType<typeof caso>;

let view: ReturnType<typeof renderClickable> | undefined;
// O jsdom não faz layout: sem isto todo caso estaria "fora da tela" e a tecla só rolaria até ele.
let now = 0;
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 100, width: 600, height: 300 }));
  // Cada leitura do relógio anda 1 s: o caso em foco já teve tempo de ser lido quando a ação chega.
  now = 1_790_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
});
afterEach(() => { view?.unmount(); view = undefined; vi.restoreAllMocks(); });

function montar(casos: Caso[], { canManage = true, matchingTotal = casos.length as number | null, resolve = vi.fn((): unknown => true) } = {}) {
  view = renderClickable(
    <MatchingCard pendingMatch={casos} matchingTotal={matchingTotal} resolveMatch={resolve} canManage={canManage} />,
  );
  const texto = () => view!.container.textContent ?? "";
  const tecla = (key: string, target: EventTarget = document.body, repeat = false) => {
    act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, repeat, bubbles: true, cancelable: true })); });
  };
  return { view, resolve, texto, tecla };
}

/** Deixa as promessas do `resolveMatch` assentarem. */
const assentar = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("Vincular em modo foco", () => {
  it("mostra um caso por vez, com a posição na fila", () => {
    const { texto } = montar([caso("a", 2), caso("b", 2), caso("c", 1)]);
    expect(texto()).toContain("1 de 3");
    expect(texto()).toContain("Casa a");
    expect(texto()).not.toContain("Casa b");
    expect(texto()).toContain("Cand a.1");
    expect(texto()).toContain("Cand a.2");
    expect(view!.container.querySelector('[role="status"]')?.textContent).toBe("Caso 1 de 3: Casa a contra Fora a");
  });

  it("cada candidato mostra o horário do jogo, a distância para o kickoff da aposta e o mando invertido", () => {
    montar([caso("a", 2)]);
    const [primeiro, segundo] = [...view!.container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Cand a"));
    expect(primeiro!.textContent).toContain("País · Liga 1 · 14/06 15:30");
    expect(primeiro!.textContent).not.toContain("mando invertido");
    expect(primeiro!.textContent).not.toContain("do kickoff");
    expect(segundo!.textContent).toContain("País · Liga 2 · 21/06 15:30 · mando invertido · 7 dias depois do kickoff");
  });

  it("a tecla do número vincula aquele candidato e passa ao próximo caso", () => {
    const { resolve, texto, tecla } = montar([caso("a", 2), caso("b", 2), caso("c", 1)]);
    tecla("2");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("a", expect.objectContaining({ id: "a-c1", index: 1 }));
    expect(texto()).toContain("2 de 3");
    expect(texto()).toContain("Casa b");
    expect(texto()).not.toContain("Casa a");
  });

  it("o toque duplo não vincula o caso seguinte antes de ele ser lido", () => {
    const { resolve, texto, tecla } = montar([caso("a", 2), caso("b", 2), caso("c", 1)]);
    tecla("1");
    expect(texto()).toContain("Casa b");
    // O relógio para: a segunda tecla e o segundo clique chegam com o caso "b" recém-posto em foco.
    const focusedAt = now;
    vi.spyOn(Date, "now").mockImplementation(() => focusedAt + FOCUS_QUEUE_ACTION_DELAY_MS - 1);
    tecla("1");
    view!.click("Cand b.1");
    view!.click("Tentar mais tarde");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(texto()).toContain("Casa b");
    vi.spyOn(Date, "now").mockImplementation(() => focusedAt + FOCUS_QUEUE_ACTION_DELAY_MS);
    tecla("1");
    expect(resolve).toHaveBeenLastCalledWith("b", expect.objectContaining({ id: "b-c0" }));
    expect(texto()).toContain("Casa c");
  });

  it("a tecla segurada não decide", () => {
    const { resolve, texto, tecla } = montar([caso("a", 2), caso("b", 2)]);
    tecla("1", document.body, true);
    tecla(TECLA_MATCHING.ignorar, document.body, true);
    expect(resolve).not.toHaveBeenCalled();
    expect(texto()).toContain("Casa a");
  });

  it("clicar no candidato vincula pelo mesmo caminho", () => {
    const { resolve, texto } = montar([caso("a", 2), caso("b", 1)]);
    view!.click("Cand a.1");
    expect(resolve).toHaveBeenCalledWith("a", expect.objectContaining({ id: "a-c0" }));
    expect(texto()).toContain("Casa b");
  });

  it("I adia o caso e passa ao próximo", () => {
    const { resolve, texto, tecla } = montar([caso("a", 2), caso("b", 2)]);
    tecla(TECLA_MATCHING.ignorar.toUpperCase());
    expect(resolve).toHaveBeenCalledWith("a", "ignored");
    expect(texto()).toContain("Casa b");
    view!.click("Tentar mais tarde");
    expect(resolve).toHaveBeenLastCalledWith("b", "ignored");
  });

  it("número sem candidato não faz nada", () => {
    const { resolve, texto, tecla } = montar([caso("a", 2)]);
    tecla("3");
    expect(resolve).not.toHaveBeenCalled();
    expect(texto()).toContain("Casa a");
  });

  it("as setas trocam de caso sem resolver, e o último resolvido volta aos que ficaram para trás", () => {
    const { resolve, texto, tecla } = montar([caso("a", 1), caso("b", 1), caso("c", 1)]);
    tecla(FOCUS_QUEUE_KEY.next);
    tecla(FOCUS_QUEUE_KEY.next);
    expect(texto()).toContain("3 de 3");
    expect(texto()).toContain("Casa c");
    tecla(FOCUS_QUEUE_KEY.next);
    expect(texto()).toContain("Casa c");
    tecla(FOCUS_QUEUE_KEY.previous);
    expect(texto()).toContain("Casa b");
    view!.click("próximo");
    tecla("1");
    expect(resolve).toHaveBeenCalledWith("c", expect.objectContaining({ id: "c-c0" }));
    // Não havia depois de "c": volta ao primeiro que ficou.
    expect(texto()).toContain("Casa a");
    expect(texto()).toContain("2 de 3");
  });

  it("resolvido o último caso, a fila zera", () => {
    const { texto, tecla } = montar([caso("a", 1), caso("b", 0)]);
    tecla("1");
    tecla(TECLA_MATCHING.ignorar);
    expect(texto()).toContain("Fila zerada");
    expect(texto()).toContain("Nada mais para vincular agora.");
    expect(texto()).toContain("2 de 2");
  });

  it("sem casos desde o início, o mesmo estado vazio", () => {
    const html = renderDesignMarkup(<MatchingCard pendingMatch={[]} matchingTotal={0} resolveMatch={() => {}} canManage />);
    expect(html).toContain("Vincular ao jogo");
    expect(html).toContain("Fila zerada");
    expect(html).not.toContain(" de 0");
  });

  it("se a ação falha, o caso volta à fila", async () => {
    const resolve = vi.fn(() => Promise.resolve(false));
    const { texto, tecla } = montar([caso("a", 1)], { resolve });
    tecla("1");
    await assentar();
    expect(texto()).toContain("Casa a");
    expect(texto()).toContain("1 de 1");
  });

  it("a página recarregada sem o caso resolvido não desloca a contagem", () => {
    const casos = [caso("a", 1), caso("b", 1), caso("c", 1)];
    const resolve = vi.fn(() => true);
    const { texto, tecla } = montar(casos, { resolve });
    tecla("1");
    view!.rerender(
      <MatchingCard pendingMatch={casos.slice(1)} matchingTotal={2} resolveMatch={resolve} canManage />,
    );
    expect(texto()).toContain("2 de 3");
    expect(texto()).toContain("Casa b");
  });

  it("com o caso fora da tela, a tecla o traz em vez de resolver", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 2000, width: 600, height: 300 }));
    const rolar = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = rolar;
    try {
      const { resolve, tecla } = montar([caso("a", 1)]);
      tecla("1");
      expect(resolve).not.toHaveBeenCalled();
      expect(rolar).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("tecla digitada num campo de texto não resolve", () => {
    const { resolve, tecla } = montar([caso("a", 2)]);
    const campo = document.createElement("input");
    document.body.appendChild(campo);
    tecla("1", campo);
    tecla(TECLA_MATCHING.ignorar, campo);
    campo.remove();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("com o foco na aba da fila, o número vincula e a seta fica com as abas", () => {
    const { resolve, texto, tecla } = montar([caso("a", 1), caso("b", 1), caso("c", 1)]);
    const abas = document.createElement("div");
    abas.setAttribute("role", "tablist");
    const aba = document.createElement("button");
    abas.appendChild(aba);
    document.body.appendChild(abas);
    tecla(FOCUS_QUEUE_KEY.next, aba);
    expect(texto()).toContain("Casa a");
    tecla("1", aba);
    abas.remove();
    expect(resolve).toHaveBeenCalledWith("a", expect.objectContaining({ id: "a-c0" }));
  });

  it("sem permissão, os candidatos aparecem sem ação e as teclas não resolvem", () => {
    const { resolve, texto, tecla } = montar([caso("a", 2), caso("b", 1)], { canManage: false });
    const opcoes = [...view!.container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Cand a"));
    expect(opcoes).toHaveLength(2);
    expect(opcoes.every((b) => b.disabled)).toBe(true);
    tecla("1");
    tecla(TECLA_MATCHING.ignorar);
    expect(resolve).not.toHaveBeenCalled();
    expect(texto()).not.toContain("Tentar mais tarde");
    // Navegar não é ação: continua valendo.
    tecla(FOCUS_QUEUE_KEY.next);
    expect(texto()).toContain("Casa b");
  });

  it("sem candidato, a única opção é corrigir o nome do evento na ficha", () => {
    const { view: v, texto } = montar([caso("a", 0, { matchingReason: "Nenhuma partida foi retornada pelos providers na janela do kickoff." })]);
    expect(texto()).toContain("Busca automática: Nenhuma partida foi retornada");
    expect(texto()).toContain("nenhum candidato");
    const link = v.container.querySelector('a[href="/aposta?id=bet-a"]');
    expect(link?.textContent).toContain("Corrigir o nome do evento");
    expect(texto()).toContain("Tentar mais tarde");
  });

  it("mostra o total da fila além da página carregada", () => {
    const html = renderDesignMarkup(
      <MatchingCard pendingMatch={Array.from({ length: 20 }, (_, i) => caso(`m${i}`, 0))} matchingTotal={57}
        resolveMatch={() => {}} canManage={false} />,
    );
    expect(html).toContain("1 de 57");
    expect(html).toContain("+37 mais na fila além desta página");
  });

  /** O conteúdo de cada `<kbd>`, na ordem em que sai no HTML. */
  const chips = (html: string): string[] =>
    [...html.matchAll(/<kbd[^>]*>([^<]+)<\/kbd>/g)].map((m) => m[1]!);

  it("anuncia só as teclas que o caso em foco escuta", () => {
    const html = renderDesignMarkup(
      <MatchingCard pendingMatch={[caso("a", 3), caso("b", 5)]} matchingTotal={2} resolveMatch={() => {}} canManage />,
    );
    const numeros = chips(html).filter((t) => /^\d+$/.test(t)).map(Number);
    expect(new Set(numeros)).toEqual(new Set([1, 2, 3]));
    expect(chips(html)).toContain(TECLA_MATCHING.ignorar.toUpperCase());
  });
});
