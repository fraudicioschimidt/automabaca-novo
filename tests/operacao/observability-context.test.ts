import { describe, expect, it, vi } from "vitest";
import {
  betIdFromPayload,
  correlationIdFromPayload,
  getObservabilityContext,
  isSafeCorrelationId,
  runWithObservabilityContext,
  withCurrentCorrelation,
} from "@/src/infra/observability-context";
import { privacyHash } from "@/src/infra/privacy";

describe("contexto de observabilidade", () => {
  it("isola correlações concorrentes e as propaga ao payload", async () => {
    const run = (correlationId: string, delay: number) =>
      runWithObservabilityContext({ correlationId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return {
          context: getObservabilityContext()?.correlationId,
          payload: withCurrentCorrelation({ betId: correlationId }),
        };
      });

    const [first, second] = await Promise.all([run("corr_first", 5), run("corr_second", 1)]);
    expect(first.context).toBe("corr_first");
    expect(second.context).toBe("corr_second");
    expect(correlationIdFromPayload(first.payload)).toBe("corr_first");
    expect(correlationIdFromPayload(second.payload)).toBe("corr_second");
    expect(getObservabilityContext()).toBeUndefined();
  });

  it("rejeita correlações manipuladas", () => {
    expect(isSafeCorrelationId("http_123:abc-def")).toBe(true);
    expect(correlationIdFromPayload({ _observability: { correlationId: "forged\nlog" } })).toBeUndefined();
    expect(correlationIdFromPayload({ _observability: { correlationId: "x".repeat(101) } })).toBeUndefined();
  });

  it("gera hash estável, separado por namespace e sem expor o valor", () => {
    const first = privacyHash("127.0.0.1", "ip");
    expect(first).toBe(privacyHash("127.0.0.1", "ip"));
    expect(first).not.toBe(privacyHash("127.0.0.1", "username"));
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(first).not.toContain("127.0.0.1");
  });

  it("propaga betId no ALS e rejeita valores inseguros", async () => {
    await runWithObservabilityContext(
      { correlationId: "corr_bet", betId: "bet_abc-123" },
      async () => {
        expect(getObservabilityContext()?.betId).toBe("bet_abc-123");
        await runWithObservabilityContext({ source: "nested" }, async () => {
          // partial sem betId não apaga o do pai
          expect(getObservabilityContext()?.betId).toBe("bet_abc-123");
          expect(getObservabilityContext()?.source).toBe("nested");
        });
      },
    );
    expect(betIdFromPayload({ betId: "bet_ok" })).toBe("bet_ok");
    expect(betIdFromPayload({ betId: "bad\nid" })).toBeUndefined();
    expect(betIdFromPayload({ betId: "x".repeat(81) })).toBeUndefined();
  });
});

it("compartilha contexto entre cópias do módulo sem misturar requisições", async () => {
  const first = await import("@/src/infra/observability-context");
  vi.resetModules();
  const second = await import("@/src/infra/observability-context");

  const run = (correlationId: string, delay: number) =>
    first.runWithObservabilityContext({ correlationId, route: "/api/test" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      expect(second.getObservabilityContext()?.correlationId).toBe(correlationId);
      return second.runWithObservabilityContext({ source: "nested" }, async () => {
        await Promise.resolve();
        expect(first.getObservabilityContext()).toEqual({
          correlationId, route: "/api/test", source: "nested",
        });
        expect(first.withCurrentCorrelation({ test: true })).toMatchObject({
          _observability: { correlationId },
        });
      });
    });

  await Promise.all([run("http_first", 5), run("http_second", 1)]);
  expect(first.getObservabilityContext()).toBeUndefined();
  expect(second.getObservabilityContext()).toBeUndefined();
});
