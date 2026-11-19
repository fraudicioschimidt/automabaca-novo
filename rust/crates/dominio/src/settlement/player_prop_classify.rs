//! A estatística de JOGADOR que a aposta pede (faltas, chutes, desarmes,
//! cartões, passes…), portada de `src/domain/settlement/player-prop-classify.ts`.
//! Sem nome casável contra o evento, "Bahia over 8.5 faltas" continua faltas
//! de TIME; o artilheiro tem caminho próprio.

use crate::mercados::classify::{MarketPeriod, market_period_of};
use crate::mercados::stat_qualifier::is_both_teams_cards_text;
use crate::settlement::goalscorer::eh_mercado_artilheiro;
use crate::settlement::goalscorer_matching::tokens_da_selecao;
use crate::settlement::over_under_subject::prefixo_antes_da_linha;
use crate::settlement::sides::match_team_side;
use crate::sports::registry::canonical_sport;
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerPropFamily {
    FoulsSuffered,
    FoulsCommitted,
    PassesTotal,
    PassesCompleted,
    ShotsTotal,
    ShotsOnTarget,
    TacklesTotal,
    TacklesWon,
    CardsAny,
    CardsYellow,
    CardsRed,
    Assists,
    Interceptions,
    KeyPasses,
    Offsides,
    SavesTotal,
}

use PlayerPropFamily as F;

/// Família, nome gravado, rótulo final de produto (settlement FlashScore),
/// estatística em PT no singular e no plural, e a chave do FlashScore
/// `player-stats` (`None` em `cards_any`: a casa pode contar amarelo,
/// vermelho direto e segundo amarelo de formas distintas, e sem contrato por
/// casa a prop genérica permanece manual).
type FamilyRow = (
    PlayerPropFamily,
    &'static str,
    &'static str,
    (&'static str, &'static str),
    Option<&'static str>,
);

pub const FAMILIES: [FamilyRow; 16] = [
    (
        F::FoulsSuffered,
        "fouls_suffered",
        "Player Fouls Suffered",
        ("falta sofrida", "faltas sofridas"),
        Some("FOULS_SUFFERED"),
    ),
    (
        F::FoulsCommitted,
        "fouls_committed",
        "Player Fouls",
        ("falta", "faltas"),
        Some("FOULS_COMMITTED"),
    ),
    (
        F::PassesTotal,
        "passes_total",
        "Player Passes",
        ("passe", "passes"),
        Some("PASSES_TOTAL"),
    ),
    (
        F::PassesCompleted,
        "passes_completed",
        "Player Passes Completed",
        ("passe certo", "passes certos"),
        Some("PASSES_ACCURATE"),
    ),
    (
        F::ShotsTotal,
        "shots_total",
        "Player Shots",
        ("chute", "chutes"),
        Some("SHOTS_TOTAL"),
    ),
    (
        F::ShotsOnTarget,
        "shots_on_target",
        "Player Shots on Target",
        ("chute no gol", "chutes no gol"),
        Some("SHOTS_ON_TARGET"),
    ),
    (
        F::TacklesTotal,
        "tackles_total",
        "Player Tackles",
        ("desarme", "desarmes"),
        Some("TACKLES_TOTAL"),
    ),
    (
        F::TacklesWon,
        "tackles_won",
        "Player Tackles Won",
        ("desarme ganho", "desarmes ganhos"),
        Some("TACKLES_WON"),
    ),
    (
        F::CardsAny,
        "cards_any",
        "Player Cards",
        ("cartão", "cartões"),
        None,
    ),
    (
        F::CardsYellow,
        "cards_yellow",
        "Player Yellow Cards",
        ("cartão amarelo", "cartões amarelos"),
        Some("CARDS_YELLOW"),
    ),
    (
        F::CardsRed,
        "cards_red",
        "Player Red Cards",
        ("cartão vermelho", "cartões vermelhos"),
        Some("CARDS_RED"),
    ),
    (
        F::Assists,
        "assists",
        "Player Assists",
        ("assistência", "assistências"),
        Some("ASSISTS_GOAL"),
    ),
    (
        F::Interceptions,
        "interceptions",
        "Player Interceptions",
        ("interceptação", "interceptações"),
        Some("INTERCEPTIONS"),
    ),
    (
        F::KeyPasses,
        "key_passes",
        "Player Key Passes",
        ("passe-chave", "passes-chave"),
        Some("KEY_PASSES"),
    ),
    (
        F::Offsides,
        "offsides",
        "Player Offsides",
        ("impedimento", "impedimentos"),
        Some("OFFSIDES"),
    ),
    (
        F::SavesTotal,
        "saves_total",
        "Player Saves",
        ("defesa", "defesas"),
        Some("SAVES_TOTAL"),
    ),
];

fn row(family: PlayerPropFamily) -> &'static FamilyRow {
    FAMILIES
        .iter()
        .find(|row| row.0 == family)
        .unwrap_or(&FAMILIES[0])
}

impl PlayerPropFamily {
    pub fn as_str(self) -> &'static str {
        row(self).1
    }

    pub fn mercado(self) -> &'static str {
        row(self).2
    }

    /// A chave do FlashScore `player-stats`; ausência da chave ≠ 0: falha
    /// fechado, não inventa zero.
    pub fn stat_key(self) -> Option<&'static str> {
        row(self).4
    }

    /// A chave como o registro grava: as três de cartão em `cards_any`.
    pub fn chave(self) -> &'static str {
        self.stat_key()
            .unwrap_or("CARDS_YELLOW|CARDS_RED|CARDS_YELLOW_SECOND")
    }

    pub fn from_name(name: &str) -> Option<Self> {
        FAMILIES.iter().find(|row| row.1 == name).map(|row| row.0)
    }
}

/// A estatística da prop em PT, concordando com o valor ("chutes no gol").
/// A família chega de JSON gravado: a desconhecida volta crua.
pub fn prop_stat_label(family: &str, value: f64) -> String {
    match PlayerPropFamily::from_name(family) {
        Some(family) => {
            let (singular, plural) = row(family).3;
            if value.abs() == 1.0 { singular } else { plural }.to_owned()
        }
        None => family.to_owned(),
    }
}

fn has_any(text: &str, stems: &[&str]) -> bool {
    stems.iter().any(|stem| text.contains(stem))
}

/// O rótulo de mercado da prop, na ordem: a frase mais específica antes.
fn mercado_canonico() -> [(&'static Regex, PlayerPropFamily); 16] {
    [
        (
            regex!(r"\bplayer passes completed\b", ""),
            F::PassesCompleted,
        ),
        (regex!(r"\bplayer passes\b", ""), F::PassesTotal),
        (regex!(r"\bplayer tackles won\b", ""), F::TacklesWon),
        (regex!(r"\bplayer yellow cards?\b", ""), F::CardsYellow),
        (regex!(r"\bplayer red cards?\b", ""), F::CardsRed),
        (
            regex!(r"\bplayer fouls suffered\b|\bfaltas sofridas\b", ""),
            F::FoulsSuffered,
        ),
        (
            regex!(r"\bplayer fouls\b|\bfaltas d[oa] jogador", ""),
            F::FoulsCommitted,
        ),
        (
            regex!(
                r"\bplayer shots on target\b|\bchutes no gol d[oa] jogador",
                ""
            ),
            F::ShotsOnTarget,
        ),
        (
            regex!(r"\bplayer shots\b|\bchutes d[oa] jogador", ""),
            F::ShotsTotal,
        ),
        (
            regex!(r"\bplayer tackles\b|\bdesarmes d[oa] jogador", ""),
            F::TacklesTotal,
        ),
        (
            regex!(r"\bplayer cards\b|\bcartoes? d[oa] jogador", ""),
            F::CardsAny,
        ),
        (
            regex!(r"\bplayer assists\b|\bassistencias? d[oa] jogador", ""),
            F::Assists,
        ),
        (
            regex!(
                r"\bplayer interceptions?\b|\bintercepta(?:cao|coes) d[oa] jogador",
                ""
            ),
            F::Interceptions,
        ),
        (
            regex!(
                r"\bplayer key passes?\b|\bpasses? (?:chave|decisivos?) d[oa] jogador",
                ""
            ),
            F::KeyPasses,
        ),
        (
            regex!(r"\bplayer offsides?\b|\bimpedimentos? d[oa] jogador", ""),
            F::Offsides,
        ),
        (
            regex!(
                r"\bplayer saves?\b|\bdefesas? d[oa] (?:jogador|goleir[oa])",
                ""
            ),
            F::SavesTotal,
        ),
    ]
}

/// Todo rótulo canônico passa por um destes trechos.
fn canonical_family(mercado_n: &str) -> Option<PlayerPropFamily> {
    if !has_any(
        mercado_n,
        &["player", "jogador", "goleir", "faltas sofridas"],
    ) {
        return None;
    }
    mercado_canonico()
        .into_iter()
        .find(|(pattern, _)| pattern.is_match(mercado_n))
        .map(|(_, family)| family)
}

fn prop_de_jogador() -> &'static Regex {
    regex!(r"\b(?:player|jogador|jogadora|atleta)\b", "")
}

fn names_player(text: &str) -> bool {
    has_any(text, &["player", "jogador", "atleta"]) && prop_de_jogador().is_match(text)
}

fn fouls_suffered() -> [&'static Regex; 3] {
    [
        regex!(
            r"\b(?:sofre|sofrida|sofridas|suffered)\s+(?:falta|faltas|foul|fouls)\b",
            ""
        ),
        regex!(
            r"\b(?:falta|faltas|foul|fouls)\s+(?:sofrida|sofridas|suffered)\b",
            ""
        ),
        regex!(r"\bfouls?\s+suffered\b", ""),
    ]
}

fn fouls_committed() -> [&'static Regex; 3] {
    [
        regex!(
            r"\b(?:comete|cometida|cometidas|committed)\s+(?:falta|faltas|foul|fouls)\b",
            ""
        ),
        regex!(
            r"\b(?:falta|faltas|foul|fouls)\s+(?:cometida|cometidas|committed)\b",
            ""
        ),
        regex!(r"\bfouls?\s+committed\b", ""),
    ]
}

fn shot_word() -> &'static Regex {
    regex!(
        r"\b(?:remate|remates|chute|chutes|shot|shots|finalizacao|finalizacoes)\b",
        ""
    )
}

fn on_target() -> &'static Regex {
    regex!(
        r"\b(?:on\s+(?:target|goal)|ao?\s+gol|no\s+gol|no\s+alvo|a\s+baliza|a\s+porta)\b",
        ""
    )
}

fn tackle_word() -> &'static Regex {
    regex!(r"\b(?:desarme|desarmes|tackle|tackles)\b", "")
}

fn won_word() -> &'static Regex {
    regex!(r"\b(?:ganho|ganhos|certo|certos|won)\b", "")
}

fn card_word() -> &'static Regex {
    regex!(r"\b(?:cartao|cartoes|card|cards|booking|bookings)\b", "")
}

fn red_word() -> &'static Regex {
    regex!(r"\b(?:red|vermelh[oa]s?)\b", "")
}

fn yellow_word() -> &'static Regex {
    regex!(r"\b(?:yellow|amarel[oa]s?)\b", "")
}

fn assist_word() -> &'static Regex {
    regex!(r"\b(?:assistencia|assistencias|assist|assists)\b", "")
}

fn interception_word() -> &'static Regex {
    regex!(
        r"\b(?:interceptacao|interceptacoes|interception|interceptions)\b",
        ""
    )
}

fn key_pass_word() -> &'static Regex {
    regex!(
        r"\b(?:key\s+passes?|passes?\s+chave|passes?\s+decisivos?)\b",
        ""
    )
}

fn offside_word() -> &'static Regex {
    regex!(r"\b(?:impedimento|impedimentos|offside|offsides)\b", "")
}

fn save_word() -> &'static Regex {
    regex!(r"\b(?:defesa|defesas|save|saves)\b", "")
}

fn pass_word() -> &'static Regex {
    regex!(r"\b(?:passe|passes)\b", "")
}

fn completed_word() -> &'static Regex {
    regex!(
        r"\b(?:completo|completos|certo|certos|completed|accurate)\b",
        ""
    )
}

fn foul_word() -> &'static Regex {
    regex!(r"\b(?:falta|faltas|foul|fouls)\b", "")
}

fn committed_word() -> &'static Regex {
    regex!(r"\b(?:comete|cometida|cometidas|committed)\b", "")
}

fn any_match(patterns: &[&Regex], text: &str) -> bool {
    patterns.iter().any(|pattern| pattern.is_match(text))
}

/// A família no texto normalizado. Cada pergunta só roda quando o texto tem
/// o radical que toda forma dela exige.
fn familia_no_texto(text: &str) -> Option<PlayerPropFamily> {
    let foul = has_any(text, &["falta", "foul"]);
    if foul && any_match(&fouls_suffered(), text) {
        return Some(F::FoulsSuffered);
    }
    if foul && any_match(&fouls_committed(), text) {
        return Some(F::FoulsCommitted);
    }
    if has_any(text, &["remate", "chute", "shot", "finalizac"]) && shot_word().is_match(text) {
        return Some(if on_target().is_match(text) {
            F::ShotsOnTarget
        } else {
            F::ShotsTotal
        });
    }
    if has_any(text, &["desarme", "tackle"]) && tackle_word().is_match(text) {
        return Some(if won_word().is_match(text) {
            F::TacklesWon
        } else {
            F::TacklesTotal
        });
    }
    if has_any(text, &["cartao", "cartoes", "card", "booking"]) && card_word().is_match(text) {
        if red_word().is_match(text) {
            return Some(F::CardsRed);
        }
        if yellow_word().is_match(text) {
            return Some(F::CardsYellow);
        }
        return Some(F::CardsAny);
    }
    if text.contains("assist") && assist_word().is_match(text) {
        return Some(F::Assists);
    }
    if text.contains("intercept") && interception_word().is_match(text) {
        return Some(F::Interceptions);
    }
    if text.contains("pass") && key_pass_word().is_match(text) {
        return Some(F::KeyPasses);
    }
    if has_any(text, &["impedimento", "offside"]) && offside_word().is_match(text) {
        return Some(F::Offsides);
    }
    if has_any(text, &["defesa", "save"]) && save_word().is_match(text) {
        return Some(F::SavesTotal);
    }
    if text.contains("passe") && pass_word().is_match(text) {
        return Some(if completed_word().is_match(text) {
            F::PassesCompleted
        } else {
            F::PassesTotal
        });
    }
    if foul && foul_word().is_match(text) {
        return Some(F::FoulsCommitted);
    }
    None
}

fn especializa(base: PlayerPropFamily, detalhe: PlayerPropFamily) -> bool {
    matches!(
        (base, detalhe),
        (F::PassesTotal, F::PassesCompleted)
            | (F::ShotsTotal, F::ShotsOnTarget)
            | (F::TacklesTotal, F::TacklesWon)
            | (F::CardsAny, F::CardsYellow | F::CardsRed)
    )
}

fn contradiz(a: PlayerPropFamily, b: PlayerPropFamily) -> bool {
    !(a == b || especializa(a, b) || especializa(b, a))
}

fn both_teams() -> &'static Regex {
    regex!(
        r"\b(?:both teams|ambas(?: as equipes)?|ambos(?: os times)?)\b",
        ""
    )
}

/// A prop classificada: a família, o rótulo final e o período, quando não é
/// o jogo inteiro (períodos parciais ficam explícitos e são recusados).
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerPropClassificacao {
    pub family: PlayerPropFamily,
    pub period: Option<MarketPeriod>,
}

/// A seleção/mercado pede uma estatística de JOGADOR? `esporte` `None` é o
/// esporte não informado; informado, só o futebol (o endpoint e as chaves
/// desta fase são contrato medido apenas no futebol).
pub fn classificar_prop_de_jogador(
    mercado: &str,
    selecao: &str,
    evento: Option<&str>,
    esporte: Option<&str>,
) -> Option<PlayerPropClassificacao> {
    if eh_mercado_artilheiro(mercado, None) {
        return None;
    }
    if let Some(esporte) = esporte
        && canonical_sport(esporte) != Some("Soccer")
    {
        return None;
    }
    let mercado_n = normalize_str(mercado);
    let selecao_n = normalize_str(selecao);
    let combinado = format!("{mercado_n} {selecao_n}");
    // Mercado coletivo conhecido vem antes da heurística de nome: "Both Teams"
    // não é atleta e cada lado atingir a linha não é soma individual.
    if is_both_teams_cards_text(&combinado)
        || (has_any(&combinado, &["both teams", "ambas", "ambos"])
            && both_teams().is_match(&combinado))
    {
        return None;
    }
    let canonico = canonical_family(&mercado_n);
    let pela_selecao = familia_no_texto(&selecao_n);
    let pelo_mercado_jogador = if names_player(&mercado_n) {
        familia_no_texto(&mercado_n)
    } else {
        None
    };
    let mut family = canonico.or(pelo_mercado_jogador).or(pela_selecao)?;
    for evidence in [pelo_mercado_jogador, pela_selecao].into_iter().flatten() {
        if contradiz(family, evidence) {
            return None;
        }
        if especializa(family, evidence) {
            family = evidence;
        }
    }

    let evento = evento.filter(|evento| !evento.is_empty());
    let marcado_como_jogador = canonico.is_some() || names_player(&combinado);
    let prefixo = prefixo_antes_da_linha(selecao);
    let prefixo_e_time = match (&prefixo, evento) {
        (Some(prefixo), Some(evento)) => match_team_side(prefixo, evento).is_some(),
        _ => false,
    };
    if prefixo_e_time && !marcado_como_jogador {
        return None;
    }
    let sofre_ou_comete = family == F::FoulsSuffered
        || (family == F::FoulsCommitted
            && has_any(&combinado, &["comet", "committed"])
            && committed_word().is_match(&combinado));
    // Nome de jogador na forma tipster: "Fulano over 0.5 …". Sem a direção, o
    // texto antes do número é rótulo de mercado, não um atleta.
    let prefixo_e_stat = prefixo.as_deref().and_then(familia_no_texto).is_some();
    let tem_nome_de_jogador = prefixo.is_some()
        && !prefixo_e_time
        && !prefixo_e_stat
        && !tokens_da_selecao(selecao).is_empty();
    if !marcado_como_jogador && !sofre_ou_comete && !tem_nome_de_jogador {
        return None;
    }
    // Sem evento, nome+faltas não distingue "Emmanuel Martinez" de
    // "Flamengo": sem evento só a marca explícita vale.
    if !marcado_como_jogador && !sofre_ou_comete && evento.is_none() {
        return None;
    }
    let period = market_period_of(&format!("{mercado} {selecao}"), esporte);
    Some(PlayerPropClassificacao {
        family,
        period: (period != MarketPeriod::Ft).then_some(period),
    })
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all: Vec<&'static Regex> = mercado_canonico()
        .iter()
        .map(|(pattern, _)| *pattern)
        .collect();
    all.extend(fouls_suffered());
    all.extend(fouls_committed());
    all.extend([
        prop_de_jogador(),
        shot_word(),
        on_target(),
        tackle_word(),
        won_word(),
        card_word(),
        red_word(),
        yellow_word(),
        assist_word(),
        interception_word(),
        key_pass_word(),
        offside_word(),
        save_word(),
        pass_word(),
        completed_word(),
        foul_word(),
        committed_word(),
        both_teams(),
    ]);
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    fn family(mercado: &str, selecao: &str, evento: Option<&str>) -> Option<&'static str> {
        classificar_prop_de_jogador(mercado, selecao, evento, Some("Soccer"))
            .map(|c| c.family.as_str())
    }

    #[test]
    fn classifica_a_prop() {
        let evento = Some("Flamengo vs Palmeiras");
        assert_eq!(
            family("Player Shots on Target", "Pedro over 0.5", evento),
            Some("shots_on_target")
        );
        assert_eq!(
            family("Total", "Pedro over 0.5 chutes no gol", evento),
            Some("shots_on_target")
        );
        assert_eq!(family("Total", "Flamengo over 8.5 faltas", evento), None);
        assert_eq!(
            family("Total", "Willian José over 0,5 sofre falta", evento),
            Some("fouls_suffered")
        );
        assert_eq!(family("Anytime Goalscorer", "Pedro", evento), None);
        assert_eq!(family("Both Teams Cards", "Over 2.5", evento), None);
        assert_eq!(
            classificar_prop_de_jogador(
                "Player Shots",
                "Pedro over 0.5",
                evento,
                Some("Basketball")
            ),
            None
        );
        assert_eq!(prop_stat_label("shots_on_target", 1.0), "chute no gol");
        assert_eq!(prop_stat_label("shots_on_target", 2.0), "chutes no gol");
        assert_eq!(prop_stat_label("desconhecida", 2.0), "desconhecida");
        assert_eq!(F::CardsAny.stat_key(), None);
        assert_eq!(
            F::CardsAny.chave(),
            "CARDS_YELLOW|CARDS_RED|CARDS_YELLOW_SECOND"
        );
    }
}
