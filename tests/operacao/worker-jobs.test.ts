import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";

const mocks = vi.hoisted(() => ({
  registerQueue: vi.fn(),
  workObserved: vi.fn(),
  sendPendingDigest: vi.fn(async () => ({ pendentes: 0 })),
  closeStaleTrainingCases: vi.fn(async () => ({ expired: 0, orphans: 0 })),
}));
vi.mock("@/src/services/ops/digests/pending-digest", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/services/ops/digests/pending-digest")>(),
  sendPendingDigest: mocks.sendPendingDigest,
}));
vi.mock("@/src/jobs/maintenance-jobs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/jobs/maintenance-jobs")>(),
  closeStaleTrainingCases: mocks.closeStaleTrainingCases,
}));
vi.mock("@/src/jobs/queues", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/jobs/queues")>(),
  registerQueue: mocks.registerQueue,
}));
vi.mock("@/src/services/ops/telemetry", () => ({ workObserved: mocks.workObserved }));

import { registerWorkerJobs, WORKER_JOBS } from "@/src/jobs/worker-jobs";
import { SCHEDULE_MANIFEST } from "@/src/jobs/schedules";

/**
 * A topologia que a produção tem hoje. Mudar nome, ordem, retry, policy ou cron
 * de uma fila é decisão operacional (policy divergente derruba o boot; cron
 * mexe na cadência dos portões), então esta lista muda junto, de propósito.
 */
const PRODUCTION = [
  ["health.heartbeat", { retryLimit: 1, policy: "exclusive" }, "4-59/5 * * * *"],
  ["outbox.dispatch", { retryLimit: 2, policy: "exclusive" }, "* * * * *"],
  ["capture.sport_resolve", { retryLimit: 2, retryDelay: 60, retryBackoff: true, policy: "exclusive" }, null],
  ["sharp.enrich", { retryLimit: 12, retryDelay: 60, retryBackoff: true, retryDelayMax: 1800, policy: "exclusive" }, null],
  ["sharp.revive", { retryLimit: 1, policy: "exclusive" }, "1-59/5 * * * *"],
  ["closing.price_series", { retryLimit: 0, policy: "exclusive" }, null],
  ["closing.price_series_sweep", { retryLimit: 0, policy: "exclusive" }, "* * * * *"],
  ["closing.sync", { retryLimit: 2, retryDelay: 120, policy: "exclusive", expireInSeconds: 600 }, "*/5 * * * *"],
  ["sharp.bridge_postgame", { retryLimit: 1, retryDelay: 600, policy: "exclusive", expireInSeconds: 1200 }, "2-59/20 * * * *"],
  ["policy.evaluate", { retryLimit: 2, retryDelay: 300, policy: "exclusive" }, "45 5 * * *"],
  ["consistency.financeiro", { retryLimit: 2, retryDelay: 300, policy: "exclusive" }, "40 3 * * *"],
  ["consistency.revisao", { retryLimit: 2, retryDelay: 300, policy: "exclusive" }, "45 3 * * *"],
  ["health.digest", { retryLimit: 2, retryDelay: 300, policy: "exclusive" }, "0 8 * * *"],
  ["pending.digest", { retryLimit: 2, retryDelay: 300, policy: "exclusive" }, "0 11 * * *"],
  ["training.close_stale_cases", { retryLimit: 2, retryDelay: 300, policy: "exclusive" }, "50 3 * * *"],
  ["executive.briefing", { retryLimit: 2, retryDelay: 300, policy: "exclusive" }, "5 0 * * *"],
  ["channels.weekly_digest", { retryLimit: 2, retryDelay: 300, policy: "exclusive" }, "0 9 * * 1"],
  ["settlement.ia_judge", { retryLimit: 2, retryDelay: 300, policy: "exclusive", expireInSeconds: 2400 }, "15 1-23/2 * * *"],
  ["settlement.flashscore_results", { retryLimit: 2, retryDelay: 300, policy: "exclusive" }, "1-59/10 * * * *"],
  ["settlement.flashscore_recheck", { retryLimit: 2, retryDelay: 600, policy: "exclusive" }, "10 7 * * *"],
  ["settlement.flashscore_inference_report", { retryLimit: 2, retryDelay: 300, policy: "exclusive" }, "40 7 * * *"],
  ["observability.slo", { retryLimit: 1, policy: "exclusive" }, "4-59/15 * * * *"],
  ["operational.actions", { retryLimit: 2, policy: "exclusive" }, "2-59/5 * * * *"],
  ["telegram.silence_watch", { retryLimit: 1, policy: "exclusive" }, "5-59/15 * * * *"],
  ["ops.release_verdict", { retryLimit: 1, policy: "exclusive" }, "3-59/15 * * * *"],
  ["teams.catalog_pairing", { retryLimit: 1, retryDelay: 600, policy: "exclusive" }, "37 8,12,16,20 * * *"],
  ["audit.purge", { retryLimit: 1, policy: "exclusive" }, "20 2 * * *"],
] as const;

describe("tabela de jobs do worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerQueue.mockResolvedValue(undefined);
    mocks.workObserved.mockResolvedValue(undefined);
  });

  it("declara exatamente as filas, retries, policies e crons da produção, na ordem do boot", () => {
    expect(WORKER_JOBS.map((job) => {
      const { onDeadLetter: _onDeadLetter, ...queueOptions } = job.queueOptions;
      return [job.queue, queueOptions, job.schedule?.cron ?? null];
    })).toEqual(PRODUCTION);
    expect(WORKER_JOBS.filter((job) => job.queueOptions.onDeadLetter).map((job) => job.queue))
      .toEqual(["capture.sport_resolve", "sharp.enrich"]);
  });

  it("o manifesto de schedules sai da tabela, no UTC−3 fixo e sem fila repetida", () => {
    expect(SCHEDULE_MANIFEST.map((item) => [item.queue, item.cron, item.timezone])).toEqual(
      PRODUCTION.filter(([, , cron]) => cron !== null).map(([queue, , cron]) => [queue, cron, "Etc/GMT+3"]),
    );
    expect(new Set(WORKER_JOBS.map((job) => job.queue)).size).toBe(WORKER_JOBS.length);
  });

  it("registra cada fila, liga os consumidores e dispara as execuções de boot", async () => {
    const send = vi.fn().mockResolvedValue("job");
    const boss = { send } as unknown as PgBoss;

    await registerWorkerJobs(boss);

    expect(mocks.registerQueue.mock.calls.map(([, queue]) => queue)).toEqual(PRODUCTION.map(([queue]) => queue));
    for (const job of WORKER_JOBS) {
      // A fila de cron leva o intervalo dela (destino da dead-letter) e a retenção do agendamento.
      expect(mocks.registerQueue).toHaveBeenCalledWith(boss, job.queue, job.schedule
        ? { ...job.queueOptions, cronMaxGapMinutes: expect.any(Number), deleteAfterSeconds: expect.any(Number) }
        : job.queueOptions);
    }
    // O heartbeat só ganha consumidor depois de o worker ficar pronto.
    const consumers = mocks.workObserved.mock.calls.map(([, queue]) => queue);
    expect(consumers).toEqual(PRODUCTION.map(([queue]) => queue).filter((queue) => queue !== "health.heartbeat"));
    expect(send.mock.calls).toEqual([
      ["closing.price_series_sweep", null, {}],
      ["operational.actions", null, {}],
    ]);
  });

  it("o cron que chega com a rodada anterior ainda em andamento conclui sem rodar outra em cima", async () => {
    await registerWorkerJobs({ send: vi.fn() } as unknown as PgBoss);
    const consumer = mocks.workObserved.mock.calls.find(([, queue]) => queue === "pending.digest")?.[2] as
      (jobs: unknown[]) => Promise<unknown>;
    let finish = (_value: { pendentes: number }) => {};
    mocks.sendPendingDigest.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

    const abandoned = consumer([{ expireInSeconds: 900 }]);
    await consumer([{ expireInSeconds: 900 }]);
    expect(mocks.sendPendingDigest).toHaveBeenCalledOnce();

    finish({ pendentes: 0 });
    await abandoned;
    await consumer([{ expireInSeconds: 900 }]);
    expect(mocks.sendPendingDigest).toHaveBeenCalledTimes(2);
  });

  it("a rodada que falha libera a vez para a seguinte", async () => {
    await registerWorkerJobs({ send: vi.fn() } as unknown as PgBoss);
    const consumer = mocks.workObserved.mock.calls.find(([, queue]) => queue === "pending.digest")?.[2] as
      (jobs: unknown[]) => Promise<unknown>;
    mocks.sendPendingDigest.mockRejectedValueOnce(new Error("Telegram fora"));

    await expect(consumer([{ expireInSeconds: 900 }])).rejects.toThrow("Telegram fora");
    await consumer([{ expireInSeconds: 900 }]);
    expect(mocks.sendPendingDigest).toHaveBeenCalledTimes(2);
  });

  it("no enrich a espera de provider é retentativa esperada, e a falha do banco é erro", () => {
    const isExpectedRetry = WORKER_JOBS.find((job) => job.queue === "sharp.enrich")?.work?.isExpectedRetry;
    const bancoFora = Object.assign(new Error("\nInvalid `prisma.bet.findUnique()` invocation:\n\nTransaction API error: expired"), {
      name: "PrismaClientKnownRequestError", code: "P2028",
    });
    const aguardandoPinnacle = Object.assign(new Error("Match não encontrado"), { name: "PrePinnacleRetryError" });
    expect(isExpectedRetry?.(bancoFora)).toBe(false);
    expect(isExpectedRetry?.(aguardandoPinnacle)).toBe(true);
  });

  it("o resumo de pendências só manda o resumo; o fechamento dos casos de treino é job próprio", async () => {
    const boss = {} as PgBoss;
    const handlerOf = (queue: string) => WORKER_JOBS.find((job) => job.queue === queue)?.handler;
    await handlerOf("pending.digest")?.([], boss);
    expect(mocks.sendPendingDigest).toHaveBeenCalledOnce();
    expect(mocks.closeStaleTrainingCases).not.toHaveBeenCalled();

    await handlerOf("training.close_stale_cases")?.([], boss);
    expect(mocks.closeStaleTrainingCases).toHaveBeenCalledOnce();
    expect(mocks.sendPendingDigest).toHaveBeenCalledOnce();
  });
});
