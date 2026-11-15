import { describe, expect, it } from "vitest";
import { parseDecimalInput, parseMoneyInput } from "@/src/domain/decimal-input";

describe("parseDecimalInput", () => {
  it.each([
    ["1,90", 1.9],
    ["0.50", 0.5],
    ["-0,25", -0.25],
    ["1.234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["1.000.000,00", 1000000],
    ["1,000,000.00", 1000000],
    ["1.000.000", 1000000],
    [2, 2],
  ])("aceita %j como %s", (input, expected) => {
    expect(parseDecimalInput(input)).toBe(expected);
  });

  it("mantém um único ponto como decimal fora de contexto monetário", () => {
    expect(parseDecimalInput("1.000")).toBe(1);
    expect(parseDecimalInput("1.925")).toBe(1.925);
  });

  it.each(["", "1,2,3", "12.34.567", "1.00.000,00", "abc", null, Number.NaN])("rejeita %j", (input) => {
    expect(parseDecimalInput(input)).toBeNull();
  });
});

describe("parseMoneyInput", () => {
  it.each(['USD 10', '$10', '€10', '10 EUR', '10 BRL'])("não converte moeda identificada implicitamente em reais: %s", (input) => {
    expect(parseMoneyInput(input)).toBeNull();
  });

  it.each(["1 2", "10 00", "1 23,45", "1,\n50", "1 234,5 6", "12\t34", "1\n000"])("não transforma espaços malformados em outro valor: %j", (input) => {
    expect(parseMoneyInput(input)).toBeNull();
  });

  it.each([
    ["1 234,56", 1234.56], ["1\u00a0234,56", 1234.56],
    ["1\u202f234\u202f567.89", 1234567.89], ["-12 345,67", -12345.67],
  ])("aceita agrupamento de milhares por espaço: %j", (input, expected) => {
    expect(parseMoneyInput(input)).toBe(expected);
  });

  it.each([
    ["1.000", 1000],
    ["10.000", 10000],
    ["999.999", 999999],
    ["1.000,50", 1000.5],
    ["1,50", 1.5],
    ["-1.000", -1000],
    ["0.001", 0.001],
  ])("interpreta %j no contexto de R$ como %s", (input, expected) => {
    expect(parseMoneyInput(input)).toBe(expected);
  });
});

describe("entradas malformadas", () => {
  it("parseDecimalInput e parseMoneyInput tratam zeros à esquerda, milhar BR e espaços internos", () => {
    expect(parseDecimalInput("00.000")).toBeNull();
    expect(parseDecimalInput("01.234.567")).toBeNull();
    expect(parseDecimalInput("0123")).toBeNull();
    expect(parseDecimalInput("1 2")).toBeNull();
    expect(parseDecimalInput("1.")).toBeNull();
    expect(parseDecimalInput("1.234,56")).toBe(1234.56);
    expect(parseMoneyInput("1.000")).toBe(1000);
    expect(parseMoneyInput("1 234,56")).toBe(1234.56);
  });
});
