//! Catálogo de mercados, portado de `src/domain/mercados/catalog.ts`: os
//! rótulos finais (os da Pinnacle, de `catalog-data.json`), os intermediários
//! que a captura ainda aceita e as traduções diretas PT/legado.

use crate::js;
use crate::text_normalization::normalize_str;
use std::collections::HashMap;
use std::sync::LazyLock;

/// Um alias do mercado e, quando o rótulo é de uma casa só, a casa.
pub type MercadoAlias = (&'static str, Option<&'static str>);

include!(concat!(env!("OUT_DIR"), "/catalog_data.rs"));

/// Intermediários sport-aware (`Asian Handicap`, `Total`, `Moneyline`): aceitos
/// para o finalize mapear por esporte; a Config lista só os finais.
pub const MERCADOS_INTERMEDIARIOS: &[&str] = &[
    "Asian Handicap",
    "Asian Handicap Cards",
    "Asian Handicap Corners",
    "Asian Total Cards",
    "Asian Total Corners",
    "1st Half Asian Corners",
    "Cards",
    "Cards O/U",
    "Corners",
    "Corners O/U",
    "Total",
    "Total Cards",
    "Moneyline",
    "Draw No Bet",
    "Player Props",
    "Player Points/Rebounds/Assists",
    "Player Points",
    "Player Rebounds",
    "Player Assists",
    "Shots",
    "Shots On Target",
];

/// Traduções diretas PT/legado → intermediário ou final (defensivas), na ordem
/// do TypeScript: com duas chaves iguais depois de normalizadas, vale a última.
pub const MERCADO_TRANSLATIONS: &[(&str, &str)] = &[
    ("Total – Partida", "Total"),
    ("Resultado Final", "Moneyline"),
    ("Para Ganhar", "Moneyline"),
    ("Para Ganhar a Partida", "Moneyline"),
    ("Para Vencer a Partida", "Moneyline"),
    ("Mais/Menos", "Total"),
    ("Total de Pontos", "Total Points"),
    ("Gols + -", "Total"),
    ("Gols +-", "Total"),
    ("Gols +/-", "Total"),
    ("Gols Mais/Menos", "Total"),
    ("Gols Acima/Abaixo", "Total"),
    ("Handicap Asiático", "Asian Handicap"),
    ("Handicap Asiatico", "Asian Handicap"),
    ("Hándicap Asiático", "Asian Handicap"),
    ("Handicap Asiático - Cartões", "Asian Handicap Cards"),
    ("Handicap Asiático de Cartões", "Asian Handicap Cards"),
    ("Handicap Asiático - Escanteios", "Asian Handicap Corners"),
    ("Handicap Asiático de Escanteios", "Asian Handicap Corners"),
    ("Handicap (incl. entradas extras)", "Asian Handicap"),
    ("Handicap (incl. extra innings)", "Asian Handicap"),
    ("Ambas Marcam", "Both Teams to Score"),
    ("Ambos Marcam", "Both Teams to Score"),
    ("Ambas Equipes Marcam", "Both Teams to Score"),
    ("Gol/Gol", "Both Teams to Score"),
    ("Both Score", "Both Teams to Score"),
    ("Chance Dupla", "Double Chance"),
    ("Double Chance – Match", "Double Chance"),
    ("Double Chance - Match", "Double Chance"),
    ("Empate Anula a Aposta", "Draw No Bet"),
    ("Empate Anula", "Draw No Bet"),
    ("Aposta Sem Empate", "Draw No Bet"),
    ("Sem Empate", "Draw No Bet"),
    ("Tie No Bet", "Draw No Bet"),
    ("Handicap - Partida", "Asian Handicap"),
    ("Handicap (Soccer) – Match", "Asian Handicap"),
    ("Handicap (Asian) - Match", "Asian Handicap"),
    ("Asian Handicap (Bookings) – Match", "Asian Handicap Cards"),
    ("Handicap da Partida", "Asian Handicap"),
    ("Handicap - 2 Opções", "Asian Handicap"),
    ("Handicap - 2 Opcoes", "Asian Handicap"),
    ("Handicap 2 Opções", "Asian Handicap"),
    ("Handicap 2 Opcoes", "Asian Handicap"),
    ("Handicap 2 Vias", "Asian Handicap"),
    ("Handicap - 2 Vias", "Asian Handicap"),
    ("Handicap de Rounds da Partida", "Asian Handicap"),
    ("Handicap de Rounds", "Asian Handicap"),
    ("Total de Rounds da Partida", "Total"),
    ("Total de Rounds", "Total"),
    ("Total (Gols) – Match", "Total"),
    ("Total de Gols", "Total"),
    ("Goal Line", "Total"),
    ("Linha de Gols", "Total"),
    ("Linha de Gol", "Total"),
    ("Asian Goal Line", "Total"),
    ("Goal Line Asiático", "Total"),
    ("Goal Line Asiatico", "Total"),
    ("Linha de Escanteios", "Corners"),
    ("Total de Escanteios", "Corners"),
    ("Mais/Menos Escanteios", "Corners"),
    ("Over/Under Escanteios", "Corners"),
    ("Asian Corners", "Total (Corners) – Match"),
    ("Linha de Cartões", "Cards"),
    ("Linha de Cartoes", "Cards"),
    ("1st Half Total Corners", "Total (Corners) – 1st Half"),
    ("1º Tempo - Total Escanteios", "Total (Corners) – 1st Half"),
    ("Handicap de Pontos", "Asian Handicap"),
    ("Marcar a Qualquer Momento", "Anytime Goalscorer"),
    ("Para Marcar a Qualquer Momento", "Anytime Goalscorer"),
    ("Primeiro a Marcar", "First Goalscorer"),
    ("Primeiro Marcador", "First Goalscorer"),
    ("Último a Marcar", "Last Goalscorer"),
    ("Ultimo a Marcar", "Last Goalscorer"),
    ("Último Marcador", "Last Goalscorer"),
    ("Ultimo Marcador", "Last Goalscorer"),
    ("Resultado Intervalo", "Money Line – 1st Half"),
    ("1st Half Moneyline", "Money Line – 1st Half"),
    ("1st Half Handicap", "Handicap – 1st Half"),
    ("1st Half Total", "Total – 1st Half"),
    ("Half Time Result", "Money Line – 1st Half"),
    ("Total de Cartões", "Total (Bookings) – Match"),
    ("Total do Time", "Team Total"),
    ("Total de Gols do Time", "Team Total"),
    ("Total da Equipe", "Team Total"),
    ("Time 1 - Total", "Team Total"),
    ("Time 1 Total", "Team Total"),
    ("Time 2 - Total", "Team Total"),
    ("Time 2 Total", "Team Total"),
    ("Time da Casa - Total", "Team Total"),
    ("Time Visitante - Total", "Team Total"),
    ("Cartões", "Cards"),
    ("Escanteios", "Corners"),
    ("Placar Exato", "Correct Score"),
    ("1º Tempo - Para Ganhar", "Money Line – 1st Half"),
    ("1º Tempo - Totais", "Total – 1st Half"),
    ("1T Totais", "Total – 1st Half"),
    ("1T - Totais", "Total – 1st Half"),
    ("Totais 1T", "Total – 1st Half"),
    ("Primeiro mapa - total kills", "Total (Kills) – Map 1"),
    ("Segundo mapa - total kills", "Total (Kills) – Map 2"),
    ("Terceiro mapa - total kills", "Total (Kills) – Map 3"),
    ("Quarto mapa - total kills", "Total (Kills) – Map 4"),
    ("Quinto mapa - total kills", "Total (Kills) – Map 5"),
    ("1º mapa - total kills", "Total (Kills) – Map 1"),
    ("2º mapa - total kills", "Total (Kills) – Map 2"),
    ("3º mapa - total kills", "Total (Kills) – Map 3"),
    ("4º mapa - total kills", "Total (Kills) – Map 4"),
    ("5º mapa - total kills", "Total (Kills) – Map 5"),
    ("anytime", "Anytime Goalscorer"),
    ("anytime goalscorer", "Anytime Goalscorer"),
    ("any 1° gol", "First Goalscorer"),
    ("any 1º gol", "First Goalscorer"),
    ("any 1o gol", "First Goalscorer"),
    ("1° gol", "First Goalscorer"),
    ("1º gol", "First Goalscorer"),
    ("1o gol", "First Goalscorer"),
    ("primeiro gol", "First Goalscorer"),
    ("deaths", "Player Props"),
    ("kills", "Player Props"),
    ("abates", "Player Props"),
    ("mortes", "Player Props"),
    ("deaths ht", "Player Props"),
    ("deaths HT", "Player Props"),
    ("kills ht", "Player Props"),
    ("kills HT", "Player Props"),
    ("player kills", "Player Props"),
    ("player deaths", "Player Props"),
    ("P + A + R", "Player Points/Rebounds/Assists"),
    ("p + a + r", "Player Points/Rebounds/Assists"),
    ("P+A+R", "Player Points/Rebounds/Assists"),
    ("p+a+r", "Player Points/Rebounds/Assists"),
    ("PRA", "Player Points/Rebounds/Assists"),
    ("pra", "Player Points/Rebounds/Assists"),
    (
        "pontos + rebotes + assistências",
        "Player Points/Rebounds/Assists",
    ),
    (
        "pontos + rebotes + assistencias",
        "Player Points/Rebounds/Assists",
    ),
    ("pontos", "Player Points"),
    ("rebotes", "Player Rebounds"),
    ("ass", "Player Assists"),
    ("assist", "Player Assists"),
    ("assists", "Player Assists"),
    ("assistência", "Player Assists"),
    ("assistencias", "Player Assists"),
    ("assistências", "Player Assists"),
    ("player assists", "Player Assists"),
    ("chutes", "Shots"),
    ("chutes do jogador", "Shots"),
    ("finalizacoes", "Shots"),
    ("finalizações", "Shots"),
    ("player shots", "Shots"),
    ("chutes ao gol", "Shots On Target"),
    ("chutes no gol", "Shots On Target"),
    ("chutes a gol", "Shots On Target"),
    ("finalizacoes no alvo", "Shots On Target"),
    ("finalizações no alvo", "Shots On Target"),
    ("player shots on target", "Shots On Target"),
    ("2+ gols", "To Score 2+ Goals"),
    ("marcar 2+ gols", "To Score 2+ Goals"),
    ("marcar 2 ou mais gols", "To Score 2+ Goals"),
    ("to score 2+ goals", "To Score 2+ Goals"),
    ("3+ gols", "To Score 3+ Goals"),
    ("marcar 3+ gols", "To Score 3+ Goals"),
    ("marcar 3 ou mais gols", "To Score 3+ Goals"),
    ("to score 3+ goals", "To Score 3+ Goals"),
    ("hat-trick", "To Score 3+ Goals"),
    ("to score a hat-trick", "To Score 3+ Goals"),
];

/// Rótulos FINAIS, na ordem do catálogo.
pub fn mercados_finais() -> impl Iterator<Item = &'static str> {
    MERCADO_CATALOG.iter().map(|(name, _)| *name)
}

/// Tudo que `resolve_mercado_static` aceita: entrada + final.
pub fn canonical_markets() -> impl Iterator<Item = &'static str> {
    MERCADOS_INTERMEDIARIOS
        .iter()
        .copied()
        .chain(mercados_finais())
}

/// Chave de lookup de alias: minúsculo, sem acento, só `[a-z0-9]` e espaço.
pub fn normalize_mercado_key(text: &str) -> String {
    let normalized = normalize_str(text);
    let mut key = String::with_capacity(normalized.len());
    let mut in_run = false;
    for c in normalized.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            key.push(c);
            in_run = false;
        } else if !in_run {
            key.push(' ');
            in_run = true;
        }
    }
    js::trim(&key).to_owned()
}

/// `new Map(pares)`: com chave repetida, vale a última.
fn by_key<'a>(pairs: impl Iterator<Item = (String, &'a str)>) -> HashMap<String, &'a str> {
    pairs.collect()
}

static CANONICAL_BY_KEY: LazyLock<HashMap<String, &'static str>> = LazyLock::new(|| {
    by_key(canonical_markets().map(|market| (normalize_mercado_key(market), market)))
});
static TRANSLATION_BY_KEY: LazyLock<HashMap<String, &'static str>> = LazyLock::new(|| {
    by_key(
        MERCADO_TRANSLATIONS
            .iter()
            .map(|(from, to)| (normalize_mercado_key(from), *to)),
    )
});

/// Resolve apenas nomes canônicos, sem aliases nem traduções.
pub fn resolve_mercado_canonical(raw: &str) -> Option<&'static str> {
    let key = normalize_mercado_key(raw);
    if key.is_empty() {
        return None;
    }
    CANONICAL_BY_KEY.get(&key).copied()
}

/// Resolve direto contra catálogo + traduções estáticas (sem banco).
pub fn resolve_mercado_static(raw: &str) -> Option<&'static str> {
    let key = normalize_mercado_key(raw);
    if key.is_empty() {
        return None;
    }
    resolve_mercado_canonical(raw).or_else(|| TRANSLATION_BY_KEY.get(&key).copied())
}

/// O mercado gravado está no vocabulário canônico Pinnacle?
pub fn is_mercado_final(mercado: &str) -> bool {
    let key = normalize_mercado_key(mercado);
    mercados_finais().any(|market| normalize_mercado_key(market) == key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolucao() {
        assert_eq!(
            normalize_mercado_key("  Handicap – 1º Tempo! "),
            "handicap 1 tempo"
        );
        assert_eq!(resolve_mercado_static("Resultado Final"), Some("Moneyline"));
        assert_eq!(
            resolve_mercado_static("asian handicap"),
            Some("Asian Handicap")
        );
        assert!(is_mercado_final("Both Teams to Score"));
        assert!(!is_mercado_final("Total"));
        assert_eq!(resolve_mercado_static("   "), None);
    }
}
