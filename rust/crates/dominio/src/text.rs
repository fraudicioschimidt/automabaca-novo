//! Texto de aposta e de provider para matching, portado de `src/domain/text.ts`:
//! similaridade de nomes de time, separação "A vs B", slug, o casamento dos
//! dois lados de um confronto e o refinamento de candidatos por categoria.
//!
//! As contas seguem as do TypeScript na mesma ordem (o número é o mesmo), e
//! comprimentos, bigramas e distância de edição contam unidades UTF-16, como
//! o `length` e o `slice` do JavaScript.

use crate::js;
use crate::team_category::{
    are_categories_compatible, category_tokens_from_league, protected_categories_mismatch,
    strip_category_tokens, team_category_in_context, team_category_tokens,
    team_identity_category_conflict,
};
use crate::text_normalization::{
    RESERVE_CLASS_MARKER, RESERVE_CLASS_TOKENS, TEAM_STOP_WORDS, canonicalize_team_name,
    collapse_whitespace, is_protected_token, normalize_str, team_name_variants,
};
use js_regex::{Regex, regex};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn is_stop_word(word: &str) -> bool {
    TEAM_STOP_WORDS.contains(&word)
}

/// `text.replace(/\s+/g, "")`.
fn without_whitespace(text: &str) -> String {
    text.chars().filter(|c| !js::is_whitespace(*c)).collect()
}

/// Tokens e bigramas de um nome canônico.
struct NameFeatures {
    tokens: HashSet<String>,
    grams: HashSet<(u16, u16)>,
}

fn name_features_uncached(canon: &str) -> NameFeatures {
    // Token set para similaridade: II/Youth/B contam como a mesma classe reserva.
    let tokens = canon
        .split(' ')
        .filter(|token| !token.is_empty())
        .map(|token| {
            if RESERVE_CLASS_TOKENS.contains(&token) {
                RESERVE_CLASS_MARKER.to_owned()
            } else {
                token.to_owned()
            }
        })
        .collect();
    let units: Vec<u16> = without_whitespace(canon).encode_utf16().collect();
    let grams = units.windows(2).map(|pair| (pair[0], pair[1])).collect();
    NameFeatures { tokens, grams }
}

const FEATURE_CACHE_LIMIT: usize = 20_000;

thread_local! {
    // O laço contra o catálogo compara o mesmo nome do fornecedor com cada
    // aposta e com cada forma do dicionário.
    static FEATURES: RefCell<HashMap<String, Rc<NameFeatures>>> = RefCell::new(HashMap::new());
}

fn name_features(canon: &str) -> Rc<NameFeatures> {
    if let Some(known) = FEATURES.with(|cache| cache.borrow().get(canon).cloned()) {
        return known;
    }
    let features = Rc::new(name_features_uncached(canon));
    FEATURES.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= FEATURE_CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(canon.to_owned(), Rc::clone(&features));
    });
    features
}

fn dice(a: &HashSet<(u16, u16)>, b: &HashSet<(u16, u16)>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.iter().filter(|gram| b.contains(gram)).count();
    (2 * inter) as f64 / (a.len() + b.len()) as f64
}

/// Semelhança de um lado do confronto: `score` soma no par; `evidence` é a
/// parte que pode ANCORAR o par (tudo menos o resgate de digitação).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TeamSideSimilarity {
    pub score: f64,
    pub evidence: f64,
}

const NO_SIMILARITY: TeamSideSimilarity = TeamSideSimilarity {
    score: 0.0,
    evidence: 0.0,
};
const SAME_NAME: TeamSideSimilarity = TeamSideSimilarity {
    score: 1.0,
    evidence: 1.0,
};
const EXPANDED_CAP: f64 = 0.95;

/// Similaridade híbrida 0..1 entre nomes de time (ver o TypeScript).
pub fn team_similarity(a: &str, b: &str) -> f64 {
    team_similarity_canon(&canonicalize_team_name(a), &canonicalize_team_name(b))
}

/// Núcleo de `team_similarity` para nomes JÁ canonicalizados.
pub fn team_similarity_canon(ca: &str, cb: &str) -> f64 {
    team_side_similarity_canon(ca, cb).score
}

/// `team_similarity_canon` com a evidência de âncora: vale o melhor entre os
/// nomes como vieram, as formas equivalentes do dicionário e a inicial
/// expandida.
pub fn team_side_similarity_canon(ca: &str, cb: &str) -> TeamSideSimilarity {
    let direct = raw_side_similarity(ca, cb, true);
    if direct.evidence == 1.0 {
        return direct;
    }
    let variants_a = team_name_variants(ca);
    let variants_b = team_name_variants(cb);
    let initials_a = expand_initials(ca, cb);
    let initials_b = expand_initials(cb, ca);
    if variants_a.is_empty()
        && variants_b.is_empty()
        && initials_a.is_none()
        && initials_b.is_none()
    {
        return direct;
    }
    let TeamSideSimilarity {
        mut score,
        mut evidence,
    } = direct;
    // A forma do dicionário e a inicial expandida valem como estão: sem o
    // resgate de digitação em cima delas.
    let forms_a: Vec<&str> = std::iter::once(ca)
        .chain(variants_a.iter().map(String::as_str))
        .collect();
    let forms_b: Vec<&str> = std::iter::once(cb)
        .chain(variants_b.iter().map(String::as_str))
        .collect();
    for a in &forms_a {
        for b in &forms_b {
            if *a != ca || *b != cb {
                let side = raw_side_similarity(a, b, false);
                score = score.max(side.score);
                evidence = evidence.max(side.evidence);
            }
        }
    }
    // A forma expandida fica abaixo do nome igual; só a inicial de uma letra ancora.
    let expanded = [
        (
            initials_a.as_ref(),
            initials_a.as_ref().map(|e| e.name.as_str()),
            Some(cb),
        ),
        (
            initials_b.as_ref(),
            Some(ca),
            initials_b.as_ref().map(|e| e.name.as_str()),
        ),
    ];
    for (expansion, a, b) in expanded {
        let (Some(expansion), Some(a), Some(b)) = (expansion, a, b) else {
            continue;
        };
        if a.is_empty() || b.is_empty() {
            continue;
        }
        let side = raw_side_similarity(a, b, false);
        score = score.max(side.score.min(EXPANDED_CAP));
        if !expansion.prefix {
            evidence = evidence.max(side.evidence.min(EXPANDED_CAP));
        }
    }
    TeamSideSimilarity { score, evidence }
}

/// Letra solta que é categoria, não inicial: B (reserva), W e F (feminino).
const CATEGORY_LETTERS: [&str; 3] = ["b", "w", "f"];
const JOINERS: [&str; 8] = ["de", "del", "da", "do", "dos", "das", "e", "y"];
/// Sigla de estado brasileiro no fim do nome não é abreviação.
const BRAZILIAN_STATES: [&str; 27] = [
    "ac", "al", "ap", "am", "ba", "ce", "df", "es", "go", "ma", "mt", "ms", "mg", "pa", "pb", "pr",
    "pe", "pi", "rj", "rn", "rs", "ro", "rr", "sc", "sp", "se", "to",
];
/// Palavra comum demais para confirmar a abreviação ("M. City").
const GENERIC_SUPPORT: [&str; 14] = [
    "city",
    "united",
    "town",
    "county",
    "rovers",
    "wanderers",
    "athletic",
    "athletico",
    "sport",
    "sports",
    "juniors",
    "rangers",
    "albion",
    "calcio",
];

fn is_lowercase_ascii_word(word: &str) -> bool {
    !word.is_empty() && word.bytes().all(|b| b.is_ascii_lowercase())
}

struct Expansion {
    name: String,
    prefix: bool,
}

/// "A. Italiano" = "Audax Italiano": troca cada abreviação de `a` pela próxima
/// palavra de `b` que começa com ela, na mesma ordem, se uma palavra
/// distintiva é igual nos dois lados (ver o TypeScript).
fn expand_initials(a: &str, b: &str) -> Option<Expansion> {
    // `/(?:^| )[a-z]{1,3}(?: |$)/`.
    let words_a: Vec<&str> = a.split(' ').collect();
    if !words_a
        .iter()
        .any(|word| utf16_len(word) <= 3 && is_lowercase_ascii_word(word))
    {
        return None;
    }
    let words_b: Vec<&str> = b
        .split(' ')
        .filter(|word| !JOINERS.contains(word))
        .collect();
    let last = words_a.len() - 1;
    let is_abbreviation = |word: &str, index: usize| -> bool {
        if JOINERS.contains(&word) || words_b.contains(&word) {
            return false;
        }
        // A sigla de estado vem no fim ("Botafogo SP"); no começo é abreviação.
        if BRAZILIAN_STATES.contains(&word) && index == last {
            return false;
        }
        let length = utf16_len(word);
        if length == 1 {
            let previous_single = index > 0 && utf16_len(words_a[index - 1]) == 1;
            return !CATEGORY_LETTERS.contains(&word) && (index < last || previous_single);
        }
        length <= 3
            && is_lowercase_ascii_word(word)
            && !is_stop_word(word)
            && !is_protected_token(word)
    };
    if !words_a
        .iter()
        .enumerate()
        .any(|(index, word)| is_abbreviation(word, index))
    {
        return None;
    }
    let supported = words_a.iter().any(|word| {
        utf16_len(word) > 2
            && !is_stop_word(word)
            && !GENERIC_SUPPORT.contains(word)
            && words_b.contains(word)
    });
    if !supported {
        return None;
    }
    let mut out: Vec<&str> = Vec::with_capacity(words_a.len());
    let mut next = 0;
    let mut prefix = false;
    for (index, word) in words_a.iter().enumerate() {
        let at = words_b
            .iter()
            .skip(next)
            .position(|other| other == word)
            .map(|p| p + next);
        if at.is_some() || !is_abbreviation(word, index) {
            if let Some(at) = at {
                next = at + 1;
            }
            out.push(word);
            continue;
        }
        let length = utf16_len(word);
        let found = (next..words_b.len()).find(|found| {
            let candidate = words_b[*found];
            utf16_len(candidate) > length && candidate.starts_with(word)
        })?;
        out.push(words_b[found]);
        next = found + 1;
        prefix |= length > 1;
    }
    Some(Expansion {
        name: out.join(" "),
        prefix,
    })
}

/// A evidência de um par de nomes (sem o resgate de digitação).
pub fn team_name_evidence(a: &str, b: &str) -> f64 {
    team_side_similarity_canon(&canonicalize_team_name(a), &canonicalize_team_name(b)).evidence
}

fn raw_side_similarity(ca: &str, cb: &str, typo_rescue: bool) -> TeamSideSimilarity {
    if ca.is_empty() || cb.is_empty() {
        return NO_SIMILARITY;
    }
    if ca == cb {
        return SAME_NAME;
    }
    let features_a = name_features(ca);
    let features_b = name_features(cb);
    let (ta, tb) = (&features_a.tokens, &features_b.tokens);
    let protected_mismatch = protected_categories_mismatch(ca, cb);
    let inter = ta.iter().filter(|token| tb.contains(*token)).count();
    let union = ta.len() + tb.len() - inter;
    let jaccard = if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    };
    let containment = inter as f64 / 1usize.max(ta.len().min(tb.len())) as f64;
    let dice = dice(&features_a.grams, &features_b.grams);
    let smaller = if ta.len() <= tb.len() { ta } else { tb };
    let distinctive = smaller
        .iter()
        .any(|token| utf16_len(token) > 2 && !is_stop_word(token) && token != RESERVE_CLASS_MARKER);
    let evidence_only = |score: f64| {
        let capped = if protected_mismatch {
            score.min(0.35)
        } else {
            score
        };
        TeamSideSimilarity {
            score: capped,
            evidence: capped,
        }
    };
    if containment >= 0.999 && distinctive {
        return evidence_only(0.9f64.max(0.6 * dice + 0.4));
    }
    let fa = without_whitespace(ca);
    let fb = without_whitespace(cb);
    if (fa.contains(&fb) || fb.contains(&fa)) && utf16_len(&fa).min(utf16_len(&fb)) >= 4 {
        return evidence_only(0.85f64.max(0.5 * dice + 0.4));
    }
    let score = 0.45 * jaccard + 0.3 * dice + 0.25 * containment;
    if protected_mismatch {
        return evidence_only(score);
    }
    let rescued = if typo_rescue {
        score.max(typo_rescue_score(ca, cb))
    } else {
        score
    };
    TeamSideSimilarity {
        score: rescued,
        evidence: score,
    }
}

/// Piso do lado ÂNCORA de um confronto, sobre a `evidence` do lado.
pub const ANCHOR_SIDE_FLOOR: f64 = 0.5;

/// O par tem um lado âncora? As evidências dos lados JÁ orientados.
pub fn fixture_has_anchor_side(home_evidence: f64, away_evidence: f64) -> bool {
    home_evidence.max(away_evidence) >= ANCHOR_SIDE_FLOOR
}

/// Piso do resgate de digitação.
const TYPO_RESCUE_FLOOR: f64 = 0.85;

/// Forma jurídica e artigo: não distinguem um time na comparação de digitação.
const TYPO_IGNORED_TOKENS: [&str; 15] = [
    "fc", "sc", "ca", "fk", "sk", "club", "de", "da", "do", "del", "the", "ac", "cf", "bk", "if",
];

fn typo_rescue_score(ca: &str, cb: &str) -> f64 {
    let direct = typo_ratio(ca, cb);
    if direct > 0.0 {
        return direct;
    }
    let without_legal_form = |canon: &str| {
        canon
            .split(' ')
            .filter(|word| !TYPO_IGNORED_TOKENS.contains(word))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let sa = without_legal_form(ca);
    let sb = without_legal_form(cb);
    if (sa != ca) != (sb != cb) {
        typo_ratio(&sa, &sb)
    } else {
        0.0
    }
}

/// 0 quando não alcança o piso, para o `max` do chamador ignorar.
fn typo_ratio(a: &str, b: &str) -> f64 {
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    let longest = a.len().max(b.len());
    if longest == 0 {
        return 0.0;
    }
    // Pré-filtro barato: a diferença de tamanho já impede alcançar o piso.
    if 1.0 - (a.len() as f64 - b.len() as f64).abs() / (longest as f64) < TYPO_RESCUE_FLOOR {
        return 0.0;
    }
    let similarity = 1.0 - edit_distance(&a, &b) as f64 / longest as f64;
    if similarity >= TYPO_RESCUE_FLOOR {
        similarity
    } else {
        0.0
    }
}

/// Distância de edição em que a inversão de duas letras vizinhas custa 1
/// (Damerau restrita), com três linhas em vez da matriz inteira.
fn edit_distance(a: &[u16], b: &[u16]) -> usize {
    if a == b {
        return 0;
    }
    let mut before_previous = vec![0usize; b.len() + 1];
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        current[0] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (previous[j] + 1)
                .min(current[j - 1] + 1)
                .min(previous[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(before_previous[j - 2] + 1);
            }
            current[j] = best;
        }
        std::mem::swap(&mut before_previous, &mut previous);
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
}

/// Melhor token para busca textual em provider (mais distintivo e longo).
pub fn best_search_word(text: &str) -> String {
    let canon = canonicalize_team_name(text);
    let words: Vec<&str> = canon.split(' ').filter(|word| !word.is_empty()).collect();
    if words.is_empty() {
        return normalize_str(text);
    }
    let longest_first = |pool: &[&str]| -> String {
        pool.iter()
            .fold(None::<&str>, |best, word| match best {
                Some(best) if utf16_len(word) <= utf16_len(best) => Some(best),
                _ => Some(word),
            })
            .unwrap_or("")
            .to_owned()
    };
    let meaningful: Vec<&str> = words
        .iter()
        .copied()
        .filter(|word| {
            utf16_len(word) > 2
                && !is_stop_word(word)
                && !js::all_digits(word)
                && !is_protected_token(word)
        })
        .collect();
    if !meaningful.is_empty() {
        return longest_first(&meaningful);
    }
    // Só descritores genéricos ("Team 1", "Equipe A"): nunca como filtro.
    let nongeneric: Vec<&str> = words
        .iter()
        .copied()
        .filter(|word| !is_stop_word(word) && !is_protected_token(word))
        .collect();
    longest_first(&nongeneric)
}

fn state_suffixes_around_hyphen() -> &'static Regex {
    regex!(
        r"^.+\/[a-z]{2}\s+[-–—]\s+.+\/[a-z]{2}(?:\s+[-–—]\s+.*)?$",
        "i"
    )
}

fn round_suffix() -> &'static Regex {
    regex!(
        r"\s+[-–—]\s+(?:(?:\d+[ªºa.]*)\s*)?(?:(?:rodada|round|jornada|matchday)\b|[rj]\.?(?=\s|$)).*$",
        "i"
    )
}

fn delimiter_vs() -> &'static Regex {
    regex!(r"\s+(?:vs\.?|versus)\s+", "i")
}
fn delimiter_x() -> &'static Regex {
    regex!(r"\s+x\s+", "")
}
fn delimiter_upper_x() -> &'static Regex {
    regex!(r"\s+X\s+", "")
}
fn delimiter_slash() -> &'static Regex {
    regex!(r"\s+\/\s+", "")
}
fn delimiter_dash() -> &'static Regex {
    regex!(r"\s+[-–—]\s+", "")
}
fn delimiter_glued_slash() -> &'static Regex {
    regex!(r"(?<=\S)\/(?=\S)", "")
}
fn delimiter_v() -> &'static Regex {
    regex!(r"\s+v\.?\s+", "")
}
fn delimiter_upper_v() -> &'static Regex {
    regex!(r"\s+V\.?\s+", "")
}

fn placeholder_opponent() -> &'static Regex {
    regex!(r"\b(?:adversario|opponent|tbd|a definir)\b|\.{3}|…", "")
}

fn line_as_team() -> &'static Regex {
    regex!(
        r"^[+-]?\s*\d+(?:[.,]\d+)?(?:\s*(?:ha|ah|handicap|ml|pts?|pontos?))?$",
        "i"
    )
}

fn soccer_reserve_marker() -> &'static Regex {
    regex!(r"\s+(?:R|Res)\.?\s*$", "i")
}

fn letter_or_number() -> &'static Regex {
    regex!(r"^[\p{L}\p{N}]$", "u")
}

/// Os regexes do módulo, para o catálogo que o teste compara com o V8.
pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        state_suffixes_around_hyphen(),
        round_suffix(),
        delimiter_vs(),
        delimiter_x(),
        delimiter_upper_x(),
        delimiter_slash(),
        delimiter_dash(),
        delimiter_glued_slash(),
        delimiter_v(),
        delimiter_upper_v(),
        placeholder_opponent(),
        line_as_team(),
        soccer_reserve_marker(),
        letter_or_number(),
    ]
}

/// Divide "Time A vs Time B" em casa/fora, tolerando os delimitadores comuns.
/// `None` quando não é um confronto.
pub fn split_evento_teams(evento: &str) -> Option<(String, String)> {
    let compact = collapse_whitespace(evento);
    if compact.is_empty() {
        return None;
    }
    // Delimitadores em ordem de FORÇA (ver o TypeScript). X e V maiúsculos só
    // valem com o evento todo em caixa alta.
    let state_suffixes = state_suffixes_around_hyphen().is_match(&compact);
    let all_upper = compact == js_text::to_upper_case(&compact);
    let mut delimiters: Vec<(&'static Regex, bool)> =
        vec![(delimiter_vs(), false), (delimiter_x(), false)];
    if all_upper {
        delimiters.push((delimiter_upper_x(), false));
    }
    delimiters.push((delimiter_slash(), false));
    if state_suffixes {
        delimiters.push((delimiter_dash(), false));
    }
    delimiters.push((delimiter_glued_slash(), true));
    delimiters.push((delimiter_v(), false));
    if all_upper {
        delimiters.push((delimiter_upper_v(), false));
    }
    if !state_suffixes {
        delimiters.push((delimiter_dash(), false));
    }
    for (pattern, glued_slash) in delimiters {
        let Some(found) = pattern.exec(&compact) else {
            continue;
        };
        let home = js::trim(&compact[..found.start()]).to_owned();
        let away = js::trim(&compact[found.end()..]).to_owned();
        // Sufixo de rodada polui o visitante: "Time A - Time B - 15ª rodada".
        let away = js::trim(&round_suffix().replace(&away, "")).to_owned();
        if glued_slash {
            let size = |name: &str| name.chars().filter(char::is_ascii_alphanumeric).count();
            if size(&home) < 2 || size(&away) < 2 {
                continue;
            }
        }
        if !home.is_empty() && !away.is_empty() {
            return Some((home, away));
        }
    }
    None
}

/// Adversário inventado ou cortado, ou uma linha no lugar de um dos times.
pub fn fixture_has_placeholder_team(evento: &str) -> bool {
    if placeholder_opponent().is_match(&normalize_str(evento)) {
        return true;
    }
    split_evento_teams(evento).is_some_and(|(home, away)| {
        [home, away]
            .iter()
            .any(|team| line_as_team().is_match(js::trim(team)))
    })
}

/// Limiar único de "é o MESMO confronto, só com outro alias dos times".
pub const SAME_FIXTURE_MIN_SIMILARITY: f64 = 0.85;

/// Os dois eventos descrevem o mesmo confronto (mandante com mandante,
/// visitante com visitante)?
pub fn same_fixture_teams(evento_a: &str, evento_b: &str) -> bool {
    let (Some((home_a, away_a)), Some((home_b, away_b))) =
        (split_evento_teams(evento_a), split_evento_teams(evento_b))
    else {
        return false;
    };
    if team_identity_category_conflict(&home_a, &home_b)
        || team_identity_category_conflict(&away_a, &away_b)
    {
        return false;
    }
    team_similarity(&home_a, &home_b) >= SAME_FIXTURE_MIN_SIMILARITY
        && team_similarity(&away_a, &away_b) >= SAME_FIXTURE_MIN_SIMILARITY
}

/// "Tipster João" → "tipster-joao" (slug de URL).
pub fn slugify(text: &str) -> String {
    let normalized = normalize_str(text);
    let mut slug = String::with_capacity(normalized.len());
    let mut in_run = false;
    for c in normalized.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
            in_run = false;
        } else if !in_run {
            slug.push('-');
            in_run = true;
        }
    }
    // `/(^-|-$)/g`: um hífen em cada ponta.
    let slug = slug.strip_prefix('-').unwrap_or(&slug);
    slug.strip_suffix('-').unwrap_or(slug).to_owned()
}

/// A similaridade dos dois lados de um confronto nas duas orientações.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MatchTeamsResult {
    pub direct_home: f64,
    pub direct_away: f64,
    pub inverted_home: f64,
    pub inverted_away: f64,
    pub direct: f64,
    pub inverted: f64,
    pub swapped: bool,
    pub score: f64,
    pub compatible: bool,
    pub anchored: bool,
    pub evidence_home: f64,
    pub evidence_away: f64,
}

/// Os nomes já canonicalizados de um confronto da aposta contra o da fixture.
pub struct CanonFixturePair<'a> {
    pub bet_home: &'a str,
    pub bet_away: &'a str,
    pub fixture_home: &'a str,
    pub fixture_away: &'a str,
    pub bet_league: Option<&'a str>,
    pub fixture_league: Option<&'a str>,
}

struct OrientedSide {
    similarity: TeamSideSimilarity,
    compatible: bool,
}

/// `matchTeamsWithCategoryContext`: canonicaliza e compara.
pub fn match_teams_with_category_context(pair: &CanonFixturePair<'_>) -> MatchTeamsResult {
    let canon = [
        pair.bet_home,
        pair.bet_away,
        pair.fixture_home,
        pair.fixture_away,
    ]
    .map(canonicalize_team_name);
    match_canon_teams_with_category_context(&CanonFixturePair {
        bet_home: &canon[0],
        bet_away: &canon[1],
        fixture_home: &canon[2],
        fixture_away: &canon[3],
        bet_league: pair.bet_league,
        fixture_league: pair.fixture_league,
    })
}

/// Núcleo para nomes JÁ canonicalizados. Sem categoria declarada em lugar
/// nenhum, que é o caso comum, pula a leitura de categoria por orientação.
pub fn match_canon_teams_with_category_context(pair: &CanonFixturePair<'_>) -> MatchTeamsResult {
    let (bet_league, fixture_league) = (pair.bet_league, pair.fixture_league);
    let no_category = [
        pair.bet_home,
        pair.bet_away,
        pair.fixture_home,
        pair.fixture_away,
    ]
    .iter()
    .all(|canon| team_category_tokens(canon, false).is_empty())
        && category_tokens_from_league(bet_league.unwrap_or("")).is_empty()
        && category_tokens_from_league(fixture_league.unwrap_or("")).is_empty();
    let side = |bet: &str, fixture: &str| -> OrientedSide {
        if no_category {
            return OrientedSide {
                similarity: team_side_similarity_canon(bet, fixture),
                compatible: true,
            };
        }
        let category = are_categories_compatible(bet, fixture, bet_league, fixture_league);
        OrientedSide {
            similarity: team_side_similarity_canon(
                &strip_category_tokens(bet, &category.covered_tokens),
                &strip_category_tokens(fixture, &category.covered_tokens),
            ),
            compatible: category.compatible,
        }
    };
    let direct_home = side(pair.bet_home, pair.fixture_home);
    let direct_away = side(pair.bet_away, pair.fixture_away);
    let direct_compatible = direct_home.compatible && direct_away.compatible;
    let direct = if direct_compatible {
        direct_home.similarity.score + direct_away.similarity.score
    } else {
        0.0
    };
    let inverted_home = side(pair.bet_away, pair.fixture_home);
    let inverted_away = side(pair.bet_home, pair.fixture_away);
    let inverted_compatible = inverted_home.compatible && inverted_away.compatible;
    let inverted = if inverted_compatible {
        inverted_home.similarity.score + inverted_away.similarity.score
    } else {
        0.0
    };
    let swapped = inverted > direct;
    let (chosen_home, chosen_away) = if swapped {
        (&inverted_home, &inverted_away)
    } else {
        (&direct_home, &direct_away)
    };
    MatchTeamsResult {
        direct_home: direct_home.similarity.score,
        direct_away: direct_away.similarity.score,
        inverted_home: inverted_home.similarity.score,
        inverted_away: inverted_away.similarity.score,
        direct,
        inverted,
        swapped,
        score: direct.max(inverted),
        compatible: if swapped {
            inverted_compatible
        } else {
            direct_compatible
        },
        anchored: fixture_has_anchor_side(
            chosen_home.similarity.evidence,
            chosen_away.similarity.evidence,
        ),
        evidence_home: chosen_home.similarity.evidence,
        evidence_away: chosen_away.similarity.evidence,
    }
}

/// O que a categoria decide de um candidato.
#[derive(Debug, Clone)]
pub struct CategoryCandidateFixture {
    pub home: String,
    pub away: String,
    pub league: Option<String>,
    /// País da competição; sem ele, a listagem em dobro não é presumida.
    pub country: Option<String>,
    pub kickoff_ms: f64,
    /// O candidato tem o mando trocado em relação ao post.
    pub swapped: bool,
}

/// O mesmo confronto com o principal e a categoria no mesmo fim de semana.
const CATEGORY_TWIN_WINDOW_MS: f64 = 36.0 * 3_600_000.0;
/// O mesmo jogo listado duas vezes pelo provider.
const DUPLICATE_LISTING_WINDOW_MS: f64 = 10.0 * 60_000.0;
const DUPLICATE_LISTING_MIN_SIDE: f64 = 0.85;

fn pair_without_category(fixture: &CategoryCandidateFixture) -> String {
    let side = |name: &str| {
        let canon = canonicalize_team_name(name);
        strip_category_tokens(&canon, &team_category_tokens(&canon, false))
    };
    let mut sides = [side(&fixture.home), side(&fixture.away)];
    // O `sort()` do JavaScript compara por unidade UTF-16.
    sides.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    sides.join(" x ")
}

fn declares_category(home: &str, away: &str, league: Option<&str>) -> bool {
    !team_category_in_context(home, league).is_empty()
        || !team_category_in_context(away, league).is_empty()
}

/// O mesmo jogo listado duas vezes: mesmo país, mesmo horário, os dois times
/// parecidos e o mesmo mando.
fn same_listed_game(a: &CategoryCandidateFixture, b: &CategoryCandidateFixture) -> bool {
    if (a.kickoff_ms - b.kickoff_ms).abs() > DUPLICATE_LISTING_WINDOW_MS {
        return false;
    }
    let country = |country: &Option<String>| normalize_str(country.as_deref().unwrap_or(""));
    let (country_a, country_b) = (country(&a.country), country(&b.country));
    if country_a.is_empty() || country_a != country_b {
        return false;
    }
    let [ah, aa, bh, ba] =
        [&a.home, &a.away, &b.home, &b.away].map(|name| canonicalize_team_name(name));
    team_similarity_canon(&ah, &bh).min(team_similarity_canon(&aa, &ba))
        >= DUPLICATE_LISTING_MIN_SIDE
}

/// O que o refinamento por categoria recebe sobre a aposta.
pub struct CategoryRefinement<'a> {
    pub bet_home: &'a str,
    pub bet_away: &'a str,
    pub bet_league: Option<&'a str>,
    /// Horário do post; `None` quando é só o dia.
    pub bet_kickoff_ms: Option<f64>,
    /// Falso quando o provider tem id de time (FlashScore).
    pub collapse_duplicate_listings: bool,
}

/// Os índices dos candidatos que ficam, na ordem do provider (ver
/// `refineCategoryCandidates` no TypeScript).
pub fn refine_category_candidates(
    bet: &CategoryRefinement<'_>,
    candidates: &[CategoryCandidateFixture],
) -> Vec<usize> {
    let without_base: Vec<usize> = (0..candidates.len())
        .filter(|i| {
            let fixture = &candidates[*i];
            !crate::team_category::is_base_category_fixture(
                &fixture.home,
                &fixture.away,
                fixture.league.as_deref(),
            )
        })
        .collect();
    let bet_declares = declares_category(bet.bet_home, bet.bet_away, bet.bet_league);
    let principals: Vec<&CategoryCandidateFixture> = without_base
        .iter()
        .map(|i| &candidates[*i])
        .filter(|f| !declares_category(&f.home, &f.away, f.league.as_deref()))
        .collect();
    let without_twins: Vec<usize> = if bet_declares {
        without_base
    } else {
        without_base
            .into_iter()
            .filter(|i| {
                let fixture = &candidates[*i];
                if !declares_category(&fixture.home, &fixture.away, fixture.league.as_deref()) {
                    return true;
                }
                let pair = pair_without_category(fixture);
                !principals.iter().any(|principal| {
                    pair_without_category(principal) == pair
                        && (principal.kickoff_ms - fixture.kickoff_ms).abs()
                            <= CATEGORY_TWIN_WINDOW_MS
                        && (!principal.swapped || fixture.swapped)
                        && bet.bet_kickoff_ms.is_none_or(|at| {
                            (principal.kickoff_ms - at).abs() <= (fixture.kickoff_ms - at).abs()
                        })
                })
            })
            .collect()
    };
    if !bet.collapse_duplicate_listings {
        return without_twins;
    }
    let mut kept: Vec<usize> = Vec::new();
    for i in without_twins {
        if kept
            .iter()
            .any(|k| same_listed_game(&candidates[*k], &candidates[i]))
        {
            continue;
        }
        kept.push(i);
    }
    kept
}

/// O caractere é `[\p{L}\p{N}]`.
fn is_letter_or_number(c: char) -> bool {
    let mut buffer = [0u8; 4];
    letter_or_number().is_match(c.encode_utf8(&mut buffer))
}

/// O "R"/"Res" de reserva do tipster do futebol argentino nos DOIS times vira
/// "Reserva" (ver o TypeScript). `None` quando nada muda (o TS devolve o
/// mesmo objeto).
pub fn mark_soccer_reserve_teams(evento: &str, selecao: &str) -> Option<(String, String)> {
    let (home, away) = split_evento_teams(evento)?;
    let marker = soccer_reserve_marker();
    if !marker.is_match(&home) || !marker.is_match(&away) {
        return None;
    }
    let marked_home = marker.replace(&home, " Reserva");
    let marked_away = marker.replace(&away, " Reserva");
    let mut names: Vec<(&str, &str)> = vec![(home.as_str(), marked_home.as_str())];
    if away != home {
        names.push((away.as_str(), marked_away.as_str()));
    }
    // O nome mais longo primeiro (ordenação estável): "Estudiantes R" não cai
    // dentro de "Estudiantes Rio Cuarto R".
    names.sort_by_key(|(name, _)| std::cmp::Reverse(utf16_len(name)));
    // `/(?<![\p{L}\p{N}])(nomes)(?![\p{L}\p{N}])/gu`, trocando cada nome pela forma marcada.
    let mut out = String::with_capacity(selecao.len() + 16);
    let mut previous: Option<char> = None;
    let mut position = 0;
    while position < selecao.len() {
        let rest = &selecao[position..];
        let boundary_before = previous.is_none_or(|c| !is_letter_or_number(c));
        let found = boundary_before
            .then(|| {
                names.iter().find(|(name, _)| {
                    rest.starts_with(name)
                        && rest[name.len()..]
                            .chars()
                            .next()
                            .is_none_or(|c| !is_letter_or_number(c))
                })
            })
            .flatten();
        if let Some((name, marked)) = found {
            out.push_str(marked);
            previous = name.chars().last();
            position += name.len();
            continue;
        }
        let Some(c) = rest.chars().next() else { break };
        out.push(c);
        previous = Some(c);
        position += c.len_utf8();
    }
    Some((format!("{marked_home} vs {marked_away}"), out))
}
