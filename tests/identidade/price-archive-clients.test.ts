import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { priceEnvelope, ARCHIVE_ENTRY } from "../helpers/price-archive-fixtures";
import { sanitizePinnacle17Event } from "@/src/providers/pinnacle17/types";

const mocks = vi.hoisted(() => ({ http: vi.fn(), archive: vi.fn(async () => "saved"), cache: vi.fn(async (): Promise<unknown> => null) }));
vi.mock("@/src/infra/env", () => ({ getEnv: () => ({ PINNACLE17_MODE: "on", PINNACLE17_RAPIDAPI_KEY: "synthetic-key",
  BRIDGEODDS_URL: "https://bridge.test", BRIDGEODDS_USER: "synthetic-user", BRIDGEODDS_PASS: "synthetic-pass" }) }));
vi.mock("@/src/infra/circuit-breaker", () => ({ withBreaker: (_: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/src/providers/budget", () => ({
  chargeProviderRequest: vi.fn(async () => {}), reconcileProviderBudgetFromProvider: vi.fn(async () => {}) }));
vi.mock("@/src/providers/request-cadence", () => ({ awaitProviderCadence: vi.fn(async () => {}) }));
vi.mock("@/src/providers/provider-cache", () => ({ readProviderCache: mocks.cache, writeProviderCache: vi.fn(async () => {}) }));
vi.mock("@/src/providers/price-archive/store", () => ({ archivePriceResponse: mocks.archive }));
vi.mock("@/src/providers/core/http", async (original) => ({ ...await original<object>(), fetchJsonWithRetry: mocks.http }));
import { fetchPinnacle17Odds, fetchPinnacle17Events } from "@/src/providers/pinnacle17/client";
import { queryOpeningClosing } from "@/src/providers/bridgeodds/client";

beforeEach(() => {
  vi.clearAllMocks(); mocks.cache.mockResolvedValue(null);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(ARCHIVE_ENTRY);
});
afterEach(() => vi.useRealTimers());
describe("arquivo de preços nas consultas físicas existentes", () => {
  it("Pinnacle guarda JSON completo e relógio da última tentativa antes de normalizar", async () => {
    const envelope = priceEnvelope(), event = sanitizePinnacle17Event(envelope.context.event);
    expect(event).not.toBeNull();
    mocks.http.mockImplementation(async (params) => {
      await params.beforeAttempt(); vi.setSystemTime(new Date(ARCHIVE_ENTRY.getTime() + 20_000));
      await params.beforeAttempt(); vi.setSystemTime(new Date(ARCHIVE_ENTRY.getTime() + 21_000));
      params.onResponse(new Response(null, { headers: { date: "Sun, 13 Sep 2026 06:00:21 GMT" } }));
      return { ok: true, data: envelope.body };
    });
    const result = await fetchPinnacle17Odds(123, undefined, event ?? undefined);
    expect(result?.data).toHaveLength(1); expect(mocks.http).toHaveBeenCalledOnce(); expect(mocks.archive).toHaveBeenCalledOnce();
    expect(mocks.archive.mock.calls[0]).toEqual([expect.objectContaining({ body: envelope.body,
      requestedAt: "2026-09-13T06:00:20.000Z", observedAt: "2026-09-13T06:00:21.000Z",
      context: expect.objectContaining({ event, httpDate: "Sun, 13 Sep 2026 06:00:21 GMT" }) }), ["synthetic-key"]]);
  });
  it("cache preserva hora antiga sem comprar nem arquivar outra resposta", async () => {
    mocks.cache.mockResolvedValue({ data: [], fetchedAt: ARCHIVE_ENTRY });
    expect(await fetchPinnacle17Odds(123)).toEqual({ data: [], observedAt: ARCHIVE_ENTRY });
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.archive).not.toHaveBeenCalled();
  });
  it("catálogo Pinnacle não entra no arquivo de preços", async () => {
    mocks.http.mockImplementation(async (params) => { await params.beforeAttempt(); return { ok: true, data: [] }; });
    await fetchPinnacle17Events({ sportId: 29, kickoffUtc: ARCHIVE_ENTRY }); expect(mocks.archive).not.toHaveBeenCalled();
  });
  it("Bridge não entra no arquivo e mantém placares fora do retorno de preços", async () => {
    const envelope = priceEnvelope("bridgeodds");
    mocks.http.mockImplementation(async (params) => {
      await params.beforeAttempt();
      return { ok: true, data: params.url.includes("auth/login") ? { token: "synthetic-token", expires_in: 3600 } : envelope.body };
    });
    const result = await queryOpeningClosing({ date: "2026-09-13", sport: "Futebol" });
    expect(mocks.http).toHaveBeenCalledTimes(2); expect(mocks.archive).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('"home_score":7');
    expect(JSON.stringify(result)).not.toContain('"away_score":4');
  });
});
