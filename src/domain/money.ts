/**
 * Aritmética de dinheiro. Invariante de integridade financeira do Blueprint:
 * - Decimal no banco; conversão para number SÓ via toNumber() na borda.
 * - Somas de N valores via BigInt-cents (sem drift IEEE-754).
 */

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

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Precisão decimal inválida (${String(decimals)})`);
  }
}

/**
 * Converte a representação decimal curta de um `number` para inteiro escalado,
 * arredondando empates para longe de zero, como o `numeric` do PostgreSQL.
 * Fazer isso com `Math.round(value * factor)` é incorreto para valores negativos
 * (`Math.round(-0.5) === -0`) e também sofre com 1.005 em ponto flutuante.
 */
const SCALED_BIGINT_CACHE_LIMIT = 4_096;
const SCALED_BIGINT_CACHE = Array.from(
  { length: 19 },
  () => new Map<number, bigint>(),
);

function toScaledBigInt(value: number, decimals: number): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(`Valor não-finito (${String(value)})`);
  }
  assertDecimals(decimals);
  const cache = SCALED_BIGINT_CACHE[decimals]!;
  const cached = cache.get(value);
  if (cached !== undefined) return cached;

  const negative = value < 0;
  const [coefficient = "0", exponentText = "0"] = Math.abs(value).toString().split("e");
  const exponent = Number(exponentText);
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const digits = BigInt(`${whole}${fraction}` || "0");
  const shift = exponent - fraction.length + decimals;

  let scaled: bigint;
  if (shift >= 0) {
    scaled = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    scaled = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }
  const result = negative ? -scaled : scaled;
  // Analyzer/ledger repetem poucos valores de stake/lucro em milhares de
  // grupos. A conversão decimal exata é pura, mas parsear string+BigInt em cada
  // bucket dominava o budget de escala. Cache pequeno e limitado preserva a
  // mesma aritmética e se auto-recicla sob cardinalidade alta.
  if (cache.size >= SCALED_BIGINT_CACHE_LIMIT) cache.clear();
  cache.set(value, result);
  return result;
}

function scaledBigIntToNumber(value: bigint, factor: number, context: string): number {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > limit || value < -limit) {
    throw new Error(`${context}: total fora da faixa numérica segura`);
  }
  return Number(value) / factor;
}

export function divideRoundHalfAway(value: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) {
    throw new Error("divideRoundHalfAway: divisor deve ser estritamente positivo");
  }
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const rounded = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  return negative ? -rounded : rounded;
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

/**
 * Soma N valores monetários sem acumular erro de ponto flutuante:
 * converte para inteiro (10^decimals), soma como bigint, divide no final.
 * decimals=6 acompanha a precisão do schema (Decimal(14,6)). BRL puro: 2.
 */
export function sumMoneyDecimal(
  values: ReadonlyArray<number>,
  decimals: number = 6,
): number {
  // Antes do fast-path: uma precisão inválida tem que explodir SEMPRE, não só
  // quando há o que somar. Mascarar a má configuração exatamente no caso vazio
  // adia o erro para a primeira soma real.
  assertDecimals(decimals);
  if (values.length === 0) return 0;
  const factor = 10 ** decimals;
  let totalCents = 0n;
  for (const v of values) {
    if (!Number.isFinite(v)) {
      throw new Error(`sumMoneyDecimal: valor não-finito (${String(v)})`);
    }
    totalCents += toScaledBigInt(v, decimals);
  }
  return scaledBigIntToNumber(totalCents, factor, "sumMoneyDecimal");
}

/** Variante com seletor — `sumMoneyBy(bets, (b) => toNumber(b.lucro))`. */
export function sumMoneyBy<T>(
  items: ReadonlyArray<T>,
  selector: (item: T) => number,
  decimals: number = 6,
): number {
  assertDecimals(decimals);
  if (items.length === 0) return 0;
  const factor = 10 ** decimals;
  let totalCents = 0n;
  for (const item of items) {
    const v = selector(item);
    if (!Number.isFinite(v)) {
      throw new Error(`sumMoneyBy: seletor retornou valor não-finito (${String(v)})`);
    }
    totalCents += toScaledBigInt(v, decimals);
  }
  return scaledBigIntToNumber(totalCents, factor, "sumMoneyBy");
}

/**
 * Acumulador de soma corrente sem drift IEEE-754 — para curvas acumuladas
 * (PnL, drawdown), onde `acum += v` em float acumula erro. Mesma base
 * BigInt-cents de sumMoneyDecimal.
 */
export function createMoneyAccumulator(decimals: number = 6) {
  assertDecimals(decimals);
  const factor = 10 ** decimals;
  let totalCents = 0n;
  return {
    /** Soma v e retorna o acumulado atual. */
    add(v: number): number {
      if (!Number.isFinite(v)) {
        throw new Error(`Acumulador monetário recebeu valor não-finito (${String(v)})`);
      }
      totalCents += toScaledBigInt(v, decimals);
      return scaledBigIntToNumber(totalCents, factor, "Acumulador monetário");
    },
    get value(): number {
      return scaledBigIntToNumber(totalCents, factor, "Acumulador monetário");
    },
  };
}

/**
 * Arredondamento decimal correto via deslocamento de expoente.
 *
 * `Math.round(v * 10^d) / 10^d` falha em casos como 1.005 (vira 100.4999…
 * antes do round → 1.00). O deslocamento via notação exponencial usa a
 * representação em string do número (menor forma exata) e evita a
 * multiplicação: "1.005e2" → 100.5 → 101 → 1.01.
 *
 * Para decisão de resultado financeiro use comparações com
 * `LEDGER_MIN_AMOUNT`, não epsilon ad-hoc.
 */
export function roundMoney(value: number, decimals: number = 6): number {
  try {
    const factor = 10 ** decimals;
    return scaledBigIntToNumber(
      toScaledBigInt(value, decimals),
      factor,
      "roundMoney",
    );
  } catch (error) {
    throw new Error(
      `roundMoney: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  const multiplierDecimals = options.multiplierDecimals ?? 4;
  const divisor = options.divisor ?? 1;
  const divisorDecimals = options.divisorDecimals ?? 0;
  const resultDecimals = options.resultDecimals ?? decimals;
  assertDecimals(decimals);
  assertDecimals(multiplierDecimals);
  assertDecimals(resultDecimals);
  assertDecimals(divisorDecimals);
  if (!Number.isFinite(divisor) || divisor <= 0 || (divisorDecimals === 0 && !Number.isSafeInteger(divisor))) {
    throw new Error(`multiplyMoneyDecimal: divisor inválido (${String(divisor)})`);
  }
  const scaledDivisor = toScaledBigInt(divisor, divisorDecimals);
  if (scaledDivisor <= 0n) throw new Error("multiplyMoneyDecimal: divisor arredondado a zero");
  const factor = 10 ** resultDecimals;
  const productScale = decimals + multiplierDecimals;
  const product = toScaledBigInt(value, decimals)
    * toScaledBigInt(multiplier, multiplierDecimals);
  // Conserva a escala dos operandos e arredonda uma única vez na saída.
  // Unidades × R$/u podem ter oito casas, mas o ledger exige duas.
  const shift = resultDecimals + divisorDecimals - productScale;
  const scaled = divideRoundHalfAway(
    shift > 0 ? product * 10n ** BigInt(shift) : product,
    scaledDivisor * (shift < 0 ? 10n ** BigInt(-shift) : 1n),
  );
  return scaledBigIntToNumber(scaled, factor, "multiplyMoneyDecimal");
}

/** Valor monetario ponderado por uma porcentagem, sem produto em IEEE-754. */
export function moneyByPercent(value: number, percent: number): number {
  return multiplyMoneyDecimal(value, percent, {
    multiplierDecimals: 6,
    divisor: 100,
  });
}

/**
 * Unidades (seis casas) × valor da unidade (R$, duas casas) em reais,
 * arredondado ao centavo: a conta do lançamento no ledger, que as telas e o
 * briefing repetem para dizer o mesmo valor.
 */
export function unitsToBrl(units: number, valorUnidade: number): number {
  return multiplyMoneyDecimal(units, valorUnidade, { decimals: 6, multiplierDecimals: 2, resultDecimals: 2 });
}

/**
 * Unidades em reais pelo valor da unidade gravado na aposta, sem arredondar ao
 * centavo: seis casas, como stake e lucro no banco. A linha da carteira, o
 * resumo do histórico extenso e o simulador de stake fazem a mesma conta, e os
 * totais precisam bater.
 */
export function unitsToReais(units: number, unitValue: number): number {
  return multiplyMoneyDecimal(units, unitValue, { multiplierDecimals: 2 });
}

/** Menor valor relevante para colunas BRL `Decimal(...,2)`: meio centavo. */
export const LEDGER_MIN_AMOUNT = 0.005;

/** Menor diferença relevante para stake/lucro em unidades `Decimal(...,6)`. */
export const BET_UNIT_MIN_AMOUNT = 0.0000005;

/** Kahan Summation para somatório de alta precisão em ponto flutuante. */
export function kahanSum(values: readonly number[]): number {
  let sum = 0;
  let c = 0;
  for (const x of values) {
    if (!Number.isFinite(x)) {
      throw new Error(`kahanSum: valor não-finito recebido (${x})`);
    }
    const y = x - c;
    const t = sum + y;
    c = (t - sum) - y;
    sum = t;
  }
  return sum;
}
