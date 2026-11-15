/**
 * Kelly da calculadora de Ferramentas — domínio puro (client-safe). A vantagem
 * é uma ESTIMATIVA do operador (o CLV médio do tipster é a melhor que se tem):
 * p = (1 + vantagem) / odd.
 */
export type KellyAnalysis = {
  impliedProbability: number;
  estimatedProbability: number;
  fullFraction: number;
};

/** Decomposição canônica de Kelly; null quando vantagem/odd implicam probabilidade impossível. */
export function analyzeKelly(odds: number, vantagemPct: number): KellyAnalysis | null {
  if (!Number.isFinite(odds) || !Number.isFinite(vantagemPct) || odds <= 1) return null;
  const impliedProbability = 1 / odds;
  const estimatedProbability = (1 + vantagemPct / 100) / odds;
  if (estimatedProbability <= 0 || estimatedProbability >= 1) return null;
  const b = odds - 1;
  const fullFraction =
    (b * estimatedProbability - (1 - estimatedProbability)) / b;
  return { impliedProbability, estimatedProbability, fullFraction };
}

/** Kelly fracionário, em unidades a cada 100 de banca, limitado pelo teto. */
export function kellyStake(params: {
  odds: number;
  vantagemPct: number;
  fraction: number;
  capUnits: number;
}): number {
  const { odds, vantagemPct, fraction, capUnits } = params;
  if (
    !Number.isFinite(odds) ||
    !Number.isFinite(vantagemPct) ||
    !Number.isFinite(fraction) ||
    !Number.isFinite(capUnits) ||
    odds <= 1 ||
    vantagemPct <= 0 ||
    fraction <= 0 ||
    capUnits <= 0
  ) return 0;
  const analysis = analyzeKelly(odds, vantagemPct);
  if (!analysis) return 0;
  const kelly = analysis.fullFraction;
  if (kelly <= 0) return 0;
  return Math.min(capUnits, fraction * kelly * 100);
}

/** A fração e o teto com que a calculadora de Ferramentas abre. */
export const KELLY_DEFAULT_FRACTION = 0.25;
export const KELLY_DEFAULT_CAP_UNITS = 10;
