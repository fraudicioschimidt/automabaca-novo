import { describe, expect, it } from "vitest";
import { BoundedTtlCache } from "@/src/infra/bounded-ttl-cache";

describe("BoundedTtlCache", () => {
  it("remove expiradas e limita o crescimento pelo item menos recente", () => {
    const cache = new BoundedTtlCache<string, number>(2, 100);
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    expect(cache.get("a", 10)).toBe(1);
    cache.set("c", 3, 10);
    expect(cache.get("b", 10)).toBeUndefined();
    expect(cache.get("a", 10)).toBe(1);
    expect(cache.get("c", 10)).toBe(3);
    expect(cache.get("a", 101)).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it("permite invalidar uma entrada explicitamente", () => {
    const cache = new BoundedTtlCache<string, number>(2, 100);
    cache.set("a", 1, 0);

    expect(cache.delete("a")).toBe(true);
    expect(cache.get("a", 1)).toBeUndefined();
    expect(cache.delete("a")).toBe(false);
  });

  it("aceita TTL menor por entrada sem alterar o padrão do cache", () => {
    const cache = new BoundedTtlCache<string, number>(2, 100);
    cache.set("curto", 1, 0, 10);
    cache.set("padrao", 2, 0);

    expect(cache.get("curto", 11)).toBeUndefined();
    expect(cache.get("padrao", 11)).toBe(2);
  });
});

describe("limites do cache com qualquer chave válida de Map", () => {
  it("remove a chave undefined quando ela é a menos recente", () => {
    const cache = new BoundedTtlCache<string | undefined, number>(1, 100);
    cache.set(undefined, 1, 0);
    cache.set("nova", 2, 0);
    expect(cache.size).toBe(1);
    expect(cache.get(undefined, 0)).toBeUndefined();
    expect(cache.get("nova", 0)).toBe(2);
  });

  it.each([Infinity, NaN, 0, -1])("recusa TTL inválido: %s", (ttl) => {
    expect(() => new BoundedTtlCache(1, ttl)).toThrow(/ttlMs/);
    const cache = new BoundedTtlCache(1, 100);
    expect(() => cache.set("a", 1, 0, ttl)).toThrow(/ttlMs/);
    expect(cache.size).toBe(0);
  });
});
