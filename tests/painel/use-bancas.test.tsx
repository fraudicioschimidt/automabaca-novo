// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBancas } from "@/app/_design/screens/config/use-bancas";
import { renderClickable } from "../helpers/click-render";

let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); view = undefined; vi.unstubAllGlobals(); });

describe("bancas na Config", () => {
  it("a banca criada na tela mostra a unidade como o servidor escreve", async () => {
    let state!: ReturnType<typeof useBancas>;
    function Harness() {
      state = useBancas([], true, { onCreateBanca: vi.fn().mockResolvedValue({ id: "b1", slug: "nova" }) });
      return null;
    }
    view = renderClickable(<Harness />);
    act(() => state.lista.setNewBanca({ name: "Nova", unit: "12.50", channel: "" }));
    await act(async () => { state.lista.addBanca(); });
    // O adapter escreve "R$12,5/u"; o texto digitado ("R$12.50/u") ficava até recarregar.
    expect(state.lista.bancas.at(-1)!.unit).toBe("R$12,5/u");
  });
  it.each([['1,005', 1.01], ['0,0049', 0], ['999999999999999', 0]])('criação com unidade %s conserva a precisão de centavos', async (unit, expected) => {
    const create = vi.fn().mockResolvedValue({ id: "b1", slug: "nova" });
    let state!: ReturnType<typeof useBancas>;
    function Harness() { state = useBancas([], true, { onCreateBanca: create }); return null; }
    view = renderClickable(<Harness />);
    act(() => state.lista.setNewBanca({ name: "Nova", unit, channel: "" }));
    await act(async () => { await state.lista.addBanca(); });
    if (!expected) {
      expect(create).not.toHaveBeenCalled();
      expect(state.lista.bancas).toHaveLength(0);
    } else {
      expect(state.lista.bancas[0]?.unitValue).toBe(expected);
      act(() => state.lista.openEdit(state.lista.bancas[0]!));
      expect(state.modal.bform.unit).toBe(String(expected));
    }
  });

  it("edição conserva no estado os centavos persistidos pelo servidor", async () => {
    const banca = { id: "b1", slug: "nova", name: "Nova", unit: "R$100/u", unitValue: 100, channel: "—", channelRaw: "", sharpMode: "CLV_ONLY" as const, capturePolicy: "AUTO" as const, logoUrl: null };
    const edit = vi.fn().mockResolvedValue(undefined);
    let state!: ReturnType<typeof useBancas>;
    function Harness() { state = useBancas([banca], true, { onEditBanca: edit }); return null; }
    view = renderClickable(<Harness />);
    act(() => state.lista.openEdit(banca));
    act(() => state.modal.setBform((form) => ({ ...form, unit: '1,005' })));
    await act(async () => { await state.modal.submitEdit(banca); });
    expect(edit).toHaveBeenCalledOnce();
    expect(state.lista.bancas[0]?.unitValue).toBe(1.01);
    act(() => state.lista.openEdit(state.lista.bancas[0]!));
    expect(state.modal.bform.unit).toBe('1.01');
  });

  it("criação recusada preserva o formulário e não deixa uma linha provisória editável", async () => {
    const deferred = Promise.withResolvers<{ ok: true; id: string; slug: string }>();
    const create = vi.fn().mockReturnValue(deferred.promise);
    let state!: ReturnType<typeof useBancas>;
    function Harness() { state = useBancas([], true, { onCreateBanca: create }); return null; }
    view = renderClickable(<Harness />);
    const draft = { name: "Canal novo", unit: "50", channel: "-100123" };
    act(() => { state.lista.setAdding(true); state.lista.setNewBanca(draft); });
    act(() => { state.lista.addBanca(); state.lista.addBanca(); });
    expect(create).toHaveBeenCalledOnce();
    expect(state.lista.bancas).toHaveLength(0);
    await act(async () => { deferred.reject(new Error("Canal já vinculado")); });
    expect(state.lista.adding).toBe(true);
    expect(state.lista.newBanca).toEqual(draft);
  });

  it("repete a criação após perda da resposta com o mesmo identificador", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("resposta perdida")).mockResolvedValue({ id: "b1", slug: "nova" });
    let state!: ReturnType<typeof useBancas>;
    function Harness() { state = useBancas([], true, { onCreateBanca: create }); return null; }
    view = renderClickable(<Harness />);
    act(() => { state.lista.setAdding(true); state.lista.setNewBanca({ name: "Nova", unit: "100", channel: "" }); });
    await act(async () => { await state.lista.addBanca(); });
    await act(async () => { await state.lista.addBanca(); });
    expect(create.mock.calls[0]?.[0]).toMatchObject({ requestId: expect.any(String) });
    expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
    expect(state.lista.bancas).toHaveLength(1);
  });

  it.each(["sucesso", "recusa"])("resposta de logo com %s não muda o formulário de outro tipster", async (outcome) => {
    const deferred = Promise.withResolvers<{ ok: true; logoUrl: string }>();
    const createObjectURL = vi.fn().mockReturnValue("blob:preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
    const defaults = { unit: "R$100/u", unitValue: 100, channelRaw: "", sharpMode: "CLV_ONLY" as const, capturePolicy: "AUTO" as const };
    const a = { ...defaults, id: "a", slug: "a", name: "A", channel: "—", logoUrl: "/api/logos/a.png" };
    const b = { ...defaults, id: "b", slug: "b", name: "B", channel: "—", logoUrl: "/api/logos/b.png" };
    let state!: ReturnType<typeof useBancas>;
    function Harness() { state = useBancas([a, b], true, { onUploadLogo: () => deferred.promise }); return null; }
    view = renderClickable(<Harness />);
    act(() => state.lista.openEdit(a));
    const target = { files: [new File(["image"], "logo.png")], value: "" };
    act(() => state.modal.onPickLogo({ target } as unknown as Parameters<typeof state.modal.onPickLogo>[0]));
    act(() => { state.modal.closeOv(); state.lista.openEdit(b); });
    await act(async () => {
      if (outcome === "sucesso") deferred.resolve({ ok: true, logoUrl: "/api/logos/a-new.png" });
      else deferred.reject(new Error("Arquivo recusado"));
    });
    expect(state.modal.bform.logoUrl).toBe(b.logoUrl);
    expect(state.lista.bancas.find((item) => item.id === "a")?.logoUrl).toBe(outcome === "sucesso" ? "/api/logos/a-new.png" : a.logoUrl);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

});
