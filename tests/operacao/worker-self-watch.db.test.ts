import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerHeartbeatProof } from "@/src/infra/worker-instance";
import { operationalActionFingerprint } from "@/src/services/ops/operational-actions";
import { createTestDb, type TestDb } from "../helpers/db";

const alerts = vi.hoisted(() => ({ raiseOnce: vi.fn(), send: vi.fn() }));
vi.mock("@/src/services/ops/alerts", async (original) => ({
  ...await original<typeof import("@/src/services/ops/alerts")>(),
  raiseOperationalAlertOnce: alerts.raiseOnce,
  sendOperationalAlert: alerts.send,
}));

const { persistOperationalAlert } = await import("@/src/services/ops/alerts");
const { SELF_RESTART_ACTION, startWorkerSelfWatch } = await import("@/src/jobs/worker-self-watch");
type WorkerSelfWatch = ReturnType<typeof startWorkerSelfWatch>;

const MIN = 60_000;
const QUEUE = "health.heartbeat";
let db: TestDb;
let boss: PgBoss;
let watches: WorkerSelfWatch[] = [];

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => {
  await db.reset();
  alerts.raiseOnce.mockReset().mockResolvedValue(true);
  alerts.send.mockReset().mockResolvedValue(true);
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schedule: false, supervise: false });
  await boss.start();
  await boss.createQueue(QUEUE);
  await db.prisma.$executeRawUnsafe("DELETE FROM pgboss.job WHERE name = $1", QUEUE);
});
afterEach(async () => {
  await Promise.all(watches.map((watch) => watch.stop()));
  watches = [];
  await boss.stop({ graceful: false });
});

/** Um processo pronto há `readyMinutesAgo`, com a mesma forma de prova que o heartbeat grava. */
function instanceReady(readyMinutesAgo: number): { proof: () => WorkerHeartbeatProof } {
  const readyAt = new Date(Date.now() - readyMinutesAgo * MIN);
  const proof: WorkerHeartbeatProof = {
    workerInstance: {
      version: 1,
      instanceId: randomUUID(),
      startedAt: new Date(readyAt.getTime() - 30_000).toISOString(),
      readyAt: readyAt.toISOString(),
    },
  };
  return { proof: () => proof };
}

async function heartbeatCompleted(proof: WorkerHeartbeatProof, minutesAgo: number): Promise<void> {
  const id = await boss.send(QUEUE, null);
  if (!id) throw new Error("heartbeat não entrou na fila");
  await boss.fetch(QUEUE);
  await boss.complete(QUEUE, id, proof);
  await db.prisma.$executeRawUnsafe(
    "UPDATE pgboss.job SET completed_on = $1 WHERE id = $2::uuid", new Date(Date.now() - minutesAgo * MIN), id,
  );
}

function watch(instance: { proof: () => WorkerHeartbeatProof }) {
  const onStale = vi.fn();
  const started = startWorkerSelfWatch(instance, { onStale, intervalMs: 60 * MIN });
  watches.push(started);
  return { ...started, onStale };
}

const restarts = () => db.prisma.auditEvent.findMany({ where: { action: SELF_RESTART_ACTION } });

describe("vigia do próprio worker", () => {
  it("não disputa o aviso de retorno enquanto outra volta o está gravando", async () => {
    await db.prisma.auditEvent.create({ data: { action: SELF_RESTART_ACTION, resource: "worker", resourceId: randomUUID() } });
    const instance = instanceReady(1);
    await heartbeatCompleted(instance.proof(), 0);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    alerts.send.mockImplementationOnce(async () => { entered(); await gate; return true; });
    const self = watch(instance);
    const first = self.tick();
    await started;
    try { await self.tick(); expect(alerts.send).toHaveBeenCalledOnce(); }
    finally { release(); await first; }
    await self.tick();
    expect(alerts.send).toHaveBeenCalledOnce();
    expect(await db.prisma.auditEvent.count({ where: { action: "worker.self_restart_announced" } })).toBe(1);
  });

  it("retenta o aviso de autocura esgotada depois de falha de persistência", async () => {
    await db.prisma.auditEvent.createMany({
      data: [10, 40, 70].map((minutesAgo) => ({
        action: SELF_RESTART_ACTION, resource: "worker", resourceId: randomUUID(),
        createdAt: new Date(Date.now() - minutesAgo * MIN),
      })),
    });
    alerts.raiseOnce.mockImplementation(async (...args: Parameters<typeof persistOperationalAlert>) => { await persistOperationalAlert(...args); return true; }).mockRejectedValueOnce(new Error("pool temporariamente indisponível"));
    const self = watch(instanceReady(25));
    await self.tick();
    await self.tick();
    expect(alerts.raiseOnce).toHaveBeenCalledTimes(2);
    expect(await db.prisma.operationalAction.count({ where: { fingerprint: operationalActionFingerprint("worker.self-restart", "exhausted") } })).toBe(1);
    expect(self.onStale).not.toHaveBeenCalled();
  });

  it("recusa do Telegram não confirma o aviso de retorno", async () => {
    await db.prisma.auditEvent.create({ data: { action: SELF_RESTART_ACTION, resource: "worker", resourceId: randomUUID() } });
    const instance = instanceReady(1);
    await heartbeatCompleted(instance.proof(), 0);
    alerts.send.mockResolvedValueOnce(false).mockResolvedValue(true);
    const self = watch(instance);
    await self.tick();
    expect(await db.prisma.auditEvent.count({ where: { action: "worker.self_restart_announced" } })).toBe(0);
    await self.tick(); await self.tick();
    expect(alerts.send).toHaveBeenCalledTimes(2);
    expect(await db.prisma.auditEvent.count({ where: { action: "worker.self_restart_announced" } })).toBe(1);
  });

  it("recusa do Telegram não encerra as tentativas do aviso de autocura esgotada", async () => {
    await db.prisma.auditEvent.createMany({ data: [10, 40, 70].map((minutesAgo) => ({
      action: SELF_RESTART_ACTION, resource: "worker", resourceId: randomUUID(),
      createdAt: new Date(Date.now() - minutesAgo * MIN),
    })) });
    alerts.raiseOnce.mockResolvedValueOnce(false).mockResolvedValue(true);
    const self = watch(instanceReady(25));
    await self.tick(); await self.tick(); await self.tick();
    expect(alerts.raiseOnce).toHaveBeenCalledTimes(2);
  });

  it("retenta o aviso de retorno e grava o recibo depois da recuperação", async () => {
    await db.prisma.auditEvent.create({ data: {
      action: SELF_RESTART_ACTION, resource: "worker", resourceId: randomUUID(),
      createdAt: new Date(Date.now() - MIN),
    } });
    const instance = instanceReady(1);
    await heartbeatCompleted(instance.proof(), 0);
    alerts.send.mockRejectedValueOnce(new Error("pool temporariamente indisponível"));
    const self = watch(instance);
    await self.tick();
    await self.tick();
    expect(alerts.send).toHaveBeenCalledTimes(2);
    expect(await db.prisma.auditEvent.count({ where: { action: "worker.self_restart_announced" } })).toBe(1);
    await self.tick();
    expect(alerts.send).toHaveBeenCalledTimes(2);
  });

  it("com heartbeat recente deste processo, segue rodando", async () => {
    const instance = instanceReady(60);
    await heartbeatCompleted(instance.proof(), 2);
    const self = watch(instance);
    await self.tick();
    expect(self.onStale).not.toHaveBeenCalled();
    expect(await restarts()).toEqual([]);
  });

  it("20 min sem prova de vida: grava o reinício e sai, uma vez só", async () => {
    const instance = instanceReady(60);
    await heartbeatCompleted(instance.proof(), 25);
    const self = watch(instance);
    await self.tick();
    await self.tick();
    expect(self.onStale).toHaveBeenCalledOnce();
    const [restart] = await restarts();
    expect(restart).toEqual(expect.objectContaining({
      actor: "system", resource: "worker", resourceId: instance.proof().workerInstance.instanceId,
    }));
    expect(restart?.details).toEqual(expect.objectContaining({
      lastProofAt: expect.any(String), staleSince: expect.any(String), restartedAt: expect.any(String),
    }));
  });

  it("heartbeat concluído por outro processo não prova a vida deste", async () => {
    const previous = instanceReady(90);
    await heartbeatCompleted(previous.proof(), 1);
    const self = watch(instanceReady(21));
    await self.tick();
    expect(self.onStale).toHaveBeenCalledOnce();
  });

  it("com 3 reinícios na janela, não reinicia de novo e avisa uma vez", async () => {
    await db.prisma.auditEvent.createMany({
      data: [10, 40, 70].map((minutesAgo) => ({
        action: SELF_RESTART_ACTION, resource: "worker", resourceId: randomUUID(),
        createdAt: new Date(Date.now() - minutesAgo * MIN),
      })),
    });
    const self = watch(instanceReady(25));
    await self.tick();
    await self.tick();
    expect(self.onStale).not.toHaveBeenCalled();
    expect(alerts.raiseOnce).toHaveBeenCalledOnce();
    expect(alerts.raiseOnce.mock.calls[0]?.[0]).toContain("já foram 3 reinícios automáticos nas últimas 3 h");
    expect(alerts.raiseOnce.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ source: "worker.self-restart", key: "exhausted" }));
  });

  it("o reinício de mais de 3 h atrás não gasta a cota", async () => {
    await db.prisma.auditEvent.createMany({
      data: [10, 40, 200].map((minutesAgo) => ({
        action: SELF_RESTART_ACTION, resource: "worker", resourceId: randomUUID(),
        createdAt: new Date(Date.now() - minutesAgo * MIN),
      })),
    });
    const self = watch(instanceReady(25));
    await self.tick();
    expect(self.onStale).toHaveBeenCalledOnce();
  });

  it("o processo novo avisa a volta na primeira prova de vida, uma vez só, e fecha a autocura esgotada", async () => {
    const stuck = instanceReady(40);
    await heartbeatCompleted(stuck.proof(), 30);
    await watch(stuck).tick();
    await persistOperationalAlert("autocura esgotada", {
      source: "worker.self-restart", key: "exhausted", title: "Autocura do worker esgotada", autoResolve: false,
    });

    const back = instanceReady(1);
    const self = watch(back);
    await self.tick();
    expect(alerts.send).not.toHaveBeenCalled();
    await heartbeatCompleted(back.proof(), 0);
    await self.tick();
    expect(await db.prisma.auditEvent.count({ where: { action: "worker.self_restart_announced" } })).toBe(1);
    expect(alerts.send).toHaveBeenCalledOnce();
    const [message, context] = alerts.send.mock.calls[0] ?? [];
    expect(message).toMatch(/^🔁 O worker se reiniciou sozinho\nFicou 20 min sem concluir o heartbeat \(o último às \d\d:\d\d\) e saiu às \d\d:\d\d/);
    expect(message).toContain("Reinícios automáticos nas últimas 3 h: 1 de 3.");
    expect(context).toEqual(expect.objectContaining({ source: "worker.self-restart", key: "restart" }));
    const exhausted = await db.prisma.operationalAction.findFirst({
      where: { fingerprint: operationalActionFingerprint("worker.self-restart", "exhausted") },
    });
    expect(exhausted?.status).toBe("RESOLVED");

    await self.tick();
    const nextBoot = instanceReady(0);
    await heartbeatCompleted(nextBoot.proof(), 0);
    await watch(nextBoot).tick();
    expect(alerts.send).toHaveBeenCalledOnce();
  });
});
