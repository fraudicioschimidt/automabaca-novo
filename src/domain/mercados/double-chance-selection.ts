/**
 * A seleção de Dupla Chance canônica (1X, X2, 12), resolvida enquanto o
 * evento ainda tem o nome da mensagem. A regra mora em Rust
 * (`rust/crates/dominio/src/mercados/double_chance_selection.rs`).
 */
import dominio from "@automabaca/dominio";

/**
 * Resolve a abreviação enquanto o evento ainda contém o nome da mensagem.
 * O token X2/1X/12 atravessa aliases sem perder lado nem a cobertura do empate.
 */
export function canonicalDoubleChanceSelection(input: {
  evento: string;
  mercado: string;
  selecao: string;
  esporte: string;
}): { mercado: string; selecao: string } | null {
  const canonical = dominio.canonicalDoubleChanceSelection(input.evento, input.mercado, input.selecao, input.esporte);
  return canonical && { mercado: canonical[0], selecao: canonical[1] };
}
