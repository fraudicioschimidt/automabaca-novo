//! O mercado equivalente que os feeds cotam quando o original não existe
//! neles (DNB → AH 0.0, Dupla Chance 1X/X2 → AH +0.5), portado de
//! `src/domain/mercados/sharp-equivalent.ts`.

use super::classify::{
    MarketKind, MarketPeriod, market_includes_extra_time, market_kind_of, market_period_of,
};
use super::compatibility::restricts_to_regulation_time;
use crate::settlement::sides::{
    Outcome, Side, match_double_chance_selection, match_draw_no_bet_selection,
};
use crate::sports::registry::canonical_sport;
use crate::text::split_evento_teams;

/// A equivalência e a nota que a explica.
pub struct SharpEquivalentBet {
    pub mercado: &'static str,
    pub selecao: String,
    pub nota: &'static str,
}

/// Sem esporte confirmado ou com regras distintas de retirada (tênis), não
/// há equivalência comprovada. `None` é o esporte não informado, que conta
/// como compatível, como o `undefined` do TS; texto vazio não.
pub fn supports_sharp_equivalence(esporte: Option<&str>) -> bool {
    match esporte {
        None => true,
        Some(esporte) => canonical_sport(esporte)
            .is_some_and(|sport| sport != "Tennis" && sport != "Table Tennis"),
    }
}

/// O lado de uma Dupla Chance com o empate; 12 (casa e fora) não tem
/// equivalente de lado único.
fn double_chance_side(selecao: &str, evento: &str) -> Option<Side> {
    let (one, other) = match_double_chance_selection(selecao, evento)?;
    let has = |outcome| one == outcome || other == outcome;
    if has(Outcome::Home) && has(Outcome::Draw) {
        Some(Side::Home)
    } else if has(Outcome::Away) && has(Outcome::Draw) {
        Some(Side::Away)
    } else {
        None
    }
}

/// A tradução para o mercado equivalente cotável; `None` segue o fluxo normal.
pub fn sharp_equivalent_bet(
    mercado: &str,
    selecao: &str,
    evento: &str,
    esporte: Option<&str>,
) -> Option<SharpEquivalentBet> {
    if !supports_sharp_equivalence(esporte) {
        return None;
    }
    let kind = market_kind_of(mercado, selecao, Some(evento));
    // Mercado e seleção são duas superfícies da mesma evidência: traduzir um
    // DNB parcial para AH 0.0 do jogo inteiro fabricaria uma linha que não
    // foi apostada.
    if market_period_of(mercado, None) != MarketPeriod::Ft
        || market_period_of(selecao, None) != MarketPeriod::Ft
        || [mercado, selecao]
            .iter()
            .any(|text| restricts_to_regulation_time(text, esporte))
    {
        return None;
    }
    let market = if [mercado, selecao]
        .iter()
        .any(|text| market_includes_extra_time(text))
    {
        "Asian Handicap – Including Overtime"
    } else {
        "Asian Handicap"
    };
    let (home, away) = split_evento_teams(evento)?;
    let team = |side| match side {
        Side::Home => home.as_str(),
        Side::Away => away.as_str(),
    };
    match kind {
        MarketKind::DrawNoBet => {
            let side = match_draw_no_bet_selection(selecao, evento)?;
            Some(SharpEquivalentBet {
                mercado: market,
                selecao: format!("{} 0.0", team(side)),
                nota: "dnb→ah_0.0",
            })
        }
        MarketKind::DoubleChance => {
            let side = double_chance_side(selecao, evento)?;
            Some(SharpEquivalentBet {
                mercado: market,
                selecao: format!("{} +0.5", team(side)),
                nota: "dc→ah_+0.5",
            })
        }
        _ => None,
    }
}

/// A aposta efetiva para PRECIFICAÇÃO: a original, ou o equivalente AH.
pub fn effective_sharp_bet(
    mercado: &str,
    selecao: &str,
    evento: &str,
    esporte: Option<&str>,
) -> (String, String) {
    match sharp_equivalent_bet(mercado, selecao, evento, esporte) {
        Some(equivalent) => (equivalent.mercado.to_owned(), equivalent.selecao),
        None => (mercado.to_owned(), selecao.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equivalencia_asiatica() {
        let evento = "Flamengo vs Palmeiras";
        assert_eq!(
            effective_sharp_bet("Draw No Bet", "Flamengo", evento, Some("Soccer")),
            ("Asian Handicap".to_owned(), "Flamengo 0.0".to_owned())
        );
        assert_eq!(
            effective_sharp_bet("Dupla Chance", "X2", evento, None),
            ("Asian Handicap".to_owned(), "Palmeiras +0.5".to_owned())
        );
        assert!(sharp_equivalent_bet("Draw No Bet", "Flamengo", evento, Some("Tennis")).is_none());
        assert!(!supports_sharp_equivalence(Some("")));
    }
}
