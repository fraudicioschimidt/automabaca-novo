import { spDayKey } from "@/src/domain/dates";
import { canonicalSport, type CanonicalSport } from "@/src/domain/sports/registry";
import {
  splitEventoTeams,
} from "@/src/domain/text";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";
import { geminiGenerateJsonWithSearch } from "@/src/infra/llm/gemini-search";
import { createLogger } from "@/src/infra/logger";
import {
  fetchPinnacle17Events,
  pinnacle17Configured,
} from "@/src/providers/pinnacle17/client";
import { findPinnacle17Event } from "@/src/providers/pinnacle17/feed";
import { pinnacle17SportId } from "@/src/providers/pinnacle17/types";
import { resolveKickoffViaWebSearch, type KickoffWebSearchFn } from "@/src/services/sharp/enrich/resolve-kickoff-web";
import { pinnFixtureLooksWrongSport } from "@/src/services/sharp/enrich/kickoff-schedule";
import type { SportCandidate } from "./types";
import {
  providerTeamCategoryCompatible,
  type SportSearchBet,
} from "./provider-shared";

const log = createLogger("sport-provider-candidates");

/** Esportes fora do Bridge/FS que o Pinnacle17 costuma cobrir. */
const EXTRA_FIXTURE_SPORTS = [
  "Volleyball",
  "Hockey",
  "American Football",
  "Tennis",
  "Baseball",
  "eSports",
] as const satisfies readonly CanonicalSport[];

function fixtureSportsToProbe(
  hints: readonly CanonicalSport[],
  priorCandidates: readonly SportCandidate[],
): CanonicalSport[] {
  const preferred = [...new Set([...priorCandidates.map((c) => c.sport), ...hints, ...EXTRA_FIXTURE_SPORTS])]
    .filter((sport) => sport !== "Soccer" && sport !== "Basketball");
  return ["Soccer", "Basketball", ...preferred.slice(0, 4)];
}

export async function findPinnacle17SportCandidates(params: {
  bet: SportSearchBet;
  hints: readonly CanonicalSport[];
  flashCandidates: readonly SportCandidate[];
}): Promise<SportCandidate[]> {
  if (!pinnacle17Configured()) return [];
  const teams = splitEventoTeams(params.bet.evento);
  if (!teams) return [];
  const sports = fixtureSportsToProbe(params.hints, params.flashCandidates);
  const day = spDayKey(params.bet.data);
  const kickoffForMatch = params.bet.kickoffInferido
    ? new Date(`${day}T15:00:00.000Z`)
    : params.bet.data;
  const results: SportCandidate[] = [];
  const failures: Array<{ error: unknown; sport: CanonicalSport }> = [];
  for (const sport of sports) {
    const sportId = pinnacle17SportId(sport);
    if (!sportId) continue;
    let eventsObserved;
    try {
      eventsObserved = await fetchPinnacle17Events({
        sportId,
        kickoffUtc: kickoffForMatch,
      });
    } catch (error) {
      failures.push({ error, sport });
      if (
        error instanceof CircuitOpenError ||
        (error instanceof Error && error.name === "CircuitOpenError")
      ) {
        break;
      }
      continue;
    }
    const events = eventsObserved?.data;
    if (!events || events.length === 0) continue;
    const found = findPinnacle17Event({
      events,
      home: teams.home,
      away: teams.away,
      kickoffUtc: kickoffForMatch,
      kickoffInferido: params.bet.kickoffInferido,
      competition: params.bet.competicao,
      country: params.bet.pais,
    });
    if (!found) continue;
    if (
      pinnFixtureLooksWrongSport(
        sport,
        found.event.league.name ?? "",
        found.event.homeTeam.name,
        found.event.awayTeam.name,
      )
    ) {
      continue;
    }
    if (
      !providerTeamCategoryCompatible({
        localHome: teams.home,
        localAway: teams.away,
        providerHome: found.event.homeTeam.name,
        providerAway: found.event.awayTeam.name,
        swapped: found.swapped,
        betLeague: params.bet.competicao,
        providerLeague: found.event.league.name,
      })
    ) {
      continue;
    }
    results.push({
      sport,
      confidence: 95,
      source: "PROVIDER",
      provider: "pinnacle17",
      matchId: String(found.event.id),
      home: found.event.homeTeam.name,
      away: found.event.awayTeam.name,
      swapped: found.swapped,
      kickoffIso: found.event.startTime,
      competition: found.event.league.name ?? null,
      strategy: "fixture",
    });
  }
  if (failures.length > 0) {
    log.warn(
      {
        err: failures[0]?.error,
        provider: "pinnacle17",
        sports: failures.map((failure) => failure.sport),
      },
      "fonte indisponível durante resolução de esporte",
    );
  }
  return results;
}

/**
 * Busca web do esporte. `answered` diz se a busca respondeu (achando o jogo
 * ou não): é o que gasta a vez do resolvedor. Cota, 429, trava fechada ou
 * erro não respondem, e a mesma vez fica para a próxima tentativa.
 */
export async function searchWebSportCandidate(
  bet: SportSearchBet,
): Promise<{ answered: boolean; candidate: SportCandidate | null }> {
  let answered = false;
  const search: KickoffWebSearchFn = async (request) => {
    const result = await geminiGenerateJsonWithSearch(request);
    answered = result !== null;
    return result;
  };
  let found;
  try {
    found = await resolveKickoffViaWebSearch({
      evento: bet.evento,
      esporte: "Unknown",
      pais: bet.pais,
      competicao: bet.competicao,
      mercado: bet.mercado,
      selecao: bet.selecao,
      data: bet.data,
      search,
    });
  } catch (error) {
    log.warn(
      { err: error, provider: "web" },
      "fonte indisponível durante resolução de esporte",
    );
    return { answered: false, candidate: null };
  }
  const sport = canonicalSport(found?.sport);
  if (!found || !sport) return { answered, candidate: null };
  return {
    answered,
    candidate: {
      sport,
      // Preserva a confiança grounded observada, sem arredondar para cima:
      // 89,9% não pode virar confirmação automática.
      confidence: Math.max(0, Math.min(100, Math.floor(found.confidence * 100))),
      source: "WEB",
      provider: "web",
      kickoffIso: found.kickoff.toISOString(),
      competition: found.competition,
      country: found.country,
      strategy: "grounded_search",
    },
  };
}
