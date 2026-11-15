import { describe, expect, it } from "vitest";
import {
  createMoneyAccumulator,
  divideRoundHalfAway,
  kahanSum,
  BET_UNIT_MIN_AMOUNT,
  LEDGER_MIN_AMOUNT,
  multiplyMoneyDecimal,
  roundMoney,
  sumMoneyBy,
  sumMoneyDecimal,
  toNullableNumber,
  toNumber,
} from "@/src/domain/money";

describe("sumMoneyDecimal", () => {
  it("soma 0.1 + 0.2 sem drift de float", () => {
    expect(sumMoneyDecimal([0.1, 0.2])).toBe(0.3);
  });

  it("soma 10.000 × R$0,01 = exatamente 100 (drift zero em N grande)", () => {
    const values = Array.from({ length: 10_000 }, () => 0.01);
    expect(sumMoneyDecimal(values, 2)).toBe(100);
  });

  it("retorna 0 para lista vazia e recusa não-finitos", () => {
    expect(sumMoneyDecimal([])).toBe(0);
    // Precisão inválida explode SEMPRE, inclusive no fast-path de vazio: a má
    // configuração não pode passar calada quando não há o que somar.
    expect(() => sumMoneyDecimal([], 25)).toThrow(/precis/i);
    expect(() => sumMoneyDecimal([1], 25)).toThrow(/precis/i);
    expect(() => sumMoneyDecimal([1.5, Number.NaN, 0.5])).toThrow(/não-finito/i);
    expect(() => sumMoneyDecimal([Number.POSITIVE_INFINITY])).toThrow(/não-finito/i);
  });

  it("soma stakes fracionárias em unidades (decimals=6)", () => {
    expect(sumMoneyDecimal([0.16, 0.33, 0.51])).toBe(1);
  });

  it("aceita exatamente os dois limites inteiros seguros", () => {
    expect(sumMoneyDecimal([Number.MAX_SAFE_INTEGER], 0)).toBe(Number.MAX_SAFE_INTEGER);
    expect(sumMoneyDecimal([-Number.MAX_SAFE_INTEGER], 0)).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it("arredonda empates negativos para longe de zero, igual ao PostgreSQL", () => {
    expect(sumMoneyDecimal([-0.005], 2)).toBe(-0.01);
    expect(sumMoneyDecimal([0.005, -0.005], 2)).toBe(0);
  });
});

describe("sumMoneyBy", () => {
  it("soma via seletor sem drift", () => {
    const bets = [{ lucro: 0.1 }, { lucro: 0.2 }, { lucro: -0.3 }];
    expect(sumMoneyBy(bets, (b) => b.lucro)).toBe(0);
  });

  it("recusa seletor não-finito e total fora da precisão segura", () => {
    expect(() => sumMoneyBy([], () => 1, -1)).toThrow(/precisão/i);
    expect(() => sumMoneyBy([{ lucro: Number.NaN }], (b) => b.lucro)).toThrow(/não-finito/i);
    expect(() => sumMoneyDecimal([Number.MAX_SAFE_INTEGER], 6)).toThrow(/faixa/i);
  });
});

describe("toNumber", () => {
  it("converte number, string e Decimal-like", () => {
    expect(toNumber(2.5)).toBe(2.5);
    expect(toNumber("3.14")).toBe(3.14);
    expect(toNumber({ toNumber: () => 7.7 })).toBe(7.7);
    expect(toNumber({ toString: () => "8.25" })).toBe(8.25);
  });

  it("lança em valor inválido ou não-finito (nunca propaga NaN)", () => {
    expect(() => toNumber("abc")).toThrow();
    expect(() => toNumber(undefined)).toThrow();
    expect(() => toNumber(Number.NaN)).toThrow();
    expect(() => toNumber({ toNumber: () => Number.POSITIVE_INFINITY })).toThrow();
    expect(() => toNumber({ toString: () => "Infinity" })).toThrow();
    expect(() => toNumber({})).toThrow();
    expect(() => toNumber([])).toThrow();
    expect(() => toNumber(new Date())).toThrow();
    expect(() => toNumber({ toString: Object.prototype.toString })).toThrow();
    expect(toNumber(Object.assign(Object.create(null), { toString: () => "4.25" }))).toBe(4.25);
  });

  it("toNullableNumber preserva null/undefined", () => {
    expect(toNullableNumber(null)).toBeNull();
    expect(toNullableNumber(undefined)).toBeNull();
    expect(toNullableNumber("1.5")).toBe(1.5);
  });
});

describe("roundMoney", () => {
  it("arredonda matematicamente em uma etapa", () => {
    expect(roundMoney(10.1234567)).toBe(10.123457);
    expect(roundMoney(1.005, 2)).toBe(1.01);
    expect(roundMoney(-1.005, 2)).toBe(-1.01);
    expect(roundMoney(-0.005, 2)).toBe(-0.01);
  });

  it("recusa resultado escalado acima da faixa inteira segura", () => {
    expect(() => roundMoney(Number.MAX_SAFE_INTEGER, 6)).toThrow(/faixa/i);
  });

  it("aceita os extremos da precisão e recusa precisão inválida", () => {
    expect(roundMoney(0, 0)).toBe(0);
    expect(roundMoney(0, 18)).toBe(0);
    for (const decimals of [-1, 1.5, 19]) {
      expect(() => roundMoney(1, decimals)).toThrow(/precisão/i);
      expect(() => createMoneyAccumulator(decimals)).toThrow(/precisão/i);
    }
  });

  it("mantém a causa não-finita explícita na borda pública", () => {
    expect(() => roundMoney(Number.POSITIVE_INFINITY, 2)).toThrow(/não-finito/i);
    expect(() => roundMoney(Number.NEGATIVE_INFINITY, 2)).toThrow(/não-finito/i);
  });
});

describe("multiplyMoneyDecimal", () => {
  it("converte microunidades em centavos sem arredondamento intermediário", () => {
    for (const sign of [1, -1]) {
      expect(multiplyMoneyDecimal(sign * 1.00505, 0.99, { multiplierDecimals: 2, resultDecimals: 2 })).toBe(sign * 0.99);
      expect(multiplyMoneyDecimal(sign * 1.005051, 0.99, { multiplierDecimals: 2, resultDecimals: 2 })).toBe(sign);
      expect(multiplyMoneyDecimal(sign * 0.005, 1, { multiplierDecimals: 2, resultDecimals: 2 })).toBe(sign * 0.01);
    }
    expect(multiplyMoneyDecimal(1.25, 0.5, { decimals: 2, multiplierDecimals: 1, resultDecimals: 6 })).toBe(0.625);
    expect(() => multiplyMoneyDecimal(1, 2, { resultDecimals: 19 })).toThrow(/precisão/i);
  });

  it("multiplica e divide sem perder empates decimais em ponto flutuante", () => {
    expect(multiplyMoneyDecimal(76.6711, 1.39 - 1, { divisor: 2 })).toBe(14.950865);
    expect(multiplyMoneyDecimal(76.6711, -(1.39 - 1), { divisor: 2 })).toBe(-14.950865);
  });

  it("escala um retorno proporcional com divisor decimal e um único arredondamento final", () => {
    for (const sign of [1, -1]) {
      expect(multiplyMoneyDecimal(sign * 1, 50, { multiplierDecimals: 2, divisor: 3, divisorDecimals: 6 })).toBe(sign * 16.666667);
      expect(multiplyMoneyDecimal(sign * 0.000001, 0.01, { multiplierDecimals: 2, divisor: 0.000001, divisorDecimals: 6 })).toBe(sign * 0.01);
      expect(multiplyMoneyDecimal(sign * 0.000001, 0.01, { multiplierDecimals: 2, divisor: 0.02, divisorDecimals: 6 })).toBe(sign * 0.000001);
    }
    expect(() => multiplyMoneyDecimal(1, 2, { divisor: 0.0000001, divisorDecimals: 6 })).toThrow(/divisor/i);
    expect(() => multiplyMoneyDecimal(1, 2, { divisorDecimals: 19 })).toThrow(/precisão/i);
  });

  it("valida divisor e escalas", () => {
    expect(() => multiplyMoneyDecimal(1, 2, { divisor: 0 })).toThrow(/divisor/i);
    expect(() => multiplyMoneyDecimal(1, 2, { divisor: 1.5 })).toThrow(/divisor/i);
    expect(() => multiplyMoneyDecimal(1, 2, { multiplierDecimals: 19 })).toThrow(/precisão/i);
  });
});

describe("createMoneyAccumulator", () => {
  it("soma corrente sem drift IEEE-754 (0.1 somado 1000x = 100 exato)", () => {
    const acum = createMoneyAccumulator(2);
    let last = 0;
    for (let i = 0; i < 1000; i += 1) last = acum.add(0.1);
    expect(last).toBe(100);
    expect(acum.value).toBe(100);
  });

  it("cada add retorna o acumulado parcial e recusa não-finito", () => {
    const acum = createMoneyAccumulator();
    expect(acum.add(1.23)).toBe(1.23);
    expect(() => acum.add(Number.NaN)).toThrow(/não-finito/i);
    expect(acum.add(-0.03)).toBe(1.2);
  });
});

describe("LEDGER_MIN_AMOUNT", () => {
  it("é meio centavo — alinhado entre settlement e ledger", () => {
    expect(LEDGER_MIN_AMOUNT).toBe(0.005);
  });

  it("separa a precisão BRL da precisão de unidades", () => {
    expect(BET_UNIT_MIN_AMOUNT).toBe(0.0000005);
  });
});

describe("entradas inválidas", () => {
  it("toNumber rejeita string vazia, espaços e bases não-decimais inclusive via objetos", () => {
    expect(() => toNumber("")).toThrow("toNumber: string vazia");
    expect(() => toNumber("   ")).toThrow("toNumber: string vazia");
    expect(() => toNumber("0x10")).toThrow("toNumber: formato numérico decimal inválido");
    expect(() => toNumber("0b10")).toThrow("toNumber: formato numérico decimal inválido");
    expect(() => toNumber("0o10")).toThrow("toNumber: formato numérico decimal inválido");
    expect(() => toNumber({ toString: () => "0x10" })).toThrow("toNumber: formato numérico decimal inválido");
    expect(toNumber("123.45")).toBe(123.45);
    expect(toNumber(100)).toBe(100);
  });

  it("divideRoundHalfAway rejeita divisores zero e negativos", () => {
    expect(() => divideRoundHalfAway(100n, 0n)).toThrow("divideRoundHalfAway: divisor deve ser estritamente positivo");
    expect(() => divideRoundHalfAway(100n, -2n)).toThrow("divideRoundHalfAway: divisor deve ser estritamente positivo");
    expect(divideRoundHalfAway(100n, 3n)).toBe(33n);
  });

  it("kahanSum rejeita valores não-finitos", () => {
    expect(() => kahanSum([1, NaN, 2])).toThrow("kahanSum: valor não-finito recebido");
    expect(() => kahanSum([1, Infinity, 2])).toThrow("kahanSum: valor não-finito recebido");
    expect(kahanSum([1.1, 2.2, 3.3])).toBeCloseTo(6.6, 10);
  });
});
