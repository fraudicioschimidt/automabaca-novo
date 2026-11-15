import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import type { PoolClient } from "pg";
import { pgPool } from "@/src/infra/prisma";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
const previous = process.env.OBSERVABILITY_METRICS_IN_TEST;
beforeAll(() => { db = createTestDb(); process.env.OBSERVABILITY_METRICS_IN_TEST = "true"; });
beforeEach(async () => { await db.reset(); });
afterAll(async () => {
  if (previous === undefined) delete process.env.OBSERVABILITY_METRICS_IN_TEST;
  else process.env.OBSERVABILITY_METRICS_IN_TEST = previous;
  await db.dispose();
});

it("cancela INSERT bloqueado sem deixar escrita órfã e retoma após desbloqueio", async () => {
  const lock = await pgPool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE operational_metrics IN ACCESS EXCLUSIVE MODE");
    const started = performance.now();
    await expect(recordOperationalMetric({ kind: "action", name: "budget.blocked", outcome: "success" })).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1500);
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  expect(await db.prisma.operationalMetric.count()).toBe(0);
  await recordOperationalMetric({ kind: "action", name: "budget.recovered", outcome: "success" });
  expect(await db.prisma.operationalMetric.count()).toBe(1);
});

it("grava a métrica mesmo com o pool de negócio esgotado, sem tomar conexão dele", async () => {
  const clients: PoolClient[] = [];
  for (let i = 0; i < (pgPool.options.max ?? 10); i += 1) clients.push(await pgPool.connect());
  const release = () => { for (const client of clients.splice(0)) client.release(); };
  const backstop = setTimeout(release, 2000);
  try {
    // A telemetria tem pool próprio: o pool de negócio cheio não a atrasa nem a perde.
    const started = performance.now();
    await recordOperationalMetric({ kind: "action", name: "budget.pool", outcome: "success" });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(clients).toHaveLength(pgPool.options.max ?? 10);
  } finally {
    clearTimeout(backstop);
    release();
  }
  expect(await db.prisma.operationalMetric.count({ where: { name: "budget.pool" } })).toBe(1);
});
