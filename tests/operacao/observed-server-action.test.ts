import { expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { getObservabilityContext, withCurrentCorrelation } from "@/src/infra/observability-context";

const request = new AsyncLocalStorage<Headers>();
vi.mock("next/headers", () => ({ headers: async () => request.getStore() }));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: vi.fn() }));
const { observeAction } = await import("@/app/_lib/observed-action");
const { workObserved } = await import("@/src/services/ops/telemetry");

it("preserva HTTP → ação → payload → job, sem misturar requisições concorrentes", async () => {
  for (const id of await Promise.all(["http_one", "http_two"].map((correlationId) =>
    request.run(new Headers({ "x-correlation-id": correlationId }), () => observeAction("test", async () => {
      await Promise.resolve();
      expect(getObservabilityContext()?.correlationId).toBe(correlationId);
      return withCurrentCorrelation({ betId: "synthetic" });
    })),
  ))) {
    let handler: (jobs: unknown[]) => Promise<unknown> = async () => undefined;
    const boss = { work: async (_name: string, _options: unknown, run: typeof handler) => { handler = run; } };
    await workObserved(boss as never, "test", async () => {
      expect(getObservabilityContext()?.correlationId).toBe(id._observability?.correlationId);
    });
    await handler([{ id: "job-synthetic", data: id }]);
  }
  expect(getObservabilityContext()).toBeUndefined();
});

it("não aceita correlação inválida e preserva a falha da ação", async () => {
  const failure = new Error("synthetic");
  await expect(request.run(new Headers({ "x-correlation-id": "invalid value" }), () => observeAction("test", async () => {
    expect(getObservabilityContext()?.correlationId).toMatch(/^action_/);
    throw failure;
  }))).rejects.toBe(failure);
});
