// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }));
const captured = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));
// O cliente da rota só embrulha as actions e as entrega à tela: o que importa
// aqui é o que ele faz depois que a action volta.
vi.mock("@/app/_design/DesignScreen", () => ({
  DesignScreen: ({ children }: { children: React.ReactElement<Record<string, unknown>> }) => {
    captured.props = children.props;
    return null;
  },
}));

import { BankrollClient } from "@/app/(painel)/tipsters/[slug]/BankrollClient";
import { ApostaClient } from "@/app/(painel)/aposta/ApostaClient";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Array<ReturnType<typeof createRoot>> = [];
function render(ui: React.ReactElement) {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(ui));
}
afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()));
  vi.clearAllMocks();
});

type Fn = (...args: unknown[]) => Promise<unknown>;

describe("cliente da banca", () => {
  it("action que já revalida a rota não dispara um segundo carregamento", async () => {
    const actions = {
      onFetchClosing: vi.fn().mockResolvedValue({ ok: true }),
      onSettleBet: vi.fn().mockResolvedValue({ ok: true }),
      onDeleteBet: vi.fn().mockResolvedValue({ ok: true }),
      onRegisterBet: vi.fn().mockResolvedValue({ ok: true, betId: "b", created: true }),
      onChangeSharpMode: vi.fn().mockResolvedValue({ ok: true }),
    };
    const props = { data: null, initialMode: "light", ...actions } as unknown as React.ComponentProps<typeof BankrollClient>;
    render(<BankrollClient {...props} />);
    await (captured.props.onFetchClosing as Fn)("banca");
    await (captured.props.onSettleBet as Fn)("banca", "bet", "won");
    await (captured.props.onDeleteBet as Fn)("banca", "bet");
    await (captured.props.onRegisterBet as Fn)("banca", {});
    await (captured.props.onChangeSharpMode as Fn)("banca", "OFF");
    for (const action of Object.values(actions)) expect(action).toHaveBeenCalledOnce();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("recusa da liquidação chega à tela como erro com a mensagem", async () => {
    const onSettleBet = vi.fn().mockResolvedValue({ erro: "Aposta não encontrada neste tipster." });
    render(<BankrollClient data={null} initialMode="light" onSettleBet={onSettleBet as never} />);
    await expect((captured.props.onSettleBet as Fn)("banca", "bet", "won")).rejects.toThrow("Aposta não encontrada neste tipster.");
  });
});

describe("recusa das actions chega à tela com a mensagem", () => {
  it("banca: fechamento, exportação e modo sharp recusados viram exceção com o texto do servidor", async () => {
    const recusa = { ok: false, erro: 'Tipster "banca" não encontrado.' };
    const props = {
      data: null, initialMode: "light",
      onFetchClosing: vi.fn().mockResolvedValue(recusa),
      onExportCsv: vi.fn().mockResolvedValue(recusa),
      onChangeSharpMode: vi.fn().mockResolvedValue(recusa),
    } as unknown as React.ComponentProps<typeof BankrollClient>;
    render(<BankrollClient {...props} />);
    await expect((captured.props.onFetchClosing as Fn)("banca")).rejects.toThrow('Tipster "banca" não encontrado.');
    await expect((captured.props.onExportCsv as Fn)("banca")).rejects.toThrow('Tipster "banca" não encontrado.');
    await expect((captured.props.onChangeSharpMode as Fn)("banca", "OFF")).rejects.toThrow('Tipster "banca" não encontrado.');
  });

  it("banca: registrar e apagar recusados viram exceção com o texto do servidor", async () => {
    const onDeleteBet = vi.fn().mockResolvedValue({ ok: false, erro: "Aposta não encontrada neste tipster." });
    const onRegisterBet = vi.fn().mockResolvedValue({ ok: false, erro: "Preencha mandante, visitante, odds (> 1) e stake (> 0)." });
    const props = { data: null, initialMode: "light", onDeleteBet, onRegisterBet } as unknown as React.ComponentProps<typeof BankrollClient>;
    render(<BankrollClient {...props} />);
    await expect((captured.props.onDeleteBet as Fn)("banca", "bet")).rejects.toThrow("Aposta não encontrada neste tipster.");
    await expect((captured.props.onRegisterBet as Fn)("banca", {})).rejects.toThrow("Preencha mandante");
  });

  it("ficha: apagar recusado não navega", async () => {
    const onDeleteBet = vi.fn().mockResolvedValue({ ok: false, erro: "Aposta não encontrada neste tipster." });
    render(<ApostaClient bet={{} as never} trilha={null} captura={null} settlement={null} removal={null} initialMode="light" onEditBet={null} onDeleteBet={onDeleteBet} onRestoreBets={null} />);
    await expect((captured.props.onDeleteBet as Fn)("banca", "bet")).rejects.toThrow("Aposta não encontrada neste tipster.");
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("cliente da ficha", () => {
  it("editar não recarrega; excluir volta para a banca uma vez só", async () => {
    const onEditBet = vi.fn().mockResolvedValue({ ok: true });
    const onDeleteBet = vi.fn().mockResolvedValue({ ok: true });
    render(<ApostaClient bet={{} as never} trilha={null} captura={null} settlement={null} removal={null} initialMode="light" onEditBet={onEditBet} onDeleteBet={onDeleteBet} onRestoreBets={null} />);
    await (captured.props.onEditBet as Fn)("banca", "bet", {});
    await (captured.props.onDeleteBet as Fn)("banca", "bet");
    expect(router.replace).toHaveBeenCalledExactlyOnceWith("/tipsters/banca");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("restaurar a removida fica na ficha, e a recusa chega com a mensagem", async () => {
    const onRestoreBets = vi.fn()
      .mockResolvedValueOnce({ ok: true, restored: ["bet"], blocked: [] })
      .mockResolvedValueOnce({ ok: false, erro: 'Tipster "banca" não encontrado.' });
    render(<ApostaClient bet={{} as never} trilha={null} captura={null} settlement={null} removal={null} initialMode="light" onEditBet={null} onDeleteBet={null} onRestoreBets={onRestoreBets} />);
    await expect((captured.props.onRestoreBets as Fn)("banca", ["bet"])).resolves.toMatchObject({ restored: ["bet"] });
    await expect((captured.props.onRestoreBets as Fn)("banca", ["bet"])).rejects.toThrow('Tipster "banca" não encontrado.');
    expect(router.replace).not.toHaveBeenCalled();
  });
});
