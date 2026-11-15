import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  criarConta,
  editarConta,
  registrarMovimentacaoManual,
  removerConta,
} from "@/src/services/contas/manage";
import { applyManualBetStatusChange as applyBetStatusChange } from "../helpers/settle";
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

describe("ciclo de vida e identidade financeira da conta", () => {
  it("não remove conta zerada enquanto uma aposta final ainda estiver viva", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "Fabricio", saldoInicial: 100 },
      opts(),
    );
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Conta viva", slug: "conta-viva", valorUnidade: 100 },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        contaId,
        data: new Date("2026-08-13T18:00:00Z"),
        evento: "Time A vs Time B",
        esporte: "Soccer",
        casaDeAposta: "Bet365",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2,
        stake: 1,
      },
    });

    await applyBetStatusChange(
      { betId: bet.id, newStatus: "LOST", source: "test:account-lifecycle" },
      opts(),
    );
    expect(
      toNumber(
        (await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual,
      ),
    ).toBe(0);

    await expect(removerConta({ contaId }, opts())).rejects.toThrow(/apostas vivas/i);
    expect(
      (await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).deletedAt,
    ).toBeNull();

    await expect(
      applyBetStatusChange(
        { betId: bet.id, newStatus: "PENDING", source: "test:account-reopen" },
        opts(),
      ),
    ).resolves.toMatchObject({ status: "PENDING" });
    expect(
      toNumber(
        (await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual,
      ),
    ).toBe(100);
  });

  it("torna bookmaker e titular imutáveis depois do primeiro movimento", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "Pessoa Física", saldoInicial: 0 },
      opts(),
    );

    await editarConta(
      {
        contaId,
        casaDeAposta: "Betano",
        titular: "Empresa Ltda",
        apelido: "antes do ledger",
      },
      opts(),
    );
    await registrarMovimentacaoManual(
      {
        contaId,
        tipo: "DEPOSITO",
        valor: 100,
        clientMutationId: randomUUID(),
      },
      opts(),
    );

    await expect(
      editarConta(
        {
          contaId,
          casaDeAposta: "Pinnacle",
          titular: "Empresa Ltda",
          apelido: "não pode trocar casa",
        },
        opts(),
      ),
    ).rejects.toThrow(/identidade.*primeiro movimento/i);
    await expect(
      editarConta(
        {
          contaId,
          casaDeAposta: "Betano",
          titular: "Outra Pessoa",
          apelido: "não pode trocar titular",
        },
        opts(),
      ),
    ).rejects.toThrow(/identidade.*primeiro movimento/i);

    const conta = await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } });
    expect(conta).toMatchObject({
      casaDeAposta: "Betano",
      titular: "Empresa Ltda",
      apelido: "antes do ledger",
    });
  });

  it("continua permitindo apelido e vínculos sem reatribuir a identidade", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Nova banca", slug: "nova-banca", valorUnidade: 100 },
    });
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "Fabricio", saldoInicial: 100 },
      opts(),
    );

    await editarConta(
      {
        contaId,
        casaDeAposta: "Bet365",
        titular: "Fabricio",
        apelido: "principal",
        bankrollIds: [bankroll.id],
      },
      opts(),
    );

    const conta = await db.prisma.conta.findUniqueOrThrow({
      where: { id: contaId },
      include: { bankrollLinks: true },
    });
    expect(conta).toMatchObject({
      casaDeAposta: "Bet365",
      titular: "Fabricio",
      apelido: "principal",
    });
    expect(conta.bankrollLinks.map((link) => link.bankrollId)).toEqual([bankroll.id]);
  });
});
