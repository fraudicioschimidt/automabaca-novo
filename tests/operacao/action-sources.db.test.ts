import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { reportOperationalActions } from "@/src/services/ops/operational-actions";
import { reconcileOperationalActions, reconcileWatchdogActions } from "@/src/services/ops/action-sources";
import { sendPendingDigest } from "@/src/services/ops/digests/pending-digest";
import { OperationalRisk } from "@/src/generated/prisma/client";
import { listDeadLetters } from "@/src/services/ops/dlq/replay";

const notifySpy = vi.fn(async (_message: string) => true);

vi.mock("@/src/services/ops/dlq/replay", () => ({
  listDeadLetters: vi.fn(async () => []),
}));
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperationalAlert: (message: string) => notifySpy(message),
  sendOperatorNotification: (message: string) => notifySpy(message),
  sendRequiredOperatorNotification: async (message: string) => {
    await notifySpy(message);
    return "delivered" as const;
  },
}));

let db: TestDb;
beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  notifySpy.mockClear();
});

describe("ação de dead-letter", () => {
  const row = { fila: "telegram.updates", data: {}, criadoEm: new Date("2026-09-20T12:00:00Z"), erro: "A aposta possui kickoff provisório." };
  it("falha de captura aponta banca e post; recusa de negócio não compete com falha do sistema", async () => {
    vi.mocked(listDeadLetters).mockResolvedValueOnce([
      { ...row, id: "job-negocio", classe: "business", waitsFor: null, post: {
        bankroll: "Tipster Alfa", channelId: "-1001234567890", messageId: 42, mediaGroupId: null, excerpt: "Flamengo x Vasco Over 2.5",
      } },
      { ...row, id: "job-sistema", fila: "sharp.enrich", erro: "boom", classe: "other", waitsFor: null, post: null },
      { ...row, id: "job-espera", classe: "business", waitsFor: "o evento começar", erro: "Este evento é futuro.", post: {
        bankroll: "Tipster Alfa", channelId: "-1001234567890", messageId: 43, mediaGroupId: null, excerpt: null,
      } },
    ]);
    await reconcileOperationalActions();
    const acoes = await db.prisma.operationalAction.findMany({ where: { actionType: "dlq.replay" }, orderBy: [{ priority: "asc" }, { resourceId: "asc" }] });
    expect(acoes.map((acao) => [acao.resourceId, acao.priority, acao.risk])).toEqual([
      ["job-espera", 60, OperationalRisk.MEDIUM], ["job-negocio", 60, OperationalRisk.MEDIUM], ["job-sistema", 80, OperationalRisk.HIGH],
    ]);
    // Recusa que o tempo resolve diz quando reprocessar, sem mandar corrigir dado.
    const espera = acoes[0]!;
    expect(espera.description).toContain("isso se resolve quando o evento começar");
    expect(espera.description).toContain("👉 Quando o evento começar, reprocesse em Monitoramento para o post entrar");
    expect(espera.description).not.toContain("falha de novo enquanto o dado não mudar");
    expect(espera.evidence).toMatchObject({ aguarda: "o evento começar" });
    const negocio = acoes[1]!;
    expect(negocio.title).toBe("Post não processado · Tipster Alfa · mensagem 42");
    expect(negocio.description).toContain("Tipster Tipster Alfa · mensagem 42 do canal -1001234567890 (https://t.me/c/1234567890/42)");
    expect(negocio.description).toContain("“Flamengo x Vasco Over 2.5”");
    expect(negocio.description).toContain("👉 Se o post era aposta, registre-a à mão");
    expect(negocio.evidence).toMatchObject({ tipster: "Tipster Alfa", messageId: 42, classe: "business" });
    expect(negocio.description).toContain("o replay falha de novo enquanto o dado não mudar");
    expect(acoes[2]?.title).toBe("Revisar falha em sharp.enrich");
  });
});

describe("ação de dead-letter cujo job saiu da fila", () => {
  const base = { fila: "sharp.enrich", data: {}, criadoEm: new Date("2026-09-20T12:00:00Z"), erro: "boom", classe: "other", waitsFor: null, post: null };

  it("fecha dizendo por que saiu, e sem rastro diz que expirou sem decisão", async () => {
    vi.mocked(listDeadLetters).mockResolvedValueOnce(
      ["job-reprocessado", "job-no-meio-do-replay", "job-descartado", "job-tique", "job-expirado", "job-vivo"]
        .map((id) => ({ ...base, id })),
    );
    await reconcileOperationalActions();
    await db.prisma.auditEvent.createMany({ data: [
      { actor: "fabricio", action: "dlq_replay", resource: "pgboss_job", resourceId: "job-reprocessado", outcome: "success" },
      // Job já apagado pelo replay, sucesso ainda não marcado.
      { actor: "fabricio", action: "dlq_replay", resource: "pgboss_job", resourceId: "job-no-meio-do-replay", outcome: "pending" },
      { actor: "system", action: "job.dlq_discarded", resource: "sharp.enrich", resourceId: "job-descartado" },
      { actor: "system", action: "job.dlq_tick_discarded", resource: "closing.sync", resourceId: "job-tique" },
    ] });

    vi.mocked(listDeadLetters).mockResolvedValueOnce([{ ...base, id: "job-vivo" }]);
    await reconcileOperationalActions();

    const acoes = await db.prisma.operationalAction.findMany({ where: { actionType: "dlq.replay" } });
    const nota = Object.fromEntries(acoes.map((acao) => [acao.resourceId, [acao.status, acao.resolutionNote]]));
    expect(nota["job-reprocessado"]).toEqual(["RESOLVED", "Reprocessada: a tarefa voltou para a fila de origem."]);
    expect(nota["job-no-meio-do-replay"]).toEqual(["RESOLVED", "Reprocessada: a tarefa voltou para a fila de origem."]);
    expect(nota["job-descartado"]).toEqual(["RESOLVED", "Descartada: a aposta da tarefa foi removida."]);
    expect(nota["job-tique"]?.[1]).toMatch(/^Descartada: era um disparo de tarefa agendada/);
    expect(nota["job-expirado"]?.[0]).toBe("RESOLVED");
    expect(nota["job-expirado"]?.[1]).toMatch(/^Saiu da fila sem decisão: a falha expirou/);
    expect(nota["job-vivo"]).toEqual(["OPEN", null]);
  });
});

describe("reconcileWatchdogActions (Postgres real)", () => {
  it("preserva ações com autoResolve: false mesmo sem falhas recentes nas 24h", async () => {
    const actions = await reportOperationalActions([
      {
        source: "settlement.ia-judge",
        key: "cycle-failure",
        area: "settlement",
        actionType: "ia_judge.cycle_failure",
        title: "Falha de IA Judge",
        description: "Falha que exige revisão humana",
        risk: OperationalRisk.CRITICAL,
        autoResolve: false,
        evidence: { autoResolve: false },
      },
    ]);

    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action?.status).toBe("OPEN");

    await reconcileWatchdogActions();

    const check = await db.prisma.operationalAction.findUniqueOrThrow({
      where: { id: action?.id },
    });
    expect(check.status).toBe("OPEN");
    expect(check.resolvedAt).toBeNull();
  });

  it("auto-resolve ações com autoResolve != false quando não há falhas recentes", async () => {
    const actions = await reportOperationalActions([
      {
        source: "settlement.ia-judge",
        key: "cycle-failure",
        area: "settlement",
        actionType: "ia_judge.cycle_failure",
        title: "Falha de IA Judge",
        description: "Falha transitória",
        risk: OperationalRisk.MEDIUM,
        autoResolve: true,
        evidence: { autoResolve: true },
      },
    ]);

    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action?.status).toBe("OPEN");

    await reconcileWatchdogActions();

    const check = await db.prisma.operationalAction.findUniqueOrThrow({
      where: { id: action?.id },
    });
    expect(check.status).toBe("RESOLVED");
    expect(check.resolvedAt).not.toBeNull();
  });

  it("preserva ações da busca pós-jogo com autoResolve: false", async () => {
    const actions = await reportOperationalActions([
      {
        source: "sharp.bridge_postgame",
        key: "batch-failure",
        area: "sharp",
        actionType: "bridge_postgame.failure",
        title: "Falha na busca pós-jogo",
        description: "Exige auditoria",
        risk: OperationalRisk.CRITICAL,
        autoResolve: false,
        evidence: { autoResolve: false },
      },
    ]);

    expect(actions).toHaveLength(1);
    const action = actions[0];

    await reconcileWatchdogActions();

    const check = await db.prisma.operationalAction.findUniqueOrThrow({
      where: { id: action?.id },
    });
    expect(check.status).toBe("OPEN");
  });

  it("não resolve ações se houver falha de ciclo recente nas últimas 24h", async () => {
    const now = new Date();
    await db.prisma.auditEvent.create({
      data: {
        action: "ia_judge.cycle_failure",
        resource: "system",
        resourceId: "ia_judge",
        createdAt: new Date(now.getTime() - 10 * 60_000), // 10 min atrás
      },
    });

    const actions = await reportOperationalActions([
      {
        source: "settlement.ia-judge",
        key: "cycle-failure",
        area: "settlement",
        actionType: "ia_judge.cycle_failure",
        title: "Falha de IA Judge",
        description: "Falha transitória",
        risk: OperationalRisk.MEDIUM,
        autoResolve: true,
        evidence: { autoResolve: true },
      },
    ]);

    expect(actions).toHaveLength(1);
    const action = actions[0];

    await reconcileWatchdogActions(now);

    const check = await db.prisma.operationalAction.findUniqueOrThrow({
      where: { id: action?.id },
    });
    expect(check.status).toBe("OPEN");
  });
});

const NOW = new Date("2026-08-13T15:00:00Z");
async function createPostponed(
  hoursAfterKickoff: number,
  suffix: string,
  snapshot: object = { outcome: "matched", settlementOutcome: "postponed_waiting" },
): Promise<string> {
  const bankroll = await db.prisma.bankroll.upsert({
    where: { slug: "postponed-ops" },
    update: {},
    create: { nome: "Adiadas", slug: "postponed-ops" },
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      data: new Date(NOW.getTime() - hoursAfterKickoff * 3_600_000),
      evento: `Casa ${suffix} vs Fora`,
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: `Casa ${suffix}`,
      odds: 2,
      stake: 1,
      status: "PENDING",
      result: {
        create: {
          resultProvider: "flashscore",
          resultCheckedAt: new Date(NOW.getTime() - 60_000),
          resultSnapshot: snapshot,
        },
      },
    },
  });
  return bet.id;
}

describe("grace operacional de partida adiada", () => {
  it("abre ticket depois das 48h, mas não durante a espera deliberada", async () => {
    const emGraca = await createPostponed(30, "30h");
    const expirada = await createPostponed(60, "60h");

    await expect(reconcileOperationalActions(NOW)).resolves.toMatchObject({
      settlementParado: 1,
    });
    const actions = await db.prisma.operationalAction.findMany({
      where: { fingerprint: { startsWith: "settlement.parado:" } },
      select: { resourceId: true },
    });
    expect(actions).toEqual([{ resourceId: expirada }]);
    expect(actions).not.toContainEqual({ resourceId: emGraca });
  });

  it("inclui a adiada expirada no digest e oculta somente a que ainda está na graça", async () => {
    await createPostponed(30, "30h");
    await createPostponed(60, "60h");

    await expect(sendPendingDigest(NOW)).resolves.toEqual({ pendentes: 1 });
    const message = String(notifySpy.mock.calls.at(-1)?.[0]);
    expect(message).toContain("Casa 60h vs Fora");
    expect(message).not.toContain("Casa 30h vs Fora");
  });

  it("a exclusão não esconde a aposta recente cujo snapshot não tem settlementOutcome", async () => {
    await createPostponed(30, "sem-chave", { outcome: "no_candidate" });

    await expect(sendPendingDigest(NOW)).resolves.toEqual({ pendentes: 1 });
    await expect(reconcileOperationalActions(NOW)).resolves.toMatchObject({ settlementParado: 1 });
  });
});
