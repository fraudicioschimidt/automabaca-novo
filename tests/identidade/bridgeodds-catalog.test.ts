import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearBridgeCatalogCache,
  getBridgeDayCatalog,
} from "@/src/providers/bridgeodds/catalog";
import type { BridgeMatch } from "@/src/providers/bridgeodds/types";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/src/providers/provider-cache", () => ({
  readProviderCache: mocks.read,
  writeProviderCache: mocks.write,
}));
vi.mock("@/src/providers/bridgeodds/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/providers/bridgeodds/client")>(),
  queryOpeningClosing: mocks.query,
}));

const matches: BridgeMatch[] = Array.from({ length: 300 }, (_, index) => ({
  match_id: index + 1,
  sport: "Futebol",
  league: "Brasil - Liga de teste",
  home: `Mandante ${index + 1}`,
  away: `Visitante ${index + 1}`,
  match_date: "2026-10-11T20:00:00Z",
}));
const params = { sport: "Futebol", date: "2026-10-11", filters: { league: "Liga de teste" } };

type CacheRow = { data: unknown; fetchedAt: Date; expiresAt: Date };
const rows = new Map<string, CacheRow>();

beforeEach(() => {
  clearBridgeCatalogCache();
  rows.clear();
  mocks.read.mockReset().mockImplementation(async ({ key, now }: { key: string; now: Date }) => {
    const row = rows.get(key);
    return row && row.expiresAt > now ? { ...row, stale: false } : null;
  });
  mocks.write.mockReset().mockImplementation(async (input: {
    key: string; data: unknown; now: Date; ttlMs: number;
  }) => {
    rows.set(input.key, { data: input.data, fetchedAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.ttlMs) });
  });
  mocks.query.mockReset().mockResolvedValue({ matches, truncated: false,
    observedAtByMatchId: { "1": 900 } });
});

describe("catálogo compartilhado BridgeOdds", () => {
  it.each([false, true])("100 consumidores compartilham leitura e preparação (aquecido=%s)", async (warm) => {
    if (warm) {
      await getBridgeDayCatalog({ ...params, now: 1_000 });
      clearBridgeCatalogCache();
      mocks.read.mockClear();
    }
    const catalogs = await Promise.all(Array.from({ length: 100 }, () =>
      getBridgeDayCatalog({ ...params, now: 2_000 })));

    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(catalogs.every((catalog) => catalog === catalogs[0])).toBe(true);
    expect(catalogs[0]?.prepared).toHaveLength(300);
    expect(catalogs[0]?.fetchedAt).toBe(warm ? 1_000 : 2_000);
    expect(catalogs[0]?.observedAtByMatchId).toEqual({ "1": 900 });
  });

  it("falha ao salvar cache preserva resposta e o horário original do preço", async () => {
    mocks.write.mockRejectedValueOnce(new Error("cache indisponível"));
    const catalog = await getBridgeDayCatalog({ ...params, now: 1_000 });
    expect(await getBridgeDayCatalog({ ...params, now: 2_000 })).toBe(catalog);
    expect(catalog.fetchedAt).toBe(1_000);
    expect(catalog.observedAtByMatchId).toEqual({ "1": 900 });
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(rows.size).toBe(0);
  });

  it("cache vencido é renovado sem rejuvenescer observações anteriores", async () => {
    await getBridgeDayCatalog({ ...params, now: 1_000 });
    clearBridgeCatalogCache();
    mocks.query.mockResolvedValueOnce({ matches, truncated: false, observedAtByMatchId: { "1": 1_800_900 } });
    const renewed = await getBridgeDayCatalog({ ...params, now: 1_801_001 });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(renewed.fetchedAt).toBe(1_801_001);
    expect(renewed.observedAtByMatchId).toEqual({ "1": 1_800_900 });
  });

  it("libera leitura que falhou para permitir nova tentativa", async () => {
    const error = new Error("leitura indisponível");
    mocks.read.mockRejectedValueOnce(error);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
      getBridgeDayCatalog({ ...params, now: 1_000 })));
    expect(results.every((result) => result.status === "rejected" && result.reason === error)).toBe(true);
    expect(mocks.query).not.toHaveBeenCalled();
    await expect(getBridgeDayCatalog({ ...params, now: 1_001 })).resolves.toMatchObject({ fetchedAt: 1_001 });
    expect(mocks.query).toHaveBeenCalledOnce();
  });
});
