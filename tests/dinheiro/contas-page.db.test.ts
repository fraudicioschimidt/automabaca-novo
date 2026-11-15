import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/src/infra/prisma";
import type { Prisma } from "@/src/generated/prisma/client";
import { createTestDb, type TestDb } from "../helpers/db";
import { getContasData } from "@/app/_design/adapters/contas";
import { getContasPageData } from "@/src/services/painel/contas";
import { criarConta, registrarMovimentacaoManual } from "@/src/services/contas/manage";
import { excluirBankroll } from "@/src/services/bankrolls/manage";

/**
 * Totais de Contas somam o histórico COMPLETO, não a janela de 60 do display:
 * depositado, sacado e resultado não podem errar depois de 60 lançamentos.
 */
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

describe("getContasPageData — totais sobre o histórico completo", () => {
  it("limita no banco a janela de 60 por conta sem truncar os totais históricos", async () => {
    const accounts = await db.prisma.conta.createManyAndReturn({ data: [
      { casaDeAposta: "Casa A", titular: "Sintético", saldoInicial: 0, saldoAtual: 900 },
      { casaDeAposta: "Casa B", titular: "Sintético", saldoInicial: 0, saldoAtual: 900 },
    ] });
    for (const account of accounts) await db.prisma.$executeRaw`
      INSERT INTO movimentacoes(id, "contaId", tipo, valor, "saldoApos", data)
      SELECT gen_random_uuid()::text, ${account.id}, 'DEPOSITO'::"MovimentacaoTipo", 10, n*10,
        '2026-09-01T12:00:00Z'::timestamptz + n*interval '1 minute'
      FROM generate_series(1,90) n`;
    let transferred = 0;
    const realTx = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => realTx(async (tx) => {
      const read = tx.$queryRaw.bind(tx);
      const querySpy = vi.spyOn(tx, "$queryRaw").mockImplementation((async (...args) => {
        const rows = await read(...args);
        if (Array.isArray(rows)) transferred += rows.length;
        return rows;
      }) as typeof tx.$queryRaw);
      try { return await fn(tx); } finally { querySpy.mockRestore(); }
    }, options)) as typeof prisma.$transaction);
    try {
      const page = await getContasPageData();
      expect(page.ativas).toHaveLength(2);
      for (const card of page.ativas) {
        expect(card.movimentacoes).toHaveLength(60);
        expect(card.movimentacoesTotal).toBe(90);
        expect(card.depositado).toBe(900);
        expect(card.movimentacoes[0]!.saldoApos).toBe(900);
        expect(card.movimentacoes.at(-1)!.saldoApos).toBe(310);
      }
      expect(transferred).toBe(120);
    } finally { spy.mockRestore(); }
  });

  it("mantém saldo, totais e extrato no mesmo snapshot durante um depósito", async () => {
    const { contaId } = await criarConta({ casaDeAposta: "Casa", titular: "Sintético", saldoInicial: 100 }, { client: db.prisma });
    let deposited = false;
    const interceptRead = (client: Prisma.TransactionClient) => {
      const read = client.conta.findMany.bind(client.conta);
      return vi.spyOn(client.conta, "findMany").mockImplementation((async (args) => {
        const rows = await read(args);
        if (!deposited) {
          deposited = true;
          await registrarMovimentacaoManual({ contaId, tipo: "DEPOSITO", valor: 50,
            clientMutationId: "deposito-durante-leitura", actor: "test" }, { client: db.prisma });
        }
        return rows;
      }) as typeof client.conta.findMany);
    };
    const rootSpy = interceptRead(prisma);
    const realTx = prisma.$transaction.bind(prisma);
    const txSpy = vi.spyOn(prisma, "$transaction").mockImplementation((async (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => realTx(async (tx) => {
      const readSpy = interceptRead(tx);
      try { return await fn(tx); } finally { readSpy.mockRestore(); }
    }, options)) as typeof prisma.$transaction);
    try {
      const page = await getContasPageData();
      expect(deposited).toBe(true);
      const card = page.ativas.find((row) => row.id === contaId)!;
      expect(card).toMatchObject({ saldoAtual: 100, depositado: 100, lucroLiquido: 0, movimentacoesTotal: 1 });
      expect(card.movimentacoes).toHaveLength(1);
      expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual)).toBe(150);
    } finally { txSpy.mockRestore(); rootSpy.mockRestore(); }
    expect((await getContasPageData()).ativas.find((row) => row.id === contaId))
      .toMatchObject({ saldoAtual: 150, depositado: 150, lucroLiquido: 0, movimentacoesTotal: 2 });
  });

  it("a exclusão definitiva da banca remove também seu vínculo operacional", async () => {
    const viva = await db.prisma.bankroll.create({
      data: { nome: "Viva", slug: "conta-viva" },
    });
    const excluida = await db.prisma.bankroll.create({
      data: { nome: "Excluída", slug: "conta-excluida" },
    });
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Bet365",
        titular: "Fabricio",
        saldoInicial: 0,
        saldoAtual: 0,
        bankrollLinks: { create: [{ bankrollId: viva.id }, { bankrollId: excluida.id }] },
      },
    });
    await excluirBankroll(excluida.id, "test");

    const page = await getContasPageData();
    const card = page.ativas.find((item) => item.id === conta.id);
    expect(card?.bancas).toEqual(["Viva"]);
    expect(card?.bancaIds).toEqual([viva.id]);

    const acc = await getContasData();
    expect(acc.accounts.find((item) => item.id === conta.id)?.bankroll).toBe("Viva");
    expect(acc.accounts.find((item) => item.id === conta.id)?.bankrollIds).toEqual([viva.id]);
  });

  it("depositado soma TODAS as movimentações (> 60), não só as 60 do display", async () => {
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Bet365", titular: "Fabricio", saldoInicial: 0, saldoAtual: 61 },
    });
    const movs: Prisma.MovimentacaoCreateManyInput[] = Array.from({ length: 61 }, (_, i) => ({
      contaId: conta.id,
      tipo: "DEPOSITO",
      valor: 1,
      saldoApos: i + 1,
      data: new Date(Date.UTC(2026, 0, 1, 0, i)),
    }));
    await db.prisma.movimentacao.createMany({ data: movs });

    const page = await getContasPageData();
    const card = [...page.ativas, ...page.limitadas, ...page.encerradas].find(
      (c) => c.id === conta.id,
    );
    expect(card).toBeDefined();
    expect(card!.depositado).toBe(61); // somou as 61, não as 60 do display
    expect(card!.movimentacoes.length).toBe(60); // display segue limitado a 60
    expect(card!.movimentacoesTotal).toBe(61); // legenda informa o total, não a janela

    const acc = await getContasData();
    expect(acc.accounts.find((item) => item.id === conta.id)?.moveCount).toBe(61);
  });

  it("usa a transição auditada para LIMITADA, não a última atualização da conta", async () => {
    const limitadaEm = new Date("2026-02-10T12:00:00.000Z");
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Superbet",
        titular: "Fabricio",
        status: "LIMITADA",
        saldoInicial: 100,
        saldoAtual: 100,
      },
    });
    await db.prisma.auditEvent.create({
      data: {
        actor: "test",
        action: "conta.status",
        resource: "conta",
        resourceId: conta.id,
        details: { from: "ATIVA", status: "LIMITADA" },
        createdAt: limitadaEm,
      },
    });
    await db.prisma.movimentacao.create({
      data: {
        contaId: conta.id,
        tipo: "AJUSTE_MANUAL",
        valor: 0,
        saldoApos: 100,
        data: new Date("2026-03-15T12:00:00.000Z"),
      },
    });

    const page = await getContasPageData();
    expect(page.limitadas.find((item) => item.id === conta.id)?.limitadaEm).toEqual(limitadaEm);

    const acc = await getContasData();
    expect(acc.accounts.find((item) => item.id === conta.id)?.limitedAt).toBe("10/02/2026");
  });

  it("separa bônus de depósito e o reconhece no lucro líquido", async () => {
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Pinnacle", titular: "Fabricio", saldoInicial: 100, saldoAtual: 120 },
    });
    await db.prisma.movimentacao.createMany({
      data: [
        { contaId: conta.id, tipo: "DEPOSITO", valor: 100, saldoApos: 100 },
        { contaId: conta.id, tipo: "BONUS", valor: 20, saldoApos: 120 },
      ],
    });

    const page = await getContasPageData();
    const card = page.ativas.find((item) => item.id === conta.id);

    expect(card?.depositado).toBe(100);
    expect(card?.lucroLiquido).toBe(20);
  });

  it("mantém o titular específico de cada conta no adaptador visual", async () => {
    await db.prisma.conta.createMany({
      data: [
        { casaDeAposta: "Bet365", titular: "Titular A", saldoInicial: 10, saldoAtual: 10 },
        { casaDeAposta: "Pinnacle", titular: "Titular B", saldoInicial: 20, saldoAtual: 20 },
      ],
    });

    const acc = await getContasData();
    const titulares = Object.fromEntries(
      acc.accounts.map((account) => [account.name, account.titular]),
    );

    expect(titulares).toMatchObject({
      Bet365: "Titular A",
      Pinnacle: "Titular B",
    });
  });
});
