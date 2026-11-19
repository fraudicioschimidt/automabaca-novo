//! A forma da seleção (handicap, total do time, linha, jogador de eSports,
//! handicap europeu), portada de `src/domain/mercados/selection-shape.ts`.

use super::total_direction::looks_like_total_selection;
use super::trailing_side::trailing_team_candidate_of_selection;
use crate::js;
use crate::settlement::lines::parse_line_quarters;
use crate::settlement::over_under_subject::prefixo_antes_da_linha;
use crate::settlement::sides::{match_team_side, strip_team_names};
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};

fn trailing_odds() -> &'static Regex {
    regex!(r"\s*@\s*\d+(?:[.,]\d+)?\s*$", "")
}

/// A trailing quoted price is metadata, never a handicap/total line.
pub fn strip_selection_odds(selection: &str) -> String {
    if !selection.contains('@') {
        return js::trim(selection).to_owned();
    }
    js::trim(&trailing_odds().replace(selection, "")).to_owned()
}

fn esports_stat() -> &'static Regex {
    regex!(r"\b(?:kills?|deaths?|abates?|mortes?)\b", "")
}

fn not_a_player() -> &'static Regex {
    regex!(
        r"\b(?:total|totais|kills?|deaths?|abates?|mortes?|time|team|mapa?|jogador|player)\b",
        "i"
    )
}

/// A named eSports player, distinct from either fixture team.
pub fn is_esports_player_selection(selecao: &str, evento: &str) -> bool {
    let normalized = normalize_str(selecao);
    // Toda forma da estatística passa por um destes radicais.
    if !["kill", "death", "abate", "morte"]
        .iter()
        .any(|stem| normalized.contains(stem))
        || !esports_stat().is_match(&normalized)
    {
        return false;
    }
    let Some(subject) = prefixo_antes_da_linha(selecao) else {
        return false;
    };
    subject.chars().any(|c| c.is_ascii_alphabetic())
        && match_team_side(&subject, evento).is_none()
        && !not_a_player().is_match(&subject)
}

/// O primeiro `/\d+(?:[.,]\d+)?/` do texto, com a vírgula como ponto.
fn first_number(selecao: &str) -> Option<f64> {
    let bytes = selecao.as_bytes();
    let start = bytes.iter().position(u8::is_ascii_digit)?;
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .position(|b| !b.is_ascii_digit())
            .map_or(bytes.len(), |len| from + len)
    };
    let mut end = digits(start);
    if matches!(bytes.get(end), Some(b'.' | b','))
        && bytes.get(end + 1).is_some_and(u8::is_ascii_digit)
    {
        end = digits(end + 1);
    }
    selecao[start..end]
        .replacen(',', ".", 1)
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

/// A linha de um total como a liquidação a lê: o "1" de "1T Over 110.5" é o
/// período. Quando a liquidação não lê a linha ("U3.5", "O2.5"), vale o
/// primeiro número, para a escala do esporte continuar conferida.
pub fn selection_total_line(selecao: &str, evento: &str) -> Option<f64> {
    match parse_line_quarters(&strip_team_names(selecao, evento), false) {
        Some(quarters) => Some(quarters / 4.0),
        None => first_number(selecao),
    }
}

fn handicap_line_at_end() -> &'static Regex {
    regex!(
        r"(?:^|\s)(?:[+-]\d+(?:[.,]\d+)?|\d+[.,]\d+)(?:\s*[,/]\s*[+-]?\d+(?:[.,]\d+)?)?(?:\s*(?:a\s+)?(?:cantos?|escanteios?|corners?|cart(?:[õo]es?|oes|eos)|cards?))?$",
        ""
    )
}

/// Como o texto pode terminar para a linha de handicap casar no fim.
const LINE_TAILS: [&str; 11] = [
    "canto",
    "cantos",
    "escanteio",
    "escanteios",
    "corner",
    "corners",
    "cartoe",
    "cartoes",
    "carteos",
    "card",
    "cards",
];

/// Time/lado seguido de linha; `+2.5` nu continua ambíguo.
pub fn selecao_parece_handicap(selecao: &str) -> bool {
    let selecao = strip_selection_odds(selecao);
    if looks_like_total_selection(&selecao) {
        return false;
    }
    let normalized = normalize_str(&selecao)
        .split(js::is_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    // Sem sinal, só a forma DECIMAL é inequívoca o bastante: "Flamengo 0.5" é
    // linha, enquanto inteiros podem pertencer ao nome/categoria do time. A
    // linha fecha o texto: sem um dígito ou uma estatística no fim, não casa.
    let ends_like_line = normalized.ends_with(|c: char| c.is_ascii_digit())
        || normalized.ends_with("cartões")
        || normalized.ends_with("cartõe")
        || LINE_TAILS.iter().any(|tail| normalized.ends_with(tail));
    if !ends_like_line {
        return false;
    }
    let Some(line) = handicap_line_at_end().exec(&normalized) else {
        return false;
    };
    let prefix = js::trim(&normalized[..line.start()]);
    if !prefix.chars().any(|c| c.is_ascii_lowercase()) {
        return false;
    }
    ![
        "over", "under", "ov", "un", "o", "u", "mais", "menos", "acima", "abaixo",
    ]
    .contains(&prefix)
}

/// A seleção nomeia o TIME do total ("Flamengo mais de 0.5", "Over 1.5 do
/// Flamengo"), confirmado contra o evento, nunca por parecer nome. Coagir
/// para `Total` apagaria o time e liquidaria pelo placar agregado (um 0x3
/// pagaria "Flamengo mais de 0.5"). A direção abreviada ("Flamengo O 1.5")
/// nomeia o time do mesmo jeito.
pub fn selecao_nomeia_time_do_total(selecao: &str, evento: &str) -> bool {
    // O prefixo antes da direção é o mesmo de `prefixo_antes_da_linha`.
    if prefixo_antes_da_linha(selecao)
        .is_some_and(|prefixo| match_team_side(&prefixo, evento).is_some())
    {
        return true;
    }
    trailing_team_candidate_of_selection(selecao)
        .is_some_and(|trailing| match_team_side(&trailing, evento).is_some())
}

fn european_handicap() -> &'static Regex {
    regex!(
        r"\b(?:europeu|european|europeo|europea|3\s*vias?|3\s*way|three\s*way|tres\s*vias)\b",
        ""
    )
}

/// Handicap europeu (3 vias) declarado na própria seleção: "Flamengo -1
/// (Handicap Europeu)", "Handicap 3 vias Flamengo -1". O rótulo do mercado
/// pode ter vindo genérico; a seleção é a evidência da mecânica sem push.
pub fn declares_european_handicap(selecao: &str) -> bool {
    let normalized = normalize_str(selecao);
    // Toda forma passa por "europe", "via" ou "way".
    ["europe", "via", "way"]
        .iter()
        .any(|stem| normalized.contains(stem))
        && european_handicap().is_match(&normalized)
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        trailing_odds(),
        esports_stat(),
        not_a_player(),
        handicap_line_at_end(),
        european_handicap(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forma_da_selecao() {
        let evento = "Flamengo vs Palmeiras";
        assert_eq!(
            strip_selection_odds("Flamengo -0.5 @1.90 "),
            "Flamengo -0.5"
        );
        assert!(selecao_parece_handicap("Flamengo -0.5"));
        assert!(selecao_parece_handicap("Flamengo 0.5"));
        assert!(!selecao_parece_handicap("Flamengo 2"));
        assert!(!selecao_parece_handicap("+2.5"));
        assert!(!selecao_parece_handicap("Over 2.5"));
        assert!(selecao_nomeia_time_do_total("Flamengo mais de 0.5", evento));
        assert!(selecao_nomeia_time_do_total("Over 1.5 do Flamengo", evento));
        assert!(!selecao_nomeia_time_do_total("Over 1.5", evento));
        assert_eq!(selection_total_line("Over 2.5", evento), Some(2.5));
        assert_eq!(selection_total_line("U3,5", evento), Some(3.5));
        assert!(declares_european_handicap("Flamengo -1 (Handicap Europeu)"));
        assert!(!declares_european_handicap("Flamengo -1"));
        assert!(is_esports_player_selection(
            "Faker over 5.5 kills",
            "T1 vs Gen.G"
        ));
        assert!(!is_esports_player_selection(
            "T1 over 20.5 kills",
            "T1 vs Gen.G"
        ));
    }
}
