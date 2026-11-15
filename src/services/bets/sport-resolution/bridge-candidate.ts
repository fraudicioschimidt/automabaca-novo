import { spDayKey } from "@/src/domain/dates";
import { splitEventoTeams } from "@/src/domain/text";
import type { CanonicalSport } from "@/src/domain/sports/registry";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { bridgeConfigured } from "@/src/providers/bridgeodds/client";
import { BRIDGEODDS_REQUEST_COOLDOWN_MS } from "@/src/providers/bridgeodds/limits";
import { findBridgeMatch } from "@/src/providers/bridgeodds/match";
import { bridgeSportFromEsporte } from "@/src/providers/bridgeodds/coverage-contract";
import { parseBridgeLeague } from "@/src/providers/bridgeodds/types";
import { resolveTeamsForProvider } from "@/src/services/teams/resolve";
import { TEAM_PROVIDERS } from "@/src/services/teams/types";
import {
  providerTeamCategoryCompatible,
  type SportSearchBet,
} from "./provider-shared";
import type { SportCandidate, SportSearchOptions } from "./types";

const log = createLogger("sport-provider-candidates");
const BRIDGE_SPORTS = ["Soccer", "Basketball"] as const satisfies readonly CanonicalSport[];

/**
 * A BridgeOdds, que também dá identidade ao enrich, é o último catálogo do
 * resolvedor de modalidade. Sondamos somente futebol/basquete, a cobertura do
 * provider, e reutilizamos o catálogo diário compartilhado.
 */
export async function findBridgeSportCandidates(
  bet: SportSearchBet,
  hints: readonly CanonicalSport[] = [],
  options: SportSearchOptions = {},
): Promise<SportCandidate[]> {
  if (!bridgeConfigured()) return [];
  const teams = splitEventoTeams(bet.evento);
  if (!teams) return [];
  const orderedSports = new Set<CanonicalSport>();
  if (options.bridgeCursor && BRIDGE_SPORTS.includes(options.bridgeCursor.sport as typeof BRIDGE_SPORTS[number])) {
    orderedSports.add(options.bridgeCursor.sport);
  }
  for (const sport of hints) {
    if ((BRIDGE_SPORTS as readonly CanonicalSport[]).includes(sport)) {
      orderedSports.add(sport);
    }
  }
  // Evidência antiga/LLM só ordena a busca. Nunca pode eliminar a outra
  // modalidade: um palpite Soccer errado esconderia um basquete.
  for (const sport of BRIDGE_SPORTS) orderedSports.add(sport);

  const day = spDayKey(bet.data);
  const kickoffForMatch = bet.kickoffInferido
    ? new Date(`${day}T15:00:00.000Z`)
    : bet.data;
  const minScore = getEnv().SHARP_AUTO_MATCH_MIN_SCORE;
  const results: SportCandidate[] = [];
  const failures: Array<{ error: unknown; sport: CanonicalSport }> = [];
  const deadline = Date.now() + 5_000;

  for (const sport of orderedSports) {
    if (Date.now() >= deadline) {
      options.onBridgeDeferred?.({ sport, searchAt: 0 }, new Date(Date.now() + BRIDGEODDS_REQUEST_COOLDOWN_MS));
      break;
    }
    const bridgeSport = bridgeSportFromEsporte(sport);
    if (!bridgeSport) continue;
    try {
      // Nome com mais de uma ficha segue com a grafia original.
      const resolved = await resolveTeamsForProvider(
        teams,
        TEAM_PROVIDERS.BRIDGEODDS,
        { sport, pais: bet.pais, competicao: bet.competicao },
      );
      const found = await findBridgeMatch({
        home: resolved.home,
        away: resolved.away,
        bridgeSport,
        kickoffUtc: kickoffForMatch,
        skipKickoffWindow: Boolean(bet.kickoffInferido),
        competition: bet.competicao, kickoffInferido: Boolean(bet.kickoffInferido),
        maxSearchDurationMs: Math.max(1, deadline - Date.now()),
        ...(options.bridgeCursor?.sport === sport ? { startSearchAt: options.bridgeCursor.searchAt } : {}),
      });
      if (!found.ok && found.reason === "search_budget") {
        options.onBridgeDeferred?.(
          { sport, searchAt: found.nextSearchAt ?? 0 },
          found.retryAt ?? new Date(Date.now() + BRIDGEODDS_REQUEST_COOLDOWN_MS),
        );
        break;
      }
      if (!found.ok || found.best.score < minScore) continue;
      if (
        !providerTeamCategoryCompatible({
          localHome: teams.home,
          localAway: teams.away,
          providerHome: found.best.match.home,
          providerAway: found.best.match.away,
          swapped: found.best.swapped,
          betLeague: bet.competicao,
          providerLeague: found.best.match.league,
        })
      ) {
        continue;
      }
      const league = parseBridgeLeague(found.best.match.league);
      results.push({
        sport,
        confidence: 95,
        source: "PROVIDER",
        provider: "bridgeodds",
        matchId: String(found.best.match.match_id),
        home: found.best.match.home,
        away: found.best.match.away,
        swapped: found.best.swapped,
        kickoffIso: found.best.match.match_date,
        competition: league.competicao,
        country: league.pais,
        strategy: "fixture",
      });
    } catch (error) {
      failures.push({ error, sport });
    }
  }
  if (failures.length > 0) {
    log.warn(
      {
        err: failures[0]?.error,
        provider: "bridgeodds",
        sports: failures.map((failure) => failure.sport),
      },
      "fonte indisponível durante resolução de esporte",
    );
  }
  return results;
}
