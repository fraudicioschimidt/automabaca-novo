// Valores vazios da banca (a tela sem dado) e o agrupamento por dia do histórico.
// Formatadores: importe de `src/domain/formato-de-resultado`.

import { WEEKDAY_NAMES } from "@/src/domain/dates";

export type DayGroup<B> = { day: string; label: string; bets: B[] };

/** Agrupa pelo dia do evento (`day`), na ordem de entrada. */
export function groupByDay<B extends { day: string }>(bets: readonly B[]): DayGroup<B>[] {
  const groups: DayGroup<B>[] = [];
  const indexes = new Map<string, DayGroup<B>>();
  for (const bet of bets) {
    const day = bet.day;
    let group = indexes.get(day);
    if (group === undefined) {
      const [year = NaN, month = NaN, dayNum = NaN] = day.split('-').map(Number);
      const weekday = WEEKDAY_NAMES[new Date(Date.UTC(year, month - 1, dayNum)).getUTCDay()];
      const label = Number.isFinite(year) && weekday
        ? `${weekday}, ${String(dayNum).padStart(2, '0')}/${String(month).padStart(2, '0')}`
        : day;
      group = { day, label, bets: [] };
      indexes.set(day, group);
      groups.push(group);
    }
    group.bets.push(bet);
  }
  return groups;
}

export const BANKROLL_RUNTIME = {
  BETS: [],
  METRICS: {
    capital: 0,
    ops: 0,
    settled: 0,
    lucro: 0,
    acerto: null,
    roi: 0,
    hasRoi: false,
    clvMean: 0,
    hasClv: false,
    clvShare: null,
    open: 0,
    openUnits: 0,
  },
  CHART: [],
  tips: [],
};
