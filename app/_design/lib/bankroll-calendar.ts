import { sumMoneyBy } from "@/src/domain/money";
import { isDayKey } from "./calendar-date";

export type CalendarBet = {
  day: string;
  stake: number;
  profit: number | null;
};

export type CalendarDayAggregate = {
  count: number;
  profit: number;
  units: number;
  settledCount: number;
};

export function aggregateCalendarDays(
  bets: ReadonlyArray<CalendarBet>,
): Record<string, CalendarDayAggregate> {
  const grouped = new Map<
    string,
    { stakes: number[]; profits: number[]; count: number; settledCount: number }
  >();

  for (const bet of bets) {
    if (!isDayKey(bet.day)) continue;
    const bucket = grouped.get(bet.day) ?? {
      stakes: [],
      profits: [],
      count: 0,
      settledCount: 0,
    };
    bucket.count += 1;
    bucket.stakes.push(bet.stake);
    if (bet.profit != null) {
      bucket.profits.push(bet.profit);
      bucket.settledCount += 1;
    }
    grouped.set(bet.day, bucket);
  }

  return Object.fromEntries(
    [...grouped.entries()].map(([day, bucket]) => [
      day,
      {
        count: bucket.count,
        profit: sumMoneyBy(bucket.profits, (value) => value),
        units: sumMoneyBy(bucket.stakes, (value) => value),
        settledCount: bucket.settledCount,
      },
    ]),
  );
}

export function summarizeCalendarMonth(
  days: Record<string, CalendarDayAggregate>,
  year: number,
  monthIndex: number,
): CalendarDayAggregate & { openCount: number } {
  const prefix = `${year}-${String(monthIndex + 1).padStart(2, "0")}-`;
  const monthDays = Object.entries(days)
    .filter(([day]) => day.startsWith(prefix))
    .map(([, aggregate]) => aggregate);
  const count = monthDays.reduce((total, day) => total + day.count, 0);
  const settledCount = monthDays.reduce((total, day) => total + day.settledCount, 0);

  return {
    count,
    settledCount,
    openCount: count - settledCount,
    profit: sumMoneyBy(monthDays, (day) => day.profit),
    units: sumMoneyBy(monthDays, (day) => day.units),
  };
}
