import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { roiPct } from "@/src/domain/analyzer/shared";
import type { BetRowData } from "@/src/domain/bet-read-model";
import { hitRateFromCounts } from "@/src/domain/hit-rate";
import { ausenciaAlcancaFechamento, MOTIVOS_FORA_DA_BASE } from "@/src/domain/no-odds-reason";
import { toNullableNumber, toNumber } from "@/src/domain/money";
import { prisma } from "@/src/infra/prisma";
import { describeRemovals, type BetRemoval } from "@/src/services/bets/remove";
import { resolveLogoUrl } from "@/src/services/painel/logos";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import { reliableClvSql } from "@/src/services/sharp/closing-evidence";
import { BET_ROW_SELECT, mapBetRow } from "./bet-rows";

export type BankrollSummary = {
  id: string; nome: string; slug: string; sharpMode: string; temCanal: boolean;
  valorUnidade: number; capitalInicial: number;
  apostas: number; pendentes: number; stakePendente: number; stakeFinalizada: number;
  /** Reais pelo snapshot de cada aposta, para consolidar a carteira. */
  profitBrl: number; stakedBrl: number;
  lucro: number; roi: number | null; acerto: number | null; resolvidas: number;
  wins: number; losses: number; halfWins: number; halfLosses: number;
  clv: number | null; clvSamples: number;
  /** Denominador da cobertura de CLV: a base alcançável de `situacaoDoClv`. */
  clvBase: number;
  ultimaAtividade: Date | null; logoUrl: string | null;
};

type BankrollSummaryRow = {
  id: string; nome: string; slug: string; sharpMode: string; temCanal: boolean;
  valorUnidade: Prisma.Decimal;
  capitalInicial: Prisma.Decimal; apostas: number; pendentes: number;
  wins: number; losses: number; halfWins: number; halfLosses: number;
  stakePendente: Prisma.Decimal; stakeFinalizada: Prisma.Decimal; lucro: Prisma.Decimal;
  profitBrl: Prisma.Decimal; stakedBrl: Prisma.Decimal;
  clv: Prisma.Decimal | null;
  clvSamples: number; clvBase: number; ultimaAtividade: Date | null;
};

function summaryFromRow(b: BankrollSummaryRow): BankrollSummary {
  const lucro = toNumber(b.lucro);
  const stakeFinalizada = toNumber(b.stakeFinalizada);
  return {
    acerto: hitRateFromCounts({
      won: b.wins - b.halfWins,
      lost: b.losses - b.halfLosses,
      halfWon: b.halfWins,
      halfLost: b.halfLosses,
    }),
    logoUrl: resolveLogoUrl(b.slug, b.id),
    id: b.id,
    nome: b.nome,
    slug: b.slug,
    sharpMode: b.sharpMode,
    temCanal: b.temCanal,
    valorUnidade: toNumber(b.valorUnidade),
    capitalInicial: toNumber(b.capitalInicial),
    apostas: b.apostas,
    pendentes: b.pendentes,
    stakePendente: toNumber(b.stakePendente),
    resolvidas: b.apostas - b.pendentes,
    wins: b.wins,
    losses: b.losses,
    halfWins: b.halfWins,
    halfLosses: b.halfLosses,
    clv: toNullableNumber(b.clv),
    clvSamples: b.clvSamples,
    clvBase: b.clvBase,
    ultimaAtividade: b.ultimaAtividade,
    stakeFinalizada,
    lucro,
    profitBrl: toNumber(b.profitBrl),
    stakedBrl: toNumber(b.stakedBrl),
    roi: roiPct(lucro, stakeFinalizada),
  };
}

/** Motivo da identidade que tira o CLV da base: fora dela e alcança o fechamento (`clv_only` não). */
const IDENTITY_REASONS_OUTSIDE_CLV_BASE = MOTIVOS_FORA_DA_BASE.filter(ausenciaAlcancaFechamento);

/** Resumos por bankroll; com `bankrollId`, só o daquela banca. */
async function queryBankrollSummaries(bankrollId?: string, client?: Prisma.TransactionClient): Promise<BankrollSummary[]> {
  if (!client) return prisma.$transaction((tx) => queryBankrollSummaries(bankrollId, tx), {
    isolationLevel: "RepeatableRead", timeout: 20_000,
  });
  const clvEvidence = await reliableClvSql(client, { bet: { deletedAt: null, ...(bankrollId ? { bankrollId } : {}) } });
  const rows = await client.$queryRaw<BankrollSummaryRow[]>(Prisma.sql`
    SELECT
      b.id, b.nome, b.slug, b."sharpMode"::text AS "sharpMode",
      (b."telegramChannelId" IS NOT NULL) AS "temCanal",
      b."valorUnidade", b."capitalInicial",
      count(bt.id)::int AS apostas,
      (count(bt.id) FILTER (WHERE bt.status = 'PENDING'))::int AS pendentes,
      COALESCE(sum(bt.stake) FILTER (WHERE bt.status = 'PENDING'), 0) AS "stakePendente",
      (count(bt.id) FILTER (WHERE bt.status IN ('WON', 'HALF_WON')))::int AS wins,
      (count(bt.id) FILTER (WHERE bt.status IN ('LOST', 'HALF_LOST')))::int AS losses,
      (count(bt.id) FILTER (WHERE bt.status = 'HALF_WON'))::int AS "halfWins",
      (count(bt.id) FILTER (WHERE bt.status = 'HALF_LOST'))::int AS "halfLosses",
      COALESCE(sum(bt.stake) FILTER (WHERE bt.status IN ('WON','LOST','HALF_WON','HALF_LOST','CASHOUT')), 0) AS "stakeFinalizada",
      COALESCE(sum(bt.lucro) FILTER (WHERE bt.status IN ('WON','LOST','HALF_WON','HALF_LOST','CASHOUT')), 0) AS lucro,
      COALESCE(sum(round(bt.lucro * bt."valorUnidade", 6)) FILTER (WHERE bt.status IN ('WON','LOST','HALF_WON','HALF_LOST','CASHOUT')), 0) AS "profitBrl",
      COALESCE(sum(round(bt.stake * bt."valorUnidade", 6)) FILTER (WHERE bt.status IN ('WON','LOST','HALF_WON','HALF_LOST','CASHOUT')), 0) AS "stakedBrl",
      avg(bc.clv) FILTER (WHERE bc.clv IS NOT NULL AND ${clvEvidence}) AS clv,
      (count(bc.clv) FILTER (WHERE bc.clv IS NOT NULL AND ${clvEvidence}))::int AS "clvSamples",
      -- A base alcançável de situacaoDoClv: com CLV, com motivo do fechamento
      -- que a métrica alcança, ou sem ele, já congelada ou liquidada e sem motivo da
      -- identidade que tire o CLV da base.
      (count(bt.id) FILTER (WHERE (bc.clv IS NOT NULL AND ${clvEvidence})
        OR (bc."noOddsReason" IS NOT NULL AND NOT (bc."noOddsReason" = ANY(${[...MOTIVOS_FORA_DA_BASE]}::text[])))
        OR (bc."noOddsReason" IS NULL AND (bt.status <> 'PENDING' OR bc."fetchedAt" IS NOT NULL)
          AND NOT COALESCE(bs."noOddsReason" = ANY(${[...IDENTITY_REASONS_OUTSIDE_CLV_BASE]}::text[]), false))))::int AS "clvBase",
      max(bt."registradoEm") AS "ultimaAtividade"
    FROM bankrolls b
    LEFT JOIN bets bt ON bt."bankrollId" = b.id AND bt."deletedAt" IS NULL
    LEFT JOIN bet_closing bc ON bc."betId" = bt.id
    LEFT JOIN bet_sharp bs ON bs."betId" = bt.id
    ${bankrollId ? Prisma.sql`WHERE b.id = ${bankrollId}` : Prisma.empty}
    GROUP BY b.id
    ORDER BY b.nome ASC
  `);
  return rows.map(summaryFromRow);
}

export async function getBankrollSummaries(client?: Prisma.TransactionClient): Promise<BankrollSummary[]> {
  return queryBankrollSummaries(undefined, client);
}

/** Lista leve de bancas (só identidade, sem varrer apostas) para seletores e vínculos. */
export async function getBankrollsTips(client: Prisma.TransactionClient = prisma): Promise<
  Array<{ id: string; slug: string; nome: string; sharpMode: string }>
> {
  return client.bankroll.findMany({
    orderBy: { nome: "asc" },
    select: { id: true, slug: true, nome: true, sharpMode: true },
  });
}

/** Uma aposta da lista "Removidas" da banca. */
export type RemovedBetRow = {
  id: string; evento: string; mercado: string; selecao: string;
  odds: number; stake: number; data: Date; removal: BetRemoval;
};

/** A lista "Removidas" mostra as mais recentes; o total vai na aba. */
const REMOVED_SHOWN = 100;

export type BankrollDetail = {
  resumo: BankrollSummary;
  clvMedio: number | null;
  /** Total real; `bets` e apenas a janela mais recente exibida na ficha. */
  historyTotal: number;
  bets: BetRowData[];
  removed: { total: number; bets: RemovedBetRow[] };
};

async function removedBets(bankrollId: string, client: Prisma.TransactionClient): Promise<BankrollDetail["removed"]> {
  const where = { bankrollId, deletedAt: { not: null } } satisfies Prisma.BetWhereInput;
  const rows = await client.bet.findMany({
    where,
    orderBy: [{ deletedAt: "desc" }, { id: "desc" }],
    take: REMOVED_SHOWN,
    select: { id: true, evento: true, mercado: true, selecao: true, odds: true, stake: true, data: true },
  });
  const total = await client.bet.count({ where });
  const removals = await describeRemovals(rows.map((row) => row.id), client);
  const bets = rows.flatMap((row) => {
    const removal = removals.get(row.id);
    if (!removal) return [];
    return [{ ...row, odds: toNumber(row.odds), stake: toNumber(row.stake), removal }];
  });
  return { total, bets };
}

export async function getBankrollDetail(slug: string, client?: Prisma.TransactionClient): Promise<BankrollDetail | null> {
  if (!client) return prisma.$transaction((tx) => getBankrollDetail(slug, tx), {
    isolationLevel: "RepeatableRead", timeout: 20_000,
  });
  const bankroll = await client.bankroll.findFirst({
    where: { slug },
    select: { id: true },
  });
  if (!bankroll) return null;

  const resumo = (await queryBankrollSummaries(bankroll.id, client))[0];
  if (!resumo) return null;
  const recentRaw = await client.bet.findMany({
    where: { bankrollId: bankroll.id, deletedAt: null },
    orderBy: [{ data: "desc" }, { id: "desc" }],
    take: 300,
    select: BET_ROW_SELECT,
  });
  const pendingRaw = await client.bet.findMany({
    where: { bankrollId: bankroll.id, deletedAt: null, status: "PENDING" },
    orderBy: [{ data: "desc" }, { id: "desc" }],
    select: BET_ROW_SELECT,
  });
  const removed = await removedBets(bankroll.id, client);

  const betsRaw = [...new Map(
    [...recentRaw, ...pendingRaw].map((bet) => [bet.id, bet]),
  ).values()].sort((a, b) => b.data.getTime() - a.data.getTime() || b.id.localeCompare(a.id));

  return {
    resumo,
    // O resumo já calcula essas médias com os mesmos filtros; não repita os
    // dois aggregates mais caros na abertura da ficha.
    clvMedio: resumo.clv,
    historyTotal: resumo.apostas,
    bets: betsRaw.map(mapBetRow),
    removed,
  };
}

/**
 * Teto de sanidade do export. O CSV é montado inteiro em memória, num único
 * request do processo web; 50k é ~50× uma temporada cheia, então na prática não
 * dispara: transforma "o painel congelou" em erro acionável.
 */
const MAX_EXPORT_ROWS = 50_000;

/** Histórico completo da banca para o CSV, sem o teto de 300 da ficha, em ordem cronológica. */

export async function fetchAllBankrollBetsForExport(
  bankrollId: string,
): Promise<BetRowData[]> {
  return prisma.$transaction(async (tx) => {
    const PAGE = 500;
    const all: BetRowData[] = [];
    let cursor: string | undefined;

    for (;;) {
      const batch = await tx.bet.findMany({
        where: { bankrollId, deletedAt: null },
        orderBy: [{ data: "asc" }, { id: "asc" }],
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: BET_ROW_SELECT,
      });
      if (batch.length === 0) break;
      all.push(...batch.map(mapBetRow));
      if (all.length > MAX_EXPORT_ROWS) {
        throw new RecusaDeNegocioError(
          `Export excede o limite de ${MAX_EXPORT_ROWS.toLocaleString("pt-BR")} apostas. ` +
            `Filtre por período no analyzer antes de exportar.`,
        );
      }
      if (batch.length < PAGE) break;
      cursor = batch[batch.length - 1]?.id;
      if (!cursor) break;
    }

    return all;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 });
}

/** Identidade leve de uma banca pelo slug (cabeçalho do analyzer). null se não existe. */
export async function getBankrollBySlug(
  slug: string,
): Promise<{ id: string; nome: string; slug: string; sharpMode: string } | null> {
  return prisma.bankroll.findFirst({
    where: { slug },
    select: { id: true, nome: true, slug: true, sharpMode: true },
  });
}

/** Sinal compacto de mudança, incluindo remoção e as duas tabelas de métricas. */
export async function getBankrollVersion(slug: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; version: string }>>`
    SELECT k.id, concat_ws('|', k."updatedAt"::text,
      (SELECT concat_ws(':', count(*), max(b."updatedAt")::text)
       FROM bets b WHERE b."bankrollId" = k.id),
      (SELECT max(s."updatedAt")::text FROM bet_sharp s
       JOIN bets b ON b.id = s."betId" WHERE b."bankrollId" = k.id),
      (SELECT max(c."updatedAt")::text FROM bet_closing c
       JOIN bets b ON b.id = c."betId" WHERE b."bankrollId" = k.id),
      (SELECT max(o."updatedAt")::text FROM bet_opening o
       JOIN bets b ON b.id = o."betId" WHERE b."bankrollId" = k.id)
    ) AS version FROM bankrolls k WHERE k.slug = ${slug}
  `;
  const row = rows[0];
  return row ? createHash("sha256").update(row.id + row.version).digest("hex") : null;
}
