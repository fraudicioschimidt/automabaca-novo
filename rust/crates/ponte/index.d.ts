// Tipos das funções da ponte: as mesmas nos dois lados (`src/node.rs` e
// `src/wasm.rs`), conferidas por `tests/plataforma/ponte.test.ts`. Função nova
// entra nos dois lados e aqui, com o nome em camelCase.
//
// `export =`, e não exports nomeados: o carregador do servidor é CommonJS com
// o binário num `require`, e o ESM do Node só enxerga o default dele. Importe
// sempre `import dominio from "@automabaca/dominio"`
// (`tests/plataforma/architecture-boundaries.test.ts` recusa o resto).
declare const dominio: {
  /** Versão do crate, a de `rust/Cargo.toml`. */
  versao(): string;
  /** Ver `src/domain/cron-cadence.ts`. */
  cronMaxGapMinutes(cron: string): number;
  cronFiringMinutes(cron: string): number[];
  /** Instantes em milissegundos da época; `null` quando o intervalo não tem disparo. */
  latestCronFiring(cron: string, afterMs: number, untilMs: number, utcOffsetHours: number): number | null;
  /** Ver `src/domain/kelly.ts`: `[implícita, estimada, fração]`, ou `null`. */
  analyzeKelly(odds: number, vantagemPct: number): [number, number, number] | null;
  kellyStake(odds: number, vantagemPct: number, fraction: number, capUnits: number): number;
  /** Ver `src/domain/decimal-input.ts`: só o texto; `null` quando não dá para ler sem adivinhar. */
  parseDecimalText(value: string): number | null;
  parseMoneyText(value: string): number | null;
  /** Ver `src/domain/odds.ts`. */
  powerFairProbs(odds: readonly number[]): number[] | null;
  shinFairProbs(odds: readonly number[]): number[] | null;
  powerFairOdds(odds: readonly number[]): number[] | null;
  shinFairOdds(odds: readonly number[]): number[] | null;
  autoFairOdds(odds: readonly number[]): number[] | null;
  autoFairProbs(odds: readonly number[]): number[] | null;
  combineQuarterLineOdds(side: string, aLineQ: number, aOdd: number, bLineQ: number, bOdd: number): number | null;
  percentualContraFair(bookOdd: number, fairOdd: number): number | null;
};
export = dominio;
