import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { checkOperationalSlos } from "@/src/services/ops/slo/slo";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@/src/services/ops/alerts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/services/ops/alerts")>();
  return { ...actual, sendOperationalAlert: vi.fn(async (...args: Parameters<typeof actual.sendOperationalAlert>) => {
    await actual.persistOperationalAlert(...args);
    return true;
  }) };
});

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
beforeEach(async () => { await db.reset(); vi.mocked(sendOperationalAlert).mockClear(); });
afterAll(async () => { await db.dispose(); });

it("recusa de envio não inicia o silêncio do SLO; entrega confirmada inicia", async () => {
  await db.prisma.operationalMetric.createMany({ data: Array.from({ length: 10 }, () => ({
    kind: "queue", name: "closing.sync", outcome: "error", durationMs: 100,
  })) });
  vi.mocked(sendOperationalAlert).mockImplementationOnce(async (message, context) => {
    const { persistOperationalAlert } = await import("@/src/services/ops/alerts");
    await persistOperationalAlert(message, context);
    return false;
  });
  await expect(checkOperationalSlos()).resolves.toMatchObject({ breaches: 1 });
  expect(await db.prisma.operationalAction.count({ where: { status: "OPEN", resource: "queue", resourceId: "closing.sync" } })).toBe(1);
  expect(await db.prisma.auditEvent.count({ where: { action: "observability.slo_breach" } })).toBe(0);
  await checkOperationalSlos();
  await checkOperationalSlos();
  expect(sendOperationalAlert).toHaveBeenCalledTimes(2);
  expect(await db.prisma.auditEvent.count({ where: { action: "observability.slo_breach" } })).toBe(1);
});
