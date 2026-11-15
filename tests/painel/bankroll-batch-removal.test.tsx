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

// As apostas do mock com ids de servidor: só elas entram no lote. Três bastam
// para a lista: cada linha a mais é render e estilo no jsdom, e com a CI cheia
// o mock inteiro levava um caso além do prazo.
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const BETS = BANKROLL_MOCK_DATA.BETS.slice(0, 3).map((bet, i) => ({ ...bet, id: uuid(i + 1) }));
const data = { ...BANKROLL_MOCK_DATA, BETS, historyTotal: BETS.length };
const primeira = data.BETS[0]!;
const plano = {
  remove: [
    { id: primeira.id, evento: `${primeira.home} vs ${primeira.away}`, selecao: primeira.line, status: "PENDING" as const, stake: 0.5, lucro: 0, settledAt: null },
    { id: uuid(99), evento: "Mesmo post", selecao: "Over 2.5", status: "WON" as const, stake: 1, lucro: 0.95, settledAt: "2026-06-12T20:00:00.000Z" },
  ],
  review: [{ id: uuid(98), evento: "Antiga FC vs Velho EC", selecao: "Antiga FC", status: "LOST" as const, stake: 1, lucro: -1, settledAt: "2026-05-01T20:00:00.000Z" }],
  fromSamePost: 1, missing: 0, stakeUnits: 1.5, stakeReais: 150, resultUnits: 0.95, resultReais: 95,
};
/** O que a tela manda de volta ao confirmar: o lote da prévia, com status e lucro. */
const confirmado = [
  { id: primeira.id, status: "PENDING", lucro: 0 },
  { id: uuid(99), status: "WON", lucro: 0.95 },
];

// As seções que a tela carrega sob demanda, compiladas antes dos casos: com a
// CI cheia, a compilação sozinha passava do prazo de um teste.
beforeAll(async () => {
  await Promise.all([
    import("@/app/_design/screens/bankroll/bet-history"),
    import("@/app/_design/screens/bankroll/profit-chart"),
    import("@/app/_design/screens/bankroll/batch-removal-confirm"),
  ]);
}, 60_000);

const dialogo = () => document.querySelector('[role="dialog"]');

async function montar(actions: Record<string, unknown>) {
  await act(async () => {
    view = renderClickable(<BankrollScreen data={data} {...actions} />);
  });
  // O histórico é seção adiada e preguiçosa: o teste espera ele aparecer.
  await waitUntil(() => document.querySelector('[role="tablist"][aria-label="Situação das apostas"]'), "histórico da banca");
}

async function marcarERemover(marca: string) {
  view!.click("Selecionar");
  act(() => document.querySelector<HTMLButtonElement>(marca)!.click());
  await act(async () => { view!.click("Remover"); });
}

describe("remoção em lote na lista da banca", () => {
  it("marca, mostra a prévia do servidor, remove e oferece o desfazer", async () => {
    const onPreviewRemoval = vi.fn().mockResolvedValue({ ok: true, plan: plano });
    const onRemoveBets = vi.fn().mockResolvedValue({ ok: true, plan: plano });
    const onRestoreBets = vi.fn().mockResolvedValue({ ok: true, restored: [primeira.id, uuid(99)], blocked: [] });
    await montar({ onPreviewRemoval, onRemoveBets, onRestoreBets });

    await marcarERemover(`[role="checkbox"][aria-label="Marcar ${primeira.home} contra ${primeira.away}"]`);
    const confirmacao = await waitUntil(dialogo, "confirmação da remoção");
    expect(onPreviewRemoval).toHaveBeenCalledWith("main", [primeira.id]);

    const texto = confirmacao.textContent ?? "";
    expect(texto).toContain("2 apostas · 1.50u de stake (R$ 150,00)");
    expect(texto).toContain("Inclui 1 aposta do mesmo post das marcadas");
    expect(texto).toContain("Resultado estornado: +0.95u (+R$ 95,00)");
    expect(texto).toContain("1 aposta fica de fora");
    expect(texto).toContain("Antiga FC vs Velho EC");
    expect(onRemoveBets).not.toHaveBeenCalled();

    await act(async () => { confirmacao.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    await waitUntil(() => dialogo() === null, "fim da remoção");
    expect(onRemoveBets).toHaveBeenCalledWith("main", [primeira.id], confirmado);
    expect(document.querySelector(`[aria-label="Marcar ${primeira.home} contra ${primeira.away}"]`)).toBeNull();
    expect(view!.container.textContent).not.toContain(`${primeira.home} vs ${primeira.away}`);

    const removida = vi.mocked(toast).mock.calls.find(([mensagem]) => mensagem === "2 apostas removidas");
    expect(removida?.[2]?.onUndo).toBeTypeOf("function");
    await act(async () => { removida![2]!.onUndo!(); });
    await waitUntil(() => view!.container.textContent?.includes(`${primeira.home} vs ${primeira.away}`), "aposta de volta à lista");
    expect(onRestoreBets).toHaveBeenCalledWith("main", [primeira.id, uuid(99)]);
  });

  it("o aviso das que ficaram de fora fica na tela até ser fechado", async () => {
    const onPreviewRemoval = vi.fn().mockResolvedValue({ ok: true, plan: plano });
    const onRemoveBets = vi.fn().mockResolvedValue({ ok: true, plan: plano });
    await montar({ onPreviewRemoval, onRemoveBets, onRestoreBets: vi.fn() });
    await marcarERemover(`[aria-label="Marcar ${primeira.home} contra ${primeira.away}"]`);
    const confirmacao = await waitUntil(dialogo, "confirmação da remoção");
    await act(async () => { confirmacao.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });

    const aviso = () => document.querySelector('[role="status"][aria-label="Apostas que ficaram de fora"]');
    await waitUntil(aviso, "aviso das que ficaram de fora");
    expect(aviso()?.textContent).toContain("1 aposta ficou de fora");
    expect(aviso()?.textContent).toContain("Antiga FC vs Velho EC — Antiga FC");
    // Não é toast: nada some sozinho, e o toast só leva a remoção com o Desfazer.
    expect(vi.mocked(toast).mock.calls.map(([mensagem]) => mensagem)).toEqual(["2 apostas removidas"]);
    vi.useFakeTimers();
    act(() => { vi.advanceTimersByTime(10_000); });
    vi.useRealTimers();
    expect(aviso()).not.toBeNull();

    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Fechar aviso"]')!.click());
    expect(aviso()).toBeNull();
  });

  it("lote mudado depois da prévia: a confirmação fica aberta com a prévia de agora e o motivo", async () => {
    const liquidada = { ...plano, remove: [plano.remove[0]!, { ...plano.remove[1]!, status: "LOST" as const, lucro: -1 }] };
    const motivo = "O lote mudou depois da prévia: Mesmo post — Over 2.5 mudou de resultado. Confira de novo antes de remover.";
    const onPreviewRemoval = vi.fn().mockResolvedValueOnce({ ok: true, plan: plano }).mockResolvedValueOnce({ ok: true, plan: liquidada });
    const onRemoveBets = vi.fn().mockRejectedValueOnce(new Error(motivo)).mockResolvedValueOnce({ ok: true, plan: liquidada });
    await montar({ onPreviewRemoval, onRemoveBets, onRestoreBets: vi.fn() });
    await marcarERemover(`[aria-label="Marcar ${primeira.home} contra ${primeira.away}"]`);
    const confirmacao = await waitUntil(dialogo, "confirmação da remoção");
    await act(async () => { confirmacao.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });

    const alerta = await waitUntil(() => document.querySelector('[role="dialog"] [role="alert"]'), "motivo da recusa");
    expect(alerta.textContent).toBe(motivo);
    expect(onPreviewRemoval).toHaveBeenCalledTimes(2);
    expect(view!.container.textContent).toContain(`${primeira.home} vs ${primeira.away}`);

    // Confirmar de novo leva a prévia nova.
    await act(async () => { dialogo()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    await waitUntil(() => dialogo() === null, "fim da remoção");
    expect(onRemoveBets).toHaveBeenLastCalledWith("main", [primeira.id], [confirmado[0], { id: uuid(99), status: "LOST", lucro: -1 }]);
  });

  it("recusa da prévia aparece com a mensagem e nada é removido", async () => {
    const onPreviewRemoval = vi.fn().mockRejectedValue(new Error("Nenhuma das apostas marcadas está mais na lista do tipster."));
    const onRemoveBets = vi.fn();
    await montar({ onPreviewRemoval, onRemoveBets });
    await marcarERemover('[role="checkbox"]');
    await waitUntil(() => vi.mocked(toast).mock.calls.length > 0, "aviso da recusa");
    expect(vi.mocked(toast)).toHaveBeenCalledWith("Nenhuma das apostas marcadas está mais na lista do tipster.", "warn");
    expect(dialogo()).toBeNull();
    expect(onRemoveBets).not.toHaveBeenCalled();
  });

  it("sem as actions (mock, sem sessão) a lista não oferece a seleção", async () => {
    await montar({});
    expect(view!.container.textContent).not.toContain("Selecionar");
  });
});
