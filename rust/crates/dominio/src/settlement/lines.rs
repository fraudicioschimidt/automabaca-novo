//! Linhas de handicap e de total em QUARTOS INTEIROS (linha × 4), portadas de
//! `src/domain/settlement/lines.ts`: a decisão de VOID e de meia-ganha vira
//! aritmética exata, sem epsilon de ponto flutuante decidindo dinheiro. Os
//! números são `f64`, como no JavaScript (o `-0` inclusive).

use crate::js;
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};

/// -0.25 → -1; 2.5 → 10; `None` quando não é múltiplo de 0.25.
pub fn line_to_quarters(line: f64) -> Option<f64> {
    if !line.is_finite() {
        return None;
    }
    let quarters = line * 4.0;
    let rounded = js::round(quarters);
    // Na linha enorme, ×4 estoura para infinito e a diferença é NaN: o TS
    // devolvia o infinito, porque `NaN > 1e-6` é falso.
    let off_quarter = (quarters - rounded).abs() > 1e-6;
    (!off_quarter).then_some(rounded)
}

/// O número de "2,5" ou "2.5". Quem chama passa só o que casou
/// `[+-]?\d+(?:[.,]\d+)?`, então o `Number()` do JS e o `parse` do Rust leem
/// o mesmo valor, com o mesmo arredondamento.
fn decimal_number(raw: &str) -> f64 {
    raw.replacen(',', ".", 1).parse().unwrap_or(f64::NAN)
}

/// `regex.replace(text, replacement)` só quando o texto tem o caractere que
/// toda forma da regex exige: sem ele, a troca não acontece e a regex nem roda.
fn replace_if(text: &str, needs: bool, regex: &Regex, replacement: &str) -> String {
    if needs {
        regex.replace(text, replacement)
    } else {
        text.to_owned()
    }
}

fn has_sign(text: &str) -> bool {
    text.contains(['+', '-'])
}

fn dashes() -> &'static Regex {
    regex!(r"[−–—]", "g")
}

fn loose_sign() -> &'static Regex {
    regex!(r"([+-])\s+(?=\d)", "g")
}

fn glued_split() -> &'static Regex {
    regex!(r"(\d\.\d+),(?=[+-]?\d)", "g")
}

fn normalize_line_text(text: &str) -> String {
    let normalized = normalize_str(text);
    let dashed = replace_if(
        &normalized,
        normalized.contains(['−', '–', '—']),
        dashes(),
        "-",
    );
    // Sinal SEPARADO do número por espaço ("Flamengo - 0.5", grafia comum de
    // OCR e de tipster): sem colar, a linha sai positiva e o handicap inverte
    // o dinheiro.
    let signed = replace_if(&dashed, has_sign(&dashed), loose_sign(), "$1");
    // Split Bet365 colado ("2.0,2.5") é DOIS números, não um decimal.
    replace_if(&signed, signed.contains(','), glued_split(), "$1, ")
}

fn split_pair() -> &'static Regex {
    regex!(r"\d\s*[,/]\s*[+-]?\d", "")
}

/// Dois números COLADOS por vírgula ou barra ("2.0,2.5", "-0.5, -1.0"): o
/// único caso em que a média define a linha. Recebe o texto já normalizado.
fn has_split_line_pair(normalized: &str) -> bool {
    split_pair().is_match(normalized)
}

/// Separador que NÃO é grafia conhecida de split line (";", "|", "&", " e "):
/// tirar média inventa uma linha, escolher uma perna decide dinheiro em
/// silêncio. Falha fechado.
pub const UNKNOWN_LINE_SEPARATOR: &str = r"\d\s*(?:[;|&]|\se\s)\s*[+-]?\d";

fn unknown_line_separator() -> &'static Regex {
    regex!(UNKNOWN_LINE_SEPARATOR, "")
}

fn directed_line() -> &'static Regex {
    regex!(
        r"\b(?:over|under|mais|menos|acima|abaixo)\b(?:\s+(?:de|que))?\s*([+-]?\d+(?:[.,]\d+)?)",
        "g"
    )
}

fn decimal_mark() -> &'static Regex {
    regex!(r"[.,]", "")
}

fn metadata_word() -> &'static Regex {
    regex!(
        r"\b(?:rodada|round|jornada|matchday|jogo|game|tempo|half|periodo|period|mapa|map|set)\b",
        ""
    )
}

fn round_ordinal() -> &'static Regex {
    regex!(r"(?:^|\s)\d+\s*[ªºa.]?\s*[rj]\.?(?:\s|$)", "")
}

fn signed_token() -> &'static Regex {
    regex!(r"(?:^|[\s(])([+-]\d+(?:[.,]\d+)?)(?=$|[\s)])", "g")
}

fn decimal_token() -> &'static Regex {
    regex!(r"(?:^|[^0-9])([0-9]+[.,][0-9]+)(?=$|[^0-9])", "g")
}

/// O grupo 1 de cada casamento, como número finito.
fn finite_groups(regex: &Regex, text: &str) -> Vec<f64> {
    regex
        .exec_all(text)
        .iter()
        .map(|found| decimal_number(found.get(1).unwrap_or("")))
        .filter(|value| value.is_finite())
        .collect()
}

/// Recebe o texto já normalizado.
fn unique_loose_line_candidate(normalized: &str) -> Option<f64> {
    if unknown_line_separator().is_match(normalized) {
        return None;
    }
    // Com a odd na captura, a linha continua inequívoca se estiver ligada à
    // direção do total ("Over 2.5 @ 1.90"): uma única ocorrência direcional.
    let directed = directed_line().exec_all(normalized);
    if let [only] = directed.as_slice() {
        let raw = only.get(1).unwrap_or("");
        let value = decimal_number(raw);
        if value.is_finite() {
            if decimal_mark().is_match(raw) {
                return Some(value);
            }
            // Linha inteira com outro número só quando o outro é metadado
            // rotulado ("Over 2 15ª R." → 2; "Over 2 5" segue ambíguo).
            if metadata_word().is_match(normalized) || round_ordinal().is_match(normalized) {
                return Some(value);
            }
        }
    }
    // Sinal explícito é a evidência mais forte em handicap; o parêntese é
    // fronteira como o espaço ("Schalke 04 (-1.5)").
    let signed = finite_groups(signed_token(), normalized);
    match signed.as_slice() {
        [only] => return Some(*only),
        // Dois números assinados que não formaram par não elegem vencedor: o
        // ramo decimal devolveria o valor absoluto e o LADO sumiria.
        [_, _, ..] => return None,
        [] => {}
    }
    // Sem sinal, uma única casa decimal diferencia a linha de números soltos.
    match finite_groups(decimal_token(), normalized).as_slice() {
        [only] => Some(*only),
        _ => None,
    }
}

/// Meio-tempo numerado ("1ºT", "(1°T)", "2T", "1º tempo", "1st half", "H1"):
/// o dígito dele não é número da linha.
fn numbered_half() -> &'static Regex {
    regex!(
        r"(?<![\d.,])\b(?:[12]\s*(?:[ºª°oa]|st|nd)?\s*(?:t|tempo|half|h|parte|etapa|metade)|h[12])\b",
        "gi"
    )
}

pub fn without_numbered_half(text: &str) -> String {
    numbered_half().replace(text, " ")
}

fn number_token() -> &'static Regex {
    regex!(
        r"(?:^|[^a-z0-9.,+-])([+-]?\d+(?:[.,]\d+)?)(?=$|[^0-9])",
        "g"
    )
}

pub fn extract_signed_numbers(text: &str) -> Vec<f64> {
    numbers_of_normalized(&normalize_line_text(text))
}

fn numbers_of_normalized(normalized: &str) -> Vec<f64> {
    let padded = format!(" {normalized} ");
    // A captura gulosa já engole o decimal; o lookahead só garante que não
    // paramos no meio de dígitos (vírgula de LISTA fica fora).
    finite_groups(number_token(), &padded)
}

fn comma_decimal() -> &'static Regex {
    regex!(r"(^|[^\d.,+-])([+-]\d+),(\d{1,2})(?=$|[^\d.,+-])", "g")
}

fn written_minus() -> &'static Regex {
    regex!(r"\bmenos\s+(?=\d)", "g")
}

fn written_plus() -> &'static Regex {
    regex!(r"\bmais\s+(?=\d)", "g")
}

fn spaced_legs() -> &'static Regex {
    regex!(r"([+-]\d+(?:[.,]\d+)?)\s+(?=[+-]\d)", "g")
}

fn next_signed_leg() -> &'static Regex {
    regex!(r"^[+-]\d+(?:[.,]\d+)?", "")
}

fn signed_zero_pair() -> &'static Regex {
    regex!(r"(^|[^\d.,])([+-])\s*0(?:[.,]0+)?\s*([,/])\s*(?=\d)", "g")
}

fn signed_zero_first_leg() -> &'static Regex {
    regex!(
        r"(^|[^\d.,])[+-]\s*0(?:[.,]0+)?(?=\s*[,/]\s*(?:[+-]|\d+[.,]\d))",
        "g"
    )
}

fn signed_zero_second_leg() -> &'static Regex {
    regex!(r"([,/]\s*)[+-]\s*0(?:[.,]0+)?(?=$|[^\d.,])", "g")
}

fn comma_before_signed() -> &'static Regex {
    regex!(r"(\d)\s*,(?=\s*[+-]\d)", "g")
}

fn zero_first_leg() -> &'static Regex {
    regex!(r"(^|[^\d.,])(0(?:[.,]0+)?)\s*,(?=\s*\d+[.,]\d)", "g")
}

fn total_comma_split() -> &'static Regex {
    regex!(r"(\d+),(?=\d+\.\d)", "g")
}

fn sign_glued_to_separator() -> &'static Regex {
    regex!(r"\d\s*[+-]\s*[,/]", "")
}

fn split_legs() -> &'static Regex {
    regex!(
        r"(?:^|[^\d.,+-])([+-]?)\s*(\d+(?:[.,]\d+)?)\s*([,/])\s*([+-]?)\s*(\d+(?:[.,]\d+)?)(?=$|[^\d.,+-])",
        ""
    )
}

/// As pernas separadas só por espaço ("+0 -0.5", "-1 -1.5") são a split line
/// que a vírgula grafa, quando distam exatamente meia linha (a definição de
/// quarter line); "-0.5 -110" (linha e odd americana) fica como está.
fn join_spaced_legs(text: &str) -> String {
    spaced_legs().replace_with(text, |found| {
        let whole = found.get(0).unwrap_or("");
        let first = found.get(1).unwrap_or("");
        let Some(second) = next_signed_leg()
            .exec(&text[found.end()..])
            .and_then(|next| next.get(0))
        else {
            return whole.to_owned();
        };
        match (
            line_to_quarters(decimal_number(first)),
            line_to_quarters(decimal_number(second)),
        ) {
            (Some(a), Some(b)) if (a - b).abs() == 2.0 => format!("{first}, "),
            _ => whole.to_owned(),
        }
    })
}

/// O que `new RegExp("([+-]?\s*FIRST\s*SEP\s*)SECOND").exec(text)` acharia,
/// com as pernas e o separador como literais: onde o casamento começa, onde
/// o grupo 1 termina e onde o casamento termina, em bytes. Cada pedaço começa
/// num dígito, num sinal ou num espaço, então a busca da esquerda para a
/// direita sem retrocesso dá o mesmo casamento que o `RegExp`.
fn find_leg_pair(
    text: &str,
    first: &str,
    sep: &str,
    second: &str,
) -> Option<(usize, usize, usize)> {
    let skip_space = |from: usize| {
        text[from..]
            .char_indices()
            .find(|(_, c)| !js::is_whitespace(*c))
            .map_or(text.len(), |(at, _)| from + at)
    };
    text.char_indices().map(|(at, _)| at).find_map(|start| {
        let mut at = start;
        if text[at..].starts_with(['+', '-']) {
            at += 1;
        }
        at = skip_space(at);
        at = at
            .checked_add(first.len())
            .filter(|_| text[at..].starts_with(first))?;
        at = skip_space(at);
        at = at
            .checked_add(sep.len())
            .filter(|_| text[at..].starts_with(sep))?;
        let group_end = skip_space(at);
        let end = group_end
            .checked_add(second.len())
            .filter(|_| text[group_end..].starts_with(second))?;
        Some((start, group_end, end))
    })
}

/// Linha da seleção em quartos. Duas linhas explícitas ("-0.5, -1.0") viram
/// a média (quarter line). `allow_negative` distingue handicap (±) de total
/// (≥ 0).
pub fn parse_line_quarters(selecao: &str, allow_negative: bool) -> Option<f64> {
    // Decimais com vírgula sem split ("-0,5", "Flamengo -1,75") viram ponto.
    let with_point = replace_if(selecao, selecao.contains(','), comma_decimal(), "$1$2.$3");
    // O sinal colado ao número ANTES das regras de split, que procuram `[+-]\d`.
    let glued = replace_if(&with_point, has_sign(&with_point), loose_sign(), "$1");
    let mut line_text = if allow_negative {
        // "mais"/"menos" por extenso são o sinal escrito em PT, no handicap; a
        // forma com preposição ("menos DE 0.5") é direção de total.
        let minus = replace_if(&glued, glued.contains("menos"), written_minus(), "-");
        let plus = replace_if(&minus, minus.contains("mais"), written_plus(), "+");
        // Duas pernas pedem dois sinais.
        let legs = if plus.matches(['+', '-']).count() >= 2 {
            join_spaced_legs(&plus)
        } else {
            plus
        };
        // Zero com sinal e segunda perna sem sinal (`-0/0.5` é -0.25): o
        // sinal é do par. `+0`/`-0` é zero neutro em qualquer perna.
        // As trocas do zero pedem um "0", um sinal e um separador.
        let zero = |text: &str| text.contains('0') && has_sign(text) && text.contains([',', '/']);
        let zero_pair = replace_if(&legs, zero(&legs), signed_zero_pair(), "$1 0$3$2");
        let zero_first = replace_if(
            &zero_pair,
            zero(&zero_pair),
            signed_zero_first_leg(),
            "$1 0",
        );
        // "$10" com um grupo só é o grupo 1 e um "0", como no JS.
        let zero_second = replace_if(
            &zero_first,
            zero(&zero_first),
            signed_zero_second_leg(),
            "$10",
        );
        let comma = replace_if(
            &zero_second,
            zero_second.contains(',') && has_sign(&zero_second),
            comma_before_signed(),
            "$1, ",
        );
        // Primeira perna ZERO com a segunda sem sinal (`0,0.5` = +0.25).
        replace_if(
            &comma,
            comma.contains(',') && comma.contains('0'),
            zero_first_leg(),
            "$1$2, ",
        )
    } else {
        // Total Bet365 cru (`Over 2,2.5`): a vírgula antes de uma perna
        // decimal é split.
        replace_if(&glued, glued.contains(','), total_comma_split(), "$1, ")
    };
    if allow_negative {
        // Sinal solto grudado na vírgula (`1-,1.5`) é grafia corrompida, com
        // dois lados opostos possíveis: recusa.
        let normalized = normalize_line_text(&line_text);
        if sign_glued_to_separator().is_match(&normalized) {
            return None;
        }
        if let Some(found) = split_legs().exec(&normalized) {
            let first_sign = found.get(1).unwrap_or("");
            let first_body = found.get(2).unwrap_or("");
            let sep = found.get(3).unwrap_or(",");
            let second_sign = found.get(4).unwrap_or("");
            let second_body = found.get(5).unwrap_or("");
            let is_split = sep == "/"
                || first_body.contains('.')
                || second_body.contains('.')
                || !second_sign.is_empty();
            if is_split {
                // Sinais explícitos opostos não formam linha asiática.
                if !first_sign.is_empty() && !second_sign.is_empty() && first_sign != second_sign {
                    return None;
                }
                // Primeira perna sem sinal e não zero ("2, 2.5", "2, -2.5").
                if first_sign.is_empty() && decimal_number(first_body) != 0.0 {
                    return None;
                }
                // A segunda perna sem sinal herda o da primeira. O TS montava
                // a regex com os números da aposta; aqui a busca é literal.
                if !first_sign.is_empty()
                    && second_sign.is_empty()
                    && let Some((start, group_end, end)) =
                        find_leg_pair(&line_text, first_body, sep, second_body)
                {
                    line_text = format!(
                        "{}{} {first_sign}{second_body}{}",
                        &line_text[..start],
                        &line_text[start..group_end],
                        &line_text[end..]
                    );
                }
            }
        }
    }
    let normalized = normalize_line_text(&line_text);
    let values: Vec<f64> = numbers_of_normalized(&normalized)
        .into_iter()
        .filter(|value| allow_negative || *value >= 0.0)
        .collect();
    match values.as_slice() {
        [] => None,
        [only] => line_to_quarters(*only),
        // Dois números só viram quarter line quando são um par COLADO por
        // vírgula ou barra; soltos, só um candidato marcado por sinal ou casa
        // decimal, senão falha fechado.
        [first, second] => {
            if !has_split_line_pair(&normalized) {
                return unique_loose_line_candidate(&normalized).and_then(line_to_quarters);
            }
            let a = line_to_quarters(*first)?;
            let b = line_to_quarters(*second)?;
            // Split por vírgula ou barra dista exatamente meia linha.
            if (a - b).abs() != 2.0 {
                return None;
            }
            let mid = (a + b) / 2.0;
            (mid.fract() == 0.0).then_some(mid)
        }
        // Três ou mais números não definem uma linha asiática unívoca.
        _ => None,
    }
}

/// Diferença ajustada em quartos → status: ±1 quarto é meia, 0 é devolução.
pub fn status_from_adjusted_quarters(adjusted: f64) -> &'static str {
    if adjusted == 0.0 {
        "VOID"
    } else if adjusted == 1.0 {
        "HALF_WON"
    } else if adjusted == -1.0 {
        "HALF_LOST"
    } else if adjusted > 0.0 {
        "WON"
    } else {
        "LOST"
    }
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        dashes(),
        loose_sign(),
        glued_split(),
        split_pair(),
        unknown_line_separator(),
        directed_line(),
        decimal_mark(),
        metadata_word(),
        round_ordinal(),
        signed_token(),
        decimal_token(),
        numbered_half(),
        number_token(),
        comma_decimal(),
        written_minus(),
        written_plus(),
        spaced_legs(),
        next_signed_leg(),
        signed_zero_pair(),
        signed_zero_first_leg(),
        signed_zero_second_leg(),
        comma_before_signed(),
        zero_first_leg(),
        total_comma_split(),
        sign_glued_to_separator(),
        split_legs(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linha_em_quartos() {
        assert_eq!(parse_line_quarters("Flamengo -0.5", true), Some(-2.0));
        assert_eq!(parse_line_quarters("Flamengo - 0.5", true), Some(-2.0));
        assert_eq!(parse_line_quarters("0,-0.5", true), Some(-1.0));
        assert_eq!(parse_line_quarters("-0.5, 1.0", true), Some(-3.0));
        assert_eq!(parse_line_quarters("Over 2.0,2.5", false), Some(9.0));
        assert_eq!(parse_line_quarters("Over 2 5", false), None);
        assert_eq!(parse_line_quarters("Flamengo -0.5 -110", true), None);
        assert_eq!(parse_line_quarters("1-,1.5", true), None);
        assert_eq!(line_to_quarters(0.3), None);
        assert_eq!(status_from_adjusted_quarters(-1.0), "HALF_LOST");
    }

    #[test]
    fn par_de_pernas_literal() {
        assert_eq!(
            find_leg_pair("x  -1 , 1.5", "1", ",", "1.5"),
            Some((3, 8, 11))
        );
        assert_eq!(find_leg_pair("12,5", "2", ",", "5"), Some((1, 3, 4)));
        assert_eq!(find_leg_pair("1;2", "1", ",", "2"), None);
    }
}
