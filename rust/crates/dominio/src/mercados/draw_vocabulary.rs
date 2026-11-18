//! Vocabulário único de Draw No Bet e Dupla Chance, como dados, portado de
//! `src/domain/mercados/draw-vocabulary.ts`.
//!
//! Três bordas precisam da mesma lista: o classificador de mercado, a limpeza
//! de prefixo/sufixo da seleção e a allowlist SQL do lote de liquidação.
//! Grafia presente em só duas delas deixa a aposta classificada mas fora do
//! lote, pendente para sempre sem alerta. Por isso a regex e os termos SQL são
//! construídos destas listas, e grafia nova entra num lugar só.

use super::accents::accent_variants;
use crate::js;
use js_regex::Regex;
use std::sync::LazyLock;

pub struct DrawNoBetVocabulary {
    /// Rótulos que já significam DNB sozinhos.
    pub standalone: &'static [&'static str],
    /// Siglas: no SQL usam limite de token, nunca `contains` amplo.
    pub abbreviations: &'static [&'static str],
    /// "Empate <verbo> [objeto]".
    pub verbs: &'static [&'static str],
    pub objects: &'static [&'static str],
    /// "Empate <estado>".
    pub states: &'static [&'static str],
    /// "<substantivo> [do valor] <conector> empate".
    pub nouns: &'static [&'static str],
    pub noun_qualifiers: &'static [&'static str],
    pub connectors: &'static [&'static str],
}

pub struct DoubleChanceVocabulary {
    pub standalone: &'static [&'static str],
    pub abbreviations: &'static [&'static str],
    /// Combina com "dupla" nas duas ordens ("Dupla Chance"/"Chance Dupla").
    pub terms: &'static [&'static str],
}

pub const DRAW_NO_BET_VOCABULARY: DrawNoBetVocabulary = DrawNoBetVocabulary {
    standalone: &[
        "draw no bet",
        "tie no bet",
        "aposta sem empate",
        "sem empate",
    ],
    abbreviations: &["dnb"],
    verbs: &["anula", "devolve", "reembolsa", "estorna", "cancela"],
    objects: &[
        "a aposta",
        "aposta",
        "o valor",
        "o investimento",
        "o dinheiro",
        "o capital",
        "o saldo",
        "saldo",
        "o patrimonio",
        "patrimonio",
        "o montante",
        "montante",
        "a verba",
        "verba",
        "a bet",
        "bet",
    ],
    // "Empate sem risco" é DNB; "APOSTA sem risco" é promoção de free bet e
    // não casa aqui porque o estado só vale depois da palavra "empate".
    states: &[
        "nulo",
        "nao tem aposta",
        "nao conta",
        "nao vale",
        "sem aposta",
        "sem risco",
        "sem prejuizo",
        "sem perdas",
    ],
    nouns: &["reembolso", "devolucao", "estorno"],
    noun_qualifiers: &[
        "valor",
        "investimento",
        "aposta",
        "dinheiro",
        "capital",
        "saldo",
        "patrimonio",
        "montante",
        "verba",
        "bet",
    ],
    connectors: &["no", "em", "em caso de"],
};

pub const DOUBLE_CHANCE_VOCABULARY: DoubleChanceVocabulary = DoubleChanceVocabulary {
    standalone: &["double chance"],
    abbreviations: &["dc"],
    terms: &[
        "chance",
        "hipotese",
        "oportunidade",
        "possibilidade",
        "escolha",
        "opcao",
        "alternativa",
        "variante",
        "selecao",
    ],
};

/// As palavras com `space` no lugar de cada espaço, em alternância.
fn spaced<'a>(parts: impl IntoIterator<Item = &'a &'a str>, space: &str) -> String {
    parts
        .into_iter()
        .map(|part| part.replace(' ', space))
        .collect::<Vec<_>>()
        .join("|")
}

/// Padrão de DNB. `space` é o separador entre palavras: " " para chaves de
/// mercado (já normalizadas em espaço simples) e `\s+` para texto de seleção.
pub fn draw_no_bet_pattern(space: &str) -> String {
    let v = &DRAW_NO_BET_VOCABULARY;
    let objects = format!("(?:{})", spaced(v.objects, space));
    let verbs = format!(
        "(?:{})(?:{space}{objects})?(?:{space}de)?",
        v.verbs.join("|")
    );
    let states = format!("(?:{})", spaced(v.states, space));
    let nouns = format!(
        "(?:{})(?:{space}(?:do|da){space}(?:{}))?{space}(?:{}){space}empate",
        v.nouns.join("|"),
        v.noun_qualifiers.join("|"),
        spaced(v.connectors, space),
    );
    let standalone = spaced(v.standalone.iter().chain(v.abbreviations), space);
    format!("(?:{standalone}|empate{space}(?:{verbs}|{states})|{nouns})")
}

/// Padrão de Dupla Chance, mesmo contrato de `space`.
pub fn double_chance_pattern(space: &str) -> String {
    let v = &DOUBLE_CHANCE_VOCABULARY;
    let terms = v.terms.join("|");
    let standalone = spaced(v.standalone.iter().chain(v.abbreviations), space);
    format!("(?:{standalone}|dupla{space}(?:{terms})|(?:{terms}){space}dupla)")
}

fn compiled(source: String, flags: &str) -> Regex {
    Regex::cataloged(&source, flags)
        .unwrap_or_else(|error| panic!("regex inválida /{source}/{flags}: {error}"))
}

static DRAW_NO_BET_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    compiled(
        format!(
            r"\s*(?:[-(/])?\s*(?:{})\s*\)?$",
            draw_no_bet_pattern(r"\s+")
        ),
        "i",
    )
});
static DOUBLE_CHANCE_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    compiled(
        format!(
            r"^\s*(?:\(\s*)?{}\b\s*\)?\s*[:–—-]?\s*",
            double_chance_pattern(r"\s+")
        ),
        "i",
    )
});
static DOUBLE_CHANCE_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    compiled(
        format!(
            r"(?:^|\s+|\s*[-–—(/]\s*){}\b\s*\)?\s*$",
            double_chance_pattern(r"\s+")
        ),
        "i",
    )
});

pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        &*DRAW_NO_BET_SUFFIX,
        &*DOUBLE_CHANCE_PREFIX,
        &*DOUBLE_CHANCE_SUFFIX,
    ]
}

/// Tira da seleção o sufixo ou qualificador DNB/Empate Anula: o time limpo, ou
/// `None` quando a seleção não é DNB.
pub fn strip_draw_no_bet_from_selection(selecao: &str) -> Option<String> {
    let regex = &*DRAW_NO_BET_SUFFIX;
    regex
        .is_match(selecao)
        .then(|| js::trim(&regex.replace(selecao, "")).to_owned())
}

/// Tira da seleção o prefixo ou sufixo de Dupla Chance (DC / Dupla Chance): o
/// time limpo, ou `None` quando a seleção não é Dupla Chance.
///
/// Fronteiras obrigatórias: uma palavra terminada em "dc" não é um mercado.
/// Compara sem acentos, mas corta o original nos índices UTF-16 do texto sem
/// acento, como o TypeScript fazia (o nome com acento fica como veio).
pub fn strip_double_chance_from_selection(selecao: &str) -> Option<String> {
    let normalized = js_text::nfd_without_combining_marks(selecao);
    let start = DOUBLE_CHANCE_PREFIX.exec(&normalized);
    let end = DOUBLE_CHANCE_SUFFIX.exec(&normalized);
    if start.is_none() && end.is_none() {
        return None;
    }
    let units: Vec<u16> = selecao.encode_utf16().collect();
    let from = start.map_or(0, |found| utf16_len(found.get(0).unwrap_or("")));
    let to = end.map_or(units.len(), |found| found.index());
    // `slice(from, max(from, to))`, com os índices presos ao tamanho.
    let from = from.min(units.len());
    let to = to.clamp(from, units.len());
    Some(js::trim(&String::from_utf16_lossy(&units[from..to])).to_owned())
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Espelho SQL do vocabulário: cada termo lista os trechos que precisam estar
/// todos no mercado. O verbo entra sem o objeto porque `contains` já é prefixo
/// ("empate anula" cobre "Empate Anula a Aposta de"); o substantivo entra como
/// par composto porque o qualificador fica no meio da expressão ("Devolução DO
/// VALOR no empate"). Siglas ficam fora: exigem limite de token, que o
/// chamador aplica.
pub fn draw_no_bet_sql_terms() -> Vec<Vec<String>> {
    let v = &DRAW_NO_BET_VOCABULARY;
    let mut terms = Vec::new();
    let single = |terms: &mut Vec<Vec<String>>, label: &str| {
        terms.extend(
            accent_variants(label)
                .into_iter()
                .map(|variant| vec![variant]),
        );
    };
    for label in v.standalone {
        single(&mut terms, label);
    }
    for verb in v.verbs {
        single(&mut terms, &format!("empate {verb}"));
    }
    for state in v.states {
        single(&mut terms, &format!("empate {state}"));
    }
    for noun in v.nouns {
        terms.extend(
            accent_variants(noun)
                .into_iter()
                .map(|variant| vec![variant, "empate".to_owned()]),
        );
    }
    terms
}

pub fn double_chance_sql_terms() -> Vec<Vec<String>> {
    let v = &DOUBLE_CHANCE_VOCABULARY;
    let mut terms: Vec<Vec<String>> = v
        .standalone
        .iter()
        .map(|label| vec![(*label).to_owned()])
        .collect();
    for term in v.terms {
        for label in [format!("dupla {term}"), format!("{term} dupla")] {
            terms.extend(
                accent_variants(&label)
                    .into_iter()
                    .map(|variant| vec![variant]),
            );
        }
    }
    terms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limpa_a_selecao() {
        assert_eq!(
            strip_draw_no_bet_from_selection("Flamengo (Empate Anula)").as_deref(),
            Some("Flamengo")
        );
        assert_eq!(strip_draw_no_bet_from_selection("Flamengo"), None);
        assert_eq!(
            strip_double_chance_from_selection("Dupla Chance: São Paulo ou empate").as_deref(),
            Some("São Paulo ou empate")
        );
        assert_eq!(
            strip_double_chance_from_selection("Grêmio - Dupla Opção").as_deref(),
            Some("Grêmio")
        );
        assert_eq!(strip_double_chance_from_selection("Madc"), None);
    }
}
