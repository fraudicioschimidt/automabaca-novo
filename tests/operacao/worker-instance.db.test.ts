import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { beginWorkerInstance, currentWorkerHealthy, readWorkerInstance } from "@/src/infra/worker-instance";
import { startWorkerHeartbeat } from "@/src/jobs/worker-heartbeat";
import { disconnectPrisma } from "@/src/infra/prisma";

vi.mock("@/src/services/ops/alerts", () => ({ autoResolveStaleOperationalAlerts: vi.fn(), sendOperationalAlert: vi.fn() }));
let pool: Pool; let boss: PgBoss; let directory: string; let file: string;
const name = "health.heartbeat";
const query = (sql: string, values: unknown[]) => pool.query(sql, values);
beforeAll(() => { pool = new Pool({ connectionString: process.env.DATABASE_URL }); });
afterAll(async () => { await pool.end(); await disconnectPrisma(); });
beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "automabaca-c57-health-db-")); file = path.join(directory, "marker.json");
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schedule: false, supervise: false });
  await boss.start(); await boss.createQueue(name);
  await pool.query("DELETE FROM pgboss.job WHERE name = $1", [name]);
});
afterEach(async () => { await boss.stop({ graceful: false }); safeRemoveTreeSync(tmpdir(), directory); });
async function completed(output: object | null, data: object | null = null) {
  const id = await boss.send(name, data); if (!id) throw new Error("sem job");
  await boss.fetch(name);
  await boss.complete(name, id, output);
  return id;
}

it("heartbeat legado recente não libera o processo novo, nem depois de marcar pronto", async () => {
  await completed(null);
  const instance = beginWorkerInstance(file);
  expect(await currentWorkerHealthy(query, file)).toBe(false);
  instance.ready(); expect(await currentWorkerHealthy(query, file)).toBe(false);
});

it("prova da execução anterior não libera a atual", async () => {
  const old = beginWorkerInstance(file); old.ready(); await completed(old.proof());
  expect(await currentWorkerHealthy(query, file)).toBe(true);
  const current = beginWorkerInstance(file); current.ready();
  expect(await currentWorkerHealthy(query, file)).toBe(false);
  await completed(current.proof()); expect(await currentWorkerHealthy(query, file)).toBe(true);
});

it("handler e pg-boss reais gravam a prova em output na conclusão, sem confiar no input", async () => {
  const instance = beginWorkerInstance(file); instance.ready();
  await completed(null, instance.proof());
  expect(await currentWorkerHealthy(query, file)).toBe(false);
  await startWorkerHeartbeat(boss, instance);
  const id = await boss.send(name, { workerInstance: { instanceId: "forjado" } });
  await vi.waitFor(async () => { expect(await currentWorkerHealthy(query, file)).toBe(true); }, { timeout: 10000, interval: 50 });
  const { rows } = await pool.query("SELECT output FROM pgboss.job WHERE id=$1", [id]);
  expect(rows[0].output).toEqual(instance.proof());
  instance.stop(); expect(await currentWorkerHealthy(query, file)).toBe(false);
});

it("job ainda ativo não comprova saúde mesmo contendo a identidade atual", async () => {
  const instance = beginWorkerInstance(file); instance.ready();
  const id = await boss.send(name, null); await boss.fetch(name);
  await pool.query("UPDATE pgboss.job SET output=$1::jsonb WHERE id=$2", [JSON.stringify(instance.proof()), id]);
  expect(await currentWorkerHealthy(query, file)).toBe(false);
});

it.each(["stale", "future", "before-ready"])("prova %s é recusada", async kind => {
  const instance = beginWorkerInstance(file); instance.ready();
  const marker = readWorkerInstance(file); if (!marker) throw new Error("sem marcador");
  // Janela sintética inteira no passado para separar recência e ordem do boot.
  if (kind === "stale") {
    marker.startedAt = new Date(Date.now() - 3600000).toISOString();
    marker.readyAt = new Date(Date.now() - 3500000).toISOString();
    writeFileSync(`${file}.${marker.instanceId}`, JSON.stringify(marker));
    writeFileSync(file, JSON.stringify({ ...marker, readyAt: null }));
  }
  const proof = { workerInstance: { version: 1, instanceId: marker.instanceId, startedAt: marker.startedAt, readyAt: marker.readyAt } };
  const id = await completed(proof);
  const time = kind === "stale" ? new Date(Date.now() - 16 * 60000) : kind === "future" ? new Date(Date.now() + 60000) : new Date(Date.parse(marker.readyAt ?? "") - 1);
  await pool.query("UPDATE pgboss.job SET completed_on=$1 WHERE id=$2", [time, id]);
  expect(await currentWorkerHealthy(query, file)).toBe(false);
});
