import { describe, expect, it } from "vitest";
import { BetStatus } from "@/src/generated/prisma/client";
import { computeLucroFromStatus, validateCashoutLucro } from "@/src/domain/lucro";

describe("computeLucroFromStatus / validateCashoutLucro", () => {
  it("deriva lucro de cada status", () => {
    const args = { stake: 2, odds: 1.85, currentLucro: 0 };
    expect(computeLucroFromStatus({ ...args, status: BetStatus.WON })).toBeCloseTo(1.7, 6);
    expect(computeLucroFromStatus({ ...args, status: BetStatus.LOST })).toBe(-2);
    expect(computeLucroFromStatus({ ...args, status: BetStatus.HALF_WON })).toBeCloseTo(0.85, 6);
    expect(computeLucroFromStatus({ ...args, status: BetStatus.HALF_LOST })).toBe(-1);
    expect(computeLucroFromStatus({ ...args, status: BetStatus.VOID })).toBe(0);
    expect(
      computeLucroFromStatus({ ...args, status: BetStatus.CASHOUT, currentLucro: 0.42 }),
    ).toBe(0.42);
  });

  it("preserva empate decimal de meia ganha em seis casas", () => {
    expect(computeLucroFromStatus({
      status: BetStatus.HALF_WON,
      stake: 76.6711,
      odds: 1.39,
    })).toBe(14.950865);
  });

  it("cashout fora do intervalo possível é rejeitado", () => {
    expect(() => validateCashoutLucro({ lucro: 5, stake: 1, odds: 2 })).toThrow();
    expect(() => validateCashoutLucro({ lucro: -2, stake: 1, odds: 2 })).toThrow();
    expect(() => validateCashoutLucro({ lucro: 0.5, stake: 1, odds: 2 })).not.toThrow();
    expect(validateCashoutLucro({ lucro: 0.1234564, stake: 1, odds: 2 })).toBe(0.123456);
    expect(() => validateCashoutLucro({ lucro: 1.0000005, stake: 1, odds: 2 })).toThrow();
  });

  it("cashout aceita os limites exatos e recusa entradas não-finitas", () => {
    expect(validateCashoutLucro({ lucro: -2, stake: 2, odds: 1.5 })).toBe(-2);
    expect(validateCashoutLucro({ lucro: 1, stake: 2, odds: 1.5 })).toBe(1);
    expect(() => validateCashoutLucro({ lucro: -2.000001, stake: 2, odds: 1.5 })).toThrow();
    expect(() => validateCashoutLucro({ lucro: 1.000001, stake: 2, odds: 1.5 })).toThrow();
    for (const lucro of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateCashoutLucro({ lucro, stake: 1, odds: 2 })).toThrow(/cashout/i);
    }
    for (const stake of [0, -1, Number.NaN]) {
      expect(() => validateCashoutLucro({ lucro: 0, stake, odds: 2 })).toThrow(/stake/i);
    }
    for (const odds of [1, 0, Number.POSITIVE_INFINITY]) {
      expect(() => validateCashoutLucro({ lucro: 0, stake: 1, odds })).toThrow(/odd/i);
    }
  });

  it("mensagem de cashout preserva a precisão persistida do intervalo", () => {
    expect(() => validateCashoutLucro({ lucro: 1, stake: 0.123456, odds: 2 })).toThrow(
      /entre -0\.123456 e 0\.123456 unidades/,
    );
  });

  it("não transforma dados financeiros inválidos em lucro zero", () => {
    expect(() => computeLucroFromStatus({ status: BetStatus.WON, stake: 1, odds: 1 })).toThrow();
    expect(() => computeLucroFromStatus({ status: BetStatus.LOST, stake: 0, odds: 2 })).toThrow();
    expect(() => computeLucroFromStatus({ status: BetStatus.CASHOUT, stake: 1, odds: 2 })).toThrow();
  });
});
