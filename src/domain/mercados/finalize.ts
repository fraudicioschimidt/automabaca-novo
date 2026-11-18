/**
 * O rótulo FINAL da Pinnacle a partir do canônico de entrada e do esporte, o
 * mercado do tempo regulamentar e o período declarado na troca de mercado. A
 * regra mora em Rust (`rust/crates/dominio/src/mercados/finalize.rs`).
 */
import dominio from "@automabaca/dominio";

/** Label FINAL Pinnacle a partir do canônico de entrada + esporte. */
export function finalizePinnacleMarket(mercado: string, esporte?: string): string {
  return dominio.finalizePinnacleMarket(mercado, esporte);
}

/**
 * Troca o mercado de jogo inteiro pelo do tempo regulamentar quando a aposta o
 * declara (`declared`, lido do texto cru) num esporte com prorrogação. Aposta
 * no empate nesses esportes só existe no tempo normal e também troca.
 */
export function regulationTimeMarket(params: {
  mercado: string;
  selecao: string;
  evento: string;
  esporte?: string;
  declared: boolean;
}): string {
  return dominio.regulationTimeMarket(params.mercado, params.selecao, params.evento, params.esporte, params.declared);
}

/** Mercado em estilo Pinnacle: tradução estática + finalização por esporte. */
export function pinnacleizeMercado(mercado: string, esporte?: string): string {
  return dominio.pinnacleizeMercado(mercado, esporte);
}

/**
 * Troca de mercado pela seleção (coerção, estatística da legenda) preserva o
 * período que o rótulo declara: "Gols - 1º tempo" + "Over 0.5" é Total –
 * 1st Half, não o jogo inteiro.
 */
export function keepDeclaredPeriod(original: string, coerced: string, esporte?: string, selecao = ""): string {
  return dominio.keepDeclaredPeriod(original, coerced, esporte, selecao);
}
