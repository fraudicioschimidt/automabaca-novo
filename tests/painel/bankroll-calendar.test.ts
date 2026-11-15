import { describe, expect, it } from "vitest";
import {
  aggregateCalendarDays,
  summarizeCalendarMonth,
} from "@/app/_design/lib/bankroll-calendar";

describe("bankroll-calendar", () => {
  it("agrega lucro, perda e pendências por dia sem drift", () => {
    const days = aggregateCalendarDays([
      { day: "2026-07-08", stake: 1, profit: 0.975 },
      { day: "2026-07-08", stake: 1, profit: 0.95 },
      { day: "2026-07-08", stake: 1, profit: 0.83 },
      { day: "2026-07-08", stake: 2, profit: null },
      { day: "2026-07-10", stake: 1, profit: -1 },
      { day: "2026-07-10", stake: 1, profit: -1 },
      { day: "2026-07-10", stake: 3, profit: null },
    ]);

    expect(days["2026-07-08"]).toEqual({
      count: 4,
      profit: 2.755,
      units: 5,
      settledCount: 3,
    });
    expect(days["2026-07-10"]).toEqual({
      count: 3,
      profit: -2,
      units: 5,
      settledCount: 2,
    });
  });

  it("resume somente o mês solicitado", () => {
    const days = aggregateCalendarDays([
      { day: "2026-06-30", stake: 1, profit: 1 },
      { day: "2026-07-08", stake: 2, profit: 0.75 },
      { day: "2026-07-08", stake: 1, profit: null },
      { day: "2026-07-10", stake: 1, profit: -1 },
    ]);

    expect(summarizeCalendarMonth(days, 2026, 6)).toEqual({
      count: 3,
      profit: -0.25,
      units: 4,
      settledCount: 2,
      openCount: 1,
    });
  });
});
