import measured from "../fixtures/flashscore-basketball-half-20260913.json";
import type { BasketballHalfProof } from "@/src/providers/flashscore/basketball-half";
import type { FlashscoreMatchCandidate } from "@/src/providers/flashscore/match";

export const HALF_NOW = new Date("2026-09-13T08:00:00Z");
export function halfFixture() {
  const body = structuredClone(measured.observations[0]!.body) as BasketballHalfProof["details"];
  body.timestamp = Math.floor(HALF_NOW.getTime() / 1_000) - 3 * 3_600;
  Object.assign(body.scores, { home: 87, away: 79, home_total: 87, away_total: 79,
    home_1st_quarter: 25, away_1st_quarter: 20, home_2nd_quarter: 22, away_2nd_quarter: 19,
    home_3rd_quarter: 20, away_3rd_quarter: 20, home_4th_quarter: 20, away_4th_quarter: 20 });
  const candidate: FlashscoreMatchCandidate = { strategy: "provider_id", score: 2, swapped: false,
    match: { match_id: body.match_id, timestamp: body.timestamp, match_status: { ...body.match_status },
      scores: { home: 87, away: 79 },
      home_team: { team_id: body.home_team.team_id, name: "Alpha" },
      away_team: { team_id: body.away_team.team_id, name: "Beta" } } };
  return { body, candidate, now: HALF_NOW, requestStartedAt: HALF_NOW.toISOString(), observedAt: HALF_NOW.toISOString() };
}
