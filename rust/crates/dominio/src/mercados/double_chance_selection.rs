//! A seleção de Dupla Chance canônica (1X, X2, 12), resolvida enquanto o
//! evento ainda tem o nome da mensagem, portada de
//! `src/domain/mercados/double-chance-selection.ts`. O token compacto
//! atravessa aliases sem perder o lado nem a cobertura do empate.

use super::classify::{
    MarketKind, MarketPeriod, market_includes_extra_time, market_kind_of, market_period_of,
};
use super::compatibility::restricts_to_regulation_time;
use super::draw_vocabulary::strip_double_chance_from_selection;
use super::stat_qualifier::{has_non_score_stat_qualifier, has_score_unit_mismatch};
use crate::settlement::sides::{Outcome, Side, match_double_chance_selection, match_team_side};
use crate::text::split_evento_teams;
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};

/// Linha de handicap na seleção ("Time +1", "Time -0.5").
fn handicap_line() -> &'static Regex {
    regex!(r"\+\s*\d|(?:^|\s)[−–-]\s*\d", "")
}

fn side_pair() -> &'static Regex {
    regex!(r"^[12x]\s*\+\s*[12x]$", "")
}

fn side_only() -> &'static Regex {
    regex!(r"^(?:1|2|home|away|casa|fora|mandante|visitante)$", "")
}

fn letters_or_digits() -> &'static Regex {
    regex!(r"[\p{L}\p{N}]+", "gu")
}

fn tokens(text: &str) -> Vec<String> {
    let normalized = normalize_str(text);
    letters_or_digits()
        .exec_all(&normalized)
        .iter()
        .filter_map(|found| found.get(0).map(str::to_owned))
        .collect()
}

/// `{ mercado, selecao }` canônicos, ou `None` quando a seleção não é de
/// Dupla Chance. A ambiguidade fica visível: sem lado claro, volta a seleção
/// recebida, com o marcador que explica a tip.
pub fn canonical_double_chance_selection(
    evento: &str,
    mercado: &str,
    selecao: &str,
    esporte: &str,
) -> Option<(String, String)> {
    // O token compacto não carrega a regra de prorrogação ou do regulamentar.
    if [mercado, selecao].iter().any(|text| {
        market_includes_extra_time(text) || restricts_to_regulation_time(text, Some(esporte))
    }) {
        return None;
    }
    let teams = split_evento_teams(evento);
    let kind = market_kind_of(mercado, "", None);
    let names_a_team = |text: &str| {
        teams
            .as_ref()
            .is_some_and(|(home, away)| [home, away].iter().any(|team| normalize_str(team) == text))
    };
    // "DC United" e "Washington DC" podem ser nomes inteiros, não rótulos.
    let (is_dc, selection) = if names_a_team(&normalize_str(selecao)) {
        (false, selecao.to_owned())
    } else {
        match strip_double_chance_from_selection(selecao) {
            Some(clean) => (true, clean),
            None => (false, selecao.to_owned()),
        }
    };
    let declared = kind == MarketKind::DoubleChance;
    if !declared
        && (!is_dc
            || !matches!(kind, MarketKind::Moneyline | MarketKind::Other)
            || market_period_of(mercado, None) != MarketPeriod::Ft
            || has_non_score_stat_qualifier(mercado, selecao)
            || has_score_unit_mismatch(mercado, selecao, Some(esporte)))
    {
        return None;
    }
    // Não apagar um período declarado apenas na seleção.
    if market_period_of(selecao, None) != MarketPeriod::Ft {
        return None;
    }
    let mercado = if declared { mercado } else { "Double Chance" }.to_owned();
    let unchanged = || Some((mercado.clone(), selecao.to_owned()));
    let compact = normalize_str(&selection);
    if handicap_line().is_match(&selection)
        && !names_a_team(&compact)
        && !side_pair().is_match(&compact)
    {
        return unchanged();
    }
    if let Some(covered) = match_double_chance_selection(&selection, evento) {
        let has = |outcome| covered.0 == outcome || covered.1 == outcome;
        let canonical = if !has(Outcome::Draw) {
            "12"
        } else if has(Outcome::Home) {
            "1X"
        } else {
            "X2"
        };
        return Some((mercado, canonical.to_owned()));
    }
    let side = match compact.as_str() {
        "1" => Some(Side::Home),
        "2" => Some(Side::Away),
        _ => match_team_side(&selection, evento),
    };
    if let (Some(side), Some((home, away))) = (side, &teams) {
        let (team, other) = match side {
            Side::Home => (home, away),
            Side::Away => (away, home),
        };
        let selected = tokens(&selection);
        let team_tokens = tokens(team);
        let other_tokens = tokens(other);
        // `match_team_side` aceita o nome dentro de uma frase. Aqui só o nome,
        // a abreviação ou um lado explícito autorizam acrescentar o empate.
        let names_only = !selected.is_empty()
            && selected.iter().all(|token| team_tokens.contains(token))
            && !selected.iter().all(|token| other_tokens.contains(token));
        let side_only = side_only().is_match(&compact);
        let has_line = handicap_line().is_match(&selection) && compact != normalize_str(team);
        if !has_line && (names_only || side_only) {
            let canonical = match side {
                Side::Home => "1X",
                Side::Away => "X2",
            };
            return Some((mercado, canonical.to_owned()));
        }
    }
    unchanged()
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        handicap_line(),
        side_pair(),
        side_only(),
        letters_or_digits(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dupla_chance_canonica() {
        let evento = "Flamengo vs Palmeiras";
        let dc = |mercado, selecao| {
            canonical_double_chance_selection(evento, mercado, selecao, "Soccer")
        };
        assert_eq!(
            dc("Dupla Chance", "Flamengo ou Empate"),
            Some(("Dupla Chance".to_owned(), "1X".to_owned()))
        );
        assert_eq!(
            dc("Moneyline", "Palmeiras DC"),
            Some(("Double Chance".to_owned(), "X2".to_owned()))
        );
        assert_eq!(dc("Moneyline", "Flamengo"), None);
        assert_eq!(
            dc("Dupla Chance", "Flamengo +1"),
            Some(("Dupla Chance".to_owned(), "Flamengo +1".to_owned()))
        );
    }
}
