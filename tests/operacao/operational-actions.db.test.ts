import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/src/services/ops/dlq/replay", () => ({
  listDeadLetters: vi.fn(async () => []),
}));
import { OperationalActionStatus, OperationalRisk } from "@/src/generated/prisma/client";
import {
  acknowledgeOperationalAction,
  closeOperationalAction,
  operationalActionFingerprint,
  reconcileOperationalActionSource,
  reportOperationalAction,
  reportOperationalActions,
  resolveOperationalActionBySourceKey,
} from "@/src/services/ops/operational-actions";
import {
  reconcileMappedTelegramChannelActions,
  reconcileOperationalActions,
} from "@/src/services/ops/action-sources";
import { getPainelOperationalActions } from "@/src/services/painel/operacoes/actions";
import {
  resolverAcoesDeLiquidacaoResolvida,
  resolverAcoesSemRecurso,
} from "@/src/services/ops/action-resource-gc";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

const base = {
  source: "training",
  key: "case-1",
  area: "matching",
  actionType: "training.resolve",
  title: "Resolver identidade",
  description: "Há candidatos aguardando confirmação.",
  priority: 70,
  risk: OperationalRisk.MEDIUM,
  resource: "training-case",
  resourceId: "case-1",
  evidence: { candidates: 2 },
  command: { name: "training.resolve", caseId: "case-1" },
};

describe("ações operacionais persistentes", () => {
  it("reconciliação encerra, como sistema, ações de fontes que deixaram de existir", async () => {
    const retired = await reportOperationalAction({ ...base, source: "telegram.result-review", key: "-100:42",
      area: "captura", actionType: "result_review", resource: "telegram-channel", resourceId: "-100:42", autoResolve: false });
    const oldBatch = await reportOperationalAction({ ...base, source: "telegram.capture-batch", key: "telegram-channel:-100:44",
      area: "incidentes", actionType: "incident.review", resource: "bankroll", resourceId: "bank-1", autoResolve: false });
    const human = await reportOperationalAction({ ...base, source: "telegram.reaction-review", key: "-100:43",
      area: "apostas", actionType: "bet.reaction.review", resource: "bet", resourceId: "bet-43", autoResolve: false });
    await reconcileOperationalActions();
    expect(await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: retired.id } }))
      .toMatchObject({ status: OperationalActionStatus.RESOLVED, resolutionNote: expect.stringContaining("deixou de existir") });
    expect((await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: oldBatch.id } })).status).toBe(OperationalActionStatus.RESOLVED);
    expect(await db.prisma.auditEvent.findFirst({ where: { action: "operational_action.auto_resolved", resourceId: retired.id } }))
      .toMatchObject({ actor: "system" });
    // Fonte viva que pediu decisão humana continua aberta.
    expect((await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: human.id } })).status).toBe(OperationalActionStatus.OPEN);
  });

  it("transporta totais reais e carrega uma página independente por aba", async () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, index) => ({ status: OperationalActionStatus.OPEN, key: `open-${index}` })),
      ...Array.from({ length: 7 }, (_, index) => ({ status: OperationalActionStatus.ACKED, key: `acked-${index}` })),
      ...Array.from({ length: 31 }, (_, index) => ({ status: OperationalActionStatus.RESOLVED, key: `resolved-${index}` })),
    ];
    await db.prisma.operationalAction.createMany({
      data: rows.map(({ status, key }, index) => ({
        fingerprint: `painel:${key}`,
        area: "teste",
        actionType: "audit.review",
        title: `Ação ${key}`,
        description: "Evidência de paginação.",
        priority: index,
        status,
      })),
    });

    const monitoring = await getPainelOperationalActions();
    expect(monitoring.totais).toEqual({
      abertas: 30,
      assumidas: 7,
      encerradas: 31,
      acionaveis: 37,
    });
    expect(monitoring.acoes.filter((item) => item.status === OperationalActionStatus.OPEN)).toHaveLength(25);
    expect(monitoring.acoes.filter((item) => item.status === OperationalActionStatus.ACKED)).toHaveLength(7);
    expect(monitoring.acoes.filter((item) => item.status === OperationalActionStatus.RESOLVED)).toHaveLength(25);
  });

  it("ignora treino órfão deixado pela exclusão definitiva da banca", async () => {
    const active = await db.prisma.bankroll.create({
      data: { nome: "Ativa", slug: "ativa" },
    });
    const deleted = await db.prisma.bankroll.create({
      data: { nome: "Removida", slug: "removida" },
    });
    for (const [index, bankroll] of [active, deleted].entries()) {
      const bet = await db.prisma.bet.create({
        data: {
          sportResolutionStatus: "CONFIRMED",
          sportResolvedAt: new Date(),
          bankrollId: bankroll.id,
          data: new Date("2026-08-01T16:00:00Z"),
          evento: `Time ${index} vs Rival`,
          esporte: "Soccer",
          mercado: "Moneyline",
          selecao: `Time ${index}`,
          odds: 2,
          stake: 1,
        },
      });
      await db.prisma.trainingCase.create({
        data: {
          betId: bet.id,
          evento: bet.evento,
          esporte: bet.esporte,
          status: "OPEN",
          candidatesJson: [],
        },
      });
    }
    await db.prisma.bankroll.delete({ where: { id: deleted.id } });

    await expect(reconcileOperationalActions()).resolves.toMatchObject({ training: 1 });
    expect(await db.prisma.operationalAction.count({
      where: { fingerprint: { startsWith: "training:" } },
    })).toBe(1);
  });

  it("cobra liquidação de aposta cujo jogo já terminou, e só depois da margem", async () => {
    const banca = await db.prisma.bankroll.create({ data: { nome: "Parada", slug: "parada" } });
    const aposta = (kickoffHorasAtras: number, evento: string) => db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: banca.id,
        data: new Date(Date.now() - kickoffHorasAtras * 3_600_000),
        evento,
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Casa",
        odds: 2,
        stake: 1,
        status: "PENDING",
      },
    });
    // 2h: jogo pode ter acabado agora; o ciclo de closing ainda vai passar.
    await aposta(2, "Recem terminado vs Rival");
    const parada = await aposta(30, "Parada ha 30h vs Rival");
    // Snapshot sem `settlementOutcome` não pode ser eliminado pelo `NOT` JSON
    // (NULL de três valores): a aposta sumiria do inbox apesar das 30h de atraso.
    await db.prisma.betResult.create({
      data: {
        betId: parada.id,
        resultSnapshot: { outcome: "no_candidate" },
      },
    });
    const adiada = await aposta(30, "Adiada vs Rival");
    await db.prisma.betResult.create({
      data: {
        betId: adiada.id,
        resultSnapshot: {
          outcome: "matched",
          settlementOutcome: "postponed_waiting",
        },
      },
    });
    const liquidada = await aposta(40, "Ja liquidada vs Rival");
    await db.prisma.bet.update({
      where: { id: liquidada.id },
      data: { status: "WON", settledAt: new Date() },
    });

    await expect(reconcileOperationalActions()).resolves.toMatchObject({ settlementParado: 1 });
    const acoes = await db.prisma.operationalAction.findMany({
      where: { fingerprint: { startsWith: "settlement.parado:" } },
    });
    expect(acoes).toHaveLength(1);
    expect(acoes[0]).toMatchObject({
      resourceId: parada.id,
      area: "settlement",
      priority: 85, // >= 24h parada
    });
    expect(acoes[0]?.evidence).toMatchObject({ horasParada: 30, tipster: "Parada" });

    // Liquidar encerra a ação sozinho — sem exigir clique do operador.
    await db.prisma.bet.update({
      where: { id: parada.id },
      data: { status: "LOST", settledAt: new Date() },
    });
    await reconcileOperationalActions();
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: acoes[0]!.id } }))
      .resolves.toMatchObject({ status: OperationalActionStatus.RESOLVED });
  });

  it("aposta estatística parada pede o par, não o placar de gols", async () => {
    const banca = await db.prisma.bankroll.create({
      data: { nome: "Cards parados", slug: "cards-parados" },
    });
    const aposta = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: banca.id,
        data: new Date(Date.now() - 30 * 3_600_000),
        evento: "Gremio vs Sao Paulo",
        esporte: "Soccer",
        mercado: "Total (Bookings) – Match",
        selecao: "Under 5.5",
        odds: 1.78,
        stake: 1,
        status: "PENDING",
      },
    });

    await expect(reconcileOperationalActions()).resolves.toMatchObject({ settlementParado: 1 });
    const acao = await db.prisma.operationalAction.findFirstOrThrow({
      where: { fingerprint: { startsWith: "settlement.parado:" } },
    });
    expect(acao.resourceId).toBe(aposta.id);
    expect(acao.description).toMatch(/pontos de cartões|amarelo=1/);
    expect(acao.description).not.toMatch(/falta só o placar/);
    expect(acao.evidence).toMatchObject({ statistic: "booking_points" });
  });

  it("não duplica incidente específico de settlement com card genérico de placar", async () => {
    const banca = await db.prisma.bankroll.create({
      data: { nome: "Incidente específico", slug: "incidente-especifico" },
    });
    const aposta = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: banca.id,
        data: new Date(Date.now() - 30 * 3_600_000),
        evento: "Gremio vs Sao Paulo",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Ambas 2+ cartões",
        odds: 1.78,
        stake: 1,
        status: "PENDING",
      },
    });
    await reportOperationalAction({
      source: "settlement.score-unsupported",
      key: aposta.id,
      area: "incidentes",
      actionType: "incident.review",
      title: "Liquidação manual necessária",
      description: "O placar não resolve a linha de cartões.",
      resource: "bet",
      resourceId: aposta.id,
      autoResolve: false,
    });

    await expect(reconcileOperationalActions()).resolves.toMatchObject({ settlementParado: 0 });
    await expect(db.prisma.operationalAction.count({
      where: { fingerprint: { startsWith: "settlement.parado:" } },
    })).resolves.toBe(0);
  });

  it("deduplica por fingerprint e preserva lifecycle/ownership", async () => {
    const first = await reportOperationalAction(base, new Date("2026-07-13T10:00:00Z"));
    const second = await reportOperationalAction(
      { ...base, evidence: { candidates: 3 } },
      new Date("2026-07-13T10:05:00Z"),
    );
    expect(second.id).toBe(first.id);
    expect(second.fingerprint).toBe(operationalActionFingerprint("training", "case-1"));
    expect(second.occurrenceCount).toBe(2);
    expect(second.evidence).toMatchObject({ candidates: 3 });

    const acked = await acknowledgeOperationalAction(first.id, "fabricio");
    expect(acked).toMatchObject({ status: OperationalActionStatus.ACKED, owner: "fabricio" });
    const resolved = await closeOperationalAction(first.id, "fabricio", "RESOLVED", "Resolvido.");
    expect(resolved).toMatchObject({ status: OperationalActionStatus.RESOLVED, resolutionNote: "Resolvido." });
  });

  it("grava a descrição e a evidência com as quebras de linha reais, sem segredo", async () => {
    const texto = "Tarefa parada · sharp.enrich\nErro: token=abc123segredo\n👉 Reprocesse pelo painel.";
    const unitaria = await reportOperationalAction({ ...base, description: texto, evidence: { message: texto } });
    const [emLote] = await reportOperationalActions([{ ...base, key: "case-2", description: texto }]);
    for (const acao of [unitaria, emLote!]) {
      expect(acao.description).toBe("Tarefa parada · sharp.enrich\nErro: token=[redacted]\n👉 Reprocesse pelo painel.");
    }
    const gravada = await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: unitaria.id } });
    expect(gravada.description.split("\n")).toHaveLength(3);
    expect((gravada.evidence as { message: string }).message).toBe(gravada.description);
  });

  it("reabre uma condição que reaparece", async () => {
    const first = await reportOperationalAction(base);
    await closeOperationalAction(first.id, "fabricio");
    const reopened = await reportOperationalAction(base);
    expect(reopened.status).toBe(OperationalActionStatus.OPEN);
    expect(reopened.resolvedAt).toBeNull();
  });

  it("não transforma reconciliação periódica em nova ocorrência", async () => {
    const first = await reportOperationalAction({ ...base, incrementOccurrence: false });
    const refreshed = await reportOperationalAction(
      { ...base, incrementOccurrence: false, evidence: { candidates: 4 } },
      new Date("2026-07-13T10:05:00Z"),
    );
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.occurrenceCount).toBe(1);
    expect(refreshed.evidence).toMatchObject({ candidates: 4 });
  });

  it("aceita o contador exato de uma fonte espelhada", async () => {
    await reportOperationalAction({ ...base, occurrenceCount: 7 });
    const mirrored = await reportOperationalAction({ ...base, occurrenceCount: 9 });
    expect(mirrored.occurrenceCount).toBe(9);
  });

  it("atualiza múltiplas ações pelo caminho em lote sem alterar o lifecycle", async () => {
    const second = { ...base, key: "case-2", resourceId: "case-2" };
    await reportOperationalActions([base, second], new Date("2026-07-13T10:00:00Z"));
    const refreshed = await reportOperationalActions([
      { ...base, incrementOccurrence: false, evidence: { candidates: 5 } },
      { ...second, incrementOccurrence: false },
    ], new Date("2026-07-13T10:05:00Z"));
    expect(refreshed).toHaveLength(2);
    expect(refreshed[0]).toMatchObject({ occurrenceCount: 1, evidence: { candidates: 5 } });
    expect(await db.prisma.operationalAction.count()).toBe(2);
  });

  it("normaliza espaços da fonte tanto no fingerprint quanto na reconciliação", async () => {
    expect(operationalActionFingerprint(" training ", "case-1")).toBe(
      operationalActionFingerprint("training", "case-1"),
    );
    const row = await reportOperationalAction({ ...base, source: " training " });
    await expect(reconcileOperationalActionSource(" training ", [])).resolves.toBe(1);
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ status: OperationalActionStatus.RESOLVED });
  });

  it("reconcilia fonte maior que o prefixo de 80 caracteres da fingerprint", async () => {
    const longSource = `telegram-dm:${"fonte-longa-".repeat(8)}`;
    expect(longSource.length).toBeGreaterThan(80);
    const row = await reportOperationalAction({ ...base, source: longSource });
    expect(row.fingerprint.startsWith(`${longSource.slice(0, 80)}:`)).toBe(true);

    await expect(reconcileOperationalActionSource(longSource, [])).resolves.toBe(1);
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ status: OperationalActionStatus.RESOLVED });
  });

  it("registra quem mudou o estado — inclusive o encerramento automático", async () => {
    const acao = await reportOperationalAction(base);
    await acknowledgeOperationalAction(acao.id, "fabricio");
    await closeOperationalAction(acao.id, "fabricio", "RESOLVED", "Caso resolvido.");
    await reportOperationalAction({ ...base, key: "case-9", resourceId: "case-9" });
    await reconcileOperationalActionSource("training", []);

    const eventos = await db.prisma.auditEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(eventos.map((e) => e.action)).toEqual([
      "operational_action.acknowledged",
      "operational_action.resolved",
      "operational_action.auto_resolved",
    ]);
    expect(eventos.at(-1)).toMatchObject({ actor: "system", resource: "operational_action" });
  });
});

/**
 * Alerta do motor entra na MESMA caixa das ações, com
 * `area: "incidentes"`. O ciclo (dedupe → assumir → encerrar → reabrir) é o
 * mesmo testado acima; aqui fica só o que é específico do alerta.
 */
describe("incidentes na caixa única", () => {
  const incidente = {
    source: "consistency.bet-lucro",
    key: "bet-1",
    area: "incidentes",
    actionType: "incident.review",
    title: "Lucro divergente do status",
    description: "Gravado -1u, esperado +0.9u.",
    risk: OperationalRisk.CRITICAL,
    resource: "bet",
    resourceId: "bet-1",
    evidence: { gravado: -1, esperado: 0.9 },
  };

  it("auto-resolve quando a condição some, preservando evidência e auditoria", async () => {
    await reportOperationalAction(incidente, new Date("2026-07-12T12:00:00Z"));
    await reportOperationalAction({ ...incidente, key: "bet-2", resourceId: "bet-2" });

    await expect(reconcileOperationalActionSource(incidente.source, ["bet-1", "bet-2"]))
      .resolves.toBe(0);
    await expect(reconcileOperationalActionSource(
      incidente.source,
      [],
      new Date("2026-07-12T12:15:00Z"),
    )).resolves.toBe(2);

    const linhas = await db.prisma.operationalAction.findMany();
    expect(linhas.every((l) => l.status === OperationalActionStatus.RESOLVED)).toBe(true);
    expect(linhas[0]?.resolutionNote).toMatch(/normalizada/);
    expect(await db.prisma.auditEvent.count({
      where: { action: "operational_action.auto_resolved" },
    })).toBe(2);
  });

  it("quem exige decisão humana não é encerrado pela reconciliação", async () => {
    const aberto = await reportOperationalAction({
      source: "telegram.unmapped-channel",
      key: "-1004496161582",
      area: "incidentes",
      actionType: "incident.review",
      title: "Canal Telegram sem bankroll",
      description: "Configure o canal.",
      resource: "telegram-channel",
      resourceId: "-1004496161582",
      autoResolve: false,
    });
    expect(aberto.evidence).toMatchObject({ autoResolve: false });

    await expect(reconcileOperationalActionSource("telegram.unmapped-channel", []))
      .resolves.toBe(0);
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: aberto.id } }))
      .resolves.toMatchObject({ status: OperationalActionStatus.OPEN });
  });

  it("prova explícita encerra ação que a reconciliação recusou", async () => {
    const aberto = await reportOperationalAction({
      source: "incident.manual-review",
      key: "incident:manual-review",
      area: "incidentes",
      actionType: "incident.review",
      title: "Incidente exige revisão",
      description: "A condição não é auto-resolvida.",
      risk: OperationalRisk.CRITICAL,
      resource: "incident",
      resourceId: "incident:manual-review",
      autoResolve: false,
    });

    await expect(reconcileOperationalActionSource("incident.manual-review", [])).resolves.toBe(0);
    await expect(resolveOperationalActionBySourceKey(
      "incident.manual-review",
      "incident:manual-review",
      "Incidente revisado pelo operador.",
    )).resolves.toBe(true);
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: aberto.id } }))
      .resolves.toMatchObject({
        status: OperationalActionStatus.RESOLVED,
        resolutionNote: "Incidente revisado pelo operador.",
      });
    await expect(resolveOperationalActionBySourceKey(
      "incident.manual-review",
      "incident:manual-review",
      "já encerrada",
    )).resolves.toBe(false);
  });

  it("canal sem bankroll só encerra quando o vínculo ativo passa a existir", async () => {
    const channelId = BigInt("-1004496161582");
    const aberto = await reportOperationalAction({
      source: "telegram.unmapped-channel",
      key: String(channelId),
      area: "incidentes",
      actionType: "incident.review",
      title: "Canal Telegram sem bankroll",
      description: "Configure o canal.",
      resource: "telegram-channel",
      resourceId: String(channelId),
      autoResolve: false,
    });
    await expect(reconcileMappedTelegramChannelActions()).resolves.toBe(0);

    await db.prisma.bankroll.create({
      data: { nome: "Jorge Neves", slug: "jorge-neves", telegramChannelId: channelId },
    });
    await expect(reconcileMappedTelegramChannelActions(new Date("2026-07-15T16:00:00Z")))
      .resolves.toBe(1);

    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: aberto.id } }))
      .resolves.toMatchObject({
        status: OperationalActionStatus.RESOLVED,
        owner: "system",
        resolutionNote: "Canal vinculado a um tipster ativo.",
      });
  });

  it("uma ação que falha ao fechar não aborta as outras do lote", async () => {
    // Três canais mapeados; o do meio é sabotado apagando a ação entre o
    // findMany e o close, que é o que uma corrida real produz. Antes, o throw
    // do item derrubava o laço inteiro E o `resolverAcoesSemRecurso` que roda
    // depois no mesmo job (lei 7 — isolamento por item).
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const channelId = BigInt(`-100449616158${n}`);
      const acao = await reportOperationalAction({
        source: "telegram.unmapped-channel",
        key: String(channelId),
        area: "incidentes",
        actionType: "incident.review",
        title: `Canal ${n} sem bankroll`,
        description: "Configure o canal.",
        resource: "telegram-channel",
        resourceId: String(channelId),
        autoResolve: false,
      });
      ids.push(acao.id);
      await db.prisma.bankroll.create({
        data: { nome: `Canal ${n}`, slug: `canal-${n}`, telegramChannelId: channelId },
      });
    }
    await db.prisma.operationalAction.delete({ where: { id: ids[1]! } });

    const fechadas = await reconcileMappedTelegramChannelActions();

    expect(fechadas).toBe(2);
    for (const id of [ids[0]!, ids[2]!]) {
      await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id } }))
        .resolves.toMatchObject({ status: OperationalActionStatus.RESOLVED });
    }
  });

  it("varre além de 200 recursos vivos e encerra o órfão da cauda", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Banca viva", slug: "banca-viva" },
    });
    await db.prisma.operationalAction.createMany({
      data: Array.from({ length: 200 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        fingerprint: `gc-live:${index}`,
        area: "teste",
        actionType: "audit.review",
        title: `Recurso vivo ${index}`,
        description: "Não deve ser encerrado.",
        resource: "bankroll",
        resourceId: bankroll.id,
      })),
    });
    const alvo = await db.prisma.operationalAction.create({
      data: {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        fingerprint: "gc-orphan:tail",
        area: "teste",
        actionType: "audit.review",
        title: "Recurso órfão na cauda",
        description: "Precisa ser alcançado na mesma rodada.",
        resource: "bankroll",
        resourceId: "bankroll-que-nao-existe",
      },
    });

    await expect(resolverAcoesSemRecurso()).resolves.toBe(1);
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: alvo.id } }))
      .resolves.toMatchObject({ status: OperationalActionStatus.RESOLVED });
  });

  it("filtra fontes de settlement no SQL antes do teto e alcança a linha útil", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Banca settlement", slug: "banca-settlement" },
    });
    const baseBet = {
      sportResolutionStatus: "CONFIRMED" as const,
      sportResolvedAt: new Date(),
      bankrollId: bankroll.id,
      data: new Date("2026-08-01T16:00:00Z"),
      evento: "Time A vs Time B",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Time A",
      odds: 2,
      stake: 1,
    };
    const pendente = await db.prisma.bet.create({ data: baseBet });
    const liquidada = await db.prisma.bet.create({
      data: { ...baseBet, settledAt: new Date(), evento: "Time C vs Time D", status: "WON" },
    });
    await db.prisma.operationalAction.createMany({
      data: Array.from({ length: 200 }, (_, index) => ({
        id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
        fingerprint: `settlement.telegram-edit:${index}`,
        area: "settlement",
        actionType: "settlement.review",
        title: `Edição Telegram ${index}`,
        description: "Não pertence às fontes encerráveis por status.",
        resource: "bet",
        resourceId: pendente.id,
      })),
    });
    const alvo = await db.prisma.operationalAction.create({
      data: {
        id: "ffffffff-ffff-4fff-9fff-ffffffffffff",
        fingerprint: "settlement.score-unsupported:tail",
        area: "settlement",
        actionType: "settlement.review",
        title: "Liquidação já resolvida na cauda",
        description: "Precisa ser encerrada.",
        resource: "bet",
        resourceId: liquidada.id,
      },
    });

    await expect(resolverAcoesDeLiquidacaoResolvida()).resolves.toBe(1);
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: alvo.id } }))
      .resolves.toMatchObject({ status: OperationalActionStatus.RESOLVED });
    expect(await db.prisma.operationalAction.count({
      where: { fingerprint: { startsWith: "settlement.telegram-edit:" }, status: "OPEN" },
    })).toBe(200);
  });

  it("watchdog encerra automaticamente incidentes de ia-judge e da busca pós-jogo sem falhas recentes", async () => {
    const iaJudge = await db.prisma.operationalAction.create({
      data: {
        fingerprint: "settlement.ia-judge:cycle-failure",
        area: "incidentes",
        actionType: "incident.review",
        title: "Falhas no ciclo do IA-Judge",
        description: "Falha antiga",
        resource: "ia-judge",
      },
    });
    const revival = await db.prisma.operationalAction.create({
      data: {
        fingerprint: "sharp.bridge_postgame:batch-failure",
        area: "incidentes",
        actionType: "incident.review",
        title: "Falhas na busca pós-jogo na BridgeOdds",
        description: "Falha antiga",
        resource: "bridge-postgame",
      },
    });

    await reconcileOperationalActions(new Date());

    const iaJudgeAfter = await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: iaJudge.id } });
    const revivalAfter = await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: revival.id } });

    expect(iaJudgeAfter.status).toBe(OperationalActionStatus.RESOLVED);
    expect(revivalAfter.status).toBe(OperationalActionStatus.RESOLVED);
  });
});

/**
 * Ação encerrada que VOLTA não pode se disfarçar de ação nova: a reabertura
 * preserva `openedAt` (desde quando o problema existe), conta o retorno e grava
 * a transição com a nota de resolução que o update descarta.
 */
describe("reabertura preserva a história", () => {
  const NASCIMENTO = new Date("2026-07-13T13:00:00Z");
  const RETORNO = new Date("2026-08-17T05:00:00Z");

  async function abrir(quando: Date) {
    return db.prisma.operationalAction.create({
      data: {
        // Derivada, nunca literal: escrita à mão ela não casa com a que o
        // serviço procura, e o teste passaria a exercitar a CRIAÇÃO.
        fingerprint: operationalActionFingerprint("slo", "infra"),
        area: "incidentes",
        actionType: "incident.review",
        title: "Alerta de infraestrutura",
        description: "Recurso saturado.",
        openedAt: quando,
        lastSeenAt: quando,
        createdAt: quando,
      },
    });
  }

  async function encerrar(id: string, nota: string, quando: Date) {
    return db.prisma.operationalAction.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: quando, resolutionNote: nota },
    });
  }

  /**
   * A reabertura passa pelo mesmo caminho que a produção usa —
   * `reportOperationalAction`, não um update montado aqui.
   */
  it("a reabertura preserva a PRIMEIRA vez e conta o retorno", async () => {
    const nascida = await abrir(NASCIMENTO);
    await encerrar(nascida.id, "Condição normalizada.", new Date("2026-08-01T10:00:00Z"));

    const voltou = await reportOperationalAction({
      source: "slo",
      key: "infra",
      area: "incidentes",
      actionType: "incident.review",
      title: "Alerta de infraestrutura",
      description: "Recurso saturado.",
    }, RETORNO);

    expect(voltou.status).toBe("OPEN");
    expect(voltou.openedAt.toISOString(), "a idade do problema foi apagada")
      .toBe(NASCIMENTO.toISOString());
    expect(voltou.reopenedAt?.toISOString()).toBe(RETORNO.toISOString());
    expect(voltou.reopenCount).toBe(1);
  });

  it("cada retorno soma — três ciclos não viram um", async () => {
    const entrada = {
      source: "slo", key: "infra", area: "incidentes", actionType: "incident.review",
      title: "Alerta de infraestrutura", description: "Recurso saturado.",
    };
    const nascida = await abrir(NASCIMENTO);
    for (let ciclo = 1; ciclo <= 3; ciclo += 1) {
      await encerrar(nascida.id, `Ciclo ${ciclo}.`, new Date(`2026-08-0${ciclo}T10:00:00Z`));
      const voltou = await reportOperationalAction(entrada, new Date(`2026-08-0${ciclo}T12:00:00Z`));
      expect(voltou.reopenCount, `ciclo ${ciclo}`).toBe(ciclo);
      expect(voltou.openedAt.toISOString()).toBe(NASCIMENTO.toISOString());
    }
  });

  /** A transição que não deixava rastro. A nota descartada tinha de sobrar aqui. */
  it("o retorno vira evento, com a resolução que o update descarta", async () => {
    const nascida = await abrir(NASCIMENTO);
    await encerrar(nascida.id, "Condição normalizada na reconciliação automática.", new Date("2026-08-01T10:00:00Z"));

    const voltou = await reportOperationalAction({
      source: "slo", key: "infra", area: "incidentes", actionType: "incident.review",
      title: "Alerta de infraestrutura", description: "Recurso saturado.",
    }, RETORNO);

    // O update limpa a nota porque a resolução deixou de valer — ela não pode
    // sumir por isso.
    expect(voltou.resolutionNote).toBeNull();

    const evento = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "operational_action.reopened", resourceId: nascida.id },
    });
    expect(evento.details).toMatchObject({
      resolucaoAnterior: "Condição normalizada na reconciliação automática.",
      statusAnterior: "RESOLVED",
      vezesQueVoltou: 1,
      abertaDesde: NASCIMENTO.toISOString(),
    });
  });

  it("ocorrência em ação ABERTA não é retorno — nada de contar duas vezes", async () => {
    const entrada = {
      source: "slo", key: "infra", area: "incidentes", actionType: "incident.review",
      title: "Alerta de infraestrutura", description: "Recurso saturado.",
    };
    await abrir(NASCIMENTO);
    const denovo = await reportOperationalAction(entrada, RETORNO);

    expect(denovo.reopenCount).toBe(0);
    expect(denovo.reopenedAt).toBeNull();
    expect(denovo.occurrenceCount).toBe(2);
    expect(await db.prisma.auditEvent.count({
      where: { action: "operational_action.reopened" },
    })).toBe(0);
  });

  it("ação que nasce agora não nasce reincidente", async () => {
    const nova = await reportOperationalAction({
      source: "slo", key: "nova", area: "incidentes", actionType: "incident.review",
      title: "Nova", description: "detalhe",
    }, RETORNO);
    expect(nova.reopenCount).toBe(0);
    expect(nova.reopenedAt).toBeNull();
    expect(nova.openedAt.toISOString()).toBe(RETORNO.toISOString());
  });
});

async function seedRunning() {
  return db.prisma.operationalAction.create({
    data: {
      fingerprint: "running-contract:job-1",
      area: "incidentes",
      actionType: "incident.review",
      title: "Tratamento em execução",
      description: "O executor assumiu a ação, mas ainda não a encerrou.",
      status: OperationalActionStatus.RUNNING,
    },
  });
}

describe("contrato do estado RUNNING", () => {
  it("permanece ativo na caixa e pode ser encerrado", async () => {
    const row = await seedRunning();

    const painel = await getPainelOperationalActions();
    expect(painel.totais).toEqual({
      abertas: 0,
      assumidas: 1,
      encerradas: 0,
      acionaveis: 1,
    });
    expect(painel.acoes).toContainEqual(expect.objectContaining({
      id: row.id,
      status: OperationalActionStatus.ACKED,
    }));

    await expect(closeOperationalAction(row.id, "executor")).resolves.toMatchObject({
      status: OperationalActionStatus.RESOLVED,
    });
  });

  it("é encerrado pela reconciliação quando a condição normaliza", async () => {
    const row = await seedRunning();

    await expect(reconcileOperationalActionSource("running-contract", []))
      .resolves.toBe(1);
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ status: OperationalActionStatus.RESOLVED });
  });
});

describe("reportOperationalAction numa ação já aberta", () => {
  it("reportOperationalAction em ação aberta preserva resolvedAt null apenas quando reaberta", async () => {
    const action = await reportOperationalAction({
      source: "settlement.recheck",
      key: "bet-r6-test",
      area: "settlement",
      actionType: "recheck_pendente",
      title: "Recheck Pendente",
      description: "Aposta em recheck",
    });
    expect(action.status).toBe("OPEN");

    // Atualização subsequente com a mesma ação aberta
    const updated = await reportOperationalAction({
      source: "settlement.recheck",
      key: "bet-r6-test",
      area: "settlement",
      actionType: "recheck_pendente",
      title: "Recheck Pendente (refresh)",
      description: "Aposta em recheck refresh",
    });
    expect(updated.status).toBe("OPEN");
    expect(updated.occurrenceCount).toBe(2);
  });
});

describe("esporte não confirmado na caixa de ações", () => {
  it("o pendente chega 40 min antes do jogo; o conflito, logo depois da captura", async () => {
    const now = new Date("2026-09-24T18:00:00Z");
    const minutes = (m: number) => new Date(now.getTime() + m * 60_000);
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Canal", slug: "canal-esporte" } });
    const bet = (
      evento: string, sportResolutionStatus: "PENDING" | "CONFLICT", data: Date,
      over: { registradoEm?: Date; kickoffInferido?: boolean } = {},
    ) => db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data, registradoEm: over.registradoEm ?? minutes(-60), kickoffInferido: over.kickoffInferido ?? false,
      evento, esporte: "Unknown", mercado: "Moneyline", selecao: evento.split(" vs ")[0]!, odds: 1.9, stake: 1, sportResolutionStatus,
    } });
    await bet("Longe vs Rival", "PENDING", minutes(120));
    const perto = await bet("Perto vs Rival", "PENDING", minutes(30));
    const conflito = await bet("Conflito vs Rival", "CONFLICT", minutes(300));
    // Sem horário lido não há "antes do jogo": espera o fim da busca automática.
    await bet("Sem horario vs Rival", "PENDING", minutes(-60), { kickoffInferido: true });
    // Fim da busca (o Telegram avisa o dono): aparece mesmo com o jogo distante.
    const avisado = await bet("Avisado vs Rival", "PENDING", minutes(3 * 24 * 60), { registradoEm: minutes(-26 * 60) });

    await reconcileOperationalActions(now);

    const acoes = await db.prisma.operationalAction.findMany({ where: { actionType: "sport.resolve" }, select: { resourceId: true } });
    expect(acoes.map((acao) => acao.resourceId).sort()).toEqual([avisado.id, conflito.id, perto.id].sort());
  });
});
