import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { sendOperationalAlert, sendOperatorNotification } from "@/src/services/ops/alerts";
import { recordDeadLetterRetained } from "@/src/services/ops/dlq/repository";
import { createTestDb, type TestDb } from "../helpers/db";

const DATABASE_URL_SENTINEL =
  "postgresql://sentinel_user:sentinel_password@sentinel-db.internal:5432/sentinel_database";
const BEARER_SENTINEL = "Bearer sentinelBearerToken123456789";
const COOKIE_SENTINEL = "Cookie: automabaca_session=sentinelCookieSecret123456";
const TELEGRAM_SENTINEL =
  "https://api.telegram.org/bot123456:SentinelTelegramToken_123456789012345/sendMessage";

const MESSAGE = [
  `database=${DATABASE_URL_SENTINEL}`,
  `authorization=${BEARER_SENTINEL}`,
  COOKIE_SENTINEL,
  `telegram=${TELEGRAM_SENTINEL}`,
].join("\n");

const FORBIDDEN = [
  "sentinel_user",
  "sentinel_password",
  "sentinel-db.internal",
  "sentinel_database",
  "sentinelBearerToken123456789",
  "sentinelCookieSecret123456",
  "SentinelTelegramToken_123456789012345",
] as const;

let db: TestDb;
const originalToken = process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
const originalChatId = process.env.TELEGRAM_NOTIFICATION_CHAT_ID;
const originalMetricsInTest = process.env.OBSERVABILITY_METRICS_IN_TEST;

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

beforeAll(() => {
  process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_NOTIFICATION_CHAT_ID = "123";
  process.env.OBSERVABILITY_METRICS_IN_TEST = "true";
  resetEnvCacheForTests();
  db = createTestDb();
});

afterAll(async () => {
  restoreEnv("TELEGRAM_NOTIFICATION_BOT_TOKEN", originalToken);
  restoreEnv("TELEGRAM_NOTIFICATION_CHAT_ID", originalChatId);
  restoreEnv("OBSERVABILITY_METRICS_IN_TEST", originalMetricsInTest);
  resetEnvCacheForTests();
  await db.dispose();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.reset();
  vi.unstubAllGlobals();
});

function expectNoSentinel(serialized: string): void {
  for (const forbidden of FORBIDDEN) expect(serialized).not.toContain(forbidden);
}

describe("redaction de sinks operacionais", () => {
  it("não vaza segredos em Telegram, ação, AuditEvent, DLQ nem métricas", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendOperationalAlert(MESSAGE, {
      source: "security.sentinel",
      key: "all-sinks",
      title: `Sentinela ${BEARER_SENTINEL}`,
      resource: "security-test",
      evidence: {
        databaseUrl: DATABASE_URL_SENTINEL,
        nested: { cookie: COOKIE_SENTINEL },
      },
      autoResolve: false,
    })).resolves.toBe(true);
    await expect(sendOperatorNotification(`Rotina ${MESSAGE}`)).resolves.toBe(true);

    await recordOperationalMetric({
      kind: "provider",
      name: `probe ${DATABASE_URL_SENTINEL}`,
      outcome: "error",
      labels: {
        authorization: BEARER_SENTINEL,
        cookie: COOKIE_SENTINEL,
        telegram: TELEGRAM_SENTINEL,
      },
    });
    await recordDeadLetterRetained({
      queue: "security.sentinel",
      jobId: "sentinel-job",
      errorMessage: MESSAGE,
      classification: "terminal",
    });
    await db.prisma.$transaction((tx) => tx.auditEvent.create({
      data: {
        actor: "security-test",
        action: "security.sentinel_tx",
        resource: "security-test",
        details: {
          databaseUrl: DATABASE_URL_SENTINEL,
          authorization: BEARER_SENTINEL,
          cookie: COOKIE_SENTINEL,
          telegram: TELEGRAM_SENTINEL,
        },
      },
    }));

    const telegramBodies = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit | undefined;
      return String(init?.body ?? "");
    }).join("\n");
    expectNoSentinel(telegramBodies);
    expect(telegramBodies).toContain("[redacted]");

    const persisted = JSON.stringify({
      actions: await db.prisma.operationalAction.findMany(),
      audits: await db.prisma.auditEvent.findMany(),
      metrics: await db.prisma.operationalMetric.findMany(),
    }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    expectNoSentinel(persisted);
    expect(persisted).toContain("[redacted]");
  });

  it("título e evidência do alerta guardam a quebra de linha real, não \\n literal", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 })));
    await sendOperationalAlert("Recusas repetidas\n👉 Confira o post.", {
      source: "test.newlines",
      key: "caption",
      title: "Recusas repetidas",
      evidence: { caption: "Tipster: Target\nODD: 4.33" },
      autoResolve: false,
    });
    const acao = await db.prisma.operationalAction.findFirstOrThrow({ where: { title: "Recusas repetidas" } });
    expect(acao.description).toBe("Recusas repetidas\n👉 Confira o post.");
    expect(acao.evidence).toMatchObject({ caption: "Tipster: Target\nODD: 4.33" });
  });
});
