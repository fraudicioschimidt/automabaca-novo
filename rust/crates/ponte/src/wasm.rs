//! Lado WebAssembly da ponte (navegador, `browser.mjs`). O `wasm-bindgen`
//! devolveria `undefined` para `Option` e um array tipado para `Vec`: aqui
//! saem `null` e `Array`, como na N-API.

use dominio::cron;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn versao() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

fn js_error(error: cron::CronError) -> JsError {
    JsError::new(&error.to_string())
}

#[wasm_bindgen(js_name = cronMaxGapMinutes)]
pub fn cron_max_gap_minutes(cron: &str) -> Result<u32, JsError> {
    cron::cron_max_gap_minutes(cron).map_err(js_error)
}

#[wasm_bindgen(js_name = cronFiringMinutes)]
pub fn cron_firing_minutes(cron: &str) -> Result<Vec<JsValue>, JsError> {
    cron::cron_firing_minutes(cron)
        .map(|minutes| minutes.into_iter().map(JsValue::from).collect())
        .map_err(js_error)
}

#[wasm_bindgen(js_name = latestCronFiring)]
pub fn latest_cron_firing(
    cron: &str,
    after_ms: f64,
    until_ms: f64,
    utc_offset_hours: f64,
) -> Result<JsValue, JsError> {
    cron::latest_cron_firing(cron, after_ms, until_ms, utc_offset_hours)
        .map(|firing| firing.map_or(JsValue::NULL, JsValue::from))
        .map_err(js_error)
}

#[wasm_bindgen(js_name = analyzeKelly)]
pub fn analyze_kelly(odds: f64, vantagem_pct: f64) -> JsValue {
    dominio::kelly::analyze_kelly(odds, vantagem_pct).map_or(JsValue::NULL, |analysis| {
        let valores: Vec<JsValue> = [
            analysis.implied_probability,
            analysis.estimated_probability,
            analysis.full_fraction,
        ]
        .into_iter()
        .map(JsValue::from)
        .collect();
        JsValue::from(valores)
    })
}

#[wasm_bindgen(js_name = kellyStake)]
pub fn kelly_stake(odds: f64, vantagem_pct: f64, fraction: f64, cap_units: f64) -> f64 {
    dominio::kelly::kelly_stake(odds, vantagem_pct, fraction, cap_units)
}

fn number_or_null(value: Option<f64>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

#[wasm_bindgen(js_name = parseDecimalText)]
pub fn parse_decimal_text(value: &str) -> JsValue {
    number_or_null(dominio::decimal_input::parse_decimal_text(value))
}

#[wasm_bindgen(js_name = parseMoneyText)]
pub fn parse_money_text(value: &str) -> JsValue {
    number_or_null(dominio::decimal_input::parse_money_text(value))
}

fn numbers_or_null(values: Option<Vec<f64>>) -> JsValue {
    values.map_or(JsValue::NULL, |values| {
        JsValue::from(
            values
                .into_iter()
                .map(JsValue::from)
                .collect::<Vec<JsValue>>(),
        )
    })
}

#[wasm_bindgen(js_name = powerFairProbs)]
pub fn power_fair_probs(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::power_fair_probs(odds))
}

#[wasm_bindgen(js_name = shinFairProbs)]
pub fn shin_fair_probs(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::shin_fair_probs(odds))
}

#[wasm_bindgen(js_name = powerFairOdds)]
pub fn power_fair_odds(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::power_fair_odds(odds))
}

#[wasm_bindgen(js_name = shinFairOdds)]
pub fn shin_fair_odds(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::shin_fair_odds(odds))
}

#[wasm_bindgen(js_name = autoFairOdds)]
pub fn auto_fair_odds(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::auto_fair_odds(odds))
}

#[wasm_bindgen(js_name = autoFairProbs)]
pub fn auto_fair_probs(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::auto_fair_probs(odds))
}

#[wasm_bindgen(js_name = combineQuarterLineOdds)]
pub fn combine_quarter_line_odds(
    side: &str,
    a_line_q: f64,
    a_odd: f64,
    b_line_q: f64,
    b_odd: f64,
) -> JsValue {
    use dominio::odds::QuarterLineComponent;
    number_or_null(dominio::odds::combine_quarter_line_odds(
        side,
        QuarterLineComponent {
            line_q: a_line_q,
            odd: a_odd,
        },
        QuarterLineComponent {
            line_q: b_line_q,
            odd: b_odd,
        },
    ))
}

#[wasm_bindgen(js_name = percentualContraFair)]
pub fn percentual_contra_fair(book_odd: f64, fair_odd: f64) -> JsValue {
    number_or_null(dominio::odds::percentual_contra_fair(book_odd, fair_odd))
}
