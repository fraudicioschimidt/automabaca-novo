/**
 * Grafia acentuada equivalente de um termo do vocabulário de mercados.
 *
 * O `contains` do Postgres compara CAIXA, não diacrítico: todo espelho SQL de
 * uma lista do domínio precisa das DUAS grafias. `draw-vocabulary.ts`,
 * `stat-qualifier.ts` e `score-resolvable-query.ts` usam esta mesma função.
 * A regra mora em Rust (`rust/crates/dominio/src/mercados/accents.rs`).
 */
import dominio from "@automabaca/dominio";

/** Forma acentuada do termo (idempotente para termos sem acento). */
export function accentuate(term: string): string {
  return dominio.accentuate(term);
}

/** `[termo]` quando não há acento; `[termo, acentuado]` quando há. */
export function accentVariants(term: string): string[] {
  return dominio.accentVariants(term);
}
