/**
 * Status finais (com efeito financeiro) — fonte ÚNICA da lista (antes havia
 * 4 cópias em queries/analyzer/backtest). Módulo client-safe: tipos puros
 * de domínio (o enum-valor do Prisma não pode entrar em bundle de browser).
 */
export const FINAL_BET_STATUSES = [
  "WON",
  "LOST",
  "HALF_WON",
  "HALF_LOST",
  "CASHOUT",
] as const;

export const FINAL_BET_STATUSES_SET: ReadonlySet<string> = new Set(FINAL_BET_STATUSES);

export const ALL_BET_STATUSES = [
  "PENDING",
  "WON",
  "LOST",
  "HALF_WON",
  "HALF_LOST",
  "VOID",
  "CASHOUT",
  "CANCELED",
] as const;

export type BetStatus = typeof ALL_BET_STATUSES[number];

