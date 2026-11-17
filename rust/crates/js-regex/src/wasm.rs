//! Navegador (WebAssembly): o próprio `RegExp` do host, o mesmo que o
//! TypeScript usava ali, sem motor de regex no binário. O padrão é compilado
//! com `gd`: `g` para a busca começar em `lastIndex`, `d` para o casamento
//! trazer os intervalos dos grupos, que voltam numa chamada só.

use crate::{Flags, GroupRanges};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = r#"
export function jsRegexCompile(source, flags) {
  try {
    return new RegExp(source, flags);
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}
export function jsRegexExec(regex, text, from) {
  regex.lastIndex = from;
  const found = regex.exec(text);
  if (found === null) return undefined;
  const ranges = found.indices;
  const flat = new Int32Array(ranges.length * 2);
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    flat[2 * i] = range === undefined ? -1 : range[0];
    flat[2 * i + 1] = range === undefined ? -1 : range[1];
  }
  return flat;
}
"#)]
extern "C" {
    #[wasm_bindgen(js_name = jsRegexCompile)]
    fn compile_js(source: &str, flags: &str) -> JsValue;
    #[wasm_bindgen(js_name = jsRegexExec)]
    fn exec_js(regex: &JsValue, text: &JsValue, from: u32) -> Option<Vec<i32>>;
}

thread_local! {
    // O `JsValue` não é `Send`: o `RegExp` fica aqui (o WebAssembly do
    // navegador tem uma thread só) e o `Regex` guarda o índice.
    static COMPILED: RefCell<Vec<JsValue>> = const { RefCell::new(Vec::new()) };
}

pub(crate) struct Compiled {
    index: usize,
}

pub(crate) fn compile(source: &str, flags: Flags) -> Result<Compiled, String> {
    let host_flags: String = [
        (flags.ignore_case, 'i'),
        (flags.multiline, 'm'),
        (flags.dot_all, 's'),
        (flags.unicode, 'u'),
        (true, 'g'),
        (true, 'd'),
    ]
    .iter()
    .filter_map(|(on, flag)| on.then_some(*flag))
    .collect();
    let compiled = compile_js(source, &host_flags);
    if let Some(message) = compiled.as_string() {
        return Err(message);
    }
    let index = COMPILED.with(|all| {
        let mut all = all.borrow_mut();
        match all.iter().position(JsValue::is_undefined) {
            Some(free) => {
                all[free] = compiled;
                free
            }
            None => {
                all.push(compiled);
                all.len() - 1
            }
        }
    });
    Ok(Compiled { index })
}

impl Drop for Compiled {
    // O padrão montado em tempo de execução não pode prender o RegExp do host.
    fn drop(&mut self) {
        // `try_with`: na saída da thread a tabela pode já ter ido embora.
        let _ = COMPILED.try_with(|all| {
            if let Some(slot) = all.borrow_mut().get_mut(self.index) {
                *slot = JsValue::UNDEFINED;
            }
        });
    }
}

pub(crate) struct Searcher<'c> {
    compiled: &'c Compiled,
    text: JsValue,
}

impl Compiled {
    /// O texto vira string do JavaScript uma vez por operação, não por busca.
    pub(crate) fn searcher<'c>(&'c self, _units: &[u16], text: &str) -> Searcher<'c> {
        Searcher {
            compiled: self,
            text: JsValue::from_str(text),
        }
    }
}

impl Searcher<'_> {
    pub(crate) fn exec(&self, from: usize) -> Option<GroupRanges> {
        let from = u32::try_from(from).ok()?;
        let flat = COMPILED.with(|all| {
            let all = all.borrow();
            exec_js(all.get(self.compiled.index)?, &self.text, from)
        })?;
        Some(
            flat.chunks(2)
                .map(|pair| match pair {
                    [start, end] if *start >= 0 && *end >= 0 => {
                        Some((*start as usize, *end as usize))
                    }
                    _ => None,
                })
                .collect(),
        )
    }
}
