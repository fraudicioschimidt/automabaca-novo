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
