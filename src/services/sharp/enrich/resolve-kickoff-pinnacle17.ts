import { canonicalSport } from "@/src/domain/sports/registry";
import { splitEventoTeams } from "@/src/domain/text";
import { createLogger } from "@/src/infra/logger";
import { findPinnacle17Event } from "@/src/providers/pinnacle17/feed";
import { fetchPinnacle17Events, pinnacle17Configured } from "@/src/providers/pinnacle17/client";
import { pinnacle17SportId } from "@/src/providers/pinnacle17/types";
import { providerTeamCategoryCompatible } from "@/src/services/bets/sport-resolution/provider-shared";
import {
  acceptScheduleKickoff,
  pinnFixtureLooksWrongSport,
  provisionalScheduleAnchor,
} from "./kickoff-schedule";

const log = createLogger("kickoff-catalog");

export type CatalogKickoffResolution = {
  kickoff: Date;
  sport: string | null;
  country: string | null;
  competition: string | null;
  source: "pinnacle17";
};

export type ResolveKickoffCatalogParams = {
  evento: string;
  esporte: string;
  pais?: string;
  competicao?: string;
  data: Date;
};

/** Kickoff via feed Pinnacle17 (budget). Guarda modalidade errada (ex.: VB→handball). */
export async function resolveKickoffViaPinnacle17Schedule(
  bet: ResolveKickoffCatalogParams,
): Promise<CatalogKickoffResolution | null> {
  if (!pinnacle17Configured()) return null;
  const sport = canonicalSport(bet.esporte);
  if (!sport) return null;
  const teams = splitEventoTeams(bet.evento);
  if (!teams) return null;

  try {
    const sportId = pinnacle17SportId(sport);
    if (sportId === null) return null;
    const kickoffForMatch = provisionalScheduleAnchor(bet.data);
    const observed = await fetchPinnacle17Events({ sportId, kickoffUtc: kickoffForMatch });
    if (!observed) return null;
    const found = findPinnacle17Event({
      events: observed.data,
      home: teams.home,
      away: teams.away,
      kickoffUtc: kickoffForMatch,
      kickoffInferido: true,
      competition: bet.competicao,
      country: bet.pais,
    });
    if (!found) return null;
    if (
      pinnFixtureLooksWrongSport(
        sport,
        found.event.league.name ?? "",
        found.event.homeTeam.name,
        found.event.awayTeam.name,
      )
    ) {
      log.info(
        {
          evento: bet.evento,
          league: found.event.league.name,
          home: found.event.homeTeam.name,
          away: found.event.awayTeam.name,
        },
        "calendário Pinnacle17: fixture rejeitada (modalidade incompatível)",
      );
      return null;
    }
    if (
      !providerTeamCategoryCompatible({
        localHome: teams.home,
        localAway: teams.away,
        providerHome: found.event.homeTeam.name,
        providerAway: found.event.awayTeam.name,
        swapped: found.swapped,
      })
    ) {
      return null;
    }
    const kickoff = new Date(found.event.startTime);
    const accepted = acceptScheduleKickoff(kickoff, bet.data);
    if (!accepted.ok) {
      log.info(
        { evento: bet.evento, reason: accepted.reason },
        "calendário Pinnacle17: kickoff rejeitado",
      );
      return null;
    }
    log.info(
      { evento: bet.evento, kickoff: kickoff.toISOString(), league: found.event.league.name },
      "kickoff inferido corrigido via calendário Pinnacle17",
    );
    return {
      kickoff,
      sport: null,
      country: null,
      competition: found.event.league.name ?? null,
      source: "pinnacle17",
    };
  } catch (error) {
    log.warn({ err: error, evento: bet.evento }, "calendário Pinnacle17: falha");
    return null;
  }
}
