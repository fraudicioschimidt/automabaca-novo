//! As funções de texto do JavaScript que dependem dos dados do Unicode, na
//! combinação que o domínio usa para comparar nomes:
//! `normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()`. O domínio
//! em TypeScript usava as do V8 (ICU); portado, ele tem de dar o mesmo texto
//! no servidor e no navegador. É uma operação só para o navegador cruzar para
//! o host uma vez por texto. Mais o `toUpperCase()` e o `toLowerCase()`, e a
//! dobra de caixa com que o `RegExp` com `iu` compara caracteres.
//!
//! - No navegador, as próprias funções do host, as mesmas que o TypeScript
//!   usava ali, sem tabela do Unicode no binário.
//! - No servidor, o `unicode-normalization` e o `to_lowercase` da std, ambos
//!   no Unicode 17 como o Node 24 (ICU 78), e a tabela de `\p{Diacritic}`
//!   tirada do V8. `tests/plataforma/js-text.test.ts` confere cada ponto de
//!   código contra o V8.

#[cfg(target_arch = "wasm32")]
mod backend {
    use wasm_bindgen::prelude::wasm_bindgen;

    #[wasm_bindgen(inline_js = r#"
export function jsTextToUpperCase(text) { return text.toUpperCase(); }
export function jsTextToLowerCase(text) { return text.toLowerCase(); }
export function jsTextLowerEach(text) {
  let out = "";
  for (const c of text) { const lower = c.toLowerCase(); out += [...lower].length === 1 ? lower : c; }
  return out;
}
export function jsTextNfdWithoutCombiningMarks(text) { return text.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
export function jsTextWithoutDiacritics(text) { return text.normalize("NFD").replace(/\p{Diacritic}/gu, ""); }
export function jsTextFoldForMatching(text) {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}
"#)]
    extern "C" {
        #[wasm_bindgen(js_name = jsTextFoldForMatching)]
        pub fn fold_for_matching(text: &str) -> String;
        #[wasm_bindgen(js_name = jsTextToUpperCase)]
        pub fn to_upper_case(text: &str) -> String;
        #[wasm_bindgen(js_name = jsTextToLowerCase)]
        pub fn to_lower_case(text: &str) -> String;
        #[wasm_bindgen(js_name = jsTextLowerEach)]
        pub fn lower_each(text: &str) -> String;
        #[wasm_bindgen(js_name = jsTextNfdWithoutCombiningMarks)]
        pub fn nfd_without_combining_marks(text: &str) -> String;
        #[wasm_bindgen(js_name = jsTextWithoutDiacritics)]
        pub fn without_diacritics(text: &str) -> String;
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod backend {
    use unicode_normalization::UnicodeNormalization;

    /// `\p{Diacritic}` do V8 (Unicode 17), em intervalos fechados.
    const DIACRITIC: [(u32, u32); 220] = [
        (0x005E, 0x005E),
        (0x0060, 0x0060),
        (0x00A8, 0x00A8),
        (0x00AF, 0x00AF),
        (0x00B4, 0x00B4),
        (0x00B7, 0x00B8),
        (0x02B0, 0x034E),
        (0x0350, 0x0357),
        (0x035D, 0x0362),
        (0x0374, 0x0375),
        (0x037A, 0x037A),
        (0x0384, 0x0385),
        (0x0483, 0x0487),
        (0x0559, 0x0559),
        (0x0591, 0x05BD),
        (0x05BF, 0x05BF),
        (0x05C1, 0x05C2),
        (0x05C4, 0x05C5),
        (0x05C7, 0x05C7),
        (0x064B, 0x0652),
        (0x0657, 0x0658),
        (0x06DF, 0x06E0),
        (0x06E5, 0x06E6),
        (0x06EA, 0x06EC),
        (0x0730, 0x074A),
        (0x07A6, 0x07B0),
        (0x07EB, 0x07F5),
        (0x0818, 0x0819),
        (0x0898, 0x089F),
        (0x08C9, 0x08D2),
        (0x08E3, 0x08FE),
        (0x093C, 0x093C),
        (0x094D, 0x094D),
        (0x0951, 0x0954),
        (0x0971, 0x0971),
        (0x09BC, 0x09BC),
        (0x09CD, 0x09CD),
        (0x0A3C, 0x0A3C),
        (0x0A4D, 0x0A4D),
        (0x0ABC, 0x0ABC),
        (0x0ACD, 0x0ACD),
        (0x0AFD, 0x0AFF),
        (0x0B3C, 0x0B3C),
        (0x0B4D, 0x0B4D),
        (0x0B55, 0x0B55),
        (0x0BCD, 0x0BCD),
        (0x0C3C, 0x0C3C),
        (0x0C4D, 0x0C4D),
        (0x0CBC, 0x0CBC),
        (0x0CCD, 0x0CCD),
        (0x0D3B, 0x0D3C),
        (0x0D4D, 0x0D4D),
        (0x0DCA, 0x0DCA),
        (0x0E3A, 0x0E3A),
        (0x0E47, 0x0E4C),
        (0x0E4E, 0x0E4E),
        (0x0EBA, 0x0EBA),
        (0x0EC8, 0x0ECC),
        (0x0F18, 0x0F19),
        (0x0F35, 0x0F35),
        (0x0F37, 0x0F37),
        (0x0F39, 0x0F39),
        (0x0F3E, 0x0F3F),
        (0x0F82, 0x0F84),
        (0x0F86, 0x0F87),
        (0x0FC6, 0x0FC6),
        (0x1037, 0x1037),
        (0x1039, 0x103A),
        (0x1063, 0x1064),
        (0x1069, 0x106D),
        (0x1087, 0x108D),
        (0x108F, 0x108F),
        (0x109A, 0x109B),
        (0x135D, 0x135F),
        (0x1714, 0x1715),
        (0x1734, 0x1734),
        (0x17C9, 0x17D3),
        (0x17DD, 0x17DD),
        (0x1939, 0x193B),
        (0x1A60, 0x1A60),
        (0x1A75, 0x1A7C),
        (0x1A7F, 0x1A7F),
        (0x1AB0, 0x1ABE),
        (0x1AC1, 0x1ACB),
        (0x1ACF, 0x1ADD),
        (0x1AE0, 0x1AEB),
        (0x1B34, 0x1B34),
        (0x1B44, 0x1B44),
        (0x1B6B, 0x1B73),
        (0x1BAA, 0x1BAB),
        (0x1BE6, 0x1BE6),
        (0x1BF2, 0x1BF3),
        (0x1C36, 0x1C37),
        (0x1C78, 0x1C7D),
        (0x1CD0, 0x1CE8),
        (0x1CED, 0x1CED),
        (0x1CF4, 0x1CF4),
        (0x1CF7, 0x1CF9),
        (0x1D2C, 0x1D6A),
        (0x1D9B, 0x1DBE),
        (0x1DC4, 0x1DCF),
        (0x1DF5, 0x1DFF),
        (0x1FBD, 0x1FBD),
        (0x1FBF, 0x1FC1),
        (0x1FCD, 0x1FCF),
        (0x1FDD, 0x1FDF),
        (0x1FED, 0x1FEF),
        (0x1FFD, 0x1FFE),
        (0x2CEF, 0x2CF1),
        (0x2E2F, 0x2E2F),
        (0x302A, 0x302F),
        (0x3099, 0x309C),
        (0x30FC, 0x30FC),
        (0xA66F, 0xA66F),
        (0xA67C, 0xA67D),
        (0xA67F, 0xA67F),
        (0xA69C, 0xA69D),
        (0xA6F0, 0xA6F1),
        (0xA700, 0xA721),
        (0xA788, 0xA78A),
        (0xA7F1, 0xA7F1),
        (0xA7F8, 0xA7F9),
        (0xA806, 0xA806),
        (0xA82C, 0xA82C),
        (0xA8C4, 0xA8C4),
        (0xA8E0, 0xA8F1),
        (0xA92B, 0xA92E),
        (0xA953, 0xA953),
        (0xA9B3, 0xA9B3),
        (0xA9C0, 0xA9C0),
        (0xA9E5, 0xA9E5),
        (0xAA7B, 0xAA7D),
        (0xAABF, 0xAAC2),
        (0xAAF6, 0xAAF6),
        (0xAB5B, 0xAB5F),
        (0xAB69, 0xAB6B),
        (0xABEC, 0xABED),
        (0xFB1E, 0xFB1E),
        (0xFE20, 0xFE2F),
        (0xFF3E, 0xFF3E),
        (0xFF40, 0xFF40),
        (0xFF70, 0xFF70),
        (0xFF9E, 0xFF9F),
        (0xFFE3, 0xFFE3),
        (0x102E0, 0x102E0),
        (0x10780, 0x10785),
        (0x10787, 0x107B0),
        (0x107B2, 0x107BA),
        (0x10A38, 0x10A3A),
        (0x10A3F, 0x10A3F),
        (0x10AE5, 0x10AE6),
        (0x10D22, 0x10D27),
        (0x10D4E, 0x10D4E),
        (0x10D69, 0x10D6D),
        (0x10EFA, 0x10EFA),
        (0x10EFD, 0x10EFF),
        (0x10F46, 0x10F50),
        (0x10F82, 0x10F85),
        (0x11046, 0x11046),
        (0x11070, 0x11070),
        (0x110B9, 0x110BA),
        (0x11133, 0x11134),
        (0x11173, 0x11173),
        (0x111C0, 0x111C0),
        (0x111CA, 0x111CC),
        (0x11235, 0x11236),
        (0x112E9, 0x112EA),
        (0x1133B, 0x1133C),
        (0x1134D, 0x1134D),
        (0x11366, 0x1136C),
        (0x11370, 0x11374),
        (0x113CE, 0x113D0),
        (0x113D2, 0x113D3),
        (0x113E1, 0x113E2),
        (0x11442, 0x11442),
        (0x11446, 0x11446),
        (0x114C2, 0x114C3),
        (0x115BF, 0x115C0),
        (0x1163F, 0x1163F),
        (0x116B6, 0x116B7),
        (0x1172B, 0x1172B),
        (0x11839, 0x1183A),
        (0x1193D, 0x1193E),
        (0x11943, 0x11943),
        (0x119E0, 0x119E0),
        (0x11A34, 0x11A34),
        (0x11A47, 0x11A47),
        (0x11A99, 0x11A99),
        (0x11C3F, 0x11C3F),
        (0x11D42, 0x11D42),
        (0x11D44, 0x11D45),
        (0x11D97, 0x11D97),
        (0x11DD9, 0x11DD9),
        (0x11F41, 0x11F42),
        (0x11F5A, 0x11F5A),
        (0x13447, 0x13455),
        (0x1612F, 0x1612F),
        (0x16AF0, 0x16AF4),
        (0x16B30, 0x16B36),
        (0x16D6B, 0x16D6C),
        (0x16F8F, 0x16F9F),
        (0x16FF0, 0x16FF1),
        (0x1AFF0, 0x1AFF3),
        (0x1AFF5, 0x1AFFB),
        (0x1AFFD, 0x1AFFE),
        (0x1CF00, 0x1CF2D),
        (0x1CF30, 0x1CF46),
        (0x1D167, 0x1D169),
        (0x1D16D, 0x1D172),
        (0x1D17B, 0x1D182),
        (0x1D185, 0x1D18B),
        (0x1D1AA, 0x1D1AD),
        (0x1E030, 0x1E06D),
        (0x1E130, 0x1E136),
        (0x1E2AE, 0x1E2AE),
        (0x1E2EC, 0x1E2EF),
        (0x1E5EE, 0x1E5EF),
        (0x1E8D0, 0x1E8D6),
        (0x1E944, 0x1E946),
        (0x1E948, 0x1E94A),
    ];

    fn is_diacritic(character: char) -> bool {
        let code = u32::from(character);
        DIACRITIC
            .binary_search_by(|(low, high)| {
                if *high < code {
                    std::cmp::Ordering::Less
                } else if *low > code {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .is_ok()
    }

    pub fn without_diacritics(text: &str) -> String {
        text.nfd()
            .filter(|character| !is_diacritic(*character))
            .collect()
    }

    pub fn fold_for_matching(text: &str) -> String {
        without_diacritics(text).to_lowercase()
    }

    pub fn to_upper_case(text: &str) -> String {
        text.to_uppercase()
    }

    pub fn to_lower_case(text: &str) -> String {
        text.to_lowercase()
    }

    pub fn lower_each(text: &str) -> String {
        text.chars()
            .map(|character| {
                let mut lower = character.to_lowercase();
                match (lower.next(), lower.next()) {
                    (Some(single), None) => single,
                    _ => character,
                }
            })
            .collect()
    }

    pub fn nfd_without_combining_marks(text: &str) -> String {
        text.nfd()
            .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
            .collect()
    }
}

/// `text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()`.
pub fn fold_for_matching(text: &str) -> String {
    backend::fold_for_matching(text)
}

/// `text.normalize("NFD").replace(/\p{Diacritic}/gu, "")`: o texto sem acento,
/// na caixa em que veio.
pub fn without_diacritics(text: &str) -> String {
    backend::without_diacritics(text)
}

/// `text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")`: tira só as
/// marcas combinantes do bloco principal, sem mudar a caixa.
pub fn nfd_without_combining_marks(text: &str) -> String {
    backend::nfd_without_combining_marks(text)
}

/// `text.toUpperCase()` (com as expansões do Unicode: `ß` vira `SS`).
pub fn to_upper_case(text: &str) -> String {
    backend::to_upper_case(text)
}

/// `text.toLowerCase()` (com o sigma final: `ΟΔΟΣ` vira `οδος`).
pub fn to_lower_case(text: &str) -> String {
    backend::to_lower_case(text)
}

/// Os caracteres que o `toLowerCase` não leva ao representante da dobra
/// simples: o `/iu` iguala `ſ` a `s`, `ς` a `σ`, as variantes gregas e
/// cirílicas antigas às letras comuns e duas ligaduras e duas letras
/// politônicas sem relação de caixa (`ﬆ` e `ﬅ`, `ΐ` e `ΐ`). Tirada do V8
/// sem supor que os pares se ligam por maiúscula ou minúscula, e conferida
/// em cada ponto de código por `tests/plataforma/js-text.test.ts`.
const FOLD_EXCEPTIONS: [(char, char); 25] = [
    ('\u{00B5}', '\u{03BC}'),
    ('\u{017F}', '\u{0073}'),
    ('\u{0345}', '\u{03B9}'),
    ('\u{03C2}', '\u{03C3}'),
    ('\u{03D0}', '\u{03B2}'),
    ('\u{03D1}', '\u{03B8}'),
    ('\u{03D5}', '\u{03C6}'),
    ('\u{03D6}', '\u{03C0}'),
    ('\u{03F0}', '\u{03BA}'),
    ('\u{03F1}', '\u{03C1}'),
    ('\u{03F5}', '\u{03B5}'),
    ('\u{1C80}', '\u{0432}'),
    ('\u{1C81}', '\u{0434}'),
    ('\u{1C82}', '\u{043E}'),
    ('\u{1C83}', '\u{0441}'),
    ('\u{1C84}', '\u{0442}'),
    ('\u{1C85}', '\u{0442}'),
    ('\u{1C86}', '\u{044A}'),
    ('\u{1C87}', '\u{0463}'),
    ('\u{1C88}', '\u{A64B}'),
    ('\u{1E9B}', '\u{1E61}'),
    ('\u{1FBE}', '\u{03B9}'),
    ('\u{1FD3}', '\u{0390}'),
    ('\u{1FE3}', '\u{03B0}'),
    ('\u{FB06}', '\u{FB05}'),
];

/// O representante de cada caractere na comparação do `RegExp` com `iu` (a
/// regra `Canonicalize` com `u`, a dobra simples do Unicode), um por ponto de
/// código: dois caracteres casam sem caixa quando os representantes são
/// iguais. É o `toLowerCase` de um caractere só (quando dá um caractere), mais
/// as exceções acima. Para buscar um texto montado em tempo de execução, que
/// não pode virar regex do catálogo.
pub fn simple_case_fold(text: &str) -> Vec<char> {
    text.chars()
        .zip(backend::lower_each(text).chars())
        .map(|(character, lower)| {
            FOLD_EXCEPTIONS
                .binary_search_by_key(&character, |(from, _)| *from)
                .map_or(lower, |index| FOLD_EXCEPTIONS[index].1)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn como_no_v8() {
        assert_eq!(
            fold_for_matching("São Paulo Grêmio Ñ"),
            "sao paulo gremio n"
        );
        assert_eq!(fold_for_matching("a^b`c·d"), "abcd");
        // O ponto do İ é diacrítico e sai; o sigma final vira ς.
        assert_eq!(fold_for_matching("İSTANBUL ΟΔΟΣ"), "istanbul οδος");
        assert_eq!(to_lower_case("İSTANBUL ΟΔΟΣ"), "i\u{307}stanbul οδος");
        assert_eq!(
            simple_case_fold("SſsİΣςσﬆ").into_iter().collect::<String>(),
            "sssİσσσﬅ"
        );
        assert!(FOLD_EXCEPTIONS.windows(2).all(|pair| pair[0].0 < pair[1].0));
    }
}
