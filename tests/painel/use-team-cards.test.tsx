// @vitest-environment jsdom
import { act, useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useTeamCards } from "@/app/_design/screens/config/use-team-cards";
import { CFG } from "@/app/_design/mock/config";
import { renderClickable } from "../helpers/click-render";
let state: ReturnType<typeof useTeamCards>;
function TeamCardsHarness({ data, actions }: { data: Parameters<typeof useTeamCards>[0]; actions: Parameters<typeof useTeamCards>[1] }) {
  const current = useTeamCards(data, actions);
  useEffect(() => { state = current; }, [current]);
  return null;
}
let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); vi.useRealTimers(); });
it("busca recusada não usa o offset da lista anterior para carregar a nova", async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValue(new Error("Sem conexão"));
  const data = { ...CFG, teamCards: { ...CFG.teamCards, cards: CFG.teamCards.cards.slice(0, 1), total: 6, nextOffset: 1 } };
  view = renderClickable(<TeamCardsHarness data={data} actions={{ onLoadTeamCards: load }} />);
  act(() => state.setQuery("Boise"));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(state.failed).toBe(true);
  act(() => state.loadMore());
  expect(load).toHaveBeenCalledOnce();
});
it("pareamento aguarda a leitura anterior antes de consultar novamente", async () => {
  vi.useFakeTimers();
  const deferred = Promise.withResolvers<typeof CFG.catalogPairing>();
  const load = vi.fn().mockReturnValue(deferred.promise);
  const data = { ...CFG, catalogPairing: { ...CFG.catalogPairing, inProgress: true } };
  view = renderClickable(<TeamCardsHarness data={data} actions={{ onLoadCatalogPairing: load }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(load).toHaveBeenCalledOnce();
  await act(async () => { deferred.resolve({ ...CFG.catalogPairing, inProgress: false }); });
  expect(state.pairing.status.inProgress).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(load).toHaveBeenCalledOnce();
});

it("leitura de pareamento travada termina a espera após cinco minutos", async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockReturnValue(new Promise(() => {}));
  const data = { ...CFG, catalogPairing: { ...CFG.catalogPairing, inProgress: true } };
  view = renderClickable(<TeamCardsHarness data={data} actions={{ onLoadCatalogPairing: load }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  expect(state.pairing.stale).toBe(true);
  expect(load).toHaveBeenCalledOnce();
});
it("nova busca descarta a página atrasada do filtro anterior", async () => {
  vi.useFakeTimers();
  const more = Promise.withResolvers<typeof CFG.teamCards>();
  const first = { ...CFG.teamCards, cards: CFG.teamCards.cards.slice(0, 1), nextOffset: 1 };
  const load = vi.fn().mockReturnValueOnce(more.promise).mockResolvedValueOnce({ ...CFG.teamCards, cards: CFG.teamCards.cards.slice(1, 2), nextOffset: null, total: 1 });
  const data = { ...CFG, teamCards: first };
  view = renderClickable(<TeamCardsHarness data={data} actions={{ onLoadTeamCards: load }} />);
  act(() => state.loadMore());
  act(() => state.setQuery("Boise"));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  await act(async () => { more.resolve(CFG.teamCards); });
  expect(state.cards.map((card) => card.name)).toEqual(["Boise"]);
});
