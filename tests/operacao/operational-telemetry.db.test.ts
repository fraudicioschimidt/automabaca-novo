import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Job, PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  checkOperationalSlos,
  getOperationalSlos,
  purgeOldOperationalMetrics,
} from "@/src/services/ops/slo/slo";
import { DAILY_METRIC, normalizeMetricName, recordOperationalMetric } from "@/src/infra/operational-metrics";
import { workObserved } from "@/src/services/ops/telemetry";
import { purgeOldAuditEvents } from "@/src/services/ops/audit-purge";
import { reportOperationalAction } from "@/src/services/ops/operational-actions";

let db: TestDb;
const previousMetricsFlag = process.env.OBSERVABILITY_METRICS_IN_TEST;

beforeAll(() => {
  process.env.OBSERVABILITY_METRICS_IN_TEST = "true";
  db = createTestDb();
});

afterAll(async () => {
  if (previousMetricsFlag === undefined) delete process.env.OBSERVABILITY_METRICS_IN_TEST;
  else process.env.OBSERVABILITY_METRICS_IN_TEST = previousMetricsFlag;
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
});

describe("telemetria operacional persistente", () => {
  it("não calcula disponibilidade de uma série que amostra somente falhas", async () => {
    await db.prisma.operationalMetric.createMany({ data: [
      ...Array.from({ length: 5 }, () => ({ kind: "http", name: "/api/poll", outcome: "error", labels: { sampling: "errors_only" } })),
      { kind: "http", name: "/api/full", outcome: "success", labels: {} },
    ] });
    const rows = await getOperationalSlos(1);
    expect(rows.map((row) => row.name)).toEqual(["/api/full"]);
    expect(await db.prisma.operationalMetric.count()).toBe(6);
  });
  it("normaliza cardinalidade e classifica SLO saudável", async () => {
    expect(normalizeMetricName("provider", "bridge/match/12345/prices/98")).toBe(
      "bridge/match/:id/prices/:id",
    );
    expect(
      normalizeMetricName("action", "bet/7cb45d36-78d5-4f4d-9b3c-d3f113853daa/settle"),
    ).toBe("bet/:id/settle");
    for (let i = 0; i < 5; i += 1) {
      await recordOperationalMetric({
        kind: "provider",
        name: `bridge/match/${100 + i}`,
        outcome: "success",
        durationMs: 120 + i,
        statusCode: 200,
      });
    }

    const rows = await getOperationalSlos(24);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "provider",
      name: "bridge/match/:id",
      samples: 5,
      errors: 0,
      successPct: 100,
      status: "healthy",
    });
  });

  it("conta a abertura do circuito como violação, mesmo com uma amostra só", async () => {
    await db.prisma.operationalMetric.create({
      data: {
        kind: "provider",
        name: "bridgeodds.breaker",
        outcome: "error",
        labels: { reason: "consecutive_failures", failures: 5, cooldownMs: 900_000 },
      },
    });

    const row = (await getOperationalSlos(1)).find(
      (item) => item.name === "bridgeodds.breaker",
    );
    // Uma amostra só, e ainda assim `breach`: a série mede abertura de circuito,
    // não taxa de sucesso — o piso de amostras do provider não se aplica.
    expect(row).toMatchObject({
      samples: 1,
      errors: 1,
      successPct: 0,
      status: "breach",
      reasons: ["circuito do provider abriu 1 vez na janela"],
    });
  });

  it("não degrada SLO com as amostras legadas de sonda concorrente", async () => {
    // Linhas legadas: a recusa não gera mais amostra, mas as antigas ficam
    // 30 dias na retenção e não podem virar violação.
    await db.prisma.operationalMetric.createMany({
      data: Array.from({ length: 5 }, () => ({
        kind: "provider",
        name: "bridgeodds.breaker",
        outcome: "expected_retry",
        labels: { reason: "probe_in_flight" },
      })),
    });

    await expect(getOperationalSlos(1)).resolves.toEqual([
      expect.objectContaining({
        name: "bridgeodds.breaker",
        retries: 5,
        status: "healthy",
        reasons: [],
      }),
    ]);
  });

  it("marca violação e remove métricas além da retenção", async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordOperationalMetric({
        kind: "action",
        name: "bet.settle",
        outcome: i === 0 ? "error" : "success",
        durationMs: 3_500,
      });
    }
    await db.prisma.operationalMetric.create({
      data: {
        kind: "action",
        name: "old.metric",
        outcome: "success",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    // A série diária é a linha de base de semanas atrás: fica fora do SLO e da purga.
    await db.prisma.operationalMetric.createMany({ data: [
      { ...DAILY_METRIC, name: "matching", occurredAt: new Date("2026-01-01T03:00:00Z"), labels: { day: "2026-01-01" } },
      { ...DAILY_METRIC, name: "matching", labels: { day: "2026-07-11" } },
    ] });

    const slos = await getOperationalSlos(24);
    const row = slos.find((item) => item.name === "bet.settle");
    expect(row?.status).toBe("breach");
    expect(row?.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining("sucesso"),
      expect.stringContaining("p95"),
    ]));
    expect(slos.map((item) => item.name)).not.toContain("matching");
    await expect(purgeOldOperationalMetrics(new Date("2026-07-12T00:00:00Z"))).resolves.toBe(1);
    expect(await db.prisma.operationalMetric.count({ where: { kind: DAILY_METRIC.kind } })).toBe(2);
  });

  it("aplica SLO de descoberta externa ao resolvedor de esporte", async () => {
    await db.prisma.operationalMetric.createMany({
      data: Array.from({ length: 5 }, () => ({
        kind: "action",
        name: "sport.resolve",
        outcome: "success",
        durationMs: 40_000,
      })),
    });

    const row = (await getOperationalSlos(24)).find(
      (item) => item.name === "sport.resolve",
    );
    expect(row).toMatchObject({ status: "healthy", p95DurationMs: 40_000 });
  });

  it("mantém retentativa isolada visível sem degradar o SLO", async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordOperationalMetric({
        kind: "queue",
        name: "sharp.enrich",
        outcome: "success",
        durationMs: 100,
      });
    }
    await recordOperationalMetric({
      kind: "queue",
      name: "sharp.enrich",
      outcome: "expected_retry",
      durationMs: 200,
      labels: { error: "PrePinnacleRetryError" },
    });

    const row = (await getOperationalSlos(24)).find((item) => item.name === "sharp.enrich");
    expect(row).toMatchObject({
      samples: 6,
      errors: 0,
      retries: 1,
      successPct: 100,
      status: "healthy",
    });
    await expect(db.prisma.operationalMetric.count({
      where: { name: "sharp.enrich", outcome: "expected_retry" },
    })).resolves.toBe(1);
  });

  it("marca tempestade de retentativas esperadas como violação", async () => {
    for (let i = 0; i < 6; i += 1) {
      await recordOperationalMetric({
        kind: "queue",
        name: "capture.sport_resolve",
        outcome: "expected_retry",
        durationMs: 100,
      });
    }
    const row = (await getOperationalSlos(24)).find(
      (item) => item.name === "capture.sport_resolve",
    );
    expect(row).toMatchObject({ retries: 6, retryPct: 100, status: "breach" });
    expect(row?.reasons).toEqual(expect.arrayContaining([expect.stringContaining("retentativas")]));
  });

  it("respeita as três janelas de retenção ao purgar auditoria em lotes", async () => {
    const old = new Date("2025-01-01T00:00:00Z");
    const recent = new Date("2026-07-10T00:00:00Z");
    await db.prisma.auditEvent.createMany({ data: [
      { action: "routine", createdAt: old },
      { action: "bet_lucro_drift", createdAt: old },
      { action: "conta.create", createdAt: old },
      { action: "routine", createdAt: recent },
    ] });
    await db.prisma.authDeviceSession.create({
      data: {
        username: "old-user",
        tokenHash: "old-token",
        deviceName: "Old device",
        userAgent: "test",
        ipHash: "old-ip",
        expiresAt: old,
      },
    });
    await db.prisma.telegramMediaAlbum.create({
      data: {
        mediaGroupId: "old-album",
        chatId: "1",
        status: "done",
        winnerMessageId: 1,
        winnerFileId: "file",
        messageIds: [1],
        postDate: old,
        expiresAt: old,
      },
    });
    await db.prisma.telegramDmDraft.create({
      data: {
        chatId: "1",
        messageId: 1,
        parsedBet: { evento: "A vs B" },
        postDate: old,
        expiresAt: old,
      },
    });
    await db.prisma.authDeviceSession.create({
      data: {
        username: "recent-user",
        tokenHash: "recent-token",
        deviceName: "Recent device",
        userAgent: "test",
        ipHash: "recent-ip",
        expiresAt: new Date("2026-08-19T00:00:00Z"),
      },
    });
    await db.prisma.telegramMediaAlbum.create({
      data: {
        mediaGroupId: "recent-album",
        chatId: "1",
        // "open": o domínio só escreve open/done (há CHECK no banco).
        status: "open",
        winnerMessageId: 2,
        winnerFileId: "recent-file",
        messageIds: [2],
        postDate: recent,
        expiresAt: new Date("2026-07-19T00:00:00Z"),
      },
    });
    await db.prisma.telegramDmDraft.create({
      data: {
        chatId: "1",
        messageId: 2,
        parsedBet: { evento: "C vs D" },
        postDate: recent,
        expiresAt: new Date("2026-07-19T00:00:00Z"),
      },
    });

    await expect(purgeOldAuditEvents(new Date("2026-07-18T00:00:00Z"))).resolves.toEqual({
      deletedNormal: 1,
      deletedCooldowns: 0,
      deletedCritical: 1,
      deletedFinancial: 1,
      deletedMarketAliasRemoval: 0,
      deletedSessions: 1,
      deletedAlbums: 1,
      deletedDmDrafts: 1,
      deletedCaptureEvidence: 0,
      deletedProviderCaches: 0,
      deletedProviderBudgets: 0,
    });
    await expect(db.prisma.auditEvent.findMany({ select: { action: true } })).resolves.toEqual([
      { action: "routine" },
    ]);
    await expect(db.prisma.authDeviceSession.count()).resolves.toBe(1);
    await expect(db.prisma.telegramMediaAlbum.count()).resolves.toBe(1);
    await expect(db.prisma.telegramDmDraft.count()).resolves.toBe(1);
  });

  it("purga cache de provider vencido, menos o snapshot que a identidade lê vencido", async () => {
    const now = new Date("2026-09-23T12:00:00Z");
    const diasAtras = (dias: number) => new Date(now.getTime() - dias * 86_400_000);
    const cache = (provider: string, key: string, fetchedAt: Date, expiresAt: Date) => ({
      provider, key, payload: {}, fetchedAt, expiresAt,
    });
    await db.prisma.providerCache.createMany({ data: [
      cache("pinnacle17", "odds:1:prematch:v2", diasAtras(2), diasAtras(1)),
      cache("llm:reading-cache:v1", "abc", diasAtras(1), diasAtras(1)),
      cache("bridgeodds", "search:x", diasAtras(1), new Date(now.getTime() + 60_000)),
      cache("bridgeodds", "match:v2:10:current", diasAtras(10), diasAtras(10)),
      cache("bridgeodds", "match:v2:11:current", diasAtras(31), diasAtras(31)),
    ] });
    await db.prisma.providerBudget.createMany({ data: [
      { provider: "bridgeodds", periodKey: "2026-06-01T10", spent: 3, updatedAt: diasAtras(100) },
      { provider: "pinnacle17", periodKey: "2026-09-22", spent: 7, updatedAt: diasAtras(1) },
    ] });

    const result = await purgeOldAuditEvents(now);

    expect(result).toMatchObject({ deletedProviderCaches: 3, deletedProviderBudgets: 1 });
    const restantes = await db.prisma.providerCache.findMany({ select: { key: true }, orderBy: { key: "asc" } });
    expect(restantes.map((row) => row.key)).toEqual(["match:v2:10:current", "search:x"]);
    expect(await db.prisma.providerBudget.count()).toBe(1);
  });

  it("workObserved repropaga a retentativa, mas persiste resultado neutro", async () => {
    class ExpectedRetry extends Error {}
    let worker: ((jobs: Job[]) => Promise<unknown>) | undefined;
    const boss = {
      work: async (
        _name: string,
        options: { notifyPollingIntervalSeconds?: number },
        handler: (jobs: Job[]) => Promise<unknown>,
      ) => {
        expect(options.notifyPollingIntervalSeconds).toBe(5);
        worker = handler;
      },
    } as unknown as PgBoss;
    const retry = new ExpectedRetry("aguardando provider");

    await workObserved(
      boss,
      "sharp.enrich",
      async () => { throw retry; },
      { isExpectedRetry: (error) => error instanceof ExpectedRetry },
    );
    expect(worker).toBeDefined();
    await expect(worker!([{
      id: "job-expected-retry",
      data: {},
      createdOn: new Date(),
    } as unknown as Job])).rejects.toBe(retry);

    await expect(db.prisma.operationalMetric.findFirstOrThrow({
      where: { name: "sharp.enrich" },
      select: { outcome: true },
    })).resolves.toEqual({ outcome: "expected_retry" });
    expect(await getOperationalSlos(24)).toEqual([
      expect.objectContaining({
        name: "sharp.enrich",
        samples: 1,
        retries: 1,
        status: "warning",
        reasons: ["amostra curta"],
      }),
    ]);
  });

  it("respeita o cooldown gravado para a mesma violação", async () => {
    await db.prisma.operationalMetric.createMany({
      data: Array.from({ length: 5 }, () => ({
        kind: "action",
        name: "bet.settle",
        outcome: "error",
        durationMs: 4_000,
      })),
    });
    await db.prisma.auditEvent.create({
      data: {
        actor: "system",
        action: "observability.slo_breach",
        resource: "action",
        resourceId: "bet.settle",
        outcome: "error",
        details: {},
      },
    });

    await expect(checkOperationalSlos()).resolves.toEqual({ checked: 1, breaches: 1 });
    await expect(db.prisma.auditEvent.count({
      where: { action: "observability.slo_breach", resourceId: "bet.settle" },
    })).resolves.toBe(1);
    await expect(db.prisma.operationalAction.findFirst({
      where: { fingerprint: { startsWith: "slo:" } },
    })).resolves.toMatchObject({ status: "OPEN", occurrenceCount: 1 });
  });

  it("transporte de IA violado fica no painel; a cascata inteira sem leitura alerta", async () => {
    const stale = await reportOperationalAction({
      source: "slo", key: "provider:llm.transport.gemini.generate", area: "incidentes",
      actionType: "incident.review", title: "SLO violado em llm.transport.gemini.generate", description: "503 do Gemini",
    });
    await db.prisma.operationalMetric.createMany({ data: [
      ...Array.from({ length: 10 }, () => ({ kind: "provider", name: "llm.transport.gemini.generate", outcome: "error", durationMs: 500 })),
      ...Array.from({ length: 10 }, () => ({ kind: "provider", name: "llm.cascade", outcome: "success", durationMs: 8_000 })),
    ] });
    // O painel continua mostrando a violação do transporte, marcada como série que não alerta.
    const janela = await getOperationalSlos(1);
    expect(janela.find((row) => row.name === "llm.transport.gemini.generate")).toMatchObject({ status: "breach", alerting: false });
    expect(janela.find((row) => row.name === "llm.cascade")).toMatchObject({ alerting: true });
    await expect(checkOperationalSlos()).resolves.toEqual({ checked: 2, breaches: 0 });
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: stale.id } }))
      .resolves.toMatchObject({ status: "RESOLVED" });

    await db.prisma.operationalMetric.createMany({ data: Array.from({ length: 10 }, () => (
      { kind: "provider", name: "llm.cascade", outcome: "error", durationMs: 30_000 })) });
    await expect(checkOperationalSlos()).resolves.toEqual({ checked: 2, breaches: 1 });
    await expect(db.prisma.operationalAction.findFirst({ where: { title: "SLO violado em llm.cascade" } }))
      .resolves.toMatchObject({ status: "OPEN" });
  });

  it("não resolve alerta de SLO enquanto a amostra está curta", async () => {
    const incident = await reportOperationalAction({
      source: "slo",
      key: "action:bet.settle",
      area: "incidentes",
      actionType: "incident.review",
      title: "SLO violado em bet.settle",
      description: "Violação anterior ainda sem amostra suficiente para confirmar recuperação.",
    });
    await db.prisma.operationalMetric.createMany({
      data: Array.from({ length: 4 }, () => ({
        kind: "action",
        name: "bet.settle",
        outcome: "success",
        durationMs: 100,
      })),
    });

    await expect(checkOperationalSlos()).resolves.toEqual({ checked: 1, breaches: 0 });
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: incident.id } }))
      .resolves.toMatchObject({ status: "OPEN" });
  });

  it("série violada que some da janela não conta como recuperada", async () => {
    const abrir = (kind: string, name: string) => reportOperationalAction({
      source: "slo", key: `${kind}:${name}`, area: "incidentes", actionType: "incident.review",
      title: `SLO violado em ${name}`, description: "violação anterior", resource: kind, resourceId: name,
    });
    const horasAtras = (horas: number) => new Date(Date.now() - horas * 3_600_000);
    const calada = await abrir("queue", "closing.sync");
    const esquecida = await abrir("queue", "fila.que.saiu");
    const circuito = await abrir("provider", "flashscore.breaker");
    const recuperada = await abrir("queue", "sharp.revive");
    await db.prisma.operationalMetric.createMany({ data: [
      { kind: "queue", name: "closing.sync", outcome: "error", occurredAt: horasAtras(2) },
      { kind: "queue", name: "fila.que.saiu", outcome: "error", occurredAt: horasAtras(30) },
      { kind: "provider", name: "flashscore.breaker", outcome: "error", occurredAt: horasAtras(2) },
      ...Array.from({ length: 5 }, () => ({ kind: "queue", name: "sharp.revive", outcome: "success", durationMs: 100 })),
    ] });

    await checkOperationalSlos();

    const status = async (id: string) => db.prisma.operationalAction.findUniqueOrThrow({ where: { id } });
    expect(await status(calada.id)).toMatchObject({ status: "OPEN" });
    expect(await status(esquecida.id)).toMatchObject({
      status: "RESOLVED",
      resolutionNote: "A série parou de mandar amostras há mais de 24 h: encerrada sem prova de recuperação.",
    });
    // A série do circuito só grava abertura: sem abertura na janela, está saudável.
    expect(await status(circuito.id)).toMatchObject({ status: "RESOLVED" });
    expect(await status(recuperada.id)).toMatchObject({ status: "RESOLVED" });
  });
});
