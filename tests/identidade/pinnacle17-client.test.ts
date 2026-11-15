import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  charge: vi.fn(async () => {}),
  reconcile: vi.fn(async () => {}),
  cadence: vi.fn(async () => {}),
  readCache: vi.fn(async (_params?: unknown): Promise<unknown> => null),
  writeCache: vi.fn(async () => {}),
  archive: vi.fn(async (_envelope: unknown) => null),
}));

vi.mock("@/src/infra/env", () => ({
  getEnv: () => ({ PINNACLE17_MODE: "on", PINNACLE17_RAPIDAPI_KEY: "pinnacle17-test-key" }),
}));
vi.mock("@/src/infra/circuit-breaker", () => ({
  withBreaker: (_name: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/src/providers/budget", () => ({
  chargeProviderRequest: mocks.charge,
  reconcileProviderBudgetFromProvider: mocks.reconcile,
}));
vi.mock("@/src/providers/request-cadence", () => ({ awaitProviderCadence: mocks.cadence }));
vi.mock("@/src/providers/provider-cache", () => ({
  readProviderCache: mocks.readCache,
  writeProviderCache: mocks.writeCache,
}));
vi.mock("@/src/providers/price-archive/store", () => ({ archivePriceResponse: mocks.archive }));
vi.mock("@/src/providers/core/http", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, fetchJsonWithRetry: mocks.fetchJson };
});

import {
  fetchPinnacle17Events,
  fetchPinnacle17EventsOutcome,
  fetchPinnacle17Odds,
  fetchPinnacle17OddsOutcome,
  findPinnacle17EventById,
} from "@/src/providers/pinnacle17/client";
import {
  PINNACLE17_EVENTS_TTL_MS,
  PINNACLE17_GLOBAL_COOLDOWN_MS,
  PINNACLE17_PRICE_TTL_MS,
} from "@/src/providers/pinnacle17/limits";

const event = {
  id: 1634172613,
  name: "Union de Santa Fe vs Sarmiento de Junin",
  startTime: "2026-08-28T19:00:00-03:00",
  status: { isStarted: false, isInProgress: false, isInterrupted: false },
  sport: { id: 29, name: "Soccer" },
  league: { id: 210697, name: "Liga Pro", country: "Argentina" },
  homeTeam: { name: "Union de Santa Fe" },
  awayTeam: { name: "Sarmiento de Junin" },
  units: "Regular",
};

describe("cliente Pinnacle17", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCache.mockResolvedValue(null);
    mocks.archive.mockImplementation(async () => null);
    mocks.reconcile.mockImplementation(async () => {});
    mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      params.onResponse?.(new Response(null, { headers: {
        "x-ratelimit-requests-limit": "10000",
        "x-ratelimit-requests-remaining": "9997",
        "x-ratelimit-requests-reset": "3600",
      } }));
      return { ok: true, status: 200, data: [event] };
    });
  });

  it("usa o host correto, retry limitado, data UTC, cadência e budget próprios", async () => {
    await expect(fetchPinnacle17Events({
      sportId: 29,
      kickoffUtc: new Date("2026-08-28T22:00:00Z"),
    })).resolves.toMatchObject({ data: [{ id: 1634172613 }] });
    const params = mocks.fetchJson.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      maxRetries: 1,
      init: { headers: {
        "x-rapidapi-host": "pinnacle17.p.rapidapi.com",
        "x-rapidapi-key": "pinnacle17-test-key",
      } },
    });
    expect(params.url).toContain("/api/pinnacle/v1/sport/matches?");
    expect(params.url).toContain("sport_id=29");
    expect(params.url).toContain("date=2026-08-28");
    expect(params.url).toContain("timezone=UTC");
    expect(mocks.charge).toHaveBeenCalledWith("pinnacle17", "sport/matches");
    expect(mocks.reconcile).toHaveBeenCalledWith("pinnacle17", 9997, 3600);
    expect(mocks.cadence).toHaveBeenCalledWith({
      provider: "pinnacle17",
      route: "global",
      cooldownMs: PINNACLE17_GLOBAL_COOLDOWN_MS,
    });
    expect(mocks.writeCache).toHaveBeenCalledWith(expect.objectContaining({ ttlMs: PINNACLE17_EVENTS_TTL_MS }));
  });

  it("acha o jogo pelo id na lista dos dias UTC dados, um pedido por dia", async () => {
    mocks.fetchJson.mockImplementation(async (params) => ({
      ok: true, status: 200, data: params.url.includes("date=2026-08-28") ? [event] : [],
    }));
    const found = await findPinnacle17EventById({
      sportId: 29,
      eventId: "1634172613",
      // O match_date velho da Bridge (dia 27) e o horário da aposta (dia 28, duas vezes).
      around: [new Date("2026-08-27T23:00:00Z"), new Date("2026-08-28T20:00:00Z"), new Date("2026-08-28T22:00:00Z")],
    });
    expect(found?.id).toBe(1634172613);
    expect(new Date(found!.startTime).toISOString()).toBe("2026-08-28T22:00:00.000Z");
    const dates = mocks.fetchJson.mock.calls.map(([params]) => /date=([\d-]+)/.exec(params.url)?.[1]);
    expect(dates).toEqual(["2026-08-27", "2026-08-28"]);
    await expect(findPinnacle17EventById({ sportId: 29, eventId: "999", around: [new Date("2026-08-28T20:00:00Z")] }))
      .resolves.toBeNull();
  });

  it.each([false, true])("prazo vencido depois da cadência não cobra tentativa Pinnacle17 (retry=%s)", async (retry) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const deferred = retry ? 2 : 1;
    let cadenceCalls = 0;
    mocks.cadence.mockImplementation(async () => {
      if (++cadenceCalls === deferred) clock.mockReturnValue(now + 10_000);
    });
    mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      if (retry) await params.beforeAttempt?.();
      return { ok: true, status: 200, data: [event] };
    });
    try {
      await expect(fetchPinnacle17EventsOutcome({ sportId: 29, kickoffUtc: new Date("2026-08-28T22:00:00Z"),
        deadline: { deadlineMs: now + 5_000, retries: 1 },
      })).resolves.toEqual({ kind: "failed", budget: false });
      expect(mocks.charge).toHaveBeenCalledTimes(retry ? 1 : 0);
      expect(mocks.writeCache).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); mocks.cadence.mockImplementation(async () => {}); }
  });

  it.each(["reconcile", "archive"])("o instante da resposta precede a demora local em %s", async (stage) => {
    const receivedAt = new Date("2026-08-28T21:59:59Z");
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(receivedAt);
    const delay = async () => { vi.setSystemTime(new Date(receivedAt.getTime() + 2000)); };
    if (stage === "reconcile") mocks.reconcile.mockImplementation(delay);
    if (stage === "archive") mocks.archive.mockImplementation(async () => { await delay(); return null; });
    mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      params.onResponse?.(new Response(null, { headers: { "x-ratelimit-requests-remaining": "9997" } }));
      return { ok: true, status: 200, data: [] };
    });
    try {
      const result = await fetchPinnacle17Odds(1634172613);
      expect(result?.observedAt).toEqual(receivedAt);
      expect(mocks.archive).toHaveBeenCalledWith(expect.objectContaining({ observedAt: receivedAt.toISOString() }), expect.any(Array));
      expect(mocks.writeCache).toHaveBeenCalledWith(expect.objectContaining({ now: receivedAt }));
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])("100 consumidores compartilham leituras persistentes (aquecido=%s)", async (warm) => {
    const observedAt = new Date("2026-08-28T21:59:59Z");
    if (warm) mocks.readCache.mockResolvedValue({ data: [event], fetchedAt: observedAt });
    const results = await Promise.all(Array.from({ length: 100 }, () =>
      fetchPinnacle17Events({ sportId: 29, kickoffUtc: new Date("2026-08-28T22:00:00Z") })));

    expect(results.every((result) => result?.data[0]?.id === event.id)).toBe(true);
    // No miss, a segunda leitura depois da cadência continua necessária:
    // outro processo pode ter obtido a resposta durante a espera global.
    expect(mocks.readCache).toHaveBeenCalledTimes(warm ? 1 : 2);
    expect(mocks.fetchJson).toHaveBeenCalledTimes(warm ? 0 : 1);
    if (warm) expect(results[0]?.observedAt).toEqual(observedAt);
  });

  it("falha ao compartilhar cache não descarta odds obtidas e arquivadas", async () => {
    mocks.fetchJson.mockImplementationOnce(async (params) => {
      await params.beforeAttempt?.();
      return { ok: true, status: 200, data: [] };
    });
    mocks.writeCache.mockRejectedValueOnce(new Error("cache indisponível"));

    await expect(fetchPinnacle17OddsOutcome(1634172613)).resolves.toMatchObject({
      kind: "observed", observed: { data: [], observedAt: expect.any(Date) },
    });
    expect(mocks.archive).toHaveBeenCalledOnce();
    expect(mocks.fetchJson).toHaveBeenCalledOnce();
  });

  it("singleflight compra uma só resposta concorrente", async () => {
    const params = { sportId: 29, kickoffUtc: new Date("2026-08-28T22:00:00Z") };
    const [first, second] = await Promise.all([fetchPinnacle17Events(params), fetchPinnacle17Events(params)]);
    expect(first?.data[0]?.id).toBe(1634172613);
    expect(second?.data[0]?.id).toBe(1634172613);
    expect(mocks.fetchJson).toHaveBeenCalledOnce();
  });

  it("closing direcionado consome a reserva somente se houver request físico", async () => {
    mocks.fetchJson.mockImplementationOnce(async (params) => {
      await params.beforeAttempt?.();
      return { ok: true, status: 200, data: [] };
    });
    const reservedAttempt = vi.fn(async () => {});
    await expect(fetchPinnacle17Odds(1634172613, reservedAttempt)).resolves.toMatchObject({ data: [] });
    expect(mocks.fetchJson.mock.calls[0]?.[0]?.url).toContain("match/odds?match_id=1634172613");
    expect(reservedAttempt).toHaveBeenCalledOnce();
    expect(mocks.writeCache).toHaveBeenCalledWith(expect.objectContaining({ ttlMs: PINNACLE17_PRICE_TTL_MS }));
  });

  it("livro vazio de evento pré-jogo não entra no cache e a próxima chamada consulta de novo", async () => {
    mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      return { ok: true, status: 200, data: [] };
    });
    const prematch = { ...event, startTime: new Date(Date.now() + 3_600_000).toISOString() };
    await expect(fetchPinnacle17Odds(1634172613, undefined, prematch)).resolves.toBeNull();
    await expect(fetchPinnacle17Odds(1634172613, undefined, prematch)).resolves.toBeNull();
    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
    expect(mocks.writeCache).not.toHaveBeenCalled();

    // Depois do início, livro vazio é a resposta de verdade.
    const started = { ...event, startTime: new Date(Date.now() - 60_000).toISOString() };
    await expect(fetchPinnacle17Odds(1634172613, undefined, started)).resolves.toMatchObject({ data: [] });
    expect(mocks.writeCache).toHaveBeenCalledOnce();
  });

  it.each([
    ["429", { ok: false, status: 429, error: "quota" }],
    ["timeout", new Error("timeout")],
    ["envelope inválido", { ok: true, status: 200, data: { unexpected: true } }],
  ])("falha segura em %s retornado pelo transporte, sem cache", async (label, response) => {
    mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      if (response instanceof Error) throw response;
      if (response.status === 429) params.onResponse?.(new Response(null, { status: 429, headers: {
        "x-ratelimit-requests-remaining": "0",
        "x-ratelimit-requests-reset": "120",
      } }));
      return response;
    });
    await expect(fetchPinnacle17Events({
      sportId: 29,
      kickoffUtc: new Date("2026-08-28T22:00:00Z"),
    })).resolves.toBeNull();
    expect(mocks.fetchJson).toHaveBeenCalledOnce();
    expect(mocks.writeCache).not.toHaveBeenCalled();
    if (label === "429") expect(mocks.reconcile).toHaveBeenCalledWith("pinnacle17", 0, 120);
  });

  it("campo renomeado pelo fornecedor é falha de contrato, e não um dia sem jogos no cache", async () => {
    const renamed = Array.from({ length: 5 }, (_, index) => {
      const { homeTeam, ...rest } = event;
      return { ...rest, id: event.id + index, home: homeTeam };
    });
    mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      return { ok: true, status: 200, data: [event, ...renamed] };
    });
    const params = { sportId: 29, kickoffUtc: new Date("2026-08-28T22:00:00Z") };

    await expect(fetchPinnacle17EventsOutcome(params)).resolves.toEqual({ kind: "failed", budget: false });
    await expect(fetchPinnacle17Events(params)).resolves.toBeNull();
    expect(mocks.writeCache).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])("%i eventos todos inválidos não são observação vazia", async (count) => {
    mocks.fetchJson.mockResolvedValue({ ok: true, status: 200,
      data: Array.from({ length: count }, () => ({ ...event, id: "inválido" })),
    });
    await expect(fetchPinnacle17EventsOutcome({ sportId: 29, kickoffUtc: new Date("2026-08-28T22:00:00Z") }))
      .resolves.toEqual({ kind: "failed", budget: false });
    expect(mocks.writeCache).not.toHaveBeenCalled();
  });

  it("evento de outro esporte não vira candidato da modalidade consultada", async () => {
    mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: [{ ...event, sport: { id: 4, name: "Basketball" } }] });
    await expect(fetchPinnacle17EventsOutcome({ sportId: 29, kickoffUtc: new Date("2026-08-28T22:00:00Z") }))
      .resolves.toEqual({ kind: "failed", budget: false });
    expect(mocks.writeCache).not.toHaveBeenCalled();
  });

  it("descarta esporte divergente num lote válido sem perder os candidatos corretos", async () => {
    const correct = Array.from({ length: 4 }, (_, i) => ({ ...event, id: event.id + i }));
    mocks.fetchJson.mockResolvedValue({ ok: true, status: 200,
      data: [...correct, { ...event, id: event.id + 10, sport: { id: 4, name: "Basketball" } }],
    });
    const result = await fetchPinnacle17Events({ sportId: 29, kickoffUtc: new Date("2026-08-28T22:00:00Z") });
    expect(result?.data.map((row) => row.id)).toEqual(correct.map((row) => row.id));
  });

  it("assinatura recusada não grava ausência e a consulta retoma quando o acesso volta", async () => {
    mocks.fetchJson.mockResolvedValueOnce({ ok: false, status: 403, error: "HTTP 403" })
      .mockResolvedValueOnce({ ok: true, status: 200, data: [event] });
    const params = { sportId: 29, kickoffUtc: new Date("2026-08-28T22:00:00Z") };
    await expect(fetchPinnacle17EventsOutcome(params)).resolves.toEqual({ kind: "failed", budget: false });
    expect(mocks.writeCache).not.toHaveBeenCalled();
    await expect(fetchPinnacle17EventsOutcome(params)).resolves.toMatchObject({ kind: "observed", observed: { data: [{ id: event.id }] } });
    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
    expect(mocks.writeCache).toHaveBeenCalledOnce();
  });

  it("uma linha ruim num dia cheio não derruba o resto", async () => {
    const good = Array.from({ length: 4 }, (_, index) => ({ ...event, id: event.id + index }));
    mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      return { ok: true, status: 200, data: [...good, { ...event, id: "sem-id" }] };
    });
    const observed = await fetchPinnacle17Events({ sportId: 29, kickoffUtc: new Date("2026-08-28T22:00:00Z") });
    expect(observed?.data.map((row) => row.id)).toEqual(good.map((row) => row.id));
    expect(mocks.writeCache).toHaveBeenCalledOnce();
  });

  it("mercados com o preço renomeado são falha de contrato; tipo que o produto não lê fica de fora sem contar", async () => {
    const market = {
      name: "Money Line – Match", type: "moneyline", period: 0, periodName: "Match", team: null, units: "Regular",
      special: null, isLive: false, line: null, status: "open", cutoffAt: null, limits: [],
      outcomes: [
        { designation: "home", name: "Union", line: null, oddsAmerican: -124, oddsDecimal: 1.806 },
        { designation: "away", name: "Sarmiento", line: null, oddsAmerican: 356, oddsDecimal: 4.56 },
      ],
    };
    const renamed = { ...market, outcomes: market.outcomes.map(({ oddsDecimal, ...rest }) => ({ ...rest, price: oddsDecimal })) };
    const respond = (data: unknown[]) => mocks.fetchJson.mockImplementation(async (params) => {
      await params.beforeAttempt?.();
      return { ok: true, status: 200, data };
    });

    respond([renamed, renamed, renamed, renamed]);
    await expect(fetchPinnacle17OddsOutcome(1634172613)).resolves.toEqual({ kind: "failed", budget: false });
    expect(mocks.writeCache).not.toHaveBeenCalled();

    const unread = { ...market, type: "player_prop" };
    respond([market, unread, unread, unread, unread]);
    await expect(fetchPinnacle17OddsOutcome(1634172613)).resolves.toMatchObject({
      kind: "observed", observed: { data: [{ type: "moneyline" }] },
    });
  });
});
