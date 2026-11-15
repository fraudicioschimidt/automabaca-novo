//! Lado N-API da ponte (web e worker, `index.cjs`).

use dominio::cron;
use napi::{Error, Result};
use napi_derive::napi;

/// Versão do binário, para o empacotamento conferir que ele carrega.
#[napi]
pub fn versao() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

fn js_error(error: cron::CronError) -> Error {
    Error::from_reason(error.to_string())
}

#[napi]
pub fn cron_max_gap_minutes(cron: String) -> Result<u32> {
    cron::cron_max_gap_minutes(&cron).map_err(js_error)
}

#[napi]
pub fn cron_firing_minutes(cron: String) -> Result<Vec<u32>> {
    cron::cron_firing_minutes(&cron).map_err(js_error)
}

/// Instantes em milissegundos da época (`Date.getTime()`); `null` sem disparo.
#[napi]
pub fn latest_cron_firing(
    cron: String,
    after_ms: f64,
    until_ms: f64,
    utc_offset_hours: f64,
) -> Result<Option<f64>> {
    cron::latest_cron_firing(&cron, after_ms, until_ms, utc_offset_hours).map_err(js_error)
}

/// `[probabilidade implícita, estimada, fração de Kelly]`; `null` quando a
/// vantagem e a odd não dão probabilidade possível.
#[napi]
pub fn analyze_kelly(odds: f64, vantagem_pct: f64) -> Option<Vec<f64>> {
    dominio::kelly::analyze_kelly(odds, vantagem_pct).map(|analysis| {
        vec![
            analysis.implied_probability,
            analysis.estimated_probability,
            analysis.full_fraction,
        ]
    })
}

#[napi]
pub fn kelly_stake(odds: f64, vantagem_pct: f64, fraction: f64, cap_units: f64) -> f64 {
    dominio::kelly::kelly_stake(odds, vantagem_pct, fraction, cap_units)
}

/// Ver `src/domain/decimal-input.ts`: só o texto; a casca trata o resto.
#[napi]
pub fn parse_decimal_text(value: String) -> Option<f64> {
    dominio::decimal_input::parse_decimal_text(&value)
}

#[napi]
pub fn parse_money_text(value: String) -> Option<f64> {
    dominio::decimal_input::parse_money_text(&value)
}

/// Ver `src/domain/odds.ts`: listas de odds entram como `Array` e saem como
/// `Array` ou `null`.
#[napi]
pub fn power_fair_probs(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::power_fair_probs(&odds)
}

#[napi]
pub fn shin_fair_probs(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::shin_fair_probs(&odds)
}

#[napi]
pub fn power_fair_odds(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::power_fair_odds(&odds)
}

#[napi]
pub fn shin_fair_odds(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::shin_fair_odds(&odds)
}

#[napi]
pub fn auto_fair_odds(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::auto_fair_odds(&odds)
}

#[napi]
pub fn auto_fair_probs(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::auto_fair_probs(&odds)
}

#[napi]
pub fn combine_quarter_line_odds(
    side: String,
    a_line_q: f64,
    a_odd: f64,
    b_line_q: f64,
    b_odd: f64,
) -> Option<f64> {
    use dominio::odds::QuarterLineComponent;
    dominio::odds::combine_quarter_line_odds(
        &side,
        QuarterLineComponent {
            line_q: a_line_q,
            odd: a_odd,
        },
        QuarterLineComponent {
            line_q: b_line_q,
            odd: b_odd,
        },
    )
}

#[napi]
pub fn percentual_contra_fair(book_odd: f64, fair_odd: f64) -> Option<f64> {
    dominio::odds::percentual_contra_fair(book_odd, fair_odd)
}
