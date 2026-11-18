//! Categoria de time (feminino, base, reserva, time B e o sufixo numérico de
//! reserva, "River Plate 2") e as travas que impedem juntar um time de
//! categoria ao principal, portado de `src/domain/team-category.ts`. A
//! categoria pode vir do nome do time ou da competição.
//!
//! O sufixo numérico não é token protegido: a similaridade também compara
//! seleções de aposta ("Canada Over 1.5"), onde o dígito não é categoria. Só
//! um dígito de 2 a 9: ano de fundação ("Mainz 05", "Bayern 1900") continua
//! compatível.
//!
//! Os conjuntos do TypeScript são listas sem repetição, na ordem de inserção,
//! como o `Set` do JavaScript devolve a quem itera.

use crate::js;
use crate::text_normalization::{
    RESERVE_CLASS_MARKER, RESERVE_CLASS_TOKENS, canonicalize_team_name, is_protected_token,
    normalize_str, team_name_variants,
};
use js_regex::{Regex, regex};
use std::cell::RefCell;
use std::collections::HashMap;

/// Insere sem repetir, como `Set.add`.
pub(crate) fn add_unique(set: &mut Vec<String>, token: impl Into<String>) {
    let token = token.into();
    if !set.contains(&token) {
        set.push(token);
    }
}

/// Os dois conjuntos têm os mesmos elementos.
fn same_elements(left: &[String], right: &[String]) -> bool {
    left.iter().all(|token| right.contains(token)) && right.iter().all(|token| left.contains(token))
}

/// `/^[2-9]$/`: o sufixo numérico de reserva.
pub(crate) fn is_reserve_digit(token: &str) -> bool {
    matches!(token.as_bytes(), [b'2'..=b'9'])
}

/// `/^u\d{2}$/`: idade declarada.
fn is_age_token(token: &str) -> bool {
    token
        .strip_prefix('u')
        .is_some_and(|digits| digits.len() == 2 && js::all_digits(digits))
}

/// II ≡ Youth ≡ Reserves (a classe reserva), mas B é distinto.
pub fn protected_category_key(token: &str) -> &str {
    if RESERVE_CLASS_TOKENS.contains(&token) {
        RESERVE_CLASS_MARKER
    } else {
        token
    }
}

/// Tokens que declaram a CATEGORIA do time: feminino, base, reserva, sufixo
/// numérico. Vazio = o nome não declara nada.
pub fn team_category_tokens(canon: &str, digits_only: bool) -> Vec<String> {
    let mut tokens = Vec::new();
    for token in canon.split(' ') {
        let declares = if digits_only {
            is_reserve_digit(token)
        } else {
            is_protected_token(token) || is_reserve_digit(token)
        };
        if declares {
            add_unique(&mut tokens, protected_category_key(token));
        }
    }
    tokens
}

/// Os dois nomes (canônicos) divergem no sufixo numérico de reserva?
pub fn reserve_suffix_mismatch(ca: &str, cb: &str) -> bool {
    !same_elements(
        &team_category_tokens(ca, true),
        &team_category_tokens(cb, true),
    )
}

fn protected_category_set(canon: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for token in canon.split(' ').filter(|token| is_protected_token(token)) {
        add_unique(&mut tokens, protected_category_key(token));
    }
    tokens
}

/// Os dois nomes (canônicos) divergem em algum token protegido?
pub fn protected_categories_mismatch(ca: &str, cb: &str) -> bool {
    !same_elements(&protected_category_set(ca), &protected_category_set(cb))
}

/// Impede que feminino, base, reservas ou time B sejam fundidos ao principal.
pub fn has_protected_team_category_conflict(a: &str, b: &str) -> bool {
    protected_categories_mismatch(&canonicalize_team_name(a), &canonicalize_team_name(b))
}

/// Conflito de categoria entre dois NOMES DE TIME: tokens protegidos OU sufixo
/// numérico de reserva. Não usar contra seleção de aposta.
pub fn team_identity_category_conflict(a: &str, b: &str) -> bool {
    has_protected_team_category_conflict(a, b)
        || reserve_suffix_mismatch(&canonicalize_team_name(a), &canonicalize_team_name(b))
}

/// A APOSTA declara uma categoria que a fixture do provider não declara
/// nenhuma? Assimétrico de propósito (ver o TypeScript).
pub fn bet_declares_category_fixture_lacks(canon_aposta: &str, canon_fixture: &str) -> bool {
    !team_category_tokens(canon_aposta, false).is_empty()
        && team_category_tokens(canon_fixture, false).is_empty()
}

/// Categoria declarada pela COMPETIÇÃO, com vocabulário próprio: "Liga II" e
/// "Liga 2" são segundas divisões, não ligas de reservas.
fn league_category_patterns() -> [(&'static Regex, &'static str); 3] {
    [
        (
            regex!(r"\b(reserves?|reservas?|next pro)\b", ""),
            RESERVE_CLASS_MARKER,
        ),
        (
            regex!(
                r"\b(youth|academy|akatemia|akademia|primavera|juniors?|development)\b",
                ""
            ),
            RESERVE_CLASS_MARKER,
        ),
        (
            regex!(
                r"\b(women|womens|ladies|feminino|feminina|femenino|femenina|femminile|damen|dames)\b",
                ""
            ),
            "women",
        ),
    ]
}

fn league_age_group() -> &'static Regex {
    regex!(r"\b(?:u|sub)[ -]?(\d{2})\b", "g")
}

/// Base = competição de idade (sub-15 a sub-23, Youth, Primavera, juvenis, a
/// Copinha); ver `isBaseCategoryFixture` no TypeScript.
fn base_league() -> &'static Regex {
    regex!(
        r"\b(?:(?:u|sub)[ -]?(?:1[5-9]|2[0-3])|youth|primavera|juvenil(?:es)?|juniores|futebol junior)\b",
        ""
    )
}

/// Os regexes do módulo, para o catálogo que o teste compara com o V8.
pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all: Vec<&'static Regex> = league_category_patterns()
        .iter()
        .map(|(pattern, _)| *pattern)
        .collect();
    all.extend([league_age_group(), base_league()]);
    all
}

const LEAGUE_TOKENS_MAX: usize = 2_000;

thread_local! {
    // Lida em laço contra o catálogo do dia, com poucas competições distintas.
    static LEAGUE_TOKENS: RefCell<HashMap<String, Vec<String>>> = RefCell::new(HashMap::new());
}

pub fn category_tokens_from_league(league: &str) -> Vec<String> {
    if let Some(known) = LEAGUE_TOKENS.with(|cache| cache.borrow().get(league).cloned()) {
        return known;
    }
    let text = normalize_str(league);
    let mut tokens = Vec::new();
    for (pattern, token) in league_category_patterns() {
        if pattern.is_match(&text) {
            add_unique(&mut tokens, token);
        }
    }
    for group in league_age_group().exec_all(&text) {
        let age = format!("u{}", group.get(1).unwrap_or_default());
        add_unique(&mut tokens, protected_category_key(&age));
    }
    LEAGUE_TOKENS.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= LEAGUE_TOKENS_MAX {
            cache.clear();
        }
        cache.insert(league.to_owned(), tokens.clone());
    });
    tokens
}

/// A LIGA da fixture cobre a categoria que a APOSTA declara? Só na direção em
/// que a trava cega: a aposta declara e o NOME da fixture não declara nada.
pub fn league_covers_bet_category(
    canon_aposta: &str,
    canon_fixture: &str,
    league: Option<&str>,
) -> bool {
    let aposta = team_category_tokens(canon_aposta, false);
    if aposta.is_empty() || !team_category_tokens(canon_fixture, false).is_empty() {
        return false;
    }
    let liga = category_tokens_from_league(league.unwrap_or(""));
    if liga.is_empty() {
        return false;
    }
    aposta.iter().all(|token| {
        liga.contains(token)
            || (is_reserve_digit(token) && liga.iter().any(|t| t == RESERVE_CLASS_MARKER))
    })
}

/// Os dois lados já orientados de um confronto (ver o TypeScript).
pub struct OrientedPair<'a> {
    pub provider_home: &'a str,
    pub provider_away: &'a str,
    pub local_home: &'a str,
    pub local_away: &'a str,
    pub swapped: bool,
    pub league: Option<&'a str>,
}

/// Sufixo numérico de reserva nos dois lados já orientados, salvo quando a
/// liga da fixture cobre a categoria.
pub fn oriented_team_pair_has_reserve_suffix_conflict(pair: &OrientedPair<'_>) -> bool {
    let (local_home, local_away) = if pair.swapped {
        (pair.local_away, pair.local_home)
    } else {
        (pair.local_home, pair.local_away)
    };
    let provider_home = canonicalize_team_name(pair.provider_home);
    let provider_away = canonicalize_team_name(pair.provider_away);
    let local_home = canonicalize_team_name(local_home);
    let local_away = canonicalize_team_name(local_away);
    let home_covered = league_covers_bet_category(&local_home, &provider_home, pair.league);
    let away_covered = league_covers_bet_category(&local_away, &provider_away, pair.league);
    (!home_covered && reserve_suffix_mismatch(&provider_home, &local_home))
        || (!away_covered && reserve_suffix_mismatch(&provider_away, &local_away))
}

/// Remove tokens de categoria já satisfeitos pelo contexto da liga.
pub fn strip_category_tokens(canon_name: &str, tokens_to_strip: &[String]) -> String {
    if canon_name.is_empty() || tokens_to_strip.is_empty() {
        return canon_name.to_owned();
    }
    let strip = |token: &str| tokens_to_strip.iter().any(|t| t == token);
    let kept: Vec<&str> = canon_name
        .split(' ')
        .filter(|word| !word.is_empty())
        .filter(|word| {
            if strip(protected_category_key(word)) || strip(word) {
                return false;
            }
            !(is_reserve_digit(word) && (strip(word) || strip(RESERVE_CLASS_MARKER)))
        })
        .collect();
    if kept.is_empty() {
        canon_name.to_owned()
    } else {
        js::trim(&kept.join(" ")).to_owned()
    }
}

/// Compatibilidade de categoria entre o time da aposta e o da fixture, lendo
/// os nomes e as competições.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryCompatibility {
    pub compatible: bool,
    /// As categorias que os dois lados declaram e que a comparação de nomes
    /// pode ignorar.
    pub covered_tokens: Vec<String>,
}

fn incompatible() -> CategoryCompatibility {
    CategoryCompatibility {
        compatible: false,
        covered_tokens: Vec::new(),
    }
}

/// `texto?.trim()` verdadeiro: a competição foi informada.
fn declared(league: Option<&str>) -> bool {
    league.is_some_and(|league| !js::trim(league).is_empty())
}

pub fn are_categories_compatible(
    bet_canon: &str,
    fixture_canon: &str,
    bet_league: Option<&str>,
    fixture_league: Option<&str>,
) -> CategoryCompatibility {
    let bet_team = team_category_tokens(bet_canon, false);
    let fixture_team = team_category_tokens(fixture_canon, false);
    let bet_league_tokens = category_tokens_from_league(bet_league.unwrap_or(""));
    let fixture_league_tokens = category_tokens_from_league(fixture_league.unwrap_or(""));
    let union = |a: &[String], b: &[String]| {
        let mut all = Vec::new();
        for token in a.iter().chain(b) {
            add_unique(&mut all, token.as_str());
        }
        all
    };
    let bet_all = union(&bet_team, &bet_league_tokens);
    let fixture_all = union(&fixture_team, &fixture_league_tokens);
    let has = |set: &[String], token: &str| set.iter().any(|t| t == token);

    // Feminino: aposta feminina exige fixture feminina; fixture feminina contra
    // aposta que declara outra competição também não casa.
    let bet_women = has(&bet_all, "women");
    let fixture_women = has(&fixture_all, "women");
    if bet_women && !fixture_women {
        return incompatible();
    }
    if fixture_women && !bet_women && declared(bet_league) {
        return incompatible();
    }
    let mut covered = Vec::new();
    if bet_women && fixture_women {
        add_unique(&mut covered, "women");
    }

    // Idades declaradas dos dois lados precisam ter uma em comum.
    let bet_ages: Vec<&String> = bet_all.iter().filter(|t| is_age_token(t)).collect();
    let fixture_ages: Vec<&String> = fixture_all.iter().filter(|t| is_age_token(t)).collect();
    if !bet_ages.is_empty() && !fixture_ages.is_empty() {
        if !bet_ages.iter().any(|age| fixture_ages.contains(age)) {
            return incompatible();
        }
        for age in &bet_ages {
            if fixture_ages.contains(age) {
                add_unique(&mut covered, age.as_str());
            }
        }
    }

    // Reservas e dígitos cobertos pela liga do outro lado.
    let mut covered_by_league: Vec<&String> = Vec::new();
    if league_covers_bet_category(bet_canon, fixture_canon, fixture_league) {
        covered_by_league.extend(&bet_team);
    }
    if league_covers_bet_category(fixture_canon, bet_canon, bet_league) {
        covered_by_league.extend(&fixture_team);
    }
    for token in covered_by_league {
        add_unique(&mut covered, token.as_str());
        if is_reserve_digit(token) {
            add_unique(&mut covered, RESERVE_CLASS_MARKER);
        }
    }

    // A mesma categoria declarada no nome dos dois times.
    for token in &bet_team {
        if fixture_team.contains(token) {
            add_unique(&mut covered, token.as_str());
        }
    }

    // Liga de reservas na fixture contra aposta de outra competição sem categoria.
    if has(&fixture_league_tokens, RESERVE_CLASS_MARKER)
        && bet_all.is_empty()
        && declared(bet_league)
    {
        return incompatible();
    }
    // E o espelho: aposta de liga de reservas ou de base contra fixture de liga
    // conhecida sem categoria nenhuma.
    let bet_league_reserve_or_age = bet_league_tokens
        .iter()
        .any(|t| t == RESERVE_CLASS_MARKER || is_age_token(t));
    if bet_league_reserve_or_age
        && bet_team.is_empty()
        && fixture_all.is_empty()
        && declared(fixture_league)
    {
        return incompatible();
    }
    CategoryCompatibility {
        compatible: true,
        covered_tokens: covered,
    }
}

/// Conflito de categoria entre o time da aposta e o da fixture, lendo também
/// as competições, e sem conflito quando uma forma equivalente o tira.
pub fn team_category_conflict_in_context(
    bet_name: &str,
    fixture_name: &str,
    bet_league: Option<&str>,
    fixture_league: Option<&str>,
) -> bool {
    let bet_canon = canonicalize_team_name(bet_name);
    let fixture_canon = canonicalize_team_name(fixture_name);
    let category =
        are_categories_compatible(&bet_canon, &fixture_canon, bet_league, fixture_league);
    if !category.compatible {
        return true;
    }
    let bet = strip_category_tokens(&bet_canon, &category.covered_tokens);
    let fixture = strip_category_tokens(&fixture_canon, &category.covered_tokens);
    let conflict =
        |a: &str, b: &str| protected_categories_mismatch(a, b) || reserve_suffix_mismatch(a, b);
    if !conflict(&bet, &fixture) {
        return false;
    }
    let fixture_forms: Vec<String> = std::iter::once(fixture.clone())
        .chain(team_name_variants(&fixture))
        .collect();
    std::iter::once(bet.clone())
        .chain(team_name_variants(&bet))
        .all(|a| fixture_forms.iter().all(|b| conflict(&a, b)))
}

/// A categoria de um time: a do NOME ou, se ele não declara nenhuma, a da
/// COMPETIÇÃO. O sufixo numérico conta como a classe reserva.
pub fn team_category_in_context(name: &str, league: Option<&str>) -> Vec<String> {
    let mut from_name = Vec::new();
    for token in team_category_tokens(&canonicalize_team_name(name), false) {
        let token = if is_reserve_digit(&token) {
            RESERVE_CLASS_MARKER.to_owned()
        } else {
            token
        };
        add_unique(&mut from_name, token);
    }
    if from_name.is_empty() {
        category_tokens_from_league(league.unwrap_or(""))
    } else {
        from_name
    }
}

pub fn same_team_category(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().all(|token| b.contains(token))
}

/// `/^u(?:1[5-9]|20)$/`: time sub-15 a sub-20.
fn is_base_team_token(token: &str) -> bool {
    matches!(token, "u15" | "u16" | "u17" | "u18" | "u19" | "u20")
}

/// Jogo de base nunca é candidato (ver o TypeScript): competição de idade ou
/// time sub-15 a sub-20.
pub fn is_base_category_fixture(home: &str, away: &str, league: Option<&str>) -> bool {
    if base_league().is_match(&normalize_str(league.unwrap_or(""))) {
        return true;
    }
    [home, away].iter().any(|name| {
        canonicalize_team_name(name)
            .split(' ')
            .any(is_base_team_token)
    })
}
