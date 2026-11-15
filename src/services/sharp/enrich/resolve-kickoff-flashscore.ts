import { prisma } from "@/src/infra/prisma";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { lockActiveEnrichBet } from "./write-guard";
import { spDayKey } from "@/src/domain/dates";
import { canonicalSport } from "@/src/domain/sports/registry";
import { splitEventoTeams } from "@/src/domain/text";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { FLASHSCORE_SPORTS, flashscoreSportId } from "@/src/providers/flashscore/sports";
import { flashscoreConfigured } from "@/src/providers/flashscore/client";
import { getFlashscoreCatalog } from "@/src/providers/flashscore/catalog";
import type { FindFlashscoreMatchResult } from "@/src/providers/flashscore/match";
import { deferFlashscoreWork } from "@/src/providers/flashscore/breaker-gate";
import { resolveTeamsForProvider } from "@/src/services/teams/resolve";
import { TEAM_PROVIDERS } from "@/src/services/teams/types";
import { linkFlashscoreMatch } from "@/src/services/settlement/bet-result";
import {
  expectedFlashscoreTeamIds,
  findFlashscoreCandidateWithAdjacentDays,
  flashscoreSearchAlternatives,
  flashscoreKickoffFitsBet,
} from "@/src/services/settlement/flashscore/match-identity";
import { providerTeamCategoryCompatible } from "@/src/services/bets/sport-resolution/provider-shared";
import { acceptScheduleKickoff, provisionalScheduleAnchor } from "./kickoff-schedule";
import type { EnrichDeps } from "./continuation";

const log = createLogger("kickoff-flashscore");

export type FlashscoreKickoffResolution = {
  kickoff: Date;
  sport: string | null;
  /** 0..1, como no resolvedor de esporte: id do provider 1, nomes 0,95. */
  confidence: number;
  country: string | null;
  competition: string | null;
  matchId: string;
};

export type ResolveKickoffViaFlashscoreParams = {
  evento: string;
  esporte: string;
  pais?: string;
  competicao?: string;
  data: Date;
};

function sportsToProbe(esporte: string): Array<{ sport: string; sportId: number }> {
  const id = flashscoreSportId(esporte);
  const canon = canonicalSport(esporte);
  if (id != null && canon) {
    return [{ sport: canon, sportId: id }];
  }
  // Unknown / fora do mapa: sonda os 5 esportes do catálogo (igual sport_resolve).
  return FLASHSCORE_SPORTS.map((item) => ({ sport: item.sport, sportId: item.sportId }));
}

/**
 * O confronto da aposta no catálogo FlashScore de um esporte. As fichas dos
 * times só ajudam: nome ambíguo segue com a grafia original, e o id do time só
 * vale na categoria da aposta.
 */
async function searchFlashscoreFixture(params: {
  teams: { home: string; away: string };
  sport: string;
  sportId: number;
  day: string;
  bet: ResolveKickoffViaFlashscoreParams;
  kickoffUtc: Date;
  kickoffInferido: boolean;
  minScore: number;
}): Promise<Extract<FindFlashscoreMatchResult, { ok: true }> | null> {
  const competicao = params.bet.competicao ?? "";
  const resolved = await resolveTeamsForProvider(params.teams, TEAM_PROVIDERS.FLASHSCORE, {
    sport: params.sport,
    pais: params.bet.pais ?? "",
    competicao,
  });
  const matches = await getFlashscoreCatalog(params.day, params.sportId);
  if (!matches) return null;
  const found = await findFlashscoreCandidateWithAdjacentDays({
    matches,
    home: resolved.home,
    away: resolved.away,
    kickoffUtc: params.kickoffUtc,
    kickoffInferido: params.kickoffInferido,
    minScore: params.minScore,
    expectedTeamIds: expectedFlashscoreTeamIds({ teams: params.teams, resolved, competicao }),
    competition: competicao,
    alternatives: flashscoreSearchAlternatives(params.teams, resolved),
    sportId: params.sportId,
    day: params.day,
    loadMatches: (candidateSportId, candidateDay) =>
      getFlashscoreCatalog(candidateDay, candidateSportId),
  });
  if (!found.ok) return null;
  const match = found.best.match;
  const compatible = providerTeamCategoryCompatible({
    localHome: params.teams.home,
    localAway: params.teams.away,
    providerHome: match.home_team.name,
    providerAway: match.away_team.name,
    swapped: found.best.swapped,
    betLeague: competicao,
    providerLeague: "tournament" in match ? match.tournament.name : null,
  });
  return compatible ? found : null;
}

/**
 * Kickoff provisório via catálogo FlashScore (day ±1). Sem horário no post, o
 * dia é só âncora: a busca vai até 36 h do meio do dia e o horário da partida
 * achada passa a ser o da aposta, com o vínculo junto (`applyKickoffCorrection`).
 * Por isso aqui não há a trava de 3 h do horário real; quem limita o horário é
 * `acceptScheduleKickoff`.
 * Null = off, times ilegíveis, miss ou horário rejeitado.
 */
export async function resolveKickoffViaFlashscoreSchedule(
  bet: ResolveKickoffViaFlashscoreParams,
): Promise<FlashscoreKickoffResolution | null> {
  if (!flashscoreConfigured()) return null;
  // Circuito aberto: o enrich segue com os outros provedores e o `sharp.revive`
  // (a cada 5 min) repesca o vínculo — sondar 5 esportes × 3 dias aqui seria o
  // maior fan-out por aposta.
  if (await deferFlashscoreWork("enrich")) return null;
  const teams = splitEventoTeams(bet.evento);
  if (!teams) return null;

  const day = spDayKey(bet.data);
  const kickoffForMatch = provisionalScheduleAnchor(bet.data);
  const minScore = getEnv().SHARP_AUTO_MATCH_MIN_SCORE;
  const probes = sportsToProbe(bet.esporte);

  for (const { sport, sportId } of probes) {
    try {
      const found = await searchFlashscoreFixture({
        teams, sport, sportId, day, bet, kickoffUtc: kickoffForMatch, kickoffInferido: true, minScore,
      });
      if (!found) continue;
      const kickoff = new Date(found.best.match.timestamp * 1_000);
      const accepted = acceptScheduleKickoff(kickoff, bet.data);
      if (!accepted.ok) {
        log.info(
          { evento: bet.evento, sport, reason: accepted.reason },
          "calendário FlashScore: kickoff rejeitado",
        );
        continue;
      }
      const match = found.best.match;
      const matchId = match.match_id ?? (match as { id?: string }).id;
      const tournament = "tournament" in match ? match.tournament : null;
      const sportChanged =
        !canonicalSport(bet.esporte) ||
        sport.toLowerCase() !== bet.esporte.trim().toLowerCase();
      log.info(
        {
          evento: bet.evento,
          sport,
          kickoff: kickoff.toISOString(),
          strategy: found.best.strategy,
          matchId,
        },
        "kickoff inferido corrigido via calendário FlashScore",
      );
      return {
        kickoff,
        sport: sportChanged ? sport : null,
        confidence: found.best.strategy === "provider_id" ? 1 : 0.95,
        country: tournament?.countryName ?? null,
        competition: tournament?.name ?? null,
        matchId,
      };
    } catch (error) {
      log.warn(
        { err: error, evento: bet.evento, sport },
        "calendário FlashScore: falha ao consultar",
      );
    }
  }
  return null;
}

/**
 * O matchId do FlashScore para a aposta com horário real, sob a trava de
 * horário da liquidação (`flashscoreKickoffFitsBet`): a partida a mais de 3 h
 * é outro jogo, ou a aposta guarda um horário velho, e a liquidação recusaria
 * o vínculo. Vinculada, ela ainda prenderia a aposta na fila de 10 min dos
 * jogos já casados. Null também quando o FlashScore está desligado, os times
 * são ilegíveis ou a partida não aparece.
 */
export async function findFlashscoreMatchIdForBet(
  bet: ResolveKickoffViaFlashscoreParams,
): Promise<string | null> {
  if (!flashscoreConfigured()) return null;
  if (await deferFlashscoreWork("enrich")) return null;
  const teams = splitEventoTeams(bet.evento);
  if (!teams) return null;

  const day = spDayKey(bet.data);
  const minScore = getEnv().SHARP_AUTO_MATCH_MIN_SCORE;
  const probes = sportsToProbe(bet.esporte);

  for (const { sport, sportId } of probes) {
    try {
      const found = await searchFlashscoreFixture({
        teams, sport, sportId, day, bet, kickoffUtc: bet.data, kickoffInferido: false, minScore,
      });
      if (!found) continue;
      const match = found.best.match;
      if (!flashscoreKickoffFitsBet(match, bet.data)) {
        log.info(
          {
            evento: bet.evento,
            sport,
            matchId: match.match_id,
            betKickoff: bet.data.toISOString(),
            matchKickoff: new Date(match.timestamp * 1_000).toISOString(),
          },
          "FlashScore find match ID: partida a mais de 3 h do horário da aposta — sem vínculo",
        );
        continue;
      }
      return match.match_id ?? (match as { id?: string }).id;
    } catch (error) {
      log.warn(
        { err: error, evento: bet.evento, sport },
        "FlashScore find match ID: falha ao consultar",
      );
    }
  }
  return null;
}

/**
 * Vinculação precoce do FlashScore Match ID em bet_result.
 * Consulta o catálogo e persiste quando a aposta ainda não tem matchId. Só com
 * horário real; com o inferido, o calendário (`resolveKickoffViaFlashscoreSchedule`)
 * acha o horário e vincula junto.
 */
export async function linkEarlyFlashscoreMatch(
  bet: {
    id: string;
    evento: string;
    esporte: string;
    pais: string;
    competicao: string;
    data: Date;
    kickoffInferido: boolean;
  },
  deps: EnrichDeps = {},
): Promise<void> {
  if (!flashscoreConfigured() || bet.kickoffInferido) return;
  if (await deferFlashscoreWork("enrich")) return;
  try {
    const original = await prisma.bet.findUnique({
      where: { id: bet.id }, select: { manualSettlementVersion: true, deletedAt: true,
        sharp: { select: { identityStatus: true, provider: true, providerMatchId: true } },
      },
    });
    if (!original || original.deletedAt) return;
    const result = await prisma.betResult.findUnique({
      where: { betId: bet.id },
      select: { resultMatchId: true },
    });
    if (!result?.resultMatchId) {
      const findFs = deps.findFlashscoreMatchId ?? findFlashscoreMatchIdForBet;
      const fsMatchId = await findFs({
        evento: bet.evento,
        esporte: bet.esporte,
        pais: bet.pais,
        competicao: bet.competicao,
        data: bet.data,
      });
      if (fsMatchId) {
        const linked = await runSerializableTransaction("enrich.linkFlashscore", async (tx) => {
          await lockActiveEnrichBet(tx, bet.id);
          const current = await tx.bet.findUniqueOrThrow({ where: { id: bet.id }, select: {
            evento: true, esporte: true, pais: true, competicao: true, data: true,
            kickoffInferido: true, manualSettlementVersion: true,
            sharp: { select: { identityStatus: true, provider: true, providerMatchId: true } },
          } });
          if (current.sharp?.identityStatus !== original.sharp?.identityStatus ||
            current.sharp?.provider !== original.sharp?.provider || current.sharp?.providerMatchId !== original.sharp?.providerMatchId ||
            current.manualSettlementVersion !== original.manualSettlementVersion ||
            current.evento !== bet.evento || current.esporte !== bet.esporte ||
            current.pais !== bet.pais || current.competicao !== bet.competicao ||
            current.data.getTime() !== bet.data.getTime() || current.kickoffInferido) return false;
          const latest = await tx.betResult.findUnique({ where: { betId: bet.id }, select: { resultMatchId: true } });
          if (latest?.resultMatchId) return false;
          await linkFlashscoreMatch(tx, bet.id, fsMatchId);
          return true;
        });
        if (!linked) return;
        log.info(
          { betId: bet.id, matchId: fsMatchId },
          "FlashScore Match ID vinculado precocemente no enrich",
        );
      }
    }
  } catch (err) {
    log.warn({ err, betId: bet.id }, "falha ao vincular precocemente FlashScore Match ID");
  }
}
