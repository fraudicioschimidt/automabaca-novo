//! Nome canônico da casa de apostas, portado de `src/domain/bookmaker.ts`:
//! só marcas conhecidas mudam de grafia; o resto volta como veio.

use crate::js;
use crate::text_normalization::normalize_str;

/// Chave (sem acento, espaço nem pontuação) → grafia canônica.
const CANONICAL_BOOKMAKERS: &[(&str, &str)] = &[
    ("1xbet", "1xBet"),
    ("bet365", "Bet365"),
    ("betano", "Betano"),
    ("betfair", "Betfair"),
    ("betnacional", "Betnacional"),
    ("estrelabet", "EstrelaBet"),
    ("esportesdasorte", "Esportes da Sorte"),
    ("bwin", "Bwin"),
    ("kto", "KTO"),
    ("novibet", "Novibet"),
    ("parimatch", "Parimatch"),
    ("pinnacle", "Pinnacle"),
    ("pixbet", "Pixbet"),
    ("sportingbet", "Sportingbet"),
    ("stake", "Stake"),
    ("superbet", "Superbet"),
    ("rivalo", "Rivalo"),
    ("vaidebet", "VaideBet"),
];

/// Sufixos operacionais de grafia colada ("Betano-VIP", "BetanoPro"):
/// `official` (EN) além de `oficial` (PT); `live`/`tv`/`casino` são CANAIS da
/// mesma casa, não outra marca. A segurança vem da estrutura: só sai se o que
/// sobra é marca do catálogo.
const GLUED_SUFFIXES: &[&str] = &[
    "sportsbook",
    "international",
    "esportes",
    "apostas",
    "exchange",
    "official",
    "sports",
    "online",
    "oficial",
    "premium",
    "casino",
    "express",
    "mobile",
    "global",
    "clube",
    "prime",
    "club",
    "live",
    "lite",
    "plus",
    "pro",
    "vip",
    "app",
    "bet",
    "tv",
    "brasil",
    "br",
];

fn brand_of(key: &str) -> Option<&'static str> {
    CANONICAL_BOOKMAKERS
        .iter()
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, brand)| *brand)
}

/// Chave da marca: sem acento, sem espaço nem pontuação.
fn key_of(name: &str) -> String {
    normalize_str(name)
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// A palavra (sem acento nem pontuação) é uma casa conhecida ("betano", "bet365").
pub fn is_known_bookmaker_key(key: &str) -> bool {
    brand_of(key).is_some()
}

/// O sufixo da lista que o `$` da regex do TS tiraria: o casamento que
/// começa mais cedo, ou seja, o sufixo mais longo.
fn strip_glued_suffix(key: &str) -> &str {
    GLUED_SUFFIXES
        .iter()
        .filter(|suffix| key.ends_with(*suffix))
        .max_by_key(|suffix| suffix.len())
        .map_or(key, |suffix| &key[..key.len() - suffix.len()])
}

/// Normaliza somente marcas conhecidas; nomes desconhecidos preservam a grafia.
pub fn canonicalize_bookmaker_name(value: &str) -> String {
    let trimmed = js::trim(value);
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(brand) = brand_of(&key_of(trimmed)) {
        return brand.to_owned();
    }
    // Sufixo de plano, nível ou canal não cria outra marca. O teste é
    // ESTRUTURAL, não uma lista de palavras: enumerar adjetivos (Oficial, VIP,
    // Pro, Premium, Gold…) não converge. O prefixo de palavras precisa ser uma
    // marca conhecida; casa desconhecida continua preservada por inteiro. O
    // ponto separa palavras como o espaço: "Stake.bet" e "Betano.com" são a
    // marca com o domínio colado.
    let words: Vec<&str> = trimmed
        .split(|c| c == '.' || js::is_whitespace(c))
        .filter(|word| !word.is_empty())
        .collect();
    for take in (1..words.len()).rev() {
        if let Some(brand) = brand_of(&key_of(&words[..take].join(" "))) {
            return brand.to_owned();
        }
    }
    // Grafia colada não tem fronteira de palavra: ali só a lista de sufixos
    // resolve. A remoção é UMA por vez, testando a marca a cada passo: com `+`
    // guloso "pixbetbet" perdia os dois "bet" de uma vez e sobrava "pix".
    let mut key = key_of(trimmed);
    for _ in 0..4 {
        let stripped = strip_glued_suffix(&key);
        if stripped.len() == key.len() || stripped.is_empty() {
            break;
        }
        key = stripped.to_owned();
        if let Some(brand) = brand_of(&key) {
            return brand.to_owned();
        }
    }
    trimmed.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marcas_conhecidas() {
        assert_eq!(canonicalize_bookmaker_name("  BETANO "), "Betano");
        assert_eq!(canonicalize_bookmaker_name("Betano Oficial"), "Betano");
        assert_eq!(canonicalize_bookmaker_name("Stake.bet"), "Stake");
        assert_eq!(canonicalize_bookmaker_name("pixbetbet"), "Pixbet");
        assert_eq!(canonicalize_bookmaker_name("Betano-VIP"), "Betano");
        assert_eq!(canonicalize_bookmaker_name("Casa Nova"), "Casa Nova");
        assert_eq!(canonicalize_bookmaker_name("   "), "");
        // A tabela do TS era um objeto comum: "constructor" achava a função
        // herdada. Aqui a tabela é lida por igualdade e o texto volta.
        assert_eq!(canonicalize_bookmaker_name("constructor"), "constructor");
        assert!(is_known_bookmaker_key("bet365"));
        assert!(!is_known_bookmaker_key("Bet365"));
    }
}
