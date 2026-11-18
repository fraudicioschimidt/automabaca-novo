//! Classificação do mercado: o tipo (moneyline, total, handicap, BTTS…), o
//! período (jogo inteiro, 1º e 2º tempo, mapa) e as famílias que nenhum
//! placar resolve (outright, método da vitória, race to, handicap de 3 vias),
//! portado de `src/domain/mercados/classify.ts`. O roteamento de odds e a
//! liquidação leem daqui: se os dois divergissem, a aposta seria liquidável
//! mas sem CLV, ou o contrário.

use super::catalog::{mercado_key_of_normalized, normalize_mercado_key};
use super::draw_vocabulary::{double_chance_pattern, draw_no_bet_pattern};
use super::match_scope::MATCH_SCOPE_NOUNS;
use super::stat_qualifier::{SCORE_UNIT_RULES, selecao_declara_linha_de_estatistica};
use super::total_direction::{expand_abbreviated_direction, total_direction_of};
use super::trailing_side::{trailing_team_candidate, trailing_team_candidate_of_selection};
use crate::js;
use crate::settlement::sides::{Side, match_team_side};
use crate::sports::registry::canonical_sport;
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};
use std::collections::HashSet;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarketKind {
    Moneyline,
    Total,
    Spread,
    TeamTotal,
    DrawNoBet,
    DoubleChance,
    Btts,
    CorrectScore,
    Scorer,
    PlayerProps,
    Other,
}

impl MarketKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MarketKind::Moneyline => "moneyline",
            MarketKind::Total => "total",
            MarketKind::Spread => "spread",
            MarketKind::TeamTotal => "team_total",
            MarketKind::DrawNoBet => "draw_no_bet",
            MarketKind::DoubleChance => "double_chance",
            MarketKind::Btts => "btts",
            MarketKind::CorrectScore => "correct_score",
            MarketKind::Scorer => "scorer",
            MarketKind::PlayerProps => "player_props",
            MarketKind::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarketPeriod {
    Ft,
    Ht,
    SecondHalf,
    Map,
    Other,
}

impl MarketPeriod {
    pub fn as_str(self) -> &'static str {
        match self {
            MarketPeriod::Ft => "FT",
            MarketPeriod::Ht => "HT",
            MarketPeriod::SecondHalf => "SECOND_HALF",
            MarketPeriod::Map => "MAP",
            MarketPeriod::Other => "OTHER",
        }
    }
}

fn compiled(source: &str, flags: &str) -> Regex {
    Regex::cataloged(source, flags)
        .unwrap_or_else(|error| panic!("regex inválida /{source}/{flags}: {error}"))
}

/// O mercado normalizado uma vez: `market_kind_of` e `market_period_of`
/// perguntam dezenas de coisas ao mesmo rótulo.
struct Market {
    /// `normalize_str(mercado)`.
    text: String,
    /// `normalize_mercado_key(mercado)`.
    key: String,
    /// `half_aware_key(mercado)`.
    half_key: String,
}

impl Market {
    fn new(mercado: &str) -> Market {
        let text = normalize_str(mercado);
        let key = mercado_key_of_normalized(&text);
        let half_key = half_aware_key_given(mercado, &key);
        Market {
            text,
            key,
            half_key,
        }
    }
}

/// Frases de palavras inteiras numa chave de mercado (só `[a-z0-9]` e espaço
/// simples, sem espaço nas pontas). Ali, `\b(?:frase|…)\b` casa exatamente
/// quando uma janela de palavras da chave é uma das frases, porque toda frase
/// começa e termina em letra ou dígito. Sem regex, a pergunta é uma busca por
/// janela: as listas de meio-tempo, com 20 frases, eram o custo maior do
/// período no `regress` e, no navegador, uma ida ao `RegExp` por pergunta.
struct Phrases {
    phrases: HashSet<&'static str>,
    max_words: usize,
}

impl Phrases {
    fn new(list: impl IntoIterator<Item = &'static str>) -> Phrases {
        let phrases: HashSet<&'static str> = list.into_iter().collect();
        let max_words = phrases
            .iter()
            .map(|phrase| phrase.split(' ').count())
            .max()
            .unwrap_or(0);
        Phrases { phrases, max_words }
    }

    /// Onde cada palavra da chave começa e termina, em bytes.
    fn words(key: &str) -> Vec<(usize, usize)> {
        debug_assert!(!key.starts_with(' ') && !key.ends_with(' ') && !key.contains("  "));
        let mut words = Vec::new();
        let mut start = 0;
        for (at, byte) in key.bytes().enumerate() {
            if byte == b' ' {
                words.push((start, at));
                start = at + 1;
            }
        }
        if !key.is_empty() {
            words.push((start, key.len()));
        }
        words
    }

    fn window_from(&self, key: &str, words: &[(usize, usize)], first: usize) -> bool {
        words[first..]
            .iter()
            .take(self.max_words)
            .any(|(_, end)| self.phrases.contains(&key[words[first].0..*end]))
    }

    /// `\b(?:frases)\b` na chave.
    fn found_in(&self, key: &str) -> bool {
        let words = Phrases::words(key);
        (0..words.len()).any(|first| self.window_from(key, &words, first))
    }

    /// `^(?:frases)\b` na chave.
    fn starts(&self, key: &str) -> bool {
        let words = Phrases::words(key);
        !words.is_empty() && self.window_from(key, &words, 0)
    }
}

fn contains_any(key: &str, literals: &[&str]) -> bool {
    literals.iter().any(|literal| key.contains(literal))
}

fn has_nonzero_digit(key: &str) -> bool {
    key.bytes().any(|byte| (b'1'..=b'9').contains(&byte))
}

/// Unidade nomeada no mercado que autoriza ler o time na seleção como team
/// total: gol, escanteio, cartão e as unidades do placar de cada esporte.
static TEAM_TOTAL_NAMED_UNIT: LazyLock<Regex> = LazyLock::new(|| {
    let units: Vec<&str> = SCORE_UNIT_RULES
        .iter()
        .flat_map(|rule| rule.terms.iter().copied())
        .collect();
    compiled(
        &format!(
            r"\b(?:goals?|gols?|goal\s*line|corners?|cantos?|escanteios?|cards?|cartoes?|carteos?|bookings?|{})\b",
            units.join("|")
        ),
        "",
    )
});

/// `normalizeStr(esporte ?? "").replace(/\s+/g, "") === "esports"`.
pub fn is_esports(esporte: Option<&str>) -> bool {
    normalize_str(esporte.unwrap_or(""))
        .chars()
        .filter(|c| !js::is_whitespace(*c))
        .eq("esports".chars())
}

/// `Number(digits)` entre 1 e 9: zeros à esquerda contam ("01" é 1).
fn map_digit(digits: &str) -> Option<u32> {
    let significant = digits.trim_start_matches('0');
    match significant.len() {
        1 => significant.parse().ok(),
        _ => None,
    }
}

const MAP_ORDINAL: [(&str, u32); 20] = [
    ("primeiro", 1),
    ("primeira", 1),
    ("segundo", 2),
    ("segunda", 2),
    ("terceiro", 3),
    ("terceira", 3),
    ("quarto", 4),
    ("quarta", 4),
    ("quinto", 5),
    ("quinta", 5),
    ("1o", 1),
    ("1a", 1),
    ("2o", 2),
    ("2a", 2),
    ("3o", 3),
    ("3a", 3),
    ("4o", 4),
    ("4a", 4),
    ("5o", 5),
    ("5a", 5),
];

const MAP_ROMAN: [(&str, u32); 5] = [("i", 1), ("ii", 2), ("iii", 3), ("iv", 4), ("v", 5)];

fn lookup(table: &[(&str, u32)], key: &str) -> Option<u32> {
    table.iter().find(|(name, _)| *name == key).map(|(_, n)| *n)
}

/// Número do mapa em eSports (Map 1 / primeiro mapa). `None` = não é mercado
/// por mapa. O número do mapa permanece distinto do período do jogo inteiro.
pub fn market_map_number_of(mercado: &str, esporte: Option<&str>) -> Option<u32> {
    map_number_of_key(&normalize_mercado_key(mercado), esporte)
}

fn map_number_of_key(key: &str, esporte: Option<&str>) -> Option<u32> {
    if key.is_empty() {
        return None;
    }
    let group = |regex: &Regex| {
        regex
            .exec(key)
            .and_then(|found| found.get(1).map(str::to_owned))
    };
    // As cinco primeiras formas escrevem "map"/"mapa"; sem a palavra, nem rodam.
    if key.contains("map") {
        if let Some(digits) = group(map_numbered()) {
            return map_digit(&digits);
        }
        if let Some(roman) = group(map_roman()) {
            return lookup(&MAP_ROMAN, &roman);
        }
        // "1º mapa" vira "1 mapa" na chave (o º some).
        if let Some(digit) = group(map_digit_first()) {
            return map_digit(&digit);
        }
        if let Some(digit) = group(map_english_ordinal()) {
            return map_digit(&digit);
        }
        if let Some(ordinal) = group(map_ordinal_word()) {
            return lookup(&MAP_ORDINAL, &ordinal);
        }
    }
    if key.contains('m')
        && let Some(digit) = group(map_compact())
    {
        return map_digit(&digit);
    }
    // "Game/Jogo N" também nomeia mapa em eSports, mas não globalmente: em
    // tênis/beisebol é outra unidade e continua fail-closed.
    if is_esports(esporte)
        && let Some(digit) = group(esports_game_number())
    {
        return map_digit(&digit);
    }
    None
}

/// Qualificadores financeiros compartilhados pela captura e pelos contratos
/// de preço. A casca expõe as fontes como `RegExp` (o contrato da Pinnacle17
/// lê com `g`).
pub const EXTRA_TIME_PATTERN: &str = r"\bot included\b|\b(?:including|includes|incl|incluindo|inclui|incluir|inclusa|incluso|incluid[ao]|com)\.?\s+(?:ot|overtime|extra time|prorrogacao|prolongamento)\b";
pub const REGULATION_TIME_PATTERN: &str = r"\b1\s*x\s*2\b|\b(?:3|tres|three)[\s-]*(?:vias?|way)\b|\btempo\s+(?:regular|regulamentar|normal)\b|\bregulamentar\b|\bregular\s+time\b|\bregulation(?:\s+time)?\b|\(\s*tr\s*\)";

static EXTRA_TIME: LazyLock<Regex> = LazyLock::new(|| compiled(EXTRA_TIME_PATTERN, ""));
static REGULATION_TIME: LazyLock<Regex> = LazyLock::new(|| compiled(REGULATION_TIME_PATTERN, ""));

/// Declaração explícita de que a prorrogação conta no resultado.
pub fn market_includes_extra_time(mercado: &str) -> bool {
    extra_time_in_key(&normalize_mercado_key(mercado))
}

/// Toda forma de `EXTRA_TIME_PATTERN` termina numa destas palavras (ou em
/// "ot included"); sem nenhuma, a regex nem roda.
fn extra_time_in_key(key: &str) -> bool {
    contains_any(
        key,
        &[
            "ot",
            "overtime",
            "extra time",
            "prorrogacao",
            "prolongamento",
        ],
    ) && EXTRA_TIME.is_match(key)
}

/// Lê antes da normalização de mercado, que apaga os parênteses de "(TR)".
pub fn declares_regulation_time(text: &str) -> bool {
    !market_includes_extra_time(text) && REGULATION_TIME.is_match(&normalize_str(text))
}

/// Vocabulário ÚNICO de "ambas marcam": duas listas para a mesma pergunta já
/// divergiram, e a grafia ficava precificável mas não liquidável.
const BTTS_MARKET: &str = r"\bboth teams to score\b|\bboth score\b|\bbtts\b|\bambas (?:as )?equipes marcam\b|\bambas marcam\b|\bambos marcam\b|\bambas as equipes marcarao\b|\bambos os times marcarao\b|\bpara ambos marcarem\b|\bgol gol\b";

static BTTS_MARKET_RE: LazyLock<Regex> = LazyLock::new(|| compiled(BTTS_MARKET, ""));
/// As frases de BTTS de um texto, para apagar todas e ler o que sobra.
static BTTS_MARKET_ALL: LazyLock<Regex> = LazyLock::new(|| compiled(BTTS_MARKET, "g"));

fn btts_residue_names_market() -> &'static Regex {
    regex!(
        r"\b(?:1x2|resultado|result|winner|vencedor|vencedora|vence|vencer|venca|win|wins|ganha|ganhador|empate|draw|over|under|mais|menos|acima|abaixo|total|totais|handicap|spread|escanteios?|corners?|cartoes|carteos|cards?)\b",
        ""
    )
}

pub fn is_btts_market(mercado: &str) -> bool {
    btts_in_key(&normalize_mercado_key(mercado))
}

/// Toda grafia de "ambas marcam" escreve uma destas palavras.
fn btts_in_key(key: &str) -> bool {
    contains_any(key, &["both", "btts", "ambas", "ambos", "gol gol"])
        && BTTS_MARKET_RE.is_match(key)
}

/// O pedido em CADA tempo ("nos dois tempos", "both halves", "1º e 2º
/// tempo"): nenhum placar sozinho responde.
fn each_half() -> &'static Regex {
    regex!(
        r"\b(?:(?:dois|2|ambos(?: os)?|os dois) tempos|cada tempo|(?:duas|2|ambas(?: as)?) (?:etapas|metades)|cada etapa|(?:both|two|2) halves|each half)\b",
        ""
    )
}

fn both_halves_elided() -> &'static Regex {
    regex!(
        r"\b(?:1|1o|1a|1st|primeir[oa]|first) (?:e|and) (?:(?:no|na|o|a|the) )?(?:(?:2|2o|2a|2nd|segund[oa]|second) (?:tempos?|etapas?|partes?|metades?|halves|half)|2t)\b|\bpt (?:e )?st\b",
        ""
    )
}

/// `each_half` ou `both_halves_elided` numa busca só (para `is_match`, a
/// união de duas alternâncias é exata).
static EACH_OR_BOTH_HALVES: LazyLock<Regex> =
    LazyLock::new(|| union(&[each_half(), both_halves_elided()]));

fn names_both_halves(key: &str) -> bool {
    // Toda forma de "cada tempo" escreve uma destas raízes.
    (contains_any(
        key,
        &["temp", "etap", "part", "metad", "half", "halv", "2t", "pt"],
    ) && EACH_OR_BOTH_HALVES.is_match(key))
        || (FIRST_HALF.found_in(key) && SECOND_HALF.found_in(key))
}

/// O texto pede os DOIS tempos ("nos dois tempos", "Both Halves", "1º e 2º tempo").
pub fn market_names_both_halves(text: &str) -> bool {
    names_both_halves(&half_aware_key(text))
}

/// BTTS COMBINADO com outra perna ("Casa vence e ambas marcam"): exige as
/// duas condições, e resolver só a de BTTS pagaria ignorando a outra. A
/// detecção é por resíduo: apaga a frase de BTTS e pergunta se o que sobrou
/// ainda nomeia um mercado. O BTTS em cada tempo também exige duas condições.
pub fn is_combined_btts_market(mercado: &str) -> bool {
    combined_btts_key(&half_aware_key(mercado))
}

fn combined_btts_key(key: &str) -> bool {
    if !btts_in_key(key) {
        return false;
    }
    if names_both_halves(key) {
        return true;
    }
    btts_residue_names_market().is_match(&BTTS_MARKET_ALL.replace(key, " "))
}

/// "no" é preposição colado ao verbo ("Ambas marcam no 1º tempo") ou antes do
/// nome do jogo ("Gol/Gol no jogo"); em qualquer outro lugar é o Não. "match"
/// fica fora dos nomes do jogo: "BTTS No Match" é o Não em inglês.
fn btts_verb_preposition() -> &'static Regex {
    regex!(
        r"\b(marca(?:m|r|rem|rao)?(?:\s+gols?)?)\s+no(?=\s+[a-z0-9])",
        "g"
    )
}

static MATCH_SCOPE_PREPOSITION: LazyLock<Regex> = LazyLock::new(|| {
    let nouns: Vec<&str> = MATCH_SCOPE_NOUNS
        .iter()
        .copied()
        .filter(|noun| *noun != "match")
        .collect();
    compiled(&format!(r"\bno(?=\s+(?:{})\b)", nouns.join("|")), "g")
});

/// Antes de um tempo e longe do verbo, o "no" pode ser um ou outro ("Gol/Gol
/// no 1T" é o Sim; "BTTS No 1T" pode ser o Não). Só o espaço separa os dois;
/// roda sobre o texto que ainda tem a pontuação.
fn is_no_before_half(text: &str) -> bool {
    no_before_word()
        .exec_all(text)
        .iter()
        .any(|found| HALF_AT_START.starts(&half_aware_key(&text[found.end()..])))
}

/// O "No" maiúsculo colado ao verbo e antes de um tempo ("Ambas marcam No
/// FT") pode ser o Não da casa ou a preposição. Lê a grafia original, que a
/// chave minúscula apaga. Como no TS, o índice do casamento no texto
/// minúsculo é lido no texto original, em unidades UTF-16.
fn is_capital_no_after_verb_before_half(selecao: &str) -> bool {
    let text = js_text::without_diacritics(selecao);
    let lower = js_text::to_lower_case(&text);
    let text_units: Vec<u16> = text.encode_utf16().collect();
    btts_verb_preposition()
        .exec_all(&lower)
        .iter()
        .any(|found| {
            let end = found.index() + found.get(0).unwrap_or("").encode_utf16().count();
            if end < 2 || text_units.get(end - 2) != Some(&u16::from(b'N')) {
                return false;
            }
            let after = lower[found.end()..].trim_start_matches(js::is_whitespace);
            full_time_at_start().is_match(after) || HALF_AT_START.starts(&half_aware_key(after))
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BttsSide {
    Yes,
    No,
}

impl BttsSide {
    pub fn as_str(self) -> &'static str {
        match self {
            BttsSide::Yes => "yes",
            BttsSide::No => "no",
        }
    }
}

/// Lado da seleção de "ambas marcam", o mesmo na captura (Sim/Não) e na
/// liquidação. Sim junto com negação, o BTTS combinado ou em cada tempo, o
/// "no" que pode ser preposição e a frase com qualificador desconhecido não
/// decidem (`None`).
pub fn btts_selection_side(selecao: &str) -> Option<BttsSide> {
    if is_capital_no_after_verb_before_half(selecao) {
        return None;
    }
    // As preposições saem antes da chave, que apagaria o hífen de "Marcam - No".
    let normalized = normalize_str(selecao);
    let without_verb = btts_verb_preposition().replace(&normalized, "$1");
    let text = MATCH_SCOPE_PREPOSITION.replace(&without_verb, " ");
    let key = half_aware_key(&text);
    if key.is_empty() || is_combined_btts_market(&key) || names_both_halves(&key) {
        return None;
    }
    let spelled_no = btts_spelled_no().is_match(&key);
    let bare_no = btts_bare_no().is_match(&key);
    if bare_no && !spelled_no && is_no_before_half(&text) {
        return None;
    }
    let affirmed = btts_affirmed().is_match(&key);
    if spelled_no || bare_no {
        return (!affirmed).then_some(BttsSide::No);
    }
    let alone = affirmed || btts_subject_alone().is_match(&key) || btts_phrase_alone(&key);
    alone.then_some(BttsSide::Yes)
}

/// Sem Sim escrito, a frase só vale como Sim acompanhada do escopo ("no
/// jogo") ou de um tempo só; qualquer outra sobra pode mudar o mercado.
fn btts_phrase_alone(key: &str) -> bool {
    if !BTTS_MARKET_RE.is_match(key) {
        return false;
    }
    let without_phrase = BTTS_MARKET_ALL.replace(key, " ");
    js::trim(&BTTS_FILLER.replace(&without_phrase, " ")).is_empty()
}

/// "Race to N" / "Primeiro a N": quem CHEGA primeiro à marca, com void quando
/// ninguém chega. Não é over/under do agregado; não há resolver, falha fechado.
pub fn is_race_to_market(mercado: &str, selecao: &str) -> bool {
    RACE_TO.found_in(&normalize_mercado_key(&format!("{mercado} {selecao}")))
}

static RACE_TO: LazyLock<Phrases> = LazyLock::new(|| {
    Phrases::new([
        "race to",
        "first to",
        "primeiro a",
        "corrida ate",
        "corrida a",
    ])
});

/// Handicap de três vias/europeu não compartilha a mecânica asiática de push.
pub fn is_three_way_handicap_market(mercado: &str) -> bool {
    let text = normalize_str(mercado);
    three_way_handicap(&mercado_key_of_normalized(&text), &text)
}

fn three_way_handicap(key: &str, text: &str) -> bool {
    // As duas formas escrevem "handicap".
    if !key.contains("handicap") {
        return false;
    }
    let has_score_notation = score_notation().is_match(text);
    (handicap_word().is_match(key)
        // `europeo` (ES) junto de `europeu`/`european`: sem ele o europeu em
        // espanhol era asiático, e a cobertura exata virava PUSH/VOID.
        && (three_way_qualifier().is_match(key) || has_score_notation))
        || handicap_result().is_match(key)
}

/// Escopo de outright: o que se vence NÃO é a partida. Dado, porque o filtro
/// SQL precisa da mesma lista. O prêmio ("título", "taça", "copa"), a fase e
/// a temporada também nomeiam o escopo; em EN o escopo vem antes de "winner".
pub const OUTRIGHT_SCOPE_NOUNS: &[&str] = &[
    "torneio",
    "campeonato",
    "grupo",
    "trofeu",
    "competicao",
    "liga",
    "serie",
    "titulo",
    "taca",
    "copa",
    "fase",
    "premio",
    "medalha",
    "temporada",
    "qualificacao",
    "group stage",
    "group",
    "season",
    "conference",
    "playoff",
    "playoffs",
    "division",
    "tournament",
    "championship",
    "cup",
    "trophy",
    "title",
    "medal",
    "qualification",
    "qualifier",
];

pub const OUTRIGHT_WINNER_PHRASES: &[&str] = &[
    "quem vence",
    "quem ganha",
    "quem leva",
    "vencedor",
    "vencedora",
    "ganhador",
    "ganhadora",
    "campeao",
    "campea",
    "para vencer",
    "para ganhar",
    "to win the",
    "to lift",
    "winner",
];

/// A ordem EN (escopo antes do verbo) e a PT (com preposição) leem a mesma lista.
static OUTRIGHT_MARKET: LazyLock<Regex> = LazyLock::new(|| {
    let scope = OUTRIGHT_SCOPE_NOUNS.join("|");
    compiled(
        &format!(
            r"\b(?:outrights?|futures?|to\s+lift|to\s+win\s+the|(?:{scope})\s+winners?|winner\s+of\s+the\s+(?:{scope})|campe(?:ao|a|oes|as)|vencedor(?:a)?\s+final|(?:vencedor(?:a)?|ganhador(?:a)?|campe(?:ao|a))\s+d[oa]\s+(?:{scope})|para\s+(?:vencer|ganhar)\s+(?:(?:o|a)\s+)?(?:{scope})|quem\s+(?:vencera|vence|ganhara|ganha|leva)\s+(?:(?:o|a)\s+)?(?:{scope}))\b"
        ),
        "",
    )
});

/// Outrights/futures não representam o vencedor da partida corrente.
pub fn is_outright_market(mercado: &str) -> bool {
    outright_in_key(&normalize_mercado_key(mercado))
}

/// Toda forma de outright escreve uma destas palavras.
fn outright_in_key(key: &str) -> bool {
    contains_any(
        key,
        &[
            "outright", "future", "lift", "win", "campe", "vencedor", "ganhador", "para ", "quem ",
        ],
    ) && OUTRIGHT_MARKET.is_match(key)
}

/// Método da vitória não equivale ao vencedor da partida.
pub fn is_method_of_victory_market(mercado: &str) -> bool {
    method_of_victory_in_key(&normalize_mercado_key(mercado))
}

/// Toda forma de método da vitória escreve uma destas palavras.
fn method_of_victory_in_key(key: &str) -> bool {
    contains_any(
        key,
        &[
            "ko",
            "submission",
            "decision",
            "metodo",
            "method",
            "por ",
            "forma ",
            "modo ",
            "tipo ",
            "como ",
        ],
    ) && method_of_victory().is_match(key)
}

static DRAW_NO_BET_MARKET: LazyLock<Regex> =
    LazyLock::new(|| compiled(&format!(r"\b{}\b", draw_no_bet_pattern(" ")), ""));
static DOUBLE_CHANCE_MARKET: LazyLock<Regex> =
    LazyLock::new(|| compiled(&format!(r"\b{}\b", double_chance_pattern(" ")), ""));

/// Vocabulário único de Draw No Bet (dados em `draw_vocabulary`).
pub fn is_draw_no_bet_market(mercado: &str) -> bool {
    draw_no_bet_in_key(&normalize_mercado_key(mercado))
}

/// Toda grafia do vocabulário de DNB escreve "empate", "no bet" ou "dnb".
fn draw_no_bet_in_key(key: &str) -> bool {
    contains_any(key, &["empate", "no bet", "dnb"]) && DRAW_NO_BET_MARKET.is_match(key)
}

/// Vocabulário único de Dupla Chance, incluindo siglas e rótulos legados.
pub fn is_double_chance_market(mercado: &str) -> bool {
    double_chance_in_key(&normalize_mercado_key(mercado))
}

/// Toda grafia do vocabulário de Dupla Chance escreve uma destas palavras.
fn double_chance_in_key(key: &str) -> bool {
    contains_any(key, &["double chance", "dc", "dupla"]) && DOUBLE_CHANCE_MARKET.is_match(key)
}

/// Lado do evento que o RÓTULO de um total nomeia ("Total de Gols do Vasco",
/// "Total Gols Time Visitante"). A seleção é só "Over 1.5": lido como total
/// do jogo, o placar somado pagaria a aposta no time que não marcou.
pub fn total_label_side(mercado: &str, evento: &str) -> Option<Side> {
    total_label_side_key(&normalize_mercado_key(mercado), evento)
}

fn total_label_side_key(key: &str, evento: &str) -> Option<Side> {
    if !total_label().is_match(key) || handicap_label().is_match(key) {
        return None;
    }
    let without_label = total_label_words().replace(key, " ");
    let named = trailing_team_candidate(&without_label).filter(|named| !named.is_empty())?;
    match_team_side(&named, evento)
}

/// Team total no mercado ("Home Total Goals") ou na seleção ("Total Goals" +
/// "Flamengo Over 1.5"). Fonte única de settlement e coverage. Sem o evento,
/// só a forma com PREFIXO é team total.
pub fn is_team_total_market(mercado: &str, selecao: &str, evento: Option<&str>) -> bool {
    team_total_key(&normalize_mercado_key(mercado), selecao, evento)
}

/// Os rótulos de team total no mercado, numa busca só: os pontos ou corridas
/// "do time", "team total", o total do lado ("Total Home"), o lado e o total
/// ("Home Total Goals") e o lado com a unidade sem `total` ("Home Team
/// Goals", a grafia comum da casa).
static TEAM_TOTAL_LABELED: LazyLock<Regex> = LazyLock::new(|| {
    union(&[
        team_points_label(),
        team_total_label(),
        total_of_side(),
        side_total(),
        side_goals(),
    ])
});

fn team_total_key(market_key: &str, selecao: &str, evento: Option<&str>) -> bool {
    let evento = evento.filter(|evento| !evento.is_empty());
    // Todo rótulo de team total escreve uma destas palavras.
    if contains_any(
        market_key,
        &[
            "time",
            "equipe",
            "team",
            "total",
            "home",
            "away",
            "casa",
            "fora",
            "mandante",
            "visitante",
        ],
    ) && TEAM_TOTAL_LABELED.is_match(market_key)
    {
        return true;
    }
    if let Some(evento) = evento
        && total_label_side_key(market_key, evento).is_some()
    {
        return true;
    }
    // Só uma variante com unidade explícita autoriza inferir pelo nome na
    // seleção: `Total` canônico pode carregar o time como ruído legado.
    if !contains_any(
        market_key,
        &[
            "goal",
            "gol",
            "corner",
            "canto",
            "escanteio",
            "card",
            "carto",
            "carteo",
            "booking",
            "run",
            "corrida",
            "point",
            "ponto",
        ],
    ) || !TEAM_TOTAL_NAMED_UNIT.is_match(market_key)
    {
        return false;
    }
    // "Flamengo O 4.5" nomeia o time como "Flamengo Over 4.5".
    let expanded = expand_abbreviated_direction(selecao);
    let selection_key = normalize_mercado_key(&expanded);
    let named_before_direction = named_before_direction()
        .exec(&selection_key)
        .and_then(|found| found.get(1).map(|named| js::trim(named).to_owned()));
    if let Some(named) = named_before_direction
        && !named.is_empty()
        && named.bytes().any(|byte| byte.is_ascii_lowercase())
        // "Cartões Amarelos Over 1.5" nomeia uma subfamília, não um time.
        && !selecao_declara_linha_de_estatistica(&expanded)
    {
        return true;
    }
    // O time também vem DEPOIS da linha ("Over 1.5 Gols do Flamengo"); sem o
    // evento não dá para separar o nome do ruído de unidade e período.
    let Some(evento) = evento else {
        return false;
    };
    trailing_team_candidate_of_selection(selecao)
        .filter(|trailing| !trailing.is_empty())
        .is_some_and(|trailing| match_team_side(&trailing, evento).is_some())
}

/// Combo que exige OS DOIS placares (intervalo E final). Testado ANTES do
/// vocabulário de meio-tempo, senão "Resultado Intervalo/Final" seria HT.
fn combo_ht_ft() -> &'static Regex {
    regex!(
        r"\b(?:half\s*time\s*full\s*time|ht\s*ft|h5\s*ft|intervalo\s*(?:e\s*)?final|resultado\s+duplo|(?:1t|1o tempo|primeiro tempo|1st half|half time|first half)\s*(?:e|\/)?\s*(?:final|full\s*time|ft)\b)",
        ""
    )
}

/// Frases de meio-tempo, como DADO: o filtro SQL precisa das mesmas. As
/// siglas ficam à parte porque exigem limite de token, e no SQL têm filtro
/// próprio. "1ª Parte" e "1ª Etapa" perdem o ordinal na normalização, por
/// isso "1 parte" e "1 etapa".
pub const HALF_PERIOD_PHRASES_FIRST: &[&str] = &[
    "1st half",
    "first half",
    "half time",
    "halftime",
    "1o tempo",
    "1 tempo",
    "primeiro tempo",
    "intervalo",
    "meio tempo",
    "1 parte",
    "primeira parte",
    "1 etapa",
    "1a etapa",
    "primeira etapa",
    "primeira metade",
    "1 metade",
];
pub const HALF_PERIOD_PHRASES_SECOND: &[&str] = &[
    "2nd half",
    "second half",
    "2o tempo",
    "2 tempo",
    "segundo tempo",
    "2 parte",
    "segunda parte",
    "2 etapa",
    "2a etapa",
    "segunda etapa",
    "segunda metade",
    "2 metade",
];
/// Siglas compactas de meio-tempo, fora das frases porque o espelho SQL
/// gera `contains` da frase: "1t" como substring pegaria lixo.
pub const HALF_PERIOD_ABBREVIATIONS_FIRST: &[&str] = &["ht", "h1", "1h", "fh", "1t"];
pub const HALF_PERIOD_ABBREVIATIONS_SECOND: &[&str] = &["h2", "2h", "sh", "2t"];

fn first_half_terms() -> Vec<&'static str> {
    [HALF_PERIOD_PHRASES_FIRST, HALF_PERIOD_ABBREVIATIONS_FIRST].concat()
}

fn second_half_terms() -> Vec<&'static str> {
    [HALF_PERIOD_PHRASES_SECOND, HALF_PERIOD_ABBREVIATIONS_SECOND].concat()
}

static FIRST_HALF: LazyLock<Phrases> = LazyLock::new(|| Phrases::new(first_half_terms()));
static SECOND_HALF: LazyLock<Phrases> = LazyLock::new(|| Phrases::new(second_half_terms()));
/// Um tempo no começo da chave; "tempo" sozinho ("no tempo regulamentar") conta.
static HALF_AT_START: LazyLock<Phrases> = LazyLock::new(|| {
    Phrases::new(
        std::iter::once("tempo")
            .chain(first_half_terms())
            .chain(second_half_terms()),
    )
});
/// O que pode acompanhar a frase de BTTS sem mudar o mercado (`btts_phrase_alone`).
static BTTS_FILLER: LazyLock<Regex> = LazyLock::new(|| {
    let mut terms: Vec<&str> = MATCH_SCOPE_NOUNS.to_vec();
    terms.extend(["no", "na", "em", "o", "a", "in", "the", "ft", "full time"]);
    terms.extend(HALF_PERIOD_PHRASES_FIRST);
    terms.extend(HALF_PERIOD_PHRASES_SECOND);
    terms.extend(HALF_PERIOD_ABBREVIATIONS_FIRST);
    terms.extend(HALF_PERIOD_ABBREVIATIONS_SECOND);
    compiled(&format!(r"\b(?:{})\b", terms.join("|")), "g")
});

/// Chave de mercado que lê a sigla do tempo: o ordinal colado de "1ºT" vira
/// espaço na chave ("1 t") e não casaria "1t"; cola antes de normalizar.
fn half_aware_key(text: &str) -> String {
    normalize_mercado_key(&ordinal_half_abbreviation().replace(text, "$1t"))
}

/// `half_aware_key` de quem já tem a chave: sem `º`, `ª` ou `°` no texto, a
/// troca não acontece e a chave é a mesma.
fn half_aware_key_given(text: &str, key: &str) -> String {
    if text.contains(['º', 'ª', '°']) {
        half_aware_key(text)
    } else {
        key.to_owned()
    }
}

/// "PT"/"ST" só valem logo depois da linha, no fim do texto ("Over 0.5 PT"):
/// em qualquer posição, o "St" de St Pauli viraria segundo tempo.
fn trailing_first_half() -> &'static Regex {
    regex!(r"\b\d+\s+(?:gols?\s+)?pt$", "")
}

fn trailing_second_half() -> &'static Regex {
    regex!(r"\b\d+\s+(?:gols?\s+)?st$", "")
}

/// Em esporte jogado em dois tempos as siglas soltas PT/ST são o 1º e o 2º
/// tempo; em outro, não se presumem ("Over 110.5 PT" no basquete pode ser de
/// pontos). Esporte que o registro não conhece vale como no futebol.
fn reads_trailing_half_abbreviation(esporte: Option<&str>) -> bool {
    match canonical_sport(esporte.unwrap_or("")) {
        None => true,
        Some(sport) => matches!(sport, "Soccer" | "Futsal" | "Handball"),
    }
}

/// Janela de minutos ("0-10 min", "até 15 min") não é tempo nenhum.
/// `minutos` antes de `min`, senão o `\b` do fim cairia dentro da palavra.
fn minute_window() -> &'static Regex {
    regex!(r"\b\d{1,3}\s*(?:minutos?|minutes?|mins?|min)\b", "")
}

/// Regulamentar, prorrogação e pênaltis sem placar próprio da fase ("AET" é
/// ambíguo entre o período e o agregado: quem quer o agregado escreve
/// "incluindo", lido antes). Lista de palavras inteiras.
static REGULATION_OR_EXTRA_TIME: LazyLock<Phrases> = LazyLock::new(|| {
    Phrases::new([
        "regulation",
        "tempo regulamentar",
        "extra time",
        "overtime",
        "prorrogacao",
        "prolongamento",
        "penalti",
        "penaltis",
        "penalties",
        "penalty",
        "shootout",
        "shoot out",
        "disputa de penaltis",
        "aet",
        "et",
        "ot",
        "pen",
        "so",
    ])
});

/// O período não tem placar próprio da fase: o combo intervalo/final (antes
/// do vocabulário de meio-tempo, senão seria HT), a janela de minutos, o
/// regulamentar, a prorrogação e os pênaltis, quartos, períodos e innings.
/// Cada regex só roda se a chave tem o literal que todas as formas dela
/// escrevem.
fn partial_phase(key: &str) -> bool {
    (contains_any(key, &["ft", "final", "full", "duplo"]) && combo_ht_ft().is_match(key))
        || (key.contains("min") && minute_window().is_match(key))
        || REGULATION_OR_EXTRA_TIME.found_in(key)
        || (contains_any(key, &["q", "p"]) && quarter_or_period().is_match(key))
        || (has_nonzero_digit(key) && inning().is_match(key))
}

/// Unidade interna do jogo, numa busca só: o vencedor do set, round, frame ou
/// leg (`game winner` em inglês fica de fora: nos esportes americanos "game"
/// é a partida; em PT, "Vencedor do Game" é a unidade do tênis), o pistol
/// round e as unidades numeradas.
static INNER_UNIT: LazyLock<Regex> = LazyLock::new(|| {
    union(&[
        unit_winner(),
        unit_winner_pt(),
        round_inside_map(),
        numbered_unit(),
    ])
});

/// A união de regexes sem flags: exata para `is_match`, porque casa onde
/// qualquer uma das partes casaria.
fn union(parts: &[&Regex]) -> Regex {
    let sources: Vec<String> = parts
        .iter()
        .map(|regex| format!("(?:{})", regex.source()))
        .collect();
    compiled(&sources.join("|"), "")
}

pub fn market_period_of(mercado: &str, esporte: Option<&str>) -> MarketPeriod {
    period_of(&Market::new(mercado), esporte)
}

fn period_of(market: &Market, esporte: Option<&str>) -> MarketPeriod {
    let key = market.half_key.as_str();
    // Cada tempo não tem placar próprio, nem com a prorrogação declarada.
    if names_both_halves(key) {
        return MarketPeriod::Other;
    }
    // Quem DECLARA incluir a prorrogação usa o placar final; vem antes do
    // bloqueio de "overtime/extra time".
    if extra_time_in_key(&market.key) {
        return MarketPeriod::Ft;
    }
    if partial_phase(key) {
        return MarketPeriod::Other;
    }
    // Game/Jogo N só é mapa quando o contexto confirma eSports.
    if has_nonzero_digit(key) && game_number().is_match(key) {
        return if map_number_of_key(&market.key, esporte).is_none() {
            MarketPeriod::Other
        } else {
            MarketPeriod::Map
        };
    }
    // Toda forma de unidade interna escreve uma destas palavras ou um dígito.
    if (has_nonzero_digit(key)
        || contains_any(key, &["winner", "vencedor", "ganhador", "pistol", "round"]))
        && INNER_UNIT.is_match(key)
    {
        return MarketPeriod::Other;
    }
    // "1º Tempo" vira "1 tempo" na chave; sem essa forma o 1º tempo seria
    // liquidado pelo placar de 90 minutos. As siglas PT/ST só valem no fim do
    // texto: sem o texto terminar nelas, as regexes nem rodam.
    let trailing_first = key.ends_with("pt") && trailing_first_half().is_match(key);
    let trailing_second = key.ends_with("st") && trailing_second_half().is_match(key);
    let trailing_half = reads_trailing_half_abbreviation(esporte);
    if SECOND_HALF.found_in(key) || (trailing_half && trailing_second) {
        return MarketPeriod::SecondHalf;
    }
    if FIRST_HALF.found_in(key) || (trailing_half && trailing_first) {
        return MarketPeriod::Ht;
    }
    if trailing_first || trailing_second {
        return MarketPeriod::Other;
    }
    if map_number_of_key(&market.key, esporte).is_some() {
        return MarketPeriod::Map;
    }
    if key.bytes().any(|byte| byte.is_ascii_digit()) && map_or_set_number().is_match(key) {
        return MarketPeriod::Other;
    }
    MarketPeriod::Ft
}

/// `full time result` e `resultado` nu são moneyline também aqui, como na
/// liquidação, senão a aposta ficaria sem CLV. O termo amplo é seguro porque
/// `market_kind_of` o lê depois de outright, placar exato, DNB, dupla chance,
/// team total e handicap.
static MONEYLINE_MARKET: LazyLock<Regex> = LazyLock::new(|| {
    let scope = MATCH_SCOPE_NOUNS.join("|");
    compiled(
        &format!(
            r"\b(moneyline|money line|match winner|winner|vencedor|1x2|ml)\b|^half time result$|\b(?:full time result|resultado)\b|\bganhador(?:a)? d[oa] (?:{scope})\b|\bpara (?:vencer|ganhar) (?:[oa] )?(?:{scope})\b|\bquem (?:vencera|vence|ganhara|ganha)\b"
        ),
        "",
    )
});

fn scorer_market() -> &'static Regex {
    regex!(
        r"\b(?:goalscorer|anytime|marcador|artilheiro|marcar a qualquer momento|para marcar a qualquer momento|to score anytime|primeiro a marcar|primeiro marcador|primeiro gol|1o?\s*gol|1o?\s*marcador|any\s*1o?\s*gol|ultimo a marcar|ultimo marcador|ultimo gol|last goalscorer|first goalscorer|marcar 2 ou mais gols|to score 2 or more goals)\b",
        ""
    )
}

/// N+ gols do jogador, lido no texto com o "+", que a chave apaga: "Mais de 2
/// gols" sem "+" é total de gols.
fn player_goals_market(raw: &str) -> bool {
    player_goals_plus().is_match(raw)
        || player_goals_phrase().is_match(raw)
        || player_goals_word().is_match(raw)
}

fn player_props_market(key: &str) -> bool {
    if key.contains("player") && player_stat_prop().is_match(key) {
        return true;
    }
    // Toda forma das três famílias escreve uma destas palavras ("p a r" vem
    // com ou sem os espaços).
    !team_total_word().is_match(key)
        && contains_any(
            key,
            &[
                "player", "kill", "death", "abate", "morte", "shot", "chute", "pra", "par",
                "p a r", "p ar", "pa r", "ponto", "rebote", "assist",
            ],
        )
        && PLAYER_PROP_FAMILIES.is_match(key)
}

/// As props de kills e mortes, chutes e assistências, e pontos, rebotes e
/// assistências, numa busca só.
static PLAYER_PROP_FAMILIES: LazyLock<Regex> = LazyLock::new(|| {
    union(&[
        kills_deaths_prop(),
        shots_assists_prop(),
        points_rebounds_assists_prop(),
    ])
});

/// O tipo do mercado. `evento` só amplia: sem ele o team total é reconhecido
/// apenas na forma com PREFIXO; com ele, a forma com SUFIXO ("Total Goals" +
/// "Over 1.5 Flamengo") também, como na liquidação.
pub fn market_kind_of(mercado: &str, selecao: &str, evento: Option<&str>) -> MarketKind {
    let market = Market::new(mercado);
    let key = market.key.as_str();
    if key.is_empty() || outright_in_key(key) || method_of_victory_in_key(key) {
        return MarketKind::Other;
    }
    // Combo (resultado ∧ ambas marcam) não é BTTS nem tem resolver.
    if combined_btts_key(&market.half_key) {
        return MarketKind::Other;
    }
    if btts_in_key(key) {
        return MarketKind::Btts;
    }
    if is_race_to_market(mercado, selecao) {
        return MarketKind::Other;
    }
    if CORRECT_SCORE.found_in(key) {
        return MarketKind::CorrectScore;
    }
    // Toda forma de artilheiro escreve uma destas palavras; o N+ gols do
    // jogador, um "+" ou uma destas.
    if (contains_any(
        key,
        &[
            "gol",
            "goalscorer",
            "anytime",
            "marca",
            "artilheiro",
            "score",
        ],
    ) && scorer_market().is_match(key))
        || (contains_any(
            &market.text,
            &["+", "to score", "marcar", "hat", "brace", "bis"],
        ) && player_goals_market(&market.text))
    {
        return MarketKind::Scorer;
    }
    if player_props_market(key) {
        return MarketKind::PlayerProps;
    }
    if draw_no_bet_in_key(key) {
        return MarketKind::DrawNoBet;
    }
    if double_chance_in_key(key) {
        return MarketKind::DoubleChance;
    }
    if team_total_key(key, selecao, evento) {
        return MarketKind::TeamTotal;
    }
    // Handicap europeu é de 3 vias, não spread asiático.
    if three_way_handicap(key, &market.text) {
        return MarketKind::Other;
    }
    if contains_any(key, &["handicap", "spread", "ah", "line"]) && spread_market().is_match(key) {
        return MarketKind::Spread;
    }
    if contains_any(
        key,
        &[
            "money", "winner", "vencedor", "1x2", "ml", "result", "ganhador", "para ", "quem ",
        ],
    ) && MONEYLINE_MARKET.is_match(key)
    {
        // Mercado genérico "Moneyline" com a semântica DNB só na seleção
        // ("Time DNB"): a seleção prevalece só aqui, depois de excluir os
        // mercados explícitos.
        return if is_draw_no_bet_market(selecao) {
            MarketKind::DrawNoBet
        } else {
            MarketKind::Moneyline
        };
    }
    // A estatística no mercado e a direção só na seleção ("Abates - Mapa 1" +
    // "Over 25.5"); restrito a kills, para prop desconhecida não virar total.
    if contains_any(key, &["kill", "abate"])
        && kills_word().is_match(key)
        && total_direction_of(selecao, false).is_some()
    {
        return MarketKind::Total;
    }
    // "Goal Line"/"Linha de Gols" é a notação asiática do total.
    if contains_any(
        key,
        &[
            "total", "totais", "o u", "over", "under", "mais", "menos", "acima", "goal", "linha",
        ],
    ) && TOTAL_OR_GOAL_LINE.is_match(key)
    {
        return MarketKind::Total;
    }
    MarketKind::Other
}

static CORRECT_SCORE: LazyLock<Phrases> =
    LazyLock::new(|| Phrases::new(["correct score", "placar exato", "resultado exato"]));

static TOTAL_OR_GOAL_LINE: LazyLock<Regex> =
    LazyLock::new(|| union(&[total_market(), goal_line_market()]));

// As regexes usadas dentro das funções acima, uma por nome, para o
// catálogo comparado com o V8 ter todas sem depender de qual ramo rodou.

fn map_numbered() -> &'static Regex {
    regex!(r"\b(?:map|mapa)\s*(\d+)\b", "")
}

fn map_roman() -> &'static Regex {
    regex!(r"\b(?:map|mapa)\s+(i|ii|iii|iv|v)\b", "")
}

fn map_digit_first() -> &'static Regex {
    regex!(r"\b([1-9])\s+mapa\b", "")
}

fn map_english_ordinal() -> &'static Regex {
    regex!(r"\b([1-9])(?:st|nd|rd|th)\s+(?:map|mapa)\b", "")
}

fn map_ordinal_word() -> &'static Regex {
    regex!(
        r"\b(primeiro|primeira|segundo|segunda|terceiro|terceira|quarto|quarta|quinto|quinta|1o|1a|2o|2a|3o|3a|4o|4a|5o|5a)\s+mapa\b",
        ""
    )
}

fn map_compact() -> &'static Regex {
    regex!(r"\bm([1-9])\b", "")
}

fn esports_game_number() -> &'static Regex {
    regex!(r"\b(?:game|jogo)\s*([1-9])\b", "")
}

fn no_before_word() -> &'static Regex {
    regex!(r"\bno\s+(?=[a-z0-9])", "g")
}

fn full_time_at_start() -> &'static Regex {
    regex!(r"^(?:ft|full time)\b", "")
}

fn btts_spelled_no() -> &'static Regex {
    regex!(r"\b(?:nao|not|ng)\b|\bsem gols? de ambos\b", "")
}

fn btts_bare_no() -> &'static Regex {
    regex!(r"\bno\b", "")
}

fn btts_affirmed() -> &'static Regex {
    regex!(r"\b(?:sim|yes|gg)\b|^g g$", "")
}

fn btts_subject_alone() -> &'static Regex {
    regex!(r"^(?:ambas|ambos)$", "")
}

fn score_notation() -> &'static Regex {
    regex!(r"\b\d+\s*:\s*\d+\b", "")
}

fn handicap_word() -> &'static Regex {
    regex!(r"\bhandicap\b", "")
}

fn three_way_qualifier() -> &'static Regex {
    regex!(
        r"\b(?:3\s*way|three\s*way|3\s*vias?|3\s*(?:opcoes|selecoes)|europeu|european|europeo|europea|europeen|europeenne)\b",
        ""
    )
}

fn handicap_result() -> &'static Regex {
    regex!(
        r"\b(?:handicap\s+result|handicap\s+resultado|resultado\s+(?:do\s+|(?:final\s+)?com\s+)?handicap)\b",
        ""
    )
}

fn method_of_victory() -> &'static Regex {
    regex!(
        r"\b(?:ko|tko|submissions?|decisions?|metodo|methods?|(?:vencedor(?:a)?|vitoria|vence)\s+por\s+(?:nocaute|finalizacao|submissao|decisao|pontos)|method of victory|winning method|victory method|metodo da vitoria|metodo de vitoria|metodo (?:do|de) encerramento|forma da vitoria|forma de vitoria|modo da vitoria|modo de vitoria|tipo da vitoria|tipo de vitoria|tipo da finalizacao|tipo de finalizacao|como (?:o|a) (?:combate|luta|duelo|confronto) (?:vai )?terminara?|como termina (?:o|a) (?:combate|luta|duelo|confronto)|metodo (?:de|do|da) (?:desfecho|termino|encerramento|finalizacao)|modo (?:de|do|da) (?:desfecho|termino|finalizacao))\b",
        ""
    )
}

fn total_label() -> &'static Regex {
    regex!(
        r"\b(?:total|totais|over|under|mais menos|acima abaixo)\b",
        ""
    )
}

fn handicap_label() -> &'static Regex {
    regex!(r"\b(?:handicap|spread|ah)\b", "")
}

fn total_label_words() -> &'static Regex {
    regex!(
        r"\b(?:total|totais|over|under|mais|menos|acima|abaixo|time|team|equipe)\b",
        "g"
    )
}

fn team_points_label() -> &'static Regex {
    regex!(
        r"\b(?:points?|pontos?|runs?|corridas?)\s+(?:do\s+time|da\s+equipe)\b",
        ""
    )
}

fn team_total_label() -> &'static Regex {
    regex!(
        r"\bteam\s*total\b|\btotal\s*(?:(?:de\s+gols\s+)?(?:do\s+time|da\s+equipe)|(?:de\s+gols\s+)?por\s+(?:time|equipe))\b",
        ""
    )
}

fn total_of_side() -> &'static Regex {
    regex!(
        r"\btotal\s+(?:(?:de\s+)?(?:goals?|gols?|points?|pontos?|corners?|cantos?|escanteios?|cards?|cartoes?|carteos?|bookings?)\s+)?(?:(?:do|da|de)\s+)?(?:home|away|casa|fora|mandante|visitante)\b",
        ""
    )
}

fn side_total() -> &'static Regex {
    regex!(
        r"\b(?:home|away|casa|fora|mandante|visitante)(?:\s+team)?\s+(?:(?:goals?|points?|pontos?|corners?|cantos?|escanteios?|cards?|cartoes?|carteos?|bookings?)\s+)?total(?:\s+(?:goals?|points?|pontos?|corners?|cantos?|escanteios?|cards?|cartoes?|carteos?|bookings?))?\b",
        ""
    )
}

fn side_goals() -> &'static Regex {
    regex!(
        r"\b(?:home|away|casa|fora|mandante|visitante)(?:\s+team)?\s+(?:goals?|gols?|points?|pontos?)\b",
        ""
    )
}

fn named_before_direction() -> &'static Regex {
    regex!(
        r"^(.+?)\s+\b(?:over|under|mais\s+de|menos\s+de|acima(?:\s+de)?|abaixo(?:\s+de)?)\b",
        ""
    )
}

fn ordinal_half_abbreviation() -> &'static Regex {
    regex!(r"(\d)\s*[ºª°]\s*t\b", "gi")
}

fn quarter_or_period() -> &'static Regex {
    regex!(
        r"\b(?:quarters?|quartos?|q\s*[1-9]|[1-9]\s*q|p\s*[1-9]|[1-9]\s*p|periods?|periodos?)\b",
        ""
    )
}

fn inning() -> &'static Regex {
    regex!(
        r"\b(?:innings?\s*[1-9]|i\s*[1-9]|[1-9](?:st|nd|rd|th)?\s+innings?|[1-9]\s+entradas?|f\s*5|h\s*5)\b",
        ""
    )
}

fn game_number() -> &'static Regex {
    regex!(r"\b(?:game|jogo)\s*[1-9]\b", "")
}

fn unit_winner() -> &'static Regex {
    regex!(r"\b(?:set|round|frame|leg|points)\s+winner\b", "")
}

fn unit_winner_pt() -> &'static Regex {
    regex!(
        r"\b(?:vencedor|ganhador) d[oa] (?:game|set|round|frame|leg)\b",
        ""
    )
}

fn round_inside_map() -> &'static Regex {
    regex!(
        r"\bpistol\b|\b(?:primeir[oa]|segund[oa]|ultim[oa]|first|second|last)\s+round\b",
        ""
    )
}

fn numbered_unit() -> &'static Regex {
    regex!(
        r"\b(?:s\s*[1-9]|[1-9]\s*s|r\s*[1-9]|(?:set|round|frame|leg)\s*[1-9]|[1-9](?:st|nd|rd|th)?\s+(?:set|round|frame|leg))\b",
        ""
    )
}

fn map_or_set_number() -> &'static Regex {
    regex!(r"\b(map|mapa|set)\s*\d", "")
}

fn player_goals_plus() -> &'static Regex {
    regex!(r"(?:^|[^\d.,])[2-9]\s*\+\s*(?:gols?|goals?)?(?:$|\s)", "")
}

fn player_goals_phrase() -> &'static Regex {
    regex!(
        r"\b(?:to score|marcar)\s+(?:a\s+|um\s+)?(?:[2-9]\s+(?:or more|ou mais)\s+(?:gols?|goals?)|hat\s*-?\s*tricks?|brace)\b",
        ""
    )
}

fn player_goals_word() -> &'static Regex {
    regex!(r"^(?:hat\s*-?\s*tricks?|hattricks?|brace|bis)$", "")
}

fn player_stat_prop() -> &'static Regex {
    regex!(
        r"\bplayer\s+(?:tackles?|fouls?|passes?|cards?|yellow\s+cards?|red\s+cards?|interceptions?|key\s+passes?|offsides?|saves?)\b",
        ""
    )
}

fn team_total_word() -> &'static Regex {
    regex!(r"\bteam\s+total", "")
}

fn kills_deaths_prop() -> &'static Regex {
    regex!(
        r"\b(?:player\s+(?:kills?|deaths?|abates?|mortes?)|(?:kills?|deaths?|abates?|mortes?)\s+(?:ht|1h|2h|do\s+jogador|da\s+jogadora|por\s+jogador|de\s+jogador)|deaths\s+ht|kills\s+ht|player\s*props?)\b|^(?:deaths|mortes|kills|abates|deaths\s+ht|kills\s+ht|player\s+props?)$",
        ""
    )
}

fn shots_assists_prop() -> &'static Regex {
    regex!(
        r"\b(?:player\s+assists|player\s+shots|player\s+shots\s+on\s+target|shots\s+on\s+target|chutes\s+ao\s+gol|chutes\s+no\s+gol)\b|^(?:shots|chutes|player\s*assists)$",
        ""
    )
}

fn points_rebounds_assists_prop() -> &'static Regex {
    regex!(
        r"\b(?:p\s*a\s*r|pra|player\s*pra|player\s+points\s+(?:and\s+)?rebounds\s+(?:and\s+)?assists|player\s+points\s*rebounds\s*assists|pontos\s+(?:e\s+)?rebotes\s+(?:e\s+)?assistencias|pontos\s+rebotes|pontos\s+assistencias|rebotes\s+assistencias|player\s+(?:points?|rebounds?|assists?|pts?|rebs?|ast))\b|^(?:p\s*a\s*r|pra|pontos|rebotes|assistencias)$",
        ""
    )
}

fn spread_market() -> &'static Regex {
    regex!(r"\b(handicap|spread|ah)\b|\b(?:run|puck)\s*line\b", "")
}

fn kills_word() -> &'static Regex {
    regex!(r"\b(?:kills?|abates?)\b", "")
}

fn total_market() -> &'static Regex {
    regex!(
        r"\b(?:total|totais)\b|\bo u\b|\bover under\b|\b(?:over|under)\b|\b(?:mais menos|acima abaixo)\b|\b(?:mais|menos)\s+(?:de|que)\b",
        ""
    )
}

fn goal_line_market() -> &'static Regex {
    regex!(
        r"\bgoal\s*line\b|\blinha de (?:gols?|pontos?|runs?|corridas?|escanteios?|cantos?|cartoes?|carteos?|kills?|abates?)\b",
        ""
    )
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        &*TEAM_TOTAL_NAMED_UNIT,
        &*EXTRA_TIME,
        &*REGULATION_TIME,
        &*BTTS_MARKET_RE,
        &*BTTS_MARKET_ALL,
        btts_residue_names_market(),
        each_half(),
        both_halves_elided(),
        btts_verb_preposition(),
        &*MATCH_SCOPE_PREPOSITION,
        &*OUTRIGHT_MARKET,
        &*DRAW_NO_BET_MARKET,
        &*DOUBLE_CHANCE_MARKET,
        combo_ht_ft(),
        &*BTTS_FILLER,
        trailing_first_half(),
        trailing_second_half(),
        minute_window(),
        &*MONEYLINE_MARKET,
        scorer_market(),
        &*EACH_OR_BOTH_HALVES,
        &*TEAM_TOTAL_LABELED,
        &*INNER_UNIT,
        &*PLAYER_PROP_FAMILIES,
        &*TOTAL_OR_GOAL_LINE,
        map_numbered(),
        map_roman(),
        map_digit_first(),
        map_english_ordinal(),
        map_ordinal_word(),
        map_compact(),
        esports_game_number(),
        no_before_word(),
        full_time_at_start(),
        btts_spelled_no(),
        btts_bare_no(),
        btts_affirmed(),
        btts_subject_alone(),
        score_notation(),
        handicap_word(),
        three_way_qualifier(),
        handicap_result(),
        method_of_victory(),
        total_label(),
        handicap_label(),
        total_label_words(),
        team_points_label(),
        team_total_label(),
        total_of_side(),
        side_total(),
        side_goals(),
        named_before_direction(),
        ordinal_half_abbreviation(),
        quarter_or_period(),
        inning(),
        game_number(),
        unit_winner(),
        unit_winner_pt(),
        round_inside_map(),
        numbered_unit(),
        map_or_set_number(),
        player_goals_plus(),
        player_goals_phrase(),
        player_goals_word(),
        player_stat_prop(),
        team_total_word(),
        kills_deaths_prop(),
        shots_assists_prop(),
        points_rebounds_assists_prop(),
        spread_market(),
        kills_word(),
        total_market(),
        goal_line_market(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tipo_e_periodo() {
        let evento = Some("Flamengo vs Palmeiras");
        assert_eq!(
            market_kind_of("Moneyline", "Flamengo", evento),
            MarketKind::Moneyline
        );
        assert_eq!(
            market_kind_of("Total de Gols", "Flamengo Over 1.5", evento),
            MarketKind::TeamTotal
        );
        assert_eq!(
            market_kind_of("Ambas marcam e Over 2.5", "", evento),
            MarketKind::Other
        );
        assert_eq!(
            market_kind_of("Vencedor do Campeonato", "", evento),
            MarketKind::Other
        );
        assert_eq!(
            market_kind_of("Handicap Europeu", "", evento),
            MarketKind::Other
        );
        assert_eq!(
            market_period_of("1º Tempo - Totais", None),
            MarketPeriod::Ht
        );
        assert_eq!(
            market_period_of("Over 0.5 ST", Some("Basketball")),
            MarketPeriod::Other
        );
        assert_eq!(
            market_period_of("Mapa 2", Some("eSports")),
            MarketPeriod::Map
        );
        assert_eq!(market_map_number_of("Map 01", None), Some(1));
        assert_eq!(market_map_number_of("Map 10", None), None);
    }

    #[test]
    fn lado_do_btts() {
        assert_eq!(
            btts_selection_side("Ambas marcam - Sim"),
            Some(BttsSide::Yes)
        );
        assert_eq!(btts_selection_side("BTTS No"), Some(BttsSide::No));
        assert_eq!(btts_selection_side("Ambas marcam No 1T"), None);
        assert_eq!(
            btts_selection_side("Ambas marcam no jogo"),
            Some(BttsSide::Yes)
        );
    }
}
