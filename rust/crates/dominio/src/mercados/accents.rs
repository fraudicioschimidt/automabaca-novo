//! Grafia acentuada equivalente de um termo do vocabulário de mercados,
//! portado de `src/domain/mercados/accents.ts`. O `contains` do Postgres
//! compara caixa, não diacrítico: todo espelho SQL de uma lista do domínio
//! precisa das duas grafias. As regras de sufixo vêm primeiro porque
//! sobrevivem a termo novo; o mapa cobre o irregular.
//!
//! O TypeScript lia o mapa num objeto comum, e `accentuate("constructor")`
//! devolvia o texto da função `Object` herdada do protótipo. Só listas fixas
//! do vocabulário chegam aqui; o Rust devolve a palavra como está.

use js_regex::{Regex, regex};

const IRREGULAR: [(&str, &str); 9] = [
    ("campea", "campeã"),
    ("hipotese", "hipótese"),
    ("patrimonio", "patrimônio"),
    ("prejuizo", "prejuízo"),
    ("premio", "prêmio"),
    ("serie", "série"),
    ("taca", "taça"),
    ("titulo", "título"),
    ("trofeu", "troféu"),
];

fn word() -> &'static Regex {
    regex!(r"[a-z]+", "g")
}

/// Sufixos regulares do PT. `coe`/`cao` antes de `oe`/`ao` porque a cedilha
/// faz parte da regra; o plural opcional está no próprio padrão.
fn suffix_rules() -> [(&'static Regex, &'static str); 5] {
    [
        (regex!(r"coe(s?)\b", "g"), "çõe$1"),
        (regex!(r"cao\b", "g"), "ção"),
        (regex!(r"oe(s?)\b", "g"), "õe$1"),
        (regex!(r"ao\b", "g"), "ão"),
        (regex!(r"encia(s?)\b", "g"), "ência$1"),
    ]
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all = vec![word()];
    all.extend(suffix_rules().iter().map(|(pattern, _)| *pattern));
    all
}

/// Forma acentuada do termo (idempotente para termos sem acento).
pub fn accentuate(term: &str) -> String {
    let by_word = word().replace_with(term, |found| {
        let word = found.get(0).unwrap_or_default();
        IRREGULAR
            .iter()
            .find(|(plain, _)| *plain == word)
            .map_or(word, |(_, accented)| accented)
            .to_owned()
    });
    suffix_rules()
        .iter()
        .fold(by_word, |text, (pattern, replacement)| {
            pattern.replace(&text, replacement)
        })
}

/// `[termo]` quando não há acento; `[termo, acentuado]` quando há.
pub fn accent_variants(term: &str) -> Vec<String> {
    let accented = accentuate(term);
    if accented == term {
        vec![term.to_owned()]
    } else {
        vec![term.to_owned(), accented]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grafias() {
        assert_eq!(accentuate("finalizacoes"), "finalizações");
        assert_eq!(accentuate("finalizacoe"), "finalizaçõe");
        assert_eq!(accentuate("titulo da serie"), "título da série");
        assert_eq!(accentuate("assistencias"), "assistências");
        assert_eq!(accent_variants("gols"), vec!["gols"]);
    }
}
