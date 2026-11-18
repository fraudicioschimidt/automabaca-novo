//! O catálogo de mercados mora em `src/domain/mercados/catalog-data.json`, que
//! o TypeScript importa (e de que tira o tipo dos mercados finais) e o seed
//! persiste. Aqui ele vira um `static` na compilação, na ordem das chaves, como
//! o `Object.keys` do JavaScript: uma fonte só, sem leitura em tempo de execução.

use std::fmt::Write as _;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let source = manifest.join("../../../src/domain/mercados/catalog-data.json");
    println!("cargo:rerun-if-changed={}", source.display());
    let text = std::fs::read_to_string(&source).unwrap_or_else(|error| {
        panic!(
            "catálogo de mercados ausente em {}: {error}",
            source.display()
        )
    });
    let catalog: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("catalog-data.json inválido: {error}"));
    let mut out = String::from(
        "/// Gerado pelo `build.rs` a partir de `catalog-data.json`.\npub static MERCADO_CATALOG: &[(&str, &[MercadoAlias])] = &[\n",
    );
    for (market, aliases) in &catalog {
        let aliases = aliases
            .as_array()
            .unwrap_or_else(|| panic!("{market}: a lista de aliases não é array"));
        let _ = write!(out, "    ({market:?}, &[");
        for alias in aliases {
            let name = alias["alias"]
                .as_str()
                .unwrap_or_else(|| panic!("{market}: alias sem `alias`"));
            match alias
                .get("casaDeAposta")
                .and_then(serde_json::Value::as_str)
            {
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
    let target =
        PathBuf::from(std::env::var("OUT_DIR").unwrap_or_default()).join("catalog_data.rs");
    std::fs::write(&target, out).unwrap_or_else(|error| panic!("{}: {error}", target.display()));
}
