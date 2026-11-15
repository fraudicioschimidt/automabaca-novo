//! Kelly da calculadora de Ferramentas, portado de `src/domain/kelly.ts`. A
//! vantagem é uma ESTIMATIVA do operador (o CLV médio do tipster é a melhor
//! que se tem): p = (1 + vantagem) / odd.
//!
//! As contas são as do TypeScript, na mesma ordem e em `f64`, para o mesmo
//! resultado bit a bit (o SSR usa a N-API e o navegador, o WebAssembly).

/// Decomposição canônica de Kelly.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KellyAnalysis {
    pub implied_probability: f64,
    pub estimated_probability: f64,
    pub full_fraction: f64,
}

/// `None` quando vantagem/odd implicam probabilidade impossível.
pub fn analyze_kelly(odds: f64, vantagem_pct: f64) -> Option<KellyAnalysis> {
    if !odds.is_finite() || !vantagem_pct.is_finite() || odds <= 1.0 {
        return None;
    }
    let implied_probability = 1.0 / odds;
    let estimated_probability = (1.0 + vantagem_pct / 100.0) / odds;
    if estimated_probability <= 0.0 || estimated_probability >= 1.0 {
        return None;
    }
    let b = odds - 1.0;
    let full_fraction = (b * estimated_probability - (1.0 - estimated_probability)) / b;
    Some(KellyAnalysis {
        implied_probability,
        estimated_probability,
        full_fraction,
    })
}

/// Kelly fracionário, em unidades a cada 100 de banca, limitado pelo teto.
pub fn kelly_stake(odds: f64, vantagem_pct: f64, fraction: f64, cap_units: f64) -> f64 {
    let finite = [odds, vantagem_pct, fraction, cap_units]
        .iter()
        .all(|value| value.is_finite());
    if !finite || odds <= 1.0 || vantagem_pct <= 0.0 || fraction <= 0.0 || cap_units <= 0.0 {
        return 0.0;
    }
    match analyze_kelly(odds, vantagem_pct) {
        Some(analysis) if analysis.full_fraction > 0.0 => {
            cap_units.min(fraction * analysis.full_fraction * 100.0)
        }
        _ => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decomposicao_da_calculadora() {
        let analysis = analyze_kelly(2.0, 10.0);
        assert_eq!(analysis.map(|a| a.implied_probability), Some(0.5));
        assert_eq!(analysis.map(|a| a.estimated_probability), Some(0.55));
        let full = analysis.map_or(f64::NAN, |a| a.full_fraction);
        assert!((full - 0.1).abs() < 1e-12, "{full}");
        assert_eq!(analyze_kelly(1.1, 10.0), None);
        assert_eq!(analyze_kelly(1.0, 10.0), None);
        assert_eq!(analyze_kelly(f64::NAN, 10.0), None);
    }

    #[test]
    fn stake_fracionaria_com_teto() {
        assert!((kelly_stake(2.0, 10.0, 0.25, 5.0) - 2.5).abs() < 1e-9);
        assert_eq!(kelly_stake(2.0, 50.0, 1.0, 5.0), 5.0);
        assert_eq!(kelly_stake(2.0, 0.0, 0.25, 5.0), 0.0);
        assert_eq!(kelly_stake(2.0, -5.0, 0.25, 5.0), 0.0);
        assert_eq!(kelly_stake(1.0, 10.0, 0.25, 5.0), 0.0);
        assert_eq!(kelly_stake(2.0, f64::NAN, 0.25, 5.0), 0.0);
        assert_eq!(kelly_stake(2.0, 10.0, -1.0, 5.0), 0.0);
        assert_eq!(kelly_stake(2.0, 10.0, 0.25, f64::INFINITY), 0.0);
    }
}
