//! Servidor (N-API, `cargo test`): o `regress`, motor com a semântica do
//! ECMAScript. Sem a flag `u` a busca é por unidade UTF-16, como no V8 (um
//! emoji são duas unidades, e `[^a-z]` casa cada metade); com ela, por ponto
//! de código. O `/i` sem `u` passa pelo ajuste de caixa de `fold.rs`.

use crate::fold;
use crate::{Flags, GroupRanges};
use std::borrow::Cow;

pub(crate) struct Compiled {
    regex: regress::Regex,
    unicode: bool,
    fold: bool,
}

pub(crate) fn compile(source: &str, flags: Flags) -> Result<Compiled, String> {
    let fold = flags.ignore_case && !flags.unicode;
    let pattern = if fold {
        Cow::Owned(fold::rewrite_for_fold(source)?)
    } else {
        Cow::Borrowed(source)
    };
    let regress_flags: String = [
        (flags.ignore_case, 'i'),
        (flags.multiline, 'm'),
        (flags.dot_all, 's'),
        (flags.unicode, 'u'),
    ]
    .iter()
    .filter_map(|(on, flag)| on.then_some(*flag))
    .collect();
    let regex = regress::Regex::with_flags(&pattern, regress_flags.as_str())
        .map_err(|error| error.to_string())?;
    Ok(Compiled {
        regex,
        unicode: flags.unicode,
        fold,
    })
}

pub(crate) struct Searcher<'c, 'h> {
    compiled: &'c Compiled,
    units: Cow<'h, [u16]>,
}

impl Compiled {
    pub(crate) fn searcher<'c, 'h>(&'c self, units: &'h [u16], _text: &str) -> Searcher<'c, 'h> {
        let divergent = |unit: &u16| fold::placeholder(*unit).is_some();
        let units = if self.fold && units.iter().any(divergent) {
            Cow::Owned(
                units
                    .iter()
                    .map(|unit| fold::placeholder(*unit).unwrap_or(*unit))
                    .collect(),
            )
        } else {
            Cow::Borrowed(units)
        };
        Searcher {
            compiled: self,
            units,
        }
    }
}

impl Searcher<'_, '_> {
    /// O primeiro casamento que começa em `from` ou depois.
    pub(crate) fn exec(&self, from: usize) -> Option<GroupRanges> {
        let regex = &self.compiled.regex;
        let found = if self.compiled.unicode {
            regex.find_from_utf16(&self.units, from).next()
        } else {
            regex.find_from_ucs2(&self.units, from).next()
        }?;
        let mut groups = Vec::with_capacity(found.captures.len() + 1);
        groups.push(Some((found.range.start, found.range.end)));
        groups.extend(
            found
                .captures
                .iter()
                .map(|group| group.as_ref().map(|range| (range.start, range.end))),
        );
        Some(groups)
    }
}
