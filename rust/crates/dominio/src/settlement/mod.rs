//! Regras da liquidação, portadas de `src/domain/settlement/`.

pub mod goalscorer_matching;
pub mod lines;
pub mod over_under_subject;
pub mod sides;

use js_regex::Regex;

/// Os regexes do módulo, para o catálogo que o teste compara com o V8.
pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all = lines::regexes();
    all.extend(over_under_subject::regexes());
    all.extend(sides::regexes());
    all
}
