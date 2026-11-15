import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), bankroll: vi.fn(), bet: vi.fn(), register: vi.fn(), edit: vi.fn(), remove: vi.fn(), revalidate: vi.fn(),
  planBatch: vi.fn(), removeBatch: vi.fn(), restoreBatch: vi.fn(),
}));
// `actor()` é a guarda das ações que gravam: lança sem sessão, como a real.
vi.mock("@/app/(painel)/_auth", () => ({ actor: mocks.session }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-correlation-id": "http_manual" }) }));
vi.mock("@/src/infra/prisma", () => ({ prisma: { bet: { findFirst: mocks.bet } } }));
vi.mock("@/src/services/painel/queries/bankrolls", () => ({ getBankrollBySlug: mocks.bankroll }));
vi.mock("@/src/services/bets/manual", () => ({ registerManualBet: mocks.register, editManualBet: mocks.edit }));
vi.mock("@/src/services/bets/remove", () => ({
  softDeleteBet: mocks.remove,
  planBatchRemoval: mocks.planBatch,
  removeBetsInBatch: mocks.removeBatch,
  restoreBetsInBatch: mocks.restoreBatch,
}));
vi.mock("@/src/services/ops/telemetry", () => ({ observeAction: (_name: string, run: () => Promise<unknown>) => run() }));
import {
  deleteBetAction,
  editBetAction,
  previewBetRemovalAction,
  registerManualBetAction as registerManualBetActionReal,
  removeBetsAction,
  restoreBetsAction,
} from "@/app/(painel)/tipsters/[slug]/manual-actions";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

function registerManualBetAction(slug: string, data: Omit<Parameters<typeof registerManualBetActionReal>[1], "requestId">) {
  return registerManualBetActionReal(slug, { ...data, requestId: "00000000-0000-4000-8000-000000000001" });
}

const BET_ID = "11111111-1111-4111-8111-111111111111";
const input = { home: "Santos", away: "Grêmio", date: "2026-09-09", time: "15:30", odds: 2.1, stake: 1 };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue("operador");
  mocks.bankroll.mockResolvedValue({ id: "bankroll" });
  mocks.bet.mockResolvedValue({ id: BET_ID });
  mocks.register.mockResolvedValue({ betId: BET_ID, created: true });
  mocks.edit.mockResolvedValue({ requiresEnrich: true });
});

describe("fronteira das ações manuais", () => {
  it("registra aposta no endereço longo já gerado sem mudar a identidade", async () => {
    const slug = `${"x".repeat(120)}-2`;
    await expect(registerManualBetAction(slug, input)).resolves.toEqual({ ok: true, betId: BET_ID, created: true });
    expect(mocks.bankroll).toHaveBeenCalledWith(slug);
  });

  it("exige identificador do formulário e entrega a mesma chave ao caso de uso", async () => {
    expect(await registerManualBetActionReal("canal", input as Parameters<typeof registerManualBetActionReal>[1])).toMatchObject({ ok: false });
    expect(mocks.register).not.toHaveBeenCalled();
    await registerManualBetAction("canal", input);
    expect(mocks.register).toHaveBeenCalledWith("bankroll", input, "operador", "00000000-0000-4000-8000-000000000001");
  });

  it("a resposta leva o que o servidor gravou", async () => {
    await expect(registerManualBetAction("canal", input)).resolves.toEqual({ ok: true, betId: BET_ID, created: true });
    await expect(deleteBetAction("canal", BET_ID)).resolves.toEqual({ ok: true });
    mocks.edit.mockResolvedValueOnce({ requiresEnrich: false });
    await expect(editBetAction("canal", BET_ID, input, 7)).resolves.toEqual({ ok: true, requiresEnrich: false });
    // A revisão que a ficha mostrava chega ao caso de uso, que recusa se a aposta mudou.
    expect(mocks.edit).toHaveBeenCalledWith(BET_ID, input, "operador", 7);
    // A exclusão pela ficha é do painel: restaurável, e o 👎 não a desfaz.
    expect(mocks.remove).toHaveBeenCalledWith(expect.objectContaining({ betId: BET_ID, actor: "operador", origin: "painel" }));
  });

  it("apagar aposta que já não existe volta como recusa com motivo, não como erro 500", async () => {
    // Em produção o Next esconde a mensagem de erro lançado: a tela via só
    // um erro genérico ao apagar uma aposta já removida (outra aba, o 👎).
    mocks.bet.mockResolvedValue(null);
    await expect(deleteBetAction("canal", BET_ID)).resolves.toEqual({ ok: false, erro: "Aposta não encontrada neste tipster." });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("recusa do caso de uso chega com a mensagem; falha inesperada continua exceção", async () => {
    mocks.register.mockRejectedValueOnce(new RecusaDeNegocioError("Preencha mandante, visitante, odds (> 1) e stake (> 0)."));
    await expect(registerManualBetAction("canal", input))
      .resolves.toEqual({ ok: false, erro: "Preencha mandante, visitante, odds (> 1) e stake (> 0)." });
    mocks.register.mockRejectedValueOnce(new Error("conexão caiu"));
    await expect(registerManualBetAction("canal", input)).rejects.toThrow("conexão caiu");
  });

  it.each(["register", "edit", "delete"])("%s atualiza também os saldos e resumos fora da ficha", async (operation) => {
    if (operation === "register") await registerManualBetAction("canal", input);
    if (operation === "edit") await editBetAction("canal", BET_ID, input, 1);
    if (operation === "delete") await deleteBetAction("canal", BET_ID);
    expect(mocks.revalidate.mock.calls).toEqual(expect.arrayContaining([
      ["/"], ["/tipsters", "layout"], ["/tipsters/canal"], ["/contas"], ["/aposta"], ["/operacoes"],
    ]));
  });

  it("recusa apostar em outra banca antes de chamar o caso de uso", async () => {
    mocks.bet.mockResolvedValue(null);
    await expect(editBetAction("canal", "22222222-2222-4222-8222-222222222222", input, 1))
      .resolves.toEqual({ ok: false, erro: "Aposta não encontrada neste tipster." });
    expect(mocks.bet).toHaveBeenCalledWith({
      where: { id: "22222222-2222-4222-8222-222222222222", bankrollId: "bankroll", deletedAt: null }, select: { id: true },
    });
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("autentica antes de consultar ou alterar a aposta", async () => {
    mocks.session.mockRejectedValue(new Error("unauthorized"));
    await expect(deleteBetAction("canal", BET_ID)).rejects.toThrow("unauthorized");
    expect(mocks.bankroll).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("hora ausente chega ao caso de uso como ausente, não como meia-noite digitada", async () => {
    const { time: _time, ...semHora } = input;
    await registerManualBetAction("canal", semHora);
    await editBetAction("canal", BET_ID, semHora, 1);
    expect(mocks.register.mock.calls[0]![1]).not.toHaveProperty("time", "00:00");
    expect(mocks.edit.mock.calls[0]![1]).not.toHaveProperty("time", "00:00");
  });

  it("rejeita payload fora do schema Zod antes do caso de uso", async () => {
    await expect(registerManualBetAction("canal", { ...input, home: "" } as typeof input))
      .resolves.toEqual({ ok: false, erro: "Dados da aposta inválidos." });
    // Slug e id malformados são defeito do cliente: erro, não recusa.
    await expect(registerManualBetAction("../evil", input)).rejects.toThrow("Tipster inválido.");
    await expect(editBetAction("canal", "not-a-uuid", input, 1)).rejects.toThrow("Aposta inválida.");
    await expect(editBetAction("canal", BET_ID, input, 0)).rejects.toThrow("Versão da aposta inválida.");
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.bankroll).not.toHaveBeenCalled();
  });
});

describe("remoção em lote pela banca", () => {
  const plano = {
    remove: [{ id: BET_ID, evento: "Santos vs Grêmio", selecao: "Santos", status: "PENDING", stake: 1, lucro: 0, settledAt: null }],
    review: [], fromSamePost: 0, missing: 0, stakeUnits: 1, stakeReais: 100, resultUnits: 0, resultReais: 0,
  };
  const confirmado = [{ id: BET_ID, status: "PENDING" as const, lucro: 0 }];

  it("remove com o operador da sessão e o lote confirmado, e revalida as telas financeiras", async () => {
    mocks.removeBatch.mockResolvedValue(plano);
    await expect(removeBetsAction("canal", [BET_ID, BET_ID], confirmado)).resolves.toEqual({ ok: true, plan: plano });
    expect(mocks.removeBatch).toHaveBeenCalledWith({ bankrollId: "bankroll", betIds: [BET_ID], confirmed: confirmado, actor: "operador" });
    expect(mocks.revalidate.mock.calls).toEqual(expect.arrayContaining([["/tipsters/canal"], ["/contas"]]));
  });

  it("prévia confirmada malformada é erro de cliente, antes de consultar", async () => {
    await expect(removeBetsAction("canal", [BET_ID], [{ id: BET_ID, status: "GANHOU", lucro: 0 }] as never)).rejects.toThrow("Prévia da remoção inválida.");
    await expect(removeBetsAction("canal", [BET_ID], undefined as never)).rejects.toThrow("Prévia da remoção inválida.");
    expect(mocks.bankroll).not.toHaveBeenCalled();
    expect(mocks.removeBatch).not.toHaveBeenCalled();
  });

  it("a prévia não grava: só chama o plano", async () => {
    mocks.planBatch.mockResolvedValue(plano);
    await expect(previewBetRemovalAction("canal", [BET_ID])).resolves.toEqual({ ok: true, plan: plano });
    expect(mocks.removeBatch).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("recusa do serviço volta com a mensagem; banca inexistente também", async () => {
    mocks.removeBatch.mockRejectedValueOnce(new RecusaDeNegocioError("Nenhuma das apostas marcadas está mais na lista do tipster."));
    await expect(removeBetsAction("canal", [BET_ID], confirmado)).resolves.toEqual({ ok: false, erro: "Nenhuma das apostas marcadas está mais na lista do tipster." });
    mocks.bankroll.mockResolvedValueOnce(null);
    await expect(restoreBetsAction("canal", [BET_ID])).resolves.toEqual({ ok: false, erro: 'Tipster "canal" não encontrado.' });
    expect(mocks.restoreBatch).not.toHaveBeenCalled();
  });

  it("ids malformados ou lote vazio são erro de cliente, antes de consultar", async () => {
    await expect(removeBetsAction("canal", [], confirmado)).rejects.toThrow("Apostas inválidas");
    await expect(removeBetsAction("canal", ["nao-e-uuid"], confirmado)).rejects.toThrow("Apostas inválidas");
    expect(mocks.bankroll).not.toHaveBeenCalled();
  });

  it("sem sessão não consulta nem remove", async () => {
    mocks.session.mockRejectedValue(new Error("Sessão inválida — faça login novamente."));
    await expect(removeBetsAction("canal", [BET_ID], confirmado)).rejects.toThrow("Sessão inválida");
    await expect(previewBetRemovalAction("canal", [BET_ID])).rejects.toThrow("Sessão inválida");
    expect(mocks.removeBatch).not.toHaveBeenCalled();
    expect(mocks.planBatch).not.toHaveBeenCalled();
  });
});
