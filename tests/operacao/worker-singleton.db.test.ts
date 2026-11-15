import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { acquireWorkerSingletonLock } from "@/src/infra/worker-singleton";

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

describe("acquireWorkerSingletonLock (Postgres real)", () => {
  it("segundo worker não adquire enquanto o primeiro segura; solta → próximo adquire", async () => {
    const release1 = await acquireWorkerSingletonLock({ attempts: 1, delayMs: 10 });

    await expect(acquireWorkerSingletonLock({ attempts: 3, delayMs: 10 })).rejects.toThrow(
      /lock ocupado/,
    );

    await release1();

    const release2 = await acquireWorkerSingletonLock({ attempts: 1, delayMs: 10 });
    await release2();
  });

  it("a sonda pública vê o lock preso e o solto (B10)", async () => {
    const { WORKER_SINGLETON_LOCK_HELD_SQL } = await import("@/src/domain/health");
    const held = async () => {
      const rows = await db.prisma.$queryRawUnsafe<Array<{ held: boolean }>>(WORKER_SINGLETON_LOCK_HELD_SQL);
      return rows[0]?.held === true;
    };
    expect(await held()).toBe(false);
    const release = await acquireWorkerSingletonLock({ attempts: 1, delayMs: 10 });
    expect(await held()).toBe(true);
    await release();
    expect(await held()).toBe(false);
  });
});
