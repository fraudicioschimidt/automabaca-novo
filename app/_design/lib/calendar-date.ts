import { spDayKey } from "@/src/domain/dates";

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DAY_KEY_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function resolveTodayKey(value: unknown, now: Date = new Date()): string {
  return isDayKey(value) ? value : spDayKey(now);
}

export function parseDayKeyParts(dayKey: unknown): {
  year: number;
  month: number;
  day: number;
  monthIndex: number;
} {
  const safe = resolveTodayKey(dayKey);
  const [year = 0, month = 1, day = 1] = safe.split("-").map(Number);
  return { year, month, day, monthIndex: month - 1 };
}

export function calendarMonthMeta(year: number, monthIndex: number): {
  startWeekday: number;
  daysInMonth: number;
} {
  return {
    startWeekday: new Date(Date.UTC(year, monthIndex, 1)).getUTCDay(),
    daysInMonth: new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate(),
  };
}

export function weekdayFromDayKey(dayKey: unknown): number {
  const { year, monthIndex, day } = parseDayKeyParts(dayKey);
  return new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
}

/** "2026-08-06" → "06/08". Chave vazia vira texto vazio. */
export function diaMesDaChave(dayKey: string): string {
  return dayKey ? `${dayKey.slice(8, 10)}/${dayKey.slice(5, 7)}` : "";
}
