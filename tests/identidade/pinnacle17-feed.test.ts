import { describe, expect, it } from "vitest";
import { findPinnacle17Event, rankPinnacle17Candidates } from "@/src/providers/pinnacle17/feed";
import type { Pinnacle17Event } from "@/src/providers/pinnacle17/types";

function makeEvent(params: {
  id: number;
  home: string;
  away: string;
  league: string;
  country?: string | null;
  startTime?: string;
}): Pinnacle17Event {
  return {
    id: params.id,
    name: `${params.home} vs ${params.away}`,
    startTime: params.startTime ?? "2026-09-22T15:00:00Z",
    status: { isStarted: false, isInProgress: false, isInterrupted: false },
    sport: { id: 29, name: "Soccer" },
    league: { id: 100, name: params.league, country: params.country ?? "England" },
    homeTeam: { name: params.home },
    awayTeam: { name: params.away },
    units: "regular",
  };
}

describe("Pinnacle17 matching com contexto de categoria de liga", () => {
  const kickoffUtc = new Date("2026-09-22T15:00:00Z");

  it("par em que os dois lados são só digitação não entra: falta lado âncora", () => {
    for (const [home, away, eventHome, eventAway] of [
      ["Juventus", "FK Partizan", "Juventud", "Partizani"],
      ["Astorps", "Juventus", "Astrops", "Juventud"],
    ] as const) {
      const ranked = rankPinnacle17Candidates({
        events: [makeEvent({ id: 1, home: eventHome, away: eventAway, league: "Liga" })],
        home, away, kickoffUtc,
      });
      expect(ranked, `${home} x ${away}`).toEqual([]);
    }
    // Com um lado casando por evidência, a digitação do outro acompanha.
    expect(rankPinnacle17Candidates({
      events: [makeEvent({ id: 2, home: "Astrops", away: "Hittarp", league: "Liga" })],
      home: "Astorps", away: "Hittarp", kickoffUtc,
    })).toHaveLength(1);
  });

  it("aposta feminina casa com fixture em liga feminina com nomes limpos (Liverpool (F))", () => {
    const events = [
      makeEvent({
        id: 1636001,
        home: "Liverpool",
        away: "Tottenham",
        league: "England - Super League Women",
      }),
    ];

    const ranked = rankPinnacle17Candidates({
      events,
      home: "Liverpool (F)",
      away: "Tottenham (F)",
      kickoffUtc,
      competition: "Women's Super League",
      country: "England",
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.event.id).toBe(1636001);
    expect(ranked[0]!.score).toBe(2.0);
    expect(ranked[0]!.swapped).toBe(false);
  });

  it("aposta feminina NUNCA casa com fixture masculina na Premier League", () => {
    const events = [
      makeEvent({
        id: 1636002,
        home: "Liverpool",
        away: "Tottenham",
        league: "England - Premier League",
      }),
    ];

    const ranked = rankPinnacle17Candidates({
      events,
      home: "Liverpool (F)",
      away: "Tottenham (F)",
      kickoffUtc,
      country: "England",
    });

    expect(ranked).toHaveLength(0);
  });

  it("aposta masculina NUNCA casa com fixture feminina na Super League Women", () => {
    const events = [
      makeEvent({
        id: 1636003,
        home: "Liverpool",
        away: "Tottenham",
        league: "England - Super League Women",
      }),
    ];

    const ranked = rankPinnacle17Candidates({
      events,
      home: "Liverpool",
      away: "Tottenham",
      kickoffUtc,
      competition: "Premier League",
      country: "England",
    });

    expect(ranked).toHaveLength(0);
  });

  it("aposta masculina casa normalmente com fixture masculina na Premier League", () => {
    const events = [
      makeEvent({
        id: 1636004,
        home: "Liverpool",
        away: "Tottenham",
        league: "England - Premier League",
      }),
    ];

    const ranked = rankPinnacle17Candidates({
      events,
      home: "Liverpool",
      away: "Tottenham",
      kickoffUtc,
      competition: "Premier League",
      country: "England",
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.event.id).toBe(1636004);
    expect(ranked[0]!.score).toBe(2.0);
  });

  it("detecta mandos invertidos corretamente em jogo feminino", () => {
    const events = [
      makeEvent({
        id: 1636005,
        home: "Tottenham",
        away: "Liverpool",
        league: "England - Super League Women",
      }),
    ];

    const ranked = rankPinnacle17Candidates({
      events,
      home: "Liverpool (F)",
      away: "Tottenham (F)",
      kickoffUtc,
      competition: "Women's Super League",
      country: "England",
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.event.id).toBe(1636005);
    expect(ranked[0]!.score).toBe(2.0);
    expect(ranked[0]!.swapped).toBe(true);
  });

  it("aposta de reservas casa com liga de reservas da Pinnacle", () => {
    const events = [
      makeEvent({
        id: 1636006,
        home: "Gimnasia La Plata",
        away: "San Lorenzo",
        league: "Argentina - Liga Pro Reserves",
        country: "Argentina",
      }),
    ];

    const ranked = rankPinnacle17Candidates({
      events,
      home: "Gimnasia L.P. 2",
      away: "San Lorenzo 2",
      kickoffUtc,
      country: "Argentina",
      minScore: 1.0,
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.event.id).toBe(1636006);
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(1.0);
  });

  it("aposta de reservas NÃO casa com liga principal do campeonato", () => {
    const events = [
      makeEvent({
        id: 1636007,
        home: "Gimnasia La Plata",
        away: "San Lorenzo",
        league: "Argentina - Liga Profesional",
        country: "Argentina",
      }),
    ];

    const ranked = rankPinnacle17Candidates({
      events,
      home: "Gimnasia L.P. 2",
      away: "San Lorenzo 2",
      kickoffUtc,
      country: "Argentina",
    });

    expect(ranked).toHaveLength(0);
  });
});

describe("Pinnacle17: gêmeo sub-19 no mesmo dia", () => {
  it("\"Real Madrid x Inter\" sem horário no post casa com a Champions, não com a Youth League (caso real que ia ao Vincular)", () => {
    const events = [
      { ...makeEvent({ id: 1, home: "Real Madrid", away: "Internazionale", league: "UEFA - Youth League U19", country: "Europe",
        startTime: "2026-09-08T14:00:00Z" }), league: { id: 201, name: "UEFA - Youth League U19", country: "Europe" } },
      { ...makeEvent({ id: 2, home: "Real Madrid", away: "Internazionale", league: "UEFA - Champions League", country: "Europe",
        startTime: "2026-09-08T19:00:00Z" }), league: { id: 202, name: "UEFA - Champions League", country: "Europe" } },
    ];
    const found = findPinnacle17Event({
      events, home: "Real Madrid", away: "Inter", kickoffUtc: new Date("2026-09-08T03:00:00Z"), kickoffInferido: true,
    });
    expect(found?.event.id).toBe(2);
  });
});

