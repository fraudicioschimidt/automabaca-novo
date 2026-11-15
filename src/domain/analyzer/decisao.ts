import { sumMoneyBy } from "@/src/domain/money";
import type { BetRowData } from "@/src/domain/bet-read-model";
import { analyzerDateFilter } from "@/src/domain/analyzer-query";
import { spDayKey } from "@/src/domain/dates";
import {
  type BetAggInput,
  CLV_CORTES,
  clvConfiavel,
  type EdgeVeredito,
  media,
  resolvidas,
  roiPct,
  VEREDITO_RANK,
  vereditoDeChaveNaTela,
  vereditoEdge,
} from "./shared";

/**
 * Métricas de decisão de assinatura de um canal (bankroll 1:1 canal):
 * % beat-the-close, distribuição de CLV, ROI real, decaimento de edge e
 * amostra mínima para significância.
 */

export type DecisaoBetInput = BetAggInput & Pick<BetRowData, "data">;

export type DecisaoCanal = {
  apostas: number;
  /** Apostas com CLV confiável — a amostra que sustenta o veredito. */
  nClv: number;
  /** % das apostas com CLV confiável que bateram o fechamento (CLV > 0). */
  beatClosePct: number | null;
  clvMedio: number | null;
  /** Contagem por faixa de CLV. */
  distClv: Array<{ label: string; count: number }>;
  /** Liquidadas — base do ROI. */
  nFinal: number;
  /** ROI realizado sobre as liquidadas. */
  roiReal: number | null;
  /** CLV médio dos jogos dos últimos 30 dias (vs `ref`). */
  clv30d: number | null;
  n30d: number;
  /** Fechamentos confiáveis dos jogos dos 30 dias anteriores: a base do outro lado do Δ. */
  n30a60d: number;
  /** Decaimento de edge: CLV médio últimos 30d − 30d anteriores (pontos %). */
  deltaClv30d: number | null;
  veredito: EdgeVeredito;
  tStat: number | null;
};

/**
 * As janelas do decaimento, pelo dia do jogo em São Paulo: os 30 dias que
 * terminam no dia de `ref` e os 30 anteriores, como o recorte "30d" do
 * Analyzer. O agregado SQL usa os mesmos dois cortes.
 */
export function decisionWindowStarts(ref: Date): { recent: Date; previous: Date } {
  const today = spDayKey(ref);
  return { recent: analyzerDateFilter("30d", today)!.gte, previous: analyzerDateFilter("30d", today, true)!.gte };
}

/**
 * Definição de referência da decisão, sobre apostas já hidratadas. A tela usa o
 * agregado SQL equivalente de `services/bankrolls/channel-decision.ts` (não hidrata o
 * histórico); `tests/painel/canais-decisao.db.test.ts` exige que os dois coincidam.
 * `ref` é o "agora" injetado.
 */
export function computeDecisaoCanal(bets: DecisaoBetInput[], ref: Date): DecisaoCanal {
  const clvs = bets.map(clvConfiavel).filter((v): v is number => v !== null);
  const { veredito, tStat } = vereditoEdge(clvs);

  const distClv = CLV_CORTES.map(([label, test]) => ({
    label,
    count: clvs.filter(test).length,
  }));

  const finais = resolvidas(bets);
  const stakeFinal = sumMoneyBy(finais, (b) => b.stake);
  const lucroReal = sumMoneyBy(finais, (b) => b.lucro);
  const roiReal = roiPct(lucroReal, stakeFinal);

  const windows = decisionWindowStarts(ref);
  const corte30d = windows.recent.getTime();
  const corte60d = windows.previous.getTime();
  const recentes: number[] = [];
  const anteriores: number[] = [];
  for (const b of bets) {
    const v = clvConfiavel(b);
    if (v === null) continue;
    const data = b.data.getTime();
    if (data >= corte30d) recentes.push(v);
    else if (data >= corte60d) anteriores.push(v);
  }
  const clv30d = media(recentes);
  const clvAntes = media(anteriores);

  return {
    apostas: bets.length,
    nClv: clvs.length,
    beatClosePct: clvs.length ? (clvs.filter((v) => v > 0).length / clvs.length) * 100 : null,
    clvMedio: media(clvs),
    distClv,
    nFinal: finais.length,
    roiReal,
    clv30d,
    n30d: recentes.length,
    n30a60d: anteriores.length,
    deltaClv30d: clv30d !== null && clvAntes !== null ? clv30d - clvAntes : null,
    veredito,
    tStat,
  };
}

export type RankingDecisao = Pick<DecisaoCanal, "veredito" | "tStat" | "clvMedio">;

/**
 * Ordem de ranking entre canais: melhor evidência de edge primeiro
 * (EDGE → INCONCLUSIVO → AMOSTRA_CURTA → SEM_EDGE), depois t-stat e CLV.
 */
export function comparaDecisao(a: RankingDecisao, b: RankingDecisao): number {
  const aRank = Object.prototype.hasOwnProperty.call(VEREDITO_RANK, a.veredito)
    ? VEREDITO_RANK[a.veredito]
    : VEREDITO_RANK.AMOSTRA_CURTA;
  const bRank = Object.prototype.hasOwnProperty.call(VEREDITO_RANK, b.veredito)
    ? VEREDITO_RANK[b.veredito]
    : VEREDITO_RANK.AMOSTRA_CURTA;
  const porVeredito = aRank - bRank;
  if (porVeredito !== 0) return porVeredito;

  const aT = typeof a.tStat === "number" && Number.isFinite(a.tStat) ? a.tStat : -Infinity;
  const bT = typeof b.tStat === "number" && Number.isFinite(b.tStat) ? b.tStat : -Infinity;
  if (aT !== bT) return bT - aT;

  const aC = typeof a.clvMedio === "number" && Number.isFinite(a.clvMedio) ? a.clvMedio : -Infinity;
  const bC = typeof b.clvMedio === "number" && Number.isFinite(b.clvMedio) ? b.clvMedio : -Infinity;
  if (aC !== bC) return bC - aC;

  return 0;
}

/** Campos da tela de assinatura no mesmo ranking de `comparaDecisao`. */
export function rankingDaDecisaoNaTela(dec: {
  veredito?: EdgeVeredito | null;
  verdict?: string | null;
  tStat?: number | null;
  clv?: number | null;
  clvMedio?: number | null;
}): RankingDecisao {
  const canon = dec.veredito;
  const veredito =
    canon && Object.prototype.hasOwnProperty.call(VEREDITO_RANK, canon)
      ? canon
      : (vereditoDeChaveNaTela(dec.verdict) ?? "AMOSTRA_CURTA");
  const clv = dec.clvMedio === undefined ? dec.clv : dec.clvMedio;
  return {
    veredito,
    tStat: typeof dec.tStat === "number" && Number.isFinite(dec.tStat) ? dec.tStat : null,
    clvMedio: typeof clv === "number" && Number.isFinite(clv) ? clv : null,
  };
}
