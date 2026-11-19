//! O SUJEITO da linha over/under (antes ou depois dela) que não é time do
//! evento, portado de `src/domain/settlement/over-under-subject.ts`. Liquidar
//! "Tatum over 10.5" ou "Over 0.5 - Mbappé" pelo placar da partida
//! responderia outra aposta.

use crate::bookmaker::is_known_bookmaker_key;
use crate::countries::KNOWN_COUNTRY_KEYS;
use crate::mercados::match_scope::MATCH_SCOPE_NOUNS;
use crate::mercados::stat_qualifier::{
    NON_SCORE_STAT_TERMS, has_non_score_stat_qualifier, is_both_teams_cards_text,
    score_qualifier_terms,
};
use crate::mercados::total_direction::expand_abbreviated_direction;
use crate::national_teams::canonical_country;
use crate::settlement::goalscorer_matching::tokens_da_selecao;
use crate::settlement::sides::match_team_side;
use crate::text::split_evento_teams;
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

const DIRECTIONS: [&str; 6] = ["over", "under", "mais", "menos", "acima", "abaixo"];

/// `\b(?:over|under|mais|menos|acima|abaixo)\b`.
fn direction() -> &'static Regex {
    regex!(r"\b(?:over|under|mais|menos|acima|abaixo)\b", "")
}

/// `normalizeStr(text).replace(/[^a-z0-9]+/g, " ").trim()`: só `[a-z0-9]` e
/// espaços simples.
fn words_of(text: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in normalize_str(text).chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out
}

/// Texto à esquerda de over/under na seleção. Sem isso, "Tatum over 10.5" e
/// "Over 10.5" parecem a mesma linha: só o prefixo diz se há um sujeito. A
/// direção abreviada ("Pedro O 0.5") tem o mesmo sujeito.
///
/// No texto só de palavras, `^(.+?)\s+\b(?:direção)\b` é o que vem antes da
/// primeira palavra de direção que não abre o texto.
pub fn prefixo_antes_da_linha(selecao: &str) -> Option<String> {
    let words = words_of(&expand_abbreviated_direction(selecao));
    let tokens: Vec<&str> = words.split(' ').collect();
    let at = (1..tokens.len()).find(|&i| DIRECTIONS.contains(&tokens[i]))?;
    let prefixo = tokens[..at].join(" ");
    prefixo
        .chars()
        .any(|c| c.is_ascii_lowercase())
        .then_some(prefixo)
}

/// A seleção que abre pela direção e pela linha ("Over 0.5", "Mais de
/// 2.0,2.5", "U 3.5").
fn leading_line() -> &'static Regex {
    regex!(
        r"^\W*(?:(?:over|under|mais|menos|acima|abaixo)\s*(?:(?:de|que)\s+)?|(?:ov|un|o|u)\.?\s*(?=\d))\+?\s*\d+(?:[.,]\d+)?(?:\s*[,/]\s*\+?\s*\d+(?:[.,]\d+)?)?",
        ""
    )
}

/// A estatística depois da linha, pelo vocabulário único de `stat_qualifier`,
/// na ordem dele: sai pela frase inteira ("chutes no gol", "double faults"),
/// que palavra a palavra não se reconhece.
static STAT_TERMS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::cataloged(&format!(r"\b(?:{NON_SCORE_STAT_TERMS})\b"), "g")
        .unwrap_or_else(|error| panic!("STAT_TERMS: {error}"))
});

/// A competição escrita depois da linha: diz onde se joga, nunca quem faz a
/// estatística.
const COMPETITION_WORDS: [&str; 20] = [
    "brasileirao",
    "serie",
    "liga",
    "league",
    "premier",
    "copa",
    "cup",
    "nba",
    "nfl",
    "nhl",
    "mlb",
    "libertadores",
    "sulamericana",
    "champions",
    "europa",
    "conference",
    "bundesliga",
    "laliga",
    "ligue",
    "eredivisie",
];

/// Chaves da lista de países que também são time ou região de time ("New
/// England" dos Patriots, "Georgia" do college, "Internacional"): continuam
/// sujeito, e a aposta vai para o dono em vez do total da partida.
const NOT_ONLY_A_COUNTRY: [&str; 5] = [
    "new england",
    "nova inglaterra",
    "georgia",
    "internacional",
    "international",
];

/// O país colado à competição ("Copa do Brasil", "Liga de Portugal", "Italy
/// Serie A", "World Cup") também é o lugar. O nome mais longo vem antes, para
/// "Irlanda do Norte" não deixar o "norte" como sujeito; o com hífen fica de
/// fora do padrão, e a grafia com espaço o cobre.
static COMPETITION_COUNTRY: LazyLock<Regex> = LazyLock::new(|| {
    let mut countries: Vec<&str> = KNOWN_COUNTRY_KEYS
        .iter()
        .map(String::as_str)
        .filter(|key| {
            !key.is_empty()
                && key.chars().all(|c| c.is_ascii_lowercase() || c == ' ')
                && !NOT_ONLY_A_COUNTRY.contains(key)
        })
        .collect();
    // O `sort` do JS é estável, como o do Rust.
    countries.sort_by_key(|key| std::cmp::Reverse(key.encode_utf16().count()));
    let countries = countries.join("|");
    let competition = COMPETITION_WORDS.join("|");
    Regex::cataloged(
        &format!(
            r"\b({competition})\s+(?:(?:de|do|da|of|the)\s+)?({countries})\b|\b({countries})\s+(?=(?:{competition})\b)"
        ),
        "g",
    )
    .unwrap_or_else(|error| panic!("COMPETITION_COUNTRY: {error}"))
});

/// Todas as grafias de cada país, pelo nome em inglês: "brasil", "brazil" e
/// "bra" são o mesmo.
static COUNTRY_SPELLINGS: LazyLock<HashMap<String, Vec<&'static str>>> = LazyLock::new(|| {
    let mut spellings: HashMap<String, Vec<&'static str>> = HashMap::new();
    for key in KNOWN_COUNTRY_KEYS.iter() {
        spellings
            .entry(canonical_country(key))
            .or_default()
            .push(key.as_str());
    }
    spellings
});

/// No jogo de seleções o país é o time, e o evento pode estar noutra língua
/// ("Over 1.5 Brasil Copa do Mundo" em "Brazil vs Argentina"): tirá-lo
/// liquidaria o total do Brasil pelo total da partida.
fn country_names_event_side(country: &str, evento: &str) -> bool {
    let event_words = format!(" {} ", words_of(evento));
    let names_side = |spelling: &str| event_words.contains(&format!(" {spelling} "));
    match COUNTRY_SPELLINGS.get(&canonical_country(country)) {
        Some(spellings) => spellings.iter().any(|spelling| names_side(spelling)),
        None => names_side(country),
    }
}

/// Tira da seleção o país que só diz onde se joga; o que é um lado do evento
/// fica. Todo casamento passa por uma palavra de competição: sem nenhuma no
/// texto, nada muda e a regex nem roda.
fn without_competition_country(rest: &str, evento: &str) -> String {
    if !COMPETITION_WORDS.iter().any(|word| rest.contains(word)) {
        return rest.to_owned();
    }
    COMPETITION_COUNTRY.replace_with(rest, |found| {
        let whole = found.get(0).unwrap_or("");
        let country = found.get(2).or(found.get(3)).unwrap_or("");
        if country_names_event_side(country, evento) {
            return whole.to_owned();
        }
        match found.get(1) {
            Some(competition) => format!("{competition} "),
            None => " ".to_owned(),
        }
    })
}

/// O resto que também não nomeia quem faz a estatística: a unidade do
/// placar, o complemento da estatística ("chutes certos", "roubos de bola"),
/// o período e o escopo do jogo ("tempo normal", "jogo todo", "ambos os
/// times"), a odd e a stake.
static NOT_A_SUBJECT: LazyLock<HashSet<String>> = LazyLock::new(|| {
    let words: &[&str] = &["goles", "golos", "pts", "game", "round", "rounds"];
    let more: &[&str] = &[
        "jogos",
        "total",
        "totais",
        "geral",
        "full",
        "time",
        "ft",
        "ht",
        "tempo",
        "tempos",
        "regulamentar",
        "regular",
        "normal",
        "todo",
        "toda",
        "inteiro",
        "inteira",
        "completo",
        "completa",
        "integral",
        "cheio",
        "cheia",
        "pre",
        "principal",
        "alternativa",
        "alternativo",
        "ambos",
        "ambas",
        "times",
        "equipes",
        "both",
        "teams",
        "somados",
        "combinados",
        "combined",
        "incluindo",
        "including",
        "sem",
        "prorrogacao",
        "overtime",
        "ot",
        "extra",
        "prolongamento",
        "primeiro",
        "primeira",
        "segundo",
        "segunda",
        "first",
        "second",
        "half",
        "metade",
        "etapa",
        "periodo",
        "period",
        "quarto",
        "quarter",
        "pt",
        "st",
        "min",
        "minutos",
        "minutes",
        "certo",
        "certos",
        "certas",
        "enquadrado",
        "enquadrados",
        "enquadrada",
        "enquadradas",
        "bola",
        "alvo",
        "target",
        "baliza",
        "convertidos",
        "convertidas",
        "made",
        "odd",
        "odds",
        "stake",
        "un",
        "unidade",
        "unidades",
        "units",
        "linha",
        "line",
        "mercado",
        "market",
        "asiatico",
        "asiatica",
        "asiaticos",
        "asiaticas",
        "asian",
        "ah",
        "gls",
        "vivo",
        "live",
        "play",
        "as",
        "os",
        "ao",
        "aos",
        "no",
        "na",
        "nos",
        "nas",
        "em",
        "de",
        "do",
        "da",
        "dos",
        "das",
        "el",
        "la",
        "los",
        "las",
        "del",
        "en",
        "para",
        "pro",
        "por",
        "com",
        "the",
        "in",
        "of",
        "for",
        "on",
        "at",
        "to",
        "and",
        "ou",
        "or",
        // Quando e onde, que o tipster escreve depois da linha e nunca são o
        // jogador.
        "hoje",
        "hj",
        "amanha",
        "agora",
    ];
    score_qualifier_terms()
        .into_iter()
        .chain(words.iter().map(|word| (*word).to_owned()))
        .chain(MATCH_SCOPE_NOUNS.iter().map(|word| (*word).to_owned()))
        .chain(more.iter().map(|word| (*word).to_owned()))
        .chain(COMPETITION_WORDS.iter().map(|word| (*word).to_owned()))
        .collect()
});

/// Quem vem DEPOIS da linha e não é time do evento: o jogador de "Over 0.5 -
/// Mbappé" ou de "Menos de 27.5 [A'ja Wilson]". Reduzida a "Over 0.5", a prop
/// seria liquidada pelo total da partida. Sem evento (`None` ou vazio),
/// `None`: o sujeito não se prova alheio.
pub fn subject_after_line(selecao: &str, evento: Option<&str>) -> Option<String> {
    let evento = evento.filter(|evento| !evento.is_empty())?;
    let n = normalize_str(&expand_abbreviated_direction(selecao));
    // Toda forma da linha tem um dígito.
    if !n.bytes().any(|b| b.is_ascii_digit()) {
        return None;
    }
    let line = leading_line().exec(&n)?;
    let rest = &n[line.end()..];
    // Outra direção adiante: o começo era a categoria do time ("U23 Sporting
    // Over 1.5").
    if direction().is_match(rest) {
        return None;
    }
    let without_country = without_competition_country(rest, evento);
    let without_stats = if without_country.trim().is_empty() {
        without_country
    } else {
        STAT_TERMS.replace(&without_country, " ")
    };
    let subject = without_stats
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|token| {
            token.len() > 1
                && !token.bytes().any(|b| b.is_ascii_digit())
                && !NOT_A_SUBJECT.contains(*token)
                && !is_known_bookmaker_key(token)
        })
        .collect::<Vec<_>>()
        .join(" ");
    if subject.is_empty()
        || match_team_side(&subject, evento).is_some()
        || prefixo_menciona_time_do_evento(&subject, evento)
    {
        return None;
    }
    Some(subject)
}

/// "Jogo O 2.5", "FT Over 2.5": o escopo na frente da linha é o próprio jogo,
/// não um sujeito.
fn is_match_scope_prefix(prefixo: &str) -> bool {
    MATCH_SCOPE_NOUNS.contains(&prefixo) || ["game", "ft", "full time"].contains(&prefixo)
}

/// Sujeito da linha O/U (antes ou depois dela) que não é time: liquidar pela
/// estatística ou pelo placar da partida responderia outra aposta. Sem
/// evento o sujeito não se prova alheio e a guarda não dispara.
pub fn line_subject_is_not_event_team(selecao: &str, evento: Option<&str>) -> bool {
    if subject_after_line(selecao, evento).is_some() {
        return true;
    }
    let Some(prefixo) = prefixo_antes_da_linha(selecao) else {
        return false;
    };
    if is_match_scope_prefix(&prefixo)
        || is_both_teams_cards_text(selecao)
        || has_non_score_stat_qualifier(&prefixo, "")
        || tokens_da_selecao(&prefixo).is_empty()
    {
        return false;
    }
    let Some(evento) = evento.filter(|evento| !evento.is_empty()) else {
        return false;
    };
    // Prefixo que cita um lado do evento não é atleta: ambíguo fica no
    // time-total.
    match_team_side(&prefixo, evento).is_none()
        && !prefixo_menciona_time_do_evento(&prefixo, evento)
}

fn prefixo_menciona_time_do_evento(prefixo: &str, evento: &str) -> bool {
    let Some((home, away)) = split_evento_teams(evento) else {
        return false;
    };
    let p = format!(" {} ", normalize_str(prefixo));
    [home, away].iter().any(|time| {
        let n = normalize_str(time);
        !n.is_empty() && p.contains(&format!(" {n} "))
    })
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        direction(),
        leading_line(),
        &*STAT_TERMS,
        &*COMPETITION_COUNTRY,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sujeito_da_linha() {
        let evento = "Flamengo vs Palmeiras";
        assert_eq!(
            prefixo_antes_da_linha("Tatum over 10.5").as_deref(),
            Some("tatum")
        );
        assert_eq!(prefixo_antes_da_linha("Over 10.5"), None);
        assert_eq!(
            prefixo_antes_da_linha("Pedro O 0.5").as_deref(),
            Some("pedro")
        );
        assert_eq!(
            subject_after_line("Over 0.5 - Mbappé", Some(evento)).as_deref(),
            Some("mbappe")
        );
        assert_eq!(subject_after_line("Over 0.5 - Mbappé", None), None);
        assert_eq!(
            subject_after_line("Over 9.5 escanteios", Some(evento)),
            None
        );
        assert_eq!(
            subject_after_line("Over 1.5 Copa do Brasil", Some(evento)),
            None
        );
        assert_eq!(subject_after_line("Over 2.5 Flamengo", Some(evento)), None);
        assert!(line_subject_is_not_event_team(
            "Tatum over 10.5",
            Some(evento)
        ));
        assert!(!line_subject_is_not_event_team(
            "Flamengo over 1.5",
            Some(evento)
        ));
        assert!(!line_subject_is_not_event_team(
            "Jogo over 2.5",
            Some(evento)
        ));
        assert!(!line_subject_is_not_event_team("Tatum over 10.5", None));
    }
}
