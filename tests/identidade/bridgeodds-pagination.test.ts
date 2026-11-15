import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderCadenceDeferredError } from "@/src/domain/provider-error";
import { resetEnvCacheForTests } from "@/src/infra/env";
import type { BridgeMatch, BridgeQueryPage } from "@/src/providers/bridgeodds/types";

const mocks = vi.hoisted(() => ({
  /** O que escapa do `withBreaker`: é o que o circuito conta como falha. */
  breakerFailures: [] as unknown[],
  logWarn: vi.fn(),
  cadence: vi.fn(async () => undefined),
  cacheRows: new Map<string, unknown>(),
  cacheRead: vi.fn(),
  cacheWrite: vi.fn(),
}));

vi.mock("@/src/providers/provider-cache", () => ({
  readProviderCache: mocks.cacheRead,
  writeProviderCache: mocks.cacheWrite,
}));


vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ warn: mocks.logWarn }),
}));

vi.mock("@/src/infra/circuit-breaker", () => ({
  withBreaker: async (_name: string, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (error) {
      mocks.breakerFailures.push(error);
      throw error;
    }
  },
  tripBreaker: async () => undefined,
}));

vi.mock("@/src/providers/request-cadence", () => ({
  awaitProviderCadence: mocks.cadence,
}));

/** Sequência de decisões do budget para tentativas opening-closing. */
const budgetAllow: boolean[] = [];
let budgetIdx = 0;

vi.mock("@/src/providers/budget", async () => {
  const { BudgetExhaustedError } = await import("@/src/domain/provider-error");
  return {
    chargeProviderRequest: async (provider: string, label?: string): Promise<void> => {
      if (label === "auth.login") return;
      const allow =
        budgetIdx >= budgetAllow.length ? true : budgetAllow[budgetIdx] !== false;
      budgetIdx += 1;
      if (!allow) throw new BudgetExhaustedError(provider, label);
    },
  };
});

const { BRIDGE_MAX_PAGES_CATALOG, queryOpeningClosing } = await import("@/src/providers/bridgeodds/client");
const { BRIDGEODDS_REQUEST_COOLDOWN_MS } = await import("@/src/providers/bridgeodds/limits");

function mkMatch(id: number): BridgeMatch {
  return {
    match_id: id,
    home: `Home ${id}`,
    away: `Away ${id}`,
    sport: "Futebol",
    league: "Test",
    match_date: "2026-07-10T12:00:00Z",
    home_score: null,
    away_score: null,
  };
}

function pagePayload(page: number, ids: number[], total: number): BridgeQueryPage {
  return {
    count: ids.length,
    page,
    per_page: 100,
    total,
    results: ids.map(mkMatch),
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetchPages(pages: BridgeQueryPage[], afterOpening?: () => void) {
  let openingCalls = 0;
  const fetchMock = vi.fn(async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/api/auth/login")) {
      return jsonResponse({ token: "t-test", expires_in: 3600 });
    }
    const u = new URL(href);
    const page = Number(u.searchParams.get("page") ?? "1");
    openingCalls += 1;
    afterOpening?.();
    const payload = pages[page - 1] ?? pagePayload(page, [], pages[0]?.total ?? 0);
    return jsonResponse(payload);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    openingCallCount: () => openingCalls,
  };
}

beforeEach(() => {
  process.env.BRIDGEODDS_URL = "https://bridge.test";
  process.env.BRIDGEODDS_USER = "u";
  process.env.BRIDGEODDS_PASS = "p";
  resetEnvCacheForTests();
  budgetAllow.length = 0;
  budgetIdx = 0;
  mocks.breakerFailures.length = 0;
  mocks.logWarn.mockClear();
  mocks.cadence.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BRIDGEODDS_URL;
  delete process.env.BRIDGEODDS_USER;
  delete process.env.BRIDGEODDS_PASS;
  resetEnvCacheForTests();
});

describe("queryOpeningClosing — paginação", () => {
  it.each([null, {}, [], { error: "upstream unavailable" }, { results: {} }, { results: [], total: -1 }].map((payload) => [payload]))(
    "envelope 2xx inválido não vira catálogo vazio (%j)", async (payload) => {
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => String(url).includes("/api/auth/login")
        ? jsonResponse({ token: "t-test", expires_in: 3600 }) : jsonResponse(payload)));
      await expect(queryOpeningClosing({ date: "2026-07-10", sport: "Futebol" }))
        .rejects.toMatchObject({ name: "ProviderRequestError", status: 200, billed: true });
    },
  );

  it.each([1, 2, 3])("%i linhas todas inválidas não provam ausência de jogos", async (count) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => String(url).includes("/api/auth/login")
      ? jsonResponse({ token: "t-test", expires_in: 3600 })
      : jsonResponse({ results: Array.from({ length: count }, () => ({ match_id: "inválido" })) })));
    await expect(queryOpeningClosing({ date: "2026-07-10", sport: "Futebol" }))
      .rejects.toMatchObject({ name: "ProviderRequestError", billed: true });
  });

  it("total omitido e última página cheia sinalizam catálogo truncado", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => String(url).includes("/api/auth/login")
      ? jsonResponse({ token: "t-test", expires_in: 3600 })
      : jsonResponse({ results: Array.from({ length: 100 }, (_, i) => mkMatch(i + 1)) })));
    const result = await queryOpeningClosing({ date: "2026-07-10", sport: "Futebol", maxPages: 1 });
    expect(result.matches).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it("total anunciado exige continuar mesmo quando a página veio menor que 100", async () => {
    const { openingCallCount } = stubFetchPages([pagePayload(1, [1], 2), pagePayload(2, [2], 2)]);
    const result = await queryOpeningClosing({ date: "2026-07-10", sport: "Futebol" });
    expect(result.matches.map((row) => row.match_id)).toEqual([1, 2]);
    expect(result.truncated).toBe(false);
    expect(openingCallCount()).toBe(2);
  });

  it("página vazia antes do total anunciado preserva sinal de truncamento", async () => {
    stubFetchPages([pagePayload(1, [1], 2), pagePayload(2, [], 2)]);
    const result = await queryOpeningClosing({ date: "2026-07-10", sport: "Futebol" });
    expect(result.matches.map((row) => row.match_id)).toEqual([1]);
    expect(result.truncated).toBe(true);
  });

  it("prazo vencido durante a espera de cadência adia sem cobrar nem chamar o fornecedor", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { openingCallCount } = stubFetchPages([pagePayload(1, [1], 1)]);
    mocks.cadence.mockImplementationOnce(async () => { clock.mockReturnValue(now + 10_000); });
    try {
      await expect(queryOpeningClosing({ date: "2026-07-10", sport: "Futebol", deadlineMs: now + 5_000 }))
        .rejects.toBeInstanceOf(ProviderCadenceDeferredError);
      expect(budgetIdx).toBe(0);
      expect(openingCallCount()).toBe(0);
    } finally { clock.mockRestore(); mocks.cadence.mockImplementation(async () => undefined); }
  });

  it("esporte divergente não vira candidato da modalidade consultada", async () => {
    const payload = pagePayload(1, [1], 1);
    payload.results[0]!.sport = "Basquete";
    stubFetchPages([payload]);
    await expect(queryOpeningClosing({ date: "2026-07-10", sport: "Futebol" }))
      .rejects.toMatchObject({ name: "ProviderRequestError", billed: true });
  });

  it("aceita alias do mesmo esporte e descarta modalidade divergente no lote", async () => {
    const payload = pagePayload(1, [1, 2, 3, 4, 5], 5);
    payload.results[0]!.sport = "Soccer";
    payload.results[4]!.sport = "Basquete";
    stubFetchPages([payload]);
    const result = await queryOpeningClosing({ date: "2026-07-19", sport: "Futebol" });
    expect(result.matches.map((row) => row.match_id)).toEqual([1, 2, 3, 4]);
    expect(result.truncated).toBe(false);
  });

  it("serializa login e páginas numa cadência global sustentável de 90/h", async () => {
    stubFetchPages([pagePayload(1, [1], 1)]);

    const result = await queryOpeningClosing({ date: "2026-07-10", sport: "Futebol" });

    expect(BRIDGEODDS_REQUEST_COOLDOWN_MS).toBe(40_000);
    expect(result.matches[0]).not.toHaveProperty("home_score");
    expect(result.matches[0]).not.toHaveProperty("away_score");
    expect(mocks.cadence).toHaveBeenCalledWith({
      provider: "bridgeodds",
      route: "global",
      cooldownMs: 40_000,
    });
  });

  it("catálogo cobre o pico medido de 1.074 jogos sem truncar nem repetir a leitura", async () => {
    const total = 1_074;
    const pages = Array.from({ length: Math.ceil(total / 100) }, (_, pageIndex) => {
      const firstId = pageIndex * 100 + 1;
      const count = Math.min(100, total - pageIndex * 100);
      return pagePayload(
        pageIndex + 1,
        Array.from({ length: count }, (_, itemIndex) => firstId + itemIndex),
        total,
      );
    });
    const { openingCallCount } = stubFetchPages(pages);

    const catalog = await queryOpeningClosing({
      date: "2026-08-08",
      sport: "Futebol",
      maxPages: BRIDGE_MAX_PAGES_CATALOG,
    });

    expect(BRIDGE_MAX_PAGES_CATALOG).toBe(15);
    expect(catalog.matches).toHaveLength(total);
    expect(catalog.truncated).toBe(false);
    expect(openingCallCount()).toBe(11);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("total=250 sem filtro: 3 GETs e 250 results", async () => {
    const pages = [
      pagePayload(1, Array.from({ length: 100 }, (_, i) => i + 1), 250),
      pagePayload(2, Array.from({ length: 100 }, (_, i) => i + 101), 250),
      pagePayload(3, Array.from({ length: 50 }, (_, i) => i + 201), 250),
    ];
    const { openingCallCount } = stubFetchPages(pages);

    const all = await queryOpeningClosing({ date: "2026-07-10", sport: "Futebol" });

    expect(all.matches).toHaveLength(250);
    expect(all.truncated).toBe(false);
    expect(openingCallCount()).toBe(3);
  });

  it("filtrado: para no teto 3 mesmo com total maior", async () => {
    const pages = [
      pagePayload(1, Array.from({ length: 100 }, (_, i) => i + 1), 400),
      pagePayload(2, Array.from({ length: 100 }, (_, i) => i + 101), 400),
      pagePayload(3, Array.from({ length: 100 }, (_, i) => i + 201), 400),
      pagePayload(4, Array.from({ length: 100 }, (_, i) => i + 301), 400),
    ];
    const { openingCallCount } = stubFetchPages(pages);

    const all = await queryOpeningClosing({
      date: "2026-07-10",
      sport: "Futebol",
      filters: { home: "France" },
    });

    expect(all.matches).toHaveLength(300);
    expect(all.truncated).toBe(true);
    // O teto de páginas é nosso: a Bridge respondeu, e a resposta não conta como incompleta.
    expect(all.incomplete).toBeUndefined();
    expect(openingCallCount()).toBe(3);
  });

  it("deadline interrompe a paginação entre páginas, não só entre buscas", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const pages = [
      pagePayload(1, Array.from({ length: 100 }, (_, i) => i + 1), 400),
      pagePayload(2, Array.from({ length: 100 }, (_, i) => i + 101), 400),
      pagePayload(3, Array.from({ length: 100 }, (_, i) => i + 201), 400),
    ];
    const { openingCallCount } = stubFetchPages(pages, () => {
      now += 160_000;
    });
    try {
      const result = await queryOpeningClosing({
        date: "2026-07-10",
        sport: "Futebol",
        filters: { home: "Alpha" },
        deadlineMs: 300_000,
      });
      expect(result.matches).toHaveLength(200);
      expect(result.truncated).toBe(true);
      expect(result.incomplete).toBe(true);
      expect(openingCallCount()).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("prazo quase no fim não gasta a cota nem conta falha no circuito", async () => {
    const { fetchMock } = stubFetchPages([pagePayload(1, [1], 1)]);

    const result = await queryOpeningClosing({ date: "2026-07-15", sport: "Futebol", deadlineMs: Date.now() + 500 });

    expect(result).toMatchObject({ matches: [], truncated: true, incomplete: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.breakerFailures).toHaveLength(0);
  });

  it("a vaga do portão precisa caber com folga antes do prazo do chamador", async () => {
    stubFetchPages([pagePayload(1, [1], 1)]);
    const deadlineMs = Date.now() + 60_000;

    await queryOpeningClosing({ date: "2026-07-16", sport: "Futebol", deadlineMs });

    const gateDeadlines = (mocks.cadence.mock.calls as unknown as Array<[{ deadlineMs: number }]>).map(([params]) => params.deadlineMs);
    expect(gateDeadlines.length).toBeGreaterThan(0);
    expect(gateDeadlines.every((gate) => deadlineMs - gate >= 3_000)).toBe(true);
  });

  it("envia os três filtros publicados na documentação oficial", async () => {
    const { fetchMock } = stubFetchPages([pagePayload(1, [1], 1)]);

    await queryOpeningClosing({
      date: "2026-07-10",
      sport: "Futebol",
      filters: { home: "São Paulo", away: "Santos", league: "Brasileirão" },
    });

    const request = fetchMock.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes("/api/odds/opening-closing"));
    expect(request).toBeDefined();
    const query = new URL(request!);
    expect(query.searchParams.get("home")).toBe("São Paulo");
    expect(query.searchParams.get("away")).toBe("Santos");
    expect(query.searchParams.get("league")).toBe("Brasileirão");
    expect(query.searchParams.get("per_page")).toBe("100");
  });

  it("stopWhen: para na página 2 (não chama página 3)", async () => {
    const pages = [
      pagePayload(1, Array.from({ length: 100 }, (_, i) => i + 1), 250),
      pagePayload(2, Array.from({ length: 100 }, (_, i) => i + 101), 250),
      pagePayload(3, Array.from({ length: 50 }, (_, i) => i + 201), 250),
    ];
    const { openingCallCount } = stubFetchPages(pages);

    const all = await queryOpeningClosing({
      date: "2026-07-10",
      sport: "Futebol",
      stopWhen: (acc) => acc.some((m) => m.match_id === 150),
    });

    expect(all.matches.some((m) => m.match_id === 150)).toBe(true);
    expect(openingCallCount()).toBe(2);
    expect(all.matches).toHaveLength(200);
    expect(all.truncated).toBe(false);
  });

  describe("linha fora do contrato descartada na sanitização", () => {
    /** Página cheia na resposta, com a linha `badId` sem liga. */
    function pageWithBadRow(page: number, ids: number[], total: number, badId: number): BridgeQueryPage {
      const payload = pagePayload(page, ids, total);
      return { ...payload, results: payload.results.map((m) => (m.match_id === badId ? { ...m, league: null } : m)) as BridgeMatch[] };
    }

    it("não encerra a paginação nem esconde o resto do dia", async () => {
      const pages = [
        pageWithBadRow(1, Array.from({ length: 100 }, (_, i) => i + 1), 150, 7),
        pagePayload(2, Array.from({ length: 50 }, (_, i) => i + 101), 150),
      ];
      const { openingCallCount } = stubFetchPages(pages);

      const all = await queryOpeningClosing({ date: "2026-07-10", sport: "Futebol" });

      expect(openingCallCount()).toBe(2);
      expect(all.matches).toHaveLength(149);
      expect(all.matches.some((m) => m.match_id === 7)).toBe(false);
      expect(all.truncated).toBe(false);
      expect(mocks.logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ descartadas: 1, date: "2026-07-10", sport: "Futebol" }),
        expect.stringContaining("descartad"),
      );
    });

    it("busca por id acha o jogo da página seguinte", async () => {
      const pages = [
        pageWithBadRow(1, Array.from({ length: 100 }, (_, i) => i + 1), 150, 7),
        pagePayload(2, Array.from({ length: 50 }, (_, i) => i + 101), 150),
      ];
      stubFetchPages(pages);

      const all = await queryOpeningClosing({
        date: "2026-07-11",
        sport: "Futebol",
        stopWhen: (acc) => acc.some((m) => m.match_id === 120),
      });

      expect(all.matches.some((m) => m.match_id === 120)).toBe(true);
    });

    it("última página cheia fecha o total sem pedir uma página vazia a mais", async () => {
      const pages = [
        pageWithBadRow(1, Array.from({ length: 100 }, (_, i) => i + 1), 200, 7),
        pagePayload(2, Array.from({ length: 100 }, (_, i) => i + 101), 200),
      ];
      const { openingCallCount } = stubFetchPages(pages);

      const all = await queryOpeningClosing({ date: "2026-07-12", sport: "Futebol", maxPages: 2 });

      expect(openingCallCount()).toBe(2);
      expect(all.matches).toHaveLength(199);
      // O teto de páginas não trunca o que a Bridge já respondeu inteiro.
      expect(all.truncated).toBe(false);
    });
  });

  describe("formato dos mercados", () => {
    const priced = (id: number, overrides: Record<string, unknown> = {}) => ({
      ...mkMatch(id),
      moneyline: { opening: { home: 2.1, draw: 3.3, away: 3.6, max_bet: 125 }, closing: { home: 2, draw: 3.4, away: 3.9 } },
      spread: [{ hdp_points: -0.5, opening: { home: 2.1, away: 1.8 }, closing: { home: 2, away: 1.9, max_bet: 200 } }],
      total: [{ hdp_points: 2.5, closing: { over: 1.9, under: 1.95 } }],
      ...overrides,
    }) as unknown as BridgeMatch;
    const page = (results: BridgeMatch[]): BridgeQueryPage =>
      ({ count: results.length, page: 1, per_page: 100, total: results.length, results });

    it("preço que não é número reprova a partida, e a fase ainda sem preço fica sem preço", async () => {
      stubFetchPages([page([
        priced(1),
        priced(2, { spread: { "-0.5": { home: 2, away: 1.9 } } }),
        priced(3, { moneyline: { closing: { home: "2.00", draw: 3.4, away: 3.9 } } }),
        priced(4, { moneyline: { opening: { home: 2.1, draw: null, away: 3.6 }, closing: { home: null, away: null } }, total: null }),
        priced(5),
      ])]);

      const all = await queryOpeningClosing({ date: "2026-07-13", sport: "Futebol" });

      expect(all.matches.map((m) => m.match_id)).toEqual([1, 4, 5]);
      const { moneyline, spread, total } = priced(1);
      expect(all.matches[0]).toMatchObject({ moneyline, spread, total });
      expect(all.matches[1]).toMatchObject({ moneyline: { opening: { home: 2.1, away: 3.6 } } });
      expect(all.matches[1]!.moneyline).not.toHaveProperty("closing");
      expect(all.matches[1]!.moneyline!.opening).not.toHaveProperty("draw");
      expect(all.matches[1]).not.toHaveProperty("total");
    });

    it("a maioria das partidas fora do contrato é falha da consulta, não dia sem o jogo", async () => {
      const renamed = (id: number) => priced(id, { total: [{ line: 2.5, closing: { over: 1.9, under: 1.95 } }] });
      stubFetchPages([page([priced(1), renamed(2), renamed(3), renamed(4)])]);

      await expect(queryOpeningClosing({ date: "2026-07-14", sport: "Futebol" }))
        .rejects.toThrow("payload fora do contrato esperado");
      // Conta no circuito: é o serviço respondendo noutro formato.
      expect(mocks.breakerFailures).toHaveLength(1);
      expect(mocks.logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ eventCode: "PROVIDER_CONTRACT_INVALID", provider: "bridgeodds", rejected: 3, total: 4 }),
        expect.any(String),
      );
    });
  });

  it("budget esgotado na página 2: devolve só página 1", async () => {
    const pages = [
      pagePayload(1, Array.from({ length: 100 }, (_, i) => i + 1), 250),
      pagePayload(2, Array.from({ length: 100 }, (_, i) => i + 101), 250),
    ];
    const { openingCallCount } = stubFetchPages(pages);
    budgetAllow.push(true, false);

    const all = await queryOpeningClosing({ date: "2026-07-10", sport: "Futebol" });

    expect(all.matches).toHaveLength(100);
    expect(all.truncated).toBe(true);
    expect(all.incomplete).toBe(true);
    expect(openingCallCount()).toBe(1);
    expect(mocks.logWarn).toHaveBeenCalledOnce();

    budgetAllow.push(true, false);
    await queryOpeningClosing({ date: "2026-07-11", sport: "Futebol" });
    expect(mocks.logWarn).toHaveBeenCalledOnce();
  });

  it("budget esgotado antes da página 1: sinaliza truncamento sem chamar a API", async () => {
    const { openingCallCount } = stubFetchPages([pagePayload(1, [1], 1)]);
    budgetAllow.push(false);

    const result = await queryOpeningClosing({ date: "2026-07-10", sport: "Futebol" });

    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(openingCallCount()).toBe(0);
  });

  it.each([[400, 0], [404, 0], [422, 0], [500, 1], [401, 1], [429, 1]])(
    "HTTP %i na consulta conta %i falha no circuito da Bridge",
    async (status, falhas) => {
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => String(url).includes("/api/auth/login")
        ? jsonResponse({ token: "t-test", expires_in: 3600 })
        : jsonResponse({ error: "recusada" }, status)));

      await expect(queryOpeningClosing({ date: "2026-07-10", sport: "Futebol", deadlineMs: Date.now() + 60_000 }))
        .rejects.toMatchObject({ name: "ProviderRequestError", status });
      // 4xx é recusa da consulta: a Bridge respondeu, e o circuito não conta.
      expect(mocks.breakerFailures).toHaveLength(falhas);
    },
  );

  it("401 atrasado de outra consulta não invalida o token já renovado", async () => {
    let releaseDelayed!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => { releaseDelayed = resolve; });
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    let firstAuthorization: string | undefined;
    let oldRequests = 0;
    let loginCalls = 0;
    const accepted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/api/auth/login")) {
        loginCalls += 1;
        return jsonResponse({ token: `concurrent-renewed-${loginCalls}`, expires_in: 3600 });
      }
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      firstAuthorization ??= authorization;
      if (authorization === firstAuthorization) {
        oldRequests += 1;
        if (oldRequests === 1) {
          await started;
          return jsonResponse({}, 401);
        }
        bothStarted();
        return delayed;
      }
      accepted.push(authorization);
      return jsonResponse(pagePayload(1, [1], 1));
    }));

    const first = queryOpeningClosing({ date: "2026-07-10", sport: "Futebol" });
    const second = queryOpeningClosing({ date: "2026-07-11", sport: "Futebol" });
    await first;
    const loginsAfterRefresh = loginCalls;
    releaseDelayed(jsonResponse({}, 401));
    await second;

    expect(oldRequests).toBe(2);
    expect(accepted).toHaveLength(2);
    expect(accepted[1]).toBe(accepted[0]);
    expect(loginCalls).toBe(loginsAfterRefresh);
  });

  it("página seguinte reutiliza token renovado após 401", async () => {
    let loginCalls = 0;
    let rejectedFirstPage = false;
    let acceptedAuthorization = "";
    let secondPageAuthorization = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/auth/login")) {
        loginCalls += 1;
        return jsonResponse({ token: `renewed-${loginCalls}`, expires_in: 3600 });
      }
      const page = Number(new URL(href).searchParams.get("page") ?? "1");
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      if (page === 1 && !rejectedFirstPage) {
        rejectedFirstPage = true;
        return jsonResponse({}, 401);
      }
      if (page === 1) acceptedAuthorization = authorization;
      if (page === 2) secondPageAuthorization = authorization;
      const payload = page === 1
        ? pagePayload(1, Array.from({ length: 100 }, (_, i) => i + 1), 150)
        : pagePayload(2, Array.from({ length: 50 }, (_, i) => i + 101), 150);
      return jsonResponse(payload);
    }));

    const all = await queryOpeningClosing({ date: "2026-07-12", sport: "Futebol" });

    expect(all.matches).toHaveLength(150);
    expect(secondPageAuthorization).toBe(acceptedAuthorization);
    expect(secondPageAuthorization).toMatch(/^Bearer renewed-/);
    expect(loginCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("queryOpeningClosing — retomada das páginas de identidade", () => {
  let now: number;
  const pages: number[] = [];
  const match = (id: number) => ({ match_id: id, home: `Home ${id}`, away: `Away ${id}`,
    sport: "Futebol", league: "Test", match_date: "2026-09-14T20:00:00Z" });
  const params = { date: "2026-09-14", sport: "Futebol", filters: { home: "Home" }, resumeIdentityPages: true };

  beforeEach(() => {
    now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.cacheRows.clear();
    pages.length = 0;
    mocks.cacheRead.mockReset().mockImplementation(async ({ key }: { key: string }) => mocks.cacheRows.get(key) ?? null);
    mocks.cacheWrite.mockReset().mockImplementation(async ({ key, data }: { key: string; data: unknown }) => {
      mocks.cacheRows.set(key, { data: JSON.parse(JSON.stringify(data)) });
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/auth/login")) return Response.json({ token: "synthetic", expires_in: 3600 });
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      return Response.json({ results: page === 1 ? Array.from({ length: 100 }, (_, i) => match(i + 1)) : [match(101)], total: 101 });
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.cadence.mockReset();
  });

  it("retoma na segunda página após adiamento, preservando o relógio da primeira", async () => {
    const firstTime = now;
    mocks.cadence.mockImplementation(async () => {
      if (pages.length === 1) throw new ProviderCadenceDeferredError("bridgeodds", new Date(now + 40_000));
    });
    await expect(queryOpeningClosing({ ...params, deadlineMs: now + 5_000 })).rejects.toBeInstanceOf(ProviderCadenceDeferredError);
    expect(pages).toEqual([1]);
    now += 80_000;
    mocks.cadence.mockResolvedValue(undefined);
    const result = await queryOpeningClosing({ ...params, deadlineMs: now + 5_000 });
    expect(pages).toEqual([1, 2]);
    expect(result.matches).toHaveLength(101);
    expect(result.truncated).toBe(false);
    expect(result.observedAtByMatchId).toMatchObject({ "1": firstTime, "101": now });
  });

  it("leitura por ID de preço/fechamento ignora páginas de identidade", async () => {
    await queryOpeningClosing({ ...params, deadlineMs: now + 5_000 });
    expect(mocks.cacheRows.size).toBe(2);
    mocks.cacheRead.mockClear();
    await queryOpeningClosing({ ...params, deadlineMs: now + 5_000, stopWhen: (rows) => rows.some((row) => row.match_id === 1) });
    expect(pages).toEqual([1, 2, 1]);
    expect(mocks.cacheRead).not.toHaveBeenCalled();
  });

  it("deadline após página lida permite retomada sem cachear catálogo parcial", async () => {
    const deadline = now + 5_000;
    mocks.cacheWrite.mockImplementation(async ({ key, data }: { key: string; data: unknown }) => {
      mocks.cacheRows.set(key, { data: JSON.parse(JSON.stringify(data)) });
      now += 6_000;
    });
    await expect(queryOpeningClosing({ ...params, deadlineMs: deadline })).rejects.toBeInstanceOf(ProviderCadenceDeferredError);
    expect(pages).toEqual([1]);
    await expect(queryOpeningClosing({ ...params, deadlineMs: now + 5_000 })).resolves.toMatchObject({ truncated: false });
    expect(pages).toEqual([1, 2]);
  });
});
