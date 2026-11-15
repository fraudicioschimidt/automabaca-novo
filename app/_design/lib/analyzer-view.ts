export function percentOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/**
 * "34% do período": quanto a faixa sob o cursor representa do gráfico inteiro.
 * Sem a participação, "12 apostas" numa faixa não diz se é a operação toda ou
 * uma sobra. Só para contagem: 34% de um lucro que soma negativo não significa
 * nada, por isso o lucro mensal e a curva acumulada seguem sem rodapé.
 */
export function fatiaDoPeriodo(parte: number, total: number): string | null {
  if (!(total > 0) || !Number.isFinite(parte)) return null;
  return `${percentOf(parte, total)}% do período`;
}

type Mes = { lucro: number; settledN?: number | null };
type Semana = { roi: number | null; settledN?: number | null };

/** Período sem aposta liquidada (só anuladas) não vira destaque. */
const temLiquidada = (row: { settledN?: number | null }): boolean => (row.settledN ?? 1) > 0;

export function getPeriodHighlights<M extends Mes, W extends Semana>(
  period: { monthly?: readonly M[] | null; weekly?: readonly W[] | null } = {},
): {
  monthly: readonly M[];
  weekly: readonly W[];
  bestMonth: M | null;
  worstMonth: M | null;
  bestWeek: W | null;
  lastWeek: W | null;
} {
  const monthly: readonly M[] = Array.isArray(period.monthly) ? period.monthly : [];
  const weekly: readonly W[] = Array.isArray(period.weekly) ? period.weekly : [];
  const eligibleMonthly = monthly.filter(temLiquidada);
  const eligibleWeekly = weekly.filter(temLiquidada);
  const bestMonth = eligibleMonthly.reduce<M | null>(
    (best, row) => !best || row.lucro > best.lucro ? row : best,
    null,
  );
  const worstMonth = eligibleMonthly.reduce<M | null>(
    (worst, row) => !worst || row.lucro < worst.lucro ? row : worst,
    null,
  );
  // ROI nulo compara como zero, como na coerção numérica do JS.
  const bestWeek = eligibleWeekly.reduce<W | null>(
    (best, row) => !best || (row.roi ?? 0) > (best.roi ?? 0) ? row : best,
    null,
  );

  return {
    monthly,
    weekly,
    bestMonth,
    worstMonth,
    bestWeek,
    lastWeek: weekly[weekly.length - 1] ?? null,
  };
}
