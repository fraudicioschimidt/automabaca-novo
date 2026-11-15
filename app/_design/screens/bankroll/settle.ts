import type { BetStatus } from "@/src/domain/bet-status";
import { computeLucroFromStatus, validateCashoutLucro } from "@/src/domain/lucro";
import type { StatusDeTela } from "@/src/domain/status-de-aposta";
import type { Theme } from "../../theme";

const DOMAIN_STATUS: Record<Exclude<StatusDeTela, "pending">, BetStatus> = {
  won: "WON",
  halfwon: "HALF_WON",
  lost: "LOST",
  half: "HALF_LOST",
  void: "VOID",
  cashout: "CASHOUT",
};

/** [resultado, rótulo, cor] */
export type ResultOption = [StatusDeTela, string, string];

// Resultados manuais; cores espelham a StatusPill. Cashout pede valor.
export function makeResults(T: Theme): ResultOption[] {
  return [
    ['won', 'Ganha', T.pos], ['halfwon', '½ Ganha', T.pos],
    ['lost', 'Perdida', T.neg], ['half', '½ Perdida', T.neg],
    ['void', 'Reembolso', T.textMuted], ['cashout', 'Cashout total', T.accent],
    ['pending', 'Pendente', T.textFaint],
  ];
}

export function resultLabelFromResults(results: readonly ResultOption[]): Record<string, string> {
  return Object.fromEntries(results.map(([k, lb]) => [k, lb]));
}

export type LocalOverride = { status: StatusDeTela; profit: number | null };

/** Resultado que a tela aplica sem servidor (mock); o lucro sai da mesma regra do domínio. */
export function computeOverride(
  b: { stake: number; odds: number },
  result: StatusDeTela,
  cashoutLucro?: number,
  canonicalProfit?: number,
): LocalOverride {
  const serverProfit = typeof canonicalProfit === "number" && Number.isFinite(canonicalProfit) ? canonicalProfit : null;
  if (result !== 'pending' && serverProfit !== null) {
    return { status: result, profit: serverProfit };
  }
  if (result === 'pending') return { status: 'pending', profit: null };
  const status = DOMAIN_STATUS[result];
  if (!status) throw new Error(`Resultado inválido: ${result}`);
  const profit = result === 'cashout'
    ? validateCashoutLucro({ lucro: cashoutLucro ?? Number.NaN, stake: b.stake, odds: b.odds })
    : computeLucroFromStatus({ status, stake: b.stake, odds: b.odds });
  return { status: result, profit };
}
