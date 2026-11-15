// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderClickable } from "../helpers/click-render";
import { usePendingBetsRefresh } from "@/app/(painel)/tipsters/[slug]/use-pending-bets-refresh";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const views: ReturnType<typeof renderClickable>[] = [];
const fetchVersion = vi.fn();
function Harness({ enabled = true }) {
  const [active, setActive] = useState(enabled);
  const [version, setVersion] = useState("v1");
  usePendingBetsRefresh(active, "treino", version);
  return <><input aria-label="Edição" /><button onClick={() => setActive(false)}>Finalizar</button>
    <button onClick={() => setVersion("v2")}>Receber</button></>;
}
function mount(enabled = true) {
  const view = renderClickable(<Harness enabled={enabled} />); views.push(view); return view;
}
async function tick(ms = 5_000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-13T17:00:00Z"));
  router.refresh.mockClear(); fetchVersion.mockReset();
  fetchVersion.mockResolvedValue({ ok: true, json: async () => ({ version: "v2" }) });
  vi.stubGlobal("fetch", fetchVersion);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("atualização leve das apostas", () => {
  it("busca versão em cinco segundos e só recarrega quando muda", async () => {
    fetchVersion.mockResolvedValueOnce({ ok: true, json: async () => ({ version: "v1" }) });
    const view = mount(); await tick();
    expect(fetchVersion).toHaveBeenCalledOnce(); expect(router.refresh).not.toHaveBeenCalled();
    await tick(); expect(router.refresh).toHaveBeenCalledOnce();
    view.click("Receber"); await tick();
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(fetchVersion.mock.calls.some((call) => call[1]?.method === "POST")).toBe(true);
  });
  it("não atualiza fixtures; desativar interrompe polling e foco", async () => {
    const view = mount(false); await tick(); expect(fetchVersion).not.toHaveBeenCalled(); view.unmount(); views.pop();
    const live = mount(); await tick(); live.click("Finalizar"); await tick();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(router.refresh).toHaveBeenCalledOnce();
  });
  it("aba oculta pausa e foco + visibilidade não duplicam consulta", async () => {
    mount(); vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await tick(); expect(fetchVersion).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
    expect(fetchVersion).toHaveBeenCalledOnce(); expect(router.refresh).toHaveBeenCalledOnce();
  });
  it("preserva edição e modal até o operador terminar", async () => {
    const view = mount(); const input = view.container.querySelector("input");
    if (!input) throw new Error("Missing input fixture");
    input.focus(); await tick(); expect(fetchVersion).not.toHaveBeenCalled(); input.blur();
    const modal = document.createElement("div"); modal.setAttribute("aria-modal", "true"); document.body.appendChild(modal);
    await tick(); expect(fetchVersion).not.toHaveBeenCalled(); modal.remove();
    await tick(); expect(router.refresh).toHaveBeenCalledOnce();
  });
  it("falha faz backoff e não perde mudança ainda não recebida nos props", async () => {
    fetchVersion.mockRejectedValueOnce(new Error("offline")); mount();
    await tick(); await tick(25_000); expect(fetchVersion).toHaveBeenCalledOnce();
    await tick(); expect(router.refresh).toHaveBeenCalledOnce();
    await tick(); expect(router.refresh).toHaveBeenCalledTimes(2);
  });
});
