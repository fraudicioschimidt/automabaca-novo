/**
 * Classificação do mercado: o tipo (moneyline, total, handicap, BTTS…), o
 * período (jogo inteiro, 1º e 2º tempo, mapa) e as famílias que nenhum placar
 * resolve (outright, método da vitória, race to, handicap de 3 vias). O
 * roteamento de odds e a liquidação leem daqui. A regra mora em Rust
 * (`rust/crates/dominio/src/mercados/classify.rs`), com o porquê de cada termo.
 */
import dominio from "@automabaca/dominio";

export type MarketKind =
  | "moneyline"
  | "total"
  | "spread"
  | "team_total"
  | "draw_no_bet"
  | "double_chance"
  | "btts"
  | "correct_score"
  | "scorer"
  | "player_props"
  | "other";

export type MarketPeriod = "FT" | "HT" | "SECOND_HALF" | "MAP" | "OTHER";

const [
  [extraTimeSource, regulationTimeSource],
  [outrightScopeNouns, outrightWinnerPhrases, halfFirst, halfSecond, abbreviationsFirst, abbreviationsSecond],
] = dominio.classifyData();

export function isEsports(esporte: string | null | undefined): boolean {
  return dominio.isEsports(esporte);
}

/**
 * Número do mapa em eSports (Map 1 / primeiro mapa). Null = não é mercado por mapa.
 * O número do mapa permanece distinto do período de jogo completo.
 */
export function marketMapNumberOf(
  mercado: string,
  esporte?: string | null,
): number | null {
  return dominio.marketMapNumberOf(mercado, esporte);
}

/** Qualificadores financeiros compartilhados pela captura e pelos contratos de preço. */
export const EXTRA_TIME_PATTERN = new RegExp(extraTimeSource);
export const REGULATION_TIME_PATTERN = new RegExp(regulationTimeSource);

/** Declaração explícita de que a prorrogação conta no resultado. */
export function marketIncludesExtraTime(mercado: string): boolean {
  return dominio.marketIncludesExtraTime(mercado);
}

/** Lê antes da normalização de mercado, que apaga os parênteses de "(TR)". */
export function declaresRegulationTime(text: string): boolean {
  return dominio.declaresRegulationTime(text);
}

/** Vocabulário único de "ambas marcam", o mesmo do roteamento de odds e da liquidação. */
export function isBttsMarket(mercado: string): boolean {
  return dominio.isBttsMarket(mercado);
}

/** O texto pede os DOIS tempos ("nos dois tempos", "Both Halves", "1º e 2º tempo"). */
export function marketNamesBothHalves(text: string): boolean {
  return dominio.marketNamesBothHalves(text);
}

/**
 * BTTS COMBINADO com outra perna ("Casa vence e ambas marcam", "BTTS & Over
 * 2.5") ou em cada tempo: exige as duas condições, e não é um BTTS.
 */
export function isCombinedBttsMarket(mercado: string): boolean {
  return dominio.isCombinedBttsMarket(mercado);
}

/**
 * Lado da seleção de "ambas marcam", lido num lugar só pela captura (Yes/No)
 * e pela liquidação. O que não decide sem adivinhar devolve null.
 */
export function bttsSelectionSide(selecao: string): "yes" | "no" | null {
  return dominio.bttsSelectionSide(selecao);
}

/** "Race to N" / "Primeiro a N": não há resolver dessa família — falha fechado. */
export function isRaceToMarket(mercado: string, selecao = ""): boolean {
  return dominio.isRaceToMarket(mercado, selecao);
}

/** Handicap de três vias/europeu não compartilha a mecânica asiática de push. */
export function isThreeWayHandicapMarket(mercado: string): boolean {
  return dominio.isThreeWayHandicapMarket(mercado);
}

/**
 * Escopo de outright: o que se vence NÃO é a partida. Exportado como dado
 * porque o filtro SQL precisa da mesma lista — "Quem Vencerá o Campeonato"
 * era recusado pelo domínio e aceito pelo SQL, saindo do IA-Judge.
 */
export const OUTRIGHT_SCOPE_NOUNS: readonly string[] = outrightScopeNouns;
export const OUTRIGHT_WINNER_PHRASES: readonly string[] = outrightWinnerPhrases;

/** Outrights/futures não representam o vencedor da partida corrente. */
export function isOutrightMarket(mercado: string): boolean {
  return dominio.isOutrightMarket(mercado);
}

/** Método da vitória não equivale ao vencedor da partida. */
export function isMethodOfVictoryMarket(mercado: string): boolean {
  return dominio.isMethodOfVictoryMarket(mercado);
}

/** Vocabulário único de Draw No Bet (dados em `draw-vocabulary.ts`). */
export function isDrawNoBetMarket(mercado: string): boolean {
  return dominio.isDrawNoBetMarket(mercado);
}

/** Vocabulário único de Dupla Chance, incluindo siglas/labels legados. */
export function isDoubleChanceMarket(mercado: string): boolean {
  return dominio.isDoubleChanceMarket(mercado);
}

/**
 * Lado do evento que o RÓTULO de um total nomeia ("Total de Gols do Vasco",
 * "Vasco - Total de Gols", "Total Gols Time Visitante").
 */
export function totalLabelSide(mercado: string, evento: string): "home" | "away" | null {
  return dominio.totalLabelSide(mercado, evento);
}

/**
 * Frases de meio-tempo, como DADO. O filtro SQL precisa das MESMAS: ele negava
 * "segundo tempo" e "1º" mas não "2 tempo"/"2o tempo"/"primeiro tempo", então
 * uma aposta de 2º tempo ficava sem NENHUM liquidador automático. As siglas
 * (HT/H1/2H…) ficam à parte porque exigem limite de token.
 */
export const HALF_PERIOD_PHRASES: { readonly first: readonly string[]; readonly second: readonly string[] } = {
  first: halfFirst,
  second: halfSecond,
};

/**
 * Siglas compactas de meio-tempo. Ficam FORA de `HALF_PERIOD_PHRASES` porque o
 * espelho SQL gera `contains` da frase: "1t" como substring pegaria lixo.
 */
export const HALF_PERIOD_ABBREVIATIONS: { readonly first: readonly string[]; readonly second: readonly string[] } = {
  first: abbreviationsFirst,
  second: abbreviationsSecond,
};

export function marketPeriodOf(
  mercado: string,
  esporte?: string | null,
): MarketPeriod {
  return dominio.marketPeriodOf(mercado, esporte);
}

/**
 * `evento` é opcional e só amplia: sem ele o team total é reconhecido apenas
 * na forma com PREFIXO. Com ele, a forma com SUFIXO ("Total Goals" + "Over 1.5
 * Flamengo") também, como na liquidação.
 */
export function marketKindOf(
  mercado: string,
  selecao = "",
  evento?: string,
): MarketKind {
  return dominio.marketKindOf(mercado, selecao, evento);
}
