//! Vocabulário e leitura de mercados, portado de `src/domain/mercados/`.

pub mod accents;
pub mod catalog;
pub mod classify;
pub mod compatibility;
pub mod double_chance_selection;
pub mod draw_vocabulary;
pub mod finalize;
pub mod match_scope;
pub mod sharp_equivalent;
pub mod stat_qualifier;
pub mod total_direction;
pub mod trailing_side;

use js_regex::Regex;

/// Os regexes do módulo, para o catálogo que o teste compara com o V8.
pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all = accents::regexes();
    all.extend(classify::regexes());
    all.extend(compatibility::regexes());
    all.extend(double_chance_selection::regexes());
    all.extend(draw_vocabulary::regexes());
    all.extend(stat_qualifier::regexes());
    all.extend(total_direction::regexes());
    all.extend(trailing_side::regexes());
    all
}
