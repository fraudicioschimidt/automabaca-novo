import { expect, it, vi } from "vitest";
import { runWithObservabilityContext } from "@/src/infra/observability-context";

const mocks = vi.hoisted(() => ({ query: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
// Pool próprio da telemetria: cada métrica é UM comando (`query`), sem transação.
vi.mock("@/src/infra/prisma", () => ({ getMetricsPool: () => ({ query: mocks.query }) }));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => mocks }));

/** Os labels do INSERT, que vão como o último parâmetro (JSON). */
function labelsOfCall(index: number): Record<string, unknown> {
  const params = mocks.query.mock.calls[index]?.[1] as unknown[] | undefined;
  return JSON.parse(String(params?.at(-1))) as Record<string, unknown>;
}

it("limita concorrência, contabiliza descarte e libera capacidade mesmo após erro", async () => {
  vi.stubEnv("OBSERVABILITY_METRICS_IN_TEST", "true");
  const { recordOperationalMetric } = await import("@/src/infra/operational-metrics");
  const resolvers: Array<() => void> = [];
  mocks.query.mockImplementation(() => new Promise<void>((resolve) => resolvers.push(resolve)));
  const input = { kind: "action", name: "test", outcome: "success" } as const;
  try {
    const pending = [recordOperationalMetric(input), recordOperationalMetric(input)];
    await recordOperationalMetric(input);
    await recordOperationalMetric(input);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ eventCode: "OBSERVABILITY_METRICS_DROPPED" }), expect.any(String));
    resolvers.forEach((resolve) => resolve());
    await Promise.all(pending);
    expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({ dropped: 2 }), expect.any(String));
    mocks.query.mockRejectedValueOnce(new Error("synthetic"));
    await expect(recordOperationalMetric(input)).resolves.toBeUndefined();
    mocks.query.mockResolvedValue(undefined);
    await recordOperationalMetric(input);
    expect(mocks.query).toHaveBeenCalledTimes(4);
  } finally { vi.unstubAllEnvs(); }
});

it("absorve rajadas curtas sem descartar métricas nem exceder duas escritas simultâneas", async () => {
  vi.stubEnv("OBSERVABILITY_METRICS_IN_TEST", "true");
  vi.clearAllMocks();
  const { recordOperationalMetric } = await import("@/src/infra/operational-metrics");
  let concurrent = 0;
  let peak = 0;
  mocks.query.mockImplementation(async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await Promise.resolve();
    concurrent -= 1;
  });
  try {
    await Promise.all(Array.from({ length: 20 }, () =>
      recordOperationalMetric({ kind: "action", name: "burst", outcome: "success" })));
    expect(mocks.query).toHaveBeenCalledTimes(20);
    expect(peak).toBeLessThanOrEqual(2);
    expect(mocks.warn).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

it("métrica identifica release, processo, job e execução LLM sem dados pessoais", async () => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue(undefined);
  const { recordOperationalMetric } = await import("@/src/infra/operational-metrics");
  vi.stubEnv("OBSERVABILITY_METRICS_IN_TEST", "true");
  vi.stubEnv("AUTOMABACA_RELEASE_ID", "release-test");
  vi.stubEnv("AUTOMABACA_PROCESS", "worker");
  await runWithObservabilityContext({ correlationId: "http_entry", jobId: "job_a", llmCallId: "llm_a", llmCallStartedAtMs: 1_750_000_000_000, llmEvaluationRandomized: false, actor: "private-user" }, () =>
    recordOperationalMetric({ kind: "provider", name: "test", outcome: "success", labels: { token: "secret-token" } }));
  const labels = labelsOfCall(0);
  expect(labels).toMatchObject({ correlationId: "http_entry", jobId: "job_a", llmCallId: "llm_a", llmCallStartedAtMs: 1_750_000_000_000, llmEvaluationRandomized: false, releaseId: "release-test", process: "worker" });
  expect(JSON.stringify(labels)).not.toContain("private-user");
  expect(JSON.stringify(labels)).not.toContain("secret-token");
  vi.unstubAllEnvs();
});

it("falha na persistência da métrica não falha a operação", async () => {
  const { recordOperationalMetric } = await import("@/src/infra/operational-metrics");
  vi.stubEnv("OBSERVABILITY_METRICS_IN_TEST", "true");
  mocks.query.mockRejectedValueOnce(new Error("db indisponível"));
  try {
    await expect(recordOperationalMetric({ kind: "action", name: "test", outcome: "success" })).resolves.toBeUndefined();
  } finally { vi.unstubAllEnvs(); }
});

it("grava a métrica num INSERT só, com o nome normalizado e sem transação", async () => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue(undefined);
  const { recordOperationalMetric } = await import("@/src/infra/operational-metrics");
  vi.stubEnv("OBSERVABILITY_METRICS_IN_TEST", "true");
  try {
    await recordOperationalMetric({ kind: "provider", name: "bridge/match/123", outcome: "error", durationMs: 12.6, statusCode: 503 });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql.trim()).toMatch(/^INSERT INTO operational_metrics/);
    expect(params.slice(0, 6)).toEqual(["provider", "bridge/match/:id", "error", 13, null, 503]);
  } finally { vi.unstubAllEnvs(); }
});
