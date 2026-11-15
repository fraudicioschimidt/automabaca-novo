import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(), charge: vi.fn(), cadence: vi.fn(), metric: vi.fn(),
  consume: vi.fn(), reconcile: vi.fn(), writeCache: vi.fn(),
}));
vi.mock("@/src/infra/env", () => ({ getEnv: () => ({
  PINNACLE17_MODE: "on", PINNACLE17_RAPIDAPI_KEY: "test",
  FLASHSCORE_MODE: "on", FLASHSCORE_API_KEY: "test",
}) }));
vi.mock("@/src/infra/circuit-breaker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/infra/circuit-breaker")>()),
  isBreakerOpen: async () => false,
  withBreaker: (_: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: mocks.metric }));
vi.mock("@/src/providers/budget", async (original) => ({
  ...await original<Record<string, unknown>>(), chargeProviderRequest: mocks.charge,
  reconcileProviderBudgetFromProvider: mocks.reconcile,
}));
vi.mock("@/src/providers/budget-reservations", () => ({
  consumeProviderBudgetReservation: mocks.consume,
  reserveProviderBudget: vi.fn(), releaseProviderBudgetReservation: vi.fn(),
}));
vi.mock("@/src/providers/request-cadence", () => ({ awaitProviderCadence: mocks.cadence }));
vi.mock("@/src/providers/provider-cache", () => ({ readProviderCache: async () => null, writeProviderCache: mocks.writeCache }));

import { fetchPinnacle17Odds } from "@/src/providers/pinnacle17/client";
import { pinnacle17ClosingReservedAttempt } from "@/src/providers/pinnacle17/sharp";
import { listFlashscoreMatchesByDate } from "@/src/providers/flashscore/client";
import { BudgetExhaustedError } from "@/src/domain/provider-error";
import { PROVIDER_CAPS } from "@/src/providers/budget-config";
import { PINNACLE17_GLOBAL_COOLDOWN_MS, PINNACLE17_PER_MINUTE_CONTRACTED_REQUESTS } from "@/src/providers/pinnacle17/limits";
import { FLASHSCORE_CONTRACTED_REQUESTS_PER_MINUTE, FLASHSCORE_REQUEST_COOLDOWN_MS } from "@/src/providers/flashscore/limits";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.consume.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

const providers = [
  { name: "flashscore", run: () => listFlashscoreMatchesByDate("2026-07-22") },
  { name: "pinnacle17", run: () => fetchPinnacle17Odds(1635205194) },
];

describe("recuperação limitada das APIs Ultra", () => {
  it("configura ambos os planos e mantém margem global abaixo de 240/min", () => {
    for (const provider of providers) expect(PROVIDER_CAPS.find(cap => cap.provider === provider.name))
      .toMatchObject({ contracted: 10_000, cap: 9_500, period: "day" });
    expect(PINNACLE17_PER_MINUTE_CONTRACTED_REQUESTS).toBe(240);
    expect(FLASHSCORE_CONTRACTED_REQUESTS_PER_MINUTE).toBe(240);
    for (const cooldown of [PINNACLE17_GLOBAL_COOLDOWN_MS, FLASHSCORE_REQUEST_COOLDOWN_MS]) {
      expect(60_000 / cooldown).toBeLessThanOrEqual(220);
      expect(60_000 / cooldown).toBeGreaterThan(210);
    }
  });

  it.each(providers)("$name recupera timeout e cobra as duas tentativas", async ({ name, run }) => {
    mocks.fetch.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
      .mockResolvedValueOnce(Response.json([]));
    expect(await run()).not.toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.charge).toHaveBeenCalledTimes(2);
    expect(mocks.cadence).toHaveBeenCalledTimes(2);
    expect(mocks.cadence).toHaveBeenLastCalledWith(expect.objectContaining({ provider: name, route: "global" }));
    expect(mocks.metric).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "success", labels: expect.objectContaining({ attempts: 2 }) }));
  });

  it.each(providers)("$name esgota após duas falhas e mantém erro no SLO", async ({ run }) => {
    mocks.fetch.mockImplementation(async () => Response.json({ error: "unavailable" }, { status: 503 }));
    await run().catch(() => null);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.charge).toHaveBeenCalledTimes(2);
    expect(mocks.metric).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "error", statusCode: 503 }));
  });

  it.each(providers)("$name não repete 429", async ({ run }) => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await run().catch(() => null);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.charge).toHaveBeenCalledOnce();
  });

  it.each(providers)("$name não faz segundo fetch quando não há cota para retry", async ({ name, run }) => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    mocks.charge.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new BudgetExhaustedError(name));
    await run().catch(() => null);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.writeCache).not.toHaveBeenCalled();
    expect(mocks.metric).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "error", labels: expect.objectContaining({ attempts: 1, error: "fetch failed" }),
    }));
  });

  it("closing paga a primeira chamada com reserva e o retry com cota nova", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(Response.json([]));
    const attempt = pinnacle17ClosingReservedAttempt("closing-test");
    expect(await fetchPinnacle17Odds(1635205194, attempt)).not.toBeNull();
    expect(mocks.consume).toHaveBeenCalledOnce();
    expect(mocks.charge).toHaveBeenCalledExactlyOnceWith("pinnacle17", "closing-retry");
    expect(mocks.cadence).toHaveBeenCalledTimes(2);
    await expect(attempt()).rejects.toThrow("esgotou as tentativas");
  });

  it.each([true, false])("FlashScore separa recusa de horizonte de HTTP 400 desconhecido: %s", async (outsideWindow) => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ message: outsideWindow
      ? "The API does not support fetching data more than 7 days in the future"
      : "Bad request" }, { status: 400 }));
    // Ambos são ProviderRequestGateError (não ProviderRequestError): 400 de
    // list-by-date é recusa de contrato/cliente — não falha transitória nem
    // estrutural para recovery/breaker.
    await expect(listFlashscoreMatchesByDate("2026-07-22")).rejects.toMatchObject({
      name: outsideWindow ? "FlashscoreDateWindowError" : "FlashscoreListByDateClientError",
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.metric).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "expected_retry", statusCode: 400,
    }));
  });
});
