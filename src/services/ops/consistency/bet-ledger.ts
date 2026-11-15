import { FINAL_BET_STATUSES } from "@/src/domain/bet-status";
import { computeLucroFromStatus } from "@/src/domain/lucro";
import { BET_UNIT_MIN_AMOUNT, LEDGER_MIN_AMOUNT, roundMoney, toNumber } from "@/src/domain/money";
import { spDayKey } from "@/src/domain/dates";
import { OperationalRisk, Prisma } from "@/src/generated/prisma/client";
import {
  persistOperationalAlert,
  notifyPersistedOperationalAlert,
  type OperationalAlertContext,
} from "@/src/services/ops/alerts";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { reconcileOperationalActionSource } from "@/src/services/ops/operational-actions";

const log = createLogger("bet-consistency");

/**
 * Consistency-check de lucro: recomputa do ZERO o lucro de
 * toda aposta liquidada a partir de
 * status/odds/stake e ALERTA divergência — nunca corrige em silêncio.
 * Complementa o drift de saldo (contas/drift): juntos cobrem o caso em que
 * lucro e movimentação erram juntos e o saldo "fecha" mesmo errado.
 * CASHOUT mantém o lucro manual: só confere os limites possíveis da aposta.
 */

/** Fonte da ação de ledger divergente; ela vigia também a aposta removida. */
export const BET_LEDGER_ALERT_SOURCE = "consistency.bet-ledger";

const VERIFICAVEIS = [...FINAL_BET_STATUSES, "VOID", "CANCELED"] as const;
const CONSISTENCY_BATCH_SIZE = 1_000;

export type LucroDivergente = {
  betId: string;
  evento: string;
  status: string;
  lucroGravado: number;
  lucroEsperado: number;
};

export type LedgerDivergente = {
  betId: string;
  evento: string;
  contaEsperadaId: string | null;
  contaMovimentoId: string;
  valorEsperado: number;
  valorGravado: number;
};

export function formatUnitForConsistencyAlert(value: number): string {
  return `${value.toFixed(6).replace(/\.?0+$/, "")}u`;
}

/**
 * Alerta uma divergência no máximo uma vez por dia (dedupe durável pelo
 * AuditEvent `action`/`resource`/dia). Nas repetições do mesmo dia só a ação da
 * caixa é atualizada, sem nova notificação.
 */
async function alertDivergenceOncePerDay(params: {
  action: string;
  resource: string;
  dayKey: string;
  details: Prisma.InputJsonObject;
  message: string;
  context: OperationalAlertContext;
  logMessage: string;
}): Promise<void> {
  const created = await prisma.$transaction(async (tx) => {
    // Uma reserva diária e sua ação precisam commitar juntas. O lock também
    // impede duas varreduras de contar a mesma divergência como ocorrências novas.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${params.action}:${params.resource}:${params.dayKey}`}, 0))
    `;
    const existing = await tx.auditEvent.findFirst({
      where: { action: params.action, resource: params.resource, resourceId: params.dayKey },
      select: { id: true },
    });
    if (!existing) await tx.auditEvent.create({
      data: {
        action: params.action,
        resource: params.resource,
        resourceId: params.dayKey,
        outcome: "failure",
        details: params.details,
      },
    });
    await persistOperationalAlert(params.message, params.context, {
      incrementOccurrence: !existing, client: tx,
    });
    return !existing;
  });
  if (!created) return;
  await notifyPersistedOperationalAlert(params.message, params.context);
  log.error(params.details, params.logMessage);
}

export async function checkBetLucroConsistency(now = new Date()): Promise<{
  verificadas: number;
  divergentes: LucroDivergente[];
}> {
  const divergentes: LucroDivergente[] = [];
  let verificadas = 0;
  let cursor: string | undefined;
  for (;;) {
    const bets = await prisma.bet.findMany({
      where: { deletedAt: null, status: { in: [...VERIFICAVEIS] } },
      select: { id: true, evento: true, status: true, odds: true, stake: true, lucro: true },
      orderBy: { id: "asc" },
      take: CONSISTENCY_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (bets.length === 0) break;
    verificadas += bets.length;
    for (const bet of bets) {
      const lucroGravado = toNumber(bet.lucro);
      const terms = { stake: toNumber(bet.stake), odds: toNumber(bet.odds) };
      // Cashout não deriva da odd: dentro do intervalo qualquer lucro manual
      // vale. Fora dele, a evidência aponta o limite que foi ultrapassado.
      const lucroEsperado = bet.status === "CASHOUT"
        ? Math.max(computeLucroFromStatus({ ...terms, status: "LOST" }),
          Math.min(computeLucroFromStatus({ ...terms, status: "WON" }), lucroGravado))
        : computeLucroFromStatus({ ...terms, status: bet.status });
      if (
        Math.abs(roundMoney(lucroGravado) - roundMoney(lucroEsperado)) >=
        BET_UNIT_MIN_AMOUNT
      ) {
        divergentes.push({ betId: bet.id, evento: bet.evento, status: bet.status, lucroGravado, lucroEsperado });
      }
    }
    cursor = bets.at(-1)?.id;
    if (bets.length < CONSISTENCY_BATCH_SIZE) break;
  }

  const dayKey = spDayKey(now);
  for (const d of divergentes) {
    const message =
      `🧮 Lucro não bate · ${d.evento} (${d.status})\n` +
      `Está gravado ${formatUnitForConsistencyAlert(d.lucroGravado)}, mas ` +
      (d.status === "CASHOUT"
        ? `ultrapassa o limite de ${formatUnitForConsistencyAlert(d.lucroEsperado)} desta aposta. `
        : `pelo resultado, odd e stake deveria ser ${formatUnitForConsistencyAlert(d.lucroEsperado)}. `) +
      `Nada foi corrigido sozinho.\n` +
      `👉 Confira a aposta ${d.betId}.`;
    await alertDivergenceOncePerDay({
      action: "bet_lucro_drift",
      resource: d.betId,
      dayKey,
      details: { ...d },
      message,
      context: {
        source: "consistency.bet-lucro",
        key: d.betId,
        title: "Lucro divergente do status",
        risk: OperationalRisk.CRITICAL,
        resource: "bet",
        resourceId: d.betId,
        evidence: {
          evento: d.evento,
          status: d.status,
          lucroGravado: d.lucroGravado,
          lucroEsperado: d.lucroEsperado,
        },
      },
      logMessage: "lucro divergente do status",
    });
  }

  if (verificadas > 0) {
    log.info({ verificadas, divergentes: divergentes.length }, "consistency-check de lucro concluído");
  }
  await reconcileOperationalActionSource("consistency.bet-lucro", divergentes.map((d) => d.betId), now);
  return { verificadas, divergentes };
}

type LedgerDriftRow = {
  betId: string;
  evento: string;
  contaEsperadaId: string | null;
  contaMovimentoId: string;
  valorEsperado: string;
  valorGravado: string;
};

async function findLedgerDriftRows(betIds: string[]): Promise<LedgerDriftRow[]> {
  return prisma.$queryRaw<LedgerDriftRow[]>`
    WITH expected AS (
      SELECT
        b.id AS "betId",
        b.evento,
        b."contaId" AS "contaEsperadaId",
        CASE
          WHEN b."deletedAt" IS NULL
            AND b."contaId" IS NOT NULL
            AND b.status IN ('WON','LOST','HALF_WON','HALF_LOST','CASHOUT')
          THEN round(b.lucro * b."valorUnidade", 2)
          ELSE 0::numeric
        END AS "valorEsperado"
      FROM bets b
      WHERE b.id IN (${Prisma.join(betIds)})
    ),
    accounts AS (
      SELECT e."betId", e."contaEsperadaId" AS "contaMovimentoId"
      FROM expected e
      WHERE e."contaEsperadaId" IS NOT NULL
      UNION
      SELECT m."betId", m."contaId"
      FROM movimentacoes m
      JOIN expected e ON e."betId" = m."betId"
    ),
    actual AS (
      SELECT m."betId", m."contaId" AS "contaMovimentoId", sum(m.valor) AS "valorGravado"
      FROM movimentacoes m
      JOIN expected e ON e."betId" = m."betId"
      GROUP BY m."betId", m."contaId"
    )
    SELECT
      e."betId",
      e.evento,
      e."contaEsperadaId",
      a."contaMovimentoId",
      CASE
        WHEN a."contaMovimentoId" = e."contaEsperadaId" THEN e."valorEsperado"
        ELSE 0::numeric
      END::text AS "valorEsperado",
      COALESCE(x."valorGravado", 0)::text AS "valorGravado"
    FROM accounts a
    JOIN expected e ON e."betId" = a."betId"
    LEFT JOIN actual x
      ON x."betId" = a."betId"
     AND x."contaMovimentoId" = a."contaMovimentoId"
    WHERE abs(
      COALESCE(x."valorGravado", 0) -
      CASE
        WHEN a."contaMovimentoId" = e."contaEsperadaId" THEN e."valorEsperado"
        ELSE 0::numeric
      END
    ) >= ${LEDGER_MIN_AMOUNT}
    ORDER BY e."betId", a."contaMovimentoId"
  `;
}

/**
 * Invariante por aposta: o líquido de cada conta tocada pela aposta deve ser
 * zero, exceto a conta atualmente vinculada a uma aposta financeira ativa,
 * cujo líquido deve ser `lucro × valorUnidade` arredondado para centavos.
 *
 * Isto cobre um buraco que os dois checks anteriores não enxergavam: um
 * lançamento ausente ou feito na conta errada pode manter tanto o lucro da
 * aposta quanto `saldoAtual = Σ ledger` internamente coerentes.
 */
export async function checkBetLedgerConsistency(now = new Date()): Promise<{
  verificadas: number;
  divergentes: LedgerDivergente[];
}> {
  let verificadas = 0;
  let cursor: string | undefined;
  const rows: LedgerDriftRow[] = [];
  for (;;) {
    const bets = await prisma.bet.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
      take: CONSISTENCY_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (bets.length === 0) break;
    verificadas += bets.length;
    const batchRows = await findLedgerDriftRows(bets.map((bet) => bet.id));
    rows.push(...batchRows);
    cursor = bets.at(-1)?.id;
    if (bets.length < CONSISTENCY_BATCH_SIZE) break;
  }

  const divergentes = rows.map((row) => ({
    betId: row.betId,
    evento: row.evento,
    contaEsperadaId: row.contaEsperadaId,
    contaMovimentoId: row.contaMovimentoId,
    valorEsperado: toNumber(row.valorEsperado),
    valorGravado: toNumber(row.valorGravado),
  }));
  const dayKey = spDayKey(now);
  const activeKeys: string[] = [];
  for (const d of divergentes) {
    const key = `${d.betId}:${d.contaMovimentoId}`;
    activeKeys.push(key);
    const message =
      `🧮 Movimento da conta não bate · ${d.evento}\n` +
      `A conta registrou R$${d.valorGravado.toFixed(2)}, mas a aposta ${d.betId} pede ` +
      `R$${d.valorEsperado.toFixed(2)} (conta ${d.contaMovimentoId}). Nada foi corrigido sozinho.\n` +
      "👉 Confira em Contas as movimentações desta aposta e corrija a que divergir.";
    await alertDivergenceOncePerDay({
      action: "bet_ledger_drift",
      resource: key,
      dayKey,
      details: { ...d },
      message,
      context: {
        source: BET_LEDGER_ALERT_SOURCE,
        key,
        title: "Ledger da aposta divergente",
        risk: OperationalRisk.CRITICAL,
        resource: "bet",
        resourceId: d.betId,
        evidence: {
          contaEsperadaId: d.contaEsperadaId,
          contaMovimentoId: d.contaMovimentoId,
          valorEsperado: d.valorEsperado,
          valorGravado: d.valorGravado,
        },
      },
      logMessage: "ledger divergente da aposta",
    });
  }

  if (verificadas > 0) {
    log.info({ verificadas, divergentes: divergentes.length }, "consistency-check de ledger concluído");
  }
  await reconcileOperationalActionSource(BET_LEDGER_ALERT_SOURCE, activeKeys, now);
  return { verificadas, divergentes };
}
