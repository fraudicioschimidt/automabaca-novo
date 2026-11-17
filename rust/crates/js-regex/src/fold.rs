//! O ajuste de caixa do `regress` (só no servidor): o padrão reescrito e o
//! texto com os caracteres divergentes trocados, para o `/i` sem `u` casar
//! como no V8.

/// O `/i` sem `u` do JavaScript compara pela regra do `toUpperCase` (uma
/// unidade só, e nunca de não-ASCII para ASCII); o `regress` compara pela
/// dobra de caixa do Unicode. Os dois só discordam nestes caracteres do BMP
/// (varredura de todos os que mudam de caixa): para o V8, `ı` e `ſ` não casam
/// com `i` e `s`, e a letra grega com iota subscrito não casa com a forma
/// titlecase. Do lado do `regress`, cada um vira um não-caractere do Unicode
/// (U+FDD0…), no texto e no padrão, e assim só casa consigo mesmo, como no V8.
pub(crate) const FOLD_DIVERGENT: [u16; 29] = [
    0x0131, 0x017F, // ı ſ
    0x1F88, 0x1F89, 0x1F8A, 0x1F8B, 0x1F8C, 0x1F8D, 0x1F8E, 0x1F8F, // ᾈ…ᾏ
    0x1F98, 0x1F99, 0x1F9A, 0x1F9B, 0x1F9C, 0x1F9D, 0x1F9E, 0x1F9F, // ᾘ…ᾟ
    0x1FA8, 0x1FA9, 0x1FAA, 0x1FAB, 0x1FAC, 0x1FAD, 0x1FAE, 0x1FAF, // ᾨ…ᾯ
    0x1FBC, 0x1FCC, 0x1FFC, // ᾼ ῌ ῼ
];
const PLACEHOLDER_START: u16 = 0xFDD0;
const PLACEHOLDER_END: u16 = 0xFDEF;

/// O substituto de um caractere de `FOLD_DIVERGENT`.
pub(crate) fn placeholder(unit: u16) -> Option<u16> {
    FOLD_DIVERGENT
        .iter()
        .position(|divergent| *divergent == unit)
        .map(|index| PLACEHOLDER_START + index as u16)
}

/// O padrão com cada caractere de `FOLD_DIVERGENT` trocado pelo substituto, e
/// com o substituto acrescentado à classe cujo intervalo contém o caractere.
/// Recusa o que a reescrita não sabe tratar (intervalo de classe com ponta que
/// ela não lê, ou que cobre os próprios substitutos): o catálogo de regex do
/// domínio é compilado nos testes, e a recusa aparece lá.
pub(crate) fn rewrite_for_fold(source: &str) -> Result<String, String> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            i = rewrite_class(&chars, i, &mut out)?;
            continue;
        }
        let (atom, next) = read_atom(&chars, i);
        match atom {
            Atom::Unit(unit) if placeholder(unit).is_some() => push_placeholder(&mut out, unit),
            _ => out.extend(&chars[i..next]),
        }
        i = next;
    }
    Ok(out)
}

#[derive(Clone, Copy, PartialEq)]
enum Atom {
    /// Um caractere de valor conhecido (literal, `\uXXXX`, `\xHH`, escape de identidade).
    Unit(u16),
    /// Escape de classe ou de valor que a reescrita não precisa saber (`\d`, `\b`, `\1`…).
    Other,
}

/// Lê um átomo a partir de `i`: devolve o átomo e a posição depois dele.
fn read_atom(chars: &[char], i: usize) -> (Atom, usize) {
    if chars[i] != '\\' {
        let mut buffer = [0u16; 2];
        let units = chars[i].encode_utf16(&mut buffer);
        let atom = if units.len() == 1 {
            Atom::Unit(units[0])
        } else {
            Atom::Other
        };
        return (atom, i + 1);
    }
    let Some(&escaped) = chars.get(i + 1) else {
        return (Atom::Other, i + 1);
    };
    let hex = |from: usize, count: usize| -> Option<u16> {
        let digits: String = chars.get(from..from + count)?.iter().collect();
        u16::from_str_radix(&digits, 16)
            .ok()
            .filter(|_| digits.len() == count)
    };
    match escaped {
        'u' => match hex(i + 2, 4) {
            Some(unit) => (Atom::Unit(unit), i + 6),
            None => (Atom::Unit('u' as u16), i + 2),
        },
        'x' => match hex(i + 2, 2) {
            Some(unit) => (Atom::Unit(unit), i + 4),
            None => (Atom::Unit('x' as u16), i + 2),
        },
        'd' | 'D' | 'w' | 'W' | 's' | 'S' | 'b' | 'B' | 'c' | 'k' | 'p' | 'P' | '0'..='9' => {
            (Atom::Other, i + 2)
        }
        't' => (Atom::Unit(0x09), i + 2),
        'n' => (Atom::Unit(0x0A), i + 2),
        'v' => (Atom::Unit(0x0B), i + 2),
        'f' => (Atom::Unit(0x0C), i + 2),
        'r' => (Atom::Unit(0x0D), i + 2),
        other if (other as u32) < 0x10000 => (Atom::Unit(other as u16), i + 2),
        _ => (Atom::Other, i + 2),
    }
}

fn push_placeholder(out: &mut String, unit: u16) {
    if let Some(substitute) = placeholder(unit) {
        out.push_str(&format!("\\u{substitute:04X}"));
    }
}

/// Reescreve a classe que começa em `start` (no `[`) e devolve a posição
/// depois do `]`.
fn rewrite_class(chars: &[char], start: usize, out: &mut String) -> Result<usize, String> {
    let mut i = start + 1;
    let mut body = String::new();
    let mut extra: Vec<u16> = Vec::new();
    if chars.get(i) == Some(&'^') {
        body.push('^');
        i += 1;
    }
    // No JavaScript o `]` logo depois do `[` fecha a classe (`[]` não casa nada).
    while i < chars.len() && chars[i] != ']' {
        let (low, after_low) = read_atom(chars, i);
        let is_range = chars.get(after_low) == Some(&'-')
            && chars.get(after_low + 1).is_some_and(|c| *c != ']');
        if is_range {
            let (high, after_high) = read_atom(chars, after_low + 1);
            let (Atom::Unit(low), Atom::Unit(high)) = (low, high) else {
                return Err(format!(
                    "intervalo de classe que o ajuste de caixa não lê: {}",
                    chars[i..after_high].iter().collect::<String>()
                ));
            };
            if low <= PLACEHOLDER_END && high >= PLACEHOLDER_START {
                return Err("intervalo de classe que cobre U+FDD0–U+FDEF".to_owned());
            }
            extra.extend(
                FOLD_DIVERGENT
                    .iter()
                    .filter(|unit| (low..=high).contains(unit)),
            );
            body.extend(&chars[i..after_high]);
            i = after_high;
            continue;
        }
        match low {
            Atom::Unit(unit) if placeholder(unit).is_some() => push_placeholder(&mut body, unit),
            Atom::Unit(unit) if (PLACEHOLDER_START..=PLACEHOLDER_END).contains(&unit) => {
                return Err("classe com caractere de U+FDD0–U+FDEF".to_owned());
            }
            _ => body.extend(&chars[i..after_low]),
        }
        i = after_low;
    }
    out.push('[');
    out.push_str(&body);
    for unit in extra {
        push_placeholder(out, unit);
    }
    out.push(']');
    Ok(i + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reescrita_do_ajuste_de_caixa() {
        assert_eq!(
            rewrite_for_fold("kası[ıa]").as_deref(),
            Ok(r"kas\uFDD0[\uFDD0a]")
        );
        assert_eq!(rewrite_for_fold(r"\u017F").as_deref(), Ok(r"\uFDD1"));
        // Intervalo que contém o ı e o ſ ganha os dois substitutos.
        assert_eq!(
            rewrite_for_fold(r"[a-z\u0100-\u017F]").as_deref(),
            Ok(r"[a-z\u0100-\u017F\uFDD0\uFDD1]")
        );
        assert_eq!(rewrite_for_fold(r"[^\d\s-]").as_deref(), Ok(r"[^\d\s-]"));
        assert!(rewrite_for_fold(r"[\uFD00-\uFDFF]").is_err());
    }
}
