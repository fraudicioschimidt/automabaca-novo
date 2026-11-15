import { matchTeamSide } from "@/src/domain/settlement/sides";
import { prisma } from "@/src/infra/prisma";
import { getFlashscoreCatalog } from "@/src/providers/flashscore/catalog";
import { flashscoreConfigured } from "@/src/providers/flashscore/client";
import { spDayKey } from "@/src/domain/dates";
import { createLogger } from "@/src/infra/logger";
import { getFlashscorePlayerEvidence } from "@/src/providers/flashscore/player-evidence";
import { normalizeFlashscorePlayers } from "@/src/providers/flashscore/player-stats";
import { mergePlayerAppearances, normalizePlayerAppearances } from "@/src/providers/flashscore/lineups";
import type { PlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { resolvePlayerIdentity } from "./resolve";
import { linkPlayerPropFlashscoreFixture } from "./fixture";
import { settlePersistentPlayerProp } from "@/src/services/settlement/flashscore/player-props";
import { BudgetExhaustedError, ProviderCadenceDeferredError, ProviderRequestError } from "@/src/domain/provider-error";
import { BetSettlementTermsChangedError } from "@/src/services/bets/settle-terms";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";

const log = createLogger("player-props-maintenance");

function reportProviderUnavailable(error: unknown, betId: string): void {
  if (!(error instanceof BudgetExhaustedError || error instanceof CircuitOpenError ||
    error instanceof ProviderRequestError || error instanceof ProviderCadenceDeferredError)) throw error;
  log.warn({ betId, err: error }, "manutenção de jogadores sem provider disponível — próxima rodada retoma");
}

export async function runPlayerPropsMaintenance(now = new Date()) {
  if (!flashscoreConfigured()) return;
  const upcoming = await prisma.betPlayerProp.findMany({
    where: { updatedAt: { lte: new Date(now.getTime() - 15 * 60_000) }, bet: {
      status: "PENDING", deletedAt: null, esporte: "Soccer", bankroll: { sharpMode: "IDENTITY_ONLY" },
      data: { gte: new Date(now.getTime() - 90 * 60_000), lte: new Date(now.getTime() + 90 * 60_000) },
    } }, include: { bet: true }, orderBy: { updatedAt: "asc" }, take: 30,
  });
  for (const prop of upcoming) {
    try {
      if (!prop.providerMatchId && !await linkPlayerPropFlashscoreFixture(prop.betId)) continue;
      const current = await prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: prop.betId }, include: { bet: true } });
      const catalog = await getFlashscoreCatalog(spDayKey(current.bet.data), 1);
      const match = catalog?.find((m) => m.match_id === current.providerMatchId);
      if (!match || match.match_status.is_finished || match.match_status.is_cancelled || match.match_status.is_postponed) continue;
      const data = await getFlashscorePlayerEvidence(match.match_id);
      const appearances = normalizePlayerAppearances(data.lineups, { home: match.home_team.team_id, away: match.away_team.team_id });
      let players = mergePlayerAppearances(normalizeFlashscorePlayers(data.stats), appearances).filter((p) => p.teamId === match.home_team.team_id || p.teamId === match.away_team.team_id);
      const terms = current.terms as unknown as PlayerPropTerms;
      const homeSide = matchTeamSide(match.home_team.name, current.bet.evento);
      if (!homeSide) continue;
      const swapped = homeSide === "away";
      if (terms.time) {
        const side = matchTeamSide(terms.time, current.bet.evento);
        const providerSide = swapped ? side === "home" ? "away" : side === "away" ? "home" : null : side;
        players = providerSide ? players.filter((p) => p.teamId === (providerSide === "home" ? match.home_team.team_id : match.away_team.team_id)) : [];
      }
      const resolved = await resolvePlayerIdentity({ selection: terms.selecaoOriginal, playerName: terms.jogador, matchId: match.match_id, sport: "Soccer", players, appearances, now });
      await prisma.betPlayerProp.updateMany({ where: { betId: current.betId, revision: current.revision, bet: { status: "PENDING", deletedAt: null } }, data: {
        resolutionStatus: resolved.ok ? "MATCHED" : "PENDING",
        evidence: { teams: { home: match.home_team.team_id, away: match.away_team.team_id, swapped }, reason: resolved.ok ? "aguardando_partida" : resolved.reason, candidates: players.map((p) => ({ playerId: p.playerId, nome: p.nome, teamId: p.teamId })) },
        // Curated associations always win over name matching.
        ...(!current.playerIdentityId && resolved.ok ? { playerIdentityId: resolved.identityId } : {}),
      } });
    } catch (error) {
      reportProviderUnavailable(error, prop.betId);
      return;
    }
  }
  const rechecks = await prisma.betPlayerProp.findMany({ where: {
    evidence: { path: ["checked24h"], equals: false },
    bet: { deletedAt: null, data: { lte: new Date(now.getTime() - 26 * 3_600_000), gte: new Date(now.getTime() - 30 * 86_400_000) } },
  }, include: { bet: true }, orderBy: { updatedAt: "asc" }, take: 30 });
  for (const prop of rechecks) {
    try {
      const before = prop.evidence as Record<string, unknown>;
      if (!prop.providerMatchId || typeof before.endedAt !== "string" || now.getTime() - Date.parse(before.endedAt) < 24 * 3_600_000) continue;
      const teams = before.teams as { home: string; away: string; swapped: boolean };
      if (!teams) continue;
      await settlePersistentPlayerProp({ bet: { ...prop.bet, playerPropRevision: prop.revision }, matchId: prop.providerMatchId, homeId: teams.home, awayId: teams.away, swapped: teams.swapped, extraTime: before.extraTime === true, now, recheck: true });
    } catch (error) {
      if (error instanceof BetSettlementTermsChangedError) {
        log.info({ betId: prop.betId }, "aposta alterada durante a rechecagem; demais apostas seguem");
        continue;
      }
      reportProviderUnavailable(error, prop.betId);
      return;
    }
  }
}
