import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeLucroFromStatus } from "@/src/domain/lucro";
import {
  createMoneyAccumulator,
  roundMoney,
  sumMoneyDecimal,
  unitsToBrl,
  unitsToReais,
} from "@/src/domain/money";
import { autoFairProbs, powerFairProbs } from "@/src/domain/odds";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { BetStatus } from "@/src/generated/prisma/enums";

const PROPERTY_RUNS = 500;
const PROPERTY_CONFIG = { numRuns: PROPERTY_RUNS } as const;
const MICRO = 1_000_000;

function divideRoundHalfAway(value: bigint, divisor: bigint): bigint {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const rounded = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  return negative ? -rounded : rounded;
}

function statusForQuarterMargin(margin: number): BetStatus {
  if (margin === 0) return BetStatus.VOID;
  if (margin === 1) return BetStatus.HALF_WON;
  if (margin === -1) return BetStatus.HALF_LOST;
  return margin > 0 ? BetStatus.WON : BetStatus.LOST;
}

function profitMicrosForStatus(
  status: BetStatus,
  stakeMicros: number,
  oddsMillis: number,
): bigint {
  if (status === BetStatus.WON) {
    return divideRoundHalfAway(
      BigInt(stakeMicros) * BigInt(oddsMillis - 1_000),
      1_000n,
    );
  }
  if (status === BetStatus.LOST) return -BigInt(stakeMicros);
  if (status === BetStatus.HALF_WON) {
    return divideRoundHalfAway(
      BigInt(stakeMicros) * BigInt(oddsMillis - 1_000),
      2_000n,
    );
  }
  if (status === BetStatus.HALF_LOST) {
    return divideRoundHalfAway(-BigInt(stakeMicros), 2n);
  }
  return 0n;
}

function quarterLine(quarters: number): string {
  const line = quarters / 4;
  return line > 0 ? `+${line}` : String(line);
}

describe("propriedades financeiras contra referência independente", () => {
  it("soma e acumulador coincidem com inteiros escalados, sem depender da ordem", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100_000_000, max: 100_000_000 }), { maxLength: 100 }),
        (microunits) => {
          const values = microunits.map((value) => value / MICRO);
          const expected = Number(microunits.reduce((sum, value) => sum + BigInt(value), 0n)) / MICRO;

          expect(sumMoneyDecimal(values)).toBe(expected);
          expect(sumMoneyDecimal([...values].reverse())).toBe(expected);

          const accumulator = createMoneyAccumulator();
          for (const value of values) accumulator.add(value);
          expect(accumulator.value).toBe(expected);
        },
      ),
      PROPERTY_CONFIG,
    );
  });

  it("arredonda qualquer decimal gerado por empate para longe de zero", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 6 }),
        (rawScaled, decimals) => {
          const value = rawScaled / 10 ** (decimals + 1);
          const expectedScaled = divideRoundHalfAway(BigInt(rawScaled), 10n);
          const expected = Number(expectedScaled) / 10 ** decimals;
          expect(roundMoney(value, decimals)).toBe(expected);
        },
      ),
      PROPERTY_CONFIG,
    );
  });

  it("conversão de unidades respeita centavos do ledger e seis casas da análise", () => {
    fc.assert(fc.property(
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      fc.integer({ min: 1, max: 1_000_000 }),
      (microunits, unitCents) => {
        const product = BigInt(microunits) * BigInt(unitCents);
        const ledgerCents = divideRoundHalfAway(product, 1_000_000n);
        const analyticalMicros = divideRoundHalfAway(product, 100n);
        expect(unitsToBrl(microunits / MICRO, unitCents / 100)).toBe(Number(ledgerCents) / 100);
        expect(unitsToReais(microunits / MICRO, unitCents / 100)).toBe(Number(analyticalMicros) / MICRO);
      },
    ), PROPERTY_CONFIG);
  });

  it("deriva lucro de cada status pelo modelo inteiro de seis casas", () => {
    const resolvedStatus = fc.constantFrom(
      BetStatus.WON,
      BetStatus.LOST,
      BetStatus.HALF_WON,
      BetStatus.HALF_LOST,
      BetStatus.VOID,
      BetStatus.PENDING,
      BetStatus.CANCELED,
    );
    fc.assert(
      fc.property(
        resolvedStatus,
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 1_001, max: 10_000 }),
        (status, stakeMicros, oddsMillis) => {
          const stake = stakeMicros / MICRO;
          const odds = oddsMillis / 1_000;
          const expectedMicros = profitMicrosForStatus(status, stakeMicros, oddsMillis);

          expect(computeLucroFromStatus({ status, stake, odds })).toBe(
            Number(expectedMicros) / MICRO,
          );
        },
      ),
      PROPERTY_CONFIG,
    );
  });
});

describe("propriedades de liquidação asiática", () => {
  it("handicap coincide com a margem inteira em quartos para os dois lados", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: -24, max: 24 }),
        fc.boolean(),
        fc.integer({ min: 1_001, max: 20_000 }),
        fc.integer({ min: 10_000, max: 100_000_000 }),
        (homeScore, awayScore, lineQuarters, homeSide, oddsMillis, stakeMicros) => {
          const sideScore = homeSide ? homeScore : awayScore;
          const opponentScore = homeSide ? awayScore : homeScore;
          const expectedStatus = statusForQuarterMargin(
            4 * (sideScore - opponentScore) + lineQuarters,
          );
          const result = resolveResultFromScore({
            mercado: "Asian Handicap",
            selecao: `${homeSide ? "Flamengo" : "Palmeiras"} ${quarterLine(lineQuarters)}`,
            evento: "Flamengo vs Palmeiras",
            homeScore,
            awayScore,
            odds: oddsMillis / 1_000,
            stake: stakeMicros / MICRO,
          });

          expect(result).toEqual({
            ok: true,
            status: expectedStatus,
            lucro: Number(profitMicrosForStatus(expectedStatus, stakeMicros, oddsMillis)) / MICRO,
          });
        },
      ),
      PROPERTY_CONFIG,
    );
  });

  it("over e under são complementares fora da linha de push", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 0, max: 48 }),
        fc.integer({ min: 1_001, max: 20_000 }),
        fc.integer({ min: 10_000, max: 100_000_000 }),
        (homeScore, awayScore, lineQuarters, oddsMillis, stakeMicros) => {
          const totalQuarters = 4 * (homeScore + awayScore);
          for (const over of [true, false]) {
            const margin = over
              ? totalQuarters - lineQuarters
              : lineQuarters - totalQuarters;
            const expectedStatus = statusForQuarterMargin(margin);
            const result = resolveResultFromScore({
              mercado: "Asian Total",
              selecao: `${over ? "Over" : "Under"} ${lineQuarters / 4}`,
              evento: "Flamengo vs Palmeiras",
              homeScore,
              awayScore,
              odds: oddsMillis / 1_000,
              stake: stakeMicros / MICRO,
            });
            expect(result).toEqual({
              ok: true,
              status: expectedStatus,
              lucro: Number(profitMicrosForStatus(expectedStatus, stakeMicros, oddsMillis)) / MICRO,
            });
          }
        },
      ),
      PROPERTY_CONFIG,
    );
  });

  it("devig permanece válido com favorito extremo e overround próximo do limite", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_010, max: 1_100 }),
        fc.integer({ min: 1_001_000, max: 1_349_000 }),
        fc.integer({ min: 1_000, max: 9_000 }),
        (favoriteOddsMillis, bookSumMicros, splitBasis) => {
          const favoriteOdd = favoriteOddsMillis / 1_000;
          const bookSum = bookSumMicros / MICRO;
          const remaining = bookSum - 1 / favoriteOdd;
          const split = splitBasis / 10_000;
          const odds = [
            favoriteOdd,
            1 / (remaining * split),
            1 / (remaining * (1 - split)),
          ];
          const probabilities = autoFairProbs(odds);

          expect(probabilities).not.toBeNull();
          expect(probabilities!.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
          expect(probabilities!.every((value) => value > 0 && value < 1)).toBe(true);
        },
      ),
      PROPERTY_CONFIG,
    );
  });
});

describe("propriedades das odds justas (devig)", () => {
  it("devig preserva probabilidade total e é equivarante à permutação", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 100, max: 800 }), { minLength: 2, maxLength: 3 }),
        fc.integer({ min: 1_000, max: 1_200 }),
        (weights, overroundMillis) => {
          const totalWeight = weights.reduce((sum, value) => sum + value, 0);
          const maxShare = Math.max(...weights) / totalWeight;
          fc.pre(maxShare * (overroundMillis / 1_000) < 1);
          const odds = weights.map(
            (weight) => 1 / ((weight / totalWeight) * (overroundMillis / 1_000)),
          );
          const calculate = odds.length === 2 ? powerFairProbs : autoFairProbs;
          const direct = calculate(odds);
          const reversed = calculate([...odds].reverse());

          expect(direct).not.toBeNull();
          expect(reversed).not.toBeNull();
          expect(direct!.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
          expect(direct!.every((value) => value > 0 && value < 1)).toBe(true);
          expect(reversed!.reverse()).toEqual(
            direct!.map((value) => expect.closeTo(value, 10)),
          );
        },
      ),
      PROPERTY_CONFIG,
    );
  });

});
