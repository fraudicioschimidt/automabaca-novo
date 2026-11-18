//! Vocabulário e leitura de mercados, portado de `src/domain/mercados/`.

pub mod accents;
pub mod match_scope;
pub mod total_direction;
pub mod trailing_side;

use js_regex::Regex;

/// Os regexes do módulo, para o catálogo que o teste compara com o V8.
pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all = accents::regexes();
    all.extend(total_direction::regexes());
    all.extend(trailing_side::regexes());
    all
}
