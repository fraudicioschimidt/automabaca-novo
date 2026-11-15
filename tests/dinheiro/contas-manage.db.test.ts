import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  alterarStatusConta,
  criarConta,
  registrarMovimentacaoManual as registrarMovimentacaoManualReal,
  removerConta,
} from "@/src/services/contas/manage";
import { toNumber } from "@/src/domain/money";

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
});

const opts = () => ({ client: db.prisma });

function registrarMovimentacaoManual(
  params: Omit<Parameters<typeof registrarMovimentacaoManualReal>[0], "clientMutationId"> & {
    clientMutationId?: string;
  },
  options = opts(),
) {
  return registrarMovimentacaoManualReal({
    ...params,
    clientMutationId: params.clientMutationId ?? randomUUID(),
  }, options);
}

describe("gestão de contas (Postgres real)", () => {
  it("recusa movimentação manual sem chave de idempotência", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "F", saldoInicial: 0 },
      opts(),
    );
    const semChave = { contaId, tipo: "DEPOSITO", valor: 10 } as unknown as
      Parameters<typeof registrarMovimentacaoManualReal>[0];
    await expect(registrarMovimentacaoManualReal(semChave, opts())).rejects.toThrow(/idempot/i);
  });

  it("reenvios simultâneos da mesma movimentação lançam o valor uma vez", async () => {
    const { contaId } = await criarConta({ casaDeAposta: "Bet365", titular: "Teste", saldoInicial: 100 }, opts());
    const input = { contaId, tipo: "DEPOSITO" as const, valor: 25, clientMutationId: randomUUID(), actor: "test" };
    const results = await Promise.all(Array.from({ length: 4 }, () => registrarMovimentacaoManualReal(input, opts())));
    expect(results.every((result) => result.saldoApos === 125)).toBe(true);
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual)).toBe(125);
    expect(await db.prisma.movimentacao.count({ where: { clientMutationId: input.clientMutationId } })).toBe(1);
    await expect(registrarMovimentacaoManualReal({ ...input, valor: 30 }, opts())).rejects.toThrow(/outra movimentação/);
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual)).toBe(125);
  });

  it("reenvio da criação com o mesmo pedido retorna uma conta e um depósito inicial", async () => {
    const input = { casaDeAposta: "Bet365", titular: "Teste", saldoInicial: 100, actor: "test", requestId: randomUUID() };
    const results = await Promise.all(Array.from({ length: 4 }, () => criarConta(input, opts())));
    const first = results[0]!;
    expect(results.every((result) => result.contaId === first.contaId)).toBe(true);
    await db.prisma.conta.update({ where: { id: first.contaId }, data: { apelido: "Editada" } });
    expect(await criarConta(input, opts())).toEqual(first);
    await expect(criarConta({ ...input, saldoInicial: 200 }, opts())).rejects.toThrow(/outros dados/);
    expect(await db.prisma.conta.count()).toBe(1);
    expect(await db.prisma.movimentacao.count()).toBe(1);
    expect(await criarConta({ ...input, requestId: randomUUID() }, opts())).not.toEqual(first);
    expect(await db.prisma.conta.count()).toBe(2);
  });

  it("falha depois da criação reverte conta, depósito e recibo antes de repetir", async () => {
    const input = { casaDeAposta: "Bet365", titular: "Teste", saldoInicial: 100, actor: "test", requestId: randomUUID() };
    await expect(criarConta(input, { client: {
      $transaction: async (operation, options) => db.prisma.$transaction(async (tx) => {
        await operation(tx);
        throw new Error("falha depois da criação");
      }, options),
    } })).rejects.toThrow("falha depois da criação");
    expect(await db.prisma.conta.count()).toBe(0);
    expect(await db.prisma.movimentacao.count()).toBe(0);
    expect(await db.prisma.creationReceipt.count()).toBe(0);
    await criarConta(input, opts());
    expect(await db.prisma.conta.count()).toBe(1);
    expect(await db.prisma.movimentacao.count()).toBe(1);
  });

  it("recibo de criação não ressuscita conta removida", async () => {
    const input = { casaDeAposta: "Bet365", titular: "Teste", saldoInicial: 0, actor: "test", requestId: randomUUID() };
    const first = await criarConta(input, opts());
    await removerConta({ contaId: first.contaId }, opts());
    await expect(criarConta(input, opts())).rejects.toThrow(/conta foi removida/);
    expect(await db.prisma.conta.count()).toBe(1);
    expect(await db.prisma.creationReceipt.count()).toBe(1);
  });

  it("criar conta lança o saldo inicial como DEPOSITO no ledger", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "Maria", saldoInicial: 500, actor: "maria-admin" },
      opts(),
    );
    const conta = await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } });
    expect(toNumber(conta.saldoAtual)).toBe(500);
    const movs = await db.prisma.movimentacao.findMany({ where: { contaId } });
    expect(movs).toHaveLength(1);
    expect(movs[0]!.tipo).toBe("DEPOSITO");
    expect(toNumber(movs[0]!.saldoApos)).toBe(500);
    expect(movs[0]!.actor).toBe("maria-admin");
    expect(await db.prisma.auditEvent.count({
      where: { action: "conta.create", actor: "maria-admin", resourceId: contaId },
    })).toBe(1);
  });

  it("depósito e saque mantêm o invariante saldo = inicial + Σ movimentações", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Betano", titular: "F", saldoInicial: 0 },
      opts(),
    );
    await registrarMovimentacaoManual(
      { contaId, tipo: "DEPOSITO", valor: 300 },
      opts(),
    );
    const { saldoApos } = await registrarMovimentacaoManual(
      { contaId, tipo: "SAQUE", valor: 120.5 },
      opts(),
    );
    expect(saldoApos).toBe(179.5);
    const conta = await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } });
    expect(toNumber(conta.saldoAtual)).toBe(179.5);
  });

  it("arredonda valor sub-centavo na borda (saldoApos não vaza float)", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "M", saldoInicial: 100 },
      opts(),
    );
    // A tela manda parseFloat sem casas; "10,999" → 10.999. Vira 11.00 → saldoApos 111 exato.
    const { saldoApos } = await registrarMovimentacaoManual(
      { contaId, tipo: "DEPOSITO", valor: 10.999 },
      opts(),
    );
    expect(saldoApos).toBe(111); // antes do fix retornava 110.999 (float não arredondado)
    const conta = await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } });
    expect(toNumber(conta.saldoAtual)).toBe(111);
  });

  it("saque acima do saldo é rejeitado sem tocar no ledger", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Betano", titular: "F", saldoInicial: 50 },
      opts(),
    );
    await expect(
      registrarMovimentacaoManual({ contaId, tipo: "SAQUE", valor: 100 }, opts()),
    ).rejects.toThrow(/saldo/i);
    expect(await db.prisma.movimentacao.count({ where: { contaId } })).toBe(1);
  });

  it("conta negativa aceita depósito parcial, bônus e ajuste positivo; só a saída é recusada", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Betano", titular: "F", saldoInicial: 0 },
      opts(),
    );
    // Aposta perdida numa conta zerada: o lançamento de aposta não tem piso.
    await db.prisma.conta.update({ where: { id: contaId }, data: { saldoAtual: -100 } });

    expect((await registrarMovimentacaoManual({ contaId, tipo: "DEPOSITO", valor: 50 })).saldoApos).toBe(-50);
    expect((await registrarMovimentacaoManual({ contaId, tipo: "BONUS", valor: 10 })).saldoApos).toBe(-40);
    expect((await registrarMovimentacaoManual({ contaId, tipo: "AJUSTE_MANUAL", valor: 15 })).saldoApos).toBe(-25);
    await expect(registrarMovimentacaoManual({ contaId, tipo: "SAQUE", valor: 5 }))
      .rejects.toThrow("Saque maior que o saldo disponível.");
    await expect(registrarMovimentacaoManual({ contaId, tipo: "AJUSTE_MANUAL", valor: -5 }))
      .rejects.toThrow("Ajuste negativo maior que o saldo disponível.");
    const conta = await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } });
    expect(toNumber(conta.saldoAtual)).toBe(-25);
  });

  it("AJUSTE_MANUAL aceita valor negativo (correção de débito)", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "M", saldoInicial: 100 },
      opts(),
    );
    const { saldoApos } = await registrarMovimentacaoManual(
      { contaId, tipo: "AJUSTE_MANUAL", valor: -25.5 },
      opts(),
    );
    expect(saldoApos).toBe(74.5);
    const conta = await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } });
    expect(toNumber(conta.saldoAtual)).toBe(74.5);
  });

  it("não inverte silenciosamente o sinal de depósito, saque ou bônus", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "M", saldoInicial: 100 },
      opts(),
    );
    for (const tipo of ["DEPOSITO", "SAQUE", "BONUS"] as const) {
      await expect(
        registrarMovimentacaoManual({ contaId, tipo, valor: -10 }, opts()),
      ).rejects.toThrow(/valor inválido/i);
    }
  });

  it("tipo de settlement não passa pela via manual; status e remoção funcionam", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "F", saldoInicial: 10 },
      opts(),
    );
    await expect(
      registrarMovimentacaoManual(
        { contaId, tipo: "GANHO_APOSTA", valor: 10 },
        opts(),
      ),
    ).rejects.toThrow(/manual/i);

    await alterarStatusConta({ contaId, status: "LIMITADA" }, opts());
    expect(
      (await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).status,
    ).toBe("LIMITADA");

    await registrarMovimentacaoManual({ contaId, tipo: "SAQUE", valor: 10 }, opts());
    await removerConta({ contaId }, opts());
    const conta = await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } });
    expect(conta.deletedAt).not.toBeNull();
    await expect(
      registrarMovimentacaoManual({ contaId, tipo: "DEPOSITO", valor: 5 }, opts()),
    ).rejects.toThrow(/inexistente|removida/i);
  });

  it("não remove conta com saldo zerado e extrato ainda divergente", async () => {
    const { contaId } = await criarConta({ casaDeAposta: "Casa", titular: "Sintético", saldoInicial: 100 }, opts());
    await db.prisma.conta.update({ where: { id: contaId }, data: { saldoAtual: 0 } });
    await expect(removerConta({ contaId }, opts())).rejects.toThrow(/reconcilie.*saldo.*movimenta/i);
    expect((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).deletedAt).toBeNull();
    expect(await db.prisma.movimentacao.count({ where: { contaId } })).toBe(1);
  });

  it("remover é idempotente; mudar status de conta removida falha acionável", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "F", saldoInicial: 10 },
      opts(),
    );
    await registrarMovimentacaoManual({ contaId, tipo: "SAQUE", valor: 10 }, opts());
    await removerConta({ contaId }, opts());
    // 2ª remoção (double-click/retry) → no-op, sem P2025 cru.
    await expect(removerConta({ contaId }, opts())).resolves.toBeUndefined();
    // Status em conta já removida → erro em PT, não Prisma cru.
    await expect(
      alterarStatusConta({ contaId, status: "LIMITADA" }, opts()),
    ).rejects.toThrow(/inexistente|removida/i);
  });

  it("status igual ao atual não grava audit event fantasma", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "F", saldoInicial: 0 },
      opts(),
    );
    const contar = () =>
      db.prisma.auditEvent.count({
        where: { action: "conta.status", resourceId: contaId },
      });

    await alterarStatusConta({ contaId, status: "LIMITADA" }, opts());
    expect(await contar()).toBe(1);

    // Repetir o MESMO status é no-op: sem update, sem evento.
    await alterarStatusConta({ contaId, status: "LIMITADA" }, opts());
    expect(await contar()).toBe(1);

    // Troca real continua registrando.
    await alterarStatusConta({ contaId, status: "ATIVA" }, opts());
    expect(await contar()).toBe(2);
    expect(
      (await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).status,
    ).toBe("ATIVA");
  });

  it("não remove conta com saldo ou aposta viva", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "F", saldoInicial: 10 },
      opts(),
    );
    await expect(removerConta({ contaId }, opts())).rejects.toThrow(/zere o saldo/i);
    await registrarMovimentacaoManual({ contaId, tipo: "SAQUE", valor: 10 }, opts());

    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Pendente", slug: "pendente", valorUnidade: 100 },
    });
    await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        contaId,
        data: new Date("2026-07-15T15:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
      },
    });
    await expect(removerConta({ contaId }, opts())).rejects.toThrow(/apostas vivas/i);
  });

  it("movimentação manual registra ator no ledger e AuditEvent na mesma transação", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "F", saldoInicial: 0 },
      opts(),
    );
    await registrarMovimentacaoManual(
      { contaId, tipo: "DEPOSITO", valor: 25, actor: "operador" },
      opts(),
    );
    const mov = await db.prisma.movimentacao.findFirstOrThrow({ where: { contaId } });
    expect(mov.actor).toBe("operador");
    expect(await db.prisma.auditEvent.count({
      where: { action: "conta.movement", actor: "operador", resourceId: mov.id },
    })).toBe(1);
  });

  it("rejeita textos e valores acima dos limites persistíveis", async () => {
    await expect(criarConta({
      casaDeAposta: "x".repeat(101),
      titular: "F",
      saldoInicial: 0,
    }, opts())).rejects.toThrow(/100 caracteres/i);
    const { contaId } = await criarConta({
      casaDeAposta: "Bet365",
      titular: "F",
      saldoInicial: 0,
    }, opts());
    await expect(registrarMovimentacaoManual({
      contaId,
      tipo: "DEPOSITO",
      valor: 10_000_000_000,
    }, opts())).rejects.toThrow(/limite financeiro/i);
    expect(await db.prisma.movimentacao.count({ where: { contaId } })).toBe(0);
  });
});
