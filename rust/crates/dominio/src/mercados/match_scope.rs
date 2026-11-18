//! Substantivos que nomeiam O PRÓPRIO evento apostado ("Ganhador do
//! confronto", "Vencedor da partida"), portado de
//! `src/domain/mercados/match-scope.ts`. É dado exportado, não N regexes
//! "iguais": quatro bordas usam a lista.

/// Escopo no MERCADO. `serie` fica de fora: no nome do mercado "Vencedor da
/// Série" é escopo de campeonato.
pub const MATCH_SCOPE_NOUNS: [&str; 9] = [
    "partida",
    "jogo",
    "confronto",
    "encontro",
    "duelo",
    "combate",
    "evento",
    "luta",
    "match",
];

/// Escopo na SELEÇÃO, onde o substantivo vem seguido do NÚMERO do lado
/// ("Vencedor da Luta 1"): sem `jogo` ("jogo N" é unidade) e com `serie` (no
/// cabeça-a-cabeça a série é a partida). Ver o TypeScript.
pub const SIDE_SCOPE_NOUNS: [&str; 8] = [
    "partida",
    "confronto",
    "encontro",
    "duelo",
    "combate",
    "evento",
    "luta",
    "serie",
];
