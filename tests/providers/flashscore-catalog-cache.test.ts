import type { FlashscoreTournamentGroup } from "@/src/providers/flashscore/types";
import { readProviderCache, writeProviderCache } from "@/src/providers/provider-cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFlashscoreCatalogCache,
  clearFlashscoreCatalogMemoryCache,
  getFlashscoreCatalog,
} from "@/src/providers/flashscore/catalog";

const providerCache = vi.hoisted(() => new Map<string, {
  data: unknown;
  fetchedAt: Date;
  expiresAt: Date;
}>());

vi.mock("@/src/providers/provider-cache", () => ({
  readProviderCache: vi.fn(async (params: { provider: string; key: string; now?: Date }) => {
    const row = providerCache.get(`${params.provider}:${params.key}`);
    if (!row || row.expiresAt <= (params.now ?? new Date())) return null;
    return { ...row, stale: false };
  }),
  writeProviderCache: vi.fn(async (params: {
    provider: string;
    key: string;
    data: unknown;
    ttlMs: number;
    now?: Date;
  }) => {
    const now = params.now ?? new Date();
    providerCache.set(`${params.provider}:${params.key}`, {
      data: params.data,
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + params.ttlMs),
    });
  }),
  deleteProviderCache: async (params: { provider: string; keyPrefix?: string }) => {
    for (const key of providerCache.keys()) {
      const prefix = `${params.provider}:${params.keyPrefix ?? ""}`;
      if (key.startsWith(prefix)) providerCache.delete(key);
    }
  },
}));

const groups: FlashscoreTournamentGroup[] = [{
  tournament_id: "league-test", name: "Liga de teste", country_name: "Brasil",
  matches: Array.from({ length: 300 }, (_, index) => ({
    match_id: `match-${index + 1}`,
    timestamp: 1_790_000_000,
    home_team: { team_id: `home-${index + 1}`, name: `Mandante ${index + 1}` },
    away_team: { team_id: `away-${index + 1}`, name: `Visitante ${index + 1}` },
    scores: { home: null, away: null },
    match_status: { stage: null, is_cancelled: false, is_postponed: false,
      is_started: false, is_in_progress: false, is_finished: false },
  })),
}];

describe("cache do catálogo FlashScore", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    providerCache.clear();
    await clearFlashscoreCatalogCache();
  });

  it("expira resultado negativo após um minuto", async () => {
    let now = 1_000;
    const fetch = vi.fn(async () => null);

    await getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => now });
    now += 59_000;
    await getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => now });
    expect(fetch).toHaveBeenCalledOnce();

    now += 1_001;
    await getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => now });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("expira catálogo positivo antes do próximo ciclo de resultados", async () => {
    let now = 1_000;
    const fetch = vi.fn(async () => []);

    await getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => now });
    now += 8 * 60_000 + 59_000;
    await getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => now });
    expect(fetch).toHaveBeenCalledOnce();

    now += 1_001;
    await getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => now });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("L1 limitado pode evictar sem perder o catálogo persistente compartilhado", async () => {
    const fetch = vi.fn(async () => []);
    for (let day = 1; day <= 65; day += 1) {
      await getFlashscoreCatalog(`2026-06-${String(day).padStart(2, "0")}`, 1, {
        fetch,
        now: () => 1_000,
      });
    }
    expect(fetch).toHaveBeenCalledTimes(65);

    await getFlashscoreCatalog("2026-06-01", 1, { fetch, now: () => 1_000 });
    expect(fetch).toHaveBeenCalledTimes(65);
  });

  it("compartilha o catálogo persistido após descartar o L1 do processo", async () => {
    const fetch = vi.fn(async () => []);
    await getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => 1_000 });
    clearFlashscoreCatalogMemoryCache();

    await expect(getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => 2_000 }))
      .resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([false, true])("100 consumidores compartilham uma leitura persistente (aquecido=%s)", async (warm) => {
    const fetch = vi.fn(async () => groups);
    if (warm) {
      await getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => 1_000 });
      clearFlashscoreCatalogMemoryCache();
      vi.mocked(readProviderCache).mockClear();
    }
    const catalogs = await Promise.all(Array.from({ length: 100 }, () =>
      getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => 2_000 })));

    expect(catalogs[0]).toHaveLength(300);
    expect(catalogs[0]?.[0]?.match_id).toBe("match-1");
    expect(catalogs.every((catalog) => catalog === catalogs[0])).toBe(true);
    expect(readProviderCache).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("falha de persistência conserva a resposta e não repete chamada cobrada", async () => {
    const fetch = vi.fn(async () => []);
    vi.mocked(writeProviderCache).mockRejectedValueOnce(new Error("cache indisponível"));

    await expect(getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => 1_000 }))
      .resolves.toEqual([]);
    await expect(getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => 2_000 }))
      .resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(providerCache.size).toBe(0);
  });

  it("libera uma leitura compartilhada que falhou para tentar novamente", async () => {
    const fetch = vi.fn(async () => []);
    const error = new Error("leitura indisponível");
    vi.mocked(readProviderCache).mockRejectedValueOnce(error);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
      getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => 1_000 })));

    expect(results.every((result) => result.status === "rejected" && result.reason === error)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    await expect(getFlashscoreCatalog("2026-08-02", 1, { fetch, now: () => 1_001 }))
      .resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
