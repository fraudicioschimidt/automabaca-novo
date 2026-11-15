import "server-only";
import type { Prisma } from "@/src/generated/prisma/client";
import { createMoneyAccumulator, toNumber } from "@/src/domain/money";
import { analyzerDateFilter } from "@/src/domain/analyzer-query";
import { spDayKey } from "@/src/domain/dates";
import { prisma } from "@/src/infra/prisma";

export type BankrollEquityCurve = {
  bankrollId: string;
  slug: string;
  acumulado: number[];
  accumulatedBrl: number[];
};

/**
 * Lucro realizado acumulado de cada banca, no dia do jogo (kickoff) em São
 * Paulo: o mesmo eixo do Analyzer. Liquidação atrasada não muda o dia.
 */
export async function getBankrollEquityCurves(client: Prisma.TransactionClient = prisma): Promise<{
  days: string[];
  curves: BankrollEquityCurve[];
}> {
  const bets = await client.$queryRaw<Array<{
    bankrollId: string;
    slug: string;
    dia: string;
    lucro: Prisma.Decimal;
    profitBrl: Prisma.Decimal;
  }>>`
    SELECT bt."bankrollId", b.slug,
      to_char(bt.data AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
      sum(bt.lucro) AS lucro,
      sum(round(bt.lucro * bt."valorUnidade", 6)) AS "profitBrl"
    FROM bets bt
    JOIN bankrolls b ON b.id = bt."bankrollId"
    WHERE bt."deletedAt" IS NULL
      AND bt.status IN ('WON','LOST','HALF_WON','HALF_LOST','CASHOUT')
    GROUP BY bt."bankrollId", b.slug, dia
    ORDER BY dia ASC
  `;

  const byBankroll = new Map<string, { slug: string; byDay: Map<string, { units: number; brl: number }[]> }>();
  const allDays = new Set<string>();
  for (const bet of bets) {
    allDays.add(bet.dia);
    let entry = byBankroll.get(bet.bankrollId);
    if (!entry) {
      entry = { slug: bet.slug, byDay: new Map() };
      byBankroll.set(bet.bankrollId, entry);
    }
    const bucket = entry.byDay.get(bet.dia) ?? [];
    bucket.push({ units: toNumber(bet.lucro), brl: toNumber(bet.profitBrl) });
    entry.byDay.set(bet.dia, bucket);
  }

  const days = [...allDays].sort();
  const curves: BankrollEquityCurve[] = [];
  for (const [bankrollId, { slug, byDay }] of byBankroll) {
    // Mesmo acumulador de `getBankrollChart`: a soma corrente vive em
    // BigInt-cents em vez de reentrar o total do dia anterior como parcela.
    const accumulator = createMoneyAccumulator();
    const brlAccumulator = createMoneyAccumulator();
    const series: number[] = [];
    const accumulatedBrl: number[] = [];
    for (const day of days) {
      for (const value of byDay.get(day) ?? []) {
        accumulator.add(value.units);
        brlAccumulator.add(value.brl);
      }
      series.push(accumulator.value);
      accumulatedBrl.push(brlAccumulator.value);
    }
    curves.push({ bankrollId, slug, acumulado: series, accumulatedBrl });
  }
  return { days, curves };
}

/** Curva do lucro realizado por dia do jogo. */
export type BankrollChartPoint = { day: string; realized: number };

export async function getBankrollChart(bankrollId: string, now: Date = new Date(), client: Prisma.TransactionClient = prisma): Promise<BankrollChartPoint[]> {
  // Um ponto por dia de jogo com aposta: a liquidada move a curva, a pendente
  // aparece no eixo sem alterar o realizado. A pendente de jogo futuro fica
  // fora: a curva do realizado não tem ponto depois de hoje (São Paulo).
  const tomorrow = analyzerDateFilter("hoje", spDayKey(now))!.lt;
  const daily = await client.$queryRaw<Array<{ day: string; realized: Prisma.Decimal }>>`
    SELECT
      to_char(bt.data AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS day,
      COALESCE(sum(bt.lucro) FILTER (
        WHERE bt.status IN ('WON','LOST','HALF_WON','HALF_LOST','CASHOUT')
      ), 0)::numeric AS realized
    FROM bets bt
    WHERE bt."deletedAt" IS NULL
      AND bt."bankrollId" = ${bankrollId}
      AND bt.status <> 'CANCELED'
      AND (bt.status <> 'PENDING' OR bt.data < ${tomorrow})
    GROUP BY day
    ORDER BY day ASC
  `;

  const points: BankrollChartPoint[] = [];
  const realizedAccumulator = createMoneyAccumulator();
  for (const row of daily) {
    points.push({ day: row.day, realized: realizedAccumulator.add(toNumber(row.realized)) });
  }
  return points;
}
