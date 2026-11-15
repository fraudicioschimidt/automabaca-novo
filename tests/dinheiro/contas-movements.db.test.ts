import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  ContaIndisponivelError,
  processMovimentacaoFromBetTx,
  type ProcessMovimentacaoFromBetParams,
} from "@/src/services/contas/movements";
import {
  type SerializableTransactionClient,
  runSerializableTransaction,
} from "@/src/services/shared/transaction";
import { sumMoneyBy, toNumber } from "@/src/domain/money";
import { applyManualBetStatusChange as applyBetStatusChange } from "../helpers/settle";

/** Financeiro contra o Postgres real: constraint e isolamento Serializable de verdade. */

/** A reconciliação roda na transação de quem muda o status; aqui, sozinha numa. */
function processMovimentacaoFromBet(
  params: ProcessMovimentacaoFromBetParams,
  options: { client: SerializableTransactionClient },
) {
  return runSerializableTransaction(
    "test.processMovimentacaoFromBet",
    (tx) => processMovimentacaoFromBetTx(tx, params),
    options,
  );
}

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

async function seed(params?: { saldoInicial?: number }) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Banca Teste", slug: "banca-teste", valorUnidade: 100 },
  });
  const conta = await db.prisma.conta.create({
    data: {
      casaDeAposta: "Bet365",
      titular: "Fabricio",
      saldoInicial: params?.saldoInicial ?? 1000,
      saldoAtual: params?.saldoInicial ?? 1000,
    },
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      contaId: conta.id,
      data: new Date("2026-08-01T16:00:00Z"),
      evento: "Flamengo vs Palmeiras",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Flamengo",
      odds: 2.0,
      stake: 1,
      status: "PENDING",
    },
  });
  return { bankroll, conta, bet };
}

const opts = () => ({ client: db.prisma });

async function saldoDe(contaId: string): Promise<number> {
  const conta = await db.prisma.conta.findUniqueOrThrow({
    where: { id: contaId },
    select: { saldoAtual: true },
  });
  return toNumber(conta.saldoAtual);
}

describe("processMovimentacaoFromBetTx (Postgres real)", () => {
  it("WON cria GANHO_APOSTA com saldoApos correto", async () => {
    const { conta, bet } = await seed();
    await processMovimentacaoFromBet(
      {
        betId: bet.id,
        newStatus: "WON",
        lucroUnidades: 1,
        valorUnidade: 100,
        contaId: conta.id,
      },
      opts(),
    );

    expect(await saldoDe(conta.id)).toBe(1100);
    const movs = await db.prisma.movimentacao.findMany({ where: { betId: bet.id } });
    expect(movs).toHaveLength(1);
    expect(movs[0]!.tipo).toBe("GANHO_APOSTA");
    expect(toNumber(movs[0]!.valor)).toBe(100);
    expect(toNumber(movs[0]!.saldoApos)).toBe(1100);
  });

  it("o lançamento e o estorno levam quem mudou o status; sem ator, system", async () => {
    const { conta, bet } = await seed();
    const params = { betId: bet.id, valorUnidade: 100, contaId: conta.id };
    await processMovimentacaoFromBet({ ...params, newStatus: "WON", lucroUnidades: 1, actor: "fabricio" }, opts());
    await processMovimentacaoFromBet({ ...params, newStatus: "LOST", lucroUnidades: -1, actor: "agent:gemini:por:fabricio" }, opts());
    await processMovimentacaoFromBet({ ...params, newStatus: "VOID", lucroUnidades: 0 }, opts());

    const movs = await db.prisma.movimentacao.findMany({ where: { betId: bet.id } });
    expect(movs.map((m) => `${m.tipo} ${m.actor}`).sort()).toEqual([
      "ESTORNO agent:gemini:por:fabricio",
      "ESTORNO system",
      "GANHO_APOSTA fabricio",
      "PERDA_APOSTA agent:gemini:por:fabricio",
    ]);
  });

  it("WON → VOID estorna e o saldo volta ao inicial", async () => {
    const { conta, bet } = await seed();
    const params = { betId: bet.id, valorUnidade: 100, contaId: conta.id };
    await processMovimentacaoFromBet(
      { ...params, newStatus: "WON", lucroUnidades: 1 },
      opts(),
    );
    await processMovimentacaoFromBet(
      { ...params, newStatus: "VOID", lucroUnidades: 0 },
      opts(),
    );

    expect(await saldoDe(conta.id)).toBe(1000);
    const movs = await db.prisma.movimentacao.findMany({ where: { betId: bet.id } });
    expect(movs.map((m) => m.tipo).sort()).toEqual(["ESTORNO", "GANHO_APOSTA"]);
  });

  it("ciclo WON → LOST → WON não conta em dobro", async () => {
    const { conta, bet } = await seed();
    const params = { betId: bet.id, valorUnidade: 100, contaId: conta.id };

    await processMovimentacaoFromBet(
      { ...params, newStatus: "WON", lucroUnidades: 1 },
      opts(),
    );
    await processMovimentacaoFromBet(
      { ...params, newStatus: "LOST", lucroUnidades: -1 },
      opts(),
    );
    await processMovimentacaoFromBet(
      { ...params, newStatus: "WON", lucroUnidades: 1 },
      opts(),
    );

    // Estado final = WON: saldo 1000 + 100.
    expect(await saldoDe(conta.id)).toBe(1100);

    // Invariante do ledger: saldoInicial + Σ movimentações = saldoAtual.
    const movs = await db.prisma.movimentacao.findMany({ where: { contaId: conta.id } });
    const somaLedger = sumMoneyBy(movs, (m) => toNumber(m.valor), 2);
    expect(1000 + somaLedger).toBe(1100);
  });

  it("CASHOUT negativo lança PERDA_APOSTA", async () => {
    const { conta, bet } = await seed();
    await processMovimentacaoFromBet(
      {
        betId: bet.id,
        newStatus: "CASHOUT",
        lucroUnidades: -0.4,
        valorUnidade: 100,
        contaId: conta.id,
      },
      opts(),
    );
    const movs = await db.prisma.movimentacao.findMany({ where: { betId: bet.id } });
    expect(movs).toHaveLength(1);
    expect(movs[0]!.tipo).toBe("PERDA_APOSTA");
    expect(await saldoDe(conta.id)).toBe(960);
  });

  it("descrição preserva fração de unidade que movimenta valor financeiro", async () => {
    const { conta, bet } = await seed();
    await processMovimentacaoFromBet(
      {
        betId: bet.id,
        newStatus: "LOST",
        lucroUnidades: -0.004,
        valorUnidade: 100,
        contaId: conta.id,
      },
      opts(),
    );
    const movimento = await db.prisma.movimentacao.findFirstOrThrow({
      where: { betId: bet.id },
    });
    expect(toNumber(movimento.valor)).toBe(-0.4);
    expect(movimento.descricao).toContain("-0.004u");
    expect(movimento.descricao).not.toContain("-0.00u");
  });

  it("valor abaixo de meio centavo não gera lançamento", async () => {
    const { conta, bet } = await seed();
    await processMovimentacaoFromBet(
      {
        betId: bet.id,
        newStatus: "WON",
        lucroUnidades: 0.00001,
        valorUnidade: 100,
        contaId: conta.id,
      },
      opts(),
    );
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
    expect(await saldoDe(conta.id)).toBe(1000);
  });

  it("conta soft-deletada → ABORTA com ContaIndisponivelError e nada muda (fail-loud)", async () => {
    const { conta, bet } = await seed();
    await processMovimentacaoFromBet(
      {
        betId: bet.id,
        newStatus: "WON",
        lucroUnidades: 1,
        valorUnidade: 100,
        contaId: conta.id,
      },
      opts(),
    );

    // Conta é deletada com a aposta ainda em ciclo de vida…
    await db.prisma.conta.update({
      where: { id: conta.id },
      data: { deletedAt: new Date() },
    });

    // …e a transição seguinte NÃO pode dessincronizar o ledger em silêncio.
    await expect(
      processMovimentacaoFromBet(
        {
          betId: bet.id,
          newStatus: "VOID",
          lucroUnidades: 0,
          valorUnidade: 100,
          contaId: conta.id,
        },
        opts(),
      ),
    ).rejects.toThrow(ContaIndisponivelError);

    // Rollback total: saldo e ledger intactos (sem ESTORNO parcial).
    expect(await saldoDe(conta.id)).toBe(1100);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(1);
  });

  it("aposta movida de conta: estorno na conta antiga, lançamento na nova (multi-conta)", async () => {
    const { conta: contaA, bet } = await seed();
    const contaB = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Pinnacle",
        titular: "Fabricio",
        saldoInicial: 2000,
        saldoAtual: 2000,
      },
    });

    // Liquida WON na conta A…
    await processMovimentacaoFromBet(
      { betId: bet.id, newStatus: "WON", lucroUnidades: 1, valorUnidade: 100, contaId: contaA.id },
      opts(),
    );
    // …o operador move a aposta para a conta B e re-liquida como LOST.
    await db.prisma.bet.update({ where: { id: bet.id }, data: { contaId: contaB.id } });
    await processMovimentacaoFromBet(
      { betId: bet.id, newStatus: "LOST", lucroUnidades: -1, valorUnidade: 100, contaId: contaB.id },
      opts(),
    );

    // Conta A volta ao inicial (GANHO estornado); conta B leva a perda.
    expect(await saldoDe(contaA.id)).toBe(1000);
    expect(await saldoDe(contaB.id)).toBe(1900);

    // Invariante por conta: saldoInicial + Σ movimentações = saldoAtual.
    for (const [contaId, inicial] of [[contaA.id, 1000], [contaB.id, 2000]] as const) {
      const movs = await db.prisma.movimentacao.findMany({ where: { contaId } });
      expect(inicial + sumMoneyBy(movs, (m) => toNumber(m.valor), 2)).toBe(await saldoDe(contaId));
    }
  });

  it("conta deletada no MEIO de um ciclo de transições: transição seguinte aborta, ledger intacto", async () => {
    const { conta, bet } = await seed();
    const params = { betId: bet.id, valorUnidade: 100, contaId: conta.id };

    // Ciclo em andamento: WON → LOST (ambas com a conta viva).
    await processMovimentacaoFromBet({ ...params, newStatus: "WON", lucroUnidades: 1 }, opts());
    await processMovimentacaoFromBet({ ...params, newStatus: "LOST", lucroUnidades: -1 }, opts());
    expect(await saldoDe(conta.id)).toBe(900);

    // Conta some no meio do ciclo…
    await db.prisma.conta.update({ where: { id: conta.id }, data: { deletedAt: new Date() } });

    // …a transição seguinte (LOST→WON) aborta inteira: nem estorno parcial.
    await expect(
      processMovimentacaoFromBet({ ...params, newStatus: "WON", lucroUnidades: 1 }, opts()),
    ).rejects.toThrow(ContaIndisponivelError);

    expect(await saldoDe(conta.id)).toBe(900);
    const movs = await db.prisma.movimentacao.findMany({
      where: { betId: bet.id },
      orderBy: { data: "asc" },
    });
    expect(movs.map((m) => m.tipo)).toEqual(["GANHO_APOSTA", "ESTORNO", "PERDA_APOSTA"]);
    expect(1000 + sumMoneyBy(movs, (m) => toNumber(m.valor), 2)).toBe(900);
  });

  it("5 settlements concorrentes na MESMA conta serializam sem perder lançamento", async () => {
    const { bankroll, conta } = await seed();
    const bets = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        db.prisma.bet.create({
          data: {
            sportResolutionStatus: "CONFIRMED",
            sportResolvedAt: new Date(),
            settledAt: null,
            bankrollId: bankroll.id,
            contaId: conta.id,
            data: new Date("2026-08-01T16:00:00Z"),
            evento: `Time A${i} vs Time B${i}`,
            esporte: "Soccer",
            mercado: "Moneyline",
            selecao: `Time A${i}`,
            odds: 2.0,
            stake: 1,
            status: "PENDING",
          },
        }),
      ),
    );

    await Promise.all(
      bets.map((bet) =>
        processMovimentacaoFromBet(
          {
            betId: bet.id,
            newStatus: "WON",
            lucroUnidades: 1,
            valorUnidade: 100,
            contaId: conta.id,
          },
          opts(),
        ),
      ),
    );

    expect(await saldoDe(conta.id)).toBe(1500);
    expect(await db.prisma.movimentacao.count({ where: { contaId: conta.id } })).toBe(5);
  });
});

/**
 * saldoAtual == saldoInicial + Σ movimentações com valorUnidade fracionário: o
 * Postgres arredonda "half away from zero", e se o saldo e a linha do extrato
 * arredondassem cada um por si, um lançamento negativo derivaria 1 centavo.
 */
describe("ledger não deriva com valorUnidade fracionário", () => {
  it.each(["WON", "LOST"] as const)("arredonda diretamente em centavos no status %s", async (status) => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Centavos", slug: "centavos", valorUnidade: 0.99, vincularContas: false },
    });
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "X", titular: "T", saldoInicial: 0, saldoAtual: 0 },
    });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id, contaId: conta.id, data: new Date("2026-01-01"),
        evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A",
        sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(),
        odds: 2, stake: 1.00505,
      },
    });
    // 1.00505 × 0.99 = 0.9949995: arredondar a seis casas antes dos
    // centavos transforma indevidamente 0.99 em 1.00 (e -0.99 em -1.00).
    await applyBetStatusChange({ betId: bet.id, newStatus: status, source: "test" });
    const expected = status === "WON" ? 0.99 : -0.99;
    const [stored, movements] = await Promise.all([
      db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } }),
      db.prisma.movimentacao.findMany({ where: { betId: bet.id } }),
    ]);
    expect(toNumber(stored.saldoAtual)).toBe(expected);
    expect(movements.map((m) => toNumber(m.valor))).toEqual([expected]);
    await applyBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "test" });
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(0);
  });

  it("saldoAtual bate com Σ movimentações após settlements fracionários alternados", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Frac", slug: "frac", valorUnidade: 33.33, sharpMode: "OFF" },
    });
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "X",
        titular: "T",
        saldoInicial: 1000,
        saldoAtual: 1000,
        bankrollLinks: { create: { bankrollId: bankroll.id } },
      },
    });

    // Alterna ganhos/perdas inteiros e meios — gera resíduos de sinais opostos.
    const statuses = [
      "WON",
      "LOST",
      "HALF_WON",
      "HALF_LOST",
      "LOST",
      "WON",
      "HALF_LOST",
      "HALF_WON",
    ] as const;
    for (let i = 0; i < statuses.length; i++) {
      const bet = await db.prisma.bet.create({
        data: {
          sportResolutionStatus: "CONFIRMED",
          sportResolvedAt: new Date(),
          settledAt: null,
          bankrollId: bankroll.id,
          contaId: conta.id,
          data: new Date(),
          evento: "A vs B",
          esporte: "Soccer",
          competicao: "C",
          pais: "P",
          mercado: "Handicap Asiático",
          selecao: "A -0.25",
          odds: 2.5,
          stake: 0.5,
          status: "PENDING",
          source: "t",
          sourceExternalId: `frac-${i}`,
        },
      });
      await applyBetStatusChange({ betId: bet.id, newStatus: statuses[i]!, source: "test" });
    }

    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    const movs = await db.prisma.movimentacao.findMany({ where: { contaId: conta.id } });
    const esperado = 1000 + sumMoneyBy(movs, (m) => toNumber(m.valor), 2);
    // Invariante exato (tolerância de meio centavo só p/ ruído de float na borda).
    expect(Math.abs(toNumber(contaDb.saldoAtual) - esperado)).toBeLessThan(0.005);
  });
});
