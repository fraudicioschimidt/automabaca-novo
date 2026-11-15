import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cadence: vi.fn(async (_: unknown) => {}), charge: vi.fn(async () => {}),
  http: vi.fn(), archive: vi.fn(), cache: vi.fn(async (): Promise<unknown> => null) }));
vi.mock("@/src/infra/env", () => ({ getEnv: () => ({ PINNACLE17_MODE: "on", PINNACLE17_RAPIDAPI_KEY: "synthetic" }) }));
vi.mock("@/src/infra/circuit-breaker", () => ({ withBreaker: (_: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/src/providers/budget", async (original) => ({ ...await original<object>(), chargeProviderRequest: mocks.charge }));
vi.mock("@/src/providers/request-cadence", () => ({ awaitProviderCadence: mocks.cadence }));
vi.mock("@/src/providers/provider-cache", () => ({ readProviderCache: mocks.cache, writeProviderCache: async () => {} }));
vi.mock("@/src/providers/price-archive/store", () => ({ archivePriceResponse: mocks.archive }));
vi.mock("@/src/providers/core/http", async (original) => ({ ...await original<object>(), fetchJsonWithRetry: mocks.http }));
import { fetchPinnacle17Odds } from "@/src/providers/pinnacle17/client";
import { BudgetExhaustedError, ProviderCadenceDeferredError } from "@/src/domain/provider-error";
const now = new Date("2026-09-13T06:00:00Z");
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  mocks.cache.mockResolvedValue(null); mocks.cadence.mockResolvedValue();
  mocks.http.mockImplementation(async (params) => { await params.beforeAttempt(); return { ok: true, status: 200, data: [] }; });
});
afterEach(() => { vi.useRealTimers(); });
describe("cliente Pinnacle17 na consulta extra do fechamento", () => {
  it("limita espera, timeout e tentativas, cobrando somente o orçamento próprio", async () => {
    const charge = vi.fn(async () => {});
    await fetchPinnacle17Odds(123, charge, undefined, { deadlineMs: now.getTime() + 60_000 });
    expect(mocks.cadence).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: now.getTime() + 250 }));
    expect(mocks.http.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 8000, maxRetries: 0 });
    expect(charge).toHaveBeenCalledOnce(); expect(mocks.charge).not.toHaveBeenCalled();
  });
  it("a primária do fechamento pede mais tempo por tentativa e uma retentativa, com o prazo valendo para a consulta toda", async () => {
    await fetchPinnacle17Odds(123, vi.fn(async () => {}), undefined,
      { deadlineMs: now.getTime() + 43_000, attemptTimeoutMs: 25_000, retries: 1 });
    expect(mocks.http.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 25_000, maxRetries: 1, signal: expect.any(AbortSignal) });
  });
  it("retentativa sem tempo até o prazo não paga cota", async () => {
    const charge = vi.fn(async () => {});
    mocks.http.mockImplementationOnce(async (params) => {
      await params.beforeAttempt(); vi.setSystemTime(now.getTime() + 42_000); await params.beforeAttempt();
      return { ok: true, status: 200, data: [] };
    });
    expect(await fetchPinnacle17Odds(123, charge, undefined,
      { deadlineMs: now.getTime() + 43_000, attemptTimeoutMs: 25_000, retries: 1 })).toBeNull();
    expect(charge).toHaveBeenCalledOnce();
  });
  it("não ocupa o transporte quando a cadência não cabe no prazo", async () => {
    mocks.cadence.mockRejectedValueOnce(new ProviderCadenceDeferredError("pinnacle17", new Date(now.getTime() + 1000)));
    await fetchPinnacle17Odds(123, undefined, undefined, { deadlineMs: now.getTime() + 2000 });
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.charge).not.toHaveBeenCalled();
  });
  it("uma consulta normal concorrente não herda recusa do limite extra", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const charge = vi.fn(async () => { await blocked; throw new BudgetExhaustedError("pinnacle17", "synthetic-limit"); });
    const pending = fetchPinnacle17Odds(123, charge, undefined, { deadlineMs: now.getTime() + 60_000 });
    await vi.waitFor(() => expect(charge).toHaveBeenCalledOnce());
    const normal = await fetchPinnacle17Odds(123);
    release(); expect(await pending).toBeNull(); expect(normal).toMatchObject({ data: [] });
    expect(mocks.charge).toHaveBeenCalledOnce(); expect(mocks.http).toHaveBeenCalledTimes(2);
    expect(mocks.http.mock.calls[1]?.[0]).toMatchObject({ timeoutMs: 30_000, maxRetries: 1 });
  });
  it("consulta extra compartilha consulta normal já em andamento", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    mocks.http.mockImplementationOnce(async (params) => { await params.beforeAttempt(); await blocked; return { ok: true, status: 200, data: [] }; });
    const normal = fetchPinnacle17Odds(123);
    await vi.waitFor(() => expect(mocks.charge).toHaveBeenCalledOnce());
    const charge = vi.fn(async () => {});
    const pending = fetchPinnacle17Odds(123, charge, undefined, { deadlineMs: now.getTime() + 60_000 });
    release(); await Promise.all([normal, pending]);
    expect(mocks.http).toHaveBeenCalledOnce(); expect(charge).not.toHaveBeenCalled();
  });
});
