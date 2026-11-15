// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BankrollScreen } from "@/app/_design/screens/BankrollScreen";
import { BANKROLL_MOCK_DATA } from "@/app/_design/mock/bankroll-data";
import { toast } from "@/app/_design/toast";
import { renderClickable, waitUntil } from "../helpers/click-render";

vi.mock("@/app/_design/AppSidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/app/_design/toast", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/_design/toast")>();
  return { ...real, toast: vi.fn() };
});

let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.clearAllMocks();
  localStorage.clear();
});

// Duas apostas na lista bastam: o caso é a aba Removidas, e cada linha a mais
// é render e estilo no jsdom; com a CI cheia, o mock inteiro levava o caso
// além do prazo.
const BETS = BANKROLL_MOCK_DATA.BETS.slice(0, 2);
const SMALL_DATA = { ...BANKROLL_MOCK_DATA, BETS, historyTotal: BETS.length };

// As seções que a tela carrega sob demanda, compiladas antes dos casos: com a
// CI cheia, a compilação sozinha passava do prazo de um teste.
beforeAll(async () => {
  await Promise.all([
    import("@/app/_design/screens/bankroll/bet-history"),
    import("@/app/_design/screens/bankroll/profit-chart"),
  ]);
}, 60_000);

async function abrirRemovidas(actions: Record<string, unknown>, data = SMALL_DATA) {
  await act(async () => {
    view = renderClickable(<BankrollScreen data={data} {...actions} />);
  });
  // O histórico é seção adiada e preguiçosa: o teste espera a aba aparecer.
  const aba = await waitUntil(
    () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith("Removidas")),
    "aba Removidas",
  );
  expect(aba.textContent).toBe("Removidas3");
  act(() => aba.click());
  return document.querySelector('ul[aria-label="Apostas removidas"]');
}

const itens = () => [...document.querySelectorAll('ul[aria-label="Apostas removidas"] > li')];

describe("aba Removidas da banca", () => {
  it("lista as que saíram, por onde e o que o estorno desfez; Restaurar volta pelo caminho do Desfazer", async () => {
    const onRestoreBets = vi.fn().mockResolvedValue({ ok: true, restored: ["r1"], blocked: [] });
    const lista = await abrirRemovidas({ onRestoreBets });

    expect(lista).not.toBeNull();
    expect(itens().map((item) => item.textContent)).toEqual([
      expect.stringContaining("Removida pelo 👎 no canal em 13/06 21:40Era ganha (+0.93u), resultado estornado"),
      expect.stringContaining("Removida pelo painel em 14/06 10:05Estava pendente"),
      expect.stringContaining("Sem restauração"),
    ]);
    // A lista das apostas da banca, a ordenação e a seleção saem de cena.
    expect(document.querySelector('button[aria-label^="Ordenar por"]')).toBeNull();
    expect(view!.container.textContent).not.toContain("Copiar apostas filtradas");
    expect(document.querySelector('a[aria-label="Ficha de Grêmio contra Internacional"]')?.getAttribute("href")).toBe("/aposta?id=r1");
    expect(document.querySelector('button[aria-label="Restaurar Santos contra Vasco"]')).toBeNull();

    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Restaurar Grêmio contra Internacional"]')!.click(); });
    await waitUntil(() => itens().length === 2, "a restaurada sai da lista");
    expect(onRestoreBets).toHaveBeenCalledExactlyOnceWith("main", ["r1"]);
    expect(vi.mocked(toast)).toHaveBeenCalledWith("1 aposta de volta ao tipster", "info");
    expect(itens()).toHaveLength(2);
    expect(view!.container.textContent).not.toContain("Grêmio");
    expect([...document.querySelectorAll('[role="tab"]')].at(-1)?.textContent).toBe("Removidas2");
  });

  it("a busca vale para as removidas", async () => {
    await abrirRemovidas({ onRestoreBets: vi.fn() });
    const busca = document.querySelector<HTMLInputElement>('input[aria-label="Buscar no histórico de apostas"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(busca, "bahia");
      busca.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(itens().map((item) => item.textContent)).toEqual([expect.stringContaining("Bahia")]);
  });

  it("banca sem nenhuma ativa ainda restaura as removidas", async () => {
    const onRestoreBets = vi.fn().mockResolvedValue({ ok: true, restored: ["r1"], blocked: [] });
    await abrirRemovidas({ onRestoreBets }, { ...BANKROLL_MOCK_DATA, BETS: [], historyTotal: 0 });
    expect(itens()).toHaveLength(3);
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Restaurar Grêmio contra Internacional"]')!.click(); });
    expect(onRestoreBets).toHaveBeenCalledExactlyOnceWith("main", ["r1"]);
  });

  it("sem sessão lista e abre a ficha, mas não restaura", async () => {
    await abrirRemovidas({});
    expect(itens()).toHaveLength(3);
    expect(document.querySelector('button[aria-label^="Restaurar"]')).toBeNull();
    expect(document.querySelectorAll('a[aria-label^="Ficha de"]')).toHaveLength(3);
  });
});
