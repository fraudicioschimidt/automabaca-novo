import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const recordOperationalMetric = vi.fn();
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric }));

const previousFlag = process.env.OBSERVABILITY_METRICS_IN_TEST;

beforeAll(() => {
  process.env.OBSERVABILITY_METRICS_IN_TEST = "true";
});

afterAll(() => {
  if (previousFlag === undefined) delete process.env.OBSERVABILITY_METRICS_IN_TEST;
  else process.env.OBSERVABILITY_METRICS_IN_TEST = previousFlag;
});

beforeEach(() => {
  recordOperationalMetric.mockReset().mockResolvedValue(undefined);
});

const { observeHttpRequest } = await import("@/src/services/ops/http-telemetry");
/** A métrica sai depois da resposta, sem ninguém esperar: deixa o import e a gravação começarem. */
const settle = async () => {
  await vi.dynamicImportSettled();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("telemetria HTTP", () => {
  it("polling registra falhas sem INSERT para sucessos", async () => {
    const request = new Request("http://localhost/api/poll");
    await observeHttpRequest(request, "/api/poll", async () => new Response(null), { metric: "errors" });
    await settle();
    expect(recordOperationalMetric).not.toHaveBeenCalled();
    await observeHttpRequest(request, "/api/poll", async () => new Response(null, { status: 503 }), { metric: "errors" });
    await settle();
    expect(recordOperationalMetric).toHaveBeenCalledWith(expect.objectContaining({ outcome: "error", statusCode: 503,
      labels: expect.objectContaining({ sampling: "errors_only" }) }));
    const failure = new Error("database unavailable");
    await expect(observeHttpRequest(request, "/api/poll", async () => { throw failure; }, { metric: "errors" })).rejects.toBe(failure);
    await settle();
    expect(recordOperationalMetric).toHaveBeenCalledTimes(2);
  });
  it("rota pode declarar 401/403 como falha técnica", async () => {
    const request = new Request("http://localhost/api/telegram/webhook", { method: "POST" });
    for (const status of [401, 403]) {
      await observeHttpRequest(request, "/api/telegram/webhook", async () => new Response(null, { status }), { failureStatuses: [401, 403] });
    }
    await observeHttpRequest(request, "/api/outra", async () => new Response(null, { status: 401 }));
    await settle();
    expect(recordOperationalMetric.mock.calls.map(([input]) => [input.name, input.statusCode, input.outcome])).toEqual([
      ["/api/telegram/webhook", 401, "error"],
      ["/api/telegram/webhook", 403, "error"],
      ["/api/outra", 401, "success"],
    ]);
  });

  it("flood numa rota guarda só a cota do minuto de cada classe de status", async () => {
    // Recusa anônima (403 do login, 429 da telemetria do navegador) não toca o
    // banco; sem cota, cada uma viraria uma linha de métrica.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-24T12:00:10Z"));
      const request = new Request("http://localhost/api/flood", { method: "POST" });
      for (let i = 0; i < 130; i += 1) {
        await observeHttpRequest(request, "/api/flood", async () => new Response(null, { status: 403 }));
      }
      await observeHttpRequest(request, "/api/flood", async () => new Response(null, { status: 200 }));
      await settle();
      const status = () => recordOperationalMetric.mock.calls.map(([input]) => input.statusCode);
      expect(status().filter((code) => code === 403)).toHaveLength(120);
      expect(status().filter((code) => code === 200)).toHaveLength(1);

      vi.setSystemTime(new Date("2026-09-24T12:01:00Z"));
      await observeHttpRequest(request, "/api/flood", async () => new Response(null, { status: 403 }));
      await settle();
      expect(status().filter((code) => code === 403)).toHaveLength(121);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserva correlação do proxy e registra status", async () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-correlation-id": "proxy_valid-123" },
    });
    const response = await observeHttpRequest(request, "/api/test", async () =>
      new Response(null, { status: 202 }),
    );

    expect(response.headers.get("x-correlation-id")).toBe("proxy_valid-123");
    await settle();
    expect(recordOperationalMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: "http",
      name: "/api/test",
      outcome: "success",
      statusCode: 202,
    }));
  });

  it("substitui correlação hostil e classifica 5xx como erro", async () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-correlation-id": "forged value" },
    });
    const response = await observeHttpRequest(request, "/api/test", async () =>
      new Response(null, { status: 503 }),
    );

    expect(response.headers.get("x-correlation-id")).toMatch(/^http_[a-f0-9-]+$/);
    await settle();
    expect(recordOperationalMetric).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "error",
      statusCode: 503,
    }));
  });

  it("preserva redirect com headers imutáveis sem transformar em 500", async () => {
    const request = new Request("http://localhost/api/redirect");
    const response = await observeHttpRequest(request, "/api/redirect", async () =>
      Response.redirect("http://localhost/destino", 302),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost/destino");
    await settle();
    expect(recordOperationalMetric).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "success",
      statusCode: 302,
    }));
  });

  it("a resposta sai sem esperar a gravação da métrica, que herda a correlação", async () => {
    // Esperar o INSERT atrasaria toda resposta quando o banco está lento.
    const { getObservabilityContext } = await import("@/src/infra/observability-context");
    let correlationNaGravacao: string | undefined;
    recordOperationalMetric.mockImplementation(() => {
      correlationNaGravacao = getObservabilityContext()?.correlationId;
      return new Promise(() => undefined);
    });
    const request = new Request("http://localhost/api/test", { headers: { "x-correlation-id": "proxy_after-1" } });
    const response = await observeHttpRequest(request, "/api/test", async () => new Response(null, { status: 200 }));
    expect(response.status).toBe(200);
    await settle();
    expect(recordOperationalMetric).toHaveBeenCalledTimes(1);
    expect(correlationNaGravacao).toBe("proxy_after-1");
  });
});
