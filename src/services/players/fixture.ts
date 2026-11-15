import { splitEventoTeams } from "@/src/domain/text";
import { prisma } from "@/src/infra/prisma";
import { spDayKey } from "@/src/domain/dates";
import { getFlashscoreCatalog } from "@/src/providers/flashscore/catalog";
import { flashscoreConfigured } from "@/src/providers/flashscore/client";
import { matchFlashscoreFixture } from "@/src/services/settlement/flashscore/match-identity";
import { linkFlashscoreMatch } from "@/src/services/settlement/bet-result";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { assertBetSettlementTermsTx } from "@/src/services/bets/settle-terms";

/** Auxiliary Flashscore link for player evidence. Pinnacle owns the bet's identity. */
export async function linkPlayerPropFlashscoreFixture(betId: string): Promise<boolean> {
  if (!flashscoreConfigured()) return false;
  const bet = await prisma.bet.findUnique({ where: { id: betId }, include: { playerProp: true, bankroll: true } });
  if (!bet?.playerProp || bet.deletedAt || bet.status !== "PENDING" || bet.esporte !== "Soccer" || bet.bankroll.sharpMode !== "IDENTITY_ONLY") return false;
  const day = spDayKey(bet.data);
  const matches = await getFlashscoreCatalog(day, 1);
  if (!matches) return false;
  const teams = splitEventoTeams(bet.evento);
  if (!teams) return false;
  // As travas da liquidação valem aqui: horário da aposta, categoria pelo nome
  // do tipster e as fichas dos times só como ajuda.
  const fixture = await matchFlashscoreFixture({
    teams, bet, matches, sportId: 1, day,
    loadMatches: (sportId, catalogDay) => getFlashscoreCatalog(catalogDay, sportId),
  });
  if (fixture.kind !== "matched") return false;
  const match = fixture.candidate.match;
  await runSerializableTransaction("player.fixture", async (tx) => {
    await assertBetSettlementTermsTx(tx, { ...bet, playerPropRevision: bet.playerProp?.revision });
    await tx.betPlayerProp.update({ where: { betId }, data: { providerMatchId: match.match_id } });
    await linkFlashscoreMatch(tx, betId, match.match_id);
  });
  return true;
}
