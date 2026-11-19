/**
 * Nome canônico da casa de apostas. A regra mora em Rust
 * (`rust/crates/dominio/src/bookmaker.rs`): só marcas conhecidas mudam de
 * grafia; o resto volta como veio.
 */
import dominio from "@automabaca/dominio";

/** A palavra (sem acento nem pontuação) é uma casa conhecida ("betano", "bet365"). */
export function isKnownBookmakerKey(key: string): boolean {
  return dominio.isKnownBookmakerKey(key);
}

/** Normaliza somente marcas conhecidas; nomes desconhecidos preservam a grafia. */
export function canonicalizeBookmakerName(value: string): string {
  return dominio.canonicalizeBookmakerName(value);
}
