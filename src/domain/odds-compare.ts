/**
 * Razão a partir da qual duas odds da mesma aposta não são o mesmo preço
 * (linha que andou, piso do tipster) e sim uma leitura errada: 1,85 × 18,5,
 * 2,10 × 1,20. Turbinada de mais de 25% também cai aqui e vai para o dono.
 */
const WIDE_DIVERGENCE_RATIO = 1.25;

export function oddsDivergeWidely(a: number, b: number): boolean {
  return Math.max(a, b) / Math.min(a, b) > WIDE_DIVERGENCE_RATIO;
}
