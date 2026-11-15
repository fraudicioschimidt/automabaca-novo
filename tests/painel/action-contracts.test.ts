import { describe, expect, expectTypeOf, it } from "vitest";
import { unwrapAction, type ApostaActions, type ContaActions, type OperacoesActions } from "@/app/_design/action-contracts";

it("contratos frontend preservam os argumentos reais das Server Actions", () => {
  expectTypeOf<NonNullable<ApostaActions["onEditBet"]>>().parameter(0).toEqualTypeOf<string>();
  expectTypeOf<NonNullable<ApostaActions["onEditBet"]>>().parameter(2).toHaveProperty("odds").toEqualTypeOf<string | number>();
  expectTypeOf<NonNullable<ApostaActions["onEditBet"]>>().parameter(3).toEqualTypeOf<number>();
  expectTypeOf<NonNullable<ContaActions["onMovimentar"]>>().parameter(0).toHaveProperty("clientMutationId").toBeString();
  expectTypeOf<NonNullable<ContaActions["onCriar"]>>().parameter(0).toHaveProperty("saldoInicial").toBeNumber();
  expectTypeOf<NonNullable<OperacoesActions["onResolveMatch"]>>().parameter(1).toEqualTypeOf<number>();
  expectTypeOf<NonNullable<OperacoesActions["onSettle"]>>().parameter(0).toEqualTypeOf<{ betId: string; expectedVersion: number; requestId: string }[]>();
});

describe("recusa da action até a tela", () => {
  it("a recusa vira exceção com a mensagem do servidor; o sucesso passa com os dados", async () => {
    const action = async (id: string) => (id === "ok"
      ? { ok: true as const, logoUrl: `/api/logos/${id}.png` }
      : { ok: false as const, erro: "Logo grande demais (máx 2MB)." });
    const naTela = unwrapAction(action);
    await expect(naTela("ok")).resolves.toEqual({ ok: true, logoUrl: "/api/logos/ok.png" });
    // Criada no cliente, a exceção leva o texto: é ele que o catch da tela mostra.
    await expect(naTela("grande")).rejects.toThrow("Logo grande demais (máx 2MB).");
  });

  it("falha que não é recusa continua exceção", async () => {
    const naTela = unwrapAction(async () => { throw new Error("rede caiu"); });
    await expect(naTela()).rejects.toThrow("rede caiu");
  });
});
