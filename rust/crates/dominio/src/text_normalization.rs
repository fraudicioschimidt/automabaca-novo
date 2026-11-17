//! Normalização de texto para MATCHING (nunca para exibição) e o vocabulário
//! de nomes de time, portado de `src/domain/text-normalization.ts`. É o caminho
//! quente do pareamento (milhares de nomes por rodada): Rust direto, sem motor
//! de regex. Depois da limpeza o nome só tem `[a-z0-9]` e espaços simples, e
//! os padrões do TypeScript com `\b` e lookahead viram regras sobre os tokens
//! (o `\b` ali é a borda do token). As listas são as do TypeScript, na mesma
//! ordem.

use crate::js;
use std::collections::HashMap;
use std::sync::LazyLock;

/// `(s || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim()`.
pub fn normalize_str(text: &str) -> String {
    js::trim(&js_text::fold_for_matching(text)).to_owned()
}

pub const TEAM_STOP_WORDS: &[&str] = &[
    "el", "la", "los", "las", "le", "les", "de", "do", "da", "dos", "das", "fc", "cf", "sc", "ac",
    "as", "sd", "ud", "cd", "rc", "rcd", "cr", "se", "ec", "ca", "ad", "fk", "sk", "bk", "if",
    "ik", "gk", "sf", "afc", "bfc", "cfc", "vfc", "ks", "mks", "gks", "lks", "zks", "ksp", "tsv",
    "fsv", "vfb", "vfl", "spvgg", "real", "club", "clube", "team", "equipe", "sporting",
    "atletico",
];

/// Expansões token-inteiro → forma canônica. Curado e conservador; o gate de
/// similaridade é a rede extra.
const TOKEN_SYNONYMS: &[(&str, &str)] = &[
    ("utd", "united"),
    ("st", "saint"),
    ("ste", "sainte"),
    ("dep", "deportivo"),
    ("depor", "deportivo"),
    ("atl", "atletico"),
    ("atm", "atletico"),
    ("ath", "athletic"),
    ("intl", "international"),
    ("cd", "deportivo"),
    ("univ", "universidad"),
    ("spfc", "sao paulo"),
    ("women", "women"),
    ("woman", "women"),
    ("fem", "women"),
    ("feminino", "women"),
    ("feminina", "women"),
    ("fminino", "women"),
    ("femenino", "women"),
    ("femenina", "women"),
    ("ladies", "women"),
    ("lady", "women"),
    ("girls", "women"),
    ("femminile", "women"),
    ("femminili", "women"),
    ("femenil", "women"),
    ("damen", "women"),
    ("dames", "women"),
    ("feminines", "women"),
    ("feminine", "women"),
];

/// Tokens que distinguem times DIFERENTES (feminino ≠ masculino, sub-20 ≠
/// profissional, B ≠ principal): nunca removidos nem expandidos.
const PROTECTED_TOKENS: &[&str] = &[
    "women", "woman", "fem", "feminino", "feminina", "fminino", "femenino", "femenina", "w", "u15",
    "u16", "u17", "u18", "u19", "u20", "u21", "u23", "sub15", "sub17", "sub19", "sub20", "sub21",
    "sub23", "b", "ii", "iii", "reserve", "reserves", "reserva", "reservas", "youth", "academy",
    "akatemia", "akademia", "amateur", "amateure", "jong",
];

/// Reservas / II / Youth / U21–U23: a mesma "classe" em feeds diferentes.
pub const RESERVE_CLASS_TOKENS: &[&str] = &[
    "ii", "iii", "reserve", "reserves", "reserva", "reservas", "youth", "academy", "akatemia",
    "akademia", "amateur", "amateure", "u21", "u23", "sub21", "sub23", "jong",
];
pub const RESERVE_CLASS_MARKER: &str = "reserve_class";

/// `u` ou `sub` seguido de dois dígitos ASCII, e nada mais.
fn age_category(token: &str) -> bool {
    let digits = token
        .strip_prefix("sub")
        .or_else(|| token.strip_prefix('u'));
    digits.is_some_and(|digits| digits.len() == 2 && js::all_digits(digits))
}

pub fn is_protected_token(token: &str) -> bool {
    PROTECTED_TOKENS.contains(&token) || age_category(token)
}

fn starts_with_digit(token: Option<&String>) -> bool {
    token.is_some_and(|token| token.starts_with(|c: char| c.is_ascii_digit()))
}

/// `20` ou `20s`: os dois dígitos.
fn age_digits(text: &str) -> Option<&str> {
    let digits = text.strip_suffix('s').unwrap_or(text);
    (digits.len() == 2 && js::all_digits(digits)).then_some(digits)
}

const AGE_PREFIXES: [&str; 3] = ["sub", "under", "u"];

/// `replace(/\b(sub|under|u)\s*(\d{2})s?\b(?!\s*\d)/g, "u$2")`: "sub 20",
/// "Under 21s" e "u23" viram `u20`, `u21`, `u23`, se o número seguinte não for
/// outro número ("u 20 5" fica).
fn spell_age_categories(tokens: Vec<String>) -> Vec<String> {
    let mut out = Vec::with_capacity(tokens.len());
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i].as_str();
        let joined = AGE_PREFIXES
            .iter()
            .find_map(|prefix| token.strip_prefix(prefix).and_then(age_digits));
        if let Some(digits) = joined.filter(|_| !starts_with_digit(tokens.get(i + 1))) {
            out.push(format!("u{digits}"));
            i += 1;
            continue;
        }
        let split = AGE_PREFIXES
            .contains(&token)
            .then(|| tokens.get(i + 1).and_then(|next| age_digits(next)))
            .flatten();
        if let Some(digits) = split.filter(|_| !starts_with_digit(tokens.get(i + 2))) {
            out.push(format!("u{digits}"));
            i += 2;
            continue;
        }
        out.push(tokens[i].clone());
        i += 1;
    }
    out
}

/// Um padrão de `RESERVE_TEAM_NAMES` do TypeScript: as formas, na ordem em
/// que o regex as tenta; o token que, logo depois, impede a troca (o
/// lookahead); e a troca. `None` na troca é o `$& u23` (o trecho + `u23`).
struct ReserveName {
    forms: &'static [&'static [&'static str]],
    only_at_start: bool,
    unless_next: &'static str,
    replacement: Option<&'static [&'static str]>,
}

/// Times reserva cujo nome não usa o vocabulário da categoria: ganham o token
/// que a categoria já entende, e a palavra própria fica. Só a primeira
/// ocorrência de cada um, como o `replace` sem `g`.
const RESERVE_TEAM_NAMES: [ReserveName; 6] = [
    // /\bcastilla\b(?! b\b)/ → "castilla b"
    ReserveName {
        forms: &[&["castilla"]],
        only_at_start: false,
        unless_next: "b",
        replacement: Some(&["castilla", "b"]),
    },
    // /\bcelta (?:vigo )?fortuna\b(?! b\b)/ → "celta vigo fortuna b"
    ReserveName {
        forms: &[&["celta", "vigo", "fortuna"], &["celta", "fortuna"]],
        only_at_start: false,
        unless_next: "b",
        replacement: Some(&["celta", "vigo", "fortuna", "b"]),
    },
    // /^bilbao athletic\b(?! b\b)/ → "bilbao athletic b"
    ReserveName {
        forms: &[&["bilbao", "athletic"]],
        only_at_start: true,
        unless_next: "b",
        replacement: Some(&["bilbao", "athletic", "b"]),
    },
    // O reserva do Club Brugge na Challenger Pro League ("Club Brugge II").
    // /\bclub nxt\b(?! ii\b)/ → "club nxt ii"
    ReserveName {
        forms: &[&["club", "nxt"]],
        only_at_start: false,
        unless_next: "ii",
        replacement: Some(&["club", "nxt", "ii"]),
    },
    // /\bnext ?gen(?:eration)?\b(?! u23\b)/ → "$& u23"
    ReserveName {
        forms: &[
            &["next", "generation"],
            &["next", "gen"],
            &["nextgeneration"],
            &["nextgen"],
        ],
        only_at_start: false,
        unless_next: "u23",
        replacement: None,
    },
    // /\b(?:ac )?milan futuro\b(?! u23\b)/ → "ac milan futuro u23"
    ReserveName {
        forms: &[&["ac", "milan", "futuro"], &["milan", "futuro"]],
        only_at_start: false,
        unless_next: "u23",
        replacement: Some(&["ac", "milan", "futuro", "u23"]),
    },
];

impl ReserveName {
    fn apply(&self, tokens: &mut Vec<String>) {
        let starts = if self.only_at_start {
            0..1
        } else {
            0..tokens.len()
        };
        for start in starts {
            for form in self.forms {
                let end = start + form.len();
                let matches = tokens
                    .get(start..end)
                    .is_some_and(|window| window.iter().zip(form.iter()).all(|(a, b)| a == b));
                if !matches || tokens.get(end).is_some_and(|next| next == self.unless_next) {
                    continue;
                }
                let replacement: Vec<String> = match self.replacement {
                    Some(words) => words.iter().map(|word| (*word).to_owned()).collect(),
                    None => form
                        .iter()
                        .map(|word| (*word).to_owned())
                        .chain(["u23".to_owned()])
                        .collect(),
                };
                tokens.splice(start..end, replacement);
                return;
            }
        }
    }
}

/// Troca cada sequência de caracteres em `separator` por um espaço.
fn replace_runs(text: &str, separator: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for character in text.chars() {
        if separator(character) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(character);
            in_run = false;
        }
    }
    out
}

/// `replace(/\s+/g, " ").trim()`.
fn collapse_whitespace(text: &str) -> String {
    js::trim(&replace_runs(text, js::is_whitespace)).to_owned()
}

/// Nome de time para matching: acentos fora, separadores viram espaço e
/// abreviações expandidas, preservando tokens protegidos e números que podem
/// fazer parte da identidade ("Racing 01" ≠ "Racing 02").
pub fn canonicalize_team_name(text: &str) -> String {
    // "(Am)" é como o FlashScore escreve o time amador/reserva; "(AM)" é o Amazonas.
    let normalized = normalize_str(&text.replace("(Am)", " amateur "));
    let separated = replace_runs(&normalized, |c| {
        matches!(c, '-' | '_' | '.' | '/' | '·' | '•' | '|')
    });
    // `[^a-z0-9\s]` sem `u` troca cada unidade UTF-16 por um espaço; o emoji
    // (duas unidades) vira dois espaços, que a linha seguinte junta.
    let cleaned: String = separated
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || js::is_whitespace(c) {
                c
            } else {
                ' '
            }
        })
        .collect();
    let collapsed = collapse_whitespace(&cleaned);
    if collapsed.is_empty() {
        return String::new();
    }
    let tokens = spell_age_categories(collapsed.split(' ').map(str::to_owned).collect());
    let last = tokens.len() - 1;
    let mut expanded: Vec<String> = Vec::with_capacity(tokens.len());
    for (index, token) in tokens.iter().enumerate() {
        let word = match TOKEN_SYNONYMS.iter().find(|(from, _)| from == token) {
            Some((_, synonym)) => *synonym,
            None if (token == "w" || token == "f") && index == last => "women",
            None => token.as_str(),
        };
        // Sinônimo de duas palavras ("sao paulo") entra como dois tokens.
        expanded.extend(
            word.split(' ')
                .filter(|part| !part.is_empty())
                .map(str::to_owned),
        );
    }
    for reserve in &RESERVE_TEAM_NAMES {
        reserve.apply(&mut expanded);
    }
    expanded.join(" ")
}

/// Formas do mesmo nome que o tipster e o fornecedor escrevem diferente (ver o
/// TypeScript). Cada linha lista formas equivalentes, já canonicalizadas.
pub const TEAM_NAME_EQUIVALENTS: &[&[&str]] = &[
    &["munique", "munich", "munchen"],
    &["milao", "milan"],
    &[
        "inter de milao",
        "inter milao",
        "inter milan",
        "internazionale",
    ],
    &["hamburgo", "hamburg"],
    &["aek atenas", "aek athens"],
    &["fc colonia", "fc koln", "fc cologne"],
    &["viena", "vienna", "wien"],
    &["bucareste", "bucharest", "bucuresti"],
    &["marselha", "marseille"],
    &["sevilha", "sevilla"],
    &["napoles", "napoli"],
    &["lisboa", "lisbon"],
    &["moscou", "moscow"],
    &["praga", "prague", "praha"],
    &["varsovia", "warsaw", "warszawa"],
    &["belgrado", "belgrade"],
    &["estrela vermelha", "crvena zvezda"],
    &["copenhague", "copenhagen", "kobenhavn"],
    &["estocolmo", "stockholm"],
    &["salonica", "thessaloniki"],
    &["pireu", "piraeus"],
    &["bruges", "brugge"],
    &["antuerpia", "antwerp"],
    &["istambul", "istanbul"],
    &["berlim", "berlin"],
    &["friburgo", "freiburg"],
    &["estugarda", "stuttgart"],
    &["augsburgo", "augsburg"],
    &["gladbach", "m gladbach", "monchengladbach"],
    &["maiorca", "mallorca"],
    &["saragoca", "zaragoza"],
    &["corunha", "coruna"],
    &["espanhol", "espanyol"],
    &["bolonha", "bologna"],
    &["veneza", "venezia"],
    &["estrasburgo", "strasbourg"],
    &["bordeus", "bordeaux"],
    &["salzburgo", "salzburg"],
    &["zurique", "zurich"],
    &["basileia", "basel"],
    &["roterda", "rotterdam"],
    &["amsterda", "amsterdam"],
    &["edimburgo", "edinburgh"],
    &["olympiacos", "olympiakos"],
    &["dinamo", "dynamo"],
    &["kiev", "kyiv"],
    &["atletico mg", "atletico mineiro"],
    &["america mg", "america mineiro"],
    &["athletico pr", "atletico pr", "athletico paranaense"],
    &["atletico go", "atletico goianiense"],
    &["operario pr", "operario ferroviario"],
    &["man united", "manchester united"],
    &["man city", "manchester city"],
    &["sheff united", "sheffield united"],
    &["sheff wed", "sheff wednesday", "sheffield wednesday"],
    &["nottm forest", "nottingham forest"],
    &["qpr", "queens park rangers"],
    &["wolves", "wolverhampton"],
    &["spurs", "tottenham"],
    &["psg", "paris sg", "paris saint germain"],
    &["jrs", "juniors"],
    &["lp", "l p", "la plata"],
    &["v haugesund", "vard haugesund"],
    &["metalac gm", "metalac gornji milanovac"],
    &["internacional de bogota", "inter bogota"],
    &["club nxt", "club brugge"],
];

static EQUIVALENT_FORMS: LazyLock<HashMap<&'static str, Vec<&'static str>>> = LazyLock::new(|| {
    let mut forms: HashMap<&'static str, Vec<&'static str>> = HashMap::new();
    for row in TEAM_NAME_EQUIVALENTS {
        for form in *row {
            forms
                .entry(form)
                .or_default()
                .extend(row.iter().filter(|other| *other != form));
        }
    }
    forms
});

static MAX_EQUIVALENT_TOKENS: LazyLock<usize> = LazyLock::new(|| {
    TEAM_NAME_EQUIVALENTS
        .iter()
        .flat_map(|row| row.iter())
        .map(|form| form.split(' ').count())
        .max()
        .unwrap_or(1)
});

/// O time B que a Pinnacle chama de II, só no fim do nome e só nesse sentido.
fn reserve_letter_form(token: &str) -> Option<&'static str> {
    (token == "ii").then_some("b")
}

/// `form.slice(0, form.lastIndexOf(" "))` do JavaScript (sem espaço, o
/// `slice(0, -1)` tira o último caractere).
fn without_last_word(form: &str) -> &str {
    match form.rfind(' ') {
        Some(space) => &form[..space],
        None => form
            .char_indices()
            .last()
            .map_or("", |(index, _)| &form[..index]),
    }
}

/// As outras formas de um nome já canonicalizado, pelas equivalências (vazia
/// quando nenhuma regra se aplica, que é o caso comum).
pub fn team_name_variants(canon: &str) -> Vec<String> {
    let tokens: Vec<&str> = canon.split(' ').filter(|token| !token.is_empty()).collect();
    struct Swap<'f> {
        start: usize,
        end: usize,
        forms: &'f [&'static str],
    }
    let mut swaps: Vec<Swap<'_>> = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        // O trecho mais longo ganha: "inter de milao" antes de "milao".
        let mut size = (*MAX_EQUIVALENT_TOKENS).min(tokens.len() - i);
        while size > 0 && !EQUIVALENT_FORMS.contains_key(tokens[i..i + size].join(" ").as_str()) {
            size -= 1;
        }
        if size == 0 {
            i += 1;
            continue;
        }
        let forms = EQUIVALENT_FORMS
            .get(tokens[i..i + size].join(" ").as_str())
            .map_or(&[][..], |forms| forms.as_slice());
        swaps.push(Swap {
            start: i,
            end: i + size,
            forms,
        });
        i += size;
    }
    let reserve = match tokens.len() {
        0 | 1 => None,
        len if swaps.last().map(|swap| swap.end) != Some(len) => {
            reserve_letter_form(tokens[len - 1])
        }
        _ => None,
    };
    let build = |pick: &dyn Fn(usize, &Swap<'_>) -> &'static str| -> String {
        let mut out: Vec<&str> = Vec::new();
        let mut position = 0;
        for (index, swap) in swaps.iter().enumerate() {
            out.extend(&tokens[position..swap.start]);
            out.push(pick(index, swap));
            position = swap.end;
        }
        out.extend(&tokens[position..]);
        out.retain(|token| !token.is_empty());
        out.join(" ")
    };
    let first = |swap: &Swap<'_>| swap.forms.first().copied().unwrap_or("");
    let mut variants: Vec<String> = Vec::new();
    let add = |variant: String, variants: &mut Vec<String>| {
        if !variants.contains(&variant) {
            variants.push(variant);
        }
    };
    if !swaps.is_empty() {
        add(build(&|_, swap| first(swap)), &mut variants);
        for (target, swap) in swaps.iter().enumerate() {
            for alternative in swap.forms.iter().skip(1) {
                add(
                    build(&|index, swap| {
                        if index == target {
                            alternative
                        } else {
                            first(swap)
                        }
                    }),
                    &mut variants,
                );
            }
        }
    }
    // O "II" → "B" é opcional em cada forma.
    if let Some(reserve) = reserve {
        let forms: Vec<String> = std::iter::once(canon.to_owned())
            .chain(variants.iter().cloned())
            .collect();
        for form in forms {
            add(
                format!("{} {reserve}", without_last_word(&form)),
                &mut variants,
            );
        }
    }
    variants.retain(|variant| variant != canon && !variant.is_empty());
    variants
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nomes_canonicos() {
        assert_eq!(normalize_str("  São Paulo FC "), "sao paulo fc");
        assert_eq!(
            canonicalize_team_name("Atlético-MG Sub-20"),
            "atletico mg u20"
        );
        assert_eq!(canonicalize_team_name("Lyon W (Fra)"), "lyon w fra");
        assert_eq!(canonicalize_team_name("Lyon W"), "lyon women");
        assert_eq!(
            canonicalize_team_name("Real Madrid Castilla"),
            "real madrid castilla b"
        );
        assert_eq!(
            canonicalize_team_name("Austria Vienna (Am)"),
            "austria vienna amateur"
        );
        assert_eq!(canonicalize_team_name("Man Utd 📅"), "man united");
        assert!(
            is_protected_token("u19") && is_protected_token("sub23") && !is_protected_token("u1x")
        );
    }

    #[test]
    fn variantes() {
        assert_eq!(
            team_name_variants("bayern de munique"),
            vec!["bayern de munich", "bayern de munchen"]
        );
        assert_eq!(team_name_variants("villarreal ii"), vec!["villarreal b"]);
        assert!(team_name_variants("flamengo").is_empty());
    }
}
