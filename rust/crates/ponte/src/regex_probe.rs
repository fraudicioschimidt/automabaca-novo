//! O regex do domínio exposto cru, só para `tests/plataforma/regex.test.ts`
//! comparar o servidor (`regress`) e o navegador (o `RegExp` do host) com o
//! V8: a busca a partir de um índice, a troca com `$` e a divisão.

use js_regex::Regex;
use std::cell::RefCell;
use std::rc::Rc;

thread_local! {
    // Lista, não `HashMap`: o teste usa algumas dezenas de padrões, e o código
    // do hash pesaria no WebAssembly de todas as telas.
    static COMPILED: RefCell<Vec<Rc<Regex>>> = const { RefCell::new(Vec::new()) };
}

fn compiled(source: &str, flags: &str) -> Result<Rc<Regex>, String> {
    let same = |regex: &&Rc<Regex>| regex.source() == source && regex.flags_text() == flags;
    if let Some(regex) = COMPILED.with(|all| all.borrow().iter().find(same).cloned()) {
        return Ok(regex);
    }
    // Fora do catálogo: as quinas e a varredura do teste não são do domínio.
    #[allow(clippy::disallowed_methods)]
    let regex = Rc::new(Regex::new(source, flags).map_err(|error| error.0)?);
    COMPILED.with(|all| all.borrow_mut().push(Rc::clone(&regex)));
    Ok(regex)
}

pub(crate) fn catalog() -> Vec<Vec<String>> {
    dominio::regex_catalog()
        .into_iter()
        .map(|(source, flags)| vec![source, flags])
        .collect()
}

pub(crate) fn exec(
    source: &str,
    flags: &str,
    text: &str,
    from: u32,
) -> Result<Option<Vec<i64>>, String> {
    Ok(js_regex::exec_utf16(
        &*compiled(source, flags)?,
        text,
        from as usize,
    ))
}

pub(crate) fn replace(
    source: &str,
    flags: &str,
    text: &str,
    replacement: &str,
) -> Result<String, String> {
    Ok(compiled(source, flags)?.replace(text, replacement))
}

pub(crate) fn split(
    source: &str,
    flags: &str,
    text: &str,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    Ok(compiled(source, flags)?.split_limit(text, limit.unwrap_or(u32::MAX)))
}
