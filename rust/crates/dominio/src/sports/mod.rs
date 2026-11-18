//! Modalidades: o registro e a detecção pelo texto, portados de
//! `src/domain/sports/`.

pub mod detect;
pub mod registry;

use js_regex::Regex;

/// Os regexes do módulo, para o catálogo que o teste compara com o V8.
pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all = registry::regexes();
    all.extend(detect::regexes());
    all
}
