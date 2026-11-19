//! Regras da liquidação, portadas de `src/domain/settlement/`.

pub mod goalscorer;
pub mod goalscorer_matching;
pub mod lines;
pub mod markets;
pub mod over_under_subject;
pub mod player_prop_classify;
pub mod sides;
pub mod statistics;

use js_regex::Regex;

/// Os regexes do módulo, para o catálogo que o teste compara com o V8.
pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all = goalscorer::regexes();
    all.extend(lines::regexes());
    all.extend(markets::regexes());
    all.extend(over_under_subject::regexes());
    all.extend(player_prop_classify::regexes());
    all.extend(sides::regexes());
    all.extend(statistics::regexes());
    all
}
