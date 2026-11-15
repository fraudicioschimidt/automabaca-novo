import "server-only";
import { toNumber } from "@/src/domain/money";
import { spDayKey } from "@/src/domain/dates";
import { analyzerDateFilter } from "@/src/domain/analyzer-query";
import { FINAL_BET_STATUSES } from "@/src/domain/bet-status";
import { prisma } from "@/src/infra/prisma";
import { Prisma } from "@/src/generated/prisma/client";
import { ACTIVE_OPERATIONAL_ACTION_STATUSES } from "@/src/domain/operational-action-status";
import { reliableClvSql } from "@/src/services/sharp/closing-evidence";

/** Números "de hoje" (fuso SP) para o card de resumo do dashboard. */
export type ResumoHoje = {
  /** Reais, com cada resultado arredondado como no extrato. */
  lucroDia: number;
  resolvidasHoje: number;
  tipsNovas: number;
  aResolver: number;
};

/** Números "de hoje" (fuso SP) para o card de resumo do dashboard. */
export async function getResumoHoje(now: Date = new Date(), client: Prisma.TransactionClient = prisma): Promise<ResumoHoje> {
  const { gte: inicio, lt: fim } = analyzerDateFilter("hoje", spDayKey(now))!;
  // Um único snapshot e uma conexão para os quatro números. O lucro segue
  // apenas os status financeiros; a contagem também inclui VOID/CANCELED.
  // "Hoje" conta o que aconteceu hoje (liquidação e registro), não o dia do
  // jogo: é o eixo das curvas e do Analyzer que segue o kickoff.
  const [resumo] = await client.$queryRaw<[
    Omit<ResumoHoje, "lucroDia"> & { lucroDia: Prisma.Decimal },
  ]>(Prisma.sql`
    SELECT
      COALESCE(sum(round(bt.lucro * bt."valorUnidade", 2)) FILTER (
        WHERE (bt."settledAt" >= ${inicio} AND bt."settledAt" < ${fim})
          AND bt.status IN (${Prisma.join(FINAL_BET_STATUSES)})
      ), 0) AS "lucroDia",
      (count(*) FILTER (WHERE (bt."settledAt" >= ${inicio} AND bt."settledAt" < ${fim})))::int AS "resolvidasHoje",
      (count(*) FILTER (WHERE (bt."registradoEm" >= ${inicio} AND bt."registradoEm" < ${fim})))::int AS "tipsNovas",
      (count(*) FILTER (WHERE bt.status = 'PENDING'))::int AS "aResolver"
    FROM bets bt
    WHERE bt."deletedAt" IS NULL
      AND ((bt."settledAt" >= ${inicio} AND bt."settledAt" < ${fim}) OR (bt."registradoEm" >= ${inicio} AND bt."registradoEm" < ${fim}) OR bt.status = 'PENDING')
  `);
  return {
    ...resumo,
    lucroDia: toNumber(resumo.lucroDia),
  };
}

// ───────────── Desde a última visita ─────────────

/** O que mudou entre a última visita do operador e a leitura desta. */
export type SinceLastVisit = {
  since: Date;
  until: Date;
  /** Apostas registradas na janela. */
  newBets: number;
  /** Liquidadas na janela, com o lucro dos status financeiros. */
  settled: number;
  lucroUnits: number;
  lucroReais: number;
  /** Fechamentos com CLV confiável gravados ou completados na janela. */
  closings: number;
  clvMean: number | null;
  /** Ações operacionais abertas (ou reabertas) na janela que continuam abertas. */
  openAlerts: number;
};

/** A última visita do operador ao dashboard; a leitura do dashboard não a muda. */
export async function getLastVisit(username: string, client: Prisma.TransactionClient = prisma): Promise<Date | null> {
  const row = await client.dashboardVisit.findUnique({ where: { username }, select: { lastSeenAt: true } });
  return row?.lastSeenAt ?? null;
}

/**
 * Avança a visita para o instante da leitura que a tela mostrou. Nunca volta
 * no tempo: duas abas abertas não fazem o resumo reaparecer.
 */
export async function markVisit(username: string, seenAt: Date): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "dashboard_visits" ("username", "lastSeenAt") VALUES (${username}, ${seenAt})
    ON CONFLICT ("username") DO UPDATE
      SET "lastSeenAt" = GREATEST("dashboard_visits"."lastSeenAt", EXCLUDED."lastSeenAt")`;
}

/**
 * Os números do resumo entre `since` (exclusive) e `until` (inclusive), pelo
 * instante em que cada fato aconteceu: é o que mudou enquanto o dono esteve fora.
 */
export async function getSinceLastVisit(since: Date, until: Date, client?: Prisma.TransactionClient): Promise<SinceLastVisit> {
  if (!client) return prisma.$transaction((tx) => getSinceLastVisit(since, until, tx), {
    isolationLevel: "RepeatableRead", timeout: 20_000,
  });
  const clvEvidence = await reliableClvSql(client, {
    bet: { deletedAt: null },
    OR: [{ fetchedAt: { gt: since, lte: until } }, { updatedAt: { gt: since, lte: until } }],
  });
  const bets = await client.$queryRaw<[{ newBets: number; settled: number; lucroUnits: Prisma.Decimal; lucroReais: Prisma.Decimal }]>(Prisma.sql`
      SELECT
        (count(*) FILTER (WHERE bt."registradoEm" > ${since} AND bt."registradoEm" <= ${until}))::int AS "newBets",
        (count(*) FILTER (WHERE bt."settledAt" > ${since} AND bt."settledAt" <= ${until}))::int AS settled,
        COALESCE(sum(bt.lucro) FILTER (
          WHERE bt."settledAt" > ${since} AND bt."settledAt" <= ${until}
            AND bt.status IN (${Prisma.join(FINAL_BET_STATUSES)})
        ), 0) AS "lucroUnits",
        -- Em reais, cada aposta arredonda para centavos como no extrato da conta.
        COALESCE(sum(round(bt.lucro * bt."valorUnidade", 2)) FILTER (
          WHERE bt."settledAt" > ${since} AND bt."settledAt" <= ${until}
            AND bt.status IN (${Prisma.join(FINAL_BET_STATUSES)})
        ), 0) AS "lucroReais"
      FROM bets bt
      WHERE bt."deletedAt" IS NULL
        AND ((bt."registradoEm" > ${since} AND bt."registradoEm" <= ${until})
          OR (bt."settledAt" > ${since} AND bt."settledAt" <= ${until}))
    `);
  const closings = await client.$queryRaw<[{ closings: number; clvMean: Prisma.Decimal | null }]>(Prisma.sql`
      SELECT count(*)::int AS closings, avg(bc.clv) AS "clvMean"
      FROM bet_closing bc
      JOIN bets bt ON bt.id = bc."betId" AND bt."deletedAt" IS NULL
      WHERE GREATEST(bc."fetchedAt", bc."updatedAt") > ${since}
        AND GREATEST(bc."fetchedAt", bc."updatedAt") <= ${until}
        AND bc.clv IS NOT NULL AND ${clvEvidence}
    `);
  // Reaberta na janela conta também: para o operador é um alerta novo.
  const openAlerts = await client.operationalAction.count({
    where: {
      status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
      OR: [{ openedAt: { gt: since, lte: until } }, { reopenedAt: { gt: since, lte: until } }],
    },
  });
  const [b] = bets;
  const [c] = closings;
  return {
    since,
    until,
    newBets: b.newBets,
    settled: b.settled,
    lucroUnits: toNumber(b.lucroUnits),
    lucroReais: toNumber(b.lucroReais),
    closings: c.closings,
    clvMean: c.clvMean === null ? null : toNumber(c.clvMean),
    openAlerts,
  };
}
