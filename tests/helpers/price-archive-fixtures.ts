import type { ArchivedPriceEnvelope } from "@/src/providers/price-archive/codec";
export const ARCHIVE_ENTRY = new Date("2026-09-13T06:00:00.000Z");
export const ARCHIVE_KICKOFF = new Date("2026-09-13T08:00:00.000Z");
export const ARCHIVE_NOW = new Date("2026-09-13T09:00:00.000Z");
export function priceEnvelope(provider: "pinnacle17" | "bridgeodds" = "pinnacle17", at = new Date(ARCHIVE_ENTRY.getTime() + 60_000)): ArchivedPriceEnvelope {
  const event = { id: 123, name: "Alpha vs Beta", startTime: ARCHIVE_KICKOFF.toISOString(),
    status: { isStarted: false, isInProgress: false, isInterrupted: false }, sport: { id: 29, name: "Soccer" },
    league: { id: 1, name: "Synthetic", country: "World" }, homeTeam: { name: "Alpha" }, awayTeam: { name: "Beta" }, units: "Regular" };
  const market = { name: "Money Line – Match", type: "moneyline", period: 0, periodName: "Match", team: null,
    units: "Regular", special: null, isLive: false, line: null, status: "open", cutoffAt: ARCHIVE_KICKOFF.toISOString(),
    limits: [{ amount: 100, type: "maxRiskStake" }], outcomes: [
      { designation: "home", name: "Alpha", line: null, oddsDecimal: 2 },
      { designation: "draw", name: "Draw", line: null, oddsDecimal: 3 },
      { designation: "away", name: "Beta", line: null, oddsDecimal: 4 }] };
  return { version: 1, provider, endpoint: provider === "pinnacle17" ? "/api/pinnacle/v1/match/odds" : "/api/odds/opening-closing",
    requestedAt: new Date(at.getTime() - 1000).toISOString(), observedAt: at.toISOString(), eventIds: ["123"],
    context: provider === "pinnacle17" ? { host: "pinnacle17.p.rapidapi.com", query: { match_id: 123, timezone: "UTC" }, event }
      : { host: "bridge.test", query: { sport: "Futebol", date: "2026-09-13", page: "1" } },
    body: provider === "pinnacle17" ? { markets: [market], extraProviderField: { preserved: true } }
      : { results: [{ match_id: 123, home: "Alpha", away: "Beta", sport: "Futebol", league: "Synthetic",
        match_date: ARCHIVE_KICKOFF.toISOString(), home_score: 7, away_score: 4,
        moneyline: { closing: { home: 2, draw: 3, away: 4, max_bet: 100 } } }], total: 1 } };
}
