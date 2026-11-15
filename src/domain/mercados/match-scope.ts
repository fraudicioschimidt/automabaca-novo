/**
 * Substantivos que nomeiam O PRÓPRIO evento apostado: "Ganhador do confronto",
 * "Para vencer o duelo" e "Vencedor da partida" pedem a mesma resposta.
 *
 * Quatro bordas usam a lista — `classify.marketKindOf`,
 * `settlement/markets.classifyScoreMarket`, os rótulos de lado e o prefixo de
 * seleção de moneyline em `settlement/sides` — e com listas próprias divergiam
 * em silêncio ("Para Ganhar o Confronto" sem kind, "Vencedor da Luta 1" sem
 * lado). Por isso é DADO exportado, não N regexes "iguais" (portão:
 * `tests/liquidacao/score-resolvable-mercado-where.test.ts`).
 */

/**
 * Escopo no MERCADO. `serie` fica de fora: no nome do mercado "Vencedor da
 * Série" é escopo de campeonato e pertence a `OUTRIGHT_SCOPE_NOUNS`.
 */
export const MATCH_SCOPE_NOUNS = [
  "partida", "jogo", "confronto", "encontro", "duelo", "combate", "evento",
  "luta", "match",
] as const;

/**
 * Escopo na SELEÇÃO, onde o substantivo é seguido do NÚMERO do lado
 * ("Vencedor da Luta 1"). Difere do mercado em dois pontos, e cada um tem uma
 * razão:
 *
 * - `jogo` sai: "jogo N"/"game N" já significa UNIDADE no resto do sistema
 *   (`marketPeriodOf` devolve OTHER, `marketMapNumberOf` só aceita como mapa em
 *   eSports). Aceitar a mesma string como LADO faria uma aposta no jogo 1
 *   liquidar pelo placar da partida inteira (portão:
 *   `tests/liquidacao/score-resolution-sides.test.ts`).
 * - `serie` entra: o evento aqui é cabeça-a-cabeça ("FURIA vs MIBR"), então a
 *   série É a partida. O sentido de campeonato é barrado antes, no mercado, por
 *   `isOutrightMarket`.
 */
export const SIDE_SCOPE_NOUNS = [
  "partida", "confronto", "encontro", "duelo", "combate", "evento", "luta",
  "serie",
] as const;
