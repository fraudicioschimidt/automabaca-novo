import { isPriceSnapshot } from "./price-provenance";

/** UI/análises atuais têm faixas em dólar; outra moeda não é comparável. */
export function comparableUsdLiquidity(
  value: number | null | undefined,
  currency: string | null | undefined,
): number | null {
  return currency === "USD" && value !== null && value !== undefined &&
      Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** Limite da linha cotada: componente de preço sintético não prova limite dela. */
export function quotedLiquidityLimit(snapshot: unknown, stored: number | null): number | null {
  if (!isPriceSnapshot(snapshot) || snapshot.combination !== "single") return null;
  const value = snapshot.maxBet === undefined ? stored : snapshot.maxBet;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
