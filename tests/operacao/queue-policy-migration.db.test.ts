import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import { getSharedBoss } from "@/src/infra/boss";
import { deadLetterOf } from "@/src/infra/queue-contract";
import { registerQueue } from "@/src/jobs/queues";

let boss: PgBoss;

beforeAll(async () => {
  boss = await getSharedBoss();
});

afterAll(async () => {
  await boss.stop({ graceful: false });
});

describe("migração de policy da fila", () => {
  it("não usa contadores cacheados para apagar um job recém-aceito", async () => {
    const queue = `test.policy_${randomUUID().replaceAll("-", "")}`;
    const deadLetter = deadLetterOf(queue);
    await boss.createQueue(queue, { policy: "singleton" });
    const jobId = await boss.send(queue, { payload: "durável" }, { singletonKey: "unit:1" });
    expect(jobId).toEqual(expect.any(String));

    try {
      const staleSnapshot = await boss.getQueue(queue);
      if (!staleSnapshot) throw new Error("fila de teste não foi criada");
      expect(staleSnapshot.queuedCount).toBe(0);
      expect(staleSnapshot.activeCount).toBe(0);

      await expect(registerQueue(boss, queue, { policy: "exclusive" })).rejects.toThrow(
        /policy singleton.*migração operacional explícita.*exclusive/i,
      );
      expect(await boss.getJobById(queue, jobId!)).not.toBeNull();
    } finally {
      await boss.offWork(deadLetter, { wait: true }).catch(() => undefined);
      await boss.deleteQueue(queue).catch(() => undefined);
      await boss.deleteQueue(deadLetter).catch(() => undefined);
    }
  });
});
