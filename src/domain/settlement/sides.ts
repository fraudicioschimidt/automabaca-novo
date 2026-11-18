/**
 * Lado apostado (casa, fora, empate) a partir da seleção e do evento: nome do
 * time com margem mínima de similaridade, rótulos ordinais ("Time 1"),
 * moneyline, Draw No Bet e Dupla Chance. Empate técnico é ambíguo e devolve
 * null: nunca chuta. A regra mora em Rust
 * (`rust/crates/dominio/src/settlement/sides.rs`), com o porquê de cada passo.
 */
import dominio from "@automabaca/dominio";

/**
 * Remove o NOME DO TIME da seleção antes de extrair a linha — inverso de
 * `matchTeamSide`. Sem isto, dígitos do clube ("1. FC Köln", "Schalke 04")
 * vazam para `parseLineQuarters` e corrompem a linha; o sinal do handicap fica.
 */
export function stripTeamNames(selecao: string, evento: string): string {
  return dominio.stripTeamNames(selecao, evento);
}

/**
 * Lado apostado (casa/fora): tokens explícitos, depois nome do time com MARGEM
 * mínima de similaridade. Empate técnico é ambíguo e devolve null — nunca chuta.
 */
export function matchTeamSide(
  selecao: string,
  evento: string,
): "home" | "away" | null {
  return dominio.matchTeamSide(selecao, evento);
}

/**
 * Como ler o resto da seleção de moneyline além do nome do time.
 *
 * - padrão (liquidação, CLV, canonicalização): recusa só o complemento que
 *   muda a aposta ("não perde", "contra", "e ambas marcam") ou um pedaço do
 *   outro time.
 * - `strict` (leitor por regra): só o nome e palavras de "vence"; o resto vai
 *   para a leitura por IA, que custa menos que uma aposta errada.
 */
export type MoneylineReading = { strict?: boolean };

/**
 * Seleção de moneyline em uma única fonte para settlement e providers.
 * Feeds 1X2 usam os tokens compactos 1/X/2; nomes de time continuam tendo
 * prioridade sobre "draw"/"empate" para não confundir clubes com esses termos.
 */
export function matchMoneylineSelection(
  selecao: string,
  evento: string,
  options: MoneylineReading = {},
): "home" | "away" | "draw" | null {
  return dominio.matchMoneylineSelection(selecao, evento, options.strict === true);
}

/**
 * A seleção de moneyline pede outro mercado: traz linha ("Flamengo -1.5"),
 * placar exato ("Flamengo 2x0") ou classificação, título e vitória a zero.
 */
export function moneylineSelectionAsksAnotherMarket(selecao: string, evento?: string): boolean {
  return dominio.moneylineSelectionAsksAnotherMarket(selecao, evento);
}

/**
 * Lado da aposta quando ele pode vir de DUAS fontes: o rótulo do mercado
 * ("Home Total Goals") e o nome do time na seleção. Discordam → decisão
 * humana; só uma fala → ela decide; nenhuma → `null`.
 */
export function resolveSideFromMarketAndSelection(
  mercado: string,
  selecao: string,
  evento: string,
): { side: "home" | "away" | null; contradicts: boolean } {
  const [side, contradicts] = dominio.resolveSideFromMarketAndSelection(mercado, selecao, evento);
  return { side, contradicts };
}

/** Seleção de Draw No Bet: sempre um lado; empate puro é inválido. */
export function matchDrawNoBetSelection(
  selecao: string,
  evento: string,
): "home" | "away" | null {
  return dominio.matchDrawNoBetSelection(selecao, evento);
}

export type DoubleChanceOutcome = "home" | "away" | "draw";

/**
 * As duas saídas cobertas por uma seleção de Dupla Chance. É a mesma fonte
 * usada por settlement e pela equivalência sharp, evitando que uma grafia seja
 * precificável mas não liquidável (ou o inverso).
 */
export function matchDoubleChanceSelection(
  selecao: string,
  evento: string,
): readonly [DoubleChanceOutcome, DoubleChanceOutcome] | null {
  return dominio.matchDoubleChanceSelection(selecao, evento);
}
