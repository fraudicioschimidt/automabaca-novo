import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OperationalRisk } from "@/src/generated/prisma/enums";
import {
  resolverAcoesDeLiquidacaoResolvida,
  resolverAcoesSemRecurso,
} from "@/src/services/ops/action-resource-gc";
import { BET_LEDGER_ALERT_SOURCE } from "@/src/services/ops/consistency/bet-ledger";
import { reportOperationalAction } from "@/src/services/ops/operational-actions";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Ação sobre alvo que não existe mais não tem decisão humana possível.
 *
 * Apostas que o operador excluiu e jobs que sumiram do pg-boss deixam ações
 * com `autoResolve: false` — corretamente, porque dead-letter exige humano —,
 * que por isso nunca fechariam sozinhas. Caixa que acumula item morto é caixa
 * ignorada.
 */

let db: TestDb;

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

async function acaoSobre(resource: string, resourceId: string, key: string, source = "teste.gc") {
  return reportOperationalAction({
    source,
    key,
    area: "incidentes",
    actionType: "incident.review",
    title: `Ação sobre ${resource}`,
    description: "Alvo pode ter sumido.",
    priority: 70,
    risk: OperationalRisk.MEDIUM,
    resource,
    resourceId,
    // Exatamente o caso que a reconciliação normal NÃO fecha.
    autoResolve: false,
  });
}

async function apostaEm(deletada: boolean) {
  const banca = await db.prisma.bankroll.upsert({
    where: { slug: "gc" },
    create: { nome: "GC", slug: "gc" },
    update: {},
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      bankrollId: banca.id,
      data: new Date("2026-08-10T18:00:00Z"),
      evento: "Time A vs Time B",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Casa",
      odds: 2,
      stake: 1,
      ...(deletada ? { deletedAt: new Date() } : {}),
    },
  });
}

async function statusDa(id: string) {
  const acao = await db.prisma.operationalAction.findUniqueOrThrow({ where: { id } });
  return acao.status;
}

describe("ações sem recurso", () => {
  it("aposta excluída fecha a ação, mesmo com autoResolve false", async () => {
    const bet = await apostaEm(true);
    const acao = await acaoSobre("bet", bet.id, "bet-excluida");

    await expect(resolverAcoesSemRecurso()).resolves.toBe(1);
    expect(await statusDa(acao.id)).toBe("RESOLVED");
  });

  it("ledger divergente de aposta removida fica aberto: o estorno é o que ele vigia", async () => {
    const bet = await apostaEm(true);
    const acao = await acaoSobre("bet", bet.id, "ledger-da-removida", BET_LEDGER_ALERT_SOURCE);

    await expect(resolverAcoesSemRecurso()).resolves.toBe(0);
    expect(await statusDa(acao.id)).toBe("OPEN");
  });

  it("aposta viva mantém a ação aberta", async () => {
    const bet = await apostaEm(false);
    const acao = await acaoSobre("bet", bet.id, "bet-viva");

    await expect(resolverAcoesSemRecurso()).resolves.toBe(0);
    expect(await statusDa(acao.id)).toBe("OPEN");
  });

  it("job que não está mais no pg-boss fecha a ação", async () => {
    const acao = await acaoSobre("pgboss-job", "f59ea24f-3b7e-47ae-8199-b556992538c9", "job-sumido");

    await expect(resolverAcoesSemRecurso()).resolves.toBe(1);
    expect(await statusDa(acao.id)).toBe("RESOLVED");
  });

  it("id que não é uuid não é tratado como ausência", async () => {
    // Não dá para consultar, então não dá para afirmar que sumiu.
    const acao = await acaoSobre("pgboss-job", "id-estranho", "job-id-invalido");

    await expect(resolverAcoesSemRecurso()).resolves.toBe(0);
    expect(await statusDa(acao.id)).toBe("OPEN");
  });

  it("recurso que a varredura não sabe verificar fica de fora", async () => {
    const acao = await acaoSobre("provider", "bridgeodds", "provider-desconhecido");

    await expect(resolverAcoesSemRecurso()).resolves.toBe(0);
    expect(await statusDa(acao.id)).toBe("OPEN");
  });

  it("o fechamento automático deixa rastro auditável", async () => {
    const bet = await apostaEm(true);
    const acao = await acaoSobre("bet", bet.id, "bet-auditada");
    await resolverAcoesSemRecurso();

    const evento = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "operational_action.auto_resolved", resourceId: acao.id },
    });
    expect(evento.details).toMatchObject({ note: expect.stringContaining("não existe mais") });
  });
});

describe("ações de liquidação após settle", () => {
  it("fecha score-unsupported quando a aposta já não está PENDING", async () => {
    const bet = await apostaEm(false);
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { status: "LOST", settledAt: new Date() },
    });
    const acao = await reportOperationalAction({
      source: "settlement.score-unsupported",
      key: bet.id,
      area: "incidentes",
      actionType: "incident.review",
      title: "Liquidação manual necessária",
      description: "Placar disponível mas não resolvi.",
      resource: "bet",
      resourceId: bet.id,
      autoResolve: false,
    });

    await expect(resolverAcoesDeLiquidacaoResolvida()).resolves.toBe(1);
    expect(await statusDa(acao.id)).toBe("RESOLVED");
  });

  it("fecha goalscorer e player-prop quando a aposta já não está PENDING", async () => {
    const bet = await apostaEm(false);
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { status: "WON", settledAt: new Date() },
    });
    const fontes = [
      "settlement.flashscore-goalscorer",
      "settlement.flashscore-ordered-goalscorer",
      "settlement.flashscore-player-prop",
    ] as const;
    const acoes = [];
    for (const source of fontes) {
      acoes.push(await reportOperationalAction({
        source,
        key: `${bet.id}:${source}`,
        area: "incidentes",
        actionType: "incident.review",
        title: source,
        description: "precisa liquidar",
        resource: "bet",
        resourceId: bet.id,
        autoResolve: false,
      }));
    }

    await expect(resolverAcoesDeLiquidacaoResolvida()).resolves.toBe(3);
    for (const acao of acoes) {
      expect(await statusDa(acao.id)).toBe("RESOLVED");
    }
  });

  it("fecha o aviso de jogo interrompido quando o jogo retoma e a aposta liquida", async () => {
    const bet = await apostaEm(false);
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { status: "WON", settledAt: new Date() },
    });
    const acoes = [];
    for (const source of ["settlement.flashscore-interrupted", "settlement.ticket-interrupted"] as const) {
      acoes.push(await reportOperationalAction({
        source,
        key: bet.id,
        area: "incidentes",
        actionType: "incident.review",
        title: source,
        description: "jogo parado",
        resource: "bet",
        resourceId: bet.id,
        autoResolve: false,
      }));
    }

    await expect(resolverAcoesDeLiquidacaoResolvida()).resolves.toBe(2);
    for (const acao of acoes) {
      expect(await statusDa(acao.id)).toBe("RESOLVED");
    }
  });

  it("não fecha recheck nem aposta ainda PENDING", async () => {
    const pending = await apostaEm(false);
    const settled = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: pending.bankrollId,
        data: new Date("2026-08-10T18:00:00Z"),
        evento: "Outro vs Time",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Casa",
        odds: 2,
        stake: 1,
        status: "WON",
        settledAt: new Date("2026-08-10T20:00:00Z"),
      },
    });
    const aindaPendente = await reportOperationalAction({
      source: "settlement.score-unsupported",
      key: pending.id,
      area: "incidentes",
      actionType: "incident.review",
      title: "Ainda pending",
      description: "Ainda pending",
      resource: "bet",
      resourceId: pending.id,
      autoResolve: false,
    });
    const recheck = await reportOperationalAction({
      source: "settlement.flashscore-recheck",
      key: settled.id,
      area: "incidentes",
      actionType: "incident.review",
      title: "Recheck",
      description: "Placar divergiu",
      resource: "bet",
      resourceId: settled.id,
      autoResolve: false,
    });

    await expect(resolverAcoesDeLiquidacaoResolvida()).resolves.toBe(0);
    expect(await statusDa(aindaPendente.id)).toBe("OPEN");
    expect(await statusDa(recheck.id)).toBe("OPEN");
  });
});
