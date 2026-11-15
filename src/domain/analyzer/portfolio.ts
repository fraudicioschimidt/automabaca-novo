import type { BetRowData } from "@/src/domain/bet-read-model";
import {
  AMOSTRA_MINIMA_CLV,
  agregaGrupo,
  clvConfiavel,
  vereditoEdge,
  type BetAggInput,
  type EdgeVeredito,
  type GrupoAgg,
} from "./shared";

/**
 * A carteira cruzada por canal (a banca de onde a aposta veio) e mercado. Cada
 * célula é o `agregaGrupo` de sempre sobre as apostas dela, então a matriz, os
 * cortes e a gaveta contam a mesma base. O dinheiro chega na unidade da tela:
 * na carteira, reais.
 */

export type PortfolioBetInput = BetAggInput & Pick<BetRowData, "mercado">;

export type ChannelMarketCell<T extends PortfolioBetInput> = GrupoAgg<T> & {
  channel: string;
  market: string;
  /** Teste t do CLV da célula: o mesmo que decide a assinatura de um canal. */
  verdict: EdgeVeredito;
  tStat: number | null;
};

/** Coluna que junta os mercados depois dos mais apostados. */
export const OTHER_MARKETS = "Outros mercados";

export type ChannelMarketGrid<T extends PortfolioBetInput> = {
  /** Colunas, do mercado mais apostado ao menos; o agrupamento por último. */
  markets: string[];
  /** Rótulo exclusivo do agrupamento; null quando todos os mercados aparecem separados. */
  otherMarketsLabel: string | null;
  /** Linhas, do canal mais apostado ao menos; `cells` alinha com `markets`. */
  rows: Array<{ channel: string; total: GrupoAgg<T>; cells: Array<ChannelMarketCell<T> | null> }>;
  /** Toda combinação canal × mercado que tem aposta, sem juntar mercados: a base dos cortes. */
  pairs: ChannelMarketCell<T>[];
};

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** Mais apostas primeiro; empate em ordem alfabética, para a tela não embaralhar entre leituras. */
function byVolume<T>(groups: Map<string, T[]>): string[] {
  return [...groups.entries()]
    .sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b, "pt-BR"))
    .map(([k]) => k);
}

function cellOf<T extends PortfolioBetInput>(channel: string, market: string, members: T[]): ChannelMarketCell<T> {
  const clvs = members.map(clvConfiavel).filter((v): v is number => v !== null);
  const { veredito, tStat } = vereditoEdge(clvs);
  return { ...agregaGrupo(members), channel, market, verdict: veredito, tStat };
}

export function channelMarketGrid<T extends PortfolioBetInput>(
  bets: T[],
  channelOf: (bet: T) => string,
  { maxMarkets = 8 }: { maxMarkets?: number } = {},
): ChannelMarketGrid<T> {
  const ranked = byVolume(groupBy(bets, (b) => b.mercado));
  // Juntar só compensa a partir de dois mercados: "Outros" com um só é aquele
  // mercado com outro nome.
  const shown = ranked.length > maxMarkets + 1 ? ranked.slice(0, maxMarkets) : ranked;
  const folded = new Set(ranked.slice(shown.length));
  let otherMarketsLabel: string | null = null;
  if (folded.size) {
    // O texto recebido de um mercado pode coincidir com o rótulo do grupo.
    const occupied = new Set(ranked);
    otherMarketsLabel = OTHER_MARKETS;
    let suffix = 1;
    while (occupied.has(otherMarketsLabel)) {
      otherMarketsLabel = `${OTHER_MARKETS} (agrupados${suffix === 1 ? "" : ` ${suffix}`})`;
      suffix += 1;
    }
  }
  const markets = otherMarketsLabel ? [...shown, otherMarketsLabel] : shown;
  const byChannel = groupBy(bets, channelOf);
  const pairs: ChannelMarketCell<T>[] = [];
  const rows = byVolume(byChannel).map((channel) => {
    const members = byChannel.get(channel) ?? [];
    const byMarket = new Map<string, ChannelMarketCell<T>>();
    for (const [market, group] of groupBy(members, (b) => b.mercado)) {
      const cell = cellOf(channel, market, group);
      byMarket.set(market, cell);
      pairs.push(cell);
    }
    const cells = markets.map((market) => {
      if (market !== otherMarketsLabel) return byMarket.get(market) ?? null;
      const rest = members.filter((b) => folded.has(b.mercado));
      return rest.length ? cellOf(channel, market, rest) : null;
    });
    return { channel, total: agregaGrupo(members), cells };
  });
  return { markets, otherMarketsLabel, rows, pairs };
}

export type SuggestedCuts<T extends PortfolioBetInput> = {
  /** Mais negativo primeiro (menor t). */
  cuts: ChannelMarketCell<T>[];
  /** Combinações com amostra para o teste: `AMOSTRA_MINIMA_CLV` fechamentos confiáveis ou mais. */
  testedPairs: number;
  totalPairs: number;
  portfolio: GrupoAgg<T>;
  /** A carteira sem as apostas dos cortes: o impacto de ignorá-los. */
  withoutCuts: GrupoAgg<T>;
  /** As apostas dos cortes, juntas. */
  cut: GrupoAgg<T>;
};

/**
 * O que cortar: a combinação canal × mercado com CLV negativo a 95% de
 * confiança (`SEM_EDGE`: ao menos `AMOSTRA_MINIMA_CLV` fechamentos e
 * t ≤ −t crítico). O ROI não decide: na amostra em que o CLV já é
 * significativo, o resultado ainda é ruído, e cortar pelo ROI tira o canal que
 * só teve azar.
 */
export function suggestedCuts<T extends PortfolioBetInput>(bets: T[], grid: ChannelMarketGrid<T>): SuggestedCuts<T> {
  const cuts = grid.pairs
    .filter((cell) => cell.verdict === "SEM_EDGE")
    // t nulo com veredito SEM_EDGE é CLV idêntico e negativo em toda aposta: a evidência mais forte.
    .sort((a, b) => (a.tStat ?? -Infinity) - (b.tStat ?? -Infinity) || (a.avgClv ?? 0) - (b.avgClv ?? 0));
  const cutMembers = cuts.flatMap((cell) => cell.membros);
  const isCut = new Set<T>(cutMembers);
  return {
    cuts,
    testedPairs: grid.pairs.filter((cell) => cell.nClv >= AMOSTRA_MINIMA_CLV).length,
    totalPairs: grid.pairs.length,
    portfolio: agregaGrupo(bets),
    withoutCuts: agregaGrupo(bets.filter((bet) => !isCut.has(bet))),
    cut: agregaGrupo(cutMembers),
  };
}
