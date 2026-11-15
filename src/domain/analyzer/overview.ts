import { spDayKey } from "@/src/domain/dates";
import { createMoneyAccumulator, moneyByPercent, roundMoney, sumMoneyBy } from "@/src/domain/money";
import type { BetRowData } from "@/src/domain/bet-read-model";
import {
  agregaGrupo,
  ordenaPorData,
  clvConfiavel,
  media,
  resolvidas,
  roiPct,
} from "./shared";

/** Aba Overview: curva PnL + drawdown, lucro mensal com ROI,
 * ROI×CLV esperado, streaks/qualidade e maior lucro/perda. */

export type PnlPoint = { dayKey: string; cum: number; drawdown: number };
export type BetDestaque = { evento: string; data: Date; odds: number; stake: number; lucro: number };

export type OverviewV1 = {
  totalBets: number;
  resolvedBets: number;
  pendingBets: number;
  totalLucro: number;
  totalStake: number;
  roi: number | null;
  avgClv: number | null;
  pctPositiveClv: number | null;
  pnl: PnlPoint[];
  maxDrawdown: number;
  expectedRoi: number | null;
  realizedRoiClv: number | null;
  realizedRoiClvN: number;
  roiClvGap: number | null;
  maxWinStreak: number;
  maxLossStreak: number;
  wonBets: number;
  halfWonBets: number;
  lostBets: number;
  halfLostBets: number;
  voidBets: number;
  sucessoPct: number | null;
  avgOdds: number | null;
  avgStake: number | null;
  bestBet: BetDestaque | null;
  worstBet: BetDestaque | null;
};


export function computeOverviewV1(bets: BetRowData[]): OverviewV1 {
  const ordered = ordenaPorData(bets);
  const fin = resolvidas(ordered);
  const agg = agregaGrupo(bets);
  const { pnl, maxDrawdown } = pnlCurve(fin);
  const roiVsClv = roiRealizadoVsClv(fin);
  const statusDe = (b: BetRowData) => (typeof b.status === "string" ? b.status.trim().toUpperCase() : "");
  const contaFinais = (status: string) => fin.filter((b) => statusDe(b) === status).length;
  return {
    totalBets: bets.length,
    resolvedBets: fin.length,
    pendingBets: bets.filter((b) => statusDe(b) === "PENDING").length,
    totalLucro: agg.lucro,
    totalStake: agg.stake,
    roi: agg.roi,
    avgClv: agg.avgClv,
    pctPositiveClv: agg.pctPositiveClv,
    pnl,
    maxDrawdown,
    ...roiVsClv,
    ...streaks(ordered.filter((b) => b.status.trim().toUpperCase() !== "PENDING")),
    wonBets: contaFinais("WON"),
    halfWonBets: contaFinais("HALF_WON"),
    lostBets: contaFinais("LOST"),
    halfLostBets: contaFinais("HALF_LOST"),
    voidBets: bets.filter((b) => statusDe(b) === "VOID").length,
    sucessoPct: agg.sucessoPct,
    avgOdds: media(fin.map((b) => b.odds)),
    avgStake: fin.length ? agg.stake / fin.length : null,
    ...destaques(fin),
  };
}

/**
 * Curva acumulada e drawdown por aposta resolvida, na ordem e no dia do jogo
 * (o eixo do recorte): liquidar com atraso não muda o dia do resultado. O
 * simulador de stake (`stake-policy`) passa o lucro de cada política por aqui,
 * para o drawdown dele ser o mesmo da visão geral.
 */
export function pnlCurve(
  fin: ReadonlyArray<Pick<BetRowData, "lucro" | "data">>,
): { pnl: PnlPoint[]; maxDrawdown: number } {
  const acum = createMoneyAccumulator();
  let pico = 0;
  let maxDrawdown = 0;
  const pnl = fin.map((b) => {
    const cum = acum.add(b.lucro);
    pico = Math.max(pico, cum);
    const drawdown = roundMoney(cum - pico);
    maxDrawdown = Math.min(maxDrawdown, drawdown);
    return { dayKey: spDayKey(b.data), cum, drawdown };
  });
  return { pnl, maxDrawdown };
}

/**
 * ROI realizado vs ROI esperado (≈CLV ponderado por stake) sobre o MESMO
 * subconjunto, as resolvidas com CLV confiável: com populações diferentes o gap
 * podia inverter de sinal.
 */
function roiRealizadoVsClv(fin: BetRowData[]) {
  const comClvFin = fin
    .map((b) => ({ stake: b.stake, lucro: b.lucro, clv: clvConfiavel(b) }))
    .filter((x): x is { stake: number; lucro: number; clv: number } => x.clv !== null);
  const stakeClv = sumMoneyBy(comClvFin, (x) => x.stake);
  const expectedRoi = roiPct(sumMoneyBy(comClvFin, (x) => moneyByPercent(x.stake, x.clv)), stakeClv);
  const realizedRoiClv = roiPct(sumMoneyBy(comClvFin, (x) => x.lucro), stakeClv);
  return {
    expectedRoi,
    realizedRoiClv,
    realizedRoiClvN: comClvFin.length,
    roiClvGap: realizedRoiClv !== null && expectedRoi !== null ? realizedRoiClv - expectedRoi : null,
  };
}

/** Maiores sequências de vitórias e derrotas; meias contam, VOID e CASHOUT quebram. */
function streaks(fin: BetRowData[]): { maxWinStreak: number; maxLossStreak: number } {
  let seqW = 0;
  let seqL = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  for (const b of fin) {
    const s = typeof b.status === "string" ? b.status.trim().toUpperCase() : "";
    if (s === "WON" || s === "HALF_WON") {
      seqW += 1;
      seqL = 0;
    } else if (s === "LOST" || s === "HALF_LOST") {
      seqL += 1;
      seqW = 0;
    } else {
      seqW = 0;
      seqL = 0;
    }
    maxWinStreak = Math.max(maxWinStreak, seqW);
    maxLossStreak = Math.max(maxLossStreak, seqL);
  }
  return { maxWinStreak, maxLossStreak };
}

function destaques(fin: BetRowData[]): { bestBet: BetDestaque | null; worstBet: BetDestaque | null } {
  const destaque = (b: BetRowData): BetDestaque => ({
    evento: b.evento,
    data: b.data,
    odds: b.odds,
    stake: b.stake,
    lucro: b.lucro,
  });
  const ganhos = fin.filter((b) => b.lucro > 0);
  const perdas = fin.filter((b) => b.lucro < 0);
  return {
    bestBet: ganhos.length ? destaque(ganhos.reduce((a, b) => (b.lucro > a.lucro ? b : a))) : null,
    worstBet: perdas.length ? destaque(perdas.reduce((a, b) => (b.lucro < a.lucro ? b : a))) : null,
  };
}
