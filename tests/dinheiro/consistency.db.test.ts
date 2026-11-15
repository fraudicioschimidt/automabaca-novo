import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  checkBetLedgerConsistency,
  checkBetLucroConsistency,
  formatUnitForConsistencyAlert,
} from "@/src/services/ops/consistency/bet-ledger";
import { checkContasDrift } from "@/src/services/contas/drift";
import { applyManualBetStatusChange as applyBetStatusChange } from "../helpers/settle";
import { prisma } from "@/src/infra/prisma";
import type { Prisma } from "@/src/generated/prisma/client";
import { softDeleteBet, restoreRemovedBet } from "@/src/services/bets/remove";

/**
 * Consistency-check diário contra Postgres real: recompute de
 * lucro por aposta + drift de saldo (alerta, nunca corrige).
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

let seq = 0;

async function seedBet(params: { status: string; odds: number; stake: number; lucro: number }) {
  seq += 1;
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: `Banca C${seq}`, slug: `banca-c${seq}`, valorUnidade: 100 },
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: params.status === "PENDING" ? null : new Date("2026-08-01T16:00:00Z"),
      bankrollId: bankroll.id,
      data: new Date("2026-08-01T16:00:00Z"),
      evento: "Time A vs Time B",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Time A",
      odds: params.odds,
      stake: params.stake,
      status: params.status as never,
      lucro: params.lucro,
    },
  });
}

describe("checkBetLucroConsistency (Postgres real)", () => {
  it("formata divergências com a precisão persistida sem zeros supérfluos", () => {
    expect(formatUnitForConsistencyAlert(0.000001)).toBe("0.000001u");
    expect(formatUnitForConsistencyAlert(-1)).toBe("-1u");
  });

  it("pagina o histórico completo sem perder registros além do primeiro lote", async () => {
    seq += 1;
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: `Escala ${seq}`, slug: `escala-${seq}`, valorUnidade: 100 },
    });
    await db.prisma.bet.createMany({
      data: Array.from({ length: 1_001 }, (_, index) => ({
        sportResolutionStatus: "CONFIRMED" as const,
        sportResolvedAt: new Date(),
        settledAt: new Date("2026-08-01T16:00:00Z"),
        bankrollId: bankroll.id,
        data: new Date("2026-08-01T16:00:00Z"),
        evento: `Escala A vs B ${index}`,
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        status: "WON" as const,
        lucro: 1,
      })),
    });

    await expect(checkBetLucroConsistency()).resolves.toMatchObject({
      verificadas: 1_001,
      divergentes: [],
    });
    await expect(checkBetLedgerConsistency()).resolves.toMatchObject({
      verificadas: 1_001,
      divergentes: [],
    });
  });

  it("aposta com lucro coerente NÃO diverge", async () => {
    // WON @2.0 stake 1 → lucro 1.0 (correto).
    await seedBet({ status: "WON", odds: 2.0, stake: 1, lucro: 1 });
    const r = await checkBetLucroConsistency();
    expect(r.verificadas).toBe(1);
    expect(r.divergentes).toHaveLength(0);
  });

  it("lucro gravado errado é detectado, alertado 1×/dia e NUNCA corrigido", async () => {
    // WON @2.0 stake 1 com lucro gravado 0.50 — divergência de 0.50u.
    const bet = await seedBet({ status: "WON", odds: 2.0, stake: 1, lucro: 0.5 });

    const hoje = new Date("2026-08-03T02:30:00Z");
    const r1 = await checkBetLucroConsistency(hoje);
    expect(r1.divergentes).toHaveLength(1);
    expect(r1.divergentes[0]).toMatchObject({
      betId: bet.id,
      lucroGravado: 0.5,
      lucroEsperado: 1,
    });

    // NÃO corrige: o lucro gravado permanece intacto.
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(Number(after.lucro)).toBe(0.5);

    // Dedupe diário durável: segunda rodada no MESMO dia não cria outro evento.
    const acao = await db.prisma.operationalAction.findFirstOrThrow({
      where: { fingerprint: { startsWith: "consistency.bet-lucro:" } },
    });
    await db.prisma.operationalAction.update({
      where: { id: acao.id },
      data: { status: "RESOLVED", resolvedAt: hoje },
    });
    await checkBetLucroConsistency(hoje);
    const eventos = await db.prisma.auditEvent.count({
      where: { action: "bet_lucro_drift", resource: bet.id },
    });
    expect(eventos).toBe(1);
    expect(await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "bet_lucro_drift", resource: bet.id },
      select: { resourceId: true },
    })).toMatchObject({ resourceId: "2026-08-02" });
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: acao.id } }))
      .resolves.toMatchObject({ status: "OPEN", occurrenceCount: 1 });
  });

  it("aceita lucro manual possível no CASHOUT e lucro zero no PENDING", async () => {
    await seedBet({ status: "CASHOUT", odds: 2.0, stake: 1, lucro: -0.37 });
    await seedBet({ status: "PENDING", odds: 2.0, stake: 1, lucro: 0 });
    const r = await checkBetLucroConsistency();
    expect(r.verificadas).toBe(1);
  });

  it("o banco recusa lucro em aposta pendente antes da conciliação", async () => {
    await expect(seedBet({ status: "PENDING", odds: 2, stake: 1, lucro: 0.25 })).rejects.toThrow(/bets_pending_financial_state/);
    expect((await checkBetLucroConsistency()).divergentes).toEqual([]);
  });

  it.each([-1.000001, 1.000001])("detecta cashout fora dos limites da aposta: %s", async (lucro) => {
    const bet = await seedBet({ status: "CASHOUT", odds: 2, stake: 1, lucro });
    expect((await checkBetLucroConsistency()).divergentes).toEqual([
      expect.objectContaining({ betId: bet.id, lucroEsperado: lucro < 0 ? -1 : 1 }),
    ]);
  });

  it("checagens concorrentes de lucro registram uma ocorrência diária", async () => {
    const bet = await seedBet({ status: "WON", odds: 2, stake: 1, lucro: 0.5 });
    const now = new Date("2026-08-03T02:30:00Z");
    await Promise.all(Array.from({ length: 4 }, () => checkBetLucroConsistency(now)));
    expect(await db.prisma.auditEvent.count({ where: { action: "bet_lucro_drift", resource: bet.id } })).toBe(1);
    expect(await db.prisma.operationalAction.findFirstOrThrow({
      where: { fingerprint: { startsWith: "consistency.bet-lucro:" } },
    })).toMatchObject({ occurrenceCount: 1 });
  });

  it("HALF_WON divergente também é pego (meio-ganho asiático)", async () => {
    // HALF_WON @1.8 stake 2 → esperado +0.8; gravado -1 (sinal trocado).
    await seedBet({ status: "HALF_WON", odds: 1.8, stake: 2, lucro: -1 });
    const r = await checkBetLucroConsistency();
    expect(r.divergentes).toHaveLength(1);
    expect(r.divergentes[0]!.lucroEsperado).toBeCloseTo(0.8, 6);
  });

  it("detecta divergência de uma unidade na sexta casa decimal", async () => {
    await seedBet({ status: "WON", odds: 2, stake: 1, lucro: 0.999999 });
    const r = await checkBetLucroConsistency();
    expect(r.divergentes).toHaveLength(1);
  });
});

describe("checkContasDrift (Postgres real)", () => {
  it("conta com saldo ≠ Σ movimentações acima de R$1 alerta com dedupe diário", async () => {
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Bet365",
        titular: "Fabricio",
        saldoInicial: 0,
        saldoAtual: 150, // ledger vazio → drift de R$150
      },
    });

    const hoje = new Date("2026-08-03T02:30:00Z");
    const r = await checkContasDrift(hoje);
    expect(r.drifts).toBe(1);

    const acao = await db.prisma.operationalAction.findFirstOrThrow({
      where: { fingerprint: { startsWith: "consistency.conta-saldo:" } },
    });
    await db.prisma.operationalAction.update({
      where: { id: acao.id },
      data: { status: "RESOLVED", resolvedAt: hoje },
    });
    await checkContasDrift(hoje);
    const eventos = await db.prisma.auditEvent.count({
      where: { action: "conta_drift", resource: conta.id },
    });
    expect(eventos).toBe(1);
    expect(await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "conta_drift", resource: conta.id },
      select: { resourceId: true },
    })).toMatchObject({ resourceId: "2026-08-02" });
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: acao.id } }))
      .resolves.toMatchObject({ status: "OPEN", occurrenceCount: 1 });
  });

  it("duas checagens concorrentes gravam um único alerta diário", async () => {
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Pinnacle", titular: "Concorrente", saldoInicial: 0, saldoAtual: 50 },
    });
    const hoje = new Date("2026-08-03T02:30:00Z");
    await Promise.all([checkContasDrift(hoje), checkContasDrift(hoje)]);
    expect(await db.prisma.auditEvent.count({
      where: { action: "conta_drift", resource: conta.id },
    })).toBe(1);
  });

  it("continua conferindo conta removida com extrato divergente", async () => {
    const conta = await db.prisma.conta.create({ data: {
      casaDeAposta: "Casa", titular: "Sintético", saldoAtual: 0, deletedAt: new Date(), status: "ENCERRADA",
    } });
    await db.prisma.movimentacao.create({ data: { contaId: conta.id, tipo: "DEPOSITO", valor: 0.01, saldoApos: 0.01 } });
    expect((await checkContasDrift()).drifts).toBe(1);
    await db.prisma.movimentacao.deleteMany({ where: { contaId: conta.id } });
    expect((await checkContasDrift()).drifts).toBe(0);
    expect(await db.prisma.operationalAction.findFirstOrThrow({
      where: { fingerprint: { startsWith: "consistency.conta-saldo:" } },
    })).toMatchObject({ status: "RESOLVED" });
  });

  it("qualquer centavo de drift alerta", async () => {
    await db.prisma.conta.create({
      data: { casaDeAposta: "Betano", titular: "F", saldoInicial: 0, saldoAtual: 0.01 },
    });
    const r = await checkContasDrift();
    expect(r.drifts).toBe(1);
  });
});

describe("checkBetLedgerConsistency (Postgres real)", () => {
  async function seedLinkedPending() {
    seq += 1;
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: `Ledger ${seq}`, slug: `ledger-${seq}`, valorUnidade: 100 },
    });
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Bet365", titular: "F", saldoInicial: 0, saldoAtual: 0 },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        contaId: conta.id,
        data: new Date("2026-08-01T16:00:00Z"),
        evento: "Ledger A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
      },
    });
    return { bankroll, conta, bet };
  }

  it("aceita settlement canônico com líquido na conta correta", async () => {
    const { bet } = await seedLinkedPending();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    const result = await checkBetLedgerConsistency();
    expect(result.verificadas).toBe(1);
    expect(result.divergentes).toEqual([]);
  });

  it("inclui removidas para provar que o estorno zerou o histórico", async () => {
    const { bet } = await seedLinkedPending();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "reacao" });

    await expect(checkBetLedgerConsistency()).resolves.toMatchObject({
      verificadas: 1,
      divergentes: [],
    });

    // Se o estorno sumir, a varredura da removida precisa alertar; filtrá-la
    // ocultaria exatamente a corrupção financeira que este gate protege.
    await db.prisma.movimentacao.deleteMany({
      where: { betId: bet.id, tipo: "ESTORNO" },
    });
    await expect(checkBetLedgerConsistency()).resolves.toMatchObject({
      verificadas: 1,
      divergentes: [expect.objectContaining({ betId: bet.id, valorEsperado: 0 })],
    });
  });

  it("concilia correções, reenvios, remoção e restauração com stake fracionária", async () => {
    const { bet, conta } = await seedLinkedPending();
    await db.prisma.bet.update({ where: { id: bet.id }, data: {
      stake: 0.333333, valorUnidade: 100, mercado: "Asian Handicap", selecao: "A -0.25",
    } });
    const outcomes = [
      ["WON", 33.33], ["LOST", -33.33], ["HALF_WON", 16.67], ["HALF_LOST", -16.67],
      ["VOID", 0], ["CANCELED", 0], ["PENDING", 0], ["CASHOUT", -10],
    ] as const;
    for (const [newStatus, balance] of outcomes) {
      const input = { betId: bet.id, newStatus, source: "test", ...(newStatus === "CASHOUT" ? { cashoutLucro: -0.1 } : {}) };
      await applyBetStatusChange(input);
      const count = await db.prisma.movimentacao.count({ where: { betId: bet.id } });
      await applyBetStatusChange(input);
      expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(count);
      expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(balance);
      expect((await checkContasDrift()).drifts).toBe(0);
      expect((await checkBetLucroConsistency()).divergentes).toEqual([]);
      expect((await checkBetLedgerConsistency()).divergentes).toEqual([]);
    }
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "Simulação", origin: "painel" });
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(0);
    expect((await checkBetLedgerConsistency()).divergentes).toEqual([]);
    await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "Simulação", by: "painel" });
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(-10);
    expect((await checkContasDrift()).drifts).toBe(0);
    expect((await checkBetLedgerConsistency()).divergentes).toEqual([]);
  });

  it("detecta lançamento ausente mesmo com lucro da aposta correto", async () => {
    const { bet } = await seedLinkedPending();
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { status: "WON", lucro: 1, settledAt: new Date() },
    });
    const result = await checkBetLedgerConsistency(new Date("2026-08-03T02:30:00Z"));
    expect(result.divergentes).toEqual([
      expect.objectContaining({
        betId: bet.id,
        valorEsperado: 100,
        valorGravado: 0,
      }),
    ]);
    const acao = await db.prisma.operationalAction.findFirstOrThrow({
      where: { fingerprint: { startsWith: "consistency.bet-ledger:" } },
    });
    await db.prisma.operationalAction.update({
      where: { id: acao.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    await checkBetLedgerConsistency(new Date("2026-08-03T02:30:00Z"));
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: acao.id } }))
      .resolves.toMatchObject({ status: "OPEN", occurrenceCount: 1 });
  });

  it("checagens concorrentes de ledger registram uma ocorrência diária", async () => {
    const { bet } = await seedLinkedPending();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { status: "WON", lucro: 1, settledAt: new Date() } });
    const now = new Date("2026-08-03T02:30:00Z");
    await Promise.all(Array.from({ length: 4 }, () => checkBetLedgerConsistency(now)));
    expect(await db.prisma.auditEvent.count({ where: { action: "bet_ledger_drift", resource: `${bet.id}:${bet.contaId}` } })).toBe(1);
    expect(await db.prisma.operationalAction.findFirstOrThrow({
      where: { fingerprint: { startsWith: "consistency.bet-ledger:" } },
    })).toMatchObject({ occurrenceCount: 1 });
  });

  it("detecta valor lançado na conta errada mesmo quando cada saldo fecha com seu ledger", async () => {
    const { bet } = await seedLinkedPending();
    const errada = await db.prisma.conta.create({
      data: { casaDeAposta: "Outra", titular: "F", saldoInicial: 0, saldoAtual: 100 },
    });
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { status: "WON", lucro: 1, settledAt: new Date() },
    });
    await db.prisma.movimentacao.create({
      data: {
        contaId: errada.id,
        betId: bet.id,
        tipo: "GANHO_APOSTA",
        valor: 100,
        saldoApos: 100,
      },
    });

    expect((await checkContasDrift()).drifts).toBe(0);
    const result = await checkBetLedgerConsistency();
    expect(result.divergentes).toEqual(expect.arrayContaining([
      expect.objectContaining({ contaMovimentoId: errada.id, valorEsperado: 0, valorGravado: 100 }),
      expect.objectContaining({ contaMovimentoId: bet.contaId, valorEsperado: 100, valorGravado: 0 }),
    ]));
  });
});

describe("publicação atômica dos alertas financeiros", () => {
  it.each(["lucro", "ledger", "saldo"] as const)("falha ao abrir ação de %s não consome a reserva diária", async (kind) => {
    const bet = await seedBet({ status: "WON", odds: 2, stake: 1, lucro: 0.5 });
    const conta = await db.prisma.conta.create({ data: { casaDeAposta: "Casa", titular: "Sintético", saldoAtual: 10 } });
    await db.prisma.bet.update({ where: { id: bet.id }, data: { contaId: conta.id } });
    const check = kind === "lucro" ? checkBetLucroConsistency : kind === "ledger" ? checkBetLedgerConsistency : checkContasDrift;
    const action = kind === "saldo" ? "conta_drift" : `bet_${kind}_drift`;
    const realTx = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => realTx(async (tx) => {
      const failure = vi.spyOn(tx.operationalAction, "create").mockRejectedValueOnce(new Error("Caixa indisponível"));
      try { return await fn(tx); } finally { failure.mockRestore(); }
    }, options)) as typeof prisma.$transaction);
    try { await expect(check()).rejects.toThrow("Caixa indisponível"); } finally { spy.mockRestore(); }
    expect(await db.prisma.auditEvent.count({ where: { action } })).toBe(0);
    expect(await db.prisma.operationalAction.count()).toBe(0);
    await check();
    expect(await db.prisma.auditEvent.count({ where: { action } })).toBe(1);
    expect(await db.prisma.operationalAction.findFirstOrThrow()).toMatchObject({ occurrenceCount: 1 });
  });
});
