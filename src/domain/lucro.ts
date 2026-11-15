import type { BetStatus } from "@/src/domain/bet-status";
import { BET_UNIT_MIN_AMOUNT, multiplyMoneyDecimal, roundMoney } from "@/src/domain/money";

/** Valor informado pelo operador fora dos limites da aposta. */
export class InvalidCashoutLucroError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCashoutLucroError";
  }
}

/**
 * Fonte única do invariante "lucro deriva do status": cópias inline desta
 * regra divergem. Tudo em unidades de stake.
 */
export function computeLucroFromStatus(args: {
  status: BetStatus;
  stake: number;
  odds: number;
  /** Só usado em CASHOUT (lucro informado manualmente). */
  currentLucro?: number;
}): number {
  const { status, stake, odds } = args;
  if (!Number.isFinite(stake) || stake <= 0) {
    throw new Error("Stake inválida para calcular o lucro.");
  }
  const hasValidOdds = Number.isFinite(odds) && odds > 1;

  switch (status) {
    case "WON":
      if (!hasValidOdds) throw new Error("Odd inválida para calcular uma aposta ganha.");
      return multiplyMoneyDecimal(stake, odds - 1);
    case "LOST":
      return roundMoney(-stake);
    case "HALF_WON":
      if (!hasValidOdds) throw new Error("Odd inválida para calcular uma meia aposta ganha.");
      return multiplyMoneyDecimal(stake, odds - 1, { divisor: 2 });
    case "HALF_LOST":
      return multiplyMoneyDecimal(stake, -1, { multiplierDecimals: 0, divisor: 2 });
    case "PENDING":
    case "VOID":
    case "CANCELED":
      return 0;
    case "CASHOUT": {
      const currentLucro = args.currentLucro;
      if (currentLucro === undefined || !Number.isFinite(currentLucro)) {
        throw new Error("Lucro do cashout inválido.");
      }
      return roundMoney(currentLucro);
    }
  }
}

/**
 * Valida o lucro informado num CASHOUT: precisa caber no intervalo possível
 * da aposta — entre perder tudo (-stake) e o lucro pleno (stake×(odds-1)),
 * após normalização para as seis casas da coluna de unidades. Lança com
 * mensagem acionável e devolve o valor normalizado que deve ser persistido.
 */
export function validateCashoutLucro(args: {
  lucro: number;
  stake: number;
  odds: number;
}): number {
  const { lucro, stake, odds } = args;
  if (!Number.isFinite(lucro)) {
    throw new InvalidCashoutLucroError("Lucro do cashout inválido — informe um número em unidades.");
  }
  if (!Number.isFinite(stake) || stake <= 0) {
    throw new Error("Stake inválida para validar o cashout.");
  }
  if (!Number.isFinite(odds) || odds <= 1) {
    throw new Error("Odd inválida para validar o cashout.");
  }
  const normalized = roundMoney(lucro);
  const min = roundMoney(-stake);
  const max = multiplyMoneyDecimal(stake, odds - 1);
  if (normalized < min - BET_UNIT_MIN_AMOUNT || normalized > max + BET_UNIT_MIN_AMOUNT) {
    const formatBoundary = (value: number) => value.toFixed(6).replace(/\.?0+$/, "");
    throw new InvalidCashoutLucroError(
      `Lucro de cashout fora do intervalo possível desta aposta ` +
        `(entre ${formatBoundary(min)} e ${formatBoundary(max)} unidades).`,
    );
  }
  return normalized;
}
