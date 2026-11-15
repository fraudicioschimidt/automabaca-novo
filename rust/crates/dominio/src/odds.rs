//! Devigging, portado de `src/domain/odds.ts`: tira o juice das odds de um
//! mercado para chegar às probabilidades e às fair odds. Shin modela o viés
//! favorito-azarão; Power é robusto em mercados de dois resultados.
//!
//! As somas seguem a ordem do `reduce` do TypeScript, a partir de zero, e o
//! `pow` é o do `js-math`: o resultado é o mesmo número que o TS dava.

/// Overround máximo aceito (1.35 = 35% de juice — acima disso é dado podre).
const MAX_BOOK_SUM: f64 = 1.35;
/// Underround mínimo aceito: livro levemente abaixo de 1 (arb, ou duas casas
/// no mesmo evento) tem preço válido; abaixo de 0.90 o dado é podre.
const MIN_BOOK_SUM: f64 = 0.9;
const MAX_BISECTION_STEPS: usize = 80;

fn sum(values: &[f64]) -> f64 {
    values.iter().fold(0.0, |total, value| total + value)
}

/// Bisseção em [lo, hi] para f(x) = 0. `None` quando não há raiz no intervalo.
fn solve_bisection(function: &dyn Fn(f64) -> f64, mut lo: f64, mut hi: f64) -> Option<f64> {
    let mut f_lo = function(lo);
    let f_hi = function(hi);
    if !f_lo.is_finite() || !f_hi.is_finite() {
        return None;
    }
    // Extremo que já é raiz (livro normalizado com Σ = 1 − ε) teria o mesmo
    // sinal do outro extremo por um erro de arredondamento.
    if f_lo.abs() < 1e-12 {
        return Some(lo);
    }
    if f_hi.abs() < 1e-12 {
        return Some(hi);
    }
    if f_lo * f_hi > 0.0 {
        return None;
    }
    for _ in 0..MAX_BISECTION_STEPS {
        let mid = (lo + hi) / 2.0;
        let f_mid = function(mid);
        if !f_mid.is_finite() {
            return None;
        }
        if f_mid.abs() < 1e-12 || (hi - lo).abs() < 1e-12 {
            return Some(mid);
        }
        if f_lo * f_mid <= 0.0 {
            hi = mid;
        } else {
            lo = mid;
            f_lo = f_mid;
        }
    }
    Some((lo + hi) / 2.0)
}

fn implied_from_odds(odds: &[f64]) -> Option<Vec<f64>> {
    if odds.len() < 2 || odds.iter().any(|odd| !odd.is_finite() || *odd <= 1.0) {
        return None;
    }
    let implied: Vec<f64> = odds.iter().map(|odd| 1.0 / odd).collect();
    let total = sum(&implied);
    if !(MIN_BOOK_SUM..=MAX_BOOK_SUM).contains(&total) {
        return None;
    }
    // Abaixo de 1, normaliza: cobre o livro underround e o arredondamento que
    // deixa um livro justo a 2e-16 de 1.
    if total < 1.0 {
        return Some(
            implied
                .iter()
                .map(|probability| probability / total)
                .collect(),
        );
    }
    Some(implied)
}

fn normalized(probabilities: Vec<f64>) -> Option<Vec<f64>> {
    let total = sum(&probabilities);
    if !total.is_finite() || total <= 0.0 {
        return None;
    }
    Some(
        probabilities
            .iter()
            .map(|probability| probability / total)
            .collect(),
    )
}

/// Devig POWER: resolve n tal que Σ p_i^(1/n) = 1.
pub fn power_fair_probs(odds: &[f64]) -> Option<Vec<f64>> {
    let implied = implied_from_odds(odds)?;
    let equation = |n: f64| {
        implied
            .iter()
            .fold(0.0, |total, p| total + js_math::pow(*p, 1.0 / n))
            - 1.0
    };
    let n = solve_bisection(&equation, 0.0001, 1.0)?;
    normalized(implied.iter().map(|p| js_math::pow(*p, 1.0 / n)).collect())
}

/// Devig SHIN: proporção z de apostadores informados.
pub fn shin_fair_probs(odds: &[f64]) -> Option<Vec<f64>> {
    let implied = implied_from_odds(odds)?;
    let book = sum(&implied);
    let raw_probs = |z: f64| -> Option<Vec<f64>> {
        let denominator = 2.0 * (1.0 - z);
        if denominator <= 0.0 {
            return None;
        }
        let probabilities: Vec<f64> = implied
            .iter()
            .map(|io| {
                let disc = z * z + 4.0 * (1.0 - z) * ((io * io) / book);
                if disc < 0.0 {
                    f64::NAN
                } else {
                    (disc.sqrt() - z) / denominator
                }
            })
            .collect();
        probabilities
            .iter()
            .all(|p| p.is_finite())
            .then_some(probabilities)
    };
    let equation =
        |z: f64| raw_probs(z).map_or(f64::NAN, |probabilities| sum(&probabilities) - 1.0);
    let z =
        solve_bisection(&equation, 0.0, 0.4).or_else(|| solve_bisection(&equation, 0.0, 0.95))?;
    normalized(raw_probs(z)?)
}

fn probs_to_fair_odds(probabilities: Option<Vec<f64>>) -> Option<Vec<f64>> {
    let probabilities = probabilities?;
    if probabilities
        .iter()
        .any(|p| !p.is_finite() || *p <= 0.0 || *p >= 1.0)
    {
        return None;
    }
    Some(probabilities.iter().map(|p| 1.0 / p).collect())
}

pub fn power_fair_odds(odds: &[f64]) -> Option<Vec<f64>> {
    probs_to_fair_odds(power_fair_probs(odds))
}

pub fn shin_fair_odds(odds: &[f64]) -> Option<Vec<f64>> {
    probs_to_fair_odds(shin_fair_probs(odds))
}

/// `Math.min(...odds)`: NaN se houver NaN, +∞ para a lista vazia.
fn js_min(values: &[f64]) -> f64 {
    values.iter().fold(f64::INFINITY, |least, value| {
        if least.is_nan() || value.is_nan() {
            f64::NAN
        } else {
            least.min(*value)
        }
    })
}

/// 2-way → power; 3-way com favorito claro (odd mínima ≤ 2) → shin com
/// fallback power; senão power com fallback shin.
pub fn auto_fair_odds(odds: &[f64]) -> Option<Vec<f64>> {
    if odds.len() == 2 {
        return power_fair_odds(odds);
    }
    if js_min(odds) <= 2.0 {
        shin_fair_odds(odds).or_else(|| power_fair_odds(odds))
    } else {
        power_fair_odds(odds).or_else(|| shin_fair_odds(odds))
    }
}

pub fn auto_fair_probs(odds: &[f64]) -> Option<Vec<f64>> {
    if odds.len() == 2 {
        return power_fair_probs(odds);
    }
    if js_min(odds) <= 2.0 {
        shin_fair_probs(odds).or_else(|| power_fair_probs(odds))
    } else {
        power_fair_probs(odds).or_else(|| shin_fair_probs(odds))
    }
}

/// Um componente de linha de quarto: a linha em quartos e a odd dela.
#[derive(Debug, Clone, Copy)]
pub struct QuarterLineComponent {
    pub line_q: f64,
    pub odd: f64,
}

fn quarter_remainder(line_q: f64) -> f64 {
    ((line_q % 4.0) + 4.0) % 4.0
}

/// Odd de uma linha de quarto a partir das odds dos dois componentes. Se o
/// componente de meio ponto é o mais difícil, a odd é a média das odds; se é
/// o mais fácil, a média é a de 1/(F−1). `side` é `over`, `under` ou
/// `handicap` (linha na perspectiva da seleção apostada).
pub fn combine_quarter_line_odds(
    side: &str,
    a: QuarterLineComponent,
    b: QuarterLineComponent,
) -> Option<f64> {
    let valid =
        |c: &QuarterLineComponent| c.line_q.fract() == 0.0 && c.odd.is_finite() && c.odd > 1.0;
    if !valid(&a) || !valid(&b) || (a.line_q - b.line_q).abs() != 2.0 {
        return None;
    }
    let (half, whole) = if quarter_remainder(a.line_q) == 2.0 {
        (a, b)
    } else if quarter_remainder(b.line_q) == 2.0 {
        (b, a)
    } else {
        return None;
    };
    if quarter_remainder(whole.line_q) != 0.0 {
        return None;
    }
    let half_is_harder = if side == "over" {
        half.line_q > whole.line_q
    } else {
        half.line_q < whole.line_q
    };
    if half_is_harder {
        Some((a.odd + b.odd) / 2.0)
    } else {
        Some(1.0 + 2.0 / (1.0 / (a.odd - 1.0) + 1.0 / (b.odd - 1.0)))
    }
}

/// Quanto uma odd cravada está acima (ou abaixo) da fair, em %: a conta do CLV.
pub fn percentual_contra_fair(book_odd: f64, fair_odd: f64) -> Option<f64> {
    if !book_odd.is_finite() || !fair_odd.is_finite() || book_odd <= 1.0 || fair_odd <= 1.0 {
        return None;
    }
    Some((book_odd / fair_odd - 1.0) * 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn devig_soma_um() {
        for odds in [vec![1.91, 1.91], vec![2.1, 3.4, 3.6], vec![1.5, 4.2, 6.5]] {
            for probabilities in [power_fair_probs(&odds), shin_fair_probs(&odds)] {
                let total = sum(&probabilities.unwrap_or_default());
                assert!(close(total, 1.0), "{odds:?} {total}");
            }
        }
        let fair = power_fair_odds(&[1.91, 1.91]).unwrap_or_default();
        assert!(close(fair[0], 2.0) && close(fair[1], 2.0), "{fair:?}");
    }

    #[test]
    fn recusa_livro_podre() {
        assert_eq!(power_fair_probs(&[1.0, 2.0]), None);
        assert_eq!(power_fair_probs(&[1.2, 1.2]), None);
        assert_eq!(power_fair_probs(&[3.0, 3.0]), None);
        assert_eq!(power_fair_probs(&[2.0]), None);
        assert_eq!(auto_fair_odds(&[]), None);
        assert_eq!(auto_fair_odds(&[f64::NAN, 2.0, 3.0]), None);
    }

    #[test]
    fn linha_de_quarto() {
        let c = |line_q: f64, odd: f64| QuarterLineComponent { line_q, odd };
        // Over 2,25 = metade em 2 (push possível) e metade em 2,5.
        assert_eq!(
            combine_quarter_line_odds("over", c(8.0, 1.8), c(10.0, 2.0)),
            Some(1.9)
        );
        let easier =
            combine_quarter_line_odds("under", c(8.0, 1.8), c(10.0, 2.0)).unwrap_or_default();
        assert!(close(easier, 1.0 + 2.0 / (1.0 / 0.8 + 1.0)), "{easier}");
        assert_eq!(
            combine_quarter_line_odds("over", c(8.0, 1.8), c(12.0, 2.0)),
            None
        );
        assert_eq!(
            combine_quarter_line_odds("over", c(8.5, 1.8), c(10.5, 2.0)),
            None
        );
    }

    #[test]
    fn clv() {
        assert!(close(
            percentual_contra_fair(2.1, 2.0).unwrap_or_default(),
            5.0
        ));
        assert_eq!(percentual_contra_fair(1.0, 2.0), None);
        assert_eq!(percentual_contra_fair(f64::NAN, 2.0), None);
    }
}
