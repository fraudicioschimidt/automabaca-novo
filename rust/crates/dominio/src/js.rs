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
    fn digitos_ascii() {
        assert!(all_digits("0123"));
        assert!(!all_digits(""));
        assert!(!all_digits("١٢"));
        assert!(leading_zero_digit("01"));
        assert!(!leading_zero_digit("0"));
        assert!(!leading_zero_digit("0,1"));
    }
}
