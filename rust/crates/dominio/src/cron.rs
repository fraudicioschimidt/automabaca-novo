//! Cadência de um cron de cinco campos, portada de `src/domain/cron-cadence.ts`.
//!
//! Só entende o que o manifesto de jobs usa: minuto, hora e dia da semana
//! (0 = domingo) com `*`, número, lista, intervalo `a-b` e passo `/n`; dia do
//! mês e mês têm de ser `*`. Qualquer outra forma é erro, em vez de uma
//! cadência inventada. As mensagens de erro são as do TypeScript, palavra por
//! palavra: os testes e os logs dependem delas.

use crate::js;
use std::collections::BTreeSet;
use std::fmt;

const DAY_MINUTES: u32 = 24 * 60;
const WEEK_MINUTES: u32 = 7 * DAY_MINUTES;
const WEEK_MS: f64 = WEEK_MINUTES as f64 * 60_000.0;
/// A época Unix caiu numa quinta: 04/01/1970, o primeiro domingo, abre as semanas do relógio.
const FIRST_SUNDAY_MS: f64 = 3.0 * DAY_MINUTES as f64 * 60_000.0;

/// Cron que este leitor recusa; o texto é a mensagem que o chamador mostra.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronError(String);

impl fmt::Display for CronError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CronError {}

/// O MAIOR intervalo, em minutos, entre duas execuções seguidas ao longo da
/// semana: o pior caso que decide quando um job agendado "parou de rodar".
pub fn cron_max_gap_minutes(cron: &str) -> Result<u32, CronError> {
    let firings = cron_firing_minutes(cron)?;
    let (Some(&first), Some(&last)) = (firings.first(), firings.last()) else {
        return Err(CronError(format!("cron que nunca dispara: \"{cron}\"")));
    };
    // A volta da semana conta: de sábado 23:50 para domingo 00:05 são 15 minutos.
    let wrap = WEEK_MINUTES - last + first;
    Ok(firings
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .fold(wrap, u32::max))
}

/// Os minutos da semana (0 = domingo 00:00 no relógio do cron, até 10079) em
/// que o cron dispara, em ordem.
pub fn cron_firing_minutes(cron: &str) -> Result<Vec<u32>, CronError> {
    let fields: Vec<&str> = cron
        .trim_matches(js::is_whitespace)
        .split(js::is_whitespace)
        .filter(|field| !field.is_empty())
        .collect();
    // `"".trim().split(/\s+/)` é `[""]` no JavaScript: um campo, não zero.
    let [minute, hour, day_of_month, month, weekday] = fields.as_slice() else {
        return Err(CronError(format!("cron sem cinco campos: \"{cron}\"")));
    };
    if *day_of_month != "*" || *month != "*" {
        return Err(CronError(format!(
            "cron com dia do mês ou mês fora do suportado: \"{cron}\""
        )));
    }
    let minutes = expand_field(minute, 0, 59, cron)?;
    let hours = expand_field(hour, 0, 23, cron)?;
    let weekdays = expand_field(weekday, 0, 6, cron)?;
    let mut firings = Vec::with_capacity(weekdays.len() * hours.len() * minutes.len());
    for day in &weekdays {
        for hour in &hours {
            firings.extend(
                minutes
                    .iter()
                    .map(|minute| day * DAY_MINUTES + hour * 60 + minute),
            );
        }
    }
    firings.sort_unstable();
    Ok(firings)
}

/// O disparo mais recente do cron em (`after_ms`, `until_ms`], em milissegundos
/// da época, com os minutos do cron lidos no relógio deslocado
/// `utc_offset_hours` horas a oeste de UTC (3 para São Paulo). `None` quando o
/// intervalo não tem disparo.
///
/// A conta é em `f64`, como no `Date` do JavaScript: instante inválido (NaN)
/// não acha disparo, e o resultado é o mesmo milissegundo que o TypeScript dava.
pub fn latest_cron_firing(
    cron: &str,
    after_ms: f64,
    until_ms: f64,
    utc_offset_hours: f64,
) -> Result<Option<f64>, CronError> {
    let minutes = cron_firing_minutes(cron)?;
    let offset_ms = utc_offset_hours * 3_600_000.0;
    let local_after = after_ms - offset_ms;
    let local_until = until_ms - offset_ms;
    let mut week_start =
        FIRST_SUNDAY_MS + ((local_until - FIRST_SUNDAY_MS) / WEEK_MS).floor() * WEEK_MS;
    while week_start + WEEK_MS > local_after {
        for &minute in minutes.iter().rev() {
            let local_firing = week_start + f64::from(minute) * 60_000.0;
            if local_firing <= local_after {
                return Ok(None);
            }
            if local_firing <= local_until {
                return Ok(Some(local_firing + offset_ms));
            }
        }
        week_start -= WEEK_MS;
    }
    Ok(None)
}

fn expand_field(field: &str, min: u32, max: u32, cron: &str) -> Result<Vec<u32>, CronError> {
    let mut values = BTreeSet::new();
    for part in field.split(',') {
        let unsupported = || {
            CronError(format!(
                "campo de cron fora do suportado: \"{part}\" em \"{cron}\""
            ))
        };
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => (range, Some(parse_number(step).ok_or_else(unsupported)?)),
            None => (part, None),
        };
        let (start, end) = if range == "*" {
            (min, u64::from(max))
        } else {
            let (start, end) = match range.split_once('-') {
                Some((start, end)) => (start, Some(end)),
                None => (range, None),
            };
            let start = parse_number(start).ok_or_else(unsupported)?;
            let end = match end {
                Some(end) => parse_number(end).ok_or_else(unsupported)?,
                // `5/15` vale como `5-59/15`, como no cron do pg-boss.
                None if step.is_some() => u64::from(max),
                None => start,
            };
            let Ok(start) = u32::try_from(start) else {
                return Err(out_of_bounds(part, cron));
            };
            (start, end)
        };
        let step = step.unwrap_or(1);
        if start < min || end > u64::from(max) || u64::from(start) > end || step < 1 {
            return Err(out_of_bounds(part, cron));
        }
        // `end <= max` cabe em u32; um passo maior que a faixa dá um valor só.
        let end = u32::try_from(end).unwrap_or(max);
        let step = usize::try_from(step).unwrap_or(usize::MAX);
        values.extend((start..=end).step_by(step));
    }
    Ok(values.into_iter().collect())
}

fn out_of_bounds(part: &str, cron: &str) -> CronError {
    CronError(format!(
        "campo de cron fora dos limites: \"{part}\" em \"{cron}\""
    ))
}

/// Um ou mais dígitos ASCII (o `\d+` do JavaScript). Número grande demais para
/// u64 vira `u64::MAX`: no TypeScript ele também passa do limite do campo.
fn parse_number(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(text.parse().unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(iso: &str) -> f64 {
        // Só o formato dos casos: AAAA-MM-DDTHH:MM:SSZ.
        let number = |range: std::ops::Range<usize>| -> i64 {
            iso.get(range)
                .and_then(|text| text.parse().ok())
                .unwrap_or(-1)
        };
        let (year, month, day) = (number(0..4), number(5..7), number(8..10));
        let (hour, minute, second) = (number(11..13), number(14..16), number(17..19));
        // Dias desde a época (algoritmo de Howard Hinnant, calendário gregoriano).
        let y = if month <= 2 { year - 1 } else { year };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let mp = (month + 9) % 12;
        let doy = (153 * mp + 2) / 5 + day - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        ((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) as f64
    }

    fn gap(cron: &str) -> u32 {
        cron_max_gap_minutes(cron).unwrap_or(0)
    }

    fn error(cron: &str) -> String {
        cron_max_gap_minutes(cron)
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default()
    }

    #[test]
    fn maior_intervalo_de_cada_forma_do_manifesto() {
        for (cron, expected) in [
            ("* * * * *", 1),
            ("*/5 * * * *", 5),
            ("2-59/5 * * * *", 5),
            ("3/15 * * * *", 15),
            ("6,16,26,36,46,56 * * * *", 10),
            ("15 1-23/2 * * *", 120),
            ("20 3-21/6 * * *", 360),
            ("40 3 * * *", 24 * 60),
            ("0 9 * * 1", 7 * 24 * 60),
            ("0 9,21 * * *", 720),
            ("0 3,5 * * *", 22 * 60),
            ("0 9 * * 1,4", 4 * 24 * 60),
            ("  5   *\t* * *  ", 60),
        ] {
            assert_eq!(gap(cron), expected, "{cron}");
        }
    }

    #[test]
    fn recusa_o_que_nao_sabe_ler_com_a_mensagem_do_typescript() {
        assert_eq!(
            error("0 0 1 * *"),
            "cron com dia do mês ou mês fora do suportado: \"0 0 1 * *\""
        );
        assert_eq!(
            error("0 0 * 1 *"),
            "cron com dia do mês ou mês fora do suportado: \"0 0 * 1 *\""
        );
        assert_eq!(
            error("0 9 * * 7"),
            "campo de cron fora dos limites: \"7\" em \"0 9 * * 7\""
        );
        assert_eq!(
            error("L * * * *"),
            "campo de cron fora do suportado: \"L\" em \"L * * * *\""
        );
        assert_eq!(
            error("70 * * * *"),
            "campo de cron fora dos limites: \"70\" em \"70 * * * *\""
        );
        assert_eq!(error("* * * *"), "cron sem cinco campos: \"* * * *\"");
        assert_eq!(error(""), "cron sem cinco campos: \"\"");
        assert_eq!(
            error("5-1 * * * *"),
            "campo de cron fora dos limites: \"5-1\" em \"5-1 * * * *\""
        );
        assert_eq!(
            error("*/0 * * * *"),
            "campo de cron fora dos limites: \"*/0\" em \"*/0 * * * *\""
        );
        assert_eq!(
            error("1,,2 * * * *"),
            "campo de cron fora do suportado: \"\" em \"1,,2 * * * *\""
        );
        assert_eq!(
            error("*-5 * * * *"),
            "campo de cron fora do suportado: \"*-5\" em \"*-5 * * * *\""
        );
        assert_eq!(
            error("99999999999999999999999 * * * *"),
            "campo de cron fora dos limites: \"99999999999999999999999\" em \"99999999999999999999999 * * * *\""
        );
    }

    #[test]
    fn minutos_da_semana_em_ordem_e_sem_repeticao() {
        assert_eq!(
            cron_firing_minutes("30,0,30 12 * * 0,6"),
            Ok(vec![720, 750, 9360, 9390])
        );
        assert_eq!(cron_firing_minutes("0 0 * * *").map(|m| m.len()), Ok(7));
        assert_eq!(
            cron_firing_minutes("0 0 * * 0/3"),
            Ok(vec![0, 3 * DAY_MINUTES, 6 * DAY_MINUTES])
        );
        assert_eq!(cron_firing_minutes("7/100 0 * * 0"), Ok(vec![7]));
    }

    #[test]
    fn disparo_mais_recente_no_relogio_de_sao_paulo() {
        let latest = |cron, after, until| latest_cron_firing(cron, ms(after), ms(until), 3.0);
        assert_eq!(
            latest(
                "15 1-23/2 * * *",
                "2026-09-23T22:00:00Z",
                "2026-09-23T23:30:00Z"
            ),
            Ok(Some(ms("2026-09-23T22:15:00Z")))
        );
        assert_eq!(
            latest(
                "15 1-23/2 * * *",
                "2026-09-23T22:15:00Z",
                "2026-09-24T00:14:00Z"
            ),
            Ok(None)
        );
        assert_eq!(
            latest("5 0 * * *", "2026-09-23T12:00:00Z", "2026-09-24T03:05:00Z"),
            Ok(Some(ms("2026-09-24T03:05:00Z")))
        );
        assert_eq!(
            latest("5 0 * * *", "2026-09-24T03:05:00Z", "2026-09-24T12:00:00Z"),
            Ok(None)
        );
        assert_eq!(
            latest("0 9 * * 1", "2026-09-10T00:00:00Z", "2026-09-28T12:00:00Z"),
            Ok(Some(ms("2026-09-28T12:00:00Z")))
        );
        assert_eq!(
            latest("0 9 * * 1", "2026-09-21T12:00:00Z", "2026-09-28T11:59:00Z"),
            Ok(None)
        );
        assert_eq!(
            latest_cron_firing("* * * * *", f64::NAN, 0.0, 3.0),
            Ok(None)
        );
        assert!(latest_cron_firing("0 0 1 * *", 0.0, 1.0, 3.0).is_err());
    }
}
