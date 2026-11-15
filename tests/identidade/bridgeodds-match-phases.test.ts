import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_TRUNCATED_CACHE_TTL_MS,
  bridgeCatalogCacheKey,
  clearBridgeCatalogCache,
} from "@/src/providers/bridgeodds/catalog";
import { findBridgeMatch, findBridgeMatchByIdWithEvidence } from "@/src/providers/bridgeodds/match";
import type { BridgeMatch } from "@/src/providers/bridgeodds/types";
import { BudgetExhaustedError, ProviderCadenceDeferredError } from "@/src/domain/provider-error";

// Catálogo é cache de processo: sem limpar entre casos, um teste reaproveita a
// leitura do anterior e a contagem de GETs deixa de medir nada.
beforeEach(() => clearBridgeCatalogCache());

function match(over: Partial<BridgeMatch> & { home: string; away: string }): BridgeMatch {
  return {
    match_id: over.match_id ?? 1,
    home: over.home,
    away: over.away,
    sport: "Futebol",
    league: "Test",
    match_date: over.match_date ?? "2026-07-10T12:00:00Z",
    home_score: null,
    away_score: null,
  };
}

describe("findBridgeMatch — busca filtrada e cache de identidade", () => {
  const kickoff = new Date("2026-07-10T12:00:00Z");

  it("retoma a busca interrompida pela cadência sem refazer o filtro já concluído", async () => {
    const retryAt = new Date(Date.now() + 40_000);
    const query = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new ProviderCadenceDeferredError("bridgeodds", retryAt));
    const params = { home: "Palmeiras", away: "Santos", bridgeSport: "Futebol", kickoffUtc: kickoff, query, maxSearchDurationMs: 5_000 };
    const paused = await findBridgeMatch(params);
    expect(paused).toMatchObject({ ok: false, reason: "search_budget", nextSearchAt: 1, retryAt });
    query.mockResolvedValueOnce([match({ home: "Palmeiras", away: "Santos" })]);
    const resumed = await findBridgeMatch({ ...params, startSearchAt: 1 });
    expect(resumed.ok).toBe(true);
    expect(query.mock.calls).toHaveLength(3);
    expect(query.mock.calls[2]![0].filters).toEqual({ home: "palmeiras" });
  });

  it("gera chave persistente inequívoca sem byte NUL", () => {
    const key = bridgeCatalogCacheKey({
      sport: "Futebol",
      date: "2026-07-10",
      filters: { home: "A\u0000B", away: "C:D", league: "Liga" },
    });
    const anotherKey = bridgeCatalogCacheKey({
      sport: "Futebol",
      date: "2026-07-10",
      filters: { home: "A", away: "B:C:D", league: "Liga" },
    });

    expect(key).toMatch(/^v3:/);
    expect(key).not.toContain("\u0000");
    expect(key).not.toBe(anotherKey);
  });

  it("miss com kickoff confiável: 1 GET no dia e vizinhos UTC", async () => {
    const calls: Array<{ date: string; filters?: unknown }> = [];
    const query = vi.fn(async (p: unknown) => {
      calls.push(p as { date: string; filters?: unknown });
      return [];
    });
    const found = await findBridgeMatch({
      home: "Central Coast Mariners",
      away: "Blacktown Spartans",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
    });
    expect(found.ok).toBe(false);

    // Dia âncora exato, dois lados relaxados e vizinhos exatos: teto de 5.
    expect(calls.length).toBe(5);
    expect([...new Set(calls.map((c) => c.date))].sort()).toEqual([
      "2026-07-09", "2026-07-10", "2026-07-11",
    ]);
    for (const call of calls) expect(call.filters).toBeDefined();
    expect(calls.slice(0, 3).every((call) => call.date === "2026-07-10")).toBe(true);
    for (const index of [0, 3, 4]) {
      const filters = calls[index]!.filters as { home?: string; away?: string };
      expect(Boolean(filters.home && filters.away)).toBe(true);
    }
  });

  it("a mesma identidade é reaproveitada sem nova chamada", async () => {
    const query = vi.fn(async () => [
      match({ match_id: 10, home: "Palmeiras", away: "Santos" }),
      match({ match_id: 11, home: "Flamengo", away: "Vasco" }),
    ]);

    const primeira = await findBridgeMatch({
      home: "Palmeiras", away: "Santos", bridgeSport: "Futebol",
      kickoffUtc: kickoff, query: query as never,
    });
    const chamadasApos1 = query.mock.calls.length;

    const segunda = await findBridgeMatch({
      home: "Palmeiras", away: "Santos", bridgeSport: "Futebol",
      kickoffUtc: kickoff, query: query as never,
    });

    expect(primeira.ok).toBe(true);
    expect(segunda.ok).toBe(true);
    // Revival/reprocess da mesma identidade usa a resposta em memória.
    expect(query.mock.calls.length).toBe(chamadasApos1);
  });

  it("duas buscas concorrentes da mesma identidade compartilham um único GET", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const query = vi.fn(async () => {
      await gate;
      return [match({ match_id: 12, home: "Palmeiras", away: "Santos" })];
    });
    const params = {
      home: "Palmeiras",
      away: "Santos",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
    };

    const first = findBridgeMatch(params);
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    const second = findBridgeMatch(params);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(query).toHaveBeenCalledOnce();
  });

  it("hit forte no dia 0: early-exit (1 GET, sem varrer o resto da janela)", async () => {
    const query = vi.fn(async () => [
      match({
        match_id: 42,
        home: "Central Coast Mariners",
        away: "Blacktown Spartans",
        match_date: "2026-07-10T12:00:00Z",
      }),
    ]);
    const found = await findBridgeMatch({
      home: "Central Coast Mariners",
      away: "Blacktown Spartans",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
    });
    expect(found.ok).toBe(true);
    expect(query.mock.calls.length).toBe(1);
  });

  it("busca exata vazia relaxa um lado no dia âncora", async () => {
    const query = vi.fn(async (p: { filters?: { home?: string; away?: string } }) => {
      if (p.filters?.home && p.filters.away) {
        return { matches: [], truncated: false };
      }
      return {
        matches: [
          match({
            match_id: 99,
            home: "Central Coast Mariners",
            away: "Blacktown Spartans",
          }),
        ],
        truncated: false,
      };
    });
    const found = await findBridgeMatch({
      home: "Central Coast Mariners",
      away: "Blacktown Spartans",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
    });
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.best.match.match_id).toBe(99);
    expect(query.mock.calls.some((c) => (c[0] as { filters?: unknown }).filters)).toBe(true);
  });

  it("cai para a grafia alternativa da identidade antes de declarar miss", async () => {
    // A aposta veio com o apelido do tipster ("Verdao") e nenhuma tradução foi
    // eleita; a grafia Pinnacle da MESMA identidade está no banco. Sem usá-la,
    // isto vira miss, caso de treino e aposta sem preço.
    const query = vi.fn(async (p: { filters?: { home?: string; away?: string } }) => {
      if (p.filters?.home === "palmeiras") {
        return {
          matches: [match({ match_id: 77, home: "Palmeiras", away: "Flamengo" })],
          truncated: false,
        };
      }
      return { matches: [], truncated: false };
    });

    const semAlternativa = await findBridgeMatch({
      home: "Verdao",
      away: "Flamengo RJ",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
    });
    expect(semAlternativa.ok).toBe(false);

    clearBridgeCatalogCache();
    const comAlternativa = await findBridgeMatch({
      home: "Verdao",
      away: "Flamengo RJ",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
      homeAlternatives: ["Palmeiras SP"],
    });
    expect(comAlternativa.ok).toBe(true);
    if (comAlternativa.ok) expect(comAlternativa.best.match.match_id).toBe(77);
  });

  it("adia grafias alternativas para o fallback sem gravar miss falso", async () => {
    const query = vi.fn(async (p: { filters?: { home?: string } }) => {
      if (p.filters?.home === "palmeiras") {
        return {
          matches: [match({ match_id: 78, home: "Palmeiras", away: "Flamengo" })],
          truncated: false,
        };
      }
      return { matches: [], truncated: false };
    });

    const adiado = await findBridgeMatch({
      home: "Verdao",
      away: "Flamengo RJ",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
      homeAlternatives: ["Palmeiras SP"],
      alternativeNameMode: "deferred",
    });
    expect(adiado).toMatchObject({ ok: false, reason: "deferred_alternatives" });
    expect(query).toHaveBeenCalledTimes(5);

    clearBridgeCatalogCache();
    const revival = await findBridgeMatch({
      home: "Verdao",
      away: "Flamengo RJ",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
      homeAlternatives: ["Palmeiras SP"],
    });
    expect(revival.ok).toBe(true);
  });

  it("interrompe a fase Bridge entre tentativas ao esgotar o orçamento", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const query = vi.fn(async () => {
      now += 160_000;
      return { matches: [], truncated: false };
    });
    try {
      const found = await findBridgeMatch({
        home: "Alpha",
        away: "Bravo",
        bridgeSport: "Futebol",
        kickoffUtc: kickoff,
        query: query as never,
        maxSearchDurationMs: 300_000,
      });
      expect(found).toMatchObject({ ok: false, reason: "search_budget" });
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("data a observação quando a resposta chega, após a espera da cadência", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const query = vi.fn(async () => {
      now += 80_000;
      return {
        matches: [match({ match_id: 79, home: "Alpha", away: "Bravo" })],
        truncated: false,
      };
    });
    try {
      const found = await findBridgeMatch({
        home: "Alpha",
        away: "Bravo",
        bridgeSport: "Futebol",
        kickoffUtc: kickoff,
        query: query as never,
      });
      expect(found.ok).toBe(true);
      if (found.ok) {
        expect(found.stalePrices).toBe(false);
        expect(found.priceObservedAt.getTime()).toBe(80_000);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("não gasta consulta com alternativa quando já há candidato", async () => {
    const query = vi.fn(async () => ({
      matches: [match({ match_id: 5, home: "Palmeiras SP", away: "Flamengo RJ" })],
      truncated: false,
    }));
    const found = await findBridgeMatch({
      home: "Palmeiras SP",
      away: "Flamengo RJ",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
      homeAlternatives: ["Palmeiras"],
    });
    expect(found.ok).toBe(true);
    // Early-exit do hit forte: a alternativa nem é considerada.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("busca truncada é reaproveitada no debounce e relida depois", async () => {
    const now = Date.parse("2026-07-10T12:00:00.000Z");
    const query = vi.fn(async () => ({ matches: [], truncated: true }));
    await findBridgeMatch({
      home: "A", away: "B", bridgeSport: "Futebol",
      kickoffUtc: kickoff, query: query as never, now,
    });
    const primeiraRodada = query.mock.calls.length;
    await findBridgeMatch({
      home: "A", away: "B", bridgeSport: "Futebol",
      kickoffUtc: kickoff, query: query as never, now: now + 10_000,
    });
    const noDebounce = query.mock.calls.length;
    expect(noDebounce).toBe(primeiraRodada);

    await findBridgeMatch({
      home: "A", away: "B", bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
      now: now + BRIDGE_TRUNCATED_CACHE_TTL_MS + 1,
    });
    const depoisDoDebounce = query.mock.calls.length;
    expect(depoisDoDebounce).toBeGreaterThan(primeiraRodada);
  });

  it("kickoff provisório também limita catálogos ao dia e vizinhos", async () => {
    const calls: Array<{ date: string }> = [];
    const query = vi.fn(async (p: unknown) => {
      calls.push(p as { date: string });
      return [];
    });
    await findBridgeMatch({
      home: "Central Coast Mariners",
      away: "Blacktown Spartans",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      skipKickoffWindow: true,
      query: query as never,
    });
    expect([...new Set(calls.map((c) => c.date))]).toEqual([
      "2026-07-10", "2026-07-11", "2026-07-09",
    ]);
  });

  it("skipKickoffWindow ignora distância horária, mas não compra datas remotas", async () => {
    const query = vi.fn(async (params: { date: string }) =>
      params.date === "2026-07-15"
        ? [
            match({
              match_id: 7,
              home: "Rodez",
              away: "Bastia",
              match_date: "2026-07-15T18:00:00Z", // +5d do âncora
            }),
          ]
        : [],
    );
    const withWindow = await findBridgeMatch({
      home: "Rodez",
      away: "Bastia",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
    });
    expect(withWindow.ok).toBe(false);

    clearBridgeCatalogCache();
    query.mockClear();
    const calendar = await findBridgeMatch({
      home: "Rodez",
      away: "Bastia",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      skipKickoffWindow: true,
      query: query as never,
    });
    expect(calendar.ok).toBe(false);
  });
});

describe("findBridgeMatch — retomada e candidatos para o juiz", () => {
  const kickoffUtc = new Date("2026-09-14T20:00:00Z");
  // Nome curto do tipster fora do dicionário: candidato fraco, para o juiz.
  const candidate = { match_id: 123, home: "Alianza Valledupar", away: "Junior de Barranquilla",
    league: "Colombia - Primera A", sport: "Futebol", match_date: kickoffUtc.toISOString() };
  const input = { home: "Alianza FC", away: "Junior de Barranquilla", bridgeSport: "Futebol", kickoffUtc };

  it("entrega candidato fraco ao juiz depois da primeira resposta completa", async () => {
    const query = vi.fn(async () => [candidate]);
    const found = await findBridgeMatch({ ...input, query, stopAtCandidates: true });
    expect(query).toHaveBeenCalledOnce();
    expect(found).toMatchObject({ ok: true, resume: { nextSearchAt: 1 } });
    if (!found.ok) throw new Error("fixture");
    expect(found.best.score).toBeLessThan(1.5);
  });

  it("retém candidatos e relógio por JSON, sem transformar preço antigo em fresco", async () => {
    const observedAt = Date.now() - 120_000;
    const query = vi.fn().mockResolvedValueOnce([candidate]).mockRejectedValueOnce(new ProviderCadenceDeferredError("bridgeodds", new Date()));
    const paused = await findBridgeMatch({ ...input, query, now: observedAt });
    expect(paused).toMatchObject({ ok: false, reason: "search_budget", resume: { nextSearchAt: 1 } });
    clearBridgeCatalogCache();
    query.mockResolvedValue([]);
    const result = await findBridgeMatch({ ...input, query, resume: JSON.parse(JSON.stringify(paused.resume)) });
    expect(result).toMatchObject({ ok: true, best: { match: { match_id: 123 } }, stalePrices: true, priceObservedAt: new Date(observedAt) });
    expect(query.mock.calls[2]![0].filters).toEqual({ home: "alianza" });
  });

  it("alteração de adversário invalida cursor e candidatos anteriores", async () => {
    const query = vi.fn().mockResolvedValueOnce([candidate]);
    const first = await findBridgeMatch({ ...input, query, stopAtCandidates: true });
    clearBridgeCatalogCache(); query.mockResolvedValue([]);
    const next = await findBridgeMatch({ ...input, away: "River Plate", query, resume: first.resume });
    expect(next).toMatchObject({ ok: false, candidates: [] });
    expect(query.mock.calls[1]![0].filters).toEqual({ home: "alianza", away: "river" });
  });

  it("catálogo parcial não vira confirmação automática nem ausência comprovada", async () => {
    const query = vi.fn(async () => ({ matches: [{ ...candidate, home: input.home, away: input.away }], truncated: true }));
    await expect(findBridgeMatch({ ...input, query, stopAtCandidates: true })).resolves.toMatchObject({ ok: false, reason: "truncated" });
  });

  it("paginação concluída agora não renova o preço de uma página antiga", async () => {
    const observedAt = Date.now() - 120_000;
    const query = vi.fn(async () => ({ matches: [candidate], truncated: false, observedAtByMatchId: { "123": observedAt } }));
    await expect(findBridgeMatch({ ...input, query, stopAtCandidates: true })).resolves.toMatchObject({
      ok: true, stalePrices: true, priceObservedAt: new Date(observedAt),
    });
  });
});

const findById = async (params: Parameters<typeof findBridgeMatchByIdWithEvidence>[0]) =>
  (await findBridgeMatchByIdWithEvidence(params))?.match ?? null;

describe("findBridgeMatchByIdWithEvidence — fallback sem filtro", () => {
  const kickoff = new Date("2026-07-10T12:00:00Z");

  it("filtro miss + unfiltered hit no mesmo dia", async () => {
    const target = match({ match_id: 99, home: "France", away: "Morocco" });
    const query = vi.fn(async (p: { filters?: { home?: string } }) => {
      if (p.filters?.home) return [match({ match_id: 1, home: "Frankfurt", away: "Away FC" })];
      return [target];
    });
    const found = await findById({
      providerMatchId: "99",
      searchWord: "France",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
    });
    expect(found?.match_id).toBe(99);
    expect(query.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("hit no filtro: não faz query sem filtro", async () => {
    const target = match({ match_id: 42, home: "France", away: "Morocco" });
    const query = vi.fn(async () => [target]);
    const found = await findById({
      providerMatchId: "42",
      searchWord: "France",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
    });
    expect(found?.match_id).toBe(42);
    expect(query.mock.calls.length).toBe(1);
  });

  it("passa stopWhen por match_id nas queries", async () => {
    const target = match({ match_id: 99, home: "France", away: "Morocco" });
    const query = vi.fn(async (p: { stopWhen?: (all: BridgeMatch[]) => boolean }) => {
      expect(typeof p.stopWhen).toBe("function");
      expect(p.stopWhen?.([target])).toBe(true);
      expect(p.stopWhen?.([match({ match_id: 1, home: "Home FC", away: "Away FC" })])).toBe(false);
      return [target];
    });
    const found = await findById({
      providerMatchId: "99",
      searchWord: "France",
      bridgeSport: "Futebol",
      kickoffUtc: kickoff,
      query: query as never,
    });
    expect(found?.match_id).toBe(99);
  });

  it("modo cheap usa o dia UTC do contrato BridgeOdds", async () => {
    const query = vi.fn(async () => []);
    await findById({
      providerMatchId: "99",
      searchWord: "France",
      bridgeSport: "Futebol",
      kickoffUtc: new Date("2026-07-10T01:00:00Z"),
      query: query as never,
      mode: "cheap",
    });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-07-10" }));
  });

  it("prazo vencido: não pede página nova, e quem exige resposta completa não recebe 'não achou'", async () => {
    const query = vi.fn(async () => []);
    const params = {
      providerMatchId: "99", searchWord: "France", bridgeSport: "Futebol", kickoffUtc: kickoff,
      query: query as never, deadlineMs: Date.now() - 1,
    };
    await expect(findById(params)).resolves.toBeNull();
    await expect(findById({ ...params, requireComplete: true })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(query).not.toHaveBeenCalled();
  });
});
