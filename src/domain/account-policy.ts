/** Limite de Decimal(12,2), usado na criação e em todo movimento manual. */
export const MAX_ACCOUNT_BALANCE = 9_999_999_999.99;

export const MANUAL_MOVEMENT_TYPES: ReadonlySet<string> = new Set([
  "DEPOSITO", "SAQUE", "AJUSTE_MANUAL", "BONUS",
]);

export function isManualMovementId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(value);
}
