// Tipos das funções que `rust/crates/dominio-node/src/lib.rs` exporta. Cada
// `#[napi]` novo entra aqui com o nome em camelCase que o napi-rs gera.
//
// `export =`, e não exports nomeados: o carregador é CommonJS com o binário
// num `require`, e o ESM do Node só enxerga o default dele. Importe sempre
// `import dominio from "@automabaca/dominio-node"` (`tests/plataforma/architecture-boundaries.test.ts` recusa o resto).
declare const dominio: {
  /** Versão do crate, a de `rust/Cargo.toml`. */
  versao(): string;
};
export = dominio;
