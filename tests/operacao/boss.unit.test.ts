import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  on: vi.fn(),
  getEnv: vi.fn(() => ({ DATABASE_URL: "postgres://test" })),
}));

vi.mock("pg-boss", () => ({
  PgBoss: class {
    start = mocks.start;
    on = mocks.on;
  },
}));
vi.mock("@/src/infra/env", () => ({ getEnv: mocks.getEnv }));

const { getSharedBoss, isExpectedBossShutdownError } = await import("@/src/infra/boss");
type BossGlobal = typeof globalThis & { __boss?: Promise<unknown> };

beforeEach(() => {
  delete (globalThis as BossGlobal).__boss;
  vi.clearAllMocks();
});

describe("getSharedBoss", () => {
  it("compartilha uma inicialização concorrente", async () => {
    mocks.start.mockResolvedValue(undefined);
    const first = getSharedBoss();
    const second = getSharedBoss();
    expect(second).toBe(first);
    await first;
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("limpa a promessa rejeitada para permitir nova tentativa", async () => {
    mocks.start
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce(undefined);

    await expect(getSharedBoss()).rejects.toThrow("startup failed");
    await expect(getSharedBoss()).resolves.toBeDefined();
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });
});

describe("erro do pg-boss durante shutdown", () => {
  it("reconhece somente a corrida emitida pelo próprio Worker.stop", () => {
    expect(isExpectedBossShutdownError({
      message: "Database connection is not opened (Queue: sharp.enrich)",
      stack: "AssertionError\n at async Worker.stop (worker.js:100)",
    })).toBe(true);
    expect(isExpectedBossShutdownError({
      message: "Database connection is not opened (Queue: sharp.enrich)",
      stack: "AssertionError\n at async Worker.run (worker.js:60)",
    })).toBe(false);
    expect(isExpectedBossShutdownError(new Error("timeout exceeded"))).toBe(false);
  });
});
