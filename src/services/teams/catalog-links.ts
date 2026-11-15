import { randomUUID } from "node:crypto";
import { teamNameEvidence } from "@/src/domain/text";
import type { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { canonicalizeFlashscoreTeamName } from "@/src/providers/flashscore/match";
import { KICKOFF_WINDOW_MS, type CatalogCardSide, type CatalogPair } from "@/src/services/teams/catalog-pairing";

/**
 * O que o pareamento dos catálogos grava, a ligação do jogo e a ficha do time,
 * e a leitura da ligação usável (`ok` e 1:1) pela liquidação e pelo
 * aprendizado do nome do tipster.
 */

const LINK_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
/** Fichas de antes da coluna `flashscoreNameNorm` preenchidas por rodada. */
const NAME_NORM_BACKFILL_BATCH = 500;
/** Abaixo disto contra todos os nomes que a ficha já tinha, o nome novo vira alerta. */
const NAME_DIVERGENCE_FLOOR = 0.5;
const MOVED_SECONDS = KICKOFF_WINDOW_MS / 1_000;

/** Um evento da Pinnacle17 que a rodada viu na lista do dia, com o horário de agora. */
export type SeenCatalogEvent = { pinnacleEventId: string; kickoffPinnacle: Date };

/** A ficha ganhou um nome da Pinnacle17 que não se parece com nenhum dos que ela já tinha. */
export type CardNameDivergence = {
  cardId: string;
  sport: string;
  flashscoreTeamId: string;
  flashscoreName: string;
  pinnacleName: string;
  previousNames: string[];
  pinnacleEventId: string;
};

export type CatalogWrite = {
  conflicts: number;
  moved: number;
  newCards: number;
  divergences: CardNameDivergence[];
};

/** A linha depois do upsert, com o `status` e o `moved` de antes (nulos no evento novo). */
type LinkRow = {
  status: string;
  flashscoreMatchId: string;
  moved: boolean;
  wasStatus: string | null;
  wasMoved: boolean | null;
};

/**
 * Grava a rodada de um esporte numa transação: as ligações dos pares, o
 * horário dos eventos já ligados que a rodada viu e, dos pares que ficaram
 * `ok` e 1:1, as fichas dos lados bem casados. Repetir a rodada não duplica nada.
 */
export async function saveCatalogRound(params: {
  sport: string;
  pairs: readonly CatalogPair[];
  seen: readonly SeenCatalogEvent[];
  flashscoreKickoffs: ReadonlyMap<string, Date>;
  now: Date;
}): Promise<CatalogWrite> {
  const { sport, now } = params;
  return prisma.$transaction(async (tx) => {
    const write: CatalogWrite = { conflicts: 0, moved: 0, newCards: 0, divergences: [] };
    const kept: CatalogPair[] = [];
    for (const pair of params.pairs) {
      const row = await upsertLink(tx, sport, pair, now);
      if (row.status === "conflict" && row.wasStatus !== "conflict") write.conflicts += 1;
      if (row.moved && !row.wasMoved) write.moved += 1;
      if (row.status === "ok" && row.flashscoreMatchId === pair.match.match_id) kept.push(pair);
    }
    write.moved += await refreshSeenLinks(tx, params.seen, params.pairs, params.flashscoreKickoffs, now);
    const doubled = await doubledMatches(tx, kept.map((pair) => pair.match.match_id));
    for (const pair of kept) {
      if (doubled.has(pair.match.match_id)) continue;
      for (const side of pair.cards) await saveCardSide(tx, sport, String(pair.event.id), side, now, write);
    }
    await fillMissingNameNorms(tx, sport);
    return write;
  }, { maxWait: 10_000, timeout: 60_000 });
}

/**
 * A ligação do par. O jogo do FlashScore nunca é trocado: outro jogo para o
 * mesmo evento vira `conflict`, com o candidato na coluna própria, e aí só o
 * horário da Pinnacle17 e `lastSeenAt` andam. `conflict` não volta a `ok`
 * sozinho.
 */
async function upsertLink(tx: Prisma.TransactionClient, sport: string, pair: CatalogPair, now: Date): Promise<LinkRow> {
  const { event, match } = pair;
  const kickoffPinnacle = new Date(event.startTime);
  const kickoffFlashscore = new Date(match.timestamp * 1_000);
  // `wasStatus`/`wasMoved`: o subselect do RETURNING enxerga a tabela de antes
  // do comando, então são os valores anteriores (nulos no evento novo).
  const [row] = await tx.$queryRaw<LinkRow[]>`
    INSERT INTO catalog_game_links AS l (
      id, sport, "pinnacleEventId", "flashscoreMatchId", "kickoffPinnacle", "kickoffFlashscore",
      "pinnacleHome", "pinnacleAway", "pinnacleLeague", "pinnacleCountry",
      "flashscoreHome", "flashscoreAway", "flashscoreTournament", "flashscoreCountry",
      "flashscoreHomeTeamId", "flashscoreAwayTeamId", swapped, score, "decidedBy", status,
      "firstSeenAt", "lastSeenAt", "lastPairedAt"
    ) VALUES (
      ${randomUUID()}, ${sport}, ${String(event.id)}, ${match.match_id}, ${kickoffPinnacle}, ${kickoffFlashscore},
      ${event.homeTeam.name}, ${event.awayTeam.name}, ${event.league.name}, ${event.league.country ?? ""},
      ${match.home_team.name}, ${match.away_team.name}, ${match.tournament.name ?? ""}, ${match.tournament.countryName ?? ""},
      ${match.home_team.team_id}, ${match.away_team.team_id}, ${pair.swapped}, ${pair.score.toFixed(4)}::numeric,
      'catalog', 'ok', ${now}, ${now}, ${now}
    )
    ON CONFLICT ("pinnacleEventId") DO UPDATE SET
      "lastSeenAt" = EXCLUDED."lastSeenAt",
      "kickoffPinnacle" = EXCLUDED."kickoffPinnacle",
      moved = l.moved
        OR abs(extract(epoch FROM EXCLUDED."kickoffPinnacle" - l."kickoffPinnacle")) > ${MOVED_SECONDS}
        OR (l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId"
          AND abs(extract(epoch FROM EXCLUDED."kickoffFlashscore" - l."kickoffFlashscore")) > ${MOVED_SECONDS}),
      status = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId" THEN l.status ELSE 'conflict' END,
      "conflictFlashscoreMatchId" = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId"
        THEN l."conflictFlashscoreMatchId" ELSE EXCLUDED."flashscoreMatchId" END,
      "lastPairedAt" = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId"
        THEN EXCLUDED."lastPairedAt" ELSE l."lastPairedAt" END,
      "kickoffFlashscore" = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId"
        THEN EXCLUDED."kickoffFlashscore" ELSE l."kickoffFlashscore" END,
      "pinnacleHome" = EXCLUDED."pinnacleHome",
      "pinnacleAway" = EXCLUDED."pinnacleAway",
      "pinnacleLeague" = EXCLUDED."pinnacleLeague",
      "pinnacleCountry" = EXCLUDED."pinnacleCountry",
      -- O mesmo jogo pareado de novo traz o mando e os times de agora: o
      -- FlashScore às vezes inverte o mando depois da primeira rodada.
      swapped = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId" THEN EXCLUDED.swapped ELSE l.swapped END,
      "flashscoreHome" = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId"
        THEN EXCLUDED."flashscoreHome" ELSE l."flashscoreHome" END,
      "flashscoreAway" = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId"
        THEN EXCLUDED."flashscoreAway" ELSE l."flashscoreAway" END,
      "flashscoreHomeTeamId" = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId"
        THEN EXCLUDED."flashscoreHomeTeamId" ELSE l."flashscoreHomeTeamId" END,
      "flashscoreAwayTeamId" = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId"
        THEN EXCLUDED."flashscoreAwayTeamId" ELSE l."flashscoreAwayTeamId" END,
      "flashscoreTournament" = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId"
        THEN EXCLUDED."flashscoreTournament" ELSE l."flashscoreTournament" END,
      "flashscoreCountry" = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId"
        THEN EXCLUDED."flashscoreCountry" ELSE l."flashscoreCountry" END,
      score = CASE WHEN l."flashscoreMatchId" = EXCLUDED."flashscoreMatchId" THEN EXCLUDED.score ELSE l.score END
    RETURNING l.status, l."flashscoreMatchId", l.moved,
      (SELECT status FROM catalog_game_links WHERE "pinnacleEventId" = ${String(event.id)}) AS "wasStatus",
      (SELECT moved FROM catalog_game_links WHERE "pinnacleEventId" = ${String(event.id)}) AS "wasMoved"
  `;
  if (!row) throw new Error(`ligação do evento ${event.id} não gravada`);
  return row;
}

/**
 * Os eventos já ligados que a rodada viu sem parear (começou, nomes, margem ou
 * país mudaram de uma rodada para outra): andam `lastSeenAt` e o horário das
 * duas fontes, sem mexer no par. Devolve quantos passaram a ter mudado mais de
 * 15 min.
 */
async function refreshSeenLinks(
  tx: Prisma.TransactionClient,
  seen: readonly SeenCatalogEvent[],
  pairs: readonly CatalogPair[],
  flashscoreKickoffs: ReadonlyMap<string, Date>,
  now: Date,
): Promise<number> {
  const paired = new Set(pairs.map((pair) => String(pair.event.id)));
  const kickoffs = new Map(seen.filter((event) => !paired.has(event.pinnacleEventId))
    .map((event) => [event.pinnacleEventId, event.kickoffPinnacle]));
  if (kickoffs.size === 0) return 0;
  const links = await tx.catalogGameLink.findMany({
    where: { pinnacleEventId: { in: [...kickoffs.keys()] } },
    select: { pinnacleEventId: true, flashscoreMatchId: true, kickoffPinnacle: true, kickoffFlashscore: true, moved: true },
  });
  const shifted = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) > KICKOFF_WINDOW_MS;
  let newlyMoved = 0;
  for (const link of links) {
    const kickoffPinnacle = kickoffs.get(link.pinnacleEventId) ?? link.kickoffPinnacle;
    const kickoffFlashscore = flashscoreKickoffs.get(link.flashscoreMatchId) ?? link.kickoffFlashscore;
    const moved = link.moved
      || shifted(kickoffPinnacle, link.kickoffPinnacle)
      || shifted(kickoffFlashscore, link.kickoffFlashscore);
    if (moved && !link.moved) newlyMoved += 1;
    await tx.catalogGameLink.update({
      where: { pinnacleEventId: link.pinnacleEventId },
      data: { lastSeenAt: now, kickoffPinnacle, kickoffFlashscore, moved },
    });
  }
  return newlyMoved;
}

/** Os jogos do FlashScore com mais de um evento da Pinnacle17: nenhum dos dois serve de prova de time. */
async function doubledMatches(tx: Prisma.TransactionClient, matchIds: readonly string[]): Promise<Set<string>> {
  if (matchIds.length === 0) return new Set();
  const rows = await tx.$queryRaw<Array<{ flashscoreMatchId: string }>>`
    SELECT "flashscoreMatchId" FROM catalog_game_links
    WHERE "flashscoreMatchId" = ANY(${[...new Set(matchIds)]}::text[])
    GROUP BY "flashscoreMatchId" HAVING count(*) > 1
  `;
  return new Set(rows.map((row) => row.flashscoreMatchId));
}

/**
 * A ficha do lado e a evidência do jogo. O nome do FlashScore é o da última
 * rodada; país e categoria ficam os da primeira. A evidência é uma por evento,
 * e o nome da Pinnacle17 que não se parece com nenhum anterior vira alerta.
 */
async function saveCardSide(
  tx: Prisma.TransactionClient,
  sport: string,
  pinnacleEventId: string,
  side: CatalogCardSide,
  now: Date,
  write: CatalogWrite,
): Promise<void> {
  const [card] = await tx.$queryRaw<Array<{ id: string; inserted: boolean; country: string }>>`
    INSERT INTO team_cards AS c (id, sport, "flashscoreTeamId", "flashscoreName", "flashscoreNameNorm", country, category, "firstSeenAt", "lastSeenAt")
    VALUES (${randomUUID()}, ${sport}, ${side.flashscoreTeamId}, ${side.flashscoreName},
      ${canonicalizeFlashscoreTeamName(side.flashscoreName)}, ${side.country}, ${side.category}, ${now}, ${now})
    ON CONFLICT (sport, "flashscoreTeamId") DO UPDATE SET
      "flashscoreName" = EXCLUDED."flashscoreName",
      "flashscoreNameNorm" = EXCLUDED."flashscoreNameNorm",
      "lastSeenAt" = EXCLUDED."lastSeenAt",
      country = CASE WHEN c.country = '' THEN EXCLUDED.country ELSE c.country END
    RETURNING c.id, (c.xmax = 0) AS inserted, c.country
  `;
  if (!card) throw new Error(`ficha do time ${side.flashscoreTeamId} não gravada`);
  if (card.inserted) write.newCards += 1;
  else if (card.country) await moveTipsterNamesToCardCountry(tx, card.id, card.country);
  const previous = await tx.teamCardEvidence.findMany({
    where: { cardId: card.id },
    distinct: ["nameNorm"],
    select: { pinnacleName: true, nameNorm: true },
  });
  const inserted = await tx.$executeRaw`
    INSERT INTO team_card_evidence (id, "cardId", "pinnacleEventId", "pinnacleName", "nameNorm", category, "leagueKey", "createdAt")
    VALUES (${randomUUID()}, ${card.id}, ${pinnacleEventId}, ${side.pinnacleName}, ${side.pinnacleNameNorm},
      ${side.pinnacleCategory}, ${side.leagueKey}, ${now})
    ON CONFLICT ("cardId", "pinnacleEventId") DO NOTHING
  `;
  const newName = previous.length > 0 && !previous.some((row) => row.nameNorm === side.pinnacleNameNorm);
  if (inserted === 0 || !newName) return;
  if (previous.some((row) => teamNameEvidence(row.pinnacleName, side.pinnacleName) >= NAME_DIVERGENCE_FLOOR)) return;
  write.divergences.push({
    cardId: card.id,
    sport,
    flashscoreTeamId: side.flashscoreTeamId,
    flashscoreName: side.flashscoreName,
    pinnacleName: side.pinnacleName,
    previousNames: previous.map((row) => row.pinnacleName),
    pinnacleEventId,
  });
}

/**
 * Os nomes do tipster copiam o país da ficha, que é o escopo do nome
 * confirmado. A ficha nascida numa competição continental ganha o país depois:
 * os nomes já gravados vão junto. O confirmado que outra ficha já tem
 * confirmado no país novo volta a pendente (uma ficha por nome confirmado), com
 * registro na trilha.
 */
async function moveTipsterNamesToCardCountry(tx: Prisma.TransactionClient, cardId: string, country: string): Promise<void> {
  const demoted = await tx.$queryRaw<Array<{ name: string; nameNorm: string; confirmedCardId: string }>>`
    UPDATE team_tipster_names n
    SET country = ${country}, status = 'pending', "confirmedAt" = NULL, "confirmedByBetId" = NULL
    FROM team_tipster_names o
    WHERE n."cardId" = ${cardId} AND n.country <> ${country} AND n.status = 'confirmed'
      AND o."cardId" <> n."cardId" AND o.status = 'confirmed' AND o.sport = n.sport AND o.country = ${country}
      AND o.category = n.category AND o."nameNorm" = n."nameNorm"
    RETURNING n.name, n."nameNorm", o."cardId" AS "confirmedCardId"
  `;
  await tx.teamTipsterName.updateMany({ where: { cardId, country: { not: country } }, data: { country } });
  if (demoted.length === 0) return;
  await tx.auditEvent.createMany({
    data: demoted.map((row) => ({
      action: "team_tipster_name.conflict",
      resource: "team_card",
      resourceId: cardId,
      details: { ...row, country, motivo: "a ficha ganhou o país e o nome já era confirmado de outra ficha nele" },
    })),
  });
}

/**
 * O nome do FlashScore normalizado das fichas gravadas antes da coluna existir:
 * a normalização é a do código (`canonicalizeFlashscoreTeamName`), não dá para
 * fazer em SQL. Um lote por rodada até acabar.
 */
async function fillMissingNameNorms(tx: Prisma.TransactionClient, sport: string): Promise<void> {
  const cards = await tx.teamCard.findMany({
    where: { sport, flashscoreNameNorm: "" },
    select: { id: true, flashscoreName: true },
    take: NAME_NORM_BACKFILL_BATCH,
  });
  for (const card of cards) {
    const norm = canonicalizeFlashscoreTeamName(card.flashscoreName);
    if (norm) await tx.teamCard.update({ where: { id: card.id }, data: { flashscoreNameNorm: norm } });
  }
}

/** A ligação que a aposta pode usar: o jogo do FlashScore e a orientação. */
export type UsableCatalogLink = {
  sport: string;
  flashscoreMatchId: string;
  pinnacleHome: string;
  pinnacleAway: string;
  pinnacleLeague: string;
  pinnacleCountry: string;
  flashscoreHomeTeamId: string;
  flashscoreAwayTeamId: string;
  /** O mandante da Pinnacle17 é o visitante do FlashScore. */
  swapped: boolean;
};

/**
 * A ligação do evento da Pinnacle17 (o `match_id` da BridgeOdds é o mesmo id),
 * só quando ela vale: `ok` e sem outro evento no mesmo jogo do FlashScore
 * (listagem em dobro, rodada dupla, id republicado). Null no resto: quem lê
 * segue sem ela, como antes do pareamento.
 */
export async function findUsableCatalogLink(
  pinnacleEventId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<UsableCatalogLink | null> {
  const [link] = await db.$queryRaw<UsableCatalogLink[]>`
    SELECT l.sport, l."flashscoreMatchId", l."pinnacleHome", l."pinnacleAway", l."pinnacleLeague",
      l."pinnacleCountry", l."flashscoreHomeTeamId", l."flashscoreAwayTeamId", l.swapped
    FROM catalog_game_links l
    WHERE l."pinnacleEventId" = ${pinnacleEventId} AND l.status = 'ok'
      AND NOT EXISTS (
        SELECT 1 FROM catalog_game_links o WHERE o."flashscoreMatchId" = l."flashscoreMatchId" AND o.id <> l.id
      )
  `;
  return link ?? null;
}

/** O dia no resumo: jogos ligados 1:1 e as fichas, as de sempre e as novas. */
export type CatalogDaySummary = { linkedGames: number; teamCards: number; newTeamCards: number };

/**
 * Jogos do dia (pelo início na Pinnacle17) ligados e usáveis: `ok` e sem outro
 * evento no mesmo jogo do FlashScore; o dobro é descartado aqui, na leitura.
 * Fichas pela primeira vez que o time foi visto.
 */
export async function readCatalogDay(day: { start: Date; end: Date }, db: Prisma.TransactionClient = prisma): Promise<CatalogDaySummary> {
  const [links] = await db.$queryRaw<Array<{ linked: number }>>`
    SELECT count(*)::int AS linked
    FROM catalog_game_links l
    WHERE l.status = 'ok' AND l."kickoffPinnacle" >= ${day.start} AND l."kickoffPinnacle" < ${day.end}
      AND NOT EXISTS (
        SELECT 1 FROM catalog_game_links o WHERE o."flashscoreMatchId" = l."flashscoreMatchId" AND o.id <> l.id
      )
  `;
  const [cards] = await db.$queryRaw<Array<{ total: number; fresh: number }>>`
    SELECT count(*) FILTER (WHERE "firstSeenAt" < ${day.end})::int AS total,
      count(*) FILTER (WHERE "firstSeenAt" >= ${day.start} AND "firstSeenAt" < ${day.end})::int AS fresh
    FROM team_cards
  `;
  return { linkedGames: links?.linked ?? 0, teamCards: cards?.total ?? 0, newTeamCards: cards?.fresh ?? 0 };
}

/** Retenção: a ligação sai 90 dias depois do jogo; fichas e evidências ficam. */
export async function purgeOldCatalogGameLinks(now = new Date()): Promise<number> {
  const result = await prisma.catalogGameLink.deleteMany({
    where: { kickoffPinnacle: { lt: new Date(now.getTime() - LINK_RETENTION_DAYS * DAY_MS) } },
  });
  return result.count;
}
