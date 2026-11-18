//! Regras da liquidação, portadas de `src/domain/settlement/`.

pub mod sides;

use js_regex::Regex;

/// Os regexes do módulo, para o catálogo que o teste compara com o V8.
pub(crate) fn regexes() -> Vec<&'static Regex> {
    sides::regexes()
}
