/**
 * Linhas de handicap/total em QUARTOS INTEIROS (linha × 4): decisão de
 * VOID/meio-ganho vira aritmética exata — zero epsilon de float decidindo
 * dinheiro. A regra mora em Rust (`rust/crates/dominio/src/settlement/lines.rs`),
 * com o porquê de cada grafia aceita ou recusada.
 */
import dominio from "@automabaca/dominio";
import type { BetStatus } from "@/src/domain/bet-status";

/** -0.25 → -1; 2.5 → 10; null quando não é múltiplo de 0.25. */
export function lineToQuarters(line: number): number | null {
  return dominio.lineToQuarters(line);
}

/**
 * Separador que NÃO é grafia conhecida de split line (";", "|", "&", " e "):
 * tirar média inventa uma linha; escolher uma perna decide dinheiro em
 * silêncio. Falha fechado até existir grafia real da captura.
 */
export const UNKNOWN_LINE_SEPARATOR = new RegExp(dominio.unknownLineSeparator());

/**
 * Meio-tempo numerado ("1ºT", "2T", "1º tempo", "1st half", "H1"): o dígito
 * dele não é número da linha. Quem lê a linha de um texto que pode nomear o
 * tempo apaga o tempo antes.
 */
export function withoutNumberedHalf(text: string): string {
  return dominio.withoutNumberedHalf(text);
}

export function extractSignedNumbers(text: string): number[] {
  return dominio.extractSignedNumbers(text);
}

/**
 * Linha da seleção em quartos. Duas linhas explícitas ("-0.5, -1.0") viram a
 * média (quarter line). `allowNegative` distingue handicap (±) de total (≥0).
 */
export function parseLineQuarters(
  selecao: string,
  opts: { allowNegative: boolean },
): number | null {
  return dominio.parseLineQuarters(selecao, opts.allowNegative);
}

/** Diferença ajustada em quartos → status: ±1 quarto é meia, 0 é devolução. */
export function statusFromAdjustedQuarters(adjustedQ: number): BetStatus {
  return dominio.statusFromAdjustedQuarters(adjustedQ);
}
