/**
 * A forma da seleção: handicap, total do time, linha, jogador de eSports e
 * handicap europeu. A regra mora em Rust
 * (`rust/crates/dominio/src/mercados/selection_shape.rs`).
 */
import dominio from "@automabaca/dominio";

/** A trailing quoted price is metadata, never a handicap/total line. */
export function stripSelectionOdds(selection: string): string {
  return dominio.stripSelectionOdds(selection);
}

/** A named eSports player, distinct from either fixture team. */
export function isEsportsPlayerSelection(selecao: string, evento: string): boolean {
  return dominio.isEsportsPlayerSelection(selecao, evento);
}

/**
 * A linha de um total como a liquidação a lê: o "1" de "1T Over 110.5" é o
 * período. Quando a liquidação não lê a linha ("U3.5", "O2.5"), vale o
 * primeiro número, para a escala do esporte continuar conferida.
 */
export function selectionTotalLine(selecao: string, evento: string): number | null {
  return dominio.selectionTotalLine(selecao, evento);
}

/** Time/lado seguido de linha; `+2.5` nu continua ambíguo. */
export function selecaoPareceHandicap(selecao: string): boolean {
  return dominio.selecaoPareceHandicap(selecao);
}

/**
 * A seleção nomeia o TIME do total ("Flamengo mais de 0.5", "Over 1.5 do
 * Flamengo") — confirmado contra o evento, nunca por parecer nome. Coagir para
 * `Total` apagaria o time e liquidaria pelo placar agregado (um 0x3 pagaria
 * "Flamengo mais de 0.5").
 */
export function selecaoNomeiaTimeDoTotal(selecao: string, evento: string): boolean {
  return dominio.selecaoNomeiaTimeDoTotal(selecao, evento);
}

/**
 * Handicap europeu (3 vias) declarado na própria seleção: "Flamengo -1
 * (Handicap Europeu)", "Handicap 3 vias Flamengo -1".
 */
export function declaresEuropeanHandicap(selecao: string): boolean {
  return dominio.declaresEuropeanHandicap(selecao);
}
