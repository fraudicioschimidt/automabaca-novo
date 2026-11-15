import type { PgBoss } from "pg-boss";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import type { SportResolutionDecision } from "@/src/domain/sports/detect";
import { uuidFromKey } from "@/src/domain/telegram-job";
import { createLogger } from "@/src/infra/logger";
import { resolveOperationalActionBySourceKeyTx } from "@/src/services/ops/operational-actions";
import { enrichSingletonKey, QUEUES, sportResolveKeyPrefix } from "@/src/infra/queue-contract";
import { enqueueSharpEnrich } from "./enqueue-enrich";
import { enqueueSportResolution } from "./enqueue-sport-resolution";

/** Aposta que a captura acabou de gravar, com a decisão de esporte que ela recebeu. */
export type CapturedBet = {
  betId: string;
  sportResolutionStatus: SportResolutionDecision["status"];
  notTaken?: boolean;
  captureFollowupId?: string;
};

export type CaptureFollowupOrigin = "telegram-dm" | "telegram-capture-fix" | "not-taken-undone";
export const CAPTURE_FOLLOWUP_ACTION = "capture.followup";
const log = createLogger("capture-followup");

/** Na transação da aposta: a queda antes do send deixa trabalho durável. */
export async function recordCaptureFollowupTx(
  tx: Prisma.TransactionClient, betId: string, origem: CaptureFollowupOrigin, actor: string, restorationId?: string,
): Promise<string> {
  if (origem === "not-taken-undone") {
    if (!restorationId) throw new Error("Restauração sem revisão para retomar.");
    // A aposta está travada pela restauração: o intent anterior perde a vez
    // mesmo quando duas auditorias têm o mesmo timestamp.
    await tx.auditEvent.updateMany({ where: {
      resourceId: betId, action: CAPTURE_FOLLOWUP_ACTION, outcome: "pending",
      details: { path: ["origem"], equals: "not-taken-undone" },
    }, data: { outcome: "success" } });
  }
  const audit = await tx.auditEvent.create({ data: {
    actor, action: CAPTURE_FOLLOWUP_ACTION, resource: "bet", resourceId: betId,
    outcome: "pending", details: { origem, ...(restorationId ? { restorationId } : {}) },
  }, select: { id: true } });
  return audit.id;
}

/** Relê a aposta e confirma o send idempotente; falha deixa o intent pendente. */
export async function dispatchCaptureFollowupAudit(boss: PgBoss, auditId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const audit = await tx.auditEvent.findFirst({
      where: { id: auditId, action: CAPTURE_FOLLOWUP_ACTION, outcome: "pending" },
      select: { id: true, resourceId: true, details: true },
    });
    if (!audit) return false;
    const { origem, restorationId } = (audit.details as { origem?: unknown; restorationId?: unknown } | null) ?? {};
    if (!audit.resourceId || (origem !== "telegram-dm" && origem !== "telegram-capture-fix" && origem !== "not-taken-undone")) {
      throw new Error(`Intent de captura ${audit.id} inválido.`);
    }
    if (origem === "not-taken-undone" && typeof restorationId !== "string") {
      throw new Error(`Intent de restauração ${audit.id} sem revisão.`);
    }
    // A remoção/reliquidação só pode passar depois do send; ela cancela o job
    // recém-criado. Relê o estado depois de adquirir a trava.
    await tx.$queryRaw`SELECT id FROM bets WHERE id = ${audit.resourceId} FOR NO KEY UPDATE`;
    const current = await tx.auditEvent.findUnique({ where: { id: audit.id }, select: { outcome: true } });
    if (current?.outcome !== "pending") return false;
    const bet = await tx.bet.findUnique({ where: { id: audit.resourceId }, select: {
      id: true, deletedAt: true, notTakenAt: true, status: true, data: true, sportResolutionStatus: true,
      bankroll: { select: { sharpMode: true } }, sharp: { select: { identityStatus: true } },
    } });
    const confirmed = bet?.sportResolutionStatus === "CONFIRMED";
    const unavailable = !bet || bet.deletedAt || bet.notTakenAt || bet.status !== "PENDING" ||
      bet.sportResolutionStatus === "CONFLICT" ||
      (confirmed && (bet.bankroll.sharpMode === "OFF" || (bet.sharp && bet.sharp.identityStatus !== "PENDING")));
    let disposition = "skipped";
    if (!unavailable) {
      const queue = confirmed ? QUEUES.sharpEnrich : QUEUES.sportResolve;
      const jobId = uuidFromKey(`capture-followup:${audit.id}:${queue}`);
      const key = confirmed ? enrichSingletonKey(bet.id) : `${sportResolveKeyPrefix(bet.id)}%`;
      // A captura aceita uma cadeia anterior. A restauração aceita somente
      // seu id estável ou uma cadeia ativa, sem reutilizar job cancelado.
      const known = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM pgboss.job WHERE name = ${queue}
          AND (id = ${jobId}::uuid OR (singleton_key LIKE ${key} AND data->>'oneShot' IS DISTINCT FROM 'true'
            AND (${origem !== 'not-taken-undone'} OR state IN ('created', 'retry', 'active'))))
        LIMIT 1
      `;
      if (known.length === 0) {
        const sent = confirmed
          ? await enqueueSharpEnrich(boss, bet.id, { jobId, origem })
          : await enqueueSportResolution(boss, bet.id, { jobId, origem, kickoff: bet.data });
        if (!sent) {
          const duplicate = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id::text FROM pgboss.job WHERE name = ${queue}
              AND (id = ${jobId}::uuid OR (singleton_key LIKE ${key} AND data->>'oneShot' IS DISTINCT FROM 'true'
            AND (${origem !== 'not-taken-undone'} OR state IN ('created', 'retry', 'active'))))
            LIMIT 1
          `;
          if (duplicate.length === 0) throw new Error(`Agendamento de captura ${audit.id} recusado sem job correspondente.`);
        }
      }
      disposition = "scheduled";
    }
    if (origem !== "not-taken-undone") {
      await resolveOperationalActionBySourceKeyTx(tx,
        origem === "telegram-dm" ? "bets.dm-enrich-enqueue" : "bets.capture-fix-enqueue",
        audit.resourceId!, disposition === "scheduled"
          ? "Agendamento da captura confirmado pela outbox."
          : "O estado atual da aposta dispensa o agendamento da captura.",
      );
    }
    await tx.auditEvent.updateMany({ where: { id: audit.id, outcome: "pending" },
        data: { outcome: "success", details: { origem, disposition, ...(typeof restorationId === "string" ? { restorationId } : {}) } } });
    return true;
  }, { timeout: 20_000 });
}

/** A outbox retoma todos os intents do lote, inclusive se um deles falhar. */
export async function dispatchPendingCaptureFollowups(boss: PgBoss): Promise<number> {
  const rows = await prisma.auditEvent.findMany({
    where: { action: CAPTURE_FOLLOWUP_ACTION, outcome: "pending" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 50, select: { id: true },
  });
  let dispatched = 0;
  const errors: unknown[] = [];
  for (const row of rows) {
    try { if (await dispatchCaptureFollowupAudit(boss, row.id)) dispatched++; }
    catch (err) { errors.push(err); log.error({ err, auditId: row.id }, "próximo passo da captura segue na outbox"); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Falha ao despachar próximos passos da captura.");
  return dispatched;
}

/**
 * O que vem depois de gravar uma aposta capturada: com o esporte confirmado,
 * a busca de preço; sem ele, a resolução do esporte, que libera o preço
 * depois. Cada aposta de um lote segue a própria decisão; a que o dono marcou
 * como não pega fica parada.
 */
export async function enqueueAfterCapture(
  boss: PgBoss,
  bets: readonly CapturedBet[],
  origem: string,
): Promise<void> {
  const scheduled = new Set<string>();
  for (const bet of bets) {
    if (bet.notTaken || scheduled.has(bet.betId)) continue;
    scheduled.add(bet.betId);
    if (bet.captureFollowupId) {
      await dispatchCaptureFollowupAudit(boss, bet.captureFollowupId);
      continue;
    }
    if (bet.sportResolutionStatus === "CONFIRMED") {
      await enqueueSharpEnrich(boss, bet.betId);
    } else {
      await enqueueSportResolution(boss, bet.betId, { origem });
    }
  }
}

/**
 * Reentrega de post já capturado: a aposta foi gravada, mas o processo pode
 * ter caído entre o commit e o enfileiramento. Refaz o que falta para as
 * apostas pendentes do post que nunca chegaram à fila: sem job algum de preço
 * (nem resultado dele) ou de resolução de esporte. Devolve quantas voltaram.
 */
export async function ensureCaptureFollowups(boss: PgBoss, betId: string, origem: string): Promise<number> {
  const captured = await prisma.bet.findUnique({
    where: { id: betId },
    select: { source: true, sourceExternalId: true },
  });
  if (!captured?.sourceExternalId) return 0;
  const root = captured.sourceExternalId.split(":")[0]!;
  const bets = await prisma.bet.findMany({
    where: {
      source: captured.source,
      OR: [{ sourceExternalId: root }, { sourceExternalId: { startsWith: `${root}:` } }],
      deletedAt: null,
      notTakenAt: null,
      status: "PENDING",
    },
    select: { id: true, sportResolutionStatus: true, sharp: { select: { betId: true } } },
  });
  const candidates = bets.filter((bet) => bet.sportResolutionStatus !== "CONFIRMED" || !bet.sharp);
  if (candidates.length === 0) return 0;
  const patterns = candidates.map((bet) => bet.sportResolutionStatus === "CONFIRMED"
    ? enrichSingletonKey(bet.id)
    : `${sportResolveKeyPrefix(bet.id)}%`);
  const known = await prisma.$queryRaw<Array<{ singletonKey: string }>>(Prisma.sql`
    SELECT DISTINCT singleton_key AS "singletonKey" FROM pgboss.job
    WHERE name IN (${QUEUES.sharpEnrich}, ${QUEUES.sportResolve})
      AND singleton_key LIKE ANY (${patterns}::text[])
  `);
  const missing = candidates.filter((bet) => !known.some(({ singletonKey }) => (
    bet.sportResolutionStatus === "CONFIRMED"
      ? singletonKey === enrichSingletonKey(bet.id)
      : singletonKey.startsWith(sportResolveKeyPrefix(bet.id))
  )));
  await enqueueAfterCapture(boss, missing.map((bet) => ({
    betId: bet.id,
    sportResolutionStatus: bet.sportResolutionStatus,
  })), origem);
  return missing.length;
}
