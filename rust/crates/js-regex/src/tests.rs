//! Casos com o resultado que o V8 dá (conferidos no Node); o teste da ponte
//! compara os dois lados com o V8 num corpus maior.

use super::*;

fn re(source: &str, flags: &str) -> Regex {
    Regex::new(source, flags).unwrap_or_else(|error| panic!("/{source}/{flags}: {error}"))
}

#[test]
fn troca_com_cifrao() {
    let data = re(r"(\d{1,2})/(\d{1,2})", "g");
    assert_eq!(data.replace("27/09 e 1/2", "$2-$1"), "09-27 e 2-1");
    assert_eq!(
        data.replace("27/09", "[$&|$`|$'|$$|$3|$0|$01|$10]"),
        "[27/09|||$|$3|$0|27|270]"
    );
    let nomeado = re(r"(?<dia>\d+)/(?<mes>\d+)", "");
    assert_eq!(
        nomeado.replace("x 27/09 y", "$<mes>.$<dia>.$<ano>"),
        "x 09.27. y"
    );
    assert_eq!(re("a", "").replace("aa", "$<x>"), "$<x>a");
    assert_eq!(re("a", "g").replace("aXa", "$"), "$X$");
}

#[test]
fn troca_com_funcao_e_global() {
    let numero = re(r"\d+", "g");
    assert_eq!(
        numero.replace_with("a1b22", |m| format!("<{}>", m.get(0).unwrap_or(""))),
        "a<1>b<22>"
    );
    // Casamento vazio avança uma unidade: o JS insere em cada posição.
    assert_eq!(re("x*", "g").replace("abc", "-"), "-a-b-c-");
    assert_eq!(re("", "gu").replace("a😀b", "-"), "-a-😀-b-");
}

#[test]
fn divisao_pela_especificacao() {
    assert_eq!(re(r"\s+", "").split(" a  b "), vec!["", "a", "b", ""]);
    assert_eq!(
        re(r"(-)|(\+)", "").split("1-2+3"),
        vec!["1", "-", "", "2", "", "+", "3"]
    );
    assert_eq!(re("", "").split("abc"), vec!["a", "b", "c"]);
    assert_eq!(re("x*", "").split("axbc"), vec!["a", "b", "c"]);
    assert_eq!(re(",", "").split_limit("a,b,c", 2), vec!["a", "b"]);
    assert_eq!(re(",", "").split(""), vec![""]);
    assert!(re("", "").split("").is_empty());
}

#[test]
fn sticky_e_busca_do_meio() {
    let palavra = re("[a-z]+", "y");
    assert!(palavra.exec(" ab").is_none());
    assert_eq!(palavra.exec("ab cd").and_then(|m| m.get(0)), Some("ab"));
    let qualquer = re("[a-z]+", "");
    let segundo = qualquer.exec_from("ab cd", 2);
    assert_eq!(segundo.as_ref().and_then(|m| m.get(0)), Some("cd"));
    assert_eq!(segundo.map(|m| m.start()), Some(3));
}

#[test]
fn busca_com_u_no_meio_do_par_recua() {
    // `lastIndex` = 1 cai no meio do 📅: com `u`, o JS busca do começo dele.
    let vazio = re("", "u");
    assert_eq!(exec_utf16(&vazio, "📅 x", 1), Some(vec![0, 0]));
    assert_eq!(exec_utf16(&re("", ""), "📅 x", 1), Some(vec![1, 1]));
}

#[test]
fn lookbehind_ve_o_texto_antes_do_inicio() {
    let depois_de_barra = re(r"(?<=/)\d+", "");
    assert_eq!(
        depois_de_barra.exec_from("27/09", 3).and_then(|m| m.get(0)),
        Some("09")
    );
}

#[test]
fn indices_e_bytes() {
    let m = re("b+", "")
        .exec("ção bb")
        .unwrap_or_else(|| panic!("sem casamento"));
    assert_eq!((m.index(), m.start(), m.get(0)), (4, 6, Some("bb")));
    let todos: Vec<_> = re(r"\p{L}+", "gu")
        .exec_all("São Paulo")
        .iter()
        .filter_map(|m| m.get(0))
        .collect();
    assert_eq!(todos, vec!["São", "Paulo"]);
}

#[test]
fn meio_emoji_sem_u() {
    // Sem `u`, o JS casa só a primeira metade do par; a captura se alarga ao
    // emoji, e a troca, feita em UTF-16, dá o mesmo texto que o JS.
    let simbolo = re("[^a-z ]", "");
    let m = simbolo
        .exec("ab 📅 c")
        .unwrap_or_else(|| panic!("sem casamento"));
    assert_eq!((m.index(), m.get(0)), (3, Some("📅")));
    assert_eq!(re("[^a-z ]", "g").replace("a📅b", "-"), "a--b");
    assert_eq!(re("[^a-z ]", "g").replace("a📅b", ""), "ab");
    assert_eq!(re("[^a-z ]+", "g").replace("a📅b", "-"), "a-b");
}

#[test]
fn caixa_sem_u_como_no_v8() {
    // Para o V8, sem `u`, `ı` e `ſ` não casam com `i` e `s`.
    assert!(!re("kasimpasa", "i").is_match("Kasımpaşa"));
    assert!(re("kasımpaşa", "i").is_match("KASıMPAŞA"));
    assert!(!re("[a-z]+", "i").is_match("ı"));
    assert!(re(r"[\u0100-\u017F]", "i").is_match("ſ"));
    assert!(!re("s", "i").is_match("ſ"));
    assert!(!re("ᾀ", "i").is_match("ᾈ"));
    assert!(re("ᾈ", "i").is_match("ᾈ"));
    // Com `u`, a dobra do Unicode vale nos dois.
    assert!(re("s", "iu").is_match("ſ"));
    assert!(re("K", "i").is_match("k"));
}

#[test]
fn flags_e_erros() {
    assert!(Regex::new("(", "").is_err());
    assert!(Regex::new("a", "gg").is_err());
    assert!(Regex::new("a", "x").is_err());
    assert!(
        catalog().contains(&(r"\d+".to_owned(), "g".to_owned())) || Regex::new(r"\d+", "g").is_ok()
    );
}
