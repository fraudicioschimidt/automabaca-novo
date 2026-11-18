//! Dados que o TypeScript também lê moram em JSON ao lado do módulo TS, e aqui
//! viram `static` na compilação, na ordem das chaves (a do `Object.keys`): uma
//! fonte só, sem leitura em tempo de execução.
//!
//! - `src/domain/mercados/catalog-data.json`: o catálogo de mercados, de que o
//!   TS tira o tipo dos mercados finais e que o seed persiste;
//! - `src/domain/sports/registry-data.json`: o registro de esportes, de que o
//!   TS tira o tipo `CanonicalSport`. A unidade do placar é conferida aqui,
//!   contra o enum fechado do Rust: unidade nova não compila.

use serde_json::{Map, Value};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap_or_default());
    let src = manifest.join("../../../src/domain");
    write(
        &out_dir.join("catalog_data.rs"),
        &catalog(&read(&src.join("mercados/catalog-data.json"))),
    );
    write(
        &out_dir.join("sports_registry.rs"),
        &sports(&read(&src.join("sports/registry-data.json"))),
    );
}

fn read(path: &Path) -> Map<String, Value> {
    println!("cargo:rerun-if-changed={}", path.display());
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("{} ausente: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} inválido: {error}", path.display()))
}

fn write(path: &Path, code: &str) {
    std::fs::write(path, code).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
}

fn catalog(catalog: &Map<String, Value>) -> String {
    let mut out = String::from(
        "/// Gerado pelo `build.rs` a partir de `catalog-data.json`.\npub static MERCADO_CATALOG: &[(&str, &[MercadoAlias])] = &[\n",
    );
    for (market, aliases) in catalog {
        let aliases = aliases
            .as_array()
            .unwrap_or_else(|| panic!("{market}: a lista de aliases não é array"));
        let _ = write!(out, "    ({market:?}, &[");
        for alias in aliases {
            let name = alias["alias"]
                .as_str()
                .unwrap_or_else(|| panic!("{market}: alias sem `alias`"));
            match alias.get("casaDeAposta").and_then(Value::as_str) {
                Some(book) => {
                    let _ = write!(out, "({name:?}, Some({book:?})), ");
                }
                None => {
                    let _ = write!(out, "({name:?}, None), ");
                }
            }
        }
        out.push_str("]),\n");
    }
    out.push_str("];\n");
    out
}

fn strings(sport: &str, entry: &Value, field: &str) -> String {
    let items = entry[field]
        .as_array()
        .unwrap_or_else(|| panic!("{sport}: `{field}` não é array"));
    let items: Vec<String> = items
        .iter()
        .map(|item| {
            let text = item
                .as_str()
                .unwrap_or_else(|| panic!("{sport}: item de `{field}` não é texto"));
            format!("{text:?}")
        })
        .collect();
    format!("&[{}]", items.join(", "))
}

fn optional_pattern(sport: &str, entry: &Value, field: &str) -> String {
    match &entry[field] {
        Value::Null => "None".to_owned(),
        Value::String(source) => format!("Some({source:?})"),
        _ => panic!("{sport}: `{field}` precisa ser a fonte de um regex ou null"),
    }
}

fn sports(registry: &Map<String, Value>) -> String {
    let mut out = String::from(
        "/// Gerado pelo `build.rs` a partir de `registry-data.json`.\npub static SPORTS_REGISTRY: &[SportEntry] = &[\n",
    );
    for (sport, entry) in registry {
        let label = entry["labelPt"]
            .as_str()
            .unwrap_or_else(|| panic!("{sport}: sem `labelPt`"));
        let flashscore_id = match &entry["flashscoreId"] {
            Value::Null => "None".to_owned(),
            Value::Number(id) => format!(
                "Some({})",
                id.as_u64()
                    .unwrap_or_else(|| panic!("{sport}: `flashscoreId` não é inteiro"))
            ),
            _ => panic!("{sport}: `flashscoreId` precisa ser número ou null"),
        };
        let unit = match entry["unidadeDoPlacar"].as_str() {
            Some("gols") => "Gols",
            Some("pontos") => "Pontos",
            Some("corridas") => "Corridas",
            Some("sets") => "Sets",
            Some("games") => "Games",
            Some("legs") => "Legs",
            Some("frames") => "Frames",
            Some("mapas") => "Mapas",
            Some("outra") => "Outra",
            other => panic!(
                "{sport}: unidade do placar {other:?} desconhecida; decida em \
                 `sports/registry.rs` o que o settlement por placar faz com ela"
            ),
        };
        let _ = writeln!(
            out,
            "    SportEntry {{ canonical: {sport:?}, label_pt: {label:?}, aliases: {}, emojis: {}, \
             texto: {}, competicoes: {}, flashscore_id: {flashscore_id}, unidade_do_placar: UnidadeDoPlacar::{unit} }},",
            strings(sport, entry, "aliases"),
            strings(sport, entry, "emojis"),
            optional_pattern(sport, entry, "texto"),
            optional_pattern(sport, entry, "competicoes"),
        );
    }
    out.push_str("];\n");
    out
}
