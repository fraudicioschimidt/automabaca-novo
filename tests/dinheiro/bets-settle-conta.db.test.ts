import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { applyManualBetStatusChange as applyBetStatusChange } from "../helpers/settle";
import {
  applyAutomaticBetStatusChange,
  applyManualBetStatusChangeTx as applyBetStatusChangeTx,
} from "@/src/services/bets/settle";
import { toNumber } from "@/src/domain/money";

/**
 * Conta que recebe o lançamento da liquidação: vínculo refeito na hora, conta
 * única elegível, e a ação "liquidada sem conta" quando não há.
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

const opts = () => ({ client: db.prisma });

describe("liquidação e conta da aposta (Postgres real)", () => {
  it("liquida SEM mover ledger quando a conta da casa é de outra banca", async () => {
    const dona = await db.prisma.bankroll.create({
      data: { nome: "Dona", slug: "dona", valorUnidade: 50, vincularContas: true },
    });
    const alvo = await db.prisma.bankroll.create({
      data: { nome: "Alvo", slug: "alvo", valorUnidade: 50, vincularContas: true },
    });
    await db.prisma.conta.create({
      data: {
        casaDeAposta: "Betano",
        titular: "Conta da dona",
        saldoInicial: 500,
        saldoAtual: 500,
        bankrollLinks: { create: { bankrollId: dona.id } },
      },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: alvo.id,
        contaId: null,
        casaDeAposta: "Betano",
        data: new Date("2026-08-02T19:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        valorUnidade: 50,
      },
    });
    const result = await applyBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "manual" },
      opts(),
    );

    // O resultado É registrado.
    expect(result.status).toBe("WON");
    const depois = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(depois.status).toBe("WON");
    expect(depois.contaId).toBeNull();
    // O ledger NÃO é movido — escolher uma conta arbitrária é que seria o erro.
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
    // E a pendência fica visível, sem se auto-resolver.
    expect(result.semContaElegivel).toMatchObject({ casaDeAposta: "Betano" });
    const acao = await db.prisma.operationalAction.findFirst({
      where: { resource: "bet", resourceId: bet.id, status: "OPEN" },
      select: { title: true, description: true },
    });
    expect(acao?.title).toMatch(/sem movimentar conta/i);
    // O texto precisa dizer o CAMINHO de volta, não só o problema.
    expect(acao?.description).toMatch(/Pendente/);
  });

  it("grava aposta e ação sem-conta atomicamente — rollback não deixa metade", async () => {
    const dona = await db.prisma.bankroll.create({
      data: { nome: "Dona rollback", slug: "dona-rollback", valorUnidade: 50 },
    });
    const alvo = await db.prisma.bankroll.create({
      data: {
        nome: "Alvo rollback",
        slug: "alvo-rollback",
        valorUnidade: 50,
        vincularContas: true,
      },
    });
    await db.prisma.conta.create({
      data: {
        casaDeAposta: "Betano",
        titular: "Conta alheia",
        saldoInicial: 500,
        saldoAtual: 500,
        bankrollLinks: { create: { bankrollId: dona.id } },
      },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: alvo.id,
        casaDeAposta: "Betano",
        data: new Date("2026-08-02T19:00:00Z"),
        evento: "Rollback A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
      },
    });

    await expect(db.prisma.$transaction(async (tx) => {
      await applyBetStatusChangeTx(tx, {
        betId: bet.id,
        newStatus: "WON",
        source: "manual:test-rollback",
      });
      expect(await tx.operationalAction.count({
        where: { resource: "bet", resourceId: bet.id },
      })).toBe(1);
      throw new Error("rollback-proposital");
    })).rejects.toThrow("rollback-proposital");

    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .toMatchObject({ status: "PENDING" });
    expect(await db.prisma.operationalAction.count({
      where: { resource: "bet", resourceId: bet.id },
    })).toBe(0);
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id } })).toBe(0);
  });

  it("retry idempotente repara ação sem-conta ausente sem duplicar settlement", async () => {
    const banca = await db.prisma.bankroll.create({
      data: { nome: "Reparo", slug: "reparo", valorUnidade: 50, vincularContas: true },
    });
    await db.prisma.conta.createMany({
      data: [
        { casaDeAposta: "Betano", titular: "A", saldoInicial: 500, saldoAtual: 500 },
        { casaDeAposta: "Betano", titular: "B", saldoInicial: 500, saldoAtual: 500 },
      ],
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: banca.id,
        casaDeAposta: "Betano",
        data: new Date("2026-08-02T19:00:00Z"),
        evento: "Reparo A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
      },
    });
    await applyAutomaticBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "score" },
      opts(),
    );
    await db.prisma.operationalAction.deleteMany({
      where: { resource: "bet", resourceId: bet.id },
    });

    await expect(applyAutomaticBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "score" },
      opts(),
    )).resolves.toMatchObject({
      status: "WON",
      previousStatus: "WON",
      semContaElegivel: { casaDeAposta: "Betano", bankrollId: banca.id },
    });
    expect(await db.prisma.operationalAction.count({
      where: { resource: "bet", resourceId: bet.id, status: "OPEN" },
    })).toBe(1);
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id } })).toBe(1);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
  });

  it("conta LIMITADA não some: bloqueia com card em vez de virar legado silencioso", async () => {
    const banca = await db.prisma.bankroll.create({
      data: { nome: "Limite", slug: "limite", valorUnidade: 50, vincularContas: true },
    });
    await db.prisma.conta.create({
      data: {
        casaDeAposta: "Betano",
        titular: "Titular",
        status: "LIMITADA",
        saldoInicial: 500,
        saldoAtual: 500,
      },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: banca.id,
        contaId: null,
        casaDeAposta: "Betano",
        data: new Date("2026-08-02T19:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        valorUnidade: 50,
      },
    });

    const result = await applyBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "manual" },
      opts(),
    );

    expect(result.status).toBe("WON");
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
    // O que NÃO pode acontecer é o silêncio: a pendência tem que aparecer.
    expect(result.semContaElegivel).toMatchObject({ casaDeAposta: "Betano" });
    expect(
      await db.prisma.operationalAction.count({
        where: { resource: "bet", resourceId: bet.id, status: "OPEN" },
      }),
    ).toBe(1);
  });

  it("mesmo WON com conta única fecha a ação settle-sem-conta e lança um GANHO", async () => {
    const banca = await db.prisma.bankroll.create({
      data: { nome: "Reparo tarde", slug: "reparo-tarde", valorUnidade: 50, vincularContas: true },
    });
    const extra = await db.prisma.conta.create({
      data: { casaDeAposta: "Betano", titular: "A", saldoInicial: 500, saldoAtual: 500 },
    });
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Betano", titular: "B", saldoInicial: 500, saldoAtual: 500 },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: banca.id,
        contaId: null,
        casaDeAposta: "Betano",
        data: new Date("2026-08-02T19:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        valorUnidade: 50,
      },
    });

    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual" }, opts());
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
    expect(await db.prisma.operationalAction.count({
      where: { resource: "bet", resourceId: bet.id, status: "OPEN" },
    })).toBe(1);

    await db.prisma.conta.delete({ where: { id: extra.id } });
    const retry = await applyBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "manual" },
      opts(),
    );

    expect(retry.semContaElegivel).toBeUndefined();
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).contaId).toBe(conta.id);
    expect(await db.prisma.movimentacao.count({
      where: { betId: bet.id, tipo: "GANHO_APOSTA" },
    })).toBe(1);
    expect(await db.prisma.operationalAction.count({
      where: { resource: "bet", resourceId: bet.id, status: "OPEN" },
    })).toBe(0);
    expect(await db.prisma.operationalAction.count({
      where: { resource: "bet", resourceId: bet.id, status: "RESOLVED" },
    })).toBe(1);
  });

  it("reabrir PENDING não fecha settle-sem-conta; WON com conta única fecha com 1 GANHO", async () => {
    const banca = await db.prisma.bankroll.create({
      data: { nome: "Reparo pendente", slug: "reparo-pendente", valorUnidade: 50, vincularContas: true },
    });
    const extra = await db.prisma.conta.create({
      data: { casaDeAposta: "Betano", titular: "A", saldoInicial: 500, saldoAtual: 500 },
    });
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Betano", titular: "B", saldoInicial: 500, saldoAtual: 500 },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: banca.id,
        contaId: null,
        casaDeAposta: "Betano",
        data: new Date("2026-08-02T19:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        valorUnidade: 50,
      },
    });

    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual" }, opts());
    const aberta = await db.prisma.operationalAction.findFirstOrThrow({
      where: { resource: "bet", resourceId: bet.id, status: "OPEN" },
    });
    expect(aberta.resolutionNote).toBeNull();

    await applyBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual" }, opts());
    const aindaAberta = await db.prisma.operationalAction.findFirstOrThrow({
      where: { id: aberta.id },
    });
    expect(aindaAberta.status).toBe("OPEN");
    expect(aindaAberta.resolutionNote).toBeNull();
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);

    await db.prisma.conta.delete({ where: { id: extra.id } });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual" }, opts());
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).contaId).toBe(conta.id);
    expect(await db.prisma.movimentacao.count({
      where: { betId: bet.id, tipo: "GANHO_APOSTA" },
    })).toBe(1);
    expect(await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: aberta.id } }))
      .toMatchObject({ status: "RESOLVED", resolutionNote: expect.stringMatching(/Ledger criado/) });
  });

  it("vínculo com banca APAGADA não sequestra a conta", async () => {
    const morta = await db.prisma.bankroll.create({
      data: {
        nome: "Prova",
        slug: "prova-apagada",
        valorUnidade: 50,
        vincularContas: true,
      },
    });
    const viva = await db.prisma.bankroll.create({
      data: { nome: "Viva", slug: "viva", valorUnidade: 50, vincularContas: true },
    });
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Betano",
        titular: "Fabricio",
        saldoInicial: 500,
        saldoAtual: 500,
        bankrollLinks: { create: { bankrollId: morta.id } },
      },
    });
    await db.prisma.bankroll.delete({ where: { id: morta.id } });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: viva.id,
        contaId: null,
        casaDeAposta: "Betano",
        data: new Date("2026-08-02T19:00:00Z"),
        evento: "Forward Madison vs Westchester SC",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Forward Madison",
        odds: 2,
        stake: 1,
        valorUnidade: 50,
      },
    });

    const result = await applyBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "manual" },
      opts(),
    );

    // A conta volta a ser global e o ledger segue normalmente.
    expect(result.semContaElegivel).toBeUndefined();
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).contaId)
      .toBe(conta.id);
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual))
      .toBe(550); // 500 + 1u × R$50
  });

  it("resolve conta única criada depois da aposta antes do lançamento financeiro", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Conta tardia", slug: "conta-tardia", valorUnidade: 50, vincularContas: true },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        contaId: null,
        casaDeAposta: "Betano",
        data: new Date("2026-08-03T19:00:00Z"),
        evento: "Santos vs Grêmio",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Santos",
        odds: 1.8,
        stake: 2,
        valorUnidade: 50,
      },
    });
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "betano", titular: "Criada depois", saldoInicial: 500, saldoAtual: 500 },
    });

    await applyBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "manual" },
      opts(),
    );

    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(updated.contaId).toBe(conta.id);
    expect(toNumber(contaDb.saldoAtual)).toBe(580);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(1);
  });

  it("não reutiliza conta morta (soft-deletada ou encerrada) e sinaliza semContaElegivel", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Banca Vinc", slug: "banca-vinc", valorUnidade: 50, vincularContas: true },
    });
    const contaMorta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Betano",
        titular: "Fabricio",
        saldoInicial: 500,
        saldoAtual: 500,
        status: "ENCERRADA",
        deletedAt: new Date(),
      },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        contaId: contaMorta.id,
        casaDeAposta: "Betano",
        data: new Date("2026-08-02T19:00:00Z"),
        evento: "Santos vs Grêmio",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Santos",
        odds: 2.0,
        stake: 1,
        status: "PENDING",
      },
    });

    const res = await applyBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "manual" },
      opts(),
    );

    expect(res.status).toBe("WON");
    expect(res.semContaElegivel).toBeDefined();
    expect(res.semContaElegivel?.casaDeAposta).toBe("Betano");

    // Nenhuma movimentação criada na conta morta
    const movs = await db.prisma.movimentacao.count({ where: { betId: bet.id } });
    expect(movs).toBe(0);

    const contaAtualizada = await db.prisma.conta.findUniqueOrThrow({ where: { id: contaMorta.id } });
    expect(toNumber(contaAtualizada.saldoAtual)).toBe(500);
  });
});

it.each(["VOID", "CANCELED", "CASHOUT"] as const)("correção sem efeito financeiro para %s encerra a pendência de conta", async (newStatus) => {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Sem conta", slug: "sem-conta-zero", vincularContas: true } });
  for (const titular of ["A", "B"]) await db.prisma.conta.create({ data: { casaDeAposta: "Betano", titular, saldoInicial: 0, saldoAtual: 0 } });
  const bet = await db.prisma.bet.create({ data: { bankrollId: bankroll.id, casaDeAposta: "Betano", data: new Date("2026-08-02T19:00:00Z"), evento: "A vs B", esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), mercado: "Moneyline", selecao: "A", odds: 2, stake: 1 } });
  await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual:teste" }, opts());
  const action = await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: bet.id, status: "OPEN" } });
  const result = await applyBetStatusChange({ betId: bet.id, newStatus, cashoutLucro: newStatus === "CASHOUT" ? 0 : undefined, source: "manual:teste" }, opts());
  expect(result.semContaElegivel).toBeUndefined();
  expect(await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({ status: "RESOLVED" });
  expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
});

it("mantém a conta global já associada, mesmo com uma nova conta específica do tipster", async () => {
  const bank = await db.prisma.bankroll.create({ data: { nome: "Global", slug: "global", valorUnidade: 50, vincularContas: true } });
  const original = await db.prisma.conta.create({ data: { casaDeAposta: "Betano", titular: "Original", saldoInicial: 0, saldoAtual: 0 } });
  const bet = await db.prisma.bet.create({ data: { bankrollId: bank.id, contaId: original.id, casaDeAposta: "Betano", valorUnidade: 50, data: new Date("2026-08-02T19:00:00Z"), evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A", odds: 2, stake: 1, sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date() } });
  const newer = await db.prisma.conta.create({ data: { casaDeAposta: "Betano", titular: "Nova", saldoInicial: 0, saldoAtual: 0, bankrollLinks: { create: { bankrollId: bank.id } } } });
  await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual" }, opts());
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).contaId).toBe(original.id);
  expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: original.id } })).saldoAtual)).toBe(50);
  expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: newer.id } })).saldoAtual)).toBe(0);
  await applyBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual" }, opts());
  await applyBetStatusChange({ betId: bet.id, newStatus: "LOST", source: "manual" }, opts());
  await applyBetStatusChange({ betId: bet.id, newStatus: "LOST", source: "manual" }, opts());
  expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: original.id } })).saldoAtual)).toBe(-50);
  expect(await db.prisma.movimentacao.count({ where: { betId: bet.id, contaId: newer.id } })).toBe(0);
});
