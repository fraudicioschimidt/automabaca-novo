import { randomUUID } from "node:crypto";
import { canonicalizeTeamName } from "@/src/domain/text";
import type { PrismaClient } from "@/src/generated/prisma/client";
import { canonicalizeFlashscoreTeamName } from "@/src/providers/flashscore/match";

/**
 * Fichas de time e ligações dos catálogos montadas direto no banco, como o
 * pareamento grava: para os testes que leem as fichas sem rodar o pareamento.
 */

type Category = "principal" | "reserva" | "feminino";

export async function seedTeamCard(prisma: PrismaClient, params: {
  sport?: string;
  flashscoreTeamId: string;
  flashscoreName: string;
  country?: string;
  category?: Category;
  /** Nomes da Pinnacle17, cada um em `games` jogos distintos (eventos `ids` ou gerados). */
  pinnacleNames?: Array<{ name: string; games?: number; eventIds?: string[]; category?: Category; leagueKey?: string }>;
  tipsterNames?: Array<{ name: string; status?: "pending" | "confirmed"; firstDay?: string; firstPinnacleEventId?: string }>;
}): Promise<string> {
  const sport = params.sport ?? "Soccer";
  const category = params.category ?? "principal";
  const card = await prisma.teamCard.create({
    data: {
      sport,
      flashscoreTeamId: params.flashscoreTeamId,
      flashscoreName: params.flashscoreName,
      flashscoreNameNorm: canonicalizeFlashscoreTeamName(params.flashscoreName),
      country: params.country ?? "",
      category,
      lastSeenAt: new Date(),
    },
  });
  let order = 0;
  for (const pinnacle of params.pinnacleNames ?? []) {
    const eventIds = pinnacle.eventIds
      ?? Array.from({ length: pinnacle.games ?? 2 }, () => `ev-${randomUUID()}`);
    for (const pinnacleEventId of eventIds) {
      order += 1;
      await prisma.teamCardEvidence.create({
        data: {
          cardId: card.id,
          pinnacleEventId,
          pinnacleName: pinnacle.name,
          nameNorm: canonicalizeTeamName(pinnacle.name),
          category: pinnacle.category ?? category,
          leagueKey: pinnacle.leagueKey ?? "|",
          createdAt: new Date(Date.UTC(2026, 8, 1) + order * 60_000),
        },
      });
    }
  }
  for (const tipster of params.tipsterNames ?? []) {
    await prisma.teamTipsterName.create({
      data: {
        cardId: card.id,
        sport,
        country: card.country,
        category: card.category,
        name: tipster.name,
        nameNorm: canonicalizeTeamName(tipster.name),
        status: tipster.status ?? "confirmed",
        firstBetId: "bet-semente",
        firstPinnacleEventId: tipster.firstPinnacleEventId ?? "ev-semente",
        firstDay: tipster.firstDay ?? "2026-09-01",
        ...(tipster.status === "pending" ? {} : { confirmedAt: new Date(), confirmedByBetId: "bet-semente-2" }),
      },
    });
  }
  return card.id;
}

export async function seedCatalogLink(prisma: PrismaClient, params: {
  sport?: string;
  pinnacleEventId: string;
  flashscoreMatchId: string;
  pinnacleHome: string;
  pinnacleAway: string;
  pinnacleLeague?: string;
  pinnacleCountry?: string;
  flashscoreHome: string;
  flashscoreAway: string;
  flashscoreHomeTeamId: string;
  flashscoreAwayTeamId: string;
  swapped?: boolean;
  status?: "ok" | "conflict";
  kickoff: Date;
}): Promise<void> {
  await prisma.catalogGameLink.create({
    data: {
      sport: params.sport ?? "Soccer",
      pinnacleEventId: params.pinnacleEventId,
      flashscoreMatchId: params.flashscoreMatchId,
      kickoffPinnacle: params.kickoff,
      kickoffFlashscore: params.kickoff,
      pinnacleHome: params.pinnacleHome,
      pinnacleAway: params.pinnacleAway,
      pinnacleLeague: params.pinnacleLeague ?? "Brazil - Serie A",
      pinnacleCountry: params.pinnacleCountry ?? "Brazil",
      flashscoreHome: params.flashscoreHome,
      flashscoreAway: params.flashscoreAway,
      flashscoreHomeTeamId: params.flashscoreHomeTeamId,
      flashscoreAwayTeamId: params.flashscoreAwayTeamId,
      swapped: params.swapped ?? false,
      score: 2,
      status: params.status ?? "ok",
      lastSeenAt: params.kickoff,
      lastPairedAt: params.kickoff,
    },
  });
}
