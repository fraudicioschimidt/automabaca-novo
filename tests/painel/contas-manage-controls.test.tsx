// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { renderClickable } from "../helpers/click-render";
import { describe, expect, it, vi } from "vitest";
import { ContasScreen } from "@/app/_design/screens/ContasScreen";
import { ACC, EMPTY_ACC } from "@/app/_design/mock/contas";
import { DesignProvider } from "@/app/_design/kit/context";

function renderContas(canManage = true): string {
  return renderToStaticMarkup(
    <DesignProvider mode="light">
      <ContasScreen data={EMPTY_ACC} canManage={canManage} />
    </DesignProvider>,
  );
}

describe("controles de contas por papel", () => {
  it("preserva as ações no mock canônico de administrador", () => {
    const html = renderContas();
    expect(html).toContain("Nova conta");
    expect(html).toContain("Criar primeira conta");
  });

  it("não oferece mutações quando canManage é falso", () => {
    const html = renderContas(false);
    expect(html).not.toContain("Nova conta");
    expect(html).not.toContain("Criar primeira conta");
  });

  it("distingue o total histórico da janela exibida e omite data de limitação desconhecida", () => {
    const limitada = ACC.accounts.find((account) => account.status === "limitada");
    if (!limitada) throw new Error("fixture precisa conter uma conta limitada");
    const data = {
      ...ACC,
      accounts: [{ ...limitada, limitedAt: null, moveCount: 61 }],
    };
    const html = renderToStaticMarkup(
      <DesignProvider mode="light">
        <ContasScreen data={data} accId={limitada.id} />
      </DesignProvider>,
    );

    expect(html).toContain("Conta <b>limitada pela casa</b>. ");
    expect(html).toContain("61 registros nesta conta · exibindo os 2 mais recentes");
  });
});

describe("saldo negativo", () => {
  // A perda de aposta não tem piso de saldo: o saldo pode ficar negativo, e
  // mostrá-lo sem sinal o leria como dinheiro disponível na casa.
  const base = ACC.accounts.find((account) => account.status === "ativa");
  if (!base) throw new Error("fixture precisa conter uma conta ativa");
  const conta = { ...base, balance: -123.45 };
  const data = { ...ACC, accounts: [conta], summary: { ...ACC.summary, saldo: -123.45, saldoAtivas: -123.45 } };
  const negLight = "#a23f2b";
  const negDisplayLight = "#d4654a";

  function render(accId: string | null) {
    return renderToStaticMarkup(
      <DesignProvider mode="light">
        <ContasScreen data={data} accId={accId} />
      </DesignProvider>,
    );
  }

  it("aparece com sinal e em vermelho na lista", () => {
    const html = render(null);
    const texto = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(texto).toMatch(/Saldo geral -R\$ 123,45/);
    expect(texto).toMatch(/Saldo atual -R\$ 123,45/);
    expect(texto).toContain("-R$ 123,45 em saldo");
    expect(html).toMatch(new RegExp(`color:(${negLight}|${negDisplayLight})[^>]*>-R\\$ 123,45`));
  });

  it("aparece com sinal e em vermelho no detalhe", () => {
    const html = render(conta.id);
    const texto = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(texto).toMatch(/Saldo atual -R\$ 123,45/);
    expect(html).toMatch(new RegExp(`color:(${negLight}|${negDisplayLight})[^>]*>-R\\$ 123,45`));
  });
});

it("criar conta mantém o pedido após perder a resposta e renova ao abrir outro formulário", async () => {
  const create = vi.fn().mockRejectedValueOnce(new Error("resposta perdida")).mockResolvedValue({ ok: true });
  const view = renderClickable(<ContasScreen data={EMPTY_ACC} onCriar={create} />);
  const fill = (placeholder: string, value: string) => {
    const field = view.container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const prepare = () => { view.click("Nova conta"); fill("ex.: Bet365", "Bet365"); fill("Nome do titular", "Teste"); };
  try {
    prepare();
    await act(async () => { view.click("Criar conta"); });
    await act(async () => { view.click("Criar conta"); });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ requestId: expect.any(String) });
    expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
    prepare();
    await act(async () => { view.click("Criar conta"); });
    expect(create.mock.calls[2]?.[0].requestId).not.toBe(create.mock.calls[0]?.[0].requestId);
  } finally { view.unmount(); }
});
