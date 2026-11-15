import { sumMoneyBy } from "@/src/domain/money";
import { hitRateFromCounts } from "@/src/domain/hit-rate";
import {
  comparaDecisao,
  rankingDaDecisaoNaTela,
} from "@/src/domain/analyzer/decisao";

/** Default do pódio / lista: evidência de edge, não lucro anedótico. */
export const DEFAULT_TIPSTER_SORT = "decisao";

export type TipsterMetricRow = {
  lucro: number;
  staked: number;
  wins: number;
  losses: number;
  halfWins?: number;
  halfLosses?: number;
  clv: number;
  /** Média da mesma base do veredito, antes do arredondamento de exibição. */
  clvMedio?: number | null;
  clvSamples?: number;
  hasRoi?: boolean;
  hasClv?: boolean;
  hasAcerto?: boolean;
  [key: string]: unknown;
};

export function hasTipsterMetric(row: TipsterMetricRow, key: string): boolean {
  if (key === "lucro" || key === "roi") return row.hasRoi ?? row.staked > 0;
  if (key === "clv") return row.hasClv ?? (row.clvSamples ?? 0) > 0;
  if (key === "acerto") return row.hasAcerto ?? row.wins + row.losses > 0;
  return true;
}

/** Consolidado em reais: unidades de tipsters diferentes não são somáveis. */
export function aggregateTipsterMetrics(rows: Array<TipsterMetricRow & { profitBrl: number; stakedBrl: number }>) {
  const lucro = sumMoneyBy(rows, (row) => row.profitBrl);
  const staked = sumMoneyBy(rows, (row) => row.stakedBrl);
  const wins = rows.reduce((sum, row) => sum + row.wins, 0);
  const losses = rows.reduce((sum, row) => sum + row.losses, 0);
  const halfWins = rows.reduce((sum, row) => sum + (row.halfWins ?? 0), 0);
  const halfLosses = rows.reduce((sum, row) => sum + (row.halfLosses ?? 0), 0);
  const attempts = wins + losses;
  const clvSamples = rows.reduce((sum, row) => sum + (row.clvSamples ?? 0), 0);
  const clvWeighted = sumMoneyBy(
    rows,
    (row) => row.clv * (row.clvSamples ?? 0),
    4,
  );

  return {
    lucro,
    staked,
    roi: staked > 0 ? (lucro / staked) * 100 : null,
    clv: clvSamples > 0 ? clvWeighted / clvSamples : null,
    winrate: hitRateFromCounts({
      won: wins - halfWins,
      lost: losses - halfLosses,
      halfWon: halfWins,
      halfLost: halfLosses,
    }),
    wins,
    losses,
    halfWins,
    halfLosses,
    attempts,
    clvSamples,
  };
}

export function compareTipsterMetric(
  a: TipsterMetricRow,
  b: TipsterMetricRow,
  key: string,
): number {
  const aHas = hasTipsterMetric(a, key);
  const bHas = hasTipsterMetric(b, key);
  if (aHas !== bHas) return aHas ? -1 : 1;
  const av = Number(a[key] ?? 0);
  const bv = Number(b[key] ?? 0);
  return bv - av;
}

function decisaoDoTipster(row: TipsterMetricRow) {
  const nested = row.dec as
    | {
        veredito?: string | null;
        verdict?: string | null;
        tStat?: number | null;
        clv?: number | null;
        clvMedio?: number | null;
      }
    | undefined;
  return rankingDaDecisaoNaTela({
    veredito: (nested?.veredito ?? row.veredito) as never,
    verdict: nested?.verdict ?? (row.verdict as string | null | undefined),
    tStat: nested?.tStat ?? (row.tStat as number | null | undefined),
    clvMedio: nested ? nested.clvMedio : row.clvMedio,
    clv: nested ? nested.clv : hasTipsterMetric(row, "clv") ? row.clv : null,
  });
}

/** Pódio e chave CLV usam o mesmo piso/t-stat do veredito. */
export function compareTipstersByKey(
  a: TipsterMetricRow,
  b: TipsterMetricRow,
  key: string,
): number {
  if (key === "decisao" || key === "clv") {
    return comparaDecisao(decisaoDoTipster(a), decisaoDoTipster(b));
  }
  if (key === "volume" || key === "apostas") {
    return Number(b.n ?? 0) - Number(a.n ?? 0);
  }
  if (key === "nome") {
    return String(a.name ?? "").localeCompare(String(b.name ?? ""), "pt-BR");
  }
  return compareTipsterMetric(a, b, key);
}

/**
 * Destaque por métrica de TAXA: quem tem o melhor CLV médio.
 *
 * Taxa não se compara sem amostra: uma banca com UM fechamento não pode ganhar
 * o "Melhor CLV médio". Só elege quem passa do piso, e a tela mostra a amostra
 * ao lado do percentual.
 *
 * Só vale para TAXA. `Mais lucrativo` e `Precisa de atenção` somam lucro
 * absoluto: quem fez +5u em uma aposta fez +5u mesmo, e um piso ali esconderia
 * dinheiro real. Piso é para média, não para soma.
 */
export type DestaqueDeTaxa<R = TipsterMetricRow> =
  | { estado: "sem-dado" }
  | { estado: "amostra-curta"; melhorAmostra: number }
  | { estado: "ok"; row: R; amostra: number };

export function melhorPorTaxa<R extends TipsterMetricRow>(
  rows: R[],
  key: "clv",
  piso: number,
): DestaqueDeTaxa<R> {
  const amostraDe = (row: TipsterMetricRow) =>
    Number(row.clvSamples ?? 0);
  const comDado = rows.filter((row) => hasTipsterMetric(row, key) && amostraDe(row) > 0);
  if (comDado.length === 0) return { estado: "sem-dado" };
  const elegiveis = comDado.filter((row) => amostraDe(row) >= piso);
  if (elegiveis.length === 0) {
    return {
      estado: "amostra-curta",
      melhorAmostra: Math.max(...comDado.map(amostraDe)),
    };
  }
  const row = elegiveis.slice().sort((a, b) => Number(b[key]) - Number(a[key]))[0]!;
  return { estado: "ok", row, amostra: amostraDe(row) };
}
