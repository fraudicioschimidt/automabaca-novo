import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import type { ClosingPriceWatch } from "@/src/generated/prisma/client";
import { getEnv } from "@/src/infra/env";
import { QUEUES } from "@/src/infra/queue-contract";
import { enqueueClosingWatch } from "@/src/services/sharp/closing/series";
import { createTestDb, type TestDb } from "../helpers/db";
let db: TestDb, boss: PgBoss;
const options = () => ({ connectionString: getEnv().DATABASE_URL, schema: "c18_queue_contract", schedule: false, supervise: false });
beforeAll(async () => {
  db = createTestDb(); boss = new PgBoss(options()); await boss.start();
  await boss.createQueue(QUEUES.closingSeries, { policy: "exclusive", retryLimit: 0 });
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS c18_queue_contract CASCADE");
  await db.dispose();
});
function watch(kickoff: Date): ClosingPriceWatch {
  const now = new Date();
  return { id: crypto.randomUUID(), betId: "synthetic", contextHash: "a".repeat(64), eventId: "123",
    kickoff, createdAt: new Date(now.getTime() - 60_000), nextAttemptAt: new Date(now.getTime() - 1000),
    leaseUntil: null, leaseToken: null, lastPhysicalAt: null, attempts: 0, completedAt: null };
}
describe("série de fechamento com PgBoss e PostgreSQL reais", () => {
  it("deduplica o mesmo ponto e preserva agenda e prioridade após reinício do cliente", async () => {
    const now = new Date(), recovery = watch(new Date(now.getTime() - 10_000)), imminent = watch(new Date(now.getTime() + 60_000));
    await enqueueClosingWatch(recovery, boss, now);
    await enqueueClosingWatch(imminent, boss, now); await enqueueClosingWatch(imminent, boss, now);
    await boss.stop({ graceful: false }); boss = new PgBoss(options()); await boss.start();
    const first = await boss.fetch<{ watchId: string }>(QUEUES.closingSeries);
    expect(first).toHaveLength(1); expect(first[0]?.data.watchId).toBe(imminent.id);
    await boss.complete(QUEUES.closingSeries, first[0]!.id);
    const second = await boss.fetch<{ watchId: string }>(QUEUES.closingSeries);
    expect(second).toHaveLength(1); expect(second[0]?.data.watchId).toBe(recovery.id);
    await boss.complete(QUEUES.closingSeries, second[0]!.id);
    expect(await boss.fetch(QUEUES.closingSeries)).toHaveLength(0);
  });
  it("uma lease vigente impede execução antecipada mesmo com ponto vencido", async () => {
    const now = new Date(), row = watch(new Date(now.getTime() + 60_000)); row.leaseUntil = new Date(now.getTime() + 30_000);
    await enqueueClosingWatch(row, boss, now);
    expect(await boss.fetch(QUEUES.closingSeries)).toHaveLength(0);
  });
});
