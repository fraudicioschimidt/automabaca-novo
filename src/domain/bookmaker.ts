/**
 * Nome canônico da casa de apostas. A regra mora em Rust
 * (`rust/crates/dominio/src/bookmaker.rs`): só marcas conhecidas mudam de
 * grafia; o resto volta como veio.
 */
import dominio from "@automabaca/dominio";

/** Normaliza somente marcas conhecidas; nomes desconhecidos preservam a grafia. */
export function canonicalizeBookmakerName(value: string): string {
  return dominio.canonicalizeBookmakerName(value);
}
