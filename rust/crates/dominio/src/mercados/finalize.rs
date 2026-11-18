//! O rótulo FINAL da Pinnacle a partir do canônico de entrada e do esporte,
//! o mercado do tempo regulamentar e o período declarado na troca de mercado,
//! portados de `src/domain/mercados/finalize.ts`.

use super::catalog::resolve_mercado_static;
use super::classify::{MarketKind, MarketPeriod, market_kind_of, market_period_of};
use super::compatibility::{
    MarketSport, REGULATION_TIME_MONEYLINE, REGULATION_TIME_SPORTS, REGULATION_TIME_SPREAD,
    REGULATION_TIME_TOTAL, is_mercado_final_for_sport, market_sport_of, regulation_time_base_of,
};
use crate::js;
use crate::settlement::sides::{Outcome, match_moneyline_selection};

use MarketSport::{
    AmericanFootball, Baseball, Basketball, BeachVolleyball, Esports, Futsal, Handball, Hockey,
    Other, Soccer, TableTennis, Tennis, Volleyball,
};

type BySport = &'static [(MarketSport, &'static str)];

/// "Moneyline" e "Money Line" são o mesmo mercado.
const MONEYLINE_BY_SPORT: BySport = &[
    (Soccer, "Money Line – Match"),
    (Esports, "Money Line – Match"),
    (Basketball, "Money Line – Game"),
    (Baseball, "Money Line – Game"),
    (Tennis, "Match Winner"),
    (Hockey, "Money Line"),
    (AmericanFootball, "Money Line"),
];

const FINAL_BY_SPORT: &[(&str, BySport)] = &[
    ("Moneyline", MONEYLINE_BY_SPORT),
    ("Money Line", MONEYLINE_BY_SPORT),
    (
        "Asian Handicap",
        &[
            (Soccer, "Handicap – Match"),
            (Basketball, "Handicap – Game"),
            (Tennis, "Handicap (Games) – Match"),
            (Esports, "Handicap – Match"),
            (Baseball, "Handicap – Game"),
            (Hockey, "Puck Line"),
            (AmericanFootball, "Point Spread"),
            (Volleyball, "Handicap (Sets) – Match"),
            (TableTennis, "Handicap (Sets) – Match"),
            (BeachVolleyball, "Handicap (Sets) – Match"),
            (Handball, "Handicap – Match"),
            (Futsal, "Handicap – Match"),
        ],
    ),
    ("Point Spread", &[(Basketball, "Handicap – Game")]),
    (
        "Total",
        &[
            (Soccer, "Total – Match"),
            (Basketball, "Total Points"),
            (Baseball, "Total – Game"),
            (Tennis, "Total (Games) – Match"),
            (Esports, "Total – Match"),
            (Handball, "Total – Match"),
            (Futsal, "Total – Match"),
            (Hockey, "Total – Match"),
            (Volleyball, "Total (Sets) – Match"),
            (TableTennis, "Total (Sets) – Match"),
            (BeachVolleyball, "Total (Sets) – Match"),
        ],
    ),
    (
        "1st Half Total",
        &[
            (Basketball, "1st Half Total Points"),
            (Soccer, "Total – 1st Half"),
        ],
    ),
    (
        "1st Half Moneyline",
        &[
            (Soccer, "Money Line – 1st Half"),
            (Basketball, "Money Line – 1st Half"),
        ],
    ),
    (
        "1st Half Handicap",
        &[
            (Soccer, "Handicap – 1st Half"),
            (Basketball, "Handicap – 1st Half"),
        ],
    ),
    (
        "Team Total",
        &[
            (Soccer, "Team Total – Match"),
            (Tennis, "Team Total (Games) – Match"),
            (Other, "Team Total – Match"),
        ],
    ),
];

/// Escanteios e cartões: o rótulo final independe do esporte (só existem no
/// futebol).
const FINAL_FIXED: &[(&str, &str)] = &[
    ("Asian Total Corners", "Total (Corners) – Match"),
    ("Corners O/U", "Total (Corners) – Match"),
    ("Corners", "Total (Corners) – Match"),
    ("Asian Handicap Corners", "Handicap (Corners) – Match"),
    ("1st Half Asian Corners", "Handicap (Corners) – 1st Half"),
    ("Total Cards", "Total (Bookings) – Match"),
    ("Asian Total Cards", "Total (Bookings) – Match"),
    ("Cards O/U", "Total (Bookings) – Match"),
    ("Cards", "Total (Bookings) – Match"),
    ("Asian Handicap Cards", "Handicap (Bookings) – Match"),
    ("Double Chance – Match", "Double Chance"),
    ("Double Chance - Match", "Double Chance"),
    ("Run Line", "Handicap – Game"),
];

/// Props de jogador e gols do jogador: o rótulo já é o final.
const FINAL_AS_IS: &[&str] = &[
    "Player Props",
    "Player Points/Rebounds/Assists",
    "Player Points",
    "Player Rebounds",
    "Player Assists",
    "Shots",
    "Shots On Target",
    "To Score 2+ Goals",
    "To Score 3+ Goals",
];

fn lookup<T: Copy>(table: &[(&str, T)], key: &str) -> Option<T> {
    table
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| *value)
}

fn for_sport(table: BySport, sport: MarketSport) -> Option<&'static str> {
    table
        .iter()
        .find(|(entry, _)| *entry == sport)
        .map(|(_, label)| *label)
}

/// Rótulo FINAL da Pinnacle a partir do canônico de entrada e do esporte. As
/// tabelas são lidas por igualdade: o TS lia objetos comuns, e "constructor"
/// dava a função herdada do protótipo (a chamada quebrava); aqui o texto
/// volta como veio.
pub fn finalize_pinnacle_market(mercado: &str, esporte: Option<&str>) -> String {
    if FINAL_AS_IS.contains(&mercado) {
        return mercado.to_owned();
    }
    let slug = market_sport_of(esporte);
    let again = |base: &str| finalize_pinnacle_market(base, esporte);
    // Fora dos esportes com prorrogação, o tempo regulamentar É o mercado do
    // jogo (o 1X2 do futebol é o Money Line – Match).
    if let Some(base) = regulation_time_base_of(mercado)
        && !REGULATION_TIME_SPORTS.contains(&slug)
        && slug != Other
    {
        return again(base);
    }
    match mercado {
        "Match Winner" if slug != Tennis => return again("Moneyline"),
        "Money Line – Match" if !matches!(slug, Soccer | Esports | Other) => {
            return again("Moneyline");
        }
        "Money Line – Game" if !matches!(slug, Basketball | Baseball) => {
            return again("Moneyline");
        }
        // Sem rótulo observado para o esporte, fica a forma externa como
        // conceito intermediário: roteável por semântica, mas fora do
        // catálogo final.
        "Moneyline" | "Money Line" => {
            return for_sport(MONEYLINE_BY_SPORT, slug)
                .unwrap_or(mercado)
                .to_owned();
        }
        "Handicap – Match" if !matches!(slug, Soccer | Esports | Other) => {
            return again("Asian Handicap");
        }
        "Handicap – Game" if !matches!(slug, Basketball | Baseball) => {
            return again("Asian Handicap");
        }
        "Total – Match" if matches!(slug, Basketball | Baseball | Tennis) => {
            return again("Total");
        }
        "Total – Game" if slug != Baseball => return again("Total"),
        "Team Total – Match" if slug == Tennis => return again("Team Total"),
        _ => {}
    }
    if let Some(fixed) = lookup(FINAL_FIXED, mercado) {
        return if is_mercado_final_for_sport(fixed, esporte) {
            fixed
        } else {
            mercado
        }
        .to_owned();
    }
    let Some(by_sport) = lookup(FINAL_BY_SPORT, mercado) else {
        return mercado.to_owned();
    };
    let candidate = for_sport(by_sport, slug).unwrap_or(mercado);
    if is_mercado_final_for_sport(candidate, esporte) {
        candidate
    } else {
        mercado
    }
    .to_owned()
}

/// Troca o mercado de jogo inteiro pelo do tempo regulamentar quando a aposta
/// o declara (`declared`, lido do texto cru) num esporte com prorrogação.
/// Aposta no empate nesses esportes só existe no tempo normal e também troca.
/// Com o esporte ainda desconhecido, a declaração já grava o mercado do tempo
/// regulamentar, e a confirmação do esporte o devolve ao do jogo se ele não
/// tiver prorrogação.
pub fn regulation_time_market(
    mercado: &str,
    selecao: &str,
    evento: &str,
    esporte: Option<&str>,
    declared: bool,
) -> String {
    let slug = market_sport_of(esporte);
    let overtime_sport = REGULATION_TIME_SPORTS.contains(&slug);
    if !overtime_sport && slug != Other {
        return mercado.to_owned();
    }
    if market_period_of(mercado, esporte) != MarketPeriod::Ft {
        return mercado.to_owned();
    }
    let regulation = match market_kind_of(mercado, selecao, Some(evento)) {
        MarketKind::Moneyline => REGULATION_TIME_MONEYLINE,
        MarketKind::Spread => REGULATION_TIME_SPREAD,
        MarketKind::Total => REGULATION_TIME_TOTAL,
        _ => return mercado.to_owned(),
    };
    let draw_bet = overtime_sport
        && regulation == REGULATION_TIME_MONEYLINE
        && match_moneyline_selection(selecao, evento, false) == Some(Outcome::Draw);
    if declared || draw_bet {
        regulation.to_owned()
    } else {
        mercado.to_owned()
    }
}

/// Mercado em estilo Pinnacle: tradução estática e finalização por esporte.
pub fn pinnacleize_mercado(mercado: &str, esporte: Option<&str>) -> String {
    let trimmed = js::trim(mercado);
    if trimmed.is_empty() {
        return String::new();
    }
    let canonical = resolve_mercado_static(trimmed).unwrap_or(trimmed);
    finalize_pinnacle_market(canonical, esporte)
}

/// O mesmo mercado no 1º tempo, para a coerção não trocar o período declarado.
const FIRST_HALF_VARIANT: &[(&str, &str)] = &[
    ("Total", "1st Half Total"),
    ("Total – Match", "1st Half Total"),
    ("Total – Game", "1st Half Total"),
    ("Total Points", "1st Half Total"),
    ("Moneyline", "1st Half Moneyline"),
    ("Money Line", "1st Half Moneyline"),
    ("Money Line – Match", "1st Half Moneyline"),
    ("Money Line – Game", "1st Half Moneyline"),
    ("Asian Handicap", "1st Half Handicap"),
    ("Handicap – Match", "1st Half Handicap"),
    ("Handicap – Game", "1st Half Handicap"),
    ("Corners O/U", "Total (Corners) – 1st Half"),
    ("Asian Total Corners", "Total (Corners) – 1st Half"),
    ("Total (Corners) – Match", "Total (Corners) – 1st Half"),
    ("Asian Handicap Corners", "1st Half Asian Corners"),
    ("Handicap (Corners) – Match", "1st Half Asian Corners"),
];

/// A troca de mercado pela seleção preserva o período que o rótulo declara:
/// "Gols - 1º tempo" + "Over 0.5" é Total – 1st Half, não o jogo inteiro. Sem
/// a variante do período, fica o rótulo recebido. O 1º tempo dito só na
/// seleção ("Total de Gols" + "Over 0.5 HT") também vai para o mercado; sem a
/// variante, o período fica só na seleção, que a liquidação lê.
pub fn keep_declared_period(
    original: &str,
    coerced: &str,
    esporte: Option<&str>,
    selecao: &str,
) -> String {
    let label_period = market_period_of(original, esporte);
    let from_selection =
        label_period == MarketPeriod::Ft && market_period_of(selecao, esporte) == MarketPeriod::Ht;
    let period = if from_selection {
        MarketPeriod::Ht
    } else {
        label_period
    };
    if period == MarketPeriod::Ft || market_period_of(coerced, esporte) == period {
        return coerced.to_owned();
    }
    let finalized = (period == MarketPeriod::Ht)
        .then(|| lookup(FIRST_HALF_VARIANT, coerced))
        .flatten()
        .map(|variant| finalize_pinnacle_market(variant, esporte));
    if let Some(finalized) = finalized
        && market_period_of(&finalized, esporte) == period
    {
        return finalized;
    }
    if from_selection { coerced } else { original }.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotulo_final_por_esporte() {
        assert_eq!(
            finalize_pinnacle_market("Moneyline", Some("Tennis")),
            "Match Winner"
        );
        assert_eq!(
            finalize_pinnacle_market("Moneyline", Some("Basketball")),
            "Money Line – Game"
        );
        assert_eq!(
            finalize_pinnacle_market("Total Points", Some("Soccer")),
            "Total Points"
        );
        assert_eq!(
            finalize_pinnacle_market("constructor", Some("Soccer")),
            "constructor"
        );
        assert_eq!(
            regulation_time_market("Moneyline", "Empate", "A vs B", Some("Hockey"), false),
            "Money Line – Regulation Time"
        );
        assert_eq!(
            keep_declared_period("Gols - 1º tempo", "Total", Some("Soccer"), "Over 0.5"),
            "Total – 1st Half"
        );
    }
}
