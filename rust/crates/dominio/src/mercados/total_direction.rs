//! Direção de um total (over/under) na seleção, portado de
//! `src/domain/mercados/total-direction.ts`, sem confundir nomes como
//! "Sporting U23". Os padrões são os do TypeScript, montados pelas mesmas
//! peças.

use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TotalDirection {
    Over,
    Under,
}

macro_rules! line {
    () => {
        r"\d+(?:[.,]\d+)?"
    };
}
macro_rules! over_words {
    () => {
        "over|mais|acima|above"
    };
}
macro_rules! under_words {
    () => {
        "under|menos|abaixo|below"
    };
}
macro_rules! total_unit {
    () => {
        concat!(
            r"(?:gols?|goals?|cantos?|corners?|escanteios?|cartoes?|carteos?|cards?|bookings?|",
            r"pontos?|points?|games?|jogos?|sets?|kills?|abates?|chutes?|shots?|",
            r"faltas?|fouls?|rebotes?|rebounds?|aces?|bases?|roubos?|steals?|",
            r"torres?|towers?|impedimentos?|offsides?)"
        )
    };
}
macro_rules! total_period {
    () => {
        concat!(
            r"\(?\s*(?:[12](?:o|º)?|primeiro|segundo)?\s*",
            r"(?:tempo|half|periodo|period|mapa|map|set)\b[^)]*\)?"
        )
    };
}
/// "O 2.5" / "U.1,5 cards" sozinhos, ou com o time na frente ("Wolves
/// O.1,5 cards"). Sem unidade nem decimal, "Sporting U23" continua time.
macro_rules! abbreviated_total {
    ($token:literal) => {
        concat!(
            r"(?:^\s*(?:",
            $token,
            r")\s*\.?\s*",
            line!(),
            r"(?:\s+(?:",
            total_unit!(),
            "|",
            total_period!(),
            r"))?\s*$)",
            r"|(?:^\s*[\p{L}\p{N}.'-]+(?:\s+[\p{L}\p{N}.'-]+)*\s+(?:",
            $token,
            r")\s*\.?\s*(?:\d+[.,]\d+(?:\s+(?:",
            total_unit!(),
            "|",
            total_period!(),
            r"))?|",
            line!(),
            r"\s+(?:",
            total_unit!(),
            "|",
            total_period!(),
            r"))\s*$)"
        )
    };
}

/// Separa apenas uma linha numérica de uma unidade conhecida; U23 e nomes ficam.
fn compact_stat_unit() -> &'static Regex {
    regex!(
        r"(\d)(?=(?:cantos?|corners?|escanteios?|gols?|goals?|cards?|cart[oõ]es|bookings?|pontos?|points?|games?|sets?|shots?|remates?)\b)",
        "gi"
    )
}

fn over_word() -> &'static Regex {
    regex!(
        concat!(
            r"\b(?:",
            over_words!(),
            r")\b(?:\s+(?:de|que))?\s*\+?\s*",
            line!(),
            r"\b"
        ),
        ""
    )
}
fn under_word() -> &'static Regex {
    regex!(
        concat!(
            r"\b(?:",
            under_words!(),
            r")\b(?:\s+(?:de|que))?\s*[+\-]?\s*",
            line!(),
            r"\b"
        ),
        ""
    )
}
fn over_word_only() -> &'static Regex {
    regex!(concat!("^(?:", over_words!(), ")$"), "")
}
fn under_word_only() -> &'static Regex {
    regex!(concat!("^(?:", under_words!(), ")$"), "")
}
fn over_abbreviated() -> &'static Regex {
    regex!(abbreviated_total!("o|ov"), "u")
}
fn under_abbreviated() -> &'static Regex {
    regex!(abbreviated_total!("u|un"), "u")
}
/// A UNIDADE não decide direção — o `+` e a linha decidem; uma palavra depois
/// da linha evita confundir com nome de time.
fn positive_total_with_unit() -> &'static Regex {
    regex!(concat!(r"^\s*\+\s*", line!(), r"\s*[a-z][a-z ]*$"), "")
}
fn bare_positive_line() -> &'static Regex {
    regex!(concat!(r"^\s*\+\s*", line!(), r"\s*$"), "")
}
/// Rótulo que nomeia AS DUAS direções ("Over/Under"): é nome de mercado.
fn composite_both_directions() -> &'static Regex {
    regex!(
        concat!(
            r"\b(?:",
            over_words!(),
            r")\b\s*[/|-]\s*\b(?:",
            under_words!(),
            r")\b",
            r"|\b(?:",
            under_words!(),
            r")\b\s*[/|-]\s*\b(?:",
            over_words!(),
            r")\b"
        ),
        "g"
    )
}
fn last_over_token() -> &'static Regex {
    regex!(r"(^|\s)(?:ov|o)\s*\.?\s*(?=\d)", "gi")
}
fn last_under_token() -> &'static Regex {
    regex!(r"(^|\s)(?:un|u)\s*\.?\s*(?=\d)", "gi")
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        compact_stat_unit(),
        over_word(),
        under_word(),
        over_word_only(),
        under_word_only(),
        over_abbreviated(),
        under_abbreviated(),
        positive_total_with_unit(),
        bare_positive_line(),
        composite_both_directions(),
        last_over_token(),
        last_under_token(),
    ]
}

/// As palavras de direção, como alternância de regex (texto normalizado).
pub const OVER_WORDS: &str = over_words!();
pub const UNDER_WORDS: &str = under_words!();

/// "10corners" → "10 corners".
pub fn separate_compact_stat_unit(text: &str) -> String {
    compact_stat_unit().replace(text, "$1 ")
}

/// O texto em que se procura a direção: o rótulo COMPOSTO ("Over/Under") sai
/// antes, porque nomeia o mercado, não o lado.
fn direction_text(selection: &str) -> String {
    composite_both_directions().replace(&normalize_str(&separate_compact_stat_unit(selection)), " ")
}

/// "Flamengo O 1.5" → "Flamengo Over 1.5": só a sigla da direção logo antes da
/// linha do fim do texto vira palavra (a primeira pode ser a categoria do time,
/// "Palmeiras U20 U 1.5").
pub fn expand_abbreviated_direction(selection: &str) -> String {
    let normalized = direction_text(selection);
    let over = over_abbreviated().is_match(&normalized);
    if over == under_abbreviated().is_match(&normalized) {
        return selection.to_owned();
    }
    let (token, word) = if over {
        (last_over_token(), "Over")
    } else {
        (last_under_token(), "Under")
    };
    let Some(last) = token.exec_all(selection).into_iter().last() else {
        return selection.to_owned();
    };
    let start = last.start() + last.get(1).map_or(0, str::len);
    format!("{}{word} {}", &selection[..start], &selection[last.end()..])
}

/// Direção explícita de uma seleção de total. `allow_bare_positive_line` só
/// quando o mercado já foi classificado como total.
pub fn total_direction_of(
    selection: &str,
    allow_bare_positive_line: bool,
) -> Option<TotalDirection> {
    let normalized = direction_text(selection);
    let over = over_word().is_match(&normalized)
        || over_word_only().is_match(&normalized)
        || over_abbreviated().is_match(&normalized)
        || positive_total_with_unit().is_match(&normalized)
        || (allow_bare_positive_line && bare_positive_line().is_match(&normalized));
    let under = under_word().is_match(&normalized)
        || under_word_only().is_match(&normalized)
        || under_abbreviated().is_match(&normalized);
    match (over, under) {
        (true, false) => Some(TotalDirection::Over),
        (false, true) => Some(TotalDirection::Under),
        _ => None,
    }
}

pub fn looks_like_total_selection(selection: &str) -> bool {
    total_direction_of(selection, false).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direcoes() {
        assert_eq!(
            total_direction_of("Over 2.5", false),
            Some(TotalDirection::Over)
        );
        assert_eq!(
            total_direction_of("Mais de 2,5 gols", false),
            Some(TotalDirection::Over)
        );
        assert_eq!(
            total_direction_of("Under 1.5", false),
            Some(TotalDirection::Under)
        );
        assert_eq!(total_direction_of("Over/Under 2.5", false), None);
        assert_eq!(total_direction_of("Sporting U23", false), None);
        assert_eq!(
            total_direction_of("Wolves O.1,5 cards", false),
            Some(TotalDirection::Over)
        );
        assert_eq!(total_direction_of("+2.5", false), None);
        assert_eq!(total_direction_of("+2.5", true), Some(TotalDirection::Over));
        assert_eq!(
            expand_abbreviated_direction("Palmeiras U20 U 1.5"),
            "Palmeiras U20 Under 1.5"
        );
        assert_eq!(separate_compact_stat_unit("10corners"), "10 corners");
    }
}
