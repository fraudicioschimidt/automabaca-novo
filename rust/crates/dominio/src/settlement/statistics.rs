//! A família da estatística de TIME que a linha pede (escanteios, cartões,
//! chutes, faltas…), portada das regras de texto de
//! `src/domain/settlement/statistics.ts`. É a fonte do roteamento (o portão
//! que decide se vale chamar a estatística do FlashScore) e da resolução.

use crate::mercados::classify::is_race_to_market;
use crate::mercados::stat_qualifier::{
    is_both_teams_cards_text, selecao_declara_linha_de_estatistica,
};
use crate::settlement::over_under_subject::line_subject_is_not_event_team;
use crate::settlement::player_prop_classify::classificar_prop_de_jogador;
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatisticFamily {
    Corners,
    BookingPoints,
    YellowCards,
    RedCards,
    ShotsTotal,
    ShotsOnTarget,
    Fouls,
    Offsides,
    Saves,
    Interceptions,
    Clearances,
    Assists,
    Blocks,
    Steals,
    Turnovers,
    Rebounds,
    Aces,
    DoubleFaults,
    ThreePointers,
}

use StatisticFamily as S;

impl StatisticFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            S::Corners => "corners",
            S::BookingPoints => "booking_points",
            S::YellowCards => "yellow_cards",
            S::RedCards => "red_cards",
            S::ShotsTotal => "shots_total",
            S::ShotsOnTarget => "shots_on_target",
            S::Fouls => "fouls",
            S::Offsides => "offsides",
            S::Saves => "saves",
            S::Interceptions => "interceptions",
            S::Clearances => "clearances",
            S::Assists => "assists",
            S::Blocks => "blocks",
            S::Steals => "steals",
            S::Turnovers => "turnovers",
            S::Rebounds => "rebounds",
            S::Aces => "aces",
            S::DoubleFaults => "double_faults",
            S::ThreePointers => "three_pointers",
        }
    }

    /// Relações em que uma família é só a versão específica de outra. Fora
    /// delas, mercado e seleção contradizem a unidade e a resposta segura é
    /// `None`, não escolher em silêncio um dos dois textos.
    fn generic(self) -> Option<StatisticFamily> {
        match self {
            S::YellowCards | S::RedCards => Some(S::BookingPoints),
            S::ShotsOnTarget => Some(S::ShotsTotal),
            S::DoubleFaults => Some(S::Fouls),
            _ => None,
        }
    }
}

fn has_any(text: &str, stems: &[&str]) -> bool {
    stems.iter().any(|stem| text.contains(stem))
}

/// Marca de prop de JOGADOR: a estatística do feed é sempre por TIME.
fn prop_de_jogador() -> &'static Regex {
    regex!(
        r"\b(?:player|jogador|jogadora|atleta|scorer|artilheiro|marcador)\b",
        ""
    )
}

fn corners() -> &'static Regex {
    regex!(
        r"\b(corner|corners|escanteio|escanteios|canto|cantos)\b",
        ""
    )
}

fn red_cards() -> &'static Regex {
    regex!(
        r"\b(?:red\s+cards?|cart(?:ao|oes)\s+vermelh[oa]s?|vermelh[oa]s?)\b",
        ""
    )
}

fn yellow_cards() -> &'static Regex {
    regex!(
        r"\b(?:yellow\s+cards?|cart(?:ao|oes)\s+amarel[oa]s?|amarel[oa]s?)\b",
        ""
    )
}

fn booking() -> &'static Regex {
    regex!(
        r"\b(card|cards|booking|bookings|cartao|cartoes|carteos)\b",
        ""
    )
}

fn double_faults() -> &'static Regex {
    regex!(
        r"\b(dupla falta|duplas faltas|double fault|double faults)\b",
        ""
    )
}

fn fouls() -> &'static Regex {
    regex!(r"\b(falta|faltas|foul|fouls)\b", "")
}

fn offsides() -> &'static Regex {
    regex!(r"\b(offside|offsides|impedimento|impedimentos)\b", "")
}

fn saves() -> &'static Regex {
    regex!(r"\b(defesa|defesas|save|saves)\b", "")
}

fn shots() -> &'static Regex {
    regex!(
        r"\b(chute|chutes|shot|shots|finalizacao|finalizacoes|remate|remates)\b",
        ""
    )
}

/// Marca a linha "no gol": é ela que separa chute de chute CERTO.
fn on_target() -> &'static Regex {
    regex!(
        r"\b(?:on\s+(?:target|goal)|ao?\s+gol|no\s+gol|no\s+alvo|a\s+baliza|enquadradas?|enquadrados?|certas?|certos?)\b",
        ""
    )
}

/// Marca explícita de agregado: autoriza a linha de chutes TOTAIS.
fn total_shots() -> &'static Regex {
    regex!(r"\b(?:total|totais|todos|todas)\b", "")
}

fn interceptions() -> &'static Regex {
    regex!(
        r"\b(interception|interceptions|interceptacao|interceptacoes)\b",
        ""
    )
}

fn clearances() -> &'static Regex {
    regex!(
        r"\b(clearance|clearances|corte|cortes|afastamento|afastamentos)\b",
        ""
    )
}

fn assists() -> &'static Regex {
    regex!(r"\b(assistencia|assistencias|assist|assists)\b", "")
}

fn blocks() -> &'static Regex {
    regex!(r"\b(bloqueio|bloqueios|block|blocks|toco|tocos)\b", "")
}

fn steals() -> &'static Regex {
    regex!(r"\b(roubo|roubos|roubada|roubadas|steal|steals)\b", "")
}

fn turnovers() -> &'static Regex {
    regex!(r"\b(turnover|turnovers|perda|perdas)\b", "")
}

fn rebounds() -> &'static Regex {
    regex!(r"\b(rebote|rebotes|rebound|rebounds)\b", "")
}

fn aces() -> &'static Regex {
    regex!(r"\b(ace|aces)\b", "")
}

/// CESTA DE TRÊS: o feed publica `3-point field goals made`. `triple`/
/// `triplo` sozinho fica de fora: "Triple Double" é prop de jogador.
fn three_pointers() -> [&'static Regex; 4] {
    [
        regex!(r"\b(?:3|three|tres)[\s-]*point", ""),
        regex!(r"\bcestas? de (?:3|tres)\b", ""),
        regex!(r"\barremessos? de (?:3|tres)\b", ""),
        regex!(r"\b(?:triplas?|triples)\b", ""),
    ]
}

/// Unidade declarada no texto; sujeito e período são validados por quem
/// chama. Cada pergunta só roda quando o texto tem o radical que toda forma
/// dela exige.
pub fn statistic_family_in_text(raw_text: &str) -> Option<StatisticFamily> {
    let text = normalize_str(raw_text);
    let t = text.as_str();
    let found = |stems: &[&str], pattern: &Regex| has_any(t, stems) && pattern.is_match(t);
    if found(&["corner", "escanteio", "canto"], corners()) {
        return Some(S::Corners);
    }
    // A cor declarada conta AQUELA cor (`booking_points` aplica a fórmula
    // asiática); a cor vem antes do genérico.
    if found(&["red", "vermelh"], red_cards()) {
        return Some(S::RedCards);
    }
    if found(&["yellow", "amarel"], yellow_cards()) {
        return Some(S::YellowCards);
    }
    if found(
        &["card", "booking", "cartao", "cartoe", "carteos"],
        booking(),
    ) {
        return Some(S::BookingPoints);
    }
    // Antes de `fouls`: "duplas faltas" contém "faltas". O termo composto
    // sempre vence o genérico que ele contém.
    if found(&["dupla", "double"], double_faults()) {
        return Some(S::DoubleFaults);
    }
    if found(&["falta", "foul"], fouls()) {
        return Some(S::Fouls);
    }
    if found(&["offside", "impedimento"], offsides()) {
        return Some(S::Offsides);
    }
    if found(&["defesa", "save"], saves()) {
        return Some(S::Saves);
    }
    // CHUTES: "Total de Finalizações" e "Finalizações no Gol" são linhas
    // diferentes do feed; "chutes" solto fica sem família.
    if found(&["chute", "shot", "finalizac", "remate"], shots()) {
        if on_target().is_match(t) {
            return Some(S::ShotsOnTarget);
        }
        if total_shots().is_match(t) {
            return Some(S::ShotsTotal);
        }
        return None;
    }
    if found(&["intercept"], interceptions()) {
        return Some(S::Interceptions);
    }
    if found(&["clearance", "corte", "afastamento"], clearances()) {
        return Some(S::Clearances);
    }
    if found(&["assist"], assists()) {
        return Some(S::Assists);
    }
    if found(&["bloqueio", "block", "toco"], blocks()) {
        return Some(S::Blocks);
    }
    if found(&["roub", "steal"], steals()) {
        return Some(S::Steals);
    }
    if found(&["turnover", "perda"], turnovers()) {
        return Some(S::Turnovers);
    }
    if found(&["rebot", "rebound"], rebounds()) {
        return Some(S::Rebounds);
    }
    if found(&["ace"], aces()) {
        return Some(S::Aces);
    }
    let [point, cesta, arremesso, tripla] = three_pointers();
    if found(&["point"], point)
        || found(&["cesta"], cesta)
        || found(&["arremesso"], arremesso)
        || found(&["tripl"], tripla)
    {
        return Some(S::ThreePointers);
    }
    None
}

fn names_player(text: &str) -> bool {
    has_any(
        text,
        &[
            "player",
            "jogador",
            "atleta",
            "scorer",
            "artilheiro",
            "marcador",
        ],
    ) && prop_de_jogador().is_match(text)
}

/// Família da linha, ou `None` quando o texto não nomeia uma estatística
/// que o settlement saiba ler. A guarda sobre a seleção vive aqui para
/// roteamento e resolução a herdarem: sem ela, "Las Vegas Aces" (time da
/// WNBA) viraria família `aces` num moneyline.
pub fn statistic_family_of(
    market: &str,
    selection: &str,
    evento: Option<&str>,
    esporte: Option<&str>,
) -> Option<StatisticFamily> {
    let market_n = normalize_str(market);
    // Prop de JOGADOR não se resolve pela linha do TIME: 2 amarelos do time
    // pagariam "Player Cards / Over 0.5" de um jogador que talvez nem tenha
    // entrado.
    if classificar_prop_de_jogador(market, selection, evento, esporte).is_some() {
        return None;
    }
    // Recusar a prop não autoriza liquidar pelo time: o prefixo que não é
    // lado do evento não é estatística de equipe.
    if line_subject_is_not_event_team(selection, evento)
        || names_player(&normalize_str(&format!("{market} {selection}")))
    {
        return None;
    }
    // "Race to 3 Corners" pergunta QUEM chega primeiro à marca, não a soma.
    if is_race_to_market(market, selection) {
        return None;
    }
    let pelo_mercado = statistic_family_in_text(&market_n);
    // Pela SELEÇÃO, só quando ela acopla o termo a uma linha: nome de time
    // não declara mercado. Ela pode especializar uma família genérica do
    // mercado (amarelos, chutes no gol, duplas faltas).
    let pela_selecao = if selecao_declara_linha_de_estatistica(selection) {
        statistic_family_in_text(&normalize_str(selection))
    } else {
        None
    };
    let Some(pelo_mercado) = pelo_mercado else {
        return pela_selecao;
    };
    match pela_selecao {
        None => Some(pelo_mercado),
        Some(pela_selecao) if pela_selecao == pelo_mercado => Some(pelo_mercado),
        Some(pela_selecao) if pela_selecao.generic() == Some(pelo_mercado) => Some(pela_selecao),
        // A seleção pode repetir o nome genérico de um mercado já específico.
        Some(pela_selecao) if pelo_mercado.generic() == Some(pela_selecao) => Some(pelo_mercado),
        Some(_) => None,
    }
}

pub fn is_both_teams_cards(market: &str, selection: &str) -> bool {
    is_both_teams_cards_text(&format!("{market} {selection}"))
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all = vec![
        prop_de_jogador(),
        corners(),
        red_cards(),
        yellow_cards(),
        booking(),
        double_faults(),
        fouls(),
        offsides(),
        saves(),
        shots(),
        on_target(),
        total_shots(),
        interceptions(),
        clearances(),
        assists(),
        blocks(),
        steals(),
        turnovers(),
        rebounds(),
        aces(),
    ];
    all.extend(three_pointers());
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    fn family(market: &str, selection: &str) -> Option<&'static str> {
        statistic_family_of(
            market,
            selection,
            Some("Flamengo vs Palmeiras"),
            Some("Soccer"),
        )
        .map(StatisticFamily::as_str)
    }

    #[test]
    fn familia_da_linha() {
        assert_eq!(family("Escanteios", "Over 9.5"), Some("corners"));
        assert_eq!(
            family("Total Cards", "Over 3.5 amarelos"),
            Some("yellow_cards")
        );
        assert_eq!(
            family("Cartões Amarelos", "Over 3.5 cartões"),
            Some("yellow_cards")
        );
        assert_eq!(family("Escanteios", "Over 3.5 cartões"), None);
        assert_eq!(family("Finalizações", "Over 9.5"), None);
        assert_eq!(family("Chutes no gol", "Over 4.5"), Some("shots_on_target"));
        assert_eq!(family("Player Shots", "Pedro over 0.5"), None);
        assert_eq!(family("Race to 3 Corners", "Flamengo"), None);
        assert_eq!(
            statistic_family_in_text("Duplas Faltas"),
            Some(S::DoubleFaults)
        );
        assert_eq!(
            statistic_family_in_text("Total de Cestas de 3"),
            Some(S::ThreePointers)
        );
        assert_eq!(statistic_family_in_text("Triple Double"), None);
    }
}
