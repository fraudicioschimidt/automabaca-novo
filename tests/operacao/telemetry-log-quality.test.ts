import { beforeEach, expect, it, vi } from "vitest";
import type { Job, PgBoss } from "pg-boss";
import { getObservabilityContext } from "@/src/infra/observability-context";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

const mocks = vi.hoisted(() => ({
  metric: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: mocks.metric }));
vi.mock("@/src/infra/boss", () => ({ PGBOSS_NOTIFY_BACKSTOP_SECONDS: 5 }));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => mocks.log }));
const { workObserved, observeAction } = await import("@/src/services/ops/telemetry");

beforeEach(() => vi.clearAllMocks());

it.each([
  ["success", "info", "ACTION_SUCCEEDED"],
  ["error", "error", "ACTION_FAILED"],
  ["expected_retry", "info", "ACTION_DEFERRED"],
] as const)("log e métrica concordam no resultado %s", async (outcome, level, eventCode) => {
  const result = { ok: false };
  expect(await observeAction("test", async () => result, () => ({ outcome }))).toBe(result);
  expect(mocks.metric).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
  expect(mocks.log[level]).toHaveBeenCalledWith(expect.objectContaining({ outcome, eventCode }), expect.any(String));
});

it("distingue recusa de negócio de falha técnica e preserva a exceção", async () => {
  const refusal = new RecusaDeNegocioError("ação indisponível");
  await expect(observeAction("test", async () => { throw refusal; })).rejects.toBe(refusal);
  expect(mocks.log.info).toHaveBeenCalledWith(expect.objectContaining({ eventCode: "ACTION_REFUSED" }), expect.any(String));
  expect(mocks.log.error).not.toHaveBeenCalled();
});

async function observedWorker(handler: (jobs: Job[]) => Promise<unknown>, expectedRetry = false) {
  let worker: ((jobs: Job[]) => Promise<unknown>) | undefined;
  const boss = { work: vi.fn(async (_name, options, run) => {
    expect(options).toMatchObject({ includeMetadata: true });
    worker = run;
  }) } as unknown as PgBoss;
  await workObserved(boss, "test.queue", handler, { isExpectedRetry: () => expectedRetry });
  return worker!;
}

it("captura atraso e tentativa em filas que não pediam metadados", async () => {
  const error = new Error("aguardar");
  const worker = await observedWorker(async () => {
    expect(getObservabilityContext()).toMatchObject({ correlationId: "http_entry", jobId: "job-a" });
    throw error;
  }, true);
  await expect(worker([{
    id: "job-a", data: { _observability: { correlationId: "http_entry" } },
    retryCount: 2, createdOn: new Date(Date.now() - 60_000), startAfter: new Date(Date.now() - 500),
  } as unknown as Job])).rejects.toBe(error);
  expect(mocks.metric).toHaveBeenCalledWith(expect.objectContaining({
    outcome: "expected_retry", queueLagMs: expect.any(Number), labels: expect.objectContaining({ attempt: 3, retryCount: 2 }),
  }));
  const details = mocks.log.info.mock.calls[0]?.[0];
  expect(details).toMatchObject({ eventCode: "JOB_BATCH_RETRY_EXPECTED", attempt: 3 });
  expect(details.queueLagMs).toBeLessThan(5_000);
});

it("um lote com vários jobs não herda identidade/tentativa do primeiro", async () => {
  const worker = await observedWorker(async () => {
    expect(getObservabilityContext()?.jobId).toBeUndefined();
    expect(getObservabilityContext()?.correlationId).not.toBe("http_entry");
  });
  await worker([
    { id: "a", data: { _observability: { correlationId: "http_entry" } }, retryCount: 2 },
    { id: "b", data: {}, retryCount: 0 },
  ] as unknown as Job[]);
  expect(mocks.metric.mock.calls[0]?.[0].labels).toEqual({ jobs: 2 });
});

it("propaga betId do payload do job único no contexto ALS", async () => {
  const worker = await observedWorker(async () => {
    expect(getObservabilityContext()).toMatchObject({
      correlationId: "http_bet",
      jobId: "job-bet",
      betId: "bet_abc-123",
    });
  });
  await worker([{
    id: "job-bet",
    data: { betId: "bet_abc-123", _observability: { correlationId: "http_bet" } },
  } as unknown as Job]);
});

it("falha que a fila não espera conta como erro, com código e mensagem no log", async () => {
  // Quais erros cada fila espera é do classificador dela (`worker-jobs.test.ts`);
  // aqui, o que a telemetria faz com a falha do banco que ele não aceita.
  const bancoFora = Object.assign(new Error("\nInvalid `prisma.bet.findUnique()` invocation:\n\nTransaction API error: expired"), {
    name: "PrismaClientKnownRequestError", code: "P2028",
  });
  const worker = await observedWorker(async () => { throw bancoFora; });
  await expect(worker([{ id: "job-db", data: {}, createdOn: new Date() } as unknown as Job])).rejects.toBe(bancoFora);
  expect(mocks.metric).toHaveBeenCalledWith(expect.objectContaining({
    outcome: "error", labels: expect.objectContaining({ errorCode: "P2028" }),
  }));
  expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({
    eventCode: "JOB_BATCH_FAILED", errorCode: "P2028", errorMessage: expect.stringContaining("Transaction API error"),
  }), expect.any(String));
});
