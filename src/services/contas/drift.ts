import { persistOperationalAlert, notifyPersistedOperationalAlert } from "@/src/services/ops/alerts";
import { OperationalRisk } from "@/src/generated/prisma/client";
import { LEDGER_MIN_AMOUNT, roundMoney, toNumber } from "@/src/domain/money";
import { spDayKey } from "@/src/domain/dates";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { reconcileOperationalActionSource } from "@/src/services/ops/operational-actions";

const log = createLogger("contas-drift");

/**
 * Invariante do ledger: para toda conta,
 * `saldoAtual == Σ movimentações.valor`. Qualquer diferença de pelo menos um
 * centavo = bug de
 * transação em dinheiro → alerta IMEDIATO (fail-loud), uma vez por dia por
 * conta (dedupe durável via AuditEvent). Contas removidas continuam sob
 * conferência: ocultá-las no painel não encerra uma divergência financeira.
 */

export const DRIFT_ALERT_BRL = LEDGER_MIN_AMOUNT;

type DriftRow = {
  contaId: string;
  casa: string;
  titular: string;
  saldoAtual: string;
  somaMovs: string;
};

export async function checkContasDrift(now = new Date()): Promise<{
  contas: number;
  drifts: number;
}> {
  const rows = await prisma.$queryRaw<DriftRow[]>`
    SELECT c.id AS "contaId", c."casaDeAposta" AS casa, c.titular,
           c."saldoAtual"::text AS "saldoAtual",
           COALESCE(sum(m.valor), 0)::text AS "somaMovs"
    FROM contas c
    LEFT JOIN movimentacoes m ON m."contaId" = c.id
    GROUP BY c.id, c."casaDeAposta", c.titular
  `;

  let drifts = 0;
  const activeIds: string[] = [];
  const dayKey = spDayKey(now);
  for (const row of rows) {
    const drift = Math.abs(
      roundMoney(toNumber(row.saldoAtual) - toNumber(row.somaMovs), 2),
    );
    if (!Number.isFinite(drift) || drift < DRIFT_ALERT_BRL) continue;
    drifts += 1;
    activeIds.push(row.contaId);
    const message =
      `🧮 Saldo da conta não bate · ${row.casa} (${row.titular})\n` +
      `O saldo é R$${toNumber(row.saldoAtual).toFixed(2)}, mas a soma das movimentações dá ` +
      `R$${toNumber(row.somaMovs).toFixed(2)} (diferença de R$${drift.toFixed(2)}).\n` +
      "👉 Confira hoje as movimentações desta conta.";
    const context = {
      source: "consistency.conta-saldo",
      key: row.contaId,
      title: "Saldo divergente do ledger",
      risk: OperationalRisk.CRITICAL,
      resource: "conta",
      resourceId: row.contaId,
      evidence: {
        casa: row.casa,
        titular: row.titular,
        saldoAtual: row.saldoAtual,
        somaMovs: row.somaMovs,
        drift,
      },
    };

    const created = await prisma.$transaction(async (tx) => {
      // Serializa somente conta×dia. O lock transacional fecha a corrida entre
      // dois workers sem transformar AuditEvent append-only em tabela de chave
      // única para todas as demais ações.
      await tx.$queryRaw<Array<{ locked: number }>>`
        SELECT 1::int AS locked
        FROM pg_advisory_xact_lock(hashtext(${`conta_drift:${row.contaId}:${dayKey}`}))
      `;
      const ja = await tx.auditEvent.findFirst({
        where: { action: "conta_drift", resource: row.contaId, resourceId: dayKey },
        select: { id: true },
      });
      if (!ja) await tx.auditEvent.create({
        data: {
          action: "conta_drift",
          resource: row.contaId,
          resourceId: dayKey,
          outcome: "failure",
          details: { saldoAtual: row.saldoAtual, somaMovs: row.somaMovs, drift },
        },
      });
      await persistOperationalAlert(message, context, { incrementOccurrence: !ja, client: tx });
      return !ja;
    });
    if (!created) continue;
    await notifyPersistedOperationalAlert(message, context);
    log.error({ contaId: row.contaId, drift }, "drift de saldo detectado");
  }

  if (rows.length > 0) {
    log.info({ contas: rows.length, drifts }, "checagem de drift concluída");
  }
  await reconcileOperationalActionSource("consistency.conta-saldo", activeIds, now);
  return { contas: rows.length, drifts };
}
