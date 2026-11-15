import { canonicalSport } from "@/src/domain/sports/registry";
import { teamAliasNameProblem } from "@/src/domain/team-alias-name";
import { hasTeamProviderCountryConflict } from "@/src/domain/team-provider-context";
import { canonicalizeTeamName } from "@/src/domain/text";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { teamCardCategory } from "./catalog-pairing";
import {
  TEAM_PROVIDERS,
  type ResolvedProviderTeam,
  type ResolvedTeamsForProvider,
  type TeamCardRoute,
  type TeamIdentityContext,
  type TeamProvider,
} from "./types";

/**
 * A tradução do nome da aposta pela ficha do time (`team_cards`): o nome acha
 * a ficha pelo nome de tipster confirmado, pelo nome da Pinnacle17 das
 * evidências ou pelo nome do FlashScore, e a ficha dá o nome do provider.
 *
 * É só pista: nome com mais de uma ficha (depois de filtrar categoria e país)
 * não traduz, e sem ficha o nome segue como veio. Quem decide o jogo é o
 * matcher de cada provider, com as travas dele.
 */

/**
 * O nome da Pinnacle17 só ACHA a ficha com 2 jogos distintos: a ficha nasce de
 * um lado com evidência ≥ 0,85, e um jogo só pode ser a abreviação do
 * FlashScore casando com o time errado.
 */
const MIN_PINNACLE_NAME_GAMES = 2;
const MAX_ALTERNATIVE_NAMES = 3;
const ROUTE_PRIORITY: readonly TeamCardRoute[] = ["tipster_name", "pinnacle_name", "flashscore_name"];

/** Uma ficha achada por um nome, com os nomes que ela traduz. */
export type TeamCardMatch = {
  cardId: string;
  sport: string;
  flashscoreTeamId: string;
  flashscoreName: string;
  country: string;
  category: string;
  /** Nomes da Pinnacle17 com pelo menos 2 jogos, do mais recente ao mais antigo. */
  pinnacleNames: string[];
  /** O nome (normalizado) que achou a ficha, e por qual caminho. */
  nameNorm: string;
  route: TeamCardRoute;
};

type CardRow = {
  id: string;
  sport: string;
  flashscoreTeamId: string;
  flashscoreName: string;
  country: string;
  category: string;
};

/**
 * As fichas que cada nome (normalizado por `canonicalizeTeamName`) acha, no
 * esporte dado ou em todos (`null`), com o mesmo critério nas três rotas. Uma
 * linha por ficha e nome, com o melhor caminho: tipster confirmado, depois
 * Pinnacle17, depois FlashScore.
 */
export async function findTeamCardsByName(
  norms: readonly string[],
  sport: string | null,
): Promise<TeamCardMatch[]> {
  const names = [...new Set(norms.filter(Boolean))];
  if (names.length === 0) return [];
  const sportFilter = sport ? { sport } : {};
  const [tipster, pinnacle, flashscore] = await Promise.all([
    prisma.teamTipsterName.findMany({
      where: { status: "confirmed", nameNorm: { in: names }, ...sportFilter },
      select: { cardId: true, nameNorm: true },
    }),
    prisma.$queryRaw<Array<{ cardId: string; nameNorm: string }>>`
      SELECT e."cardId", e."nameNorm"
      FROM team_card_evidence e
      JOIN team_cards c ON c.id = e."cardId"
      WHERE e."nameNorm" = ANY(${names}::text[]) ${sport ? Prisma.sql`AND c.sport = ${sport}` : Prisma.empty}
      GROUP BY e."cardId", e."nameNorm"
      HAVING count(DISTINCT e."pinnacleEventId") >= ${MIN_PINNACLE_NAME_GAMES}
    `,
    prisma.teamCard.findMany({
      where: { flashscoreNameNorm: { in: names }, ...sportFilter },
      select: { id: true, flashscoreNameNorm: true },
    }),
  ]);
  const hits = new Map<string, { cardId: string; nameNorm: string; route: TeamCardRoute }>();
  const add = (cardId: string, nameNorm: string, route: TeamCardRoute) => {
    const key = `${cardId}\0${nameNorm}`;
    const current = hits.get(key);
    if (!current || ROUTE_PRIORITY.indexOf(route) < ROUTE_PRIORITY.indexOf(current.route)) {
      hits.set(key, { cardId, nameNorm, route });
    }
  };
  for (const row of tipster) add(row.cardId, row.nameNorm, "tipster_name");
  for (const row of pinnacle) add(row.cardId, row.nameNorm, "pinnacle_name");
  for (const row of flashscore) add(row.id, row.flashscoreNameNorm, "flashscore_name");
  if (hits.size === 0) return [];

  // A ficha já achada devolve o nome da Pinnacle17 mais recente, mesmo visto
  // num jogo só: os 2 jogos valem para ACHAR a ficha pelo nome da Pinnacle.
  const cardIds = [...new Set([...hits.values()].map((hit) => hit.cardId))];
  const [cards, pinnacleNames] = await Promise.all([
    prisma.teamCard.findMany({
      where: { id: { in: cardIds } },
      select: { id: true, sport: true, flashscoreTeamId: true, flashscoreName: true, country: true, category: true },
    }),
    prisma.$queryRaw<Array<{ cardId: string; name: string }>>`
      SELECT "cardId", (array_agg("pinnacleName" ORDER BY "createdAt" DESC))[1] AS name
      FROM team_card_evidence
      WHERE "cardId" = ANY(${cardIds}::text[])
      GROUP BY "cardId", "nameNorm"
      ORDER BY max("createdAt") DESC
    `,
  ]);
  const cardById = new Map<string, CardRow>(cards.map((card) => [card.id, card]));
  const namesByCard = new Map<string, string[]>();
  for (const row of pinnacleNames) namesByCard.set(row.cardId, [...(namesByCard.get(row.cardId) ?? []), row.name]);
  return [...hits.values()].flatMap((hit) => {
    const card = cardById.get(hit.cardId);
    return card ? [{
      cardId: card.id,
      sport: card.sport,
      flashscoreTeamId: card.flashscoreTeamId,
      flashscoreName: card.flashscoreName,
      country: card.country,
      category: card.category,
      pinnacleNames: namesByCard.get(card.id) ?? [],
      nameNorm: hit.nameNorm,
      route: hit.route,
    }] : [];
  });
}

/**
 * As fichas que o nome de entrada pode ser, no contexto da aposta: a da
 * categoria que o nome e a competição dizem, e sem país em conflito. Por
 * qualquer rota, o nome passa pela regra de nome do tipster ("Racing",
 * "Inter" e "Sporting" só com país e competição).
 */
export function cardsForName(
  inputName: string,
  matches: readonly TeamCardMatch[],
  context: Pick<TeamIdentityContext, "pais" | "competicao">,
): TeamCardMatch[] {
  const norm = canonicalizeTeamName(inputName);
  if (!norm) return [];
  const category = teamCardCategory(inputName, context.competicao);
  const fitting = matches.filter((match) =>
    match.nameNorm === norm
    && match.category === category
    && !hasTeamProviderCountryConflict({ expectedCountry: context.pais, providerCountry: match.country })
    && teamAliasNameProblem(inputName, {
      country: context.pais,
      competition: context.competicao,
      target: match.pinnacleNames[0] ?? match.flashscoreName,
      author: "tipster",
    }) === null);
  const byCard = new Map<string, TeamCardMatch>();
  for (const match of fitting) {
    const current = byCard.get(match.cardId);
    if (!current || ROUTE_PRIORITY.indexOf(match.route) < ROUTE_PRIORITY.indexOf(current.route)) {
      byCard.set(match.cardId, match);
    }
  }
  return [...byCard.values()];
}

function originalResolution(inputName: string): ResolvedProviderTeam {
  return {
    inputName,
    resolvedName: inputName,
    cardId: null,
    providerTeamId: null,
    strategy: "original",
    alternativeNames: [],
  };
}

function alternativesOf(card: TeamCardMatch, resolvedName: string): string[] {
  const seen = new Set([canonicalizeTeamName(resolvedName)]);
  const names: string[] = [];
  for (const name of [...card.pinnacleNames, card.flashscoreName]) {
    const norm = canonicalizeTeamName(name);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    names.push(name);
    if (names.length === MAX_ALTERNATIVE_NAMES) break;
  }
  return names;
}

function resolveSide(
  inputName: string,
  cards: readonly TeamCardMatch[],
  provider: TeamProvider,
): ResolvedProviderTeam {
  if (cards.length === 0) return originalResolution(inputName);
  const [card] = cards;
  if (cards.length > 1 || !card) return { ...originalResolution(inputName), strategy: "ambiguous" };
  if (provider === TEAM_PROVIDERS.FLASHSCORE) {
    return {
      inputName,
      resolvedName: card.flashscoreName,
      cardId: card.cardId,
      providerTeamId: card.flashscoreTeamId,
      strategy: card.route,
      alternativeNames: alternativesOf(card, card.flashscoreName),
    };
  }
  const pinnacleName = card.pinnacleNames[0];
  if (!pinnacleName) {
    return {
      ...originalResolution(inputName),
      cardId: card.cardId,
      strategy: "card_only",
      alternativeNames: alternativesOf(card, inputName),
    };
  }
  return {
    inputName,
    resolvedName: pinnacleName,
    cardId: card.cardId,
    providerTeamId: null,
    strategy: card.route,
    alternativeNames: alternativesOf(card, pinnacleName),
  };
}

function resolvePair(
  teams: { home: string; away: string },
  matches: readonly TeamCardMatch[],
  provider: TeamProvider,
  context: TeamIdentityContext,
): ResolvedTeamsForProvider {
  let homeResolution = resolveSide(teams.home, cardsForName(teams.home, matches, context), provider);
  let awayResolution = resolveSide(teams.away, cardsForName(teams.away, matches, context), provider);
  if (homeResolution.cardId && homeResolution.cardId === awayResolution.cardId) {
    homeResolution = { ...originalResolution(teams.home), strategy: "ambiguous" };
    awayResolution = { ...originalResolution(teams.away), strategy: "ambiguous" };
  }
  return {
    home: homeResolution.resolvedName,
    away: awayResolution.resolvedName,
    homeResolution,
    awayResolution,
  };
}

/**
 * Os nomes dos dois times em cada provider pedido, pelas fichas, com uma busca
 * só. Pinnacle, Pinnacle17 e BridgeOdds recebem o nome da Pinnacle17 mais
 * recente da ficha; o FlashScore, o nome e o id do time dele. A mesma ficha nos
 * dois lados não é um jogo: nenhum dos dois traduz. Sem esporte conhecido,
 * nada traduz: o mesmo nome é time de esportes diferentes.
 */
export async function resolveTeamsForProviders<const P extends readonly TeamProvider[]>(
  teams: { home: string; away: string },
  providers: P,
  context: TeamIdentityContext,
): Promise<{ [K in keyof P]: ResolvedTeamsForProvider }> {
  const sport = canonicalSport(context.sport);
  const matches = sport
    ? await findTeamCardsByName([canonicalizeTeamName(teams.home), canonicalizeTeamName(teams.away)], sport)
    : [];
  return providers.map((provider) => resolvePair(teams, matches, provider, context)) as { [K in keyof P]: ResolvedTeamsForProvider };
}

/** Os nomes dos dois times num provider (ver `resolveTeamsForProviders`). */
export async function resolveTeamsForProvider(
  teams: { home: string; away: string },
  provider: TeamProvider,
  context: TeamIdentityContext,
): Promise<ResolvedTeamsForProvider> {
  const [resolved] = await resolveTeamsForProviders(teams, [provider], context);
  return resolved;
}
