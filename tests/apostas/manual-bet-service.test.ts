import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  register: vi.fn(), edit: vi.fn(), enqueue: vi.fn(), cancel: vi.fn(), alert: vi.fn(), boss: {},
}));
vi.mock(import("@/src/services/bets/register"), () => ({ registerBet: mocks.register }));
vi.mock("@/src/services/bets/edit", () => ({ applyBetEdit: mocks.edit }));
/** A canonização consulta os apelidos no banco; aqui os termos passam como vieram. */
vi.mock(import("@/src/services/bets/canonicalize-registration"), () => ({ canonicalizeBetForRegistration: async (bet) => bet }));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => mocks.boss }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ enqueueSharpEnrich: mocks.enqueue, cancelPendingSharpEnrich: mocks.cancel }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperationalAlert: mocks.alert }));
import { editManualBet, registerManualBet } from "@/src/services/bets/manual";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

const input = { home: "Santos", away: "Grêmio", date: "2026-09-09", time: "15:30", odds: "2,10", stake: "0,5" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.register.mockResolvedValue({ betId: "bet", created: true });
  mocks.edit.mockResolvedValue({ requiresEnrich: true });
});

describe("casos de uso manuais sem dependência do Next", () => {
  it("a origem externa é estável para o mesmo pedido com os mesmos dados e muda com eles", async () => {
    const requestId = "00000000-0000-4000-8000-000000000001";
    const externalId = async (...args: Parameters<typeof registerManualBet>) => {
      mocks.register.mockClear();
      await registerManualBet(...args);
      expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ source: "web-manual", sourceExternalId: expect.stringMatching(/^[0-9a-f]{64}$/) }));
      return mocks.register.mock.calls[0]![0].sourceExternalId as string;
    };
    const first = await externalId("bankroll", input, "operador", requestId);
    expect(await externalId("bankroll", { ...input, odds: 2.1 }, "operador", requestId.toUpperCase())).toBe(first);
    expect(await externalId("bankroll", { ...input, odds: "2,20" }, "operador", requestId)).not.toBe(first);
    expect(await externalId("bankroll", input, "operador", "00000000-0000-4000-8000-000000000002")).not.toBe(first);
  });

  it("cadastro e edição usam os mesmos termos normalizados e preservam a autoria", async () => {
    await registerManualBet("bankroll", input, "operador");
    await editManualBet("bet", input, "operador", 4);
    const registered = mocks.register.mock.calls[0]![0];
    const edited = mocks.edit.mock.calls[0]![0];
    expect(registered).toMatchObject(edited.fields);
    expect(registered).toMatchObject({ actor: "operador", bankrollId: "bankroll", source: "web-manual" });
    expect(edited).toMatchObject({ actor: "operador", financialAuthority: "operator", expectedVersion: 4, sportResolution: { status: "CONFIRMED", source: "MANUAL" } });
    expect(mocks.cancel).toHaveBeenCalledWith(mocks.boss, "bet");
    expect(mocks.enqueue).toHaveBeenLastCalledWith(mocks.boss, "bet", { origem: "web-edit" });
  });

  it("duplicata e edição sem alteração material não enfileiram trabalho", async () => {
    mocks.register.mockResolvedValue({ betId: "bet", created: false });
    mocks.edit.mockResolvedValue({ requiresEnrich: false });
    await registerManualBet("bankroll", input, "operador");
    // A tela avisa pelo que o servidor fez: sem reprocesso, sem "reenviada para análise".
    await expect(editManualBet("bet", input, "operador", 1)).resolves.toEqual({ requiresEnrich: false });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("não perde a confirmação de gravação quando a fila falha; registra a recuperação", async () => {
    mocks.enqueue.mockRejectedValue(new Error("queue offline"));
    await expect(registerManualBet("bankroll", input, "operador")).resolves.toMatchObject({ created: true, betId: "bet" });
    expect(mocks.alert).toHaveBeenCalledWith(expect.stringContaining("foi salva"), expect.objectContaining({ resourceId: "bet", autoResolve: false }));
    // O aviso aponta o jogo, não só o id interno da aposta.
    expect(mocks.alert).toHaveBeenCalledWith(expect.stringContaining("· Santos vs Grêmio"), expect.anything());
  });

  it("falha antes da persistência quando os campos não são válidos, como recusa com a mensagem", async () => {
    // Recusa de negócio: é o tipo que leva a mensagem até a tela.
    await expect(registerManualBet("bankroll", { ...input, odds: 1 }, "operador"))
      .rejects.toThrow(new RecusaDeNegocioError("Preencha mandante, visitante, odds (> 1) e stake (> 0)."));
    await expect(editManualBet("bet", { ...input, date: "31/02" }, "operador", 1)).rejects.toBeInstanceOf(RecusaDeNegocioError);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
