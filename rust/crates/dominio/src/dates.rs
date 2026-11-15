//! Datas no fuso do operador, portado de `src/domain/dates.ts` e da parte sem
//! regex de `src/domain/dates-parsing.ts`: armazenar UTC, interpretar e exibir
//! em America/Sao_Paulo. São Paulo é UTC-3 fixo (sem horário de verão desde
//! 2019), o que permite a conversão aritmética.
//!
//! Instantes entram e saem em milissegundos desde a época (`Date.getTime()`);
//! a casca TS confere o `Date` inválido antes de chamar.

use crate::js::{self, date};

/// Horas a oeste de UTC no relógio de São Paulo.
pub const SAO_PAULO_UTC_OFFSET_HOURS: f64 = 3.0;
const OFFSET_MS: f64 = SAO_PAULO_UTC_OFFSET_HOURS * 3_600_000.0;

const WEEKDAY_NAMES: [&str; 7] = [
    "Domingo",
    "Segunda-feira",
    "Terça-feira",
    "Quarta-feira",
    "Quinta-feira",
    "Sexta-feira",
    "Sábado",
];
const MONTH_NAMES: [&str; 12] = [
    "Janeiro",
    "Fevereiro",
    "Março",
    "Abril",
    "Maio",
    "Junho",
    "Julho",
    "Agosto",
    "Setembro",
    "Outubro",
    "Novembro",
    "Dezembro",
];

/// Erro de entrada; o texto é a mensagem do TypeScript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateError(pub String);

/// Os `getUTC*` do `Date` deslocado para o relógio de São Paulo. Perto do
/// limite inferior do `Date` o deslocado é inválido, e os getters dão NaN,
/// como no TypeScript (que não lança aí).
#[derive(Clone, Copy)]
struct SpFields {
    year: f64,
    month0: f64,
    day: f64,
    weekday: f64,
    hour: f64,
    minute: f64,
}

fn sp_fields(ms: f64) -> SpFields {
    match date::parts(ms - OFFSET_MS) {
        Some(p) => SpFields {
            year: p.year as f64,
            month0: p.month0 as f64,
            day: p.day as f64,
            weekday: p.weekday as f64,
            hour: p.hour as f64,
            minute: p.minute as f64,
        },
        None => SpFields {
            year: f64::NAN,
            month0: f64::NAN,
            day: f64::NAN,
            weekday: f64::NAN,
            hour: f64::NAN,
            minute: f64::NAN,
        },
    }
}

/// `String(value).padStart(2, "0")`.
fn two(value: f64) -> String {
    format!("{:0>2}", js::number_to_string(value))
}

fn name(names: &[&'static str], index: f64) -> &'static str {
    if index.is_finite() && index >= 0.0 {
        names.get(index as usize).copied().unwrap_or("")
    } else {
        ""
    }
}

/// Chave de dia no fuso SP ("2026-06-15"); o `toISOString` lança na borda.
pub fn sp_day_key(ms: f64) -> Result<String, DateError> {
    let iso = date::to_iso_string(ms - OFFSET_MS)
        .ok_or_else(|| DateError("Invalid time value".to_owned()))?;
    Ok(iso.chars().take(10).collect())
}

/// "16:00" no fuso SP.
pub fn format_sp_time(ms: f64) -> String {
    let sp = sp_fields(ms);
    format!("{}:{}", two(sp.hour), two(sp.minute))
}

/// "15/06" no fuso SP.
pub fn format_sp_day_month(ms: f64) -> String {
    let sp = sp_fields(ms);
    format!("{}/{}", two(sp.day), two(sp.month0 + 1.0))
}

/// "15/06 16:00" no fuso SP.
pub fn format_sp_date_time(ms: f64) -> String {
    format!("{} {}", format_sp_day_month(ms), format_sp_time(ms))
}

/// "04/02/2026" no fuso SP.
pub fn format_sp_date_with_year(ms: f64) -> String {
    let sp = sp_fields(ms);
    format!(
        "{}/{}/{}",
        two(sp.day),
        two(sp.month0 + 1.0),
        js::number_to_string(sp.year)
    )
}

/// Saudação pelo período do dia no fuso SP.
pub fn sp_greeting(ms: f64) -> &'static str {
    let hour = sp_fields(ms).hour;
    if hour < 6.0 {
        "Boa noite"
    } else if hour < 12.0 {
        "Bom dia"
    } else if hour < 18.0 {
        "Boa tarde"
    } else {
        "Boa noite"
    }
}

/// "Sábado, 13 de junho" no fuso SP.
pub fn format_sp_full_date(ms: f64) -> String {
    let sp = sp_fields(ms);
    format!(
        "{}, {} de {}",
        name(&WEEKDAY_NAMES, sp.weekday),
        js::number_to_string(sp.day),
        name(&MONTH_NAMES, sp.month0).to_lowercase()
    )
}

/// Componentes do relógio de São Paulo → instante UTC, com o rollover e o
/// ano de dois dígitos do `Date.UTC`. NaN quando não há data.
pub fn sp_to_utc(year: f64, month: f64, day: f64, hour: f64, minute: f64) -> f64 {
    date::utc(
        year,
        month - 1.0,
        day,
        hour + SAO_PAULO_UTC_OFFSET_HOURS,
        minute,
    )
}

/// Início do dia de hoje (00:00 SP) como instante UTC; NaN na borda do `Date`.
pub fn sp_start_of_today_utc(now_ms: f64) -> f64 {
    let sp = sp_fields(now_ms);
    sp_to_utc(sp.year, sp.month0 + 1.0, sp.day, 0.0, 0.0)
}

/// Tempo relativo curto ("agora", "há 12 min", "em 3 h", "há 2 d").
pub fn sp_relative(date_ms: f64, now_ms: f64) -> String {
    let delta = now_ms - date_ms;
    if delta.abs() < 60_000.0 {
        return "agora".to_owned();
    }
    if delta < 0.0 {
        let minutes = (-delta / 60_000.0).floor();
        if minutes < 60.0 {
            return format!("em {} min", js::number_to_string(minutes));
        }
        let hours = (minutes / 60.0).floor();
        if hours < 24.0 {
            return format!("em {} h", js::number_to_string(hours));
        }
        return format!("em {} d", js::number_to_string((hours / 24.0).floor()));
    }
    let minutes = (delta / 60_000.0).floor();
    if minutes < 60.0 {
        return format!("há {} min", js::number_to_string(minutes));
    }
    let hours = (minutes / 60.0).floor();
    if hours < 24.0 {
        return format!("há {} h", js::number_to_string(hours));
    }
    format!("há {} d", js::number_to_string((hours / 24.0).floor()))
}

/// Duração em minutos, curta ("<1 min", "12 min", "2.5 h", "10 h", "3 dias"); "—" sem valor.
pub fn format_duration_minutes(minutes: Option<f64>) -> String {
    let Some(minutes) = minutes.filter(|m| m.is_finite()) else {
        return "—".to_owned();
    };
    if minutes < 1.0 {
        return "<1 min".to_owned();
    }
    if minutes < 60.0 {
        return format!("{} min", js::number_to_string(js::round(minutes)));
    }
    if minutes >= 48.0 * 60.0 {
        return format!(
            "{} dias",
            js::number_to_string((minutes / (24.0 * 60.0)).floor())
        );
    }
    let hours =
        js::to_fixed(minutes / 60.0, if minutes < 600.0 { 1 } else { 0 }).unwrap_or_default();
    format!("{hours} h")
}

/// Chave de semana ISO no fuso SP ("2026-W24"), com as contas do `Date` do
/// TypeScript: o `Date.UTC` leva o ano 0-99 a 19xx (e o dia da semana é o da
/// data convertida), e na borda da faixa os campos saem "NaN".
pub fn sp_week_key(ms: f64) -> String {
    let sp = sp_fields(ms);
    let midnight = date::utc(sp.year, sp.month0, sp.day, 0.0, 0.0);
    // `d.getUTCDay() || 7`: NaN também vira 7.
    let weekday = date::parts(midnight).map_or(0, |p| p.weekday);
    let day_num = if weekday == 0 { 7 } else { weekday };
    // O `setUTCDate` do TS: fora da faixa, o instante vira NaN.
    let thursday = date::utc(sp.year, sp.month0, sp.day + (4 - day_num) as f64, 0.0, 0.0);
    let year = date::parts(thursday).map_or(f64::NAN, |p| p.year as f64);
    let year_start = date::utc(year, 0.0, 1.0, 0.0, 0.0);
    let week = (((thursday - year_start) / 86_400_000.0 + 1.0) / 7.0).ceil();
    format!("{}-W{}", js::number_to_string(year), two(week))
}

/// `^(\d{4})-(\d{2})-(\d{2})$` → (ano, mês, dia).
fn day_key_parts(text: &str) -> Option<(f64, f64, f64)> {
    let bytes = text.as_bytes();
    let shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|&i| bytes[i].is_ascii_digit());
    if !shape {
        return None;
    }
    let number = |range: std::ops::Range<usize>| text[range].parse::<f64>().ok();
    Some((number(0..4)?, number(5..7)?, number(8..10)?))
}

/// Soma dias de calendário a uma chave YYYY-MM-DD sem reinterpretar fuso.
pub fn shift_day_key(day_key: &str, days: f64) -> Result<String, DateError> {
    let invalid = || DateError(format!("Chave de dia invalida: {day_key}"));
    let (year, month, day) = day_key_parts(day_key).ok_or_else(invalid)?;
    if !(days.is_finite() && days.fract() == 0.0) {
        return Err(invalid());
    }
    let source = date::parts(date::utc(year, month - 1.0, day, 0.0, 0.0)).ok_or_else(invalid)?;
    if source.year as f64 != year || source.month0 as f64 != month - 1.0 || source.day as f64 != day
    {
        return Err(invalid());
    }
    let shifted = date::utc(year, month - 1.0, day + days, 0.0, 0.0);
    let iso =
        date::to_iso_string(shifted).ok_or_else(|| DateError("Invalid time value".to_owned()))?;
    Ok(iso.chars().take(10).collect())
}

/// `^(\d{1,2}):(\d{2})$` → (hora, minuto).
fn time_parts(text: &str) -> Option<(f64, f64)> {
    let (hour, minute) = text.split_once(':')?;
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    if !(1..=2).contains(&hour.len()) || minute.len() != 2 || !digits(hour) || !digits(minute) {
        return None;
    }
    Some((hour.parse().ok()?, minute.parse().ok()?))
}

/// Campos HTML `date` + `time` no relógio de São Paulo → instante UTC.
/// Confere a ida e volta porque o `Date.UTC` aceita datas impossíveis por
/// rollover (31/02 vira março).
pub fn parse_sp_date_time_input(date_text: &str, time_text: &str) -> Option<f64> {
    let (year, month, day) = day_key_parts(js::trim(date_text))?;
    let (hour, minute) = time_parts(js::trim(time_text))?;
    if !(1.0..=12.0).contains(&month)
        || !(1.0..=31.0).contains(&day)
        || !(0.0..=23.0).contains(&hour)
        || !(0.0..=59.0).contains(&minute)
    {
        return None;
    }
    let result = sp_to_utc(year, month, day, hour, minute);
    let round_trip = date::parts(result - OFFSET_MS)?;
    let same = round_trip.year as f64 == year
        && round_trip.month0 as f64 == month - 1.0
        && round_trip.day as f64 == day
        && round_trip.hour as f64 == hour
        && round_trip.minute as f64 == minute;
    same.then_some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(year: f64, month: f64, day: f64, hour: f64, minute: f64) -> f64 {
        date::utc(year, month - 1.0, day, hour, minute)
    }

    #[test]
    fn formatos_no_relogio_de_sao_paulo() {
        // 02:30 UTC de 15/06 ainda é 14/06 em São Paulo.
        let t = ms(2026.0, 6.0, 15.0, 2.0, 30.0);
        assert_eq!(sp_day_key(t).as_deref(), Ok("2026-06-14"));
        assert_eq!(format_sp_time(t), "23:30");
        assert_eq!(format_sp_date_time(t), "14/06 23:30");
        assert_eq!(format_sp_date_with_year(t), "14/06/2026");
        assert_eq!(format_sp_full_date(t), "Domingo, 14 de junho");
        assert_eq!(sp_greeting(t), "Boa noite");
        assert_eq!(sp_week_key(t), "2026-W24");
        assert_eq!(sp_start_of_today_utc(t), ms(2026.0, 6.0, 14.0, 3.0, 0.0));
        // Na borda inferior do `Date`, os getters do TS dão NaN sem lançar.
        assert_eq!(format_sp_time(-8.64e15), "NaN:NaN");
        assert_eq!(sp_week_key(-8.64e15), "NaN-WNaN");
        assert!(sp_day_key(-8.64e15).is_err());
    }

    #[test]
    fn relativo_e_duracao() {
        assert_eq!(sp_relative(0.0, 59_999.0), "agora");
        assert_eq!(sp_relative(0.0, 12.0 * 60_000.0), "há 12 min");
        assert_eq!(sp_relative(3.0 * 3_600_000.0, 0.0), "em 3 h");
        assert_eq!(sp_relative(0.0, 50.0 * 3_600_000.0), "há 2 d");
        assert_eq!(format_duration_minutes(None), "—");
        assert_eq!(format_duration_minutes(Some(0.5)), "<1 min");
        assert_eq!(format_duration_minutes(Some(12.5)), "13 min");
        assert_eq!(format_duration_minutes(Some(150.0)), "2.5 h");
        assert_eq!(format_duration_minutes(Some(600.0)), "10 h");
        assert_eq!(format_duration_minutes(Some(4320.0)), "3 dias");
    }

    #[test]
    fn chaves_e_campos_do_painel() {
        assert_eq!(
            shift_day_key("2026-02-28", 1.0).as_deref(),
            Ok("2026-03-01")
        );
        assert_eq!(
            shift_day_key("2026-02-30", 1.0),
            Err(DateError("Chave de dia invalida: 2026-02-30".to_owned()))
        );
        assert!(shift_day_key("2026-02-28", 0.5).is_err());
        assert_eq!(
            parse_sp_date_time_input("2026-09-23", "19:15"),
            Some(ms(2026.0, 9.0, 23.0, 22.0, 15.0))
        );
        assert_eq!(parse_sp_date_time_input("2026-02-31", "10:00"), None);
        assert_eq!(parse_sp_date_time_input("0099-01-01", "10:00"), None);
        assert_eq!(
            parse_sp_date_time_input(" 2026-09-23 ", " 7:05 "),
            Some(ms(2026.0, 9.0, 23.0, 10.0, 5.0))
        );
        assert_eq!(parse_sp_date_time_input("2026-09-23", "24:00"), None);
    }
}
