import type { PgBoss } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOSS_DRAIN_TIMEOUT_MS, shutdownWorkerResources } from "@/src/jobs/worker-lifecycle";

const bossStop = vi.fn();
const release = vi.fn();
const disconnect = vi.fn();
const log = { error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  bossStop.mockResolvedValue(undefined);
  release.mockResolvedValue(undefined);
  disconnect.mockResolvedValue(undefined);
});

function shutdown() {
  return shutdownWorkerResources({
    boss: { stop: bossStop } as unknown as PgBoss,
    releaseSingletonLock: release,
    disconnect,
    log,
  });
}

describe("shutdownWorkerResources", () => {
  it("para as filas, solta singleton e desconecta o banco", async () => {
    await shutdown();
    expect(bossStop).toHaveBeenCalledWith({ graceful: true, timeout: BOSS_DRAIN_TIMEOUT_MS });
    expect(release).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("tenta todos os recursos mesmo quando todos os anteriores falham", async () => {
    bossStop.mockRejectedValue(new Error("boss timeout"));
    release.mockRejectedValue(new Error("lock lost"));
    disconnect.mockRejectedValue(new Error("db down"));
    await expect(shutdown()).resolves.toBeUndefined();
    expect(bossStop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledTimes(3);
  });

  it("aceita boss e lock ausentes durante falha parcial de boot", async () => {
    await shutdownWorkerResources({
      boss: null,
      releaseSingletonLock: null,
      disconnect,
      log,
    });
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
