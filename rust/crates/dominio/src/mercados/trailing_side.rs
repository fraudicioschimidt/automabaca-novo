//! Nome de time posicionado DEPOIS da linha ("Over 1.5 Gols do Flamengo"),
//! portado de `src/domain/mercados/trailing-side.ts`. A canonicalização da
//! seleção e a liquidação precisam do mesmo recorte: se só um reconhece o
//! lado, o outro liquida pelo placar agregado.

use crate::text_normalization::{collapse_whitespace, normalize_str};
use js_regex::{Regex, regex};

/// Unidades e preposições que separam a linha do nome do time. Vocabulário
/// RESTRITO de propósito: o que sobra ainda precisa casar com o evento.
fn trailing_unit_noise() -> &'static Regex {
    regex!(
        r"\b(?:de|do|da|dos|das|gols?|goals?|pontos?|points?|runs?|corridas?|cantos?|escanteios?|corners?|cartoes?|carteos?|cards?|bookings?|abates?|kills?|rebotes?|rebounds?|chutes?|shots?|finalizacoes?|assistencias?|assists?|faltas?|defesas?|saves?|torres?|towers?|bloqueios?|blocks?|aces?|tentativas?|attempts?|acertos?|hits?)\b",
        "gi"
    )
}

fn punctuation() -> &'static Regex {
    regex!(r"[()[\]:;,–—-]", "g")
}

fn nameable() -> &'static Regex {
    regex!(r"[a-zà-ÿ]", "i")
}

fn first_line() -> &'static Regex {
    regex!(r"\d+(?:[.,]\d+)?", "")
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        trailing_unit_noise(),
        punctuation(),
        nameable(),
        first_line(),
    ]
}

/// Limpa unidade, preposição e pontuação; `None` quando não sobra nada nomeável.
pub fn trailing_team_candidate(trailing: &str) -> Option<String> {
    // Normaliza ANTES de limpar: a lista de unidades é sem acento.
    let without_punctuation = punctuation().replace(&normalize_str(trailing), " ");
    let candidate = collapse_whitespace(&trailing_unit_noise().replace(&without_punctuation, " "));
    (!candidate.is_empty() && nameable().is_match(&candidate)).then_some(candidate)
}

/// Trecho da seleção que vem DEPOIS da primeira linha numérica, já limpo.
pub fn trailing_team_candidate_of_selection(selecao: &str) -> Option<String> {
    let normalized = normalize_str(selecao);
    let line = first_line().exec(&normalized)?;
    trailing_team_candidate(&normalized[line.end()..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_depois_da_linha() {
        assert_eq!(
            trailing_team_candidate_of_selection("Over 1.5 Gols do Flamengo").as_deref(),
            Some("flamengo")
        );
        assert_eq!(
            trailing_team_candidate_of_selection("Over 9.5 escanteios"),
            None
        );
        assert_eq!(trailing_team_candidate_of_selection("Flamengo"), None);
    }
}
