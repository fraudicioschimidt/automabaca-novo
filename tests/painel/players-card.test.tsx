// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PlayersCard } from "@/app/_design/screens/config/players-card";
import { renderClickable } from "../helpers/click-render";
import type { ComponentProps } from "react";
type Panel = Awaited<ReturnType<NonNullable<ComponentProps<typeof PlayersCard>["onLoad"]>>>;
const panel = (name: string): Panel => ({ players: [{ id: name, name, providerPlayerId: name, aliases: [{ id: name, name, provider: "LOCAL", source: "MANUAL" }] }], pending: [], corrections: [], bankrolls: [] });
let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); vi.useRealTimers(); });
function search(value: string) {
  const field = document.querySelector<HTMLInputElement>('input');
  if (!field) throw new Error("Busca ausente");
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
}
it("busca que se recuperou limpa a mensagem de erro anterior", async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockResolvedValueOnce(panel("Ana")).mockRejectedValueOnce(new Error("Sem conexão")).mockResolvedValueOnce(panel("Bia"));
  view = renderClickable(<PlayersCard onLoad={load} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  search("B");
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  search("Bia");
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.container.textContent).toContain("Flashscore: Bia");
});
it("resposta de curadoria não substitui a busca mais recente pelo recorte antigo", async () => {
  vi.useFakeTimers();
  const command = Promise.withResolvers<void>();
  const load = vi.fn().mockImplementation(async (query: string) => panel(query || "Ana"));
  view = renderClickable(<PlayersCard onLoad={load} onCommand={() => command.promise} canManage />);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  view.click("Remover nome");
  search("Bia");
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  await act(async () => { command.resolve(); await vi.advanceTimersByTimeAsync(250); });
  expect(load).toHaveBeenLastCalledWith("Bia");
  expect(view.container.textContent).toContain("Flashscore: Bia");
});

it("releitura da curadoria que chega atrasada não substitui uma busca posterior", async () => {
  vi.useFakeTimers();
  const stale = Promise.withResolvers<Panel>();
  const load = vi.fn().mockResolvedValueOnce(panel("Ana")).mockReturnValueOnce(stale.promise).mockResolvedValueOnce(panel("Bia"));
  view = renderClickable(<PlayersCard onLoad={load} onCommand={vi.fn().mockResolvedValue(undefined)} canManage />);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  view.click("Remover nome");
  await act(async () => { await Promise.resolve(); });
  search("Bia");
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  await act(async () => { stale.resolve(panel("Ana")); });
  expect(view.container.textContent).toContain("Flashscore: Bia");
  expect(view.container.textContent).not.toContain("Flashscore: Ana");
});
