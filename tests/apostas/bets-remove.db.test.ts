import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as bossModule from "@/src/infra/boss";
import { findBetsParaReviver } from "@/src/services/sharp/revive";
import { createTestDb, settleRaceAgainst, type TestDb } from "../helpers/db";
import {
  describeRemovals,
  planBatchRemoval,
  removeBetsInBatch,
  restoreBetsInBatch,
  restoreRemovedBet,
  softDeleteBet,
} from "@/src/services/bets/remove";
import { applyManualBetStatusChangeTx } from "@/src/services/bets/settle";
import { reuseSerializableTransaction, runSerializableTransaction } from "@/src/services/shared/transaction";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import { applyManualBetStatusChange as applyBetStatusChange } from "../helpers/settle";
import { listFlashscoreEligibleBets } from "@/src/services/settlement/flashscore/observation-store";
import { purgeOldAuditEvents } from "@/src/services/ops/audit-purge";
import { toNumber } from "@/src/domain/money";
import { operationalActionFingerprint } from "@/src/services/ops/operational-actions";
import { alterarStatusConta, criarConta, removerConta } from "@/src/services/contas/manage";

/**
 * softDeleteBet (👎/"não peguei") é a reversão de ledger MAIS usada no dia a dia.
 * Testa contra Postgres real o efeito no saldo, a idempotência, o estado
 * final e o guard fail-loud de não-liquidar aposta removida.
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

async function seed(params?: { saldoInicial?: number }) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Remove", slug: "remove", valorUnidade: 100, sharpMode: "OFF" },
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
      settledAt: null,
      bankrollId: bankroll.id,
      contaId: conta.id,
      data: new Date("2026-08-01T16:00:00Z"),
      evento: "Flamengo vs Palmeiras",
      esporte: "Soccer",
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      mercado: "Moneyline",
      selecao: "Flamengo",
      odds: 2.0,
      stake: 1,
      status: "PENDING",
      source: "test",
      sourceExternalId: "rm-1",
    },
  });
  return { bankroll, conta, bet };
}

async function saldoDe(contaId: string): Promise<number> {
  const conta = await db.prisma.conta.findUniqueOrThrow({
    where: { id: contaId },
    select: { saldoAtual: true },
  });
  return toNumber(conta.saldoAtual);
}

describe("softDeleteBet (Postgres real)", () => {
  it("restauração sem esporte mantém intenção durável quando a fila falha", async () => {
    const { bankroll, bet } = await seed();
    await db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { sharpMode: "CLV_ONLY" } });
    await db.prisma.bet.update({ where: { id: bet.id }, data: {
      data: new Date(Date.now() + 3_600_000), esporte: "Unknown", sportResolutionStatus: "PENDING", sportResolvedAt: null,
    } });
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "removida", origin: "painel" }, { deferEffects: true });
    const spy = vi.spyOn(bossModule, "getSharedBoss").mockRejectedValueOnce(new Error("pg-boss indisponível"));
    try {
      expect(await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "restaurada", by: "painel" })).toMatchObject({ changed: true, restoredStatus: "PENDING" });
      expect(await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "restaurada", by: "painel" })).toMatchObject({ changed: false });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "capture.followup", outcome: "pending" } })).toMatchObject({ resourceId: bet.id, details: expect.objectContaining({ origem: "not-taken-undone", restorationId: expect.any(String) }) });
      expect(await findBetsParaReviver(new Date())).not.toContain(bet.id);
      expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ deletedAt: null, notTakenAt: null, status: "PENDING", sportResolutionStatus: "PENDING" });
    } finally { spy.mockRestore(); }
  });

  it("reverte o ganho no ledger e marca deletedAt/CANCELED/lucro 0", async () => {
    const { conta, bet } = await seed();
    // Liquida WON: saldo 1000 → 1100.
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    expect(await saldoDe(conta.id)).toBe(1100);

    const res = await softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "painel" });
    expect(res.alreadyDeleted).toBe(false);

    // Saldo volta ao inicial (ganho estornado).
    expect(await saldoDe(conta.id)).toBe(1000);

    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after.deletedAt).toBeInstanceOf(Date);
    expect(after.status).toBe("CANCELED");
    expect(toNumber(after.lucro)).toBe(0);

    // Ledger fecha (GANHO_APOSTA + ESTORNO, líquido zero).
    const movs = await db.prisma.movimentacao.findMany({ where: { contaId: conta.id } });
    expect(movs.map((m) => m.tipo).sort()).toEqual(["ESTORNO", "GANHO_APOSTA"]);
    const soma = movs.reduce((s, m) => s + toNumber(m.valor), 0);
    expect(Math.round(soma * 100) / 100).toBe(0);
  });

  it("trava a aposta antes de estornar a conta, como a liquidação: as duas não fecham ciclo", async () => {
    const { conta, bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });

    await settleRaceAgainst({ betId: bet.id, contaId: conta.id },
      () => softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "painel" }));

    expect(await saldoDe(conta.id)).toBe(1000);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).deletedAt).toBeInstanceOf(Date);
  });

  it("é idempotente: 2ª chamada é no-op (alreadyDeleted) sem novo estorno", async () => {
    const { conta, bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "painel" });
    const movCount1 = await db.prisma.movimentacao.count({ where: { betId: bet.id } });

    const res2 = await softDeleteBet({ betId: bet.id, actor: "test", motivo: "de novo", origin: "painel" });
    expect(res2.alreadyDeleted).toBe(true);
    expect(await saldoDe(conta.id)).toBe(1000);
    // Nenhuma movimentação nova foi criada.
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(movCount1);
  });

  it("duas remoções concorrentes produzem um único tombstone e um único estorno", async () => {
    const { conta, bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });

    const results = await Promise.all([
      softDeleteBet(
        { betId: bet.id, actor: "a", motivo: "não peguei", origin: "reacao" },
        { client: db.prisma },
      ),
      softDeleteBet(
        { betId: bet.id, actor: "b", motivo: "não peguei", origin: "painel" },
        { client: db.prisma },
      ),
    ]);

    expect(results.filter((result) => !result.alreadyDeleted)).toHaveLength(1);
    expect(results.filter((result) => result.alreadyDeleted)).toHaveLength(1);
    expect(await saldoDe(conta.id)).toBe(1000);
    expect(await db.prisma.movimentacao.count({
      where: { betId: bet.id, tipo: "ESTORNO" },
    })).toBe(1);
    expect(await db.prisma.auditEvent.count({
      where: { resourceId: bet.id, action: "bet.soft_delete" },
    })).toBe(1);
  });

  it("rejeita sugestão pendente do IA-Judge na mesma transação", async () => {
    const { bet } = await seed();
    const suggestion = await db.prisma.iaJudgeSuggestion.create({
      data: {
        betId: bet.id,
        suggestedStatus: "WON",
        evidenceKind: "GROUNDED_WEB",
        valueFound: "2 x 0",
        confidence: 0.9,
        reason: "placar confirmado",
      },
    });

    await softDeleteBet({ betId: bet.id, actor: "fabricio", motivo: "exclusão manual", origin: "painel" });

    expect(await db.prisma.iaJudgeSuggestion.findUniqueOrThrow({
      where: { id: suggestion.id },
      select: { status: true, resolvedAt: true, resolvedBy: true },
    })).toMatchObject({
      status: "REJECTED",
      resolvedAt: expect.any(Date),
      resolvedBy: "fabricio",
    });
  });

  it("encerra imediatamente as ações da aposta excluída e preserva as demais", async () => {
    const { bet } = await seed();
    const acaoDaAposta = await db.prisma.operationalAction.create({
      data: {
        fingerprint: operationalActionFingerprint("settlement.parado", bet.id),
        area: "settlement",
        actionType: "bet.settle",
        title: `Liquidar: ${bet.evento}`,
        description: "Aposta pendente exige decisão.",
        resource: "bet",
        resourceId: bet.id,
        evidence: { autoResolve: false },
      },
    });
    const infraestrutura = await db.prisma.operationalAction.create({
      data: {
        fingerprint: operationalActionFingerprint("infra", "legacy-maintenance"),
        area: "incidentes",
        actionType: "incident.review",
        title: "Manutenção pendente",
        description: "Incidente real sem relação com a aposta.",
        resource: "infrastructure",
        resourceId: "legacy-maintenance",
      },
    });

    await softDeleteBet({ betId: bet.id, actor: "fabricio", motivo: "exclusão manual", origin: "painel" });

    await expect(db.prisma.operationalAction.findUniqueOrThrow({
      where: { id: acaoDaAposta.id },
    })).resolves.toMatchObject({
      status: "RESOLVED",
      resolvedAt: expect.any(Date),
      resolutionNote: expect.stringContaining("Aposta excluída"),
    });
    await expect(db.prisma.operationalAction.findUniqueOrThrow({
      where: { id: infraestrutura.id },
    })).resolves.toMatchObject({ status: "OPEN", resolvedAt: null });
    await expect(db.prisma.auditEvent.findFirst({
      where: {
        action: "operational_action.auto_resolved",
        resourceId: acaoDaAposta.id,
      },
    })).resolves.toMatchObject({ actor: "fabricio" });
  });

  it("remover o 👎 restaura aposta, resultado e ledger anteriores", async () => {
    const { conta, bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    await softDeleteBet({
      betId: bet.id,
      actor: "test",
      motivo: "não peguei",
      origin: "reacao",
    });
    expect(await saldoDe(conta.id)).toBe(1000);

    await restoreRemovedBet({
      betId: bet.id,
      actor: "test",
      motivo: "reação removida",
      by: "reacao",
    }, { client: db.prisma });

    const restored = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(restored.deletedAt).toBeNull();
    expect(restored.notTakenAt).toBeNull();
    expect(restored.status).toBe("WON");
    expect(toNumber(restored.lucro)).toBe(1);
    expect(await saldoDe(conta.id)).toBe(1100);
  });

  it("sem snapshot financeiro do soft-delete bloqueia a reversão e abre revisão", async () => {
    const { conta, bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    await softDeleteBet({
      betId: bet.id,
      actor: "test",
      motivo: "não peguei",
      origin: "reacao",
    });
    await db.prisma.auditEvent.deleteMany({
      where: { resourceId: bet.id, action: "bet.soft_delete" },
    });

    const result = await restoreRemovedBet({
      betId: bet.id,
      actor: "test",
      motivo: "reação removida",
      by: "reacao",
    }, { client: db.prisma });

    expect(result).toMatchObject({ changed: false, blocked: "missing_soft_delete_snapshot" });
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "CANCELED", notTakenAt: expect.any(Date) });
    expect(await saldoDe(conta.id)).toBe(1000);
    await expect(db.prisma.operationalAction.findUnique({
      where: {
        fingerprint: operationalActionFingerprint("bet.not-taken-restore", bet.id),
      },
    })).resolves.toMatchObject({ status: "OPEN", actionType: "bet.restore.review" });
  });

  it("snapshot finito porém incompatível com status/odd/stake não volta ao ledger", async () => {
    const { conta, bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    await softDeleteBet({
      betId: bet.id,
      actor: "test",
      motivo: "não peguei",
      origin: "reacao",
    });
    const deletion = await db.prisma.auditEvent.findFirstOrThrow({
      where: { resourceId: bet.id, action: "bet.soft_delete" },
      orderBy: { createdAt: "desc" },
    });
    await db.prisma.auditEvent.update({
      where: { id: deletion.id },
      data: {
        details: {
          previousStatus: "WON",
          previousLucro: -999,
          previousSettledAt: new Date().toISOString(),
        },
      },
    });

    await expect(restoreRemovedBet({
      betId: bet.id,
      actor: "test",
      motivo: "reação removida",
      by: "reacao",
    }, { client: db.prisma })).resolves.toMatchObject({
      changed: false,
      blocked: "missing_soft_delete_snapshot",
    });
    expect(await saldoDe(conta.id)).toBe(1000);
  });

  it("duas reversões concorrentes restauram o ledger exatamente uma vez", async () => {
    const { conta, bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    await softDeleteBet({
      betId: bet.id,
      actor: "test",
      motivo: "não peguei",
      origin: "reacao",
    }, { client: db.prisma });

    const results = await Promise.all([
      restoreRemovedBet(
        { betId: bet.id, actor: "a", motivo: "reação removida", by: "reacao" },
        { client: db.prisma },
      ),
      restoreRemovedBet(
        { betId: bet.id, actor: "b", motivo: "reação removida", by: "reacao" },
        { client: db.prisma },
      ),
    ]);

    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(await saldoDe(conta.id)).toBe(1100);
    // Um ganho é a liquidação original; o segundo é a única restauração.
    expect(await db.prisma.movimentacao.count({
      where: { betId: bet.id, tipo: "GANHO_APOSTA" },
    })).toBe(2);
    expect(await db.prisma.auditEvent.count({
      where: { resourceId: bet.id, action: "bet.not_taken_undone" },
    })).toBe(1);
  });

  it("liquidar uma aposta já removida é bloqueado (guard fail-loud)", async () => {
    const { conta, bet } = await seed();
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "painel" });
    await expect(
      applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" }),
    ).rejects.toThrow(/removida/);
    // O saldo não foi tocado pela tentativa bloqueada.
    expect(await saldoDe(conta.id)).toBe(1000);
  });

  it("PENDING sem conta vinculada: remove sem erro e sem lançamento", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "SemConta", slug: "sem-conta", valorUnidade: 100, sharpMode: "OFF" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date("2026-08-01T16:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        mercado: "Moneyline",
        selecao: "A",
        odds: 2.0,
        stake: 1,
        status: "PENDING",
        source: "test",
        sourceExternalId: "rm-2",
      },
    });
    const res = await softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "painel" });
    expect(res.alreadyDeleted).toBe(false);
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after.deletedAt).toBeInstanceOf(Date);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
  });

  it("fecha training case OPEN na mesma tx do soft-delete", async () => {
    const { bet } = await seed();
    await db.prisma.trainingCase.create({
      data: {
        betId: bet.id,
        evento: bet.evento,
        esporte: bet.esporte,
        status: "OPEN",
        candidatesJson: [],
        autoScore: 0,
      },
    });
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "painel" });
    const tcase = await db.prisma.trainingCase.findFirstOrThrow({ where: { betId: bet.id } });
    expect(tcase.status).toBe("EXPIRED");
    expect(tcase.resolvedAt).toBeInstanceOf(Date);
  });
});

/**
 * A conta pode ser removida depois da aposta: a aposta removida já teve o
 * efeito estornado e não segura a conta. Restaurar segue a regra da
 * liquidação para escolher a conta, em vez de lançar numa conta que não
 * existe mais.
 */
describe("restaurar aposta cuja conta saiu (Postgres real)", () => {
  async function seedWithConta({ vincularContas = true } = {}) {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Conta sai", slug: "conta-sai", valorUnidade: 100, sharpMode: "OFF", vincularContas },
    });
    const { contaId } = await criarConta({
      casaDeAposta: "Bet365", titular: "Fabricio", saldoInicial: 0, bankrollIds: [bankroll.id], actor: "test",
    });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        contaId,
        casaDeAposta: "Bet365",
        data: new Date("2026-08-01T16:00:00Z"),
        evento: "Grêmio vs Inter",
        esporte: "Soccer",
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        mercado: "Moneyline",
        selecao: "Grêmio",
        odds: 2.0,
        stake: 1,
        valorUnidade: 100,
        status: "PENDING",
        source: "test",
        sourceExternalId: "rm-conta-sai",
      },
    });
    return { bankroll, contaId, bet };
  }

  it("ganha removida e conta removida: restaura pelo painel sem ledger e com a pendência visível", async () => {
    const { bankroll, contaId, bet } = await seedWithConta();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "painel" });
    await removerConta({ contaId, actor: "test" });

    const res = await restoreBetsInBatch({ bankrollId: bankroll.id, betIds: [bet.id], actor: "fabricio" });

    expect(res.restored).toEqual([bet.id]);
    const restored = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(restored).toMatchObject({ status: "WON", deletedAt: null, notTakenAt: null, contaId: null });
    expect(toNumber(restored.lucro)).toBe(1);
    expect(await saldoDe(contaId)).toBe(0);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(2);
    const action = await db.prisma.operationalAction.findFirstOrThrow({
      where: { fingerprint: operationalActionFingerprint("bets.settle-sem-conta", bet.id), status: "OPEN" },
    });
    expect(action.description).toContain("foi removida");
    expect(action.description).not.toContain("reabra");
  });

  it("ganha removida e conta removida numa banca que não liga contas: volta sem ledger e sem a ação", async () => {
    const { bankroll, contaId, bet } = await seedWithConta({ vincularContas: false });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "painel" });
    await removerConta({ contaId, actor: "test" });

    const res = await restoreBetsInBatch({ bankrollId: bankroll.id, betIds: [bet.id], actor: "fabricio" });

    expect(res.restored).toEqual([bet.id]);
    const restored = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(restored).toMatchObject({ status: "WON", deletedAt: null, contaId: null });
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(2);
    expect(await db.prisma.operationalAction.count({
      where: { fingerprint: operationalActionFingerprint("bets.settle-sem-conta", bet.id) },
    })).toBe(0);
  });

  it("pendente removida e conta removida: volta sem apontar para a conta removida", async () => {
    const { contaId, bet } = await seedWithConta();
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "reacao" });
    await removerConta({ contaId, actor: "test" });

    await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "reação removida", by: "reacao" });

    const restored = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(restored).toMatchObject({ status: "PENDING", deletedAt: null, contaId: null });
  });

  it("ganha removida com a conta encerrada: o ganho entra na outra conta ativa da casa", async () => {
    const { bankroll, contaId, bet } = await seedWithConta();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "reacao" });
    await alterarStatusConta({ contaId, status: "ENCERRADA", expectedStatus: "ATIVA", actor: "test" });
    const { contaId: activeContaId } = await criarConta({
      casaDeAposta: "Bet365", titular: "Outro titular", saldoInicial: 0, bankrollIds: [bankroll.id], actor: "test",
    });

    await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "reação removida", by: "reacao" });

    const restored = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(restored).toMatchObject({ status: "WON", contaId: activeContaId });
    expect(await saldoDe(activeContaId)).toBe(100);
    expect(await saldoDe(contaId)).toBe(0);
  });
});

describe("remoção em lote pelo painel (Postgres real)", () => {
  const SOURCE = "telegram-channel:-100900";

  async function seedLote() {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Lote", slug: "lote", valorUnidade: 100 } });
    const outra = await db.prisma.bankroll.create({ data: { nome: "Outra", slug: "outra", valorUnidade: 100 } });
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Bet365", titular: "Fabricio", saldoInicial: 1000, saldoAtual: 1000 },
    });
    let n = 0;
    const bet = (over: { bankrollId?: string; source?: string; sourceExternalId?: string | null; evento?: string }) => db.prisma.bet.create({
      data: {
        bankrollId: over.bankrollId ?? bankroll.id,
        contaId: conta.id,
        data: new Date("2026-08-01T16:00:00Z"),
        evento: over.evento ?? `Jogo ${++n}`,
        esporte: "Soccer",
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        mercado: "Moneyline",
        selecao: "Casa",
        odds: 2.0,
        stake: 1,
        valorUnidade: 100,
        status: "PENDING",
        source: over.source ?? SOURCE,
        sourceExternalId: over.sourceExternalId === undefined ? `x-${n}` : over.sourceExternalId,
      },
    });
    const postA1 = await bet({ sourceExternalId: "900:1", evento: "A1" });
    const postA2 = await bet({ sourceExternalId: "900:2", evento: "A2" });
    const postB = await bet({ sourceExternalId: "901", evento: "B" });
    const manual = await bet({ source: "web-manual", sourceExternalId: null, evento: "Manual" });
    const mesmoPostOutraBanca = await bet({ bankrollId: outra.id, sourceExternalId: "900:3", evento: "Outra banca" });
    return { bankroll, conta, postA1, postA2, postB, manual, mesmoPostOutraBanca, bet };
  }

  /** O que a tela manda de volta: o lote da prévia, com status e lucro de cada uma. */
  async function preview(bankrollId: string, betIds: string[]) {
    const plan = await planBatchRemoval({ bankrollId, betIds });
    return plan.remove.map(({ id, status, lucro }) => ({ id, status, lucro }));
  }

  async function removeAsConfirmed(bankrollId: string, betIds: string[]) {
    return removeBetsInBatch({ bankrollId, betIds, confirmed: await preview(bankrollId, betIds), actor: "fabricio" });
  }

  it("a prévia mostra o lote do post, a stake e o resultado que sai, sem gravar nada", async () => {
    const { bankroll, postA1 } = await seedLote();
    await applyBetStatusChange({ betId: postA1.id, newStatus: "WON", source: "test" });

    const plan = await planBatchRemoval({ bankrollId: bankroll.id, betIds: [postA1.id] });

    expect(plan.remove.map((bet) => bet.evento)).toEqual(["A1", "A2"]);
    expect(plan.fromSamePost).toBe(1);
    expect(plan).toMatchObject({ stakeUnits: 2, stakeReais: 200, resultUnits: 1, resultReais: 100, review: [], missing: 0 });
    expect(await db.prisma.bet.count({ where: { deletedAt: { not: null } } })).toBe(0);
    expect(await db.prisma.auditEvent.count({ where: { action: { in: ["bet.soft_delete", "bet.batch_remove"] } } })).toBe(0);
  });

  it("remove as marcadas e as do mesmo post, com estorno, restauráveis e com o operador na trilha", async () => {
    const { bankroll, conta, postA1, postA2, postB, manual, mesmoPostOutraBanca } = await seedLote();
    await applyBetStatusChange({ betId: postA2.id, newStatus: "WON", source: "test" });
    expect(await saldoDe(conta.id)).toBe(1100);

    const plan = await removeAsConfirmed(bankroll.id, [postA1.id, manual.id]);

    expect(plan.remove.map((bet) => bet.id).sort()).toEqual([manual.id, postA1.id, postA2.id].sort());
    // O ganho da liquidada foi estornado.
    expect(await saldoDe(conta.id)).toBe(1000);
    const removidas = await db.prisma.bet.findMany({ where: { id: { in: [postA1.id, postA2.id, manual.id] } } });
    for (const bet of removidas) {
      expect(bet.deletedAt).toBeInstanceOf(Date);
      expect(bet.notTakenAt).toBeInstanceOf(Date);
    }
    // O post de outra banca e o outro post da mesma banca ficam.
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: mesmoPostOutraBanca.id } })).deletedAt).toBeNull();
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: postB.id } })).deletedAt).toBeNull();
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.soft_delete", actor: "fabricio" } })).toBe(3);
    expect(await db.prisma.auditEvent.findFirst({ where: { action: "bet.batch_remove" }, select: { actor: true, resourceId: true } }))
      .toEqual({ actor: "fabricio", resourceId: bankroll.id });

    const restore = await restoreBetsInBatch({ bankrollId: bankroll.id, betIds: [postA1.id, postA2.id, manual.id], actor: "fabricio" });
    expect(restore.restored.sort()).toEqual([manual.id, postA1.id, postA2.id].sort());
    expect(await saldoDe(conta.id)).toBe(1100);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: postA2.id } })).status).toBe("WON");
  });

  it("trava o lote antes do primeiro estorno: a liquidação da irmã, que já travou a aposta, não fecha ciclo com a conta", async () => {
    const { bankroll, conta, postA1, postA2 } = await seedLote();
    // A1 sai com estorno na conta; A2, do mesmo post, é a que a automação está liquidando.
    await applyBetStatusChange({ betId: postA1.id, newStatus: "WON", source: "test" });

    await settleRaceAgainst({ betId: postA2.id, contaId: conta.id }, () => removeAsConfirmed(bankroll.id, [postA1.id]));

    expect(await saldoDe(conta.id)).toBe(1000);
    expect(await db.prisma.bet.count({ where: { id: { in: [postA1.id, postA2.id] }, deletedAt: { not: null } } })).toBe(2);
  });

  it("liquidada há mais de 7 dias fica fora, como no 👎, e vira revisão", async () => {
    const { bankroll, postA1, postA2 } = await seedLote();
    await applyBetStatusChange({ betId: postA2.id, newStatus: "LOST", source: "test" });
    await db.prisma.bet.update({ where: { id: postA2.id }, data: { settledAt: new Date(Date.now() - 8 * 86_400_000) } });

    const plan = await removeAsConfirmed(bankroll.id, [postA1.id]);

    expect(plan.remove.map((bet) => bet.id)).toEqual([postA1.id]);
    expect(plan.review.map((bet) => bet.id)).toEqual([postA2.id]);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: postA2.id } })).deletedAt).toBeNull();
    expect(await db.prisma.operationalAction.findFirst({
      where: { resource: "bet", resourceId: postA2.id, status: "OPEN" },
      select: { actionType: true },
    })).toEqual({ actionType: "bet.removal.review" });
  });

  it("marcada que já saiu da banca conta como ausente; nada marcado na banca é recusa", async () => {
    const { bankroll, postA1, postB } = await seedLote();
    await softDeleteBet({ betId: postB.id, actor: "fabricio", motivo: "outra aba", origin: "painel" });
    const plan = await planBatchRemoval({ bankrollId: bankroll.id, betIds: [postA1.id, postB.id] });
    expect(plan.missing).toBe(1);
    await expect(removeBetsInBatch({ bankrollId: bankroll.id, betIds: [postB.id], confirmed: [], actor: "fabricio" }))
      .rejects.toThrow(new RecusaDeNegocioError("Nenhuma das apostas marcadas está mais na lista do tipster."));
  });

  it("aposta liquidada depois da prévia recusa a remoção: o estorno seria outro", async () => {
    const { bankroll, conta, postA1, postA2 } = await seedLote();
    const shown = await preview(bankroll.id, [postA1.id]);
    await applyBetStatusChange({ betId: postA2.id, newStatus: "WON", source: "test" });

    await expect(removeBetsInBatch({ bankrollId: bankroll.id, betIds: [postA1.id], confirmed: shown, actor: "fabricio" }))
      .rejects.toThrow(new RecusaDeNegocioError("O lote mudou depois da prévia: A2 — Casa foi liquidada. Confira de novo antes de remover."));
    expect(await db.prisma.bet.count({ where: { deletedAt: { not: null } } })).toBe(0);
    expect(await saldoDe(conta.id)).toBe(1100);
    expect(await db.prisma.auditEvent.count({ where: { action: { in: ["bet.soft_delete", "bet.batch_remove"] } } })).toBe(0);
  });

  it("aposta nova do mesmo post depois da prévia recusa a remoção: sairia sem ter sido vista", async () => {
    const { bankroll, postA1, bet } = await seedLote();
    const shown = await preview(bankroll.id, [postA1.id]);
    await bet({ sourceExternalId: "900:4", evento: "A3" });

    await expect(removeBetsInBatch({ bankrollId: bankroll.id, betIds: [postA1.id], confirmed: shown, actor: "fabricio" }))
      .rejects.toThrow(new RecusaDeNegocioError("O lote mudou depois da prévia: A3 — Casa, do mesmo post, entrou depois da prévia. Confira de novo antes de remover."));
    expect(await db.prisma.bet.count({ where: { deletedAt: { not: null } } })).toBe(0);

    // A prévia nova mostra o lote de agora, e com ela a remoção grava.
    const plan = await removeAsConfirmed(bankroll.id, [postA1.id]);
    expect(plan.remove.map((item) => item.evento)).toEqual(["A1", "A2", "A3"]);
  });

  it("usa somente a última remoção de cada aposta, respeitando recurso e ação", async () => {
    const { bet } = await seed();
    await db.prisma.auditEvent.createMany({ data: Array.from({ length: 200 }, (_, index) => ({
      action: "bet.soft_delete", resource: "bet", resourceId: bet.id,
      createdAt: new Date(Date.now() - 86_400_000 - index * 1000),
      details: { origin: "reacao", previousStatus: "WON", previousLucro: 1 },
    })) });
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "removida", origin: "painel" }, { deferEffects: true });
    const later = new Date(Date.now() + 1000);
    await db.prisma.auditEvent.createMany({ data: [
      { action: "bet.soft_delete", resource: "conta", resourceId: bet.id, createdAt: later, details: { previousStatus: "LOST", previousLucro: -1 } },
      { action: "bet.edit", resource: "bet", resourceId: bet.id, createdAt: later, details: { previousStatus: "LOST", previousLucro: -1 } },
    ] });
    const removals = await describeRemovals([bet.id, bet.id, "missing"]);
    expect(removals.size).toBe(1);
    expect(removals.get(bet.id)).toMatchObject({ origin: "painel", restorable: true, previous: { status: "PENDING", lucro: 0 } });
    await db.prisma.auditEvent.create({ data: { action: "bet.soft_delete", resource: "bet", resourceId: bet.id, createdAt: later,
      details: { origin: "painel", reason: "snapshot incompleto" } } });
    // Snapshot novo incompleto não permite recuperar o financeiro de uma remoção antiga.
    expect((await describeRemovals([bet.id])).get(bet.id)?.previous).toBeNull();
  });

  it("a lista e a ficha leem a origem, se volta e o que o estorno desfez", async () => {
    const { bankroll, postA1, postB, manual } = await seedLote();
    await applyBetStatusChange({ betId: postB.id, newStatus: "WON", source: "test" });
    await removeAsConfirmed(bankroll.id, [manual.id]);
    await softDeleteBet({ betId: postB.id, actor: "telegram-user:1", motivo: "nao_peguei (👎)", origin: "reacao" });
    // Exclusão gravada antes da restauração existir: sem a marca e sem origem.
    await db.prisma.bet.update({ where: { id: postA1.id }, data: { deletedAt: new Date(), status: "CANCELED", settledAt: new Date() } });

    const removals = await describeRemovals([manual.id, postB.id, postA1.id]);

    expect(removals.get(manual.id)).toMatchObject({ origin: "painel", restorable: true, previous: { status: "PENDING", lucro: 0 } });
    expect(removals.get(postB.id)).toMatchObject({ origin: "reacao", restorable: true, previous: { status: "WON", lucro: 1 } });
    expect(removals.get(postA1.id)).toMatchObject({ origin: "painel", restorable: false, previous: null });
    expect(removals.get(manual.id)?.at).toBeInstanceOf(Date);
  });
});


describe("histórico de restauração", () => {
  it("mantém o estado restaurado depois de expirar a auditoria da remoção", async () => {
    const { bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    const settled = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "não peguei", origin: "painel" }, { deferEffects: true });
    await db.prisma.auditEvent.updateMany({ where: { action: "bet.soft_delete", resourceId: bet.id },
      data: { createdAt: new Date(Date.now() - 366 * 86_400_000) } });
    await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "restaurada", by: "painel" }, { deferEffects: true });
    const restored = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    await purgeOldAuditEvents();
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.soft_delete", resourceId: bet.id } })).toBe(0);
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bet.not_taken_undone", resourceId: bet.id } });
    expect(audit.details).toMatchObject({ restoredStatus: "WON", restoredLucro: 1,
      restoredSettledAt: settled.settledAt!.toISOString(), contaId: restored.contaId, valorUnidade: 100 });
  });
});


it("remoções com o mesmo horário restauram o último estado e a última origem", async () => {
  const { bet, conta } = await seed();
  await runSerializableTransaction("remove-restore-cycle", async (tx) => {
    const options = { client: reuseSerializableTransaction(tx), deferEffects: true };
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "primeira", origin: "reacao" }, options);
    await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "voltar", by: "reacao" }, options);
    await applyManualBetStatusChangeTx(tx, { betId: bet.id, newStatus: "WON", source: "manual:teste" });
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "segunda", origin: "painel" }, options);
  });
  const audits = await db.prisma.auditEvent.findMany({ where: { action: "bet.soft_delete", resourceId: bet.id } });
  expect(audits).toHaveLength(2);
  // O relógio pode repetir um instante; ele não prova a ordem das decisões.
  await db.prisma.auditEvent.updateMany({ where: { action: "bet.soft_delete", resourceId: bet.id }, data: { createdAt: audits[0]!.createdAt } });
  expect((await describeRemovals([bet.id])).get(bet.id)).toMatchObject({ origin: "painel", previous: { status: "WON", lucro: 1 } });
  await expect(restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "tirar reação", by: "reacao" }, { deferEffects: true }))
    .resolves.toMatchObject({ changed: false, panelOnly: true });
  await expect(restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "painel", by: "painel" }, { deferEffects: true }))
    .resolves.toMatchObject({ changed: true, restoredStatus: "WON" });
  expect(await saldoDe(conta.id)).toBe(1100);
});


it("empate de remoções sem revisão íntegra bloqueia a restauração financeira", async () => {
  const { bet, conta } = await seed();
  await softDeleteBet({ betId: bet.id, actor: "test", motivo: "remover", origin: "painel" }, { deferEffects: true });
  const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bet.soft_delete", resourceId: bet.id } });
  const details = { origin: "painel", previousStatus: "WON", previousLucro: 1, previousSettledAt: new Date().toISOString() };
  await db.prisma.auditEvent.update({ where: { id: audit.id }, data: { details } });
  await db.prisma.auditEvent.create({ data: { action: audit.action, resource: "bet", resourceId: bet.id, createdAt: audit.createdAt, details: { ...details, previousStatus: "LOST", previousLucro: -1 } } });
  expect((await describeRemovals([bet.id])).get(bet.id)?.previous).toBeNull();
  await expect(restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "restaurar", by: "painel" }, { deferEffects: true }))
    .resolves.toMatchObject({ changed: false, blocked: "missing_soft_delete_snapshot" });
  expect(await saldoDe(conta.id)).toBe(1000);
});


it("restaurar pendente devolve a observação final à fila e preserva sua prova na trilha", async () => {
  const { bet } = await seed();
  const now = new Date();
  await db.prisma.bet.update({ where: { id: bet.id }, data: { data: new Date(now.getTime() - 3 * 3_600_000) } });
  await db.prisma.betResult.create({ data: { betId: bet.id, resultProvider: "flashscore", resultMatchId: "fixture", resultCheckedAt: now, resultFinal: true, scoreHome: 2, scoreAway: 1, resultSnapshot: { outcome: "matched", settlementOutcome: "manual_missing_stats" } } });
  await softDeleteBet({ betId: bet.id, actor: "test", motivo: "remover", origin: "painel" }, { deferEffects: true });
  await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "restaurar", by: "painel" }, { deferEffects: true });
  expect((await listFlashscoreEligibleBets({ now })).map((item) => item.id)).toContain(bet.id);
  expect(await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } })).toMatchObject({ resultFinal: false, resultCheckedAt: null, scoreHome: null, scoreAway: null });
  const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { resourceId: bet.id, action: "bet.not_taken_undone" } });
  expect(audit.details).toMatchObject({ previousEvidence: { result: { resultMatchId: "fixture", scoreHome: 2, scoreAway: 1, resultFinal: true } } });
});

it.each([-0.5, 0, 0.5])("remover/restaurar cash-out %su preserva encerramento e saldo uma vez", async (cashoutLucro) => {
  const { bet, conta } = await seed();
  await applyBetStatusChange({ betId: bet.id, newStatus: "CASHOUT", cashoutLucro, source: "manual" }, { client: db.prisma });
  const settled = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
  await softDeleteBet({ betId: bet.id, actor: "test", motivo: "conferência", origin: "painel" }, { deferEffects: true });
  expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(1000);
  await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "conferida", by: "painel" });
  await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "repetição", by: "painel" });
  expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "CASHOUT", lucro: settled.lucro, settledAt: settled.settledAt });
  expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(1000 + cashoutLucro * 100);
});
