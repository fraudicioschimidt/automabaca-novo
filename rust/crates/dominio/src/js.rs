//! Equivalências do JavaScript que o domínio portado precisa reproduzir bit a
//! bit, porque o TypeScript que ele substitui dependia delas.

/// O `\s` e o `trim()` do JavaScript: o espaço do Unicode, sem o NEL
/// (U+0085), mais o BOM (U+FEFF).
pub fn is_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

/// `String.prototype.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

/// `/\d/` sem a flag `u`: só os dígitos ASCII.
pub fn is_digit(c: char) -> bool {
    c.is_ascii_digit()
}

/// `/^\d+$/`.
pub fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.chars().all(is_digit)
}

/// `/^0\d/`.
pub fn leading_zero_digit(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next() == Some('0') && chars.next().is_some_and(is_digit)
}

/// `Math.round`: empate para +∞ (`-2.5` vira `-2`), não para longe de zero
/// como o `round` do Rust. Preserva `-0` e os não finitos.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    let floor = x.floor();
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && x < 0.0 {
        -0.0
    } else {
        rounded
    }
}

/// `String(x)` de um número (o `Number.prototype.toString()`): os dígitos da
/// representação mais curta, em notação exponencial abaixo de 1e-6 e a partir
/// de 1e21, `-0` como `0`.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    if x < 0.0 {
        return format!("-{}", number_to_string(-x));
    }
    if x.is_infinite() {
        return "Infinity".to_owned();
    }
    // O `{:e}` do Rust dá os dígitos da representação mais curta, como o JS.
    let scientific = format!("{x:e}");
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    let n = exponent.parse::<i64>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign = if n >= 1 { '+' } else { '-' };
        let tail = if k == 1 {
            String::new()
        } else {
            format!(".{}", &digits[1..])
        };
        format!("{}{tail}e{sign}{}", &digits[..1], (n - 1).abs())
    }
}

/// `Number.prototype.toFixed(digits)` para `digits` de 0 a 20 e |x| < 1e21:
/// o inteiro n mais próximo de x·10^digits, e no empate exato o MAIOR (o
/// `{:.N}` do Rust desempata para o par). Fora disso, `None`: quem chama não
/// usa esse caso.
pub fn to_fixed(x: f64, digits: usize) -> Option<String> {
    if !x.is_finite() || x.abs() >= 1e21 || digits > 20 {
        return None;
    }
    // A representação exata do f64 em decimal (até 1074 casas), arredondada à mão.
    let exact = format!("{:.1100}", x.abs());
    let (whole, fraction) = exact.split_once('.')?;
    let mut digits_kept: Vec<u8> = whole
        .bytes()
        .chain(fraction.bytes().take(digits))
        .map(|b| b - b'0')
        .collect();
    let rest = &fraction[digits..];
    let first = rest.bytes().next().map_or(0, |b| b - b'0');
    // Empate exato (5 seguido só de zeros) vai para o maior n, como o resto.
    if first >= 5 {
        let mut i = digits_kept.len();
        loop {
            if i == 0 {
                digits_kept.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_kept[i] == 9 {
                digits_kept[i] = 0;
            } else {
                digits_kept[i] += 1;
                break;
            }
        }
    }
    let text: String = digits_kept.iter().map(|d| char::from(b'0' + d)).collect();
    let split = text.len() - digits;
    let mut out = String::new();
    // O sinal some quando o resultado é zero só se x for -0; -0.04.toFixed(1) é "-0.0".
    if x < 0.0 {
        out.push('-');
    }
    out.push_str(&text[..split]);
    if digits > 0 {
        out.push('.');
        out.push_str(&text[split..]);
    }
    Some(out)
}

/// As contas de data do ECMAScript (`Date.UTC`, os getters UTC e o
/// `toISOString`), em milissegundos desde a época, como o `Date` guarda.
pub mod date {
    const MS_PER_DAY: f64 = 86_400_000.0;
    /// O maior instante que um `Date` representa (±8,64e15 ms).
    const MAX_TIME: f64 = 8.64e15;

    fn to_integer(x: f64) -> f64 {
        if x.is_nan() { 0.0 } else { x.trunc() + 0.0 }
    }

    /// Dias desde 1970-01-01 até o dia 1 de `month` (1-12) de `year`.
    fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
        let y = if month <= 2 { year - 1 } else { year };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let mp = (month + 9) % 12;
        let doy = (153 * mp + 2) / 5 + day - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    /// (ano, mês 1-12, dia) do dia `days` desde a época.
    fn civil_from_days(days: i64) -> (i64, i64, i64) {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        (yoe + era * 400 + i64::from(month <= 2), month, day)
    }

    /// MakeDay: dias desde a época de (ano, mês 0-11, dia), com o mês e o dia
    /// rolando para os vizinhos, como o `Date.UTC`.
    fn make_day(year: f64, month: f64, date: f64) -> f64 {
        if !year.is_finite() || !month.is_finite() || !date.is_finite() {
            return f64::NAN;
        }
        let (y, m, dt) = (to_integer(year), to_integer(month), to_integer(date));
        let ym = y + (m / 12.0).floor();
        if ym.abs() > 400_000.0 {
            return f64::NAN;
        }
        let mn = m.rem_euclid(12.0);
        // `ym` e `mn` são inteiros pequenos aqui: a conversão é exata.
        days_from_civil(ym as i64, mn as i64 + 1, 1) as f64 + dt - 1.0
    }

    fn make_time(hour: f64, minute: f64, second: f64, ms: f64) -> f64 {
        if ![hour, minute, second, ms].iter().all(|v| v.is_finite()) {
            return f64::NAN;
        }
        to_integer(hour) * 3_600_000.0
            + to_integer(minute) * 60_000.0
            + to_integer(second) * 1000.0
            + to_integer(ms)
    }

    fn time_clip(time: f64) -> f64 {
        if !time.is_finite() || time.abs() > MAX_TIME {
            f64::NAN
        } else {
            to_integer(time)
        }
    }

    /// `Date.UTC(year, month, day, hour, minute)`: NaN quando o resultado é uma
    /// data inválida. Ano de 0 a 99 vira 19xx, como no JavaScript.
    pub fn utc(year: f64, month: f64, day: f64, hour: f64, minute: f64) -> f64 {
        let year = if year.is_nan() {
            year
        } else {
            let yi = to_integer(year);
            if (0.0..=99.0).contains(&yi) {
                1900.0 + yi
            } else {
                year
            }
        };
        let day = make_day(year, month, day);
        let time = make_time(hour, minute, 0.0, 0.0);
        let date = day * MS_PER_DAY + time;
        if !date.is_finite() {
            f64::NAN
        } else {
            time_clip(date)
        }
    }

    /// Os campos UTC de um instante válido (os `getUTC*`): ano, mês 0-11,
    /// dia, dia da semana (0 = domingo), hora, minuto e segundo.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Parts {
        pub year: i64,
        pub month0: i64,
        pub day: i64,
        pub weekday: i64,
        pub hour: i64,
        pub minute: i64,
        pub second: i64,
        pub millisecond: i64,
    }

    /// `None` para instante inválido (NaN ou fora de ±8,64e15).
    pub fn parts(ms: f64) -> Option<Parts> {
        if time_clip(ms).is_nan() {
            return None;
        }
        // Instante válido é inteiro e cabe em i64.
        let ms = ms as i64;
        let days = ms.div_euclid(86_400_000);
        let in_day = ms.rem_euclid(86_400_000);
        let (year, month, day) = civil_from_days(days);
        Some(Parts {
            year,
            month0: month - 1,
            day,
            weekday: (days + 4).rem_euclid(7),
            hour: in_day / 3_600_000,
            minute: in_day / 60_000 % 60,
            second: in_day / 1000 % 60,
            millisecond: in_day % 1000,
        })
    }

    /// `toISOString()`; `None` onde o JavaScript lança "Invalid time value".
    pub fn to_iso_string(ms: f64) -> Option<String> {
        let p = parts(ms)?;
        let year = if (0..=9999).contains(&p.year) {
            format!("{:04}", p.year)
        } else {
            format!("{}{:06}", if p.year < 0 { '-' } else { '+' }, p.year.abs())
        };
        Some(format!(
            "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            p.month0 + 1,
            p.day,
            p.hour,
            p.minute,
            p.second,
            p.millisecond
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn espacos_do_javascript() {
        assert!(is_whitespace('\u{FEFF}'));
        assert!(is_whitespace('\u{a0}'));
        assert!(is_whitespace('\u{2028}'));
        assert!(!is_whitespace('\u{85}'));
        assert_eq!(trim("\u{FEFF} 1,5\u{3000}"), "1,5");
        assert_eq!(trim("\u{85}1"), "\u{85}1");
    }

    #[test]
    fn math_round_e_to_fixed() {
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(2.5), 3.0);
        assert!(round(-0.4).is_sign_negative());
        assert_eq!(round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(to_fixed(0.25, 1).as_deref(), Some("0.3"));
        assert_eq!(to_fixed(1.005, 2).as_deref(), Some("1.00"));
        assert_eq!(to_fixed(2.5, 0).as_deref(), Some("3"));
        assert_eq!(to_fixed(9.99, 1).as_deref(), Some("10.0"));
        assert_eq!(to_fixed(-0.04, 1).as_deref(), Some("-0.0"));
    }

    #[test]
    fn string_de_numero() {
        for (x, esperado) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-2.5, "-2.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (0.000_001, "0.000001"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
            (5e-324, "5e-324"),
        ] {
            assert_eq!(number_to_string(x), esperado, "{x:e}");
        }
    }

    #[test]
    fn datas_do_ecmascript() {
        assert_eq!(
            date::utc(2026.0, 8.0, 23.0, 22.0, 15.0),
            1_790_201_700_000.0
        );
        assert_eq!(
            date::to_iso_string(0.0).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        // Ano de dois dígitos e rollover de mês.
        assert_eq!(
            date::utc(99.0, 0.0, 1.0, 0.0, 0.0),
            date::utc(1999.0, 0.0, 1.0, 0.0, 0.0)
        );
        assert_eq!(
            date::utc(2026.0, 1.0, 31.0, 0.0, 0.0),
            date::utc(2026.0, 2.0, 3.0, 0.0, 0.0)
        );
        assert!(date::utc(f64::NAN, 0.0, 1.0, 0.0, 0.0).is_nan());
        assert_eq!(
            date::to_iso_string(-62_198_755_200_000.0).as_deref(),
            Some("-000001-01-01T00:00:00.000Z")
        );
        assert_eq!(date::to_iso_string(8.64e15 + 1.0), None);
        assert_eq!(
            date::parts(-1.0).map(|p| (p.year, p.hour, p.weekday)),
            Some((1969, 23, 3))
        );
    }

    #[test]
    fn digitos_ascii() {
        assert!(all_digits("0123"));
        assert!(!all_digits(""));
        assert!(!all_digits("١٢"));
        assert!(leading_zero_digit("01"));
        assert!(!leading_zero_digit("0"));
        assert!(!leading_zero_digit("0,1"));
    }
}
