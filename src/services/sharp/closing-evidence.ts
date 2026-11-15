import { Prisma } from "@/src/generated/prisma/client";
import { hasRecomputableClvEvidence } from "@/src/domain/price-provenance";
import { toNullableNumber } from "@/src/domain/money";

/** Alias `bc` = bet_closing. O predicado barato precede a validação matemática. */
const CLV_CANDIDATE_SQL = Prisma.sql`bc."clvReliable" = true
  AND bc.clv IS NOT NULL
  AND bc."fetchedAt" IS NOT NULL
  AND bc."closingPriceSnapshot" IS NOT NULL
  AND bc."closingPriceReference" IS NOT NULL
  AND bc."closingPriceObservedAt" IS NOT NULL
  AND bc.provider IN ('bridgeodds', 'pinnacle17')`;

const PROOF_BATCH = 500;

/**
 * Veredito da prova por aposta, guardado só enquanto a transação existe: no
 * mesmo snapshot a linha não muda, e os agregados de um render repetem as
 * mesmas apostas. Nunca pelo cliente global, que atravessa requisições.
 */
const verdictsByTransaction = new WeakMap<Prisma.TransactionClient, Map<string, boolean>>();

function verdictsOf(tx: Prisma.TransactionClient): Map<string, boolean> {
  // Só o cliente global sabe conectar; o da transação interativa não expõe `$connect`.
  if (typeof (tx as { $connect?: unknown }).$connect === "function") return new Map();
  let verdicts = verdictsByTransaction.get(tx);
  if (!verdicts) verdictsByTransaction.set(tx, verdicts = new Map());
  return verdicts;
}

/**
 * O agregado SQL e o detalhe devem aceitar a mesma prova. A presença do JSON
 * não prova que o book reproduz raw/fair; valida em lotes sem reter o histórico
 * nem duplicar o devig em SQL. Só os ids recusados voltam para o agregado.
 * `where` só limita o que é lido; o veredito de cada aposta não depende dele.
 * Chame na mesma transação RepeatableRead da consulta que usa o predicado.
 */
export async function reliableClvSql(
  tx: Prisma.TransactionClient,
  where: Prisma.BetClosingWhereInput = {},
): Promise<Prisma.Sql> {
  const verdicts = verdictsOf(tx);
  const candidates = await tx.betClosing.findMany({
    where: { AND: [where, {
      clvReliable: true, fetchedAt: { not: null }, clv: { not: null },
      provider: { in: ["bridgeodds", "pinnacle17"] },
    }] },
    select: { betId: true },
  });
  const pending = candidates.filter((row) => !verdicts.has(row.betId)).map((row) => row.betId);
  for (let start = 0; start < pending.length; start += PROOF_BATCH) {
    const rows = await tx.betClosing.findMany({
      where: { betId: { in: pending.slice(start, start + PROOF_BATCH) } },
      select: { betId: true, provider: true, closingOdd: true, closingRawOdd: true, clv: true, bet: { select: { odds: true } },
        closingPriceSnapshot: true, closingPriceReference: true, closingPriceObservedAt: true },
    });
    for (const row of rows) {
      verdicts.set(row.betId, hasRecomputableClvEvidence({
        odds: toNullableNumber(row.bet.odds), clv: toNullableNumber(row.clv),
        fair: toNullableNumber(row.closingOdd), raw: toNullableNumber(row.closingRawOdd),
        snapshot: row.closingPriceSnapshot, provider: row.provider,
        reference: row.closingPriceReference, requireReference: true, observedAt: row.closingPriceObservedAt,
      }));
    }
  }
  const rejected = candidates.filter((row) => verdicts.get(row.betId) !== true).map((row) => row.betId);
  return rejected.length === 0 ? CLV_CANDIDATE_SQL
    : Prisma.sql`${CLV_CANDIDATE_SQL} AND NOT (bc."betId" = ANY(${rejected}::text[]))`;
}
