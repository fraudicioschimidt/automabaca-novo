// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderClickable } from "../helpers/click-render";
import { afterEach, expect, it, vi } from "vitest";
import { useManualSettlement } from "@/app/_design/screens/bankroll/use-manual-settlement";
import { SettlementNotice } from "@/app/_design/screens/bankroll/settlement-notice";
import { applySettlementOverride, settlementOverride } from "@/app/_design/screens/bankroll/settlement-view";

const view = { version: 1, event: "France vs Spain", sport: "Soccer", competition: "Copa", country: "França", market: "Money Line – Match", selection: "France", date: "2026-09-01T12:00:00Z", bookmaker: "Betano", odds: 2, stake: 1, unitValue: 50, status: "PENDING", profit: 0, kickoffInferred: false, sportState: "CONFIRMED", settledAt: null, liveScoreHome: null, liveScoreAway: null };
const bet = { id: "bet1", settlementView: view, stake: 1, odds: 2 };
const cleanup: Array<() => void> = [];
function renderHook<P, R>(hook: (props: P) => R, initialProps: P) {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container); const result = { current: undefined as R };
  function Harness(props: P & object) { result.current = hook(props); return null; }
  const rerender = (props: P) => act(() => root.render(React.createElement(Harness, props as P & object)));
  rerender(initialProps);
  cleanup.push(() => { act(() => root.unmount()); container.remove(); });
  return { result, rerender };
}
function harness(onSettleBet = vi.fn()) {
  const setResultOverrides = vi.fn();
  const props = { slug: "c32", onSettleBet, setResultOverrides, setSettling: vi.fn(), setResultMenu: vi.fn(), resultLabel: { won: "Ganha", lost: "Perdida", cashout: "Cashout" } };
  return { ...renderHook((p) => useManualSettlement(p), props), props, onSettleBet, setResultOverrides };
}
afterEach(() => { for (const clean of cleanup.splice(0)) clean(); });
it("envia a versão da aposta escolhida mesmo após atualização do servidor", async () => {
  const h = harness(vi.fn().mockResolvedValue({ kind: "conflict", current: { ...view, version: 2, status: "WON", profit: 1 } }));
  await act(async () => { await h.result.current.doSettle(bet, "lost"); });
  expect(h.onSettleBet.mock.calls[0]?.[4]).toMatchObject({ expectedVersion: 1, requestId: expect.any(String) });
  expect(h.result.current.settlementNotice).toMatchObject({ result: "lost", current: { version: 2 } });
  h.rerender({ ...h.props });
  expect(h.onSettleBet).toHaveBeenCalledTimes(1);
  h.onSettleBet.mockResolvedValueOnce({ kind: "conflict", current: { ...view, version: 3 } });
  await act(async () => { await h.result.current.confirmSettlement(); });
  expect(h.onSettleBet.mock.calls[1]?.[4]).toMatchObject({ expectedVersion: 2 });
  expect(h.onSettleBet.mock.calls[1]?.[4].requestId).not.toBe(h.onSettleBet.mock.calls[0]?.[4].requestId);
  expect(h.result.current.settlementNotice).toMatchObject({ current: { version: 3 } });
  expect(h.setResultOverrides).not.toHaveBeenCalled();
});
it("erro de transporte preserva o recibo e o lucro de cashout na nova tentativa", async () => {
  const h = harness(vi.fn().mockRejectedValueOnce(new Error("Conexão interrompida"))
    .mockResolvedValueOnce({ kind: "saved", current: { ...view, version: 2, status: "CASHOUT", profit: 0.3 }, duplicate: true }));
  await act(async () => { await h.result.current.doSettle(bet, "cashout", 0.3); });
  expect(h.result.current.settlementNotice).toMatchObject({ kind: "error", cashoutLucro: 0.3 });
  await act(async () => { await h.result.current.confirmSettlement(); });
  expect(h.onSettleBet.mock.calls[1]).toEqual(h.onSettleBet.mock.calls[0]);
  expect(h.result.current.settlementNotice).toBeNull();
});
it("dois cliques no mesmo instante disparam apenas uma requisição", async () => {
  let finish!: (value: unknown) => void;
  const h = harness(vi.fn(() => new Promise((resolve) => { finish = resolve; })));
  let pending: unknown;
  act(() => { pending = h.result.current.doSettle(bet, "won"); h.result.current.doSettle(bet, "lost"); });
  expect(h.onSettleBet).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ kind: "saved", current: { ...view, version: 2, status: "WON", profit: 1 }, duplicate: false }); await pending; });
});
it("resposta da banca anterior não modifica a banca seguinte", async () => {
  let finish!: (value: unknown) => void;
  const h = harness(vi.fn(() => new Promise((resolve) => { finish = resolve; })));
  let pending: unknown;
  act(() => { pending = h.result.current.doSettle(bet, "won"); });
  h.rerender({ ...h.props, slug: "outra" });
  await act(async () => { finish({ kind: "conflict", current: { ...view, version: 2 } }); await pending; });
  expect(h.result.current.settlementNotice).toBeNull();
  expect(h.setResultOverrides).not.toHaveBeenCalled();
});
it("dados mais recentes do servidor substituem o resultado local já confirmado", () => {
  const override = settlementOverride({ ...view, version: 2, status: "WON", profit: 1 });
  const current = { ...bet, status: "lost", settlementView: { ...view, version: 3, status: "LOST", profit: -1 } };
  expect(applySettlementOverride(current, override)).toBe(current);
  expect(applySettlementOverride(bet, override)).toMatchObject({ status: "won", settlementView: { version: 2 } });
});
it("o aviso mostra o que mudou e mantém a escolha de cashout", () => {
  const rendered = renderClickable(<SettlementNotice notice={{ kind: "conflict", bet, view, result: "cashout", cashoutLucro: 0.3, requestId: "r1", current: { ...view, version: 2, stake: 2, status: "WON", profit: 2 } }}
    labels={{ cashout: "Cashout" }} busy={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
  cleanup.push(() => rendered.unmount());
  expect(rendered.container.querySelector('[aria-label="O que mudou"]')?.textContent).toContain("Stake: 1 → 2");
  expect(rendered.container.textContent).toContain("Cashout · lucro 0.3 u");
  expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent === "Confirmar Cashout com estes dados")).toBe(true);
});
