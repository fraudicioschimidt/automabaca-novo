/**
 * Taxa de acerto canônica por resultado esportivo. Cashout e push não dizem se
 * a seleção acertou; resultados asiáticos de meia linha pesam metade.
 */
export type HitRateCounts = {
  won: number;
  lost: number;
  halfWon: number;
  halfLost: number;
};

function assertHitRateCount(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`hitRate: ${name} inválido (${String(value)})`);
  }
  return value;
}

export function hitRateFromCounts(counts: HitRateCounts): number | null {
  const won = assertHitRateCount(counts.won, "won");
  const lost = assertHitRateCount(counts.lost, "lost");
  const halfWon = assertHitRateCount(counts.halfWon, "halfWon");
  const halfLost = assertHitRateCount(counts.halfLost, "halfLost");
  const winWeight = won + halfWon * 0.5;
  const decisionWeight = won + lost + (halfWon + halfLost) * 0.5;
  return decisionWeight > 0 ? (winWeight / decisionWeight) * 100 : null;
}
