/**
 * Substantivos que nomeiam O PRÓPRIO evento apostado: "Ganhador do confronto",
 * "Para vencer o duelo" e "Vencedor da partida" pedem a mesma resposta.
 *
 * Quatro bordas usam a lista — `classify.marketKindOf`,
 * `settlement/markets.classifyScoreMarket`, os rótulos de lado e o prefixo de
 * seleção de moneyline em `settlement/sides` — e com listas próprias divergiam
 * em silêncio. Por isso é DADO exportado, não N regexes "iguais". A lista mora
 * em Rust (`rust/crates/dominio/src/mercados/match_scope.rs`).
 */
import dominio from "@automabaca/dominio";

const [matchScopeNouns, sideScopeNouns] = dominio.scopeNouns();

/**
 * Escopo no MERCADO. `serie` fica de fora: no nome do mercado "Vencedor da
 * Série" é escopo de campeonato e pertence a `OUTRIGHT_SCOPE_NOUNS`.
 */
export const MATCH_SCOPE_NOUNS: readonly string[] = matchScopeNouns;

/**
 * Escopo na SELEÇÃO, onde o substantivo é seguido do NÚMERO do lado
 * ("Vencedor da Luta 1"): sem `jogo` ("jogo N" é unidade no resto do sistema)
 * e com `serie` (no cabeça-a-cabeça a série é a partida; o sentido de
 * campeonato é barrado antes, no mercado, por `isOutrightMarket`).
 */
export const SIDE_SCOPE_NOUNS: readonly string[] = sideScopeNouns;
