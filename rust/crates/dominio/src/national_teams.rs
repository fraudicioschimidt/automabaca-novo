//! Tradução de seleções, países e competições para o nome da Pinnacle, e a
//! troca do nome do time na seleção depois que a identidade casa, portado de
//! `src/domain/national-teams.ts`.
//!
//! O TypeScript montava regex com o nome do país ou do time de cada aposta.
//! Aqui é código: o catálogo de regex comparado com o V8 cresceria sem limite.
//! As duas regras de caixa daqueles regex são diferentes e ficam separadas: o
//! prefixo do país era `/i` sem `u` (a `Canonicalize` pelo `toUpperCase`, por
//! unidade UTF-16) e o nome do time, `/iu` (a dobra simples do Unicode).

use crate::countries::{self, NATIONAL_TEAMS_PT_EN};
use crate::js;
use crate::text_normalization::{canonicalize_team_name, normalize_str};
use js_regex::{Regex, regex};
use std::sync::LazyLock;

/// A seleção nacional ou o país em inglês da Pinnacle; `None` se não for uma
/// nação conhecida.
pub fn translate_national_team_pt_to_en(local_name: &str) -> Option<&'static str> {
    let key = canonicalize_team_name(local_name);
    if key.is_empty() {
        return None;
    }
    countries::national_team(&key)
}

/// O país no padrão da Pinnacle ("Brasil" vira "Brazil", "UK" vira
/// "England"); o desconhecido sai com cada palavra em maiúscula.
pub fn canonical_country(raw: &str) -> String {
    let trimmed = js::trim(raw);
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(country) = countries::country(&canonicalize_team_name(trimmed)) {
        return country.to_owned();
    }
    if let Some(nation) = translate_national_team_pt_to_en(trimmed) {
        return nation.to_owned();
    }
    trimmed
        .split(js::is_whitespace)
        .filter(|word| !word.is_empty())
        .map(title_word)
        .collect::<Vec<_>>()
        .join(" ")
}

/// `w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()`. O `charAt(0)` de
/// um caractere fora do BMP é meia unidade, que o `toUpperCase` não muda.
fn title_word(word: &str) -> String {
    let Some(first) = word.chars().next() else {
        return String::new();
    };
    let rest = js_text::to_lower_case(&word[first.len_utf8()..]);
    if first.len_utf16() == 2 {
        format!("{first}{rest}")
    } else {
        js_text::to_upper_case(first.encode_utf8(&mut [0; 4])) + &rest
    }
}

/// A competição no padrão da Pinnacle, sem o país repetido.
pub fn canonical_competition(raw: &str, pais: Option<&str>) -> String {
    let mut trimmed = js::trim(raw).to_owned();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(known) = countries::competition(&normalize_str(&trimmed)) {
        return known.to_owned();
    }

    // O formato bruto do FlashScore, "PAÍS: Competição [- Fase]".
    if let Some(found) = flashscore_league().exec(&trimmed) {
        let tournament =
            js::trim(&phase_suffix().replace(found.get(2).unwrap_or(""), "")).to_owned();
        if let Some(known) = countries::competition(&normalize_str(&tournament)) {
            return known.to_owned();
        }
        trimmed = tournament;
    }

    match pais.filter(|pais| !pais.is_empty()) {
        // O prefixo "País - " quando o país já está no campo país.
        Some(pais) => {
            if let Some(rest) = strip_country_prefix(&trimmed, &canonical_country(pais)) {
                trimmed = js::trim(rest).to_owned();
            }
        }
        // Sem o campo país, só o prefixo que é um país conhecido.
        None => {
            if let Some(dash) = trimmed.find(" - ").filter(|dash| *dash > 0) {
                let possible_country = js::trim(&trimmed[..dash]);
                if countries::is_known_country_key(&normalize_str(possible_country)) {
                    trimmed = js::trim(&trimmed[dash + 3..]).to_owned();
                }
            }
        }
    }

    match countries::competition(&normalize_str(&trimmed)) {
        Some(known) => known.to_owned(),
        None => trimmed,
    }
}

/// `text.replace(new RegExp(`^${escapeRegExp(country)}\\s*-\\s*`, "i"), "")`:
/// o resto, quando o texto começa pelo país (sem caixa, pela regra do `/i` sem
/// `u`) seguido do traço.
fn strip_country_prefix<'t>(text: &'t str, country: &str) -> Option<&'t str> {
    let mut rest = text.chars();
    for expected in country.chars() {
        let found = rest.next()?;
        if canonicalize_without_unicode(found) != canonicalize_without_unicode(expected) {
            return None;
        }
    }
    let rest = rest.as_str().trim_start_matches(js::is_whitespace);
    rest.strip_prefix('-')
        .map(|rest| rest.trim_start_matches(js::is_whitespace))
}

/// A `Canonicalize` do `RegExp` sem `u`: o `toUpperCase` da unidade UTF-16,
/// se der uma unidade só e não levar um não-ASCII para ASCII. Fora do BMP
/// são duas metades, cada uma igual só a si mesma.
fn canonicalize_without_unicode(character: char) -> char {
    if character.is_ascii() {
        return character.to_ascii_uppercase();
    }
    if character.len_utf16() == 2 {
        return character;
    }
    let upper = js_text::to_upper_case(character.encode_utf8(&mut [0; 4]));
    let mut chars = upper.chars();
    match (chars.next(), chars.next()) {
        (Some(single), None) if single.len_utf16() == 1 && !single.is_ascii() => single,
        _ => character,
    }
}

struct NationEntry {
    pt_key: &'static str,
    en: &'static str,
    en_canon: String,
    words: usize,
}

/// As nações da maior chave para a menor (o `sort` estável do TS, pelo
/// tamanho UTF-16; as chaves são ASCII): "irlanda do norte" antes de
/// "irlanda".
static NATIONS_BY_LENGTH: LazyLock<Vec<NationEntry>> = LazyLock::new(|| {
    let longest = NATIONAL_TEAMS_PT_EN
        .iter()
        .map(|(key, _)| key.len())
        .max()
        .unwrap_or(0);
    (1..=longest)
        .rev()
        .flat_map(|length| {
            NATIONAL_TEAMS_PT_EN
                .iter()
                .filter(move |(key, _)| key.len() == length)
        })
        .map(|(pt_key, en)| NationEntry {
            pt_key,
            en,
            en_canon: canonicalize_team_name(en),
            words: pt_key.split(' ').count(),
        })
        .collect()
});

/// Uma janela de N palavras (letras e apóstrofo) entre não letras, na posição
/// N - 1, até o maior número de palavras das chaves.
static WORD_WINDOWS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let most = NATIONS_BY_LENGTH
        .iter()
        .map(|entry| entry.words)
        .max()
        .unwrap_or(0);
    (1..=most)
        .map(|words| {
            let window = vec![r"[\p{L}']+"; words].join(r"\s+");
            let source = format!(r"(?<!\p{{L}}){window}(?!\p{{L}})");
            Regex::cataloged(&source, "giu")
                .unwrap_or_else(|error| panic!("regex inválida /{source}/: {error}"))
        })
        .collect()
});

fn flashscore_league() -> &'static Regex {
    regex!(r"^([\p{L}\p{M}\s]+):\s*(.+)$", "u")
}

fn phase_suffix() -> &'static Regex {
    regex!(
        r"\s*-\s*(?:Losers stage|Apertura|Clausura|Preliminary|Play Offs|5th-8th places|\d+(?:st|nd|rd|th)[^)]*)$",
        "i"
    )
}

/// `[\p{L}\p{N}]` com `iu`, o limite de palavra das trocas de nome.
fn letter_or_number_class() -> &'static Regex {
    regex!(r"[\p{L}\p{N}]", "iu")
}

/// O que, depois do nome, mostra que ele é o time da seleção: a linha, o
/// mercado ou "ou empate".
fn safe_suffix_start() -> &'static Regex {
    regex!(
        r"^(?:[+\-−–—]?\d|over\b|under\b|mais\b|menos\b|acima\b|abaixo\b|to win\b|para vencer\b|moneyline\b|ml\b|dnb\b|(?:or|ou)\s+(?:draw|empate)\b)",
        "iu"
    )
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all = vec![
        flashscore_league(),
        phase_suffix(),
        letter_or_number_class(),
        safe_suffix_start(),
    ];
    all.extend(WORD_WINDOWS.iter());
    all
}

/// Troca o nome da nação em português pelo da Pinnacle dentro de um texto (a
/// seleção). Com os times do jogo, só a nação que é um deles: "Franca", clube
/// de basquete, não vira France, nem "Brasil de Pelotas" vira Brazil. Uma
/// passada por nação, sobre o texto já trocado pelas anteriores.
pub fn rewrite_national_teams_in_text(text: &str, event_teams: Option<&[&str]>) -> String {
    let teams: Option<Vec<String>> = event_teams.map(|teams| {
        teams
            .iter()
            .map(|team| canonicalize_team_name(team))
            .collect()
    });
    let mut out = text.to_owned();
    for entry in NATIONS_BY_LENGTH.iter() {
        if teams
            .as_ref()
            .is_some_and(|teams| !teams.contains(&entry.en_canon))
        {
            continue;
        }
        out = WORD_WINDOWS[entry.words - 1].replace_with(&out, |found| {
            let window = found.get(0).unwrap_or("");
            if canonicalize_team_name(window) == entry.pt_key {
                entry.en.to_owned()
            } else {
                window.to_owned()
            }
        });
    }
    out
}

fn letter_or_number(character: char) -> bool {
    letter_or_number_class().is_match(character.encode_utf8(&mut [0; 4]))
}

/// Quando a identidade casa, o evento vira "France vs Morocco", mas a seleção
/// ainda pode estar "França -1.0". Sem reescrever, o lado do time não casa
/// (semelhança de ~0,2) e a odd cai em `ambiguous_selection`.
pub fn rewrite_selecao_with_matched_teams(
    selecao: &str,
    local_home: &str,
    local_away: &str,
    pinnacle_home: &str,
    pinnacle_away: &str,
) -> String {
    let mut pairs: Vec<(&str, &str)> = [(local_home, pinnacle_home), (local_away, pinnacle_away)]
        .into_iter()
        .filter(|(local, pinnacle)| {
            !local.is_empty()
                && !pinnacle.is_empty()
                && canonicalize_team_name(local) != canonicalize_team_name(pinnacle)
        })
        .collect();
    // O `sort` estável do TS pelo tamanho UTF-16, da maior para a menor.
    if pairs.len() == 2 && pairs[1].0.encode_utf16().count() > pairs[0].0.encode_utf16().count() {
        pairs.swap(0, 1);
    }

    let mut out = selecao.to_owned();
    for (local, pinnacle) in pairs {
        // A dupla chance "12" é "Casa or Fora": o nome seguido do outro time
        // do jogo, com o nome local ou o já trocado, também é o time.
        let other_team: Vec<Vec<char>> = if local == local_home {
            [local_away, pinnacle_away]
        } else {
            [local_home, pinnacle_home]
        }
        .into_iter()
        .filter(|name| !name.is_empty())
        .map(js_text::simple_case_fold)
        .collect();
        out = replace_team_name(&out, local, pinnacle, &other_team);
    }
    rewrite_national_teams_in_text(&out, Some(&[pinnacle_home, pinnacle_away]))
}

/// `source.replace(/(?<![\p{L}\p{N}])<local>(?![\p{L}\p{N}])/giu, …)`: o nome
/// do time inteiro, sem caixa, vira o da Pinnacle quando o que vem depois é a
/// linha, o mercado ou o outro time.
fn replace_team_name(
    source: &str,
    local: &str,
    pinnacle: &str,
    other_team: &[Vec<char>],
) -> String {
    let chars: Vec<char> = source.chars().collect();
    let folded = js_text::simple_case_fold(source);
    let needle = js_text::simple_case_fold(local);
    let mut out = String::with_capacity(source.len());
    let mut copied = 0;
    let mut index = 0;
    while index + needle.len() <= chars.len() {
        let end = index + needle.len();
        let found = folded[index..end] == needle[..]
            && !(index > 0 && letter_or_number(chars[index - 1]))
            && !(end < chars.len() && letter_or_number(chars[end]));
        if !found {
            index += 1;
            continue;
        }
        let suffix: String = chars[end..].iter().collect();
        let suffix = suffix.trim_start_matches(js::is_whitespace);
        out.extend(&chars[copied..index]);
        if safe_suffix(suffix, other_team) {
            out.push_str(pinnacle);
        } else {
            out.extend(&chars[index..end]);
        }
        copied = end;
        index = end;
    }
    out.extend(&chars[copied..]);
    out
}

fn safe_suffix(suffix: &str, other_team: &[Vec<char>]) -> bool {
    suffix.is_empty()
        || safe_suffix_start().is_match(suffix)
        || followed_by_other_team(suffix, other_team)
}

/// `^(?:or|ou)\s+(?:<outro>|<outro>)(?![\p{L}\p{N}])` com `iu`. O `\s+` cede
/// espaço ao nome que comece por espaço, como o retrocesso do regex.
fn followed_by_other_team(suffix: &str, other_team: &[Vec<char>]) -> bool {
    if other_team.is_empty() {
        return false;
    }
    let chars: Vec<char> = suffix.chars().collect();
    let folded = js_text::simple_case_fold(suffix);
    if !(folded.len() > 2 && folded[0] == 'o' && matches!(folded[1], 'r' | 'u')) {
        return false;
    }
    let spaces = chars[2..]
        .iter()
        .take_while(|c| js::is_whitespace(**c))
        .count();
    (3..=2 + spaces).any(|start| {
        other_team.iter().any(|name| {
            let end = start + name.len();
            end <= chars.len()
                && folded[start..end] == name[..]
                && !(end < chars.len() && letter_or_number(chars[end]))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traduz() {
        assert_eq!(translate_national_team_pt_to_en("França"), Some("France"));
        assert_eq!(translate_national_team_pt_to_en(""), None);
        assert_eq!(canonical_country(" Coreia do Sul "), "South Korea");
        assert_eq!(canonical_country("ilhas  faroé"), "Ilhas Faroé");
        assert_eq!(canonical_country("constructor"), "Constructor");
        assert_eq!(
            canonical_competition("BÉLGICA: Challenger Pro League", None),
            "Challenger Pro League"
        );
        assert_eq!(
            canonical_competition("USA - Major League Soccer", Some("USA")),
            "Major League Soccer"
        );
        assert_eq!(
            canonical_competition("Korea (Rep.) - K League 1", Some("Korea (Rep.)")),
            "K League 1"
        );
        assert_eq!(canonical_competition("Brazil - Serie A", None), "Serie A");
        assert_eq!(
            canonical_competition("Elite - Championship", None),
            "Elite - Championship"
        );
    }

    #[test]
    fn troca_na_selecao() {
        assert_eq!(
            rewrite_national_teams_in_text("Coreia do Sul -1", None),
            "South Korea -1"
        );
        assert_eq!(
            rewrite_national_teams_in_text("Estados Unidos Costa Rica", None),
            "USA Costa Rica"
        );
        assert_eq!(
            rewrite_selecao_with_matched_teams(
                "França -1.0",
                "França",
                "Marrocos",
                "France",
                "Morocco"
            ),
            "France -1.0"
        );
        assert_eq!(
            rewrite_selecao_with_matched_teams(
                "FRANÇA ou Marrocos",
                "França",
                "Marrocos",
                "France",
                "Morocco"
            ),
            "France ou Morocco"
        );
        assert_eq!(
            rewrite_selecao_with_matched_teams(
                "Franca Basquete",
                "Franca",
                "Minas",
                "Franca SP",
                "Minas TC"
            ),
            "Franca Basquete"
        );
    }

    #[test]
    fn janelas_de_palavras() {
        assert_eq!(
            WORD_WINDOWS.len(),
            3,
            "chave nova com outro número de palavras entra no catálogo"
        );
    }
}
