import { describe, expect, it } from "vitest";
import { agregaGrupo } from "@/src/domain/analyzer/shared";
import { hitRateFromCounts } from "@/src/domain/hit-rate";

/** Taxa de acerto de um grupo pelos status, pelo mesmo caminho do Analyzer. */
const hitRateFromStatuses = (statuses: string[]): number | null =>
  agregaGrupo(statuses.map((status) => ({
    status,
    stake: 1,
    lucro: 0,
    clv: null,
    clvReliable: null,
    closingFetchedAt: null,
  }))).sucessoPct;

describe("hit rate canônico", () => {
  it("pondera meias decisões e exclui resultados sem acerto comparável", () => {
    expect(hitRateFromStatuses([
      "WON",
      "LOST",
      "HALF_WON",
      "HALF_LOST",
      "CASHOUT",
      "VOID",
      "PENDING",
    ])).toBeCloseTo(50, 8);
  });

  it("retorna null quando não há decisão válida", () => {
    expect(hitRateFromStatuses(["CASHOUT", "VOID", "PENDING"])).toBeNull();
    expect(hitRateFromCounts({ won: 0, lost: 0, halfWon: 0, halfLost: 0 })).toBeNull();
  });

  it("mantém meia ganha como meia tentativa ganha", () => {
    expect(hitRateFromCounts({ won: 1, lost: 0, halfWon: 1, halfLost: 0 })).toBe(100);
  });

  it("aceita status legados em minúsculas sem zerar a métrica", () => {
    expect(hitRateFromStatuses(["won", "lost", "half_won", "half_lost"])).toBe(50);
  });

  it("valida integridade e rejeita contagens negativas, fracionárias ou não-finitas", () => {
    expect(() => hitRateFromCounts({ won: -1, lost: 0, halfWon: 0, halfLost: 0 })).toThrow(/hitRate: won inválido/);
    expect(() => hitRateFromCounts({ won: 0.5, lost: 0, halfWon: 0, halfLost: 0 })).toThrow(/hitRate: won inválido/);
    expect(() => hitRateFromCounts({ won: NaN, lost: 0, halfWon: 0, halfLost: 0 })).toThrow(/hitRate: won inválido/);
    expect(() => hitRateFromCounts({ won: Infinity, lost: 0, halfWon: 0, halfLost: 0 })).toThrow(/hitRate: won inválido/);
  });
});

describe("status com espaços", () => {
  it("apara o status antes de contar", () => {
    expect(hitRateFromStatuses([" WON ", " lost "])).toBe(50);
    expect(hitRateFromStatuses([" HALF_WON "])).toBe(100);
  });
});

describe("ponderação de meias linhas", () => {
  it("hitRateFromCounts pondera meias linhas com 0.5 no numerador e no denominador", () => {
    const wr = hitRateFromCounts({ won: 1, lost: 1, halfWon: 1, halfLost: 1 });
    expect(wr).toBe(50);

    const wrHalf = hitRateFromCounts({ won: 0, lost: 0, halfWon: 1, halfLost: 0 });
    expect(wrHalf).toBe(100);

    const wrHalfLost = hitRateFromCounts({ won: 0, lost: 0, halfWon: 0, halfLost: 1 });
    expect(wrHalfLost).toBe(0);
  });
});
