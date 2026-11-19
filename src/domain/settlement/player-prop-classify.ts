/**
 * A estatística de JOGADOR que a aposta pede (faltas, chutes, desarmes,
 * cartões, passes…). A regra mora em Rust
 * (`rust/crates/dominio/src/settlement/player_prop_classify.rs`), com o
 * vocabulário de cada família.
 */
import dominio from "@automabaca/dominio";
import type { MarketPeriod } from "@/src/domain/mercados/classify";
import type { PlayerPropKey, PlayerPropStats } from "@/src/domain/settlement/goalscorer-matching";

export type PlayerPropFamily =
  | "fouls_suffered"
  | "fouls_committed"
  | "passes_total"
  | "passes_completed"
  | "shots_total"
  | "shots_on_target"
  | "tackles_total"
  | "tackles_won"
  | "cards_any"
  | "cards_yellow"
  | "cards_red"
  | "assists"
  | "interceptions"
  | "key_passes"
  | "offsides"
  | "saves_total";

const FAMILIAS = dominio.playerPropFamilies();

/** Rótulos finais de produto — settlement FlashScore, sem odds na cascata. */
export const MERCADO_DA_PROP = Object.fromEntries(
  FAMILIAS.map(([family, mercado]) => [family, mercado]),
) as Record<PlayerPropFamily, string>;

/** A chave do FlashScore `player-stats`; `cards_any` não tem chave única. */
const CHAVE_DA_FAMILIA = new Map(FAMILIAS.map(([family, , statKey, chave]) => [family, { statKey, chave }]));

/**
 * A estatística da prop em PT, concordando com o valor ("chutes no gol"), no
 * aviso de liquidação e na ficha. A família chega de JSON gravado: a
 * desconhecida volta crua em vez de sumir.
 */
export function propStatLabel(family: string, value: number): string {
  return dominio.propStatLabel(family, value);
}

export type PlayerPropClassificacao = {
  family: PlayerPropFamily;
  mercado: string;
  /** Ausente significa FT; períodos parciais ficam explícitos e são recusados. */
  period?: Exclude<MarketPeriod, "FT">;
};

/**
 * A seleção/mercado pede uma estatística de JOGADOR? Sem nome casável contra
 * o evento, "Bahia over 8.5 faltas" continua faltas de TIME.
 *
 * Anytime Goalscorer fica de fora: tem caminho próprio (`GOALS`).
 */
export function classificarPropDeJogador(params: {
  mercado: string;
  selecao: string;
  evento?: string;
  esporte?: string;
}): PlayerPropClassificacao | null {
  // O esporte informado como `null` conta como informado (e desconhecido),
  // como no `!== undefined` de antes.
  const esporte = params.esporte === undefined ? undefined : (params.esporte ?? "");
  const found = dominio.classificarPropDeJogador(params.mercado, params.selecao, params.evento, esporte);
  if (!found) return null;
  const [family, period] = found as [PlayerPropFamily, PlayerPropClassificacao["period"] | ""];
  return { family, mercado: MERCADO_DA_PROP[family], ...(period ? { period } : {}) };
}

export function valorDaProp(
  family: PlayerPropFamily,
  stats: PlayerPropStats,
): number | undefined {
  const statKey = CHAVE_DA_FAMILIA.get(family)?.statKey;
  return statKey ? stats[statKey as PlayerPropKey] : undefined;
}

export function chaveDaProp(family: PlayerPropFamily): string {
  return CHAVE_DA_FAMILIA.get(family)?.chave as string;
}
