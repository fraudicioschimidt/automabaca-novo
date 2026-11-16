/**
 * Aritmética de dinheiro. Invariante de integridade financeira do Blueprint:
 * - Decimal no banco; conversão para number SÓ via toNumber() na borda.
 * - Somas e produtos em inteiro escalado (sem drift IEEE-754), um
 *   arredondamento só, para longe de zero, como o `numeric` do PostgreSQL.
 *
 * As contas moram em Rust (`rust/crates/dominio/src/money.rs`): no servidor
 * pela N-API, nas telas pelo WebAssembly. Aqui fica o que é do JavaScript: a
 * conversão do valor do banco (`toNumber`), o seletor do `sumMoneyBy` e o
 * valor que chega fora dos tipos, recusado antes de cruzar a ponte (o
 * WebAssembly converteria "1" em 1).
 */
import dominio from "@automabaca/dominio";


export function toNumber(value: unknown): number {
  let result: number;
  if (typeof value === "number") {
    result = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      throw new Error("toNumber: string vazia");
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      throw new Error(`toNumber: formato numérico decimal inválido (${value})`);
    }
    result = Number(trimmed);
  } else if (isDecimalWithToNumber(value)) {
    result = value.toNumber();
  } else if (isDecimalLikeValue(value)) {
    const str = value.toString().trim();
    if (str === "" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(str)) {
      throw new Error(`toNumber: formato numérico decimal inválido (${String(value)})`);
    }
    result = Number(str);
  } else {
    throw new Error(`toNumber: valor inválido (${String(value)})`);
  }
  if (!Number.isFinite(result)) {
    throw new Error(`toNumber: não foi possível converter para número (${String(value)})`);
  }
  return result;
}

export function toNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  return toNumber(value);
}

function isDecimalWithToNumber(value: unknown): value is { toNumber: () => number } {
  if (!value || typeof value !== "object") return false;
  const candidate = (value as { toNumber?: unknown }).toNumber;
  return typeof candidate === "function";
}

function isDecimalLikeValue(value: unknown): value is { toString: () => string } {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value) || value instanceof Date) return false;
  const toString = (value as { toString?: unknown }).toString;
  return typeof toString === "function" && toString !== Object.prototype.toString;
}

/** Recusa o que não é `number` com a mensagem do TypeScript, antes da ponte. */
function numbers(values: readonly unknown[], message: (value: unknown) => string): number[] {
  for (const value of values) {
    if (typeof value !== "number") throw new Error(message(value));
  }
  return values as number[];
}

function number(value: unknown, message: (value: unknown) => string): number {
  if (typeof value !== "number") throw new Error(message(value));
  return value;
}

export function divideRoundHalfAway(value: bigint, divisor: bigint): bigint {
  return BigInt(dominio.divideRoundHalfAway(value.toString(), divisor.toString()));
}

/**
 * Soma N valores monetários sem acumular erro de ponto flutuante: inteiro
 * escalado (10^decimals) e uma divisão no fim. decimals=6 acompanha a precisão
 * do schema (Decimal(14,6)). BRL puro: 2.
 */
export function sumMoneyDecimal(
  values: ReadonlyArray<number>,
  decimals: number = 6,
): number {
  return dominio.sumMoneyDecimal(numbers(values, (v) => `sumMoneyDecimal: valor não-finito (${String(v)})`), decimals);
}

/** Variante com seletor — `sumMoneyBy(bets, (b) => toNumber(b.lucro))`. */
export function sumMoneyBy<T>(
  items: ReadonlyArray<T>,
  selector: (item: T) => number,
  decimals: number = 6,
): number {
  const values = numbers(items.map(selector), (v) => `sumMoneyBy: seletor retornou valor não-finito (${String(v)})`);
  return dominio.sumMoneyBy(values, decimals);
}

/**
 * Acumulador de soma corrente sem drift IEEE-754 — para curvas acumuladas
 * (PnL, drawdown), onde `acum += v` em float acumula erro.
 */
export function createMoneyAccumulator(decimals: number = 6) {
  const accumulator = new dominio.MoneyAccumulator(decimals);
  return {
    /** Soma v e retorna o acumulado atual. */
    add(v: number): number {
      return accumulator.add(number(v, (value) => `Acumulador monetário recebeu valor não-finito (${String(value)})`));
    },
    get value(): number {
      return accumulator.value;
    },
  };
}

/**
 * Arredondamento decimal correto pela representação decimal curta do número:
 * `Math.round(v * 10^d) / 10^d` falha em casos como 1.005 (vira 100.4999…
 * antes do round → 1.00).
 *
 * Para decisão de resultado financeiro use comparações com
 * `LEDGER_MIN_AMOUNT`, não epsilon ad-hoc.
 */
export function roundMoney(value: number, decimals: number = 6): number {
  return dominio.roundMoney(number(value, (v) => `roundMoney: Valor não-finito (${String(v)})`), decimals);
}

/**
 * Multiplica dinheiro por um fator decimal sem fazer a operação em IEEE-754.
 * A escala padrão do fator acompanha `Bet.odds Decimal(10,4)`; o resultado
 * acompanha as seis casas de stake/lucro. `divisor=2` cobre meias liquidações;
 * `divisorDecimals` conserva a stake decimal ao escalar um cashout.
 */
export function multiplyMoneyDecimal(
  value: number,
  multiplier: number,
  options: { decimals?: number; multiplierDecimals?: number; divisor?: number; divisorDecimals?: number; resultDecimals?: number } = {},
): number {
  const decimals = options.decimals ?? 6;
  const notFinite = (v: unknown) => `Valor não-finito (${String(v)})`;
  return dominio.multiplyMoneyDecimal(
    number(value, notFinite),
    number(multiplier, notFinite),
    decimals,
    options.multiplierDecimals ?? 4,
    options.divisor ?? 1,
    options.divisorDecimals ?? 0,
    options.resultDecimals ?? decimals,
  );
}

/** Valor monetario ponderado por uma porcentagem, sem produto em IEEE-754. */
export function moneyByPercent(value: number, percent: number): number {
  return dominio.moneyByPercent(value, percent);
}

/**
 * Unidades (seis casas) × valor da unidade (R$, duas casas) em reais,
 * arredondado ao centavo: a conta do lançamento no ledger, que as telas e o
 * briefing repetem para dizer o mesmo valor.
 */
export function unitsToBrl(units: number, valorUnidade: number): number {
  return dominio.unitsToBrl(units, valorUnidade);
}

/**
 * Unidades em reais pelo valor da unidade gravado na aposta, sem arredondar ao
 * centavo: seis casas, como stake e lucro no banco. A linha da carteira, o
 * resumo do histórico extenso e o simulador de stake fazem a mesma conta, e os
 * totais precisam bater.
 */
export function unitsToReais(units: number, unitValue: number): number {
  return dominio.unitsToReais(units, unitValue);
}

/** Menor valor relevante para colunas BRL `Decimal(...,2)`: meio centavo. */
export const LEDGER_MIN_AMOUNT = 0.005;

/** Menor diferença relevante para stake/lucro em unidades `Decimal(...,6)`. */
export const BET_UNIT_MIN_AMOUNT = 0.0000005;

/** Kahan Summation para somatório de alta precisão em ponto flutuante. */
export function kahanSum(values: readonly number[]): number {
  return dominio.kahanSum(numbers(values, (x) => `kahanSum: valor não-finito recebido (${String(x)})`));
}
