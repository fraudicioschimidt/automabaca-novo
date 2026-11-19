/**
 * O SUJEITO da linha over/under (antes ou depois dela) que não é time do
 * evento: liquidar "Tatum over 10.5" ou "Over 0.5 - Mbappé" pelo placar da
 * partida responderia outra aposta. A regra mora em Rust
 * (`rust/crates/dominio/src/settlement/over_under_subject.rs`), com o
 * vocabulário do que não é sujeito.
 */
import dominio from "@automabaca/dominio";

/**
 * Texto à esquerda de over/under na seleção. Sem isso, "Tatum over 10.5" e
 * "Over 10.5" parecem a mesma linha — só o prefixo diz se há um sujeito. A
 * direção abreviada ("Pedro O 0.5") tem o mesmo sujeito.
 */
export function prefixoAntesDaLinha(selecao: string): string | null {
  return dominio.prefixoAntesDaLinha(selecao);
}

/**
 * Quem vem DEPOIS da linha e não é time do evento: o jogador de "Over 0.5 -
 * Mbappé" ou de "Menos de 27.5 [A'ja Wilson]". Sem evento, null: o sujeito
 * não se prova alheio.
 */
export function subjectAfterLine(selecao: string, evento?: string): string | null {
  return dominio.subjectAfterLine(selecao, evento || undefined);
}

/**
 * Sujeito da linha O/U (antes ou depois dela) que não é time: liquidar pela
 * estatística ou pelo placar da partida responderia outra aposta.
 * Sem evento o sujeito não se prova alheio e a guarda não dispara.
 */
export function lineSubjectIsNotEventTeam(selecao: string, evento?: string): boolean {
  return dominio.lineSubjectIsNotEventTeam(selecao, evento || undefined);
}
