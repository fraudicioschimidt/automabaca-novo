import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { QUEUES, type QueueName } from "@/src/infra/queue-contract";

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  continuation: vi.fn(),
  bridgePostgame: vi.fn(),
  closingSync: vi.fn(),
  closingArchive: vi.fn(),
  closingWatch: vi.fn(),
  closingSeriesSweep: vi.fn(),
  enrich: vi.fn(),
  enqueue: vi.fn(),
  evaluate: vi.fn(),
  findRevive: vi.fn(),
  markDeadLettered: vi.fn(),
  findBet: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/src/services/ops/alerts", () => ({ sendOperationalAlert: mocks.alert }));
// A marca do breaker contra o Postgres real está em sharp-jobs.db.test.ts.
vi.mock("@/src/infra/prisma", () => ({ prisma: { bet: { findUnique: mocks.findBet } } }));
vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ info: mocks.logInfo, error: mocks.logError }),
}));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ enqueueSharpEnrich: mocks.enqueue }));
vi.mock("@/src/services/scheduling/continue-sharp-enrich", () => ({ continueSharpEnrich: mocks.continuation }));
vi.mock("@/src/services/sharp/bridge-postgame", () => ({ runBridgePostgameOnce: mocks.bridgePostgame }));
vi.mock("@/src/services/sharp/closing/sync", () => ({
  runClosingSyncOnce: mocks.closingSync,
}));
vi.mock("@/src/services/sharp/closing/series", () => ({
  runClosingWatch: mocks.closingWatch,
  maintainClosingSeries: mocks.closingSeriesSweep,
  maintainClosingArchive: mocks.closingArchive,
}));
vi.mock("@/src/services/sharp/enrich/upsert-sharp", () => ({ markEnrichDeadLettered: mocks.markDeadLettered }));
vi.mock("@/src/services/sharp/enrich/enrich-bet", () => ({
  enrichBetSharp: mocks.enrich,
  PrePinnacleRetryError: class PrePinnacleRetryError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "PrePinnacleRetryError";
    }
  },
}));
vi.mock("@/src/services/sharp/revive", () => ({ findBetsParaReviver: mocks.findRevive }));
vi.mock("@/src/services/sharp/segment-policy", () => ({ evaluateSegmentPolicies: mocks.evaluate }));

import { WORKER_JOBS } from "@/src/jobs/worker-jobs";

const createBoss = () => ({}) as unknown as PgBoss;
const jobOf = (queue: QueueName) => {
  const job = WORKER_JOBS.find((item) => item.queue === queue);
  if (!job) throw new Error(`fila ausente da tabela: ${queue}`);
  return job;
};
const run = (queue: QueueName, jobs: unknown[], boss: PgBoss) => jobOf(queue).handler!(jobs as never, boss);

describe("jobs sharp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRevive.mockResolvedValue(["bet-1", "bet-2"]);
    mocks.enqueue.mockResolvedValue(undefined);
  });

  it("declara a política das filas e executa os handlers principais", async () => {
    expect(jobOf(QUEUES.sharpEnrich).queueOptions).toEqual(expect.objectContaining({ policy: "exclusive" }));
    const sharpWork = jobOf(QUEUES.sharpEnrich).work;
    expect(sharpWork?.localConcurrency).toBe(2);
    const retryClassifier = sharpWork?.isExpectedRetry;
    const ExpectedRetry = (await import("@/src/services/sharp/enrich/enrich-bet")).PrePinnacleRetryError;
    expect(retryClassifier?.(new ExpectedRetry("teste"))).toBe(true);
    expect(retryClassifier?.({ name: "CircuitOpenError", message: "aberto" })).toBe(true);
    expect(retryClassifier?.(new Error("falha real"))).toBe(false);
    expect(jobOf(QUEUES.closingSeries).queueOptions).toEqual({ retryLimit: 0, policy: "exclusive" });
    expect(jobOf(QUEUES.closingSeriesSweep).queueOptions).toEqual({ retryLimit: 0, policy: "exclusive" });
    expect(jobOf(QUEUES.closingSeries).work?.localConcurrency).toBe(3);

    const boss = createBoss();
    await run(QUEUES.sharpEnrich, [{ data: { betId: "bet-1" } }], boss);
    await run(QUEUES.sharpRevive, [], boss);
    await run(QUEUES.closingSync, [], boss);
    await run(QUEUES.bridgePostgame, [{ signal: undefined }], boss);
    await run(QUEUES.closingSeries, [{ data: { watchId: "watch-1" } }, { data: { watchId: 123 } }, { data: {} }], boss);
    await run(QUEUES.closingSeriesSweep, [], boss);
    await run(QUEUES.policyEvaluate, [], boss);

    expect(mocks.enrich).toHaveBeenCalledWith({ betId: "bet-1" }, { boss, continuation: undefined });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      boss,
      "bet-1",
      expect.objectContaining({ origem: "revive", singletonSeconds: 540 }),
    );
    expect(mocks.enqueue.mock.calls[0]?.[2]).not.toHaveProperty("retryLimit");
    expect(mocks.closingSync).toHaveBeenCalledOnce();
    expect(mocks.closingArchive).toHaveBeenCalledOnce();
    expect(mocks.bridgePostgame).toHaveBeenCalledExactlyOnceWith({ signal: undefined });
    expect(mocks.closingWatch).toHaveBeenCalledExactlyOnceWith("watch-1", boss);
    expect(mocks.closingSeriesSweep).toHaveBeenCalledExactlyOnceWith(boss);
    expect(mocks.evaluate).toHaveBeenCalledOnce();
  });

  it("o closing.sync passa ao ciclo o sinal do job e o orçamento da Bridge, menores que o teto da fila", async () => {
    const { providerWorkDeadline } = await import("@/src/infra/provider-work-budget");
    let bridgeDeadline: number | undefined;
    mocks.closingSync.mockImplementationOnce(async () => { bridgeDeadline = providerWorkDeadline("bridgeodds"); });
    const expired = new AbortController();
    const startedAt = Date.now();

    await run(QUEUES.closingSync, [{ signal: expired.signal }], createBoss());

    const { signal } = mocks.closingSync.mock.calls[0]![0] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);
    expired.abort();
    expect(signal.aborted).toBe(true);
    const budgetMs = bridgeDeadline! - startedAt;
    expect(budgetMs).toBeGreaterThan(0);
    expect(budgetMs).toBeLessThan(jobOf(QUEUES.closingSync).queueOptions.expireInSeconds! * 1000);
  });

  it("closing.sync mantém o arquivo de preços mesmo quando o ciclo falha", async () => {
    const falha = new Error("taxa de falha crítica");
    mocks.closingSync.mockRejectedValueOnce(falha);
    await expect(run(QUEUES.closingSync, [], createBoss())).rejects.toBe(falha);
    expect(mocks.closingArchive).toHaveBeenCalledOnce();
  });

  it("espera de capacidade vira continuação durável, sem retry técnico", async () => {
    const { SharpContinuationError } = await import("@/src/services/sharp/enrich/continuation");
    const retryAt = new Date(Date.now() + 40_000);
    const continuation = { betSignature: "terms" };
    mocks.enrich.mockRejectedValueOnce(new SharpContinuationError(retryAt, continuation));
    const boss = createBoss();
    const job = { id: "active-job", data: { betId: "bet-1", origem: "capture" } };
    await expect(run(QUEUES.sharpEnrich, [job], boss)).resolves.toBeUndefined();
    expect(mocks.continuation).toHaveBeenCalledWith(boss, job, retryAt, continuation);
  });

  it("marca a aposta ao esgotar retries da fila de enriquecimento", async () => {
    const { onDeadLetter } = jobOf(QUEUES.sharpEnrich).queueOptions;

    await onDeadLetter?.({ betId: "bet-dead" });
    await onDeadLetter?.({});

    expect(mocks.markDeadLettered).toHaveBeenCalledExactlyOnceWith("bet-dead");
  });

  it("breaker aberto conclui o enrich sem relançar nem queimar retry", async () => {
    const { CircuitOpenError } = await import("@/src/infra/circuit-breaker");
    mocks.enrich.mockRejectedValueOnce(new CircuitOpenError("bridgeodds"));

    await expect(
      run(QUEUES.sharpEnrich, [{ data: { betId: "bet-open", origem: "revive" } }], createBoss()),
    ).resolves.toBeUndefined();
  });

  it("match ainda ausente conclui o job e deixa a cadência para o revival", async () => {
    const ExpectedRetry = (await import("@/src/services/sharp/enrich/enrich-bet")).PrePinnacleRetryError;
    mocks.enrich.mockRejectedValueOnce(new ExpectedRetry("below_threshold"));

    await expect(
      run(QUEUES.sharpEnrich, [{ data: { betId: "bet-future", origem: "telegram" } }], createBoss()),
    ).resolves.toBeUndefined();
  });

  it("contabiliza singleton ativo como pulado, não como enfileirado", async () => {
    mocks.enqueue.mockResolvedValueOnce(null).mockResolvedValueOnce("job-2");

    await run(QUEUES.sharpRevive, [], createBoss());

    expect(mocks.logInfo).toHaveBeenCalledWith(
      { enfileiradas: 1, puladas: 1, falhas: 0 },
      "revival: apostas avaliadas para re-enfileirar enrich",
    );
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
