import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { createTestDb, type TestDb } from "../helpers/db";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/src/infra/observability-status", () => ({ readLogArchiveHealth: mocks.read }));
import { checkLogArchiveHealth } from "@/src/services/ops/log-archive-health";
let db: TestDb;
const original = {
  statusDir: process.env.OBSERVABILITY_STATUS_DIR,
  token: process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN,
  chatId: process.env.TELEGRAM_NOTIFICATION_CHAT_ID,
};
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
beforeAll(async () => {
  db = createTestDb();
  process.env.OBSERVABILITY_STATUS_DIR = "/test-status";
  process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_NOTIFICATION_CHAT_ID = "123";
  resetEnvCacheForTests();
});
beforeEach(async () => { await db.reset(); });
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => {
  restore("OBSERVABILITY_STATUS_DIR", original.statusDir);
  restore("TELEGRAM_NOTIFICATION_BOT_TOKEN", original.token);
  restore("TELEGRAM_NOTIFICATION_CHAT_ID", original.chatId);
  resetEnvCacheForTests();
  await db.dispose();
});

const healthyLogs = { collection: "fresh", export: "fresh", offsite: "fresh" };

it("opens one actionable alert, keeps repeated checks quiet and resolves recovery", async () => {
  mocks.read.mockResolvedValue({ ok: false, collection: "degraded", export: "fresh", offsite: "fresh", reasons: ["collection_stale"], backup: null });
  await checkLogArchiveHealth();
  await checkLogArchiveHealth();
  const actions = await db.prisma.operationalAction.findMany();
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ title: "Coleta de logs atrasada", occurrenceCount: 1 });
  mocks.read.mockResolvedValue({ ok: true, collection: "fresh", export: "fresh", offsite: "fresh", reasons: [], backup: null });
  await checkLogArchiveHealth();
  expect(await db.prisma.operationalAction.findFirst()).toMatchObject({ status: "RESOLVED" });
  expect(await db.prisma.bet.count()).toBe(0);
});

it("a falha de uma noite fica na caixa de ações; o backup atrasado avisa no Telegram uma vez", async () => {
  const telegram = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", telegram);
  const createdAt = "2026-09-23T04:21:00Z";
  const failedAt = "2026-09-24T04:19:00Z";

  mocks.read.mockResolvedValue({ ok: false, ...healthyLogs, reasons: ["backup_failed"],
    backup: { state: "failed", createdAt, failedAt, bets: null } });
  await checkLogArchiveHealth();
  const failed = await db.prisma.operationalAction.findMany();
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({
    title: "Backup diário do banco falhou", status: "OPEN", risk: "HIGH",
    description: expect.stringContaining("falhou às 24/09 01:19. O último backup conferido é de 23/09 01:21."),
  });
  expect(telegram).not.toHaveBeenCalled();

  // As tentativas da noite acabaram e o último conferido passou das 26 h.
  mocks.read.mockResolvedValue({ ok: false, ...healthyLogs, reasons: ["backup_failed", "backup_stale"],
    backup: { state: "stale", createdAt, failedAt, bets: null } });
  await checkLogArchiveHealth();
  await checkLogArchiveHealth();
  expect(telegram).toHaveBeenCalledTimes(1);
  const [, request] = telegram.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(request.body)).text).toContain("Backup diário do banco atrasado\nO último backup conferido é de 23/09 01:21.");
  const stale = await db.prisma.operationalAction.findFirst({ where: { title: "Backup diário do banco atrasado" } });
  expect(stale).toMatchObject({ status: "OPEN", risk: "HIGH" });

  mocks.read.mockResolvedValue({ ok: true, ...healthyLogs, reasons: [],
    backup: { state: "fresh", createdAt: "2026-09-25T04:20:00Z", failedAt: null, bets: 1234 } });
  await checkLogArchiveHealth();
  expect(await db.prisma.operationalAction.count({ where: { status: "RESOLVED" } })).toBe(2);
  expect(telegram).toHaveBeenCalledTimes(1);
});

it("a cópia do backup no computador que parou avisa no Telegram uma vez e fecha com o comprovante", async () => {
  const telegram = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", telegram);
  const backup = { state: "fresh", createdAt: "2026-10-04T04:21:00Z", failedAt: null, bets: 1234 };

  mocks.read.mockResolvedValue({ ok: false, ...healthyLogs, reasons: ["backup_offsite_stale"],
    backup: { ...backup, offsiteAt: "2026-10-02T06:30:00Z" } });
  await checkLogArchiveHealth();
  await checkLogArchiveHealth();
  expect(telegram).toHaveBeenCalledTimes(1);
  const [, request] = telegram.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(request.body)).text)
    .toContain("Cópia do backup no computador atrasada\nO último comprovante chegou em 02/10 03:30.");
  expect(await db.prisma.operationalAction.findMany()).toMatchObject([
    { title: "Cópia do backup no computador atrasada", status: "OPEN", risk: "HIGH" },
  ]);

  mocks.read.mockResolvedValue({ ok: true, ...healthyLogs, reasons: [], backup: { ...backup, offsiteAt: "2026-10-04T06:30:00Z" } });
  await checkLogArchiveHealth();
  expect(await db.prisma.operationalAction.findFirst()).toMatchObject({ status: "RESOLVED" });
  expect(telegram).toHaveBeenCalledTimes(1);
});
