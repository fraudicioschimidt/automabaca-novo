/**
 * Tamanho de lote adaptativo p/ closing/revive quando elegíveis >> 50.
 * Cap 150: limita trabalho por ciclo; o budget atômico protege as 90 req/h da
 * BridgeOdds sem deixar backlog eterno.
 */
export function adaptiveBatchSize(eligible: number, min = 50, max = 150): number {
  if (!Number.isFinite(eligible) || eligible <= min) return min;
  return Math.min(max, min + Math.floor((eligible - min) / 2));
}
