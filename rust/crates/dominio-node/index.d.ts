// Tipos das funções que `rust/crates/dominio-node/src/lib.rs` exporta. Cada
// `#[napi]` novo entra aqui com o nome em camelCase que o napi-rs gera.
//
// `export =`, e não exports nomeados: o carregador é CommonJS com o binário
// num `require`, e o ESM do Node só enxerga o default dele. Importe sempre
// `import dominio from "@automabaca/dominio-node"` (`tests/plataforma/architecture-boundaries.test.ts` recusa o resto).
declare const dominio: {
  /** Versão do crate, a de `rust/Cargo.toml`. */
  versao(): string;
  /** Ver `src/domain/cron-cadence.ts`. */
  cronMaxGapMinutes(cron: string): number;
  cronFiringMinutes(cron: string): number[];
  /** Instantes em milissegundos da época; `null` quando o intervalo não tem disparo. */
  latestCronFiring(cron: string, afterMs: number, untilMs: number, utcOffsetHours: number): number | null;
};
export = dominio;
