import { describe, expect, it } from "vitest";
import {
  kickoffChangedMaterially,
  kickoffInferidoFromParsed,
  looksLikeSpMidnightKickoff,
} from "@/src/domain/kickoff-infer";
import { parseBrKickoffDetailed, spToUtc } from "@/src/domain/dates";

describe("kickoff-infer", () => {
  it("sem data → inferido", () => {
    expect(kickoffInferidoFromParsed({ data: null })).toBe(true);
  });

  it("só dia → inferido; com hora → não", () => {
    expect(kickoffInferidoFromParsed({ data: new Date(), kickoffDateOnly: true })).toBe(true);
    expect(kickoffInferidoFromParsed({ data: new Date(), kickoffDateOnly: false })).toBe(false);
  });

  it("do parse ao flag: dateOnly espelha a ausência de hora", () => {
    const soDia = parseBrKickoffDetailed("15/06", new Date("2026-06-01T00:00:00Z"));
    expect(soDia?.dateOnly).toBe(true);
    expect(kickoffInferidoFromParsed({ data: soDia!.date, kickoffDateOnly: soDia!.dateOnly })).toBe(true);

    const comHora = parseBrKickoffDetailed("15/06 16:00", new Date("2026-06-01T00:00:00Z"));
    expect(comHora?.dateOnly).toBe(false);
    expect(kickoffInferidoFromParsed({ data: comHora!.date, kickoffDateOnly: comHora!.dateOnly })).toBe(false);
  });

  it("looksLikeSpMidnightKickoff detecta 00:00 SP", () => {
    expect(looksLikeSpMidnightKickoff(spToUtc({ year: 2026, month: 6, day: 15 }))).toBe(true);
    expect(
      looksLikeSpMidnightKickoff(spToUtc({ year: 2026, month: 6, day: 15, hour: 16 })),
    ).toBe(false);
  });

  it("mudança material ≥1h", () => {
    const a = new Date("2026-06-15T03:00:00Z");
    const b = new Date("2026-06-15T19:00:00Z"); // +16h
    expect(kickoffChangedMaterially(a, b)).toBe(true);
    expect(kickoffChangedMaterially(a, new Date(a.getTime() + 30 * 60_000))).toBe(false);
  });
});
