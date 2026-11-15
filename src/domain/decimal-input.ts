// A regra mora em Rust (`rust/crates/dominio/src/decimal_input.rs`): no
// servidor pela N-API, nas telas pelo WebAssembly. Aqui fica só o que é do
// JavaScript: o valor que já é `number` e o que não é texto.
import dominio from "@automabaca/dominio";

/** Converte entrada decimal do painel aceitando separador brasileiro ou internacional. */
export function parseDecimalInput(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  return dominio.parseDecimalText(value);
}

/**
 * Converte valor monetário digitado em reais.
 *
 * Um único ponto com três casas é ambíguo no parser genérico: `1.000` pode ser
 * odd/stake 1.000 ou R$ 1.000. Nos campos explicitamente rotulados em R$, a
 * convenção brasileira vence; nos demais, `parseDecimalInput` continua tratando
 * o ponto como separador decimal.
 */
export function parseMoneyInput(value: unknown): number | null {
  if (typeof value !== "string") return parseDecimalInput(value);
  return dominio.parseMoneyText(value);
}
