import { spWeekKey } from "@/src/domain/dates";
import { moneyByPercent, sumMoneyBy } from "@/src/domain/money";
import type { BetRowData } from "@/src/domain/bet-read-model";
import { agregaGrupo, CLV_CORTES, clvConfiavel, media, mediana, ordenaPorData, resolvidas, type GrupoAgg } from "./shared";

/** Aba de CLV: retorno implícito vs realizado, evolução semanal e faixas. */

export type ClvV1 = {
  avgClv: number | null;
  medianClv: number | null;
  totalWithClv: number;
  pctPositiveClv: number | null;
  expectedLucro: number;
  actualLucro: number;
  varianceGap: number;
  clvEvolution: Array<{ week: string; avgClv: number | null; count: number }>;
  clvDistribution: Array<{ label: string; count: number }>;
  roiByClvBucket: Array<GrupoAgg & { label: string }>;
};

export function computeClvV1(bets: BetRowData[]): ClvV1 {
  const clvs = bets.map(clvConfiavel).filter((v): v is number => v !== null);

  const porSemana = new Map<string, BetRowData[]>();
  for (const b of ordenaPorData(bets)) {
    const k = spWeekKey(b.data);
    const cur = porSemana.get(k);
    if (cur) cur.push(b);
    else porSemana.set(k, [b]);
  }
  const semanas = [...porSemana.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  // Referência (Σ stake×CLV) vs realizado (sobre apostas com CLV resolvidas).
  const comClvFin = resolvidas(bets).filter((b) => clvConfiavel(b) !== null);
  // Σ stake×(CLV/100) — série monetária; soma em BigInt-cents.
  const expectedLucro = sumMoneyBy(comClvFin, (b) =>
    moneyByPercent(b.stake, clvConfiavel(b) ?? 0),
  );
  const actualLucro = sumMoneyBy(comClvFin, (b) => b.lucro);

  const clvEvolution = semanas.map(([week, grupo]) => {
    const weeklyClvs = grupo.map(clvConfiavel).filter((v): v is number => v !== null);
    return { week: `S${week.slice(6)}`, avgClv: media(weeklyClvs), count: weeklyClvs.length };
  });

  const clvDistribution = CLV_CORTES.map(([label, test]) => ({
    label,
    count: clvs.filter(test).length,
  }));

  const roiByClvBucket = CLV_CORTES.map(([label, test]) => {
    const grupo = bets.filter((b) => {
      const v = clvConfiavel(b);
      return v !== null && test(v);
    });
    const agg = agregaGrupo(grupo);
    return { ...agg, label };
  });

  return {
    avgClv: media(clvs),
    medianClv: mediana(clvs),
    totalWithClv: clvs.length,
    pctPositiveClv: clvs.length ? (clvs.filter((v) => v > 0).length / clvs.length) * 100 : null,
    expectedLucro,
    actualLucro,
    varianceGap: sumMoneyBy([actualLucro, -expectedLucro], (v) => v),
    clvEvolution,
    clvDistribution,
    roiByClvBucket,
  };
}
