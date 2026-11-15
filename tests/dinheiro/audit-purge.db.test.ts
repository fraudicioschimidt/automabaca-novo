import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIT_FINANCIAL_RETENTION_DAYS,
  AUDIT_RETENTION_DAYS,
  purgeOldAuditEvents,
} from "@/src/services/ops/audit-purge";
import { ACOES_DE_AUDITORIA_DA_TRILHA } from "@/src/domain/trilha-da-aposta";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Retenção da trilha financeira: todo o ciclo da aposta, inclusive o
 * `bet.create`, fica 365 dias, e não na janela comum de 30. Este teste cobra o
 * CICLO INTEIRO, derivado do registro da trilha (o que a ficha exibe é o que
 * precisa sobreviver), não só a ação que alguém lembrou de adicionar.
 *
 * `bet.settle` e `bet.settle_batch_item` não entram: são nomes de
 * `observeAction` (métrica de borda), nunca `action` de auditoria. A liquidação
 * mora em `settlement_events`, que a purga não toca — há um caso provando isso.
 */

const DIA_MS = 86_400_000;

/**
 * Ciclo de vida financeiro completo. Derivado do registro da trilha (o que a
 * ficha da aposta exibe) mais o desfazer do 👎, que mexe no ledger sem aparecer
 * na trilha.
 */
const CICLO_FINANCEIRO_DA_APOSTA = [
  ...ACOES_DE_AUDITORIA_DA_TRILHA,
  "bet.not_taken_undone",
] as const;

let db: TestDb;

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

async function semear(action: string, idadeEmDias: number): Promise<void> {
  await db.prisma.auditEvent.create({
    data: {
      actor: "test",
      action,
      resource: "bet",
      resourceId: `${action}-${idadeEmDias}`,
      createdAt: new Date(Date.now() - idadeEmDias * DIA_MS),
    },
  });
}

async function acoesVivas(): Promise<string[]> {
  const linhas = await db.prisma.auditEvent.findMany({ select: { action: true } });
  return linhas.map((linha) => linha.action).sort();
}

describe("retenção da trilha de auditoria", () => {
  it.each(["OPEN", "ACKED"] as const)("conserva recibo de entrega enquanto o ciclo está %s e purga os antigos", async (status) => {
    const incident = await db.prisma.operationalAction.create({ data: {
      fingerprint: "test-receipt", area: "incidentes", actionType: "incident.review",
      title: "Incidente de teste", description: "Teste de retenção", status, reopenCount: 2,
    } });
    const receipt = await db.prisma.auditEvent.create({ data: {
      action: "ops.alert_once_delivered", resource: "operational_action", resourceId: incident.id,
      createdAt: new Date(Date.now() - 40 * DIA_MS), details: { cycle: 2 },
    } });
    const previous = await db.prisma.auditEvent.create({ data: {
      action: "ops.alert_once_delivered", resource: "operational_action", resourceId: incident.id,
      createdAt: new Date(Date.now() - 40 * DIA_MS), details: { cycle: 1 },
    } });
    await purgeOldAuditEvents();
    expect(await db.prisma.auditEvent.findUnique({ where: { id: receipt.id } })).not.toBeNull();
    expect(await db.prisma.auditEvent.findUnique({ where: { id: previous.id } })).toBeNull();
    await db.prisma.operationalAction.update({ where: { id: incident.id }, data: { status: "RESOLVED" } });
    await purgeOldAuditEvents();
    expect(await db.prisma.auditEvent.findUnique({ where: { id: receipt.id } })).toBeNull();
  });

  it("preserva a prova antiga de origem absorvida enquanto não há recibo durável", async () => {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Teste", slug: "teste" } });
    const bet = await db.prisma.bet.create({ data: { bankrollId: bankroll.id, data: new Date(), evento: "A vs B", esporte: "Soccer", sportResolvedAt: new Date(),
      mercado: "Moneyline", selecao: "A", odds: 2, stake: 1 } });
    const audit = await db.prisma.auditEvent.create({ data: { action: "bet.duplicate_absorbed", resource: "bet", resourceId: bet.id,
      details: { source: "telegram-dm:123", sourceExternalId: "42" }, createdAt: new Date(Date.now() - 400 * DIA_MS) } });
    await purgeOldAuditEvents();
    expect(await db.prisma.auditEvent.findUnique({ where: { id: audit.id } })).not.toBeNull();
    await db.prisma.absorbedBetSource.create({ data: { betId: bet.id, source: "telegram-dm:123", sourceExternalId: "42" } });
    await purgeOldAuditEvents();
    expect(await db.prisma.auditEvent.findUnique({ where: { id: audit.id } })).toBeNull();
    expect(await db.prisma.absorbedBetSource.count()).toBe(1);
  });

  it("preserva o agendamento pendente da captura até ser confirmado", async () => {
    const createdAt = new Date(Date.now() - 40 * DIA_MS);
    const pending = await db.prisma.auditEvent.create({ data: {
      actor: "test", action: "capture.followup", resource: "bet", outcome: "pending", createdAt,
    } });
    await db.prisma.auditEvent.create({ data: {
      actor: "test", action: "capture.followup", resource: "bet", outcome: "success", createdAt,
    } });
    await purgeOldAuditEvents();
    expect(await db.prisma.auditEvent.findMany({ select: { id: true } })).toEqual([{ id: pending.id }]);
    await db.prisma.auditEvent.update({ where: { id: pending.id }, data: { outcome: "success" } });
    await purgeOldAuditEvents();
    expect(await db.prisma.auditEvent.count()).toBe(0);
  });

  it("o ciclo financeiro da aposta sobrevive muito além dos 30 dias comuns", async () => {
    const idade = AUDIT_RETENTION_DAYS + 60; // 90 dias: já morto para a janela comum
    for (const action of CICLO_FINANCEIRO_DA_APOSTA) await semear(action, idade);

    await purgeOldAuditEvents();

    expect(await acoesVivas()).toEqual([...CICLO_FINANCEIRO_DA_APOSTA].sort());
  });

  it("purga o ciclo financeiro só depois de um ano", async () => {
    for (const action of CICLO_FINANCEIRO_DA_APOSTA) {
      await semear(action, AUDIT_FINANCIAL_RETENTION_DAYS + 5);
    }

    await purgeOldAuditEvents();

    expect(await acoesVivas()).toEqual([]);
  });

  it("preserva o snapshot do soft-delete enquanto o 👎 ainda é reversível", async () => {
    const old = new Date(Date.now() - (AUDIT_FINANCIAL_RETENTION_DAYS + 5) * DIA_MS);
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Tombstone", slug: "retencao-tombstone" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: old,
        data: old,
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        status: "CANCELED",
        lucro: 0,
        settledAt: old,
        deletedAt: old,
        notTakenAt: old,
      },
    });
    await db.prisma.auditEvent.create({
      data: {
        actor: "test",
        action: "bet.soft_delete",
        resource: "bet",
        resourceId: bet.id,
        createdAt: old,
        details: {
          previousStatus: "WON",
          previousLucro: 1,
          previousSettledAt: old.toISOString(),
        },
      },
    });

    await purgeOldAuditEvents();
    expect(await db.prisma.auditEvent.count({
      where: { action: "bet.soft_delete", resourceId: bet.id },
    })).toBe(1);

    await db.prisma.bet.update({ where: { id: bet.id }, data: { notTakenAt: null } });
    await purgeOldAuditEvents();
    expect(await db.prisma.auditEvent.count({
      where: { action: "bet.soft_delete", resourceId: bet.id },
    })).toBe(0);
  });

  it("drift de ledger fica os 90 dias de investigação, como os drifts irmãos", async () => {
    await semear("bet_ledger_drift", AUDIT_RETENTION_DAYS + 30); // 60d: vivo
    await semear("bet_lucro_drift", AUDIT_RETENTION_DAYS + 30);
    await semear("conta_drift", AUDIT_RETENTION_DAYS + 30);

    await purgeOldAuditEvents();

    expect(await acoesVivas()).toEqual([
      "bet_ledger_drift",
      "bet_lucro_drift",
      "conta_drift",
    ]);
  });

  /**
   * A liquidação não está em `audit_events`: ela é uma linha de
   * `settlement_events`, tabela que a purga de auditoria não varre. Provar aqui
   * impede que alguém "conserte" a ausência de `bet.settle` recolocando o nome
   * morto na lista.
   */
  it("a liquidação vive em settlement_events e a purga de auditoria não a alcança", async () => {
    const banca = await db.prisma.bankroll.upsert({
      where: { slug: "ret" }, create: { nome: "Ret", slug: "ret" }, update: {},
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: banca.id, data: new Date(), evento: "A vs B", esporte: "Soccer",
        mercado: "Moneyline", selecao: "Casa", odds: 2, stake: 1,
      },
    });
    await db.prisma.settlementEvent.create({
      data: {
        betId: bet.id, type: "STATUS_CHANGED", payloadHash: "velho",
        createdAt: new Date(Date.now() - (AUDIT_FINANCIAL_RETENTION_DAYS + 400) * DIA_MS),
        payload: { from: "PENDING", to: "WON", lucro: 1, source: "flashscore" },
      },
    });

    await purgeOldAuditEvents();

    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id } })).toBe(1);
  });

  it("a remoção de alias de mercado fica enquanto o alias está fora do mercado", async () => {
    // A sincronização do catálogo lê a remoção para não recolocar o alias.
    const mercado = await db.prisma.mercadoPadrao.create({ data: { nome: "Correct Score" } });
    for (const aliasNormalizado of ["placar exato", "resultado correto"]) {
      await db.prisma.auditEvent.create({
        data: {
          actor: "fabricio",
          action: "market_alias.delete",
          resource: "market_alias",
          resourceId: aliasNormalizado,
          createdAt: new Date(Date.now() - (AUDIT_FINANCIAL_RETENTION_DAYS + 5) * DIA_MS),
          details: { alias: aliasNormalizado, aliasNormalizado, mercadoPadraoId: mercado.id },
        },
      });
    }
    // O dono pôs "resultado correto" de volta: a remoção dele deixou de valer.
    await db.prisma.mercadoAlias.create({
      data: { alias: "Resultado Correto", aliasNormalizado: "resultado correto", mercadoPadraoId: mercado.id },
    });
    await semear("market_alias.delete", AUDIT_RETENTION_DAYS + 60);

    await purgeOldAuditEvents();

    const vivas = await db.prisma.auditEvent.findMany({
      where: { action: "market_alias.delete" }, select: { resourceId: true },
    });
    expect(vivas.map((linha) => linha.resourceId).sort()).toEqual([
      `market_alias.delete-${AUDIT_RETENTION_DAYS + 60}`, "placar exato",
    ]);
  });

  it("a causa da dead-letter retida dura os 90 dias da dead-letter", async () => {
    await semear("job.dlq_retained", AUDIT_RETENTION_DAYS + 30);
    await semear("job.dlq_retained", 95);

    await purgeOldAuditEvents();

    expect(await acoesVivas()).toEqual(["job.dlq_retained"]);
  });

  it("evento comum antigo continua saindo na janela de 30 dias", async () => {
    await semear("auth.login_ok", AUDIT_RETENTION_DAYS + 5);
    await semear("bet.create", AUDIT_RETENTION_DAYS + 5);

    await purgeOldAuditEvents();

    // Só o financeiro fica: a janela comum não pode ser afrouxada junto.
    expect(await acoesVivas()).toEqual(["bet.create"]);
  });
});


it("a retenção do bloqueio do canal não impede a purga das outras mudanças do tipster", async () => {
  const createdAt = new Date(Date.now() - (AUDIT_FINANCIAL_RETENTION_DAYS + 5) * DIA_MS);
  await db.prisma.auditEvent.createMany({ data: [
    { actor: "test", action: "bankroll.update", resource: "bankroll", resourceId: "nome", details: { nome: "Novo nome" }, createdAt },
    { actor: "test", action: "bankroll.delete", resource: "bankroll", resourceId: "sem-canal", details: { telegramChannelIds: [] }, createdAt },
  ] });
  await purgeOldAuditEvents();
  expect(await db.prisma.auditEvent.count()).toBe(0);
});
