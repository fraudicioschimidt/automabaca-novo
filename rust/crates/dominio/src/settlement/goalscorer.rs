//! As regras de texto do mercado de artilheiro, portadas de
//! `src/domain/settlement/goalscorer.ts`: qual mercado é gol de jogador
//! (anytime, por tempo, primeiro/último), qual qualificador a lista de
//! jogadores não responde e quantos gols a aposta pede.

use crate::js;
use crate::mercados::classify::{MarketPeriod, market_names_both_halves, market_period_of};
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};
use std::collections::BTreeSet;

fn has_any(text: &str, stems: &[&str]) -> bool {
    stems.iter().any(|stem| text.contains(stem))
}

fn ordered_word() -> &'static Regex {
    regex!(
        r"\b(?:first|last|1st|primeiro|ultimo|2nd|second|segundo)\b",
        ""
    )
}

/// Gol de TIME ("Both Teams to Score", o nome gravado para Ambas Marcam;
/// "Home to Score"; "Primeiro Time a Marcar"): não é pergunta sobre jogador,
/// e quem responde é o placar. "Any Time to Score" continua artilheiro.
fn team_goal() -> &'static Regex {
    regex!(
        r"(?<!\bany\s)\b(?:teams?|time|equipe|home|away)\s+(?:(?:da casa|visitante|mandante)\s+)?(?:(?:not|nao)\s+)?(?:to\s+score|a\s+marcar|marcar)\b",
        ""
    )
}

/// O time citado é o do jogador ("Jogador da Equipe Visitante a Marcar",
/// "Anytime Goalscorer - Away Team to Score"): a pergunta é o gol dele.
fn player_of_team() -> &'static Regex {
    regex!(
        r"\bjogador\s+d[oa]\s+(?:time|equipe)\b|\b(?:goalscorer|artilheiro)\b",
        ""
    )
}

/// Todo casamento de `team_goal` passa por "score" ou "marcar".
fn matches_team_goal(texto: &str) -> bool {
    has_any(texto, &["score", "marcar"]) && team_goal().is_match(texto)
}

fn names_team_goal(texto: &str) -> bool {
    matches_team_goal(texto) && !player_of_team().is_match(texto)
}

fn goalscorer_word() -> &'static Regex {
    regex!(r"\bgoalscorer\b", "")
}

fn anytime_pt() -> &'static Regex {
    regex!(r"\bmarcar a qualquer momento\b", "")
}

fn anytime_word() -> &'static Regex {
    regex!(r"\banytime\b", "")
}

fn to_score() -> &'static Regex {
    regex!(r"\bto score\b", "")
}

fn n_plus_goals() -> &'static Regex {
    regex!(r"(?:^|[^\d.,])\d\s*\+\s*(?:gols?|goals?)\b", "")
}

fn hat_trick_or_brace() -> &'static Regex {
    regex!(
        r"\bhat\s*-?\s*tricks?\b|\bhattricks?\b|\bbrace\b|\bbis\b",
        ""
    )
}

/// Artilheiro que o FlashScore sabe resolver: só ANYTIME. First/Last exigem a
/// ordem do gol, que a lista de jogadores não traz.
pub fn eh_mercado_artilheiro(mercado: &str, selecao: Option<&str>) -> bool {
    let selecao = selecao.filter(|selecao| !selecao.is_empty());
    // "Marcar nos dois tempos" tem período OTHER, mas continua gol de
    // jogador: quem o recusa é o qualificador, no resolvedor.
    let both_halves =
        market_names_both_halves(mercado) || selecao.is_some_and(market_names_both_halves);
    if !both_halves {
        if market_period_of(mercado, None) != MarketPeriod::Ft {
            return false;
        }
        if selecao.is_some_and(|selecao| market_period_of(selecao, None) != MarketPeriod::Ft) {
            return false;
        }
    }
    let texto = normalize_str(mercado);
    if names_team_goal(&texto) {
        return false;
    }
    // Cada forma só roda quando o texto tem o radical dela. "anytime scorer"
    // já casa em `anytime`.
    let eh_artilheiro = (texto.contains("goalscorer") && goalscorer_word().is_match(&texto))
        || (texto.contains("marcar a qualquer momento") && anytime_pt().is_match(&texto))
        || (texto.contains("anytime") && anytime_word().is_match(&texto))
        || (texto.contains("to score") && to_score().is_match(&texto))
        || (texto.contains('+') && n_plus_goals().is_match(&texto))
        || (has_any(&texto, &["hat", "brace", "bis"]) && hat_trick_or_brace().is_match(&texto));
    eh_artilheiro && !ordered_word().is_match(&texto)
}

/// Mercado de gol de jogador em 1º ou 2º TEMPO. A prova é o minuto do gol,
/// no resumo da partida. O vocabulário é estreito de propósito: `marcar`
/// sozinho pegaria mercado de TIME ("time da casa marcar").
fn goalscorer_by_half() -> [&'static Regex; 3] {
    [
        // `normalize_str` tira acento mas PRESERVA o ordinal masculino: "1º
        // Tempo" vira "1º tempo", não "1o tempo".
        regex!(
            r"\bmarcar\b[^|]{0,40}[\s(]?(?:1|2|primeiro|segundo)\s*[º°o]?\s*tempo\b",
            ""
        ),
        regex!(
            r"\b(?:first|second|1st|2nd)\s+half\b[^|]{0,40}(?:goalscorer|to score|scorer)\b",
            ""
        ),
        regex!(
            r"\b(?:anytime\s+)?(?:goalscorer|to score)\b[^|]{0,40}\b(?:first|second|1st|2nd)\s+half\b",
            ""
        ),
    ]
}

fn half_phrase_en() -> &'static Regex {
    regex!(r"\b(?:first|second|1st|2nd)\s+half\b", "g")
}

fn half_phrase_pt() -> &'static Regex {
    regex!(r"\b(?:1|2|primeiro|segundo)\s*[º°o]?\s*tempo\b", "g")
}

pub fn eh_mercado_artilheiro_por_tempo(mercado: &str, selecao: Option<&str>) -> bool {
    let mercado_n = normalize_str(mercado);
    if names_team_goal(&mercado_n) {
        return false;
    }
    let selecao_n = selecao
        .filter(|selecao| !selecao.is_empty())
        .map(normalize_str)
        .unwrap_or_default();
    let texto = format!("{mercado_n} {selecao_n}");
    if !goalscorer_by_half()
        .iter()
        .any(|padrao| padrao.is_match(&texto))
    {
        return false;
    }
    // O ordinal precisa falar do GOL, não do TEMPO: some-se a frase do
    // período antes de procurar ordem.
    let sem_periodo = half_phrase_pt().replace(&half_phrase_en().replace(&mercado_n, " "), " ");
    !ordered_word().is_match(&sem_periodo)
}

/// Qualificador que troca "marcou?" por uma pergunta que a lista de
/// jogadores não responde: gol de cabeça, de fora da área, de pênalti ou de
/// falta, nos dois tempos, ou o gol combinado com outra coisa.
fn goal_qualifier() -> &'static Regex {
    regex!(
        r"\b(?:assist\w*|header|cabeca|fora da area|outside the box|de longe|long range|penalt\w*|free kick|de falta)\b",
        ""
    )
}

/// O conectivo só combina com termo dos dois lados, e mercado e seleção são
/// lidos em separado: "Or Dasa" abre com o nome, não liga o gol a nada.
fn goal_combination() -> &'static Regex {
    regex!(r"\S\s*[&+]\s*\S|\S\s+(?:e|and|ou|or)\s+\S", "")
}

/// Inicial de nome ("Haaland E.", a grafia do FlashScore): o "E." não é o
/// conectivo "e".
fn name_initial() -> &'static Regex {
    regex!(r"\b[a-z]\.(?!\w)", "g")
}

fn n_or_more_bare() -> &'static Regex {
    regex!(r"(?<![\d.,])\d{1,2}\s*(?:ou|or)\s*(?:mais|more)\b", "g")
}

fn n_plus_bare() -> &'static Regex {
    regex!(r"(?<![\d.,])\d{1,2}\s*\+", "g")
}

fn qualifier_text(texto: &str) -> String {
    // "N ou mais" e "N+" são quantidade de gols, que `required_player_goals`
    // lê.
    let normalized = normalize_str(texto);
    let without_n_or_more = n_or_more_bare().replace(&normalized, " ");
    let without_n_plus = n_plus_bare().replace(&without_n_or_more, " ");
    name_initial().replace(&without_n_plus, " ")
}

pub fn has_unsupported_goal_qualifier(mercado: &str, selecao: &str) -> bool {
    let market = qualifier_text(mercado);
    let selection = qualifier_text(selecao);
    // Os dois tempos pelo vocabulário do período ("1H/2H", "em cada tempo").
    goal_qualifier().is_match(&format!("{market} {selection}"))
        || market_names_both_halves(mercado)
        || market_names_both_halves(selecao)
        || goal_combination().is_match(&market)
        || goal_combination().is_match(&selection)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalOrder {
    First,
    Last,
}

impl GoalOrder {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::First => "first",
            Self::Last => "last",
        }
    }
}

fn scorer_context() -> &'static Regex {
    regex!(r"\b(?:goalscorer|scorer|marcador|artilheiro|marcar)\b", "")
}

/// Qualificadores de período que indicam mercado de período específico:
/// "1st Half Goalscorer" fala do tempo, não da ordem do gol no jogo.
fn period_qualifier() -> &'static Regex {
    regex!(r"\b(?:half|tempo|quarter|quarto|1t|2t|1h|2h|1q|2q)\b", "i")
}

fn first_word() -> &'static Regex {
    regex!(r"\b(?:first|1st|primeiro|primeira)\b", "")
}

fn last_word() -> &'static Regex {
    regex!(r"\b(?:last|ultimo|ultima)\b", "")
}

/// First/Last são outra família: `GOALS` prova quantidade, não ordem. O
/// rótulo precisa declarar sem ambiguidade primeiro ou último do jogo
/// inteiro.
pub fn ordered_goalscorer_market_order(mercado: &str, selecao: Option<&str>) -> Option<GoalOrder> {
    let texto = normalize_str(mercado);
    // Aqui qualquer time citado recusa, também o do jogador: o primeiro gol
    // do time pode ser o segundo da partida.
    if !scorer_context().is_match(&texto) || matches_team_goal(&texto) {
        return None;
    }
    if market_period_of(mercado, None) != MarketPeriod::Ft {
        return None;
    }
    if selecao
        .filter(|selecao| !selecao.is_empty())
        .is_some_and(|selecao| market_period_of(selecao, None) != MarketPeriod::Ft)
    {
        return None;
    }
    if period_qualifier().is_match(&texto) {
        return None;
    }
    match (first_word().is_match(&texto), last_word().is_match(&texto)) {
        (true, true) | (false, false) => None,
        (true, false) => Some(GoalOrder::First),
        (false, true) => Some(GoalOrder::Last),
    }
}

fn minute() -> &'static Regex {
    regex!(r"^(\d{1,3})(?:\s*\+\s*\d{1,2})?$", "")
}

/// Minuto base de "45+2" é 45: o acréscimo pertence ao tempo que termina.
pub fn minuto_base(raw: &str) -> Option<f64> {
    let trimmed = js::trim(raw);
    let limpo = trimmed.strip_suffix(['’', '\'']).unwrap_or(trimmed);
    let base: f64 = minute().exec(limpo)?.get(1)?.parse().ok()?;
    (1.0..=130.0).contains(&base).then_some(base)
}

fn half_number() -> &'static Regex {
    regex!(r"\b[12]\s*[ºª°o]?\s*(?:tempo|etapa|parte|half)\b", "g")
}

fn order_words() -> &'static Regex {
    regex!(
        r"\b(?:1st|2nd|3rd|first|second|last|primeir[oa]|segund[oa]|ultim[oa])\b",
        "g"
    )
}

fn ordinal_number() -> &'static Regex {
    regex!(r"\b[12]\s*[ºª°]", "g")
}

fn half_abbreviation() -> &'static Regex {
    regex!(r"\b(?:[12]t|h[12]|[12]h)\b", "g")
}

fn hat_trick() -> &'static Regex {
    regex!(r"\bhat\s*-?\s*tricks?\b|\bhattricks?\b", "g")
}

fn brace() -> &'static Regex {
    regex!(r"\b(?:brace|bis)\b", "g")
}

fn n_or_more_goals() -> &'static Regex {
    regex!(
        r"(?<![\d.,])(\d{1,2})\s*(?:ou|or)\s*(?:mais|more)\b(?:\s*(?:gols?|goals?))?",
        "g"
    )
}

fn at_least_n_goals() -> &'static Regex {
    regex!(
        r"\b(?:pelo menos|no minimo|at least)\s*(\d{1,2})\b(?:\s*(?:gols?|goals?))?",
        "g"
    )
}

fn n_plus_goals_count() -> &'static Regex {
    regex!(r"(?<![\d.,])(\d{1,2})\s*\+(?:\s*(?:gols?|goals?))?", "g")
}

fn n_goals() -> &'static Regex {
    regex!(r"(?<![\d.,])(\d{1,2})\s*(?:gols?|goals?)\b", "g")
}

fn unreadable_quantity() -> &'static Regex {
    regex!(
        r"\b(?:over|under|mais de|menos de|acima de|abaixo de|exatamente|exactly|dois|duas|tres|quatro|two|three|four|poker|doblete|triplete)\b",
        ""
    )
}

/// Quantos gols do jogador a aposta pede, lidos do mercado e da seleção:
/// "2+", "3+ gols", "N ou mais", "N or more", "pelo menos N", "N gols",
/// "hat-trick" (3) e "brace"/"bis" (2). Sem quantidade, é marcar (1).
/// Número ou quantidade que sobre sem leitura ("over 1.5", "dois gols",
/// duas quantidades diferentes) devolve `None`: vai para o operador, nunca
/// vira "marcar" por omissão.
pub fn required_player_goals(mercado: &str, selecao: &str) -> Option<f64> {
    let joined = format!(" {} ", normalize_str(&format!("{mercado} {selecao}")));
    // Período e ordem são outra pergunta, com resolvedor próprio: tiram-se os
    // números deles antes de procurar a quantidade.
    let mut text = half_abbreviation().replace(
        &ordinal_number().replace(
            &order_words().replace(&half_number().replace(&joined, " "), " "),
            " ",
        ),
        " ",
    );
    let mut found = BTreeSet::new();
    let mut take = |text: &mut String, pattern: &Regex, fixed: Option<u64>| {
        *text = pattern.replace_with(text, |captures| {
            let value = fixed.or_else(|| captures.get(1).and_then(|digits| digits.parse().ok()));
            if let Some(value) = value {
                found.insert(value);
            }
            " ".to_owned()
        });
    };
    take(&mut text, hat_trick(), Some(3));
    take(&mut text, brace(), Some(2));
    take(&mut text, n_or_more_goals(), None);
    take(&mut text, at_least_n_goals(), None);
    take(&mut text, n_plus_goals_count(), None);
    take(&mut text, n_goals(), None);
    if text.bytes().any(|b| b.is_ascii_digit()) || unreadable_quantity().is_match(&text) {
        return None;
    }
    match found.len() {
        0 => Some(1.0),
        1 => found
            .into_iter()
            .next()
            .filter(|goals| *goals >= 1)
            .map(|goals| goals as f64),
        _ => None,
    }
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all = vec![
        ordered_word(),
        team_goal(),
        player_of_team(),
        goalscorer_word(),
        anytime_pt(),
        anytime_word(),
        to_score(),
        n_plus_goals(),
        hat_trick_or_brace(),
        half_phrase_en(),
        half_phrase_pt(),
        goal_qualifier(),
        goal_combination(),
        name_initial(),
        n_or_more_bare(),
        n_plus_bare(),
        scorer_context(),
        period_qualifier(),
        first_word(),
        last_word(),
        minute(),
        half_number(),
        order_words(),
        ordinal_number(),
        half_abbreviation(),
        hat_trick(),
        brace(),
        n_or_more_goals(),
        at_least_n_goals(),
        n_plus_goals_count(),
        n_goals(),
        unreadable_quantity(),
    ];
    all.extend(goalscorer_by_half());
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mercado_de_artilheiro() {
        assert!(eh_mercado_artilheiro("Anytime Goalscorer", Some("Haaland")));
        assert!(eh_mercado_artilheiro("Marcar a qualquer momento", None));
        assert!(!eh_mercado_artilheiro("First Goalscorer", None));
        assert!(!eh_mercado_artilheiro("Both Teams to Score", None));
        assert!(eh_mercado_artilheiro("Any Time to Score", None));
        assert!(eh_mercado_artilheiro_por_tempo("1st Half Goalscorer", None));
        assert!(!eh_mercado_artilheiro_por_tempo("Anytime Goalscorer", None));
        assert_eq!(
            ordered_goalscorer_market_order("First Goalscorer", None),
            Some(GoalOrder::First)
        );
        assert_eq!(
            ordered_goalscorer_market_order("First or Last Goalscorer", None),
            None
        );
        assert!(has_unsupported_goal_qualifier("Gol de cabeça", ""));
        assert!(!has_unsupported_goal_qualifier(
            "Anytime Goalscorer",
            "Haaland E."
        ));
        assert_eq!(minuto_base("45+2'"), Some(45.0));
        assert_eq!(minuto_base("0"), None);
        assert_eq!(
            required_player_goals("Anytime Goalscorer", "Haaland"),
            Some(1.0)
        );
        assert_eq!(required_player_goals("", "Haaland 2+ gols"), Some(2.0));
        assert_eq!(required_player_goals("", "Haaland hat-trick"), Some(3.0));
        assert_eq!(required_player_goals("", "Haaland over 1.5"), None);
        assert_eq!(required_player_goals("1º tempo", "Haaland"), Some(1.0));
    }
}
