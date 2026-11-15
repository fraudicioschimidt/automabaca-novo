//! Números digitados no painel, portado de `src/domain/decimal-input.ts`:
//! separador brasileiro ou internacional, agrupamento de milhares só quando
//! bem formado, e nada de adivinhar o que está ambíguo. A casca TS trata o
//! valor que não é texto; aqui só entra a string.

use crate::js;

/// `parseDecimalInput` para texto. `None` quando o texto não é um número que
/// se possa ler sem adivinhar.
pub fn parse_decimal_text(value: &str) -> Option<f64> {
    let compact = js::trim(value);
    if compact.is_empty()
        || compact.chars().any(js::is_whitespace)
        || compact.ends_with('.')
        || compact.ends_with(',')
    {
        return None;
    }
    let (sign, unsigned) = match compact.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => match compact.strip_prefix('+') {
            Some(rest) => ("+", rest),
            None => ("", compact),
        },
    };
    let comma_count = unsigned.matches(',').count();
    let dot_count = unsigned.matches('.').count();

    let normalized = if comma_count > 0 && dot_count > 0 {
        // O separador decimal é o último que aparece; o outro agrupa milhares.
        let (decimal, grouping) = if unsigned.rfind(',') > unsigned.rfind('.') {
            (',', '.')
        } else {
            ('.', ',')
        };
        let mut parts = unsigned.split(decimal);
        let integer_part = parts.next().unwrap_or_default();
        let decimal_part = parts.next().unwrap_or_default();
        if parts.next().is_some() || integer_part.is_empty() || !js::all_digits(decimal_part) {
            return None;
        }
        if integer_part.contains(grouping) {
            if !valid_first_group(integer_part, grouping)
                || !grouped_thousands(integer_part, grouping)
            {
                return None;
            }
        } else if !js::all_digits(integer_part) || js::leading_zero_digit(integer_part) {
            return None;
        }
        format!(
            "{sign}{}.{decimal_part}",
            integer_part.replace(grouping, "")
        )
    } else {
        let separator = if comma_count > 0 {
            Some((',', comma_count))
        } else if dot_count > 0 {
            Some(('.', dot_count))
        } else {
            None
        };
        match separator {
            // Mais de um separador do mesmo tipo: só pode ser milhar.
            Some((separator, count)) if count > 1 => {
                if !grouped_thousands(unsigned, separator)
                    || !valid_first_group(unsigned, separator)
                {
                    return None;
                }
                format!("{sign}{}", unsigned.replace(separator, ""))
            }
            Some((separator, _)) => {
                let first = unsigned.split(separator).next().unwrap_or_default();
                if js::leading_zero_digit(first) {
                    return None;
                }
                compact.replacen(',', ".", 1)
            }
            None => {
                if js::leading_zero_digit(unsigned) {
                    return None;
                }
                compact.to_owned()
            }
        }
    };

    if !decimal_literal(&normalized) {
        return None;
    }
    // Literal decimal sem expoente: a leitura do Rust é a do `Number()`, com o
    // mesmo arredondamento correto.
    normalized
        .parse::<f64>()
        .ok()
        .filter(|parsed| parsed.is_finite())
}

/// `parseMoneyInput` para texto: nos campos em R$, `1.000` é mil (milhar
/// brasileiro), e o espaço só separa grupos completos de milhares.
pub fn parse_money_text(value: &str) -> Option<f64> {
    let trimmed = js::trim(value);
    if trimmed.chars().any(js::is_whitespace) && !space_grouped_money(trimmed) {
        return None;
    }
    let compact: String = trimmed.chars().filter(|c| !is_group_space(*c)).collect();
    if let Some(thousands) = br_thousands(&compact) {
        return parse_decimal_text(&thousands);
    }
    parse_decimal_text(&compact)
}

fn is_group_space(c: char) -> bool {
    matches!(c, ' ' | '\u{a0}' | '\u{202f}')
}

/// O primeiro grupo existe, não é `0` e não começa por zero.
fn valid_first_group(text: &str, separator: char) -> bool {
    let first = text.split(separator).next().unwrap_or_default();
    !first.is_empty() && first != "0" && !js::leading_zero_digit(first)
}

/// `/^\d{1,3}(?:S\d{3})+$/`.
fn grouped_thousands(text: &str, separator: char) -> bool {
    let mut groups = text.split(separator);
    let first = groups.next().unwrap_or_default();
    let mut rest = groups.peekable();
    (1..=3).contains(&first.len())
        && js::all_digits(first)
        && rest.peek().is_some()
        && rest.all(|group| group.len() == 3 && js::all_digits(group))
}

/// `/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/`.
fn decimal_literal(text: &str) -> bool {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    match unsigned.split_once('.') {
        None => js::all_digits(unsigned),
        Some((whole, fraction)) => {
            let fraction_ok = fraction.is_empty() || js::all_digits(fraction);
            if whole.is_empty() {
                js::all_digits(fraction)
            } else {
                js::all_digits(whole) && fraction_ok
            }
        }
    }
}

/// `/^[+-]?[1-9]\d{0,2}(?:[   ]\d{3})+(?:[.,]\d+)?$/`.
fn space_grouped_money(text: &str) -> bool {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (integer, fraction) = match unsigned.find(['.', ',']) {
        Some(index) => (&unsigned[..index], Some(&unsigned[index + 1..])),
        None => (unsigned, None),
    };
    if fraction.is_some_and(|fraction| !js::all_digits(fraction)) {
        return false;
    }
    let mut groups = integer.split(is_group_space);
    let first = groups.next().unwrap_or_default();
    let mut rest = groups.peekable();
    (1..=3).contains(&first.len())
        && js::all_digits(first)
        && !first.starts_with('0')
        && rest.peek().is_some()
        && rest.all(|group| group.len() == 3 && js::all_digits(group))
}

/// `/^([+-]?)([1-9]\d{0,2})\.(\d{3})$/`, já sem o ponto.
fn br_thousands(text: &str) -> Option<String> {
    let (sign, unsigned) = match text.chars().next() {
        Some(c @ ('+' | '-')) => (c.to_string(), &text[1..]),
        _ => (String::new(), text),
    };
    let (high, low) = unsigned.split_once('.')?;
    let ok = (1..=3).contains(&high.len())
        && js::all_digits(high)
        && !high.starts_with('0')
        && low.len() == 3
        && js::all_digits(low);
    ok.then(|| format!("{sign}{high}{low}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_aceita() {
        for (input, expected) in [
            ("1,90", 1.9),
            ("0.50", 0.5),
            ("-0,25", -0.25),
            ("1.234,56", 1234.56),
            ("1,234.56", 1234.56),
            ("1.000.000,00", 1_000_000.0),
            ("1,000,000.00", 1_000_000.0),
            ("1.000.000", 1_000_000.0),
            ("1.000", 1.0),
            ("1.925", 1.925),
            ("+.5", 0.5),
            (" 3 ", 3.0),
        ] {
            assert_eq!(parse_decimal_text(input), Some(expected), "{input}");
        }
    }

    #[test]
    fn decimal_recusa() {
        for input in [
            "",
            "1,2,3",
            "12.34.567",
            "1.00.000,00",
            "abc",
            "00.000",
            "01.234.567",
            "0123",
            "1 2",
            "1.",
            "1,",
            "-",
            "+",
            ".",
            "1e5",
            "Infinity",
            "0,000.5",
            "1.234.5",
            "٣",
        ] {
            assert_eq!(parse_decimal_text(input), None, "{input:?}");
        }
    }

    #[test]
    fn dinheiro() {
        for (input, expected) in [
            ("1 234,56", Some(1234.56)),
            ("1\u{a0}234,56", Some(1234.56)),
            ("1\u{202f}234\u{202f}567.89", Some(1_234_567.89)),
            ("-12 345,67", Some(-12345.67)),
            ("1.000", Some(1000.0)),
            ("999.999", Some(999_999.0)),
            ("1.000,50", Some(1000.5)),
            ("-1.000", Some(-1000.0)),
            ("0.001", Some(0.001)),
            ("1 2", None),
            ("10 00", None),
            ("1,\n50", None),
            ("12\t34", None),
            ("USD 10", None),
            ("10 BRL", None),
        ] {
            assert_eq!(parse_money_text(input), expected, "{input:?}");
        }
    }
}
