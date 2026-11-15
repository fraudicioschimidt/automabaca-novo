/**
 * Devigging — remove o juice das odds de um mercado para obter probabilidades
 * e fair odds. Shin e Power são os métodos padrão da indústria (Shin modela
 * viés favorito-azarão; Power é robusto em mercados 2-way). Expõe também as
 * probabilidades justas, que os providers leem direto.
 */

/** Bisseção em [lo, hi] para f(x)=0. Null quando não há raiz no intervalo. */
function solveBisection(
  fn: (x: number) => number,
  lo: number,
  hi: number,
  maxIter = 80,
): number | null {
  let fLo = fn(lo);
  const fHi = fn(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;
  // Extremo que já é raiz (livro normalizado com Σ = 1 − ε) teria o mesmo sinal
  // do outro extremo por um erro de arredondamento.
  if (Math.abs(fLo) < 1e-12) return lo;
  if (Math.abs(fHi) < 1e-12) return hi;
  if (fLo * fHi > 0) return null;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fMid = fn(mid);
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < 1e-12 || Math.abs(hi - lo) < 1e-12) return mid;
    if (fLo * fMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/** Overround máximo aceito (1.35 = 35% de juice — acima disso é dado podre). */
const MAX_BOOK_SUM = 1.35;
/**
 * Underround mínimo aceito. Livro com Σ 1/odds levemente ABAIXO de 1 (arb, ou
 * duas casas no mesmo evento) tem preço válido — só está do outro lado do
 * juice. Recusá-lo deixaria a aposta sem fair NEM CLV, reduzindo justamente a
 * amostra de CLV que é o gargalo do projeto (decisão do dono). Abaixo de 0.90 o
 * dado é podre e é recusado.
 */
const MIN_BOOK_SUM = 0.9;

function impliedFromOdds(odds: ReadonlyArray<number>): number[] | null {
  if (odds.length < 2) return null;
  if (odds.some((o) => !Number.isFinite(o) || o <= 1)) return null;
  const implied = odds.map((o) => 1 / o);
  const sum = implied.reduce((a, b) => a + b, 0);
  if (sum < MIN_BOOK_SUM || sum > MAX_BOOK_SUM) return null;
  // Qualquer soma abaixo de 1 é normalizada: cobre tanto o livro underround de
  // verdade quanto o arredondamento de ponto flutuante que deixa um livro justo
  // a 2e-16 de 1. A divisão não garante Σ = 1 exato; o solver aceita o extremo
  // que já é raiz.
  if (sum < 1) return implied.map((probability) => probability / sum);
  return implied;
}

/**
 * Devig POWER: resolve n tal que Σ p_i^(1/n) = 1. Bom default para 2-way
 * (spread/total) e mercados equilibrados.
 */
export function powerFairProbs(odds: ReadonlyArray<number>): number[] | null {
  const implied = impliedFromOdds(odds);
  if (!implied) return null;

  const n = solveBisection(
    (nn) => implied.reduce((sum, p) => sum + Math.pow(p, 1 / nn), 0) - 1,
    0.0001,
    1,
  );
  if (n === null) return null;

  const probs = implied.map((p) => Math.pow(p, 1 / n));
  const total = probs.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  return probs.map((p) => p / total);
}

/**
 * Devig SHIN: modela proporção z de apostadores informados; corrige o viés
 * favorito-azarão melhor que métodos proporcionais em 3-way (1X2).
 */
export function shinFairProbs(odds: ReadonlyArray<number>): number[] | null {
  const implied = impliedFromOdds(odds);
  if (!implied) return null;
  const impliedProbs = implied;
  const sum = implied.reduce((a, b) => a + b, 0);

  function rawProbs(z: number): number[] | null {
    const denom = 2 * (1 - z);
    if (denom <= 0) return null;
    const probs = impliedProbs.map((io) => {
      const disc = z * z + 4 * (1 - z) * ((io * io) / sum);
      if (disc < 0) return Number.NaN;
      return (Math.sqrt(disc) - z) / denom;
    });
    return probs.every(Number.isFinite) ? probs : null;
  }

  const fn = (zz: number): number => {
    const probs = rawProbs(zz);
    return probs ? probs.reduce((a, b) => a + b, 0) - 1 : Number.NaN;
  };
  const z = solveBisection(fn, 0, 0.4) ?? solveBisection(fn, 0, 0.95);
  if (z === null) return null;

  const probs = rawProbs(z);
  if (!probs) return null;
  const total = probs.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  return probs.map((p) => p / total);
}

function probsToFairOdds(probs: number[] | null): number[] | null {
  if (!probs) return null;
  if (probs.some((p) => !Number.isFinite(p) || p <= 0 || p >= 1)) return null;
  return probs.map((p) => 1 / p);
}

export function powerFairOdds(odds: ReadonlyArray<number>): number[] | null {
  return probsToFairOdds(powerFairProbs(odds));
}

export function shinFairOdds(odds: ReadonlyArray<number>): number[] | null {
  return probsToFairOdds(shinFairProbs(odds));
}

/**
 * Seleção automática: 2-way → power;
 * 3-way com favorito claro (odd mínima ≤ 2) → shin com fallback power;
 * caso contrário power com fallback shin.
 */
export function autoFairOdds(odds: ReadonlyArray<number>): number[] | null {
  if (odds.length === 2) return powerFairOdds(odds);
  const minOdd = Math.min(...odds);
  if (minOdd <= 2) return shinFairOdds(odds) ?? powerFairOdds(odds);
  return powerFairOdds(odds) ?? shinFairOdds(odds);
}

export function autoFairProbs(odds: ReadonlyArray<number>): number[] | null {
  if (odds.length === 2) return powerFairProbs(odds);
  const minOdd = Math.min(...odds);
  if (minOdd <= 2) return shinFairProbs(odds) ?? powerFairProbs(odds);
  return powerFairProbs(odds) ?? shinFairProbs(odds);
}

/**
 * Lado apostado numa linha de quarto. No over, a linha maior é a mais difícil;
 * no under e no handicap (linha na perspectiva da seleção apostada), a menor.
 */
export type QuarterLineSide = "over" | "under" | "handicap";

export type QuarterLineComponent = { readonly lineQ: number; readonly odd: number };

const quarterRemainder = (lineQ: number) => ((lineQ % 4) + 4) % 4;

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
  if (![a, b].every((c) => Number.isInteger(c.lineQ) && Number.isFinite(c.odd) && c.odd > 1)) return null;
  if (Math.abs(a.lineQ - b.lineQ) !== 2) return null;
  const half = quarterRemainder(a.lineQ) === 2 ? a : quarterRemainder(b.lineQ) === 2 ? b : null;
  const whole = half === a ? b : a;
  if (!half || quarterRemainder(whole.lineQ) !== 0) return null;
  const halfIsHarder = params.side === "over" ? half.lineQ > whole.lineQ : half.lineQ < whole.lineQ;
  if (halfIsHarder) return (a.odd + b.odd) / 2;
  return 1 + 2 / (1 / (a.odd - 1) + 1 / (b.odd - 1));
}

/**
 * Quanto uma odd cravada está acima (ou abaixo) da fair correspondente, em %.
 *
 * É a conta do CLV — `percentualContraFair(oddDoTipster, fairDeFechamento)`.
 */
export function percentualContraFair(bookOdd: number, fairOdd: number): number | null {
  if (!Number.isFinite(bookOdd) || !Number.isFinite(fairOdd)) return null;
  if (bookOdd <= 1 || fairOdd <= 1) return null;
  return (bookOdd / fairOdd - 1) * 100;
}
