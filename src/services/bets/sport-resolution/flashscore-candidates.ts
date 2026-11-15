import { spDayKey } from "@/src/domain/dates";
import type { CanonicalSport } from "@/src/domain/sports/registry";
import { splitEventoTeams } from "@/src/domain/text";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { FLASHSCORE_CANONICAL_SPORTS } from "@/src/providers/flashscore/sports";
import { flashscoreConfigured } from "@/src/providers/flashscore/client";
import { getFlashscoreCatalog } from "@/src/providers/flashscore/catalog";
import {
  expectedFlashscoreTeamIds,
  findFlashscoreCandidateWithAdjacentDays,
  flashscoreSearchAlternatives,
} from "@/src/services/settlement/flashscore/match-identity";
import { resolveTeamsForProvider } from "@/src/services/teams/resolve";
import { TEAM_PROVIDERS } from "@/src/services/teams/types";
import type { SportCandidate } from "./types";
import { flashscoreDateRetryAt } from "@/src/providers/flashscore/date-window";
import {
  providerTeamCategoryCompatible,
  type SportSearchBet,
} from "./provider-shared";

const log = createLogger("sport-provider-candidates");
const FLASHSCORE_SPORTS_PROVAVEIS = [
  "Soccer",
  "Basketball",
  "Tennis",
  "Hockey",
  "Baseball",
  "Volleyball",
] as const satisfies readonly CanonicalSport[];
const FLASHSCORE_MAX_SONDAS = 8;
const FLASHSCORE_SONDAS_SIMULTANEAS = 3;

function flashscoreSportsToProbe(
  hints: readonly CanonicalSport[],
): Array<{ sport: CanonicalSport; sportId: number }> {
  const porEsporte = new Map(
    FLASHSCORE_CANONICAL_SPORTS.map((item) => [item.sport, item.sportId] as const),
  );
  const ordenados = new Set<CanonicalSport>([
    ...hints,
    ...FLASHSCORE_SPORTS_PROVAVEIS,
  ]);
  return [...ordenados]
    .flatMap((sport) => {
      const sportId = porEsporte.get(sport);
      return sportId === undefined ? [] : [{ sport, sportId }];
    })
    .slice(0, FLASHSCORE_MAX_SONDAS);
}

export async function findFlashscoreSportCandidates(
  bet: SportSearchBet,
  hints: readonly CanonicalSport[] = [],
  now = new Date(),
): Promise<SportCandidate[]> {
  if (!flashscoreConfigured()) return [];
  const teams = splitEventoTeams(bet.evento);
  if (!teams) return [];
  const day = spDayKey(bet.data);
  if (flashscoreDateRetryAt(day, now)) return [];
  const kickoffForMatch = bet.kickoffInferido
    ? new Date(`${day}T15:00:00.000Z`)
    : bet.data;
  const minScore = getEnv().SHARP_AUTO_MATCH_MIN_SCORE;
  const failures: Array<{ error: unknown; sport: CanonicalSport }> = [];

  const sportsToProbe = flashscoreSportsToProbe(hints);
  const results: SportCandidate[] = [];

  for (let i = 0; i < sportsToProbe.length; i += FLASHSCORE_SONDAS_SIMULTANEAS) {
    const batch = sportsToProbe.slice(i, i + FLASHSCORE_SONDAS_SIMULTANEAS);
    const batchResults = await Promise.all(
      batch.map(async ({ sport, sportId }) => {
        try {
          // As fichas só ajudam: nome ambíguo segue com a grafia original, e
          // o id do time só vale na categoria da aposta.
          const resolved = await resolveTeamsForProvider(
            teams,
            TEAM_PROVIDERS.FLASHSCORE,
            { sport, pais: bet.pais, competicao: bet.competicao },
          );
          const matches = await getFlashscoreCatalog(day, sportId);
          if (!matches) return null;
          const found = await findFlashscoreCandidateWithAdjacentDays({
            matches,
            home: resolved.home,
            away: resolved.away,
            kickoffUtc: kickoffForMatch,
            kickoffInferido: bet.kickoffInferido,
            minScore,
            expectedTeamIds: expectedFlashscoreTeamIds({ teams, resolved, competicao: bet.competicao }),
            competition: bet.competicao,
            alternatives: flashscoreSearchAlternatives(teams, resolved),
            sportId,
            day,
            loadMatches: (candidateSportId, candidateDay) =>
              getFlashscoreCatalog(candidateDay, candidateSportId),
          });
          if (!found.ok) return null;
          const providerHome = found.best.match.home_team.name;
          const providerAway = found.best.match.away_team.name;
          const tournament = "tournament" in found.best.match ? found.best.match.tournament : null;
          if (!providerTeamCategoryCompatible({
            localHome: teams.home,
            localAway: teams.away,
            providerHome,
            providerAway,
            swapped: found.best.swapped,
            betLeague: bet.competicao,
            providerLeague: tournament?.name,
          })) return null;
          return {
            sport,
            confidence: found.best.strategy === "provider_id" ? 100 : 95,
            source: found.best.strategy === "provider_id" ? "TEAM_ID" : "PROVIDER",
            provider: "flashscore",
            matchId: found.best.match.match_id,
            home: providerHome,
            away: providerAway,
            homeTeamId: found.best.match.home_team.team_id,
            awayTeamId: found.best.match.away_team.team_id,
            swapped: found.best.swapped,
            kickoffIso: new Date(found.best.match.timestamp * 1_000).toISOString(),
            competition: tournament?.name ?? null,
            country: tournament?.countryName ?? null,
            strategy: found.best.strategy,
          } satisfies SportCandidate;
        } catch (error) {
          failures.push({ error, sport });
          return null;
        }
      }),
    );

    for (const item of batchResults) {
      if (item) results.push(item);
    }

    // Early exit: se encontrou candidato de alta confiança inequívoco sem conflito neste lote
    const definitive = results.filter((c) => c.confidence >= 95);
    const distinctSports = new Set(definitive.map((c) => c.sport));
    if (definitive.length > 0 && distinctSports.size === 1) {
      const best = definitive[0];
      if (best?.strategy === "provider_id" || hints.includes(best?.sport as CanonicalSport)) {
        break;
      }
    }
  }

  if (failures.length > 0) {
    log.warn(
      { err: failures[0]?.error, provider: "flashscore", sports: failures.map(({ sport }) => sport) },
      "fonte indisponível durante resolução de esporte",
    );
  }
  return results;
}
