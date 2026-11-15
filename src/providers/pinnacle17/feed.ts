import {
  canonicalizeTeamName,
  matchTeamsWithCategoryContext,
  orientedTeamPairHasReserveSuffixConflict,
  refineCategoryCandidates,
} from "@/src/domain/text";
import { getEnv } from "@/src/infra/env";
import type { Pinnacle17Event } from "./types";
import { canonicalCountry } from "@/src/domain/national-teams";
import { hasTeamProviderCountryConflict } from "@/src/domain/team-provider-context";

export type Pinnacle17Match = { event: Pinnacle17Event; score: number; swapped: boolean };
type Pinnacle17RankedCandidate = Pinnacle17Match & { rank: number };

function prematch(event: Pinnacle17Event): boolean {
  return !event.status.isStarted && !event.status.isInProgress && !event.status.isInterrupted;
}

function identityKey(event: Pinnacle17Event): string {
  return [
    event.sport.id,
    event.league.id,
    canonicalCountry(event.league.country ?? ""),
    event.units,
    canonicalizeTeamName(event.homeTeam.name),
    canonicalizeTeamName(event.awayTeam.name),
    event.startTime.slice(0, 16),
  ].join("|");
}

export function rankPinnacle17Candidates(params: {
  events: Pinnacle17Event[];
  home: string;
  away: string;
  kickoffUtc: Date;
  kickoffInferido?: boolean;
  competition?: string | null;
  country?: string | null;
  minScore?: number;
}): Pinnacle17RankedCandidate[] {
  const minScore = params.minScore ?? getEnv().SHARP_AUTO_MATCH_MIN_SCORE;
  const deduped = new Map<string, Pinnacle17Event>();
  for (const event of params.events) {
    // Tennis match identities are published as Sets, while the same event
    // carries prices in both Games and Sets. Daily Total is not a team match.
    const units = canonicalizeTeamName(event.units);
    if (!prematch(event) || (units !== "regular" && !(event.sport.id === 33 && units === "sets"))) continue;
    const key = identityKey(event);
    const previous = deduped.get(key);
    if (!previous || event.id > previous.id) deduped.set(key, event);
  }

  const windowMs = (params.kickoffInferido ? 36 : 12) * 60 * 60_000;
  const ranked: Pinnacle17RankedCandidate[] = [];
  for (const event of deduped.values()) {
    const kickoff = new Date(event.startTime);
    const distance = Math.abs(kickoff.getTime() - params.kickoffUtc.getTime());
    if (Number.isNaN(kickoff.getTime()) || distance > windowMs) continue;
    const matchResult = matchTeamsWithCategoryContext({
      betHome: params.home,
      betAway: params.away,
      fixtureHome: event.homeTeam.name,
      fixtureAway: event.awayTeam.name,
      betLeague: params.competition,
      fixtureLeague: event.league.name,
    });
    if (!matchResult.compatible || !matchResult.anchored) continue;
    if (matchResult.score < minScore) continue;
    const swapped = matchResult.swapped;
    const score = matchResult.score;
    if (orientedTeamPairHasReserveSuffixConflict({
      providerHome: event.homeTeam.name,
      providerAway: event.awayTeam.name,
      localHome: params.home,
      localAway: params.away,
      swapped,
      league: event.league.name,
    })) continue;

    const expectedCompetition = canonicalizeTeamName(params.competition ?? "");
    const actualCompetition = canonicalizeTeamName(event.league.name);
    const competitionBonus = expectedCompetition && actualCompetition &&
      (expectedCompetition.includes(actualCompetition) || actualCompetition.includes(expectedCompetition))
      ? 0.1
      : 0;
    const expectedCountry = canonicalizeTeamName(canonicalCountry(params.country ?? ""));
    const actualCountry = canonicalizeTeamName(canonicalCountry(event.league.country ?? ""));
    if (hasTeamProviderCountryConflict({ expectedCountry: canonicalCountry(params.country ?? ""),
      providerCountry: canonicalCountry(event.league.country ?? "") })) continue;
    const countryBonus = expectedCountry && actualCountry && expectedCountry === actualCountry ? 0.05 : 0;
    ranked.push({
      event,
      score,
      swapped,
      rank: score + competitionBonus + countryBonus - (params.kickoffInferido ? 0 : distance / windowMs * 0.2),
    });
  }
  ranked.sort((a, b) => b.rank - a.rank || b.event.id - a.event.id);
  return refineCategoryCandidates({
    betHome: params.home,
    betAway: params.away,
    betLeague: params.competition,
    betKickoffMs: params.kickoffInferido ? null : params.kickoffUtc.getTime(),
    candidates: ranked,
    fixture: ({ event, swapped }) => ({
      home: event.homeTeam.name, away: event.awayTeam.name, league: event.league.name, country: event.league.country,
      kickoffMs: new Date(event.startTime).getTime(), swapped,
    }),
    collapseDuplicateListings: true,
  });
}

export function findPinnacle17Event(params: {
  events: Pinnacle17Event[];
  home: string;
  away: string;
  kickoffUtc: Date;
  kickoffInferido?: boolean;
  competition?: string | null;
  country?: string | null;
}): Pinnacle17Match | null {
  const ranked = rankPinnacle17Candidates(params);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || (second && best.rank - second.rank < 0.08)) return null;
  return { event: best.event, score: best.score, swapped: best.swapped };
}
