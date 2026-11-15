// A regra mora em Rust (`rust/crates/dominio/src/odds.rs`): no servidor pela
// N-API, nas telas pelo WebAssembly. O `pow` é o `Math.pow` do JavaScript nos
// dois lados (crate `js-math`), então os números são os de antes.
import dominio from "@automabaca/dominio";

/**
 * Devigging — remove o juice das odds de um mercado para obter probabilidades
 * e fair odds. Shin e Power são os métodos padrão da indústria (Shin modela
 * viés favorito-azarão; Power é robusto em mercados 2-way). Expõe também as
 * probabilidades justas, que os providers leem direto.
 */

/**
 * Devig POWER: resolve n tal que Σ p_i^(1/n) = 1. Bom default para 2-way
 * (spread/total) e mercados equilibrados.
 */
export function powerFairProbs(odds: ReadonlyArray<number>): number[] | null {
  return dominio.powerFairProbs(odds);
}

/**
 * Devig SHIN: modela proporção z de apostadores informados; corrige o viés
 * favorito-azarão melhor que métodos proporcionais em 3-way (1X2).
 */
export function shinFairProbs(odds: ReadonlyArray<number>): number[] | null {
  return dominio.shinFairProbs(odds);
}

export function powerFairOdds(odds: ReadonlyArray<number>): number[] | null {
  return dominio.powerFairOdds(odds);
}

export function shinFairOdds(odds: ReadonlyArray<number>): number[] | null {
  return dominio.shinFairOdds(odds);
}

/**
 * Seleção automática: 2-way → power;
 * 3-way com favorito claro (odd mínima ≤ 2) → shin com fallback power;
 * caso contrário power com fallback shin.
 */
export function autoFairOdds(odds: ReadonlyArray<number>): number[] | null {
  return dominio.autoFairOdds(odds);
}

export function autoFairProbs(odds: ReadonlyArray<number>): number[] | null {
  return dominio.autoFairProbs(odds);
}

/**
 * Lado apostado numa linha de quarto. No over, a linha maior é a mais difícil;
 * no under e no handicap (linha na perspectiva da seleção apostada), a menor.
 */
export type QuarterLineSide = "over" | "under" | "handicap";

export type QuarterLineComponent = { readonly lineQ: number; readonly odd: number };

/**
 * Odd de uma linha de quarto (ex.: AH −0,25 = meia stake em AH 0 e meia em
 * AH −0,5) a partir das odds dos dois componentes, com as linhas em quartos.
 *
 * O componente de meio ponto não tem push, e a conta exata depende de onde ele
 * fica. Se é o mais difícil, os dois ganham no mesmo evento e a odd é a média
 * das odds; se é o mais fácil, os dois perdem no mesmo evento e a média é a de
 * 1/(F−1). Média de probabilidades ignora o push e erra nos dois casos.
 */
export function combineQuarterLineOdds(params: {
  side: QuarterLineSide;
  components: readonly [QuarterLineComponent, QuarterLineComponent];
}): number | null {
  const [a, b] = params.components;
  return dominio.combineQuarterLineOdds(params.side, a.lineQ, a.odd, b.lineQ, b.odd);
}

/**
 * Quanto uma odd cravada está acima (ou abaixo) da fair correspondente, em %.
 *
 * É a conta do CLV — `percentualContraFair(oddDoTipster, fairDeFechamento)`.
 */
export function percentualContraFair(bookOdd: number, fairOdd: number): number | null {
  return dominio.percentualContraFair(bookOdd, fairOdd);
}
