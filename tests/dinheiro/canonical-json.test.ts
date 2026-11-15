import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalSha256 } from "@/src/domain/canonical-json";

describe("canonicalJson / canonicalSha256", () => {
  it("ordena objetos sem colidir valores fora do domínio JSON", () => {
    expect(canonicalJson({ b: 2, a: [null, 1] })).toBe('{"a":[null,1],"b":2}');
    expect(canonicalSha256({ b: 2, a: 1 })).toBe(
      canonicalSha256({ a: 1, b: 2 }),
    );
  });

  it("recusa coerções que produziriam a mesma chave para valores diferentes", () => {
    expect(() => canonicalJson(5n)).toThrow(/BigInt/);
    expect(() => canonicalJson(new Date("2026-07-18T12:00:00Z"))).toThrow(/Date/);
    expect(() => canonicalJson(undefined)).toThrow(/undefined/);
    expect(() => canonicalJson([undefined])).toThrow(/undefined/);
    expect(() => canonicalJson(Array(1))).toThrow(/posição ausente/);
    expect(() => canonicalJson({ value: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/não-finito/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/não-finito/);
    expect(canonicalJson("5")).toBe('"5"');
    expect(canonicalJson("2026-07-18T12:00:00.000Z")).toBe(
      '"2026-07-18T12:00:00.000Z"',
    );
  });

  it("recusa estruturas não representáveis em JSON em vez de gerar hashes colidentes", () => {
    expect(() => canonicalJson(new Set([1]))).toThrow(/tipo estruturado não suportado/i);
    expect(() => canonicalJson(new Map([["a", 1]]))).toThrow(/tipo estruturado não suportado/i);
  });
});
