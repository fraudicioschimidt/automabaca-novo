//! Regex com a semântica do `RegExp` do JavaScript, para o domínio portado dar
//! o mesmo resultado que o TypeScript nos dois lados da ponte.
//!
//! - No navegador (WebAssembly), o próprio `RegExp` do host: o mesmo motor
//!   que o TypeScript usava ali, sem motor de regex no binário.
//! - No servidor (N-API, `cargo test`), o `regress`, que segue a especificação
//!   ECMAScript; o `/i` sem `u` passa por um ajuste de caixa (ver `fold.rs`).
//!
//! Cada backend só executa uma busca a partir de um índice UTF-16 e devolve os
//! intervalos dos grupos. O resto (busca global com o avanço do casamento
//! vazio, `sticky`, `replace` com `$1`/`$<nome>`, `replace` com função, `split`)
//! é este arquivo, escrito uma vez pela especificação: é onde os dois lados
//! poderiam divergir.
//!
//! O domínio trabalha com `&str`, e os intervalos das capturas são em bytes
//! UTF-8. Sem a flag `u`, o JavaScript pode casar meio emoji (uma unidade
//! UTF-16); a captura então se alarga ao caractere inteiro, e `replace` e
//! `split`, que montam o resultado em UTF-16, dão o mesmo texto que o JS,
//! menos num caso: onde o JS deixaria meia unidade solta no resultado (troca
//! sem `u` que parte um emoji), o Rust, que só tem texto bem formado, põe
//! U+FFFD, como o `toWellFormed()` do JS.

#[cfg(not(target_arch = "wasm32"))]
mod fold;
#[cfg(not(target_arch = "wasm32"))]
mod native;
mod pattern;
#[cfg(target_arch = "wasm32")]
mod wasm;

#[cfg(not(target_arch = "wasm32"))]
use native as backend;
#[cfg(target_arch = "wasm32")]
use wasm as backend;

use std::collections::BTreeSet;
use std::ops::Range;
use std::sync::{Arc, Mutex};

/// Intervalos UTF-16 do casamento (índice 0) e de cada grupo.
pub(crate) type GroupRanges = Vec<Option<(usize, usize)>>;

/// As flags que mudam o casamento. `g` e `y` mudam só quem chama: aqui as
/// operações dizem se são globais (`replace` com `g` troca todos).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Flags {
    pub global: bool,
    pub ignore_case: bool,
    pub multiline: bool,
    pub dot_all: bool,
    pub unicode: bool,
    pub sticky: bool,
}

impl Flags {
    fn parse(flags: &str) -> Result<Flags, String> {
        let mut parsed = Flags::default();
        for flag in flags.chars() {
            let slot = match flag {
                'g' => &mut parsed.global,
                'i' => &mut parsed.ignore_case,
                'm' => &mut parsed.multiline,
                's' => &mut parsed.dot_all,
                'u' => &mut parsed.unicode,
                'y' => &mut parsed.sticky,
                'd' => continue,
                other => return Err(format!("flag inválida: {other}")),
            };
            if *slot {
                return Err(format!("flag repetida: {flag}"));
            }
            *slot = true;
        }
        Ok(parsed)
    }
}

/// Padrão que o motor recusou, com a mensagem dele.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxError(pub String);

impl std::fmt::Display for SyntaxError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

pub struct Regex {
    source: String,
    flags_text: String,
    flags: Flags,
    names: Arc<[Option<String>]>,
    compiled: backend::Compiled,
}

static CATALOG: Mutex<BTreeSet<(String, String)>> = Mutex::new(BTreeSet::new());

/// Os padrões do domínio compilados neste processo (`regex!` e
/// `Regex::cataloged`), com as flags: o teste permanente compara cada um com
/// o V8.
pub fn catalog() -> Vec<(String, String)> {
    CATALOG
        .lock()
        .map(|catalog| catalog.iter().cloned().collect())
        .unwrap_or_default()
}

/// `static` com a regex compilada na primeira vez: o literal `/…/` do JS.
/// Padrão inválido é erro de programação, e a primeira chamada (num teste)
/// aponta qual.
#[macro_export]
macro_rules! regex {
    ($source:expr, $flags:expr $(,)?) => {{
        static REGEX: ::std::sync::LazyLock<$crate::Regex> = ::std::sync::LazyLock::new(|| {
            $crate::Regex::cataloged($source, $flags)
                .unwrap_or_else(|error| panic!("regex inválida /{}/{}: {error}", $source, $flags))
        });
        &*REGEX
    }};
}

impl Regex {
    /// `new RegExp(source, flags)` de um padrão do domínio, que entra no
    /// catálogo comparado com o V8. O padrão montado em tempo de execução
    /// (lista de nomes, por exemplo) vem por aqui também.
    #[allow(clippy::disallowed_methods)]
    pub fn cataloged(source: &str, flags: &str) -> Result<Regex, SyntaxError> {
        let regex = Regex::new(source, flags)?;
        if let Ok(mut catalog) = CATALOG.lock() {
            catalog.insert((source.to_owned(), flags.to_owned()));
        }
        Ok(regex)
    }

    /// `new RegExp(source, flags)` fora do catálogo: só para quem testa a
    /// camada (o domínio usa `regex!` ou `Regex::cataloged`; o clippy cobra).
    pub fn new(source: &str, flags: &str) -> Result<Regex, SyntaxError> {
        let parsed = Flags::parse(flags).map_err(SyntaxError)?;
        let compiled = backend::compile(source, parsed).map_err(SyntaxError)?;
        Ok(Regex {
            source: source.to_owned(),
            flags_text: flags.to_owned(),
            flags: parsed,
            names: pattern::capture_names(source).into(),
            compiled,
        })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn flags(&self) -> Flags {
        self.flags
    }

    /// As flags como foram escritas (`"gi"`).
    pub fn flags_text(&self) -> &str {
        &self.flags_text
    }

    /// `regex.test(text)` sem o estado de `lastIndex`: do começo (com `y`,
    /// só no começo).
    pub fn is_match(&self, text: &str) -> bool {
        self.exec_from(text, 0).is_some()
    }

    /// `regex.exec(text)` do começo, sem o estado de `lastIndex`.
    pub fn exec<'t>(&self, text: &'t str) -> Option<Captures<'t>> {
        self.exec_from(text, 0)
    }

    /// `regex.exec(text)` com `lastIndex` no byte `start` (posição de
    /// caractere do texto).
    pub fn exec_from<'t>(&self, text: &'t str, start: usize) -> Option<Captures<'t>> {
        let haystack = Haystack::new(text);
        let searcher = self.compiled.searcher(&haystack.units, text);
        let from = haystack.utf16_index(start);
        let groups = self.exec_at(&searcher_exec(&searcher), from, &haystack.units)?;
        Some(self.captures(&haystack, groups))
    }

    /// `text.matchAll(regex)`: todos os casamentos, com o avanço do JS no
    /// casamento vazio.
    pub fn exec_all<'t>(&self, text: &'t str) -> Vec<Captures<'t>> {
        let haystack = Haystack::new(text);
        let searcher = self.compiled.searcher(&haystack.units, text);
        self.all_matches(&searcher_exec(&searcher), &haystack)
            .into_iter()
            .map(|groups| self.captures(&haystack, groups))
            .collect()
    }

    /// `text.replace(regex, replacement)`, com `$$`, `$&`, `` $` ``, `$'`,
    /// `$n`, `$nn` e `$<nome>`. Com `g`, troca todos.
    pub fn replace(&self, text: &str, replacement: &str) -> String {
        let template: Vec<u16> = replacement.encode_utf16().collect();
        self.replace_units(text, |units, groups| {
            substitution(units, groups, &self.names, &template)
        })
    }

    /// `text.replace(regex, (m, ...grupos) => …)`.
    pub fn replace_with(
        &self,
        text: &str,
        mut replacer: impl FnMut(&Captures<'_>) -> String,
    ) -> String {
        let haystack = Haystack::new(text);
        self.replace_units(text, |_, groups| {
            replacer(&self.captures(&haystack, groups.clone()))
                .encode_utf16()
                .collect()
        })
    }

    /// `text.split(regex)`. Grupo de captura que não participa entra como
    /// texto vazio (o JS poria `undefined`).
    pub fn split(&self, text: &str) -> Vec<String> {
        self.split_limit(text, u32::MAX)
    }

    /// `text.split(regex, limit)`, pela especificação (`RegExp.prototype[@@split]`).
    pub fn split_limit(&self, text: &str, limit: u32) -> Vec<String> {
        let limit = limit as usize;
        if limit == 0 {
            return Vec::new();
        }
        let haystack = Haystack::new(text);
        let units = &haystack.units;
        let searcher = self.compiled.searcher(units, text);
        let exec = searcher_exec(&searcher);
        let size = units.len();
        // O split casa em cada posição como `sticky`.
        let at =
            |position: usize| exec(position).filter(|groups| start_of(groups) == Some(position));
        if size == 0 {
            return if at(0).is_some() {
                Vec::new()
            } else {
                vec![text.to_owned()]
            };
        }
        let mut pieces = Vec::new();
        let (mut p, mut q) = (0, 0);
        while q < size {
            let Some(groups) = exec(q) else { break };
            let (Some(start), Some(end)) = (start_of(&groups), end_of(&groups)) else {
                break;
            };
            if start != q {
                // Sem casamento de q até `start`: o JS avançaria até lá.
                q = start;
                continue;
            }
            let end = end.min(size);
            if end == p {
                q = advance(units, q, self.flags.unicode);
                continue;
            }
            pieces.push(String::from_utf16_lossy(&units[p..q]));
            if pieces.len() == limit {
                return pieces;
            }
            p = end;
            for group in groups.iter().skip(1) {
                pieces.push(
                    group.map_or_else(String::new, |(s, e)| String::from_utf16_lossy(&units[s..e])),
                );
                if pieces.len() == limit {
                    return pieces;
                }
            }
            q = p;
        }
        pieces.push(String::from_utf16_lossy(&units[p..size]));
        pieces
    }

    /// Uma busca a partir de `from`, com o `sticky` aplicado.
    fn exec_at(
        &self,
        exec: &dyn Fn(usize) -> Option<GroupRanges>,
        from: usize,
        units: &[u16],
    ) -> Option<GroupRanges> {
        if from > units.len() {
            return None;
        }
        // Com `u`, a busca começa no caractere que contém `from`: no meio de
        // um par substituto, o JS recua ao começo do par.
        let from = if self.flags.unicode && mid_pair(units, from) {
            from - 1
        } else {
            from
        };
        let groups = exec(from)?;
        if self.flags.sticky && start_of(&groups) != Some(from) {
            return None;
        }
        Some(groups)
    }

    /// A busca global do JS: depois de cada casamento, `lastIndex` vai ao
    /// fim dele; no casamento vazio, avança uma unidade (ou um ponto de
    /// código, com `u`).
    fn all_matches(
        &self,
        exec: &dyn Fn(usize) -> Option<GroupRanges>,
        haystack: &Haystack<'_>,
    ) -> Vec<GroupRanges> {
        let units = &haystack.units;
        let mut found = Vec::new();
        let mut last_index = 0;
        while let Some(groups) = self.exec_at(exec, last_index, units) {
            let (Some(start), Some(end)) = (start_of(&groups), end_of(&groups)) else {
                break;
            };
            last_index = if end == start {
                advance(units, end, self.flags.unicode)
            } else {
                end
            };
            found.push(groups);
        }
        found
    }

    /// `RegExp.prototype[@@replace]` com a troca em UTF-16.
    fn replace_units(
        &self,
        text: &str,
        mut replacement: impl FnMut(&[u16], &GroupRanges) -> Vec<u16>,
    ) -> String {
        let haystack = Haystack::new(text);
        let units = &haystack.units;
        let searcher = self.compiled.searcher(units, text);
        let exec = searcher_exec(&searcher);
        let matches = if self.flags.global {
            self.all_matches(&exec, &haystack)
        } else {
            self.exec_at(&exec, 0, units).into_iter().collect()
        };
        if matches.is_empty() {
            return text.to_owned();
        }
        let mut out: Vec<u16> = Vec::with_capacity(units.len());
        let mut next = 0;
        for groups in &matches {
            let (Some(start), Some(end)) = (start_of(groups), end_of(groups)) else {
                continue;
            };
            let piece = replacement(units, groups);
            if start >= next {
                out.extend_from_slice(&units[next..start]);
                out.extend_from_slice(&piece);
                next = end;
            }
        }
        out.extend_from_slice(&units[next.min(units.len())..]);
        String::from_utf16_lossy(&out)
    }

    fn captures<'t>(&self, haystack: &Haystack<'t>, groups: GroupRanges) -> Captures<'t> {
        let bytes = groups
            .iter()
            .map(|group| {
                group.map(|(start, end)| haystack.byte_floor(start)..haystack.byte_ceil(end))
            })
            .collect();
        Captures {
            text: haystack.text,
            index: groups
                .first()
                .copied()
                .flatten()
                .map_or(0, |(start, _)| start),
            bytes,
            names: Arc::clone(&self.names),
        }
    }
}

fn searcher_exec<'s, S: Exec>(searcher: &'s S) -> impl Fn(usize) -> Option<GroupRanges> + 's {
    move |from| searcher.exec_units(from)
}

/// A busca de um backend sobre um texto já preparado.
trait Exec {
    fn exec_units(&self, from: usize) -> Option<GroupRanges>;
}

#[cfg(not(target_arch = "wasm32"))]
impl Exec for native::Searcher<'_, '_> {
    fn exec_units(&self, from: usize) -> Option<GroupRanges> {
        self.exec(from)
    }
}

#[cfg(target_arch = "wasm32")]
impl Exec for wasm::Searcher<'_> {
    fn exec_units(&self, from: usize) -> Option<GroupRanges> {
        self.exec(from)
    }
}

fn start_of(groups: &GroupRanges) -> Option<usize> {
    groups.first().copied().flatten().map(|(start, _)| start)
}

fn end_of(groups: &GroupRanges) -> Option<usize> {
    groups.first().copied().flatten().map(|(_, end)| end)
}

/// A unidade `index` é a segunda metade de um par substituto.
fn mid_pair(units: &[u16], index: usize) -> bool {
    index > 0
        && units
            .get(index)
            .is_some_and(|unit| (0xDC00..0xE000).contains(unit))
        && units
            .get(index - 1)
            .is_some_and(|unit| (0xD800..0xDC00).contains(unit))
}

/// `AdvanceStringIndex`: uma unidade, ou o par substituto inteiro com `u`.
fn advance(units: &[u16], index: usize, unicode: bool) -> usize {
    let high = units
        .get(index)
        .is_some_and(|unit| (0xD800..0xDC00).contains(unit));
    let low = units
        .get(index + 1)
        .is_some_and(|unit| (0xDC00..0xE000).contains(unit));
    if unicode && high && low {
        index + 2
    } else {
        index + 1
    }
}

/// `GetSubstitution`, em UTF-16 como no JS.
fn substitution(
    units: &[u16],
    groups: &GroupRanges,
    names: &[Option<String>],
    template: &[u16],
) -> Vec<u16> {
    let piece =
        |group: Option<(usize, usize)>| group.map_or(&[][..], |(start, end)| &units[start..end]);
    let (start, end) = groups.first().copied().flatten().unwrap_or((0, 0));
    let captures = groups.len() - 1;
    let digit = |unit: Option<&u16>| {
        unit.filter(|u| (0x30..=0x39).contains(*u))
            .map(|u| usize::from(*u - 0x30))
    };
    let mut out = Vec::with_capacity(template.len());
    let mut i = 0;
    while i < template.len() {
        if template[i] != u16::from(b'$') || i + 1 == template.len() {
            out.push(template[i]);
            i += 1;
            continue;
        }
        let next = template[i + 1];
        match next {
            0x24 => {
                out.push(0x24);
                i += 2;
            }
            0x26 => {
                out.extend_from_slice(&units[start..end]);
                i += 2;
            }
            0x60 => {
                out.extend_from_slice(&units[..start]);
                i += 2;
            }
            0x27 => {
                out.extend_from_slice(&units[end.min(units.len())..]);
                i += 2;
            }
            0x3C if names.iter().any(Option::is_some) => {
                let Some(close) = template[i + 2..].iter().position(|u| *u == u16::from(b'>'))
                else {
                    out.extend_from_slice(&template[i..i + 2]);
                    i += 2;
                    continue;
                };
                let name = String::from_utf16_lossy(&template[i + 2..i + 2 + close]);
                if let Some(position) = names
                    .iter()
                    .position(|n| n.as_deref() == Some(name.as_str()))
                {
                    out.extend_from_slice(piece(groups.get(position + 1).copied().flatten()));
                }
                i += close + 3;
            }
            _ => match digit(template.get(i + 1)) {
                Some(first) => {
                    let (index, width) = match digit(template.get(i + 2)) {
                        Some(second) if (1..=captures).contains(&(first * 10 + second)) => {
                            (first * 10 + second, 2)
                        }
                        _ => (first, 1),
                    };
                    if (1..=captures).contains(&index) {
                        out.extend_from_slice(piece(groups.get(index).copied().flatten()));
                    } else {
                        out.extend_from_slice(&template[i..i + 1 + width]);
                    }
                    i += 1 + width;
                }
                None => {
                    out.push(0x24);
                    i += 1;
                }
            },
        }
    }
    out
}

/// O texto em UTF-16 e o mapa de cada unidade para o byte UTF-8.
struct Haystack<'t> {
    text: &'t str,
    units: Vec<u16>,
    /// `byte_at[i]`: o byte onde começa o caractere da unidade `i` (a segunda
    /// metade de um par aponta para o começo do par); `byte_at[len]` = fim.
    byte_at: Vec<usize>,
}

impl<'t> Haystack<'t> {
    fn new(text: &'t str) -> Haystack<'t> {
        let mut units = Vec::with_capacity(text.len());
        let mut byte_at = Vec::with_capacity(text.len() + 1);
        for (byte, character) in text.char_indices() {
            let mut buffer = [0u16; 2];
            for unit in character.encode_utf16(&mut buffer) {
                units.push(*unit);
                byte_at.push(byte);
            }
        }
        byte_at.push(text.len());
        Haystack {
            text,
            units,
            byte_at,
        }
    }

    fn mid_pair(&self, index: usize) -> bool {
        index > 0 && index < self.units.len() && self.byte_at[index] == self.byte_at[index - 1]
    }

    fn byte_floor(&self, index: usize) -> usize {
        self.byte_at[index.min(self.units.len())]
    }

    fn byte_ceil(&self, index: usize) -> usize {
        if self.mid_pair(index) {
            self.byte_at
                .get(index + 1)
                .copied()
                .unwrap_or(self.text.len())
        } else {
            self.byte_floor(index)
        }
    }

    /// O índice UTF-16 do byte `byte` (arredondado para o caractere).
    fn utf16_index(&self, byte: usize) -> usize {
        self.byte_at.partition_point(|at| *at < byte)
    }
}

/// Um casamento: o trecho e os grupos, em bytes UTF-8 do texto.
#[derive(Debug, Clone)]
pub struct Captures<'t> {
    text: &'t str,
    index: usize,
    bytes: Vec<Option<Range<usize>>>,
    names: Arc<[Option<String>]>,
}

impl<'t> Captures<'t> {
    /// O grupo `i` (0 é o casamento inteiro), `None` se não participou.
    pub fn get(&self, i: usize) -> Option<&'t str> {
        let range = self.bytes.get(i)?.clone()?;
        self.text.get(range)
    }

    /// O grupo nomeado.
    pub fn name(&self, name: &str) -> Option<&'t str> {
        let position = self.names.iter().position(|n| n.as_deref() == Some(name))?;
        self.get(position + 1)
    }

    /// O intervalo do grupo `i`, em bytes.
    pub fn range(&self, i: usize) -> Option<Range<usize>> {
        self.bytes.get(i)?.clone()
    }

    /// Onde o casamento começa, em bytes.
    pub fn start(&self) -> usize {
        self.range(0).map_or(0, |range| range.start)
    }

    /// Onde o casamento termina, em bytes.
    pub fn end(&self) -> usize {
        self.range(0).map_or(0, |range| range.end)
    }

    /// `match.index`: onde o casamento começa, em unidades UTF-16.
    pub fn index(&self) -> usize {
        self.index
    }

    /// Quantos grupos, contando o casamento inteiro.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

/// O primitivo, para o teste que compara os dois lados com o V8: os
/// intervalos UTF-16 (início e fim de cada grupo, -1 no que não participou)
/// do casamento a partir da unidade `from`, como `exec` com `lastIndex`.
pub fn exec_utf16(regex: &Regex, text: &str, from: usize) -> Option<Vec<i64>> {
    let haystack = Haystack::new(text);
    let searcher = regex.compiled.searcher(&haystack.units, text);
    let groups = regex.exec_at(&searcher_exec(&searcher), from, &haystack.units)?;
    Some(
        groups
            .iter()
            .flat_map(|group| match group {
                Some((start, end)) => [*start as i64, *end as i64],
                None => [-1, -1],
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests;
