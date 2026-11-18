//! Compatibilidade esporte × rótulo FINAL da Pinnacle, portada de
//! `src/domain/mercados/compatibility.ts`. A matriz responde uma pergunta de
//! produto ("este rótulo da Pinnacle pertence a este esporte?"), não a
//! capacidade de um provider. Rótulo ou dupla ausente falha fechado.

use super::catalog::normalize_mercado_key;
use super::classify::declares_regulation_time;
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};
use std::collections::HashMap;
use std::sync::LazyLock;

/// Esporte normalizado usado só pela taxonomia de mercados.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MarketSport {
    Soccer,
    Basketball,
    Tennis,
    Esports,
    Baseball,
    Hockey,
    AmericanFootball,
    Volleyball,
    Handball,
    Rugby,
    Futsal,
    TableTennis,
    BeachVolleyball,
    Other,
}

impl MarketSport {
    pub fn as_str(self) -> &'static str {
        match self {
            MarketSport::Soccer => "soccer",
            MarketSport::Basketball => "basketball",
            MarketSport::Tennis => "tennis",
            MarketSport::Esports => "esports",
            MarketSport::Baseball => "baseball",
            MarketSport::Hockey => "hockey",
            MarketSport::AmericanFootball => "american_football",
            MarketSport::Volleyball => "volleyball",
            MarketSport::Handball => "handball",
            MarketSport::Rugby => "rugby",
            MarketSport::Futsal => "futsal",
            MarketSport::TableTennis => "table_tennis",
            MarketSport::BeachVolleyball => "beach_volleyball",
            MarketSport::Other => "other",
        }
    }
}

/// O nome do esporte nesta taxonomia, na ordem em que o TS testava: os nomes
/// compostos ("futebol americano", "vôlei de praia", "tênis de mesa") antes
/// dos simples que eles contêm.
fn sport_names() -> [(&'static Regex, MarketSport); 13] {
    [
        (
            regex!(r"\b(?:american football|futebol americano|nfl)\b", ""),
            MarketSport::AmericanFootball,
        ),
        (
            regex!(r"\b(?:beach volleyball|volei de praia)\b", ""),
            MarketSport::BeachVolleyball,
        ),
        (
            regex!(r"\b(?:table tennis|tenis de mesa|ping pong)\b", ""),
            MarketSport::TableTennis,
        ),
        (
            regex!(r"\b(?:soccer|futebol|association football|futbol)\b", ""),
            MarketSport::Soccer,
        ),
        (
            regex!(r"\b(?:basketball|basquete|basquetebol|baloncesto)\b", ""),
            MarketSport::Basketball,
        ),
        (regex!(r"\b(?:tennis|tenis)\b", ""), MarketSport::Tennis),
        (regex!(r"\be ?sports?\b", ""), MarketSport::Esports),
        (
            regex!(r"\b(?:baseball|beisebol)\b", ""),
            MarketSport::Baseball,
        ),
        (regex!(r"\b(?:hockey|hoquei)\b", ""), MarketSport::Hockey),
        (
            regex!(r"\b(?:volleyball|volei|voleibol)\b", ""),
            MarketSport::Volleyball,
        ),
        (
            regex!(r"\b(?:handball|handebol)\b", ""),
            MarketSport::Handball,
        ),
        (regex!(r"\b(?:rugby|rugbi)\b", ""), MarketSport::Rugby),
        (regex!(r"\bfutsal\b", ""), MarketSport::Futsal),
    ]
}

fn separators() -> &'static Regex {
    regex!(r"[_-]+", "g")
}

pub fn market_sport_of(esporte: Option<&str>) -> MarketSport {
    let Some(esporte) = esporte.filter(|esporte| !esporte.is_empty()) else {
        return MarketSport::Other;
    };
    let value = separators().replace(&normalize_str(esporte), " ");
    sport_names()
        .into_iter()
        .find(|(name, _)| name.is_match(&value))
        .map_or(MarketSport::Other, |(_, sport)| sport)
}

use MarketSport::{
    AmericanFootball, Baseball, Basketball, BeachVolleyball, Esports, Futsal, Handball, Hockey,
    Rugby, Soccer, TableTennis, Tennis, Volleyball,
};

/// A fonte executável da compatibilidade esporte × rótulo FINAL. Formas
/// externas e intermediárias podem ser convertidas pelo `finalize`, mas nunca
/// viram mercado oficial só por existirem no catálogo de outro esporte.
pub const FINAL_MARKET_SPORTS: &[(&str, &[MarketSport])] = &[
    ("Anytime Goalscorer", &[Soccer]),
    ("Both Teams to Score", &[Soccer]),
    ("Correct Score", &[Soccer]),
    ("Double Chance", &[Soccer]),
    ("First Goalscorer", &[Soccer]),
    ("Handicap – 1st Half", &[Soccer, Basketball]),
    ("Handicap – Game", &[Basketball, Baseball]),
    ("Handicap – Match", &[Soccer, Esports, Handball, Futsal]),
    ("Handicap (Bookings) – Match", &[Soccer]),
    ("Handicap (Corners) – 1st Half", &[Soccer]),
    ("Handicap (Corners) – Match", &[Soccer]),
    ("Handicap (Games) – Match", &[Tennis]),
    (
        "Handicap (Sets) – Match",
        &[Tennis, Volleyball, TableTennis, BeachVolleyball],
    ),
    ("Last Goalscorer", &[Soccer]),
    ("Match Winner", &[Tennis]),
    ("Money Line", &[Hockey, AmericanFootball]),
    ("Money Line – 1st Half", &[Soccer, Basketball]),
    ("Money Line – Game", &[Basketball, Baseball]),
    (
        "Money Line – Match",
        &[Soccer, Esports, Volleyball, Handball, Futsal],
    ),
    ("Point Spread", &[AmericanFootball]),
    ("Puck Line", &[Hockey]),
    ("Team Total – Match", &[Soccer]),
    ("Team Total (Games) – Match", &[Tennis]),
    ("Total – 1st Half", &[Soccer]),
    ("Total – Game", &[Baseball]),
    (
        "Total – Match",
        &[Soccer, Hockey, Esports, Handball, Futsal],
    ),
    ("Total (Bookings) – Match", &[Soccer]),
    ("Total (Corners) – 1st Half", &[Soccer]),
    ("Total (Corners) – Match", &[Soccer]),
    ("Total (Games) – Match", &[Tennis]),
    (
        "Total (Sets) – Match",
        &[Tennis, Volleyball, TableTennis, BeachVolleyball],
    ),
    ("Total (Kills) – Map 1", &[Esports]),
    ("Total (Kills) – Map 2", &[Esports]),
    ("Total (Kills) – Map 3", &[Esports]),
    ("Total (Kills) – Map 4", &[Esports]),
    ("Total (Kills) – Map 5", &[Esports]),
    ("To Score 2+ Goals", &[Soccer]),
    ("To Score 3+ Goals", &[Soccer]),
    (
        "Total Points",
        &[Basketball, AmericanFootball, Rugby, Volleyball],
    ),
    ("1st Half Total Points", &[Basketball]),
];

/// Mercados do TEMPO REGULAMENTAR nos esportes cujo mercado padrão inclui a
/// prorrogação. "1X2", "Tempo Regular" e "(TR)" apostam no placar sem a
/// prorrogação; gravados como os do jogo, liquidariam pelo placar com ela e o
/// CLV seria comparado com outro mercado. Ficam fora do catálogo da Config.
pub const REGULATION_TIME_MONEYLINE: &str = "Money Line – Regulation Time";
pub const REGULATION_TIME_SPREAD: &str = "Handicap – Regulation Time";
pub const REGULATION_TIME_TOTAL: &str = "Total – Regulation Time";

pub const REGULATION_TIME_SPORTS: &[MarketSport] = &[Basketball, Hockey];

/// O texto pede o tempo regulamentar como regra à parte: só onde o mercado
/// padrão inclui a prorrogação, ou com o esporte ainda desconhecido.
pub fn restricts_to_regulation_time(text: &str, esporte: Option<&str>) -> bool {
    let sport = market_sport_of(esporte);
    (sport == MarketSport::Other || REGULATION_TIME_SPORTS.contains(&sport))
        && declares_regulation_time(text)
}

/// O intermediário do mesmo mercado no jogo inteiro: a base para renormalizar.
static REGULATION_TIME_BASE: LazyLock<HashMap<String, &'static str>> = LazyLock::new(|| {
    [
        (REGULATION_TIME_MONEYLINE, "Moneyline"),
        (REGULATION_TIME_SPREAD, "Asian Handicap"),
        (REGULATION_TIME_TOTAL, "Total"),
    ]
    .into_iter()
    .map(|(market, base)| (normalize_mercado_key(market), base))
    .collect()
});

/// Intermediário de jogo inteiro de um mercado do tempo regulamentar.
pub fn regulation_time_base_of(mercado: &str) -> Option<&'static str> {
    REGULATION_TIME_BASE
        .get(&normalize_mercado_key(mercado))
        .copied()
}

pub fn is_regulation_time_market(mercado: &str) -> bool {
    regulation_time_base_of(mercado).is_some()
}

static COMPATIBILITY_BY_KEY: LazyLock<HashMap<String, &'static [MarketSport]>> =
    LazyLock::new(|| {
        FINAL_MARKET_SPORTS
            .iter()
            .map(|(market, sports)| (*market, *sports))
            .chain(
                [
                    REGULATION_TIME_MONEYLINE,
                    REGULATION_TIME_SPREAD,
                    REGULATION_TIME_TOTAL,
                ]
                .map(|market| (market, REGULATION_TIME_SPORTS)),
            )
            .map(|(market, sports)| (normalize_mercado_key(market), sports))
            .collect()
    });

pub fn is_mercado_final_for_sport(mercado: &str, esporte: Option<&str>) -> bool {
    COMPATIBILITY_BY_KEY
        .get(&normalize_mercado_key(mercado))
        .is_some_and(|sports| sports.contains(&market_sport_of(esporte)))
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all: Vec<&'static Regex> = sport_names().into_iter().map(|(name, _)| name).collect();
    all.push(separators());
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn esporte_e_compatibilidade() {
        assert_eq!(
            market_sport_of(Some("Futebol Americano")),
            MarketSport::AmericanFootball
        );
        assert_eq!(
            market_sport_of(Some("table_tennis")),
            MarketSport::TableTennis
        );
        assert_eq!(market_sport_of(None), MarketSport::Other);
        assert!(is_mercado_final_for_sport(
            "Total Points",
            Some("Basketball")
        ));
        assert!(!is_mercado_final_for_sport("Total Points", Some("Soccer")));
        assert!(is_mercado_final_for_sport(
            "Total – Regulation Time",
            Some("Hockey")
        ));
        assert_eq!(
            regulation_time_base_of("Handicap – Regulation Time"),
            Some("Asian Handicap")
        );
        assert_eq!(regulation_time_base_of("constructor"), None);
    }
}
