//! Seleções, países e competições em português para o nome da Pinnacle,
//! portado de `src/domain/countries.ts`. Os tipsters brasileiros (Bet365 em
//! português) escrevem "França"; a BridgeOdds e a Pinnacle, "France". A
//! semelhança de texto entre os dois é baixa (~0,2): sem estes mapas (ou um
//! alias no banco) o filtro `home=franca` volta vazio e o pareamento não sobe.
//!
//! Só nações (uma palavra ou a forma curta). Clubes ficam no alias aprendido.
//! A ordem de cada tabela é a do objeto do TypeScript; a casca remonta as
//! seleções e os países, que o TS ainda lê.

use crate::text_normalization::normalize_str;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// Seleção nacional ou país, pela chave canônica do nome em português.
pub const NATIONAL_TEAMS_PT_EN: &[(&str, &str)] = &[
    ("alemanha", "Germany"),
    ("arabia saudita", "Saudi Arabia"),
    ("argentina", "Argentina"),
    ("australia", "Australia"),
    ("austria", "Austria"),
    ("belgica", "Belgium"),
    ("bolivia", "Bolivia"),
    ("brasil", "Brazil"),
    ("bulgaria", "Bulgaria"),
    ("camaroes", "Cameroon"),
    ("canada", "Canada"),
    ("chile", "Chile"),
    ("china", "China"),
    ("colombia", "Colombia"),
    ("coreia do norte", "North Korea"),
    ("coreia do sul", "South Korea"),
    ("costa do marfim", "Ivory Coast"),
    ("costa rica", "Costa Rica"),
    ("croacia", "Croatia"),
    ("dinamarca", "Denmark"),
    ("egito", "Egypt"),
    ("emirados arabes", "United Arab Emirates"),
    ("emirados arabes unidos", "UAE"),
    ("equador", "Ecuador"),
    ("escocia", "Scotland"),
    ("eslovaquia", "Slovakia"),
    ("eslovenia", "Slovenia"),
    ("espanha", "Spain"),
    ("estados unidos", "USA"),
    ("eua", "USA"),
    ("finlandia", "Finland"),
    ("franca", "France"),
    ("gales", "Wales"),
    ("georgia", "Georgia"),
    ("grecia", "Greece"),
    ("holanda", "Netherlands"),
    ("hungria", "Hungary"),
    ("inglesa", "England"),
    ("nova inglaterra", "New England"),
    ("inglaterra", "England"),
    ("irlanda", "Ireland"),
    ("irlanda do norte", "Northern Ireland"),
    ("islandia", "Iceland"),
    ("israel", "Israel"),
    ("italia", "Italy"),
    ("japao", "Japan"),
    ("marrocos", "Morocco"),
    ("mexico", "Mexico"),
    ("nigeria", "Nigeria"),
    ("noruega", "Norway"),
    ("nova zelandia", "New Zealand"),
    ("paises", "Netherlands"),
    ("paises baixos", "Netherlands"),
    ("panama", "Panama"),
    ("paraguai", "Paraguay"),
    ("peru", "Peru"),
    ("polonia", "Poland"),
    ("portugal", "Portugal"),
    ("catar", "Qatar"),
    ("qatar", "Qatar"),
    ("republica tcheca", "Czech Republic"),
    ("republica checa", "Czech Republic"),
    ("romania", "Romania"),
    ("russia", "Russia"),
    ("senegal", "Senegal"),
    ("servia", "Serbia"),
    ("suecia", "Sweden"),
    ("suica", "Switzerland"),
    ("turquia", "Turkey"),
    ("ucrania", "Ukraine"),
    ("uruguai", "Uruguay"),
    ("venezuela", "Venezuela"),
];

/// Competições pela chave sem acento e em caixa baixa.
pub const COMPETITION_PT_EN: &[(&str, &str)] = &[
    ("mls", "Major League Soccer"),
    ("major league soccer", "Major League Soccer"),
    ("campeonato paulista", "Paulista A1"),
    ("campeonato paulista de volei", "Paulista Women"),
    ("paulista, feminino", "Paulista Women"),
    ("paulista feminino", "Paulista Women"),
    ("paulista divisao especial a-1", "Paulista A1"),
    ("paulista divisao especial a 1", "Paulista A1"),
    ("paulista a1", "Paulista A1"),
    ("campeonato brasileiro", "Serie A"),
    ("campeonato brasileiro serie a", "Serie A"),
    ("campeonato brasileiro serie b", "Serie B"),
    ("campeonato brasileiro serie c", "Serie C"),
    ("campeonato brasileiro serie d", "Serie D"),
    ("brasileirao", "Serie A"),
    ("brasileirao serie a", "Serie A"),
    ("brasileirao serie b", "Serie B"),
    ("brasileirao serie c", "Serie C"),
    ("brasileirao serie d", "Serie D"),
    ("campeonato gaucho 2", "Gaucho 2"),
    ("gaucho 2", "Gaucho 2"),
    ("campeonato goiano - divisao de acesso", "Goiano 2"),
    ("campeonato goiano divisao de acesso", "Goiano 2"),
    ("goiano 2", "Goiano 2"),
    ("campeonato europeu feminino", "EuroVolley Women"),
    ("copa do brasil", "Copa do Brasil"),
    ("copa sul-americana", "Copa Sudamericana"),
    ("copa sul americana", "Copa Sudamericana"),
    ("copa libertadores", "Copa Libertadores"),
    ("copa america", "Copa America"),
    (
        "jogos amigaveis internacionais 2026",
        "International Friendly Games",
    ),
    ("amistosos internacionais", "International Friendly Games"),
    ("friendly international", "Friendly International"),
    ("international friendlies", "International Friendly Games"),
    ("besta deild karla", "Premier League"),
    // Nome de patrocinador da primeira divisão portuguesa (FlashScore).
    ("liga portugal betclic", "Primeira Liga"),
    ("liga portugal", "Primeira Liga"),
];

/// País (em português ou inglês, sigla ou nome) para o nome da Pinnacle.
pub const CANONICAL_COUNTRY_MAP: &[(&str, &str)] = &[
    ("usa", "USA"),
    ("united states", "USA"),
    ("united states of america", "USA"),
    ("us", "USA"),
    ("eua", "USA"),
    ("estados unidos", "USA"),
    ("england", "England"),
    ("inglaterra", "England"),
    ("inglesa", "England"),
    ("uk", "England"),
    ("united kingdom", "England"),
    ("reino unido", "England"),
    ("gb", "England"),
    ("great britain", "England"),
    ("gra bretanha", "England"),
    ("gra-bretanha", "England"),
    ("brazil", "Brazil"),
    ("brasil", "Brazil"),
    ("br", "Brazil"),
    ("bra", "Brazil"),
    ("uae", "UAE"),
    ("united arab emirates", "UAE"),
    ("emirados arabes", "UAE"),
    ("emirados arabes unidos", "UAE"),
    ("south korea", "South Korea"),
    ("korea republic", "South Korea"),
    ("republic of korea", "South Korea"),
    ("coreia do sul", "South Korea"),
    ("kr", "South Korea"),
    ("kor", "South Korea"),
    ("north korea", "North Korea"),
    ("coreia do norte", "North Korea"),
    ("czech republic", "Czech Republic"),
    ("czechia", "Czech Republic"),
    ("republica tcheca", "Czech Republic"),
    ("republica checa", "Czech Republic"),
    ("cz", "Czech Republic"),
    ("netherlands", "Netherlands"),
    ("holland", "Netherlands"),
    ("holanda", "Netherlands"),
    ("paises baixos", "Netherlands"),
    ("paises", "Netherlands"),
    ("nl", "Netherlands"),
    ("turkey", "Turkey"),
    ("turkiye", "Turkey"),
    ("turquia", "Turkey"),
    ("tr", "Turkey"),
    ("ireland", "Ireland"),
    ("irlanda", "Ireland"),
    ("northern ireland", "Northern Ireland"),
    ("irlanda do norte", "Northern Ireland"),
    ("scotland", "Scotland"),
    ("escocia", "Scotland"),
    ("wales", "Wales"),
    ("gales", "Wales"),
    ("germany", "Germany"),
    ("alemanha", "Germany"),
    ("spain", "Spain"),
    ("espanha", "Spain"),
    ("italy", "Italy"),
    ("italia", "Italy"),
    ("france", "France"),
    ("franca", "France"),
    ("portugal", "Portugal"),
    ("argentina", "Argentina"),
    ("world", "World"),
    ("mundo", "World"),
    ("international", "International"),
    ("internacional", "International"),
    ("not specified", "Not specified"),
    ("nao especificado", "Not specified"),
    ("europe", "Europe"),
    ("europa", "Europe"),
    ("south america", "South America"),
    ("america do sul", "South America"),
];

/// Os nomes de país que o prefixo "País - Competição" aceita, sem acento e
/// em caixa baixa, na ordem do `Set` do TypeScript.
pub static KNOWN_COUNTRY_KEYS: LazyLock<Vec<String>> = LazyLock::new(|| {
    let keys = NATIONAL_TEAMS_PT_EN
        .iter()
        .map(|(key, _)| (*key).to_owned())
        .chain(
            NATIONAL_TEAMS_PT_EN
                .iter()
                .map(|(_, country)| normalize_str(country)),
        )
        .chain(
            CANONICAL_COUNTRY_MAP
                .iter()
                .map(|(key, _)| (*key).to_owned()),
        )
        .chain(
            CANONICAL_COUNTRY_MAP
                .iter()
                .map(|(_, country)| normalize_str(country)),
        )
        .chain(
            ["world", "international", "europe", "south america", "usa"]
                .into_iter()
                .map(str::to_owned),
        );
    let mut seen = HashSet::new();
    keys.filter(|key| seen.insert(key.clone())).collect()
});

static KNOWN_COUNTRY_SET: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| KNOWN_COUNTRY_KEYS.iter().map(String::as_str).collect());

pub fn is_known_country_key(key: &str) -> bool {
    KNOWN_COUNTRY_SET.contains(key)
}

fn index(table: &'static [(&'static str, &'static str)]) -> HashMap<&'static str, &'static str> {
    table.iter().copied().collect()
}

static NATIONAL_TEAMS: LazyLock<HashMap<&str, &str>> =
    LazyLock::new(|| index(NATIONAL_TEAMS_PT_EN));
static COMPETITIONS: LazyLock<HashMap<&str, &str>> = LazyLock::new(|| index(COMPETITION_PT_EN));
static COUNTRIES: LazyLock<HashMap<&str, &str>> = LazyLock::new(|| index(CANONICAL_COUNTRY_MAP));

/// A seleção em inglês pela chave (o nome canônico do time).
pub fn national_team(key: &str) -> Option<&'static str> {
    NATIONAL_TEAMS.get(key).copied()
}

/// A competição em inglês pela chave (o nome sem acento e em caixa baixa).
pub fn competition(key: &str) -> Option<&'static str> {
    COMPETITIONS.get(key).copied()
}

/// O país canônico pela chave (o nome canônico).
pub fn country(key: &str) -> Option<&'static str> {
    COUNTRIES.get(key).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tabelas() {
        assert_eq!(national_team("franca"), Some("France"));
        assert_eq!(competition("liga portugal betclic"), Some("Primeira Liga"));
        assert_eq!(country("gra-bretanha"), Some("England"));
        // Chave do protótipo de um objeto do JS não é entrada da tabela.
        assert_eq!(competition("constructor"), None);
        assert!(is_known_country_key("brazil") && is_known_country_key("south america"));
        assert_eq!(KNOWN_COUNTRY_KEYS.len(), 148);
        for table in [
            NATIONAL_TEAMS_PT_EN,
            COMPETITION_PT_EN,
            CANONICAL_COUNTRY_MAP,
        ] {
            assert_eq!(index(table).len(), table.len(), "chave repetida");
        }
    }
}
