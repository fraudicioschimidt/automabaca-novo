// A regra mora em Rust (`rust/crates/dominio/src/kelly.rs`): no servidor pela
// N-API, no navegador (a calculadora de Ferramentas) pelo WebAssembly. Este
// arquivo só monta o objeto e guarda os padrões da tela.
import dominio from "@automabaca/dominio";

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
  const analysis = dominio.analyzeKelly(odds, vantagemPct);
  if (!analysis) return null;
  const [impliedProbability, estimatedProbability, fullFraction] = analysis;
  return { impliedProbability, estimatedProbability, fullFraction };
}

/** Kelly fracionário, em unidades a cada 100 de banca, limitado pelo teto. */
export function kellyStake(params: {
  odds: number;
  vantagemPct: number;
  fraction: number;
  capUnits: number;
}): number {
  return dominio.kellyStake(params.odds, params.vantagemPct, params.fraction, params.capUnits);
}

/** A fração e o teto com que a calculadora de Ferramentas abre. */
export const KELLY_DEFAULT_FRACTION = 0.25;
export const KELLY_DEFAULT_CAP_UNITS = 10;
