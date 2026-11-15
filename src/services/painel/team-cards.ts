import { canonicalizeTeamName } from "@/src/domain/text-normalization";
import { prisma } from "@/src/infra/prisma";
import type { Prisma } from "@/src/generated/prisma/client";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

/**
 * As fichas de time vistas do painel (Config › Times): o id do FlashScore com
 * os nomes que a Pinnacle17 usou nos jogos pareados e os que os tipsters
 * usaram. Leitura paginada com busca por qualquer nome, e a remoção de um nome
 * de tipster pelo dono.
 */

export const TEAM_CARDS_PAGE_SIZE = 50;

export type TeamCardsQuery = {
  /** Qualquer nome: Pinnacle, FlashScore ou tipster (ou o id do FlashScore). */
  query?: string;
  /** Nome canônico do registro (`Soccer`...); ausente é todos. */
  sport?: string | null;
  offset?: number;
};

export type TeamCardView = {
  id: string;
  sport: string;
  /** O nome da Pinnacle17 do jogo mais recente; sem jogo, o do FlashScore. */
  name: string;
  country: string;
  league: string;
  /** `principal`, `reserva` ou `feminino`. */
  category: string;
  flashscoreTeamId: string;
  flashscoreName: string;
  /** Nomes distintos da Pinnacle17, o mais recente primeiro, com os jogos de cada um. */
  pinnacleNames: Array<{ name: string; games: number }>;
  /** Confirmados primeiro, na ordem em que apareceram. */
  tipsterNames: Array<{ id: string; name: string; confirmed: boolean }>;
};

export type TeamCardsPage = {
  cards: TeamCardView[];
  /** Fichas que a busca encontrou (todas as páginas). */
  total: number;
  /** Onde começa a próxima página; null quando esta é a última. */
  nextOffset: number | null;
  /** Os esportes com ficha, para o filtro (a contagem ignora a busca). */
  sports: Array<{ sport: string; count: number }>;
};

type LatestLeague = { cardId: string; leagueKey: string; pinnacleLeague: string | null; pinnacleCountry: string | null };

function whereOf(query: string, sport: string | null): Prisma.TeamCardWhereInput {
  const where: Prisma.TeamCardWhereInput = sport ? { sport } : {};
  if (!query) return where;
  const text = { contains: query, mode: "insensitive" as const };
  // O nome normalizado acha "Fénix" por "fenix"; o texto cru acha o que a
  // normalização descarta ("FC", pontuação).
  const norm = canonicalizeTeamName(query);
  const byNorm = norm ? [{ nameNorm: { contains: norm } }] : [];
  return {
    ...where,
    OR: [
      { flashscoreName: text },
      { flashscoreTeamId: query },
      { evidence: { some: { OR: [{ pinnacleName: text }, ...byNorm] } } },
      { tipsterNames: { some: { OR: [{ name: text }, ...byNorm] } } },
    ],
  };
}

/** "pais|liga" normalizados, quando a ligação do jogo não guardou a grafia original. */
function splitLeagueKey(key: string): { country: string; league: string } {
  const [country = "", league = ""] = key.split("|");
  return { country, league };
}

export async function listTeamCards(input: TeamCardsQuery = {}): Promise<TeamCardsPage> {
  const query = (input.query ?? "").trim();
  const sport = input.sport || null;
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const where = whereOf(query, sport);
  const [cards, total, sports] = await Promise.all([
    prisma.teamCard.findMany({
      where,
      orderBy: [{ lastSeenAt: "desc" }, { flashscoreName: "asc" }, { id: "asc" }],
      skip: offset,
      take: TEAM_CARDS_PAGE_SIZE,
      select: { id: true, sport: true, flashscoreTeamId: true, flashscoreName: true, country: true, category: true },
    }),
    prisma.teamCard.count({ where }),
    prisma.teamCard.groupBy({ by: ["sport"], _count: { _all: true }, orderBy: { sport: "asc" } }),
  ]);
  const ids = cards.map((card) => card.id);
  const [names, latest, tipsters] = ids.length === 0 ? [[], [], []] : await Promise.all([
    prisma.teamCardEvidence.groupBy({
      by: ["cardId", "pinnacleName"],
      where: { cardId: { in: ids } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.$queryRaw<LatestLeague[]>`
      SELECT DISTINCT ON (e."cardId") e."cardId", e."leagueKey", l."pinnacleLeague", l."pinnacleCountry"
      FROM team_card_evidence e
      LEFT JOIN catalog_game_links l ON l."pinnacleEventId" = e."pinnacleEventId"
      WHERE e."cardId" = ANY(${ids}::text[])
      ORDER BY e."cardId", e."createdAt" DESC, e.id DESC
    `,
    prisma.teamTipsterName.findMany({
      where: { cardId: { in: ids } },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, cardId: true, name: true, status: true },
    }),
  ]);

  const namesByCard = new Map<string, typeof names>();
  for (const row of names) namesByCard.set(row.cardId, [...(namesByCard.get(row.cardId) ?? []), row]);
  const latestByCard = new Map(latest.map((row) => [row.cardId, row]));
  const tipstersByCard = new Map<string, typeof tipsters>();
  for (const row of tipsters) tipstersByCard.set(row.cardId, [...(tipstersByCard.get(row.cardId) ?? []), row]);

  return {
    cards: cards.map((card) => {
      const pinnacleNames = (namesByCard.get(card.id) ?? [])
        .sort((a, b) => (b._max.createdAt?.getTime() ?? 0) - (a._max.createdAt?.getTime() ?? 0) || b._count._all - a._count._all)
        .map((row) => ({ name: row.pinnacleName, games: row._count._all }));
      const league = latestByCard.get(card.id);
      const fromKey = splitLeagueKey(league?.leagueKey ?? "");
      return {
        id: card.id,
        sport: card.sport,
        name: pinnacleNames[0]?.name ?? card.flashscoreName,
        country: league?.pinnacleCountry || card.country || fromKey.country,
        league: league?.pinnacleLeague || fromKey.league,
        category: card.category,
        flashscoreTeamId: card.flashscoreTeamId,
        flashscoreName: card.flashscoreName,
        pinnacleNames,
        tipsterNames: (tipstersByCard.get(card.id) ?? [])
          .map((row) => ({ id: row.id, name: row.name, confirmed: row.status === "confirmed" })),
      };
    }),
    total,
    nextOffset: offset + cards.length < total ? offset + cards.length : null,
    sports: sports.map((row) => ({ sport: row.sport, count: row._count._all })),
  };
}

/**
 * Tira da ficha um nome que o tipster usou. Só a linha do nome sai: se o
 * tipster voltar a usá-lo, ele nasce de novo como pendente.
 */
export async function removeTeamTipsterName(id: string, actor: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.teamTipsterName.findUnique({
      where: { id },
      select: { id: true, cardId: true, sport: true, name: true, status: true, card: { select: { flashscoreTeamId: true, flashscoreName: true } } },
    });
    const { count } = row ? await tx.teamTipsterName.deleteMany({ where: { id } }) : { count: 0 };
    if (!row || count === 0) throw new RecusaDeNegocioError("Esse nome já tinha sido removido da ficha.");
    await tx.auditEvent.create({
      data: {
        actor,
        action: "team_tipster_name.delete",
        resource: "team_tipster_name",
        resourceId: row.id,
        details: {
          cardId: row.cardId,
          sport: row.sport,
          name: row.name,
          status: row.status,
          flashscoreTeamId: row.card.flashscoreTeamId,
          flashscoreName: row.card.flashscoreName,
        },
      },
    });
  });
}
