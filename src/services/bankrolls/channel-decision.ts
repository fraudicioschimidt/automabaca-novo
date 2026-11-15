import { Prisma } from "@/src/generated/prisma/client";
import { toNullableNumber, toNumber } from "@/src/domain/money";
import { reliableClvSql } from "@/src/services/sharp/closing-evidence";
import { prisma } from "@/src/infra/prisma";
import { comparaDecisao, decisionWindowStarts, type DecisaoCanal } from "@/src/domain/analyzer/decisao";
import { CLV_CORTES, roiPct, vereditoEdgeFromStats } from "@/src/domain/analyzer/shared";

/**
 * A régua de cada canal (bankroll 1:1 canal): as métricas de decisão de
 * assinatura. Fica fora da fronteira do Next porque o painel (Bancas,
 * Ferramentas) e o boletim semanal do worker precisam do mesmo número.
 *
 * O agregado roda em SQL para não hidratar o histórico de todas as bancas;
 * `computeDecisaoCanal` (domain/analyzer/decisao) é a mesma regra em JS, e
 * `tests/painel/canais-decisao.db.test.ts` compara as duas sobre as mesmas apostas.
 */

const LIQUIDADA_SQL = Prisma.sql`bt.status IN ('WON', 'LOST', 'HALF_WON', 'HALF_LOST', 'CASHOUT')`;

export type ChannelDecision = {
  id: string;
  nome: string;
  slug: string;
  sharpMode: string;
  temCanal: boolean;
  decisao: DecisaoCanal;
};

type ChannelAggregateRow = {
  id: string;
  nome: string;
  slug: string;
  sharpMode: string;
  temCanal: boolean;
  apostas: number;
  nClv: number;
  clvMedio: Prisma.Decimal | null;
  clvStddev: Prisma.Decimal | null;
  clvPositivos: number;
  clvMenos5: number;
  clvMenos5a0: number;
  clv0a5: number;
  clv5a10: number;
  clv10mais: number;
  nFinal: number;
  stakeFinal: Prisma.Decimal;
  lucroReal: Prisma.Decimal;
  n30d: number;
  n30a60d: number;
  clv30d: Prisma.Decimal | null;
  clv30a60d: Prisma.Decimal | null;
};

/**
 * Melhor evidência de edge primeiro; com `bankrollId`, só aquela banca. `ref`
 * posiciona as janelas de 30 dias, pelo dia do jogo em São Paulo. Com `asOf`, a régua como estava em `ref`:
 * só entram a aposta registrada, o fechamento escrito e a liquidação de antes
 * dele, cada aposta no estado de hoje (a removida depois não entra). O
 * fechamento vale pela última escrita: a busca pós-jogo da Bridge completa o
 * CLV de um fechamento congelado sem mudar o `fetchedAt`. O corte da liquidação
 * é pelo instante em que ela aconteceu (o que já se sabia em `ref`); as
 * janelas seguem o dia do jogo. O boletim semanal compara essa régua com a de
 * agora.
 */
export async function queryChannelDecisions(
  ref: Date = new Date(),
  filter: { bankrollId?: string; asOf?: boolean } = {},
  client?: Prisma.TransactionClient,
): Promise<ChannelDecision[]> {
  if (!client) return prisma.$transaction((tx) => queryChannelDecisions(ref, filter, tx), {
    isolationLevel: "RepeatableRead", timeout: 20_000,
  });
  const clvEvidence = await reliableClvSql(client, {
    ...(filter.asOf ? { fetchedAt: { lt: ref }, updatedAt: { lt: ref } } : {}),
    bet: {
      deletedAt: null, notTakenAt: null,
      ...(filter.bankrollId ? { bankrollId: filter.bankrollId } : {}),
      ...(filter.asOf ? { registradoEm: { lt: ref } } : {}),
    },
  });
  const { recent: corte30d, previous: corte60d } = decisionWindowStarts(ref);
  const knownBet = filter.asOf ? Prisma.sql`AND bt."registradoEm" < ${ref}` : Prisma.empty;
  const clvOk = filter.asOf
    ? Prisma.sql`${clvEvidence} AND GREATEST(bc."fetchedAt", bc."updatedAt") < ${ref}`
    : clvEvidence;
  const settled = filter.asOf ? Prisma.sql`${LIQUIDADA_SQL} AND bt."settledAt" < ${ref}` : LIQUIDADA_SQL;
  const rows = await client.$queryRaw<ChannelAggregateRow[]>(Prisma.sql`
    SELECT
      b.id,
      b.nome,
      b.slug,
      b."sharpMode"::text AS "sharpMode",
      (b."telegramChannelId" IS NOT NULL) AS "temCanal",
      count(bt.id)::int AS apostas,
      count(bc.clv) FILTER (WHERE bc.clv IS NOT NULL AND ${clvOk})::int AS "nClv",
      avg(bc.clv) FILTER (WHERE bc.clv IS NOT NULL AND ${clvOk}) AS "clvMedio",
      stddev_samp(bc.clv) FILTER (WHERE bc.clv IS NOT NULL AND ${clvOk}) AS "clvStddev",
      count(bc.clv) FILTER (WHERE bc.clv > 0 AND ${clvOk})::int AS "clvPositivos",
      count(bc.clv) FILTER (WHERE bc.clv < -5 AND ${clvOk})::int AS "clvMenos5",
      count(bc.clv) FILTER (WHERE bc.clv >= -5 AND bc.clv < 0 AND ${clvOk})::int AS "clvMenos5a0",
      count(bc.clv) FILTER (WHERE bc.clv >= 0 AND bc.clv < 5 AND ${clvOk})::int AS "clv0a5",
      count(bc.clv) FILTER (WHERE bc.clv >= 5 AND bc.clv < 10 AND ${clvOk})::int AS "clv5a10",
      count(bc.clv) FILTER (WHERE bc.clv >= 10 AND ${clvOk})::int AS "clv10mais",
      count(bt.id) FILTER (WHERE ${settled})::int AS "nFinal",
      COALESCE(sum(bt.stake) FILTER (WHERE ${settled}), 0) AS "stakeFinal",
      COALESCE(sum(bt.lucro) FILTER (WHERE ${settled}), 0) AS "lucroReal",
      count(bc.clv) FILTER (
        WHERE bc.clv IS NOT NULL
          AND ${clvOk}
          AND bt.data >= ${corte30d}
      )::int AS "n30d",
      avg(bc.clv) FILTER (
        WHERE bc.clv IS NOT NULL
          AND ${clvOk}
          AND bt.data >= ${corte30d}
      ) AS "clv30d",
      count(bc.clv) FILTER (
        WHERE bc.clv IS NOT NULL
          AND ${clvOk}
          AND bt.data >= ${corte60d}
          AND bt.data < ${corte30d}
      )::int AS "n30a60d",
      avg(bc.clv) FILTER (
        WHERE bc.clv IS NOT NULL
          AND ${clvOk}
          AND bt.data >= ${corte60d}
          AND bt.data < ${corte30d}
      ) AS "clv30a60d"
    FROM bankrolls b
    LEFT JOIN bets bt ON bt."bankrollId" = b.id
      AND bt."deletedAt" IS NULL
      AND bt."notTakenAt" IS NULL
      ${knownBet}
    LEFT JOIN bet_sharp bs ON bs."betId" = bt.id
    LEFT JOIN bet_closing bc ON bc."betId" = bt.id
    ${filter.bankrollId ? Prisma.sql`WHERE b.id = ${filter.bankrollId}` : Prisma.empty}
    GROUP BY b.id
    ORDER BY b.nome ASC
  `);

  return rows
    .map((row) => {
      const clvMedio = toNullableNumber(row.clvMedio);
      const clvStddev = toNullableNumber(row.clvStddev);
      const clv30d = toNullableNumber(row.clv30d);
      const clv30a60d = toNullableNumber(row.clv30a60d);
      const { veredito, tStat } = vereditoEdgeFromStats(
        row.nClv,
        clvMedio,
        clvStddev,
      );
      const distCounts = [
        row.clvMenos5,
        row.clvMenos5a0,
        row.clv0a5,
        row.clv5a10,
        row.clv10mais,
      ];
      return {
        id: row.id,
        nome: row.nome,
        slug: row.slug,
        sharpMode: row.sharpMode,
        temCanal: row.temCanal,
        decisao: {
          apostas: row.apostas,
          nClv: row.nClv,
          beatClosePct: row.nClv ? (row.clvPositivos / row.nClv) * 100 : null,
          clvMedio,
          distClv: CLV_CORTES.map(([label], index) => ({
            label,
            count: distCounts[index] ?? 0,
          })),
          nFinal: row.nFinal,
          roiReal: roiPct(toNumber(row.lucroReal), toNumber(row.stakeFinal)),
          clv30d,
          n30d: row.n30d,
          n30a60d: row.n30a60d,
          deltaClv30d:
            clv30d !== null && clv30a60d !== null ? clv30d - clv30a60d : null,
          veredito,
          tStat,
        },
      };
    })
    .sort((a, b) => comparaDecisao(a.decisao, b.decisao));
}
