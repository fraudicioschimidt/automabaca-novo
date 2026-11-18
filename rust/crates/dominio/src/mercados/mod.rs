//! Vocabulário e leitura de mercados, portado de `src/domain/mercados/`.

pub mod accents;
pub mod catalog;
pub mod draw_vocabulary;
pub mod match_scope;
pub mod total_direction;
pub mod trailing_side;

use js_regex::Regex;

/// Os regexes do módulo, para o catálogo que o teste compara com o V8.
pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all = accents::regexes();
    all.extend(draw_vocabulary::regexes());
    all.extend(total_direction::regexes());
    all.extend(trailing_side::regexes());
    all
}
