// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderClickable } from "../helpers/click-render";
import { BetActions } from "@/app/_design/screens/aposta/bet-actions";
import { ContasOverlays, type ContaForm } from "@/app/_design/screens/contas/overlays";
import { useOperacoesState } from "@/app/_design/screens/operacoes/use-operacoes-state";
import { toBet } from "@/app/_design/adapters/aposta";
import { manualSettlementView } from "@/src/domain/manual-settlement";
import { ACC } from "@/app/_design/mock/contas";
import { OPERACOES_MOCK as OPS } from "@/app/_design/mock/operacoes";
import type { OperacoesActions } from "@/app/_design/action-contracts";
import { toast } from "@/app/_design/toast";

vi.mock("@/app/_design/toast", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/_design/toast")>();
  return { ...real, toast: vi.fn(real.toast) };
});

let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); view = undefined; vi.restoreAllMocks(); });
const baseRow = {
  id: "bet", bkSlug: "banca", data: new Date("2026-09-09T12:00:00Z"), evento: "A vs B",
  competicao: "Liga", pais: "Brazil", esporte: "Soccer", mercado: "Moneyline", selecao: "A",
  casaDeAposta: "Casa", tipster: "Canal", odds: 2, stake: 1, status: "WON", lucro: 1,
  closingOdd: null,
  openingMaxBet: null, closingMaxBet: null, openingOdd: null, openingRawOdd: null, closingRawOdd: null,
  registradoEm: new Date(), clv: null, clvReliable: false, identityStatus: null,
  noOddsReason: null, closingNoOddsReason: null, source: "web", sourceExternalId: null, contaTitular: null,
};
/** A revisão da aposta vai junto da edição: o servidor recusa se ela mudou. */
const VERSION = 3;
const row: Parameters<typeof toBet>[0] = {
  ...baseRow, settlementView: manualSettlementView({ ...baseRow, manualSettlementVersion: VERSION, valorUnidade: 50 }),
};
const b = toBet(row);
async function submit() {
  await act(async () => { view?.container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
function input(label: string, value: string) {
  const field = [...(view?.container.querySelectorAll("label") ?? [])].find((node) => node.textContent?.includes(label))?.querySelector("input");
  if (!field) throw new Error(`Campo ausente: ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("mutações tipadas da interface", () => {
  it("edita com valores numéricos, preserva erro e só fecha quando salva", async () => {
    const edit = vi.fn<NonNullable<ComponentProps<typeof BetActions>["onEdit"]>>().mockRejectedValueOnce(new Error("Recusada")).mockResolvedValueOnce({ ok: true, requiresEnrich: false });
    const close = vi.fn();
    view = renderClickable(<BetActions b={b} action="edit" onEdit={edit} onClose={close} />);
    expect(view.container.textContent).toContain("voltará para Pendente");
    input("Odd", "2,25");
    input("Stake", "1,5");
    await submit();
    expect(edit).toHaveBeenLastCalledWith("banca", "bet", expect.objectContaining({ odds: 2.25, stake: 1.5 }), VERSION);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("Recusada");
    expect(close).not.toHaveBeenCalled();
    await submit();
    expect(close).toHaveBeenCalledOnce();
  });

  it("aposta com horário a confirmar corrige a odd sem inventar uma hora", async () => {
    const edit = vi.fn<NonNullable<ComponentProps<typeof BetActions>["onEdit"]>>().mockResolvedValue({ ok: true, requiresEnrich: false });
    view = renderClickable(<BetActions b={toBet({ ...row, kickoffInferido: true })} action="edit" onEdit={edit} onClose={() => {}} />);
    input("Odd", "2,25");
    await submit();
    expect(edit).toHaveBeenCalledWith("banca", "bet", expect.objectContaining({ time: "", odds: 2.25 }), VERSION);
  });

  it("sem a revisão da aposta não salva: o servidor não teria como conferir se ela mudou", async () => {
    const edit = vi.fn();
    view = renderClickable(<BetActions b={toBet(baseRow)} action="edit" onEdit={edit} onClose={() => {}} />);
    input("Odd", "2,25");
    await submit();
    expect(edit).not.toHaveBeenCalled();
  });

  it("aposta com horário confirmado não salva com a hora apagada", async () => {
    const edit = vi.fn();
    view = renderClickable(<BetActions b={b} action="edit" onEdit={edit} onClose={() => {}} />);
    input("Horário", "");
    await submit();
    expect(edit).not.toHaveBeenCalled();
  });

  it("não envia odd inválida nem mutação sem callback", async () => {
    const edit = vi.fn();
    view = renderClickable(<BetActions b={b} action="edit" onEdit={edit} onClose={() => {}} />);
    input("Odd", "1");
    await submit();
    expect(edit).not.toHaveBeenCalled();
    view.unmount();
    view = renderClickable(<BetActions b={b} action="delete" onClose={() => {}} />);
    expect(view.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });

  it("permite tentar excluir novamente depois de recusa", async () => {
    const remove = vi.fn<NonNullable<ComponentProps<typeof BetActions>["onDelete"]>>().mockRejectedValueOnce(new Error("Recusada")).mockResolvedValueOnce({ ok: true });
    view = renderClickable(<BetActions b={b} action="delete" onDelete={remove} onClose={() => {}} />);
    await submit();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("Recusada");
    await submit();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenLastCalledWith("banca", "bet");
  });

  it.each(["DEPOSITO", "AJUSTE_MANUAL"] as const)("envia %s com valor e identidade de idempotência", async (tipo) => {
    const move = vi.fn().mockResolvedValue({ ok: true });
    function Harness() {
      const [form, setForm] = useState<ContaForm>({ mutId: "manual:test", valor: tipo === "DEPOSITO" ? "12,34" : "-12,34" });
      return <ContasOverlays A={ACC} ov={{ kind: "mov", accId: "a1", tipo }} pend={false} closeOv={() => {}}
        form={form} setForm={setForm} bkQuery="" setBkQuery={() => {}} onMovimentar={move} run={async (action) => { await action(); }} />;
    }
    view = renderClickable(<Harness />);
    await submit();
    expect(move).toHaveBeenCalledWith(expect.objectContaining({ contaId: "a1", tipo, valor: tipo === "DEPOSITO" ? 12.34 : -12.34, clientMutationId: "manual:test" }));
    input("Valor", "0");
    await submit();
    expect(move).toHaveBeenCalledOnce();
  });

  it.each([false, true])("cria/edita conta com vínculos explícitos (editar=%s)", async (editing) => {
    const save = vi.fn().mockResolvedValue({ ok: true });
    view = renderClickable(<ContasOverlays A={ACC} ov={{ kind: "conta", accId: editing ? "a1" : null }} pend={false} closeOv={() => {}}
      form={{ mutId: "00000000-0000-4000-8000-000000000001", casa: " Casa ", titular: " Titular ", saldo: "100,50", bankrollIds: ["b1"] }} setForm={() => {}} bkQuery="" setBkQuery={() => {}}
      onCriar={save} onEditar={save} run={async (action) => { await action(); }} />);
    await submit();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ casaDeAposta: "Casa", titular: "Titular", bankrollIds: ["b1"], ...(editing ? { contaId: "a1" } : { saldoInicial: 100.5, requestId: "00000000-0000-4000-8000-000000000001" }) }));
  });
});

describe("estado das operações acompanha o snapshot do servidor", () => {
  let state: ReturnType<typeof useOperacoesState>;
  let refresh: () => void;
  function mount(actions: OperacoesActions = {}) {
    function Harness() {
      const [data, setData] = useState(OPS);
      refresh = () => setData({ ...OPS, settlement: OPS.settlement.slice(1), matching: [], sharp: [] });
      state = useOperacoesState(data, actions);
      return <div>{state.pendingSettle.length}</div>;
    }
    view = renderClickable(<Harness />);
  }
  type Settle = NonNullable<OperacoesActions["onSettle"]>;
  const refused = { failures: 0, ignoradas: 0, conflicts: 0, halfRefused: 0, mutadas: [] as string[], versions: {} as Record<string, number> };
  const ok = (mutadas: string[], version = 2) => ({ ...refused, mutadas, versions: Object.fromEntries(mutadas.map((id) => [id, version])) });
  const sent = (betId: string, expectedVersion: number) => [{ betId, expectedVersion, requestId: expect.any(String) }];

  it("a página recarregada troca a fila pelo snapshot novo", () => {
    mount();
    act(() => refresh());
    expect(state.pendingSettle.map((row) => row.id)).toEqual(OPS.settlement.slice(1).map((row) => row.id));
    expect(state.pendingMatch).toHaveLength(0);
    expect(state.pendingSharp).toHaveLength(0);
  });

  it("liquida uma aposta por vez e só tira da fila o que o servidor confirmou", async () => {
    const settle = vi.fn<Settle>().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ...refused, failures: 1 })
      .mockResolvedValueOnce(ok(["s1"]));
    mount({ onSettle: settle });
    await act(async () => { expect(await state.resolveSettle("s1", "won")).toBe(false); });
    expect(state.pendingSettle).toHaveLength(OPS.settlement.length);
    await act(async () => { expect(await state.resolveSettle("s1", "won")).toBe(false); });
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining("não foi liquidada"), "warn");
    await act(async () => { expect(await state.resolveSettle("s1", "won")).toBe(true); });
    // A versão é a que a fila mostrou, e cada clique leva o próprio id de pedido.
    expect(settle).toHaveBeenLastCalledWith(sent("s1", 1), "won");
    expect(new Set(settle.mock.calls.map(([items]) => items[0]!.requestId)).size).toBe(3);
    expect(state.pendingSettle.map((row) => row.id)).not.toContain("s1");
  });

  it("aposta que o automático liquidou antes sai da fila, com o aviso", async () => {
    const settle = vi.fn<Settle>().mockResolvedValue({ ...refused, ignoradas: 1 });
    mount({ onSettle: settle });
    await act(async () => { expect(await state.resolveSettle("s1", "lost")).toBe(true); });
    expect(state.pendingSettle.map((row) => row.id)).not.toContain("s1");
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining("já estava liquidada"), "info");
  });

  it("desfazer confere o retorno e avisa a fila só quando a aposta voltou", async () => {
    const settle = vi.fn<Settle>()
      .mockResolvedValueOnce(ok(["s1"]))
      .mockResolvedValueOnce({ ...refused, failures: 1 })
      .mockResolvedValueOnce(ok(["s1"]));
    const onUndone = vi.fn();
    mount({ onSettle: settle });
    await act(async () => { await state.resolveSettle("s1", "won", onUndone); });
    const opcoes = vi.mocked(toast).mock.calls.findLast(([, , o]) => o?.onUndo)?.[2];
    await act(async () => { opcoes!.onUndo!(); });
    // O desfazer confirma a versão que a liquidação gravou.
    expect(settle).toHaveBeenLastCalledWith(sent("s1", 2), "pending");
    expect(onUndone).not.toHaveBeenCalled();
    expect(state.pendingSettle.map((row) => row.id)).not.toContain("s1");
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining("A aposta não voltou a pendente (o servidor recusou)"), "warn");
    await act(async () => { opcoes!.onUndo!(); });
    expect(onUndone).toHaveBeenCalledOnce();
    expect(state.pendingSettle.map((row) => row.id)).toContain("s1");
  });

  it("aposta que mudou depois de a página abrir não é liquidada e volta à fila, com o aviso", async () => {
    const settle = vi.fn<Settle>().mockResolvedValue({ ...refused, conflicts: 1 });
    mount({ onSettle: settle });
    await act(async () => { expect(await state.resolveSettle("s1", "won")).toBe(false); });
    expect(state.pendingSettle.map((row) => row.id)).toContain("s1");
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining("mudou depois que esta página abriu"), "warn");
  });

  it("a recusa do ½ num mercado sem linha fracionária diz o motivo, à parte das falhas", async () => {
    const settle = vi.fn<Settle>().mockResolvedValue({ ...refused, halfRefused: 1 });
    mount({ onSettle: settle });
    await act(async () => { expect(await state.resolveSettle("s1", "half_won")).toBe(false); });
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining("sem linha asiática fracionária não aceita ½"), "warn");
    expect(vi.mocked(toast)).not.toHaveBeenCalledWith(expect.stringContaining("não foi liquidada"), "warn");
  });

  it("erro da action aparece com a mensagem real", async () => {
    const settle = vi.fn<Settle>().mockRejectedValue(new Error("Sessão expirada."));
    mount({ onSettle: settle });
    await act(async () => { await state.resolveSettle("s1", "lost"); });
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining("Sessão expirada."), "warn");
  });

  it("aposta em envio não aceita segundo envio", async () => {
    const settle = vi.fn<Settle>().mockReturnValue(new Promise(() => {}));
    mount({ onSettle: settle });
    act(() => { state.resolveSettle("s1", "won").catch(() => undefined); });
    await act(async () => { expect(await state.resolveSettle("s1", "won")).toBe(false); });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("o vínculo resolvido avisa o nome do evento que não virou alias", async () => {
    const notice = 'Jogo vinculado; não viraram alias: "Time 1" (é uma vaga, não um time).';
    const resolve = vi.fn<NonNullable<OperacoesActions["onResolveMatch"]>>().mockResolvedValue({ ok: true, notice });
    mount({ onResolveMatch: resolve });
    await act(async () => { await state.resolveMatch(OPS.matching[0]?.id ?? "m1", { index: 0, candidateHash: "a".repeat(64) }); });
    expect(vi.mocked(toast)).toHaveBeenCalledWith("Vínculo resolvido", "ok");
    expect(vi.mocked(toast)).toHaveBeenCalledWith(notice, "warn");
  });

  it("trata aprovação, vínculo e reprocessamento confirmados pelo servidor", async () => {
    const resolve = vi.fn().mockResolvedValue({ ok: true });
    const ignore = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const retry = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    mount({ onResolveMatch: resolve, onIgnoreMatch: ignore, onRetrySharp: retry });
    const matchId = OPS.matching[0]?.id ?? "m1";
    const sharpId = OPS.sharp[0]?.id ?? "p1";
    await act(async () => { await state.resolveMatch(matchId, {}); });
    expect(resolve).not.toHaveBeenCalled();
    await act(async () => { expect(await state.resolveMatch(matchId, { index: 0 })).toBe(false); });
    expect(resolve).not.toHaveBeenCalled();
    await act(async () => { await state.resolveMatch(matchId, { index: 0, candidateHash: "a".repeat(64) }); });
    expect(resolve).toHaveBeenCalledWith(matchId, 0, "a".repeat(64));
    await act(async () => { await state.resolveMatch(matchId, "ignored"); });
    await act(async () => { await state.resolveMatch(matchId, "ignored"); });
    expect(ignore).toHaveBeenCalledTimes(2);
    await act(async () => { expect(await state.retrySharp(sharpId)).toBe(false); });
    await act(async () => { expect(await state.retrySharp(sharpId)).toBe(true); });
    expect(retry).toHaveBeenLastCalledWith(sharpId);
    const approve = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    await act(async () => { expect(await state.handleIajAction("i1", approve)).toBe(false); });
    await act(async () => { expect(await state.handleIajAction("i1", approve)).toBe(true); });
  });
});
