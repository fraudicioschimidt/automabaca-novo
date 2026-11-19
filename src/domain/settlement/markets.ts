/**
 * Classificação de mercado para resolução por placar. A regra mora em Rust
 * (`rust/crates/dominio/src/settlement/markets.rs`), com o porquê de cada
 * recusa (placar exato, handicap europeu, combinados, "race to").
 *
 * BTTS e team totals usam `homeScore`/`awayScore` (gols por time) — o feed já
 * entrega o par, não só o agregado. Props de jogador ficam fora
 * (`hasNonScoreStatQualifier` / unsupported).
 */
import dominio from "@automabaca/dominio";
import type { MarketPeriod } from "@/src/domain/mercados/classify";

export type ScoreMarketKind =
  | "handicap"
  | "total"
  | "team_total"
  | "btts"
  | "moneyline"
  | "draw_no_bet"
  | "double_chance";

/**
 * Família do mercado, ou null quando o placar não o responde sozinho: sem
 * motor para ele, ou com uma segunda condição que o rótulo ou a seleção juntam
 * ("Ambas Marcam" / "Sim e Over 2.5"). Pago por uma metade, o combinado sairia
 * ganho com a outra perdida.
 */
export function classifyScoreMarket(
  mercadoN: string,
  selecaoN: string,
  evento?: string,
): ScoreMarketKind | null {
  return dominio.classifyScoreMarket(mercadoN, selecaoN, evento);
}

/**
 * O PLACAR FINAL responde a aposta? Para 1º tempo/HT/mapa ele não responde —
 * quem usa isto (caixa de ações e lote do IA-Judge) só tem o agregado. A
 * aposta de tempo liquida pelo FlashScore, com os parciais do jogo.
 */
export function isScoreResolvableMarket(params: {
  mercado: string;
  selecao: string;
  esporte?: string;
  /** Sem evento o team total só é reconhecido na forma com PREFIXO. */
  evento?: string;
}): boolean {
  return dominio.isScoreResolvableMarket(params.mercado, params.selecao, params.esporte, params.evento);
}

/** Mercado e seleção são duas superfícies da mesma evidência de período. */
export function hasNonFullTimeScorePeriod(params: {
  mercado: string;
  selecao: string;
  esporte?: string;
}): boolean {
  return declaredScorePeriod(params) !== "FT";
}

/**
 * Período efetivo das duas superfícies. FT numa delas é "não declarou";
 * conflito HT vs segundo tempo, OTHER ou MAP recusam liquidação automática.
 */
export function declaredScorePeriod(params: {
  mercado: string;
  selecao: string;
  esporte?: string;
}): MarketPeriod {
  return dominio.declaredScorePeriod(params.mercado, params.selecao, params.esporte);
}
