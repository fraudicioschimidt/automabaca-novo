import { describe, expect, it } from "vitest";
import { BANKROLL_RUNTIME, groupByDay } from "@/app/_design/lib/bankroll-runtime";

describe("runtime leve da bankroll", () => {
  it("começa vazio, sem carregar fixtures", () => {
    expect(BANKROLL_RUNTIME.BETS).toEqual([]);
    expect(BANKROLL_RUNTIME.tips).toEqual([]);
  });

  it("agrupa em ordem de entrada com rótulo de calendário determinístico", () => {
    const groups = groupByDay([
      { id: "1", day: "2026-07-13" },
      { id: "2", day: "2026-07-12" },
      { id: "3", day: "2026-07-13" },
    ]);
    expect(groups).toEqual([
      {
        day: "2026-07-13",
        label: "Segunda-feira, 13/07",
        bets: [{ id: "1", day: "2026-07-13" }, { id: "3", day: "2026-07-13" }],
      },
      {
        day: "2026-07-12",
        label: "Domingo, 12/07",
        bets: [{ id: "2", day: "2026-07-12" }],
      },
    ]);
  });

  it("agrupa apostas pelo dia do evento (day)", () => {
    const groups = groupByDay([
      { id: "1", day: "2026-07-12", resultDay: "2026-07-13" },
      { id: "2", day: "2026-07-13" },
    ]);
    expect(groups.map((group) => ({
      day: group.day,
      ids: group.bets.map((bet: { id: string }) => bet.id),
    }))).toEqual([
      { day: "2026-07-12", ids: ["1"] },
      { day: "2026-07-13", ids: ["2"] },
    ]);
  });
});
