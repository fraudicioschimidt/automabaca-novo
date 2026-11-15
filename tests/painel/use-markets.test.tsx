// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useMarkets } from "@/app/_design/screens/config/use-markets";
import { renderClickable } from "../helpers/click-render";
let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); });
it("confirmar variante normalizada atualiza o alias existente como o servidor", async () => {
  let state!: ReturnType<typeof useMarkets>;
  const add = vi.fn().mockResolvedValue({ ok: true });
  function Harness() { state = useMarkets([{ canon: "Moneyline", aliases: ["Vencedor do jogo"] }], { onAddAlias: add }); return null; }
  view = renderClickable(<Harness />);
  act(() => state.setAddAlias({ canon: "Moneyline", val: "vencedor DO jogo" }));
  await act(async () => { await state.commitAlias("Moneyline"); });
  expect(state.markets[0]!.aliases).toEqual(["vencedor DO jogo"]);
});
it("não permite remover um alias que ainda está sendo gravado", async () => {
  let state!: ReturnType<typeof useMarkets>;
  const deferred = Promise.withResolvers<{ ok: true }>();
  const remove = vi.fn().mockResolvedValue({ ok: true });
  function Harness() { state = useMarkets([{ canon: "Moneyline", aliases: [] }], { onAddAlias: () => deferred.promise, onRemoveAlias: remove }); return null; }
  view = renderClickable(<Harness />);
  act(() => state.setAddAlias({ canon: "Moneyline", val: "Vencedor" }));
  let pending!: Promise<void>;
  act(() => { pending = state.commitAlias("Moneyline"); });
  await act(async () => { await state.removeAlias("Moneyline", "Vencedor"); });
  expect(remove).not.toHaveBeenCalled();
  await act(async () => { deferred.resolve({ ok: true }); await pending; });
  expect(state.markets[0]!.aliases).toEqual(["Vencedor"]);
});

it("recusa ao cadastrar mantém o alias digitado e a lista anterior", async () => {
  let state!: ReturnType<typeof useMarkets>;
  function Harness() { state = useMarkets([{ canon: "Moneyline", aliases: ["Vencedor"] }], { onAddAlias: vi.fn().mockRejectedValue(new Error("Conflito")) }); return null; }
  view = renderClickable(<Harness />);
  act(() => state.setAddAlias({ canon: "Moneyline", val: "Total" }));
  await act(async () => { await state.commitAlias("Moneyline"); });
  expect(state.markets[0]!.aliases).toEqual(["Vencedor"]);
  expect(state.addAlias).toEqual({ canon: "Moneyline", val: "Total" });
});
