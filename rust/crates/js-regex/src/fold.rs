//! O `/i` sem `u` do `regress` (só no servidor). O JavaScript compara pela
//! regra `Canonicalize`: o `toUpperCase` de uma unidade UTF-16, se der uma
//! unidade só e não levar um não-ASCII para ASCII. O `regress` compara pela
//! dobra de caixa do Unicode, e os dois discordam em dezenas de caracteres
//! (ı e ſ casariam com i e s; o grego com iota subscrito, com a forma
//! titlecase; K de Kelvin, Å de Ångström, Ω de Ohm, ẞ, ϴ… dentro de
//! intervalos de classe). Por isso o padrão vai ao `regress` sem o `i`, e cada
//! letra (literal ou de classe) vira a classe exata dos caracteres que o V8
//! iguala a ela.

use std::collections::HashMap;
use std::sync::LazyLock;

/// `Canonicalize(ch)` do ECMAScript sem a flag `u`.
fn canonicalize(unit: u16) -> u16 {
    let Some(character) = char::from_u32(u32::from(unit)) else {
        return unit;
    };
    let mut upper = character.to_uppercase();
    let (Some(single), None) = (upper.next(), upper.next()) else {
        return unit;
    };
    let mut buffer = [0u16; 2];
    let units = single.encode_utf16(&mut buffer);
    if units.len() != 1 || (unit >= 128 && units[0] < 128) {
        return unit;
    }
    units[0]
}

/// Para cada valor canônico com mais de um caractere, os caracteres que o têm.
static EQUIVALENTS: LazyLock<HashMap<u16, Vec<u16>>> = LazyLock::new(|| {
    let mut classes: HashMap<u16, Vec<u16>> = HashMap::new();
    for unit in 0..=u16::MAX {
        classes.entry(canonicalize(unit)).or_default().push(unit);
    }
    classes.retain(|_, members| members.len() > 1);
    classes
});

/// Os caracteres que o V8 iguala a `unit` no `/i` sem `u` (ele mesmo incluso).
fn equivalents(unit: u16) -> Vec<u16> {
    EQUIVALENTS
        .get(&canonicalize(unit))
        .cloned()
        .unwrap_or_else(|| vec![unit])
}

/// O padrão para o `regress` compilar sem `i`, com o casamento sem caixa do V8.
pub(crate) fn rewrite_for_fold(source: &str) -> Result<String, String> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len() * 2);
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '[' => {
                i = rewrite_class(&chars, i, &mut out)?;
                continue;
            }
            // Nome de grupo e de referência nomeada não são letras do padrão.
            '(' if chars.get(i + 1) == Some(&'?')
                && chars.get(i + 2) == Some(&'<')
                && !matches!(chars.get(i + 3), Some('=') | Some('!')) =>
            {
                let close = chars[i..]
                    .iter()
                    .position(|c| *c == '>')
                    .map_or(chars.len(), |p| i + p + 1);
                out.extend(&chars[i..close]);
                i = close;
                continue;
            }
            '\\' if chars.get(i + 1) == Some(&'k') && chars.get(i + 2) == Some(&'<') => {
                let close = chars[i..]
                    .iter()
                    .position(|c| *c == '>')
                    .map_or(chars.len(), |p| i + p + 1);
                out.extend(&chars[i..close]);
                i = close;
                continue;
            }
            '\\' if chars.get(i + 1).is_some_and(|c| ('1'..='9').contains(c)) => {
                // O `regress` sem `i` compararia o grupo com caixa.
                return Err(
                    "referência a grupo com /i sem u: o ajuste de caixa não a trata".to_owned(),
                );
            }
            _ => {}
        }
        let (atom, next) = read_atom(&chars, i);
        match atom {
            Atom::Unit(unit) if equivalents(unit).len() > 1 => {
                out.push('[');
                for member in equivalents(unit) {
                    push_unit(&mut out, member);
                }
                out.push(']');
            }
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
    /// Escape de classe ou de valor que a reescrita não precisa saber (`\d`, `\b`…).
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

fn push_unit(out: &mut String, unit: u16) {
    out.push_str(&format!("\\u{unit:04X}"));
}

/// Reescreve a classe que começa em `start` (no `[`) e devolve a posição
/// depois do `]`. Cada membro ganha os equivalentes do V8 que estão fora
/// dela: a classe passa a casar sem `i` exatamente o que o V8 casa com `i`,
/// e a negada, o complemento disso, como no V8.
fn rewrite_class(chars: &[char], start: usize, out: &mut String) -> Result<usize, String> {
    let mut i = start + 1;
    out.push('[');
    if chars.get(i) == Some(&'^') {
        out.push('^');
        i += 1;
    }
    let mut members: Vec<(u16, u16)> = Vec::new();
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
            members.push((low, high));
            out.extend(&chars[i..after_high]);
            i = after_high;
            continue;
        }
        if let Atom::Unit(unit) = low {
            members.push((unit, unit));
        }
        out.extend(&chars[i..after_low]);
        i = after_low;
    }
    let inside = |unit: u16| {
        members
            .iter()
            .any(|(low, high)| (*low..=*high).contains(&unit))
    };
    let mut extra: Vec<u16> = members
        .iter()
        .flat_map(|(low, high)| *low..=*high)
        .filter(|unit| EQUIVALENTS.contains_key(&canonicalize(*unit)))
        .flat_map(equivalents)
        .filter(|unit| !inside(*unit))
        .collect();
    extra.sort_unstable();
    extra.dedup();
    for unit in extra {
        push_unit(out, unit);
    }
    out.push(']');
    Ok(i + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classe_exata_do_v8() {
        assert_eq!(rewrite_for_fold("k1").as_deref(), Ok(r"[\u004B\u006B]1"));
        // ı e ſ não têm equivalente no V8: ficam como estão.
        assert_eq!(rewrite_for_fold("ı").as_deref(), Ok("ı"));
        assert_eq!(
            rewrite_for_fold("[a-c]").as_deref(),
            Ok(r"[a-c\u0041\u0042\u0043]")
        );
        assert_eq!(
            rewrite_for_fold(r"(?<dia>x)\k<dia>").as_deref(),
            Ok(r"(?<dia>[\u0058\u0078])\k<dia>")
        );
        assert_eq!(rewrite_for_fold(r"[^\d\s-]").as_deref(), Ok(r"[^\d\s-]"));
        assert!(rewrite_for_fold(r"(\w)\1").is_err());
    }
}
