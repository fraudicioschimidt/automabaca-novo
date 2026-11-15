import { describe, expect, it } from "vitest";
import {
  calendarMonthMeta,
  isDayKey,
  parseDayKeyParts,
  resolveTodayKey,
  weekdayFromDayKey,
} from "@/app/_design/lib/calendar-date";

describe("calendar-date", () => {
  it("usa todayKey vindo do servidor quando ele é válido", () => {
    expect(resolveTodayKey("2026-07-10", new Date("2026-06-13T12:00:00Z"))).toBe(
      "2026-07-10",
    );
  });

  it("cai para o dia de São Paulo, não o dia UTC", () => {
    expect(resolveTodayKey(undefined, new Date("2026-07-10T02:59:00Z"))).toBe("2026-07-09");
    expect(resolveTodayKey(undefined, new Date("2026-07-10T03:00:00Z"))).toBe("2026-07-10");
  });

  it("rejeita chave inválida e calendário impossível", () => {
    expect(isDayKey("2026-07-10")).toBe(true);
    expect(isDayKey("2026-7-10")).toBe(false);
    expect(isDayKey("2026-02-31")).toBe(false);
  });

  it("quebra a chave no formato esperado pelo calendário", () => {
    expect(parseDayKeyParts("2026-07-10")).toEqual({
      year: 2026,
      month: 7,
      day: 10,
      monthIndex: 6,
    });
  });

  it("calcula o mês e o dia da semana como data civil, sem depender do fuso local", () => {
    expect(calendarMonthMeta(2026, 6)).toEqual({ startWeekday: 3, daysInMonth: 31 });
    expect(weekdayFromDayKey("2026-07-10")).toBe(5);
  });
});
