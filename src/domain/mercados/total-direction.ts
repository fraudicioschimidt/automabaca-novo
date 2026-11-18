/**
 * Direção de um total (over/under) na seleção, sem confundir nomes como
 * "Sporting U23". A regra mora em Rust
 * (`rust/crates/dominio/src/mercados/total_direction.rs`).
 */
import dominio from "@automabaca/dominio";

export type TotalDirection = "over" | "under";

const [overWords, underWords] = dominio.totalDirectionWords();
/** Palavras de direção de um total, como alternância de regex (texto normalizado). */
export const OVER_WORDS = overWords;
export const UNDER_WORDS = underWords;

/** Separa apenas uma linha numérica de uma unidade conhecida; U23 e nomes ficam intactos. */
export function separateCompactStatUnit(text: string): string {
  return dominio.separateCompactStatUnit(text);
}

type TotalDirectionOptions = {
  /** Só use quando o mercado já foi classificado externamente como total. */
  allowBarePositiveLine?: boolean;
};

/**
 * "Flamengo O 1.5" → "Flamengo Over 1.5", "O89,5" → "Over 89,5": só a sigla
 * da direção vira palavra; time, unidade e período ficam. A sigla trocada é a
 * logo antes da linha do fim do texto: a primeira seguida de dígito pode ser a
 * categoria do time ("Palmeiras U20 U 1.5").
 */
export function expandAbbreviatedDirection(selection: string): string {
  return dominio.expandAbbreviatedDirection(selection);
}

/** Direção explícita de uma seleção de total, sem confundir nomes como Sporting U23. */
export function totalDirectionOf(
  selection: string,
  options: TotalDirectionOptions = {},
): TotalDirection | null {
  return dominio.totalDirectionOf(selection, options.allowBarePositiveLine === true);
}

export function looksLikeTotalSelection(selection: string): boolean {
  return totalDirectionOf(selection) !== null;
}
