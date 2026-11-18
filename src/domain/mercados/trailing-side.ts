/**
 * Nome de time posicionado DEPOIS da linha ("Over 1.5 Gols do Flamengo").
 *
 * A canonicalização da seleção e o SETTLEMENT precisam do mesmo recorte: se
 * só um reconhece o lado, o outro trata a aposta como total de JOGO e liquida
 * pelo placar agregado. A regra mora em Rust
 * (`rust/crates/dominio/src/mercados/trailing_side.rs`).
 */
import dominio from "@automabaca/dominio";

/** Limpa unidade/preposição/pontuação; null quando não sobra nada nomeável. */
export function trailingTeamCandidate(trailing: string): string | null {
  return dominio.trailingTeamCandidate(trailing || "");
}

/**
 * Trecho da seleção que vem DEPOIS da primeira linha numérica, já limpo.
 * Null quando a seleção não tem linha ou nada nomeável a segue.
 */
export function trailingTeamCandidateOfSelection(selecao: string): string | null {
  return dominio.trailingTeamCandidateOfSelection(selecao || "");
}
