import { MONTH_ABBREVIATIONS, shiftDayKey, spDayKey, spWeekKey } from "@/src/domain/dates";
import { createMoneyAccumulator, sumMoneyBy } from "@/src/domain/money";
import type { BetRowData } from "@/src/domain/bet-read-model";
import { agregaGrupo, ordenaPorData, resolvidas, type GrupoAgg } from "./shared";

/** Aba Período: evolução mensal com acumulado, últimas 26
 * semanas (ROI×CLV), últimos 90 dias e tabela mensal completa. Todo balde é o
 * dia do jogo em São Paulo, o mesmo eixo do recorte. */

export type PeriodoRowV1 = GrupoAgg & { key: string; label: string; cumLucro: number };
export type PeriodoDayV1 = { dayKey: string; lucro: number };

export type PeriodoV1 = {
  totalLucro: number;
  monthly: PeriodoRowV1[];
  weekly: PeriodoRowV1[];
  daily90: PeriodoDayV1[];
  bestMonth: PeriodoRowV1 | null;
  worstMonth: PeriodoRowV1 | null;
  latestWeek: PeriodoRowV1 | null;
  bestWeek: PeriodoRowV1 | null;
};


function agrupa(
  bets: BetRowData[],
  chave: (b: BetRowData) => string,
  rotulo: (key: string) => string,
): PeriodoRowV1[] {
  const por = new Map<string, BetRowData[]>();
  for (const b of bets) {
    const k = chave(b);
    const cur = por.get(k);
    if (cur) cur.push(b);
    else por.set(k, [b]);
  }
  const acum = createMoneyAccumulator();
  return [...por.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, grupo]) => {
      const agg = agregaGrupo(grupo);
      const cum = acum.add(agg.lucro);
      return { key, label: rotulo(key), ...agg, cumLucro: cum };
    });
}

/** Agrupamento mensal, também usado pela Visão geral sem calcular semanas e dias. */
export function computeMonthlyPeriods(bets: BetRowData[]): PeriodoRowV1[] {
  return agrupa(
    bets,
    (b) => spDayKey(b.data).slice(0, 7),
    (k) => {
      const [ano, mes] = k.split("-").map(Number);
      return `${MONTH_ABBREVIATIONS[(mes ?? 1) - 1]}/${String(ano).slice(2)}`;
    },
  );
}

export function computePeriodoV1(bets: BetRowData[]): PeriodoV1 {
  const ordenadas = ordenaPorData(bets);

  const monthly = computeMonthlyPeriods(ordenadas);
  const weekly = agrupa(ordenadas, (b) => spWeekKey(b.data), (k) => `S${k.slice(6)}`).slice(-26);

  // Últimos 90 dias: lucro por dia (resolvidas).
  const porDia = new Map<string, number[]>();
  for (const b of resolvidas(ordenadas)) {
    const k = spDayKey(b.data);
    const cur = porDia.get(k);
    if (cur) cur.push(b.lucro);
    else porDia.set(k, [b.lucro]);
  }
  const dailyEntries = [...porDia.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const latestDayKey = dailyEntries.at(-1)?.[0];
  const cutoff90 = latestDayKey ? shiftDayKey(latestDayKey, -89) : null;
  const daily90 = dailyEntries
    .filter(([dayKey]) => cutoff90 !== null && dayKey >= cutoff90)
    .map(([dayKey, lucros]) => ({
      dayKey,
      lucro: sumMoneyBy(lucros, (v) => v),
    }));

  const totalLucro = sumMoneyBy(monthly, (m) => m.lucro);
  const melhor = (lista: PeriodoRowV1[], pior = false) => {
    const validas = lista.filter((r) => r.resolvedBets > 0);
    if (!validas.length) return null;
    return validas.reduce((a, b) => ((pior ? b.lucro < a.lucro : b.lucro > a.lucro) ? b : a));
  };
  const semanasComRoi = weekly.filter((w) => w.roi !== null);

  return {
    totalLucro,
    monthly,
    weekly,
    daily90,
    bestMonth: melhor(monthly),
    worstMonth: melhor(monthly, true),
    latestWeek: weekly.at(-1) ?? null,
    bestWeek: semanasComRoi.length
      ? semanasComRoi.reduce((a, b) => ((b.roi ?? -1e9) > (a.roi ?? -1e9) ? b : a))
      : null,
  };
}
