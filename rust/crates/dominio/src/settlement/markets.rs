//! Classificação de mercado para resolução por placar, portada de
//! `src/domain/settlement/markets.ts`.
//!
//! BTTS e team totals usam `homeScore`/`awayScore` (gols por time): o feed
//! já entrega o par, não só o agregado. Com kinds próprios, resolvem
//! deterministicamente. Props de jogador ficam fora
//! (`has_non_score_stat_qualifier` / unsupported).

use crate::mercados::classify::{
    MarketPeriod, is_btts_market, is_combined_btts_market, is_double_chance_market,
    is_draw_no_bet_market, is_method_of_victory_market, is_outright_market, is_race_to_market,
    is_team_total_market, is_three_way_handicap_market, market_period_of,
};
use crate::mercados::match_scope::MATCH_SCOPE_NOUNS;
use crate::mercados::stat_qualifier::{
    has_non_score_stat_qualifier, has_score_unit_mismatch, has_unknown_score_qualifier,
};
use crate::mercados::total_direction::total_direction_of;
use crate::settlement::over_under_subject::line_subject_is_not_event_team;
use crate::settlement::sides::{
    match_team_side, moneyline_selection_asks_another_market, strip_team_names,
};
use crate::text::split_evento_teams;
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};
use std::collections::HashSet;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScoreMarketKind {
    Handicap,
    Total,
    TeamTotal,
    Btts,
    Moneyline,
    DrawNoBet,
    DoubleChance,
}

impl ScoreMarketKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Handicap => "handicap",
            Self::Total => "total",
            Self::TeamTotal => "team_total",
            Self::Btts => "btts",
            Self::Moneyline => "moneyline",
            Self::DrawNoBet => "draw_no_bet",
            Self::DoubleChance => "double_chance",
        }
    }

    /// O que a seleção de cada mercado pode trazer sem pedir uma segunda
    /// condição.
    fn own_family(self) -> MarketFamily {
        match self {
            Self::Handicap => MarketFamily::Handicap,
            Self::Total | Self::TeamTotal => MarketFamily::Total,
            Self::Btts => MarketFamily::Btts,
            Self::Moneyline | Self::DrawNoBet | Self::DoubleChance => MarketFamily::Result,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum MarketFamily {
    Total,
    Btts,
    Result,
    Handicap,
}

fn total_vocabulary() -> &'static Regex {
    regex!(
        r"\b(?:over|under|acima|abaixo|above|below|total|totais)\b|\b(?:mais|menos)\s+(?:de|que)\b|\b[ou]\s?\d+[.,]\d",
        ""
    )
}

fn btts_vocabulary() -> &'static Regex {
    regex!(r"\b(?:ambas|ambos|btts|both teams)\b", "")
}

fn result_vocabulary() -> &'static Regex {
    regex!(
        r"\b(?:vence\w*|vitoria|ganha\w*|wins?|winner|empat\w+|draw|money\s*line|ml|dnb|resultado|1x2)\b",
        ""
    )
}

fn handicap_vocabulary() -> &'static Regex {
    regex!(r"\b(?:handicap|hcp|ah|spread)\b|(?:^|[\s([])[+-]\d", "")
}

/// As famílias na ordem do objeto do TypeScript.
fn family_vocabulary() -> [(MarketFamily, &'static Regex); 4] {
    [
        (MarketFamily::Total, total_vocabulary()),
        (MarketFamily::Btts, btts_vocabulary()),
        (MarketFamily::Result, result_vocabulary()),
        (MarketFamily::Handicap, handicap_vocabulary()),
    ]
}

/// Conectivo que junta duas pernas; o símbolo só antes de palavra, para
/// "2.5/3", "0,-0.5" e "+0.5" seguirem linha.
fn leg_connective() -> &'static Regex {
    regex!(r"\s(?:e|and|y|com|with)\s|[+&/,;|]\s*(?=[a-z])", "g")
}

fn ascii_words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|word| !word.is_empty())
}

fn has_lowercase(text: &str) -> bool {
    text.chars().any(|c| c.is_ascii_lowercase())
}

/// Famílias de mercado das pernas que um conectivo junta no texto ("Sim e
/// Over 2.5", "Flamengo e Over 2.5", "Resultado / Total de Gols"). Sem
/// conectivo não há segunda perna. O conectivo dentro do nome de um time do
/// evento ("Brighton & Hove Albion") não separa nada, e o time sozinho numa
/// perna é o resultado.
fn joined_leg_families(text_n: &str, evento: Option<&str>) -> HashSet<MarketFamily> {
    let evento = evento.filter(|evento| !evento.is_empty());
    let team_words: Vec<HashSet<String>> = evento
        .and_then(split_evento_teams)
        .map(|(home, away)| {
            [home, away]
                .iter()
                .map(|team| {
                    ascii_words(&normalize_str(team))
                        .map(str::to_owned)
                        .collect()
                })
                .collect()
        })
        .unwrap_or_default();
    let mut parts: Vec<&str> = Vec::new();
    let mut start = 0;
    for found in leg_connective().exec_all(text_n) {
        let before = ascii_words(&text_n[..found.start()]).last().unwrap_or("");
        let after = ascii_words(&text_n[found.end()..]).next().unwrap_or("");
        if team_words
            .iter()
            .any(|words| words.contains(before) && words.contains(after))
        {
            continue;
        }
        parts.push(&text_n[start..found.start()]);
        start = found.end();
    }
    let mut families = HashSet::new();
    if parts.is_empty() {
        return families;
    }
    parts.push(&text_n[start..]);
    for part in parts {
        let leg = match evento {
            Some(evento) => strip_team_names(part, evento),
            None => part.to_owned(),
        };
        if let Some(evento) = evento
            && has_lowercase(part)
            && !leg
                .chars()
                .any(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && match_team_side(part, evento).is_some()
        {
            families.insert(MarketFamily::Result);
        }
        for (family, vocabulary) in family_vocabulary() {
            if vocabulary.is_match(&leg) {
                families.insert(family);
            }
        }
    }
    families
}

/// Família do mercado, ou `None` quando o placar não o responde sozinho: sem
/// motor para ele, ou com uma segunda condição que o rótulo ou a seleção
/// juntam ("Ambas Marcam" / "Sim e Over 2.5"). Pago por uma metade, o
/// combinado sairia ganho com a outra perdida.
pub fn classify_score_market(
    mercado_n: &str,
    selecao_n: &str,
    evento: Option<&str>,
) -> Option<ScoreMarketKind> {
    let kind = classify_single_market(mercado_n, selecao_n, evento)?;
    if joined_leg_families(mercado_n, evento).len() > 1 {
        return None;
    }
    if joined_leg_families(selecao_n, evento)
        .iter()
        .any(|family| *family != kind.own_family())
    {
        return None;
    }
    if kind == ScoreMarketKind::Moneyline
        && moneyline_selection_asks_another_market(selecao_n, evento)
    {
        return None;
    }
    Some(kind)
}

fn exact_score() -> &'static Regex {
    regex!(
        r"\b(?:resultado\s+exato|placar\s+exato|correct\s+score)\b",
        ""
    )
}

fn european() -> &'static Regex {
    regex!(r"\b(europeu|european)\b", "")
}

fn handicap_word() -> &'static Regex {
    regex!(r"\bhandicap\b", "")
}

fn spread_word() -> &'static Regex {
    regex!(r"\b(handicap|ah|spread)\b", "")
}

fn run_or_puck_line() -> &'static Regex {
    regex!(r"\b(run|puck)\s*line\b", "")
}

/// `mais menos`/`acima abaixo` (a grafia "Mais/Menos" da casa) precisa estar
/// aqui também, senão o roteamento de preço vê total e o settlement devolve
/// `unsupported_market` para o mesmo rótulo. O separador entra explícito
/// porque o mercado vem de `normalize_str` (mantém a pontuação).
fn explicit_total() -> &'static Regex {
    regex!(
        r"\b(over|under|total|totais|mais\s*[/|-]?\s*menos|acima\s*[/|-]?\s*abaixo|mais\s*(?:de|que)|menos\s*(?:de|que)|acima(?:\s*de)?|abaixo(?:\s*de)?|goal\s*line|linha\s+de\s+(?:gols?|pontos?|runs?|corridas?)|asian\s+(?:corners?|escanteios?|cantos?|cards?|cartoes?|carteos?|bookings?|shots?)|escanteios?\s+asi[aá]ticos?|cantos?\s+asi[aá]ticos?|cart(?:[oõ]es?|eos)\s+asi[aá]ticos?)\b",
        "i"
    )
}

fn asian_word() -> &'static Regex {
    regex!(r"\basian\b", "")
}

/// Rótulo de resultado (moneyline). O escopo do "para vencer/ganhar" vem de
/// `match_scope`, o mesmo do filtro SQL: se divergissem, "Para Ganhar o
/// Confronto" sairia do IA-Judge sem log.
static RESULT_MARKET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::cataloged(
        &format!(
            r"\b(resultado\s*final|resultado\s*do\s*jogo|resultado|vencedor|ganhador|para\s+(?:vencer|ganhar)\s+(?:[ao]\s+)?(?:{})|quem\s+(?:vencera|vence|ganhara|ganha)|money\s*line|match\s*winner|full\s*time\s*result|1x2|winner|ml)\b",
            MATCH_SCOPE_NOUNS.join("|")
        ),
        "",
    )
    .unwrap_or_else(|error| panic!("RESULT_MARKET: {error}"))
});

fn only_para_ganhar() -> &'static Regex {
    regex!(r"^(?:para\s+ganhar)$", "")
}

fn classify_single_market(
    mercado_n: &str,
    selecao_n: &str,
    evento: Option<&str>,
) -> Option<ScoreMarketKind> {
    if is_outright_market(mercado_n) || is_method_of_victory_market(mercado_n) {
        return None;
    }
    // Placar exato depende do placar selecionado, não apenas do vencedor.
    // Ainda não há resolver dessa família: falha fechada em vez de cair no
    // termo amplo "resultado" da moneyline.
    if exact_score().is_match(mercado_n) {
        return None;
    }
    // Handicap EUROPEU (3-way, linha inteira) não é asiático: não tem push e
    // o resultado exato na linha é PERDA. Recusa: settlement manual.
    if is_three_way_handicap_market(mercado_n)
        || (european().is_match(mercado_n) && handicap_word().is_match(mercado_n))
    {
        return None;
    }
    // "Race to N"/"Primeiro a N" não é over/under do agregado.
    if is_race_to_market(mercado_n, selecao_n) {
        return None;
    }
    // O combo (resultado e ambas marcam) vem antes do BTTS puro: resolver só
    // a perna de "ambas marcam" pagaria a aposta com a outra metade por
    // conferir.
    if is_combined_btts_market(mercado_n) {
        return None;
    }
    if is_btts_market(mercado_n) {
        return Some(ScoreMarketKind::Btts);
    }
    // Sem isto, um prefixo que não é o time cai em team_total e, se quem
    // chama só negar o team_total, a linha vira total de JOGO e paga o placar.
    if line_subject_is_not_event_team(selecao_n, evento) {
        return None;
    }
    if is_team_total_market(mercado_n, selecao_n, evento) {
        return Some(ScoreMarketKind::TeamTotal);
    }
    if is_draw_no_bet_market(mercado_n) {
        return Some(ScoreMarketKind::DrawNoBet);
    }
    if is_double_chance_market(mercado_n) {
        return Some(ScoreMarketKind::DoubleChance);
    }
    // TOTAL antes de HANDICAP: "Asian Total" contém "asian" mas é total.
    let explicit_spread_market =
        spread_word().is_match(mercado_n) || run_or_puck_line().is_match(mercado_n);
    let explicit_total_market = explicit_total().is_match(mercado_n);
    // A seleção pode ter "Over" dentro do nome de um time: o mercado de
    // handicap explícito vence, salvo quando ele declara total asiático.
    if explicit_spread_market && !explicit_total_market {
        return Some(ScoreMarketKind::Handicap);
    }
    if explicit_total_market
        && (total_direction_of(selecao_n, true).is_some()
            || total_direction_of(&format!("{mercado_n} {selecao_n}"), false).is_some())
    {
        return Some(ScoreMarketKind::Total);
    }
    // `asian` sozinho é handicap, MENOS quando o mercado declarou total.
    if asian_word().is_match(mercado_n) && !explicit_total_market {
        return Some(ScoreMarketKind::Handicap);
    }
    let compact: String = mercado_n
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect();
    if RESULT_MARKET.is_match(mercado_n)
        || only_para_ganhar().is_match(mercado_n)
        || compact == "1x2"
        || compact == "ml"
    {
        // Capturas podem manter o rótulo genérico "Moneyline" e carregar a
        // regra DNB só na seleção ("Time DNB"): a seleção vence.
        return Some(if is_draw_no_bet_market(selecao_n) {
            ScoreMarketKind::DrawNoBet
        } else {
            ScoreMarketKind::Moneyline
        });
    }
    None
}

/// O PLACAR FINAL responde a aposta? Para 1º tempo/HT/mapa ele não
/// responde: quem usa isto (caixa de ações e lote do IA-Judge) só tem o
/// agregado. A aposta de tempo liquida pelo FlashScore, com os parciais.
/// Sem evento o team total só é reconhecido na forma com PREFIXO.
pub fn is_score_resolvable_market(
    mercado: &str,
    selecao: &str,
    esporte: Option<&str>,
    evento: Option<&str>,
) -> bool {
    !has_non_score_stat_qualifier(mercado, selecao)
        && !has_unknown_score_qualifier(mercado)
        && !has_score_unit_mismatch(mercado, selecao, esporte)
        && !has_non_full_time_score_period(mercado, selecao, esporte)
        && classify_score_market(&normalize_str(mercado), &normalize_str(selecao), evento).is_some()
}

/// Mercado e seleção são duas superfícies da mesma evidência de período.
pub fn has_non_full_time_score_period(mercado: &str, selecao: &str, esporte: Option<&str>) -> bool {
    declared_score_period(mercado, selecao, esporte) != MarketPeriod::Ft
}

/// Período efetivo das duas superfícies. FT numa delas é "não declarou";
/// conflito HT vs segundo tempo, OTHER ou MAP recusam liquidação automática.
pub fn declared_score_period(mercado: &str, selecao: &str, esporte: Option<&str>) -> MarketPeriod {
    let mercado_period = market_period_of(mercado, esporte);
    let selecao_period = market_period_of(selecao, esporte);
    if mercado_period == MarketPeriod::Other || selecao_period == MarketPeriod::Other {
        return MarketPeriod::Other;
    }
    if mercado_period == MarketPeriod::Map || selecao_period == MarketPeriod::Map {
        return MarketPeriod::Map;
    }
    if mercado_period != MarketPeriod::Ft
        && selecao_period != MarketPeriod::Ft
        && mercado_period != selecao_period
    {
        return MarketPeriod::Other;
    }
    if mercado_period != MarketPeriod::Ft {
        mercado_period
    } else {
        selecao_period
    }
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        total_vocabulary(),
        btts_vocabulary(),
        result_vocabulary(),
        handicap_vocabulary(),
        leg_connective(),
        exact_score(),
        european(),
        handicap_word(),
        spread_word(),
        run_or_puck_line(),
        explicit_total(),
        asian_word(),
        &*RESULT_MARKET,
        only_para_ganhar(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(mercado: &str, selecao: &str) -> Option<&'static str> {
        classify_score_market(
            &normalize_str(mercado),
            &normalize_str(selecao),
            Some("Flamengo vs Palmeiras"),
        )
        .map(ScoreMarketKind::as_str)
    }

    #[test]
    fn classifica_pelo_placar() {
        assert_eq!(kind("Total de Gols", "Over 2.5"), Some("total"));
        assert_eq!(kind("Asian Handicap", "Flamengo -0.5"), Some("handicap"));
        assert_eq!(kind("Ambas Marcam", "Sim"), Some("btts"));
        assert_eq!(kind("Ambas Marcam", "Sim e Over 2.5"), None);
        assert_eq!(kind("Resultado Final", "Flamengo"), Some("moneyline"));
        assert_eq!(kind("Moneyline", "Flamengo DNB"), Some("draw_no_bet"));
        assert_eq!(kind("Placar Exato", "2-1"), None);
        assert_eq!(kind("Handicap Europeu", "Flamengo -1"), None);
        assert_eq!(
            declared_score_period("1º tempo - Total", "Over 0.5", Some("Soccer")),
            MarketPeriod::Ht
        );
        assert!(is_score_resolvable_market(
            "Total de Gols",
            "Over 2.5",
            Some("Soccer"),
            Some("Flamengo vs Palmeiras")
        ));
        assert!(!is_score_resolvable_market(
            "Escanteios",
            "Over 9.5",
            Some("Soccer"),
            None
        ));
    }
}
