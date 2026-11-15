import { Prisma } from "@/src/generated/prisma/client";
import { ACTIVE_OPERATIONAL_ACTION_STATUSES } from "@/src/domain/operational-action-status";
import { isDelegatedActor } from "@/src/domain/production-write-actors";
import { prisma } from "@/src/infra/prisma";
import { isContractQueue } from "@/src/infra/queue-contract";
import { scrubSecrets } from "@/src/infra/redaction";
import { resolverAcoesDoRecursoTx } from "@/src/services/ops/action-resource-gc";

/**
 * Apaga do pg-boss uma fila que saiu do código, com a dead-letter dela e todos
 * os jobs. O pg-boss não apaga fila sozinho: sem isto ela fica registrada para
 * sempre, o painel continua listando a dead-letter dela e as falhas guardadas
 * lá seguem abrindo ações que ninguém tem como reprocessar.
 *
 * Só apaga fila que esta versão não consome, sem job por rodar e sem job novo
 * nas últimas 24 h: é o sinal de que ninguém manda mais nada para ela. As
 * falhas guardadas (`failed`) vão junto; quem roda diz por quê em `motivo`, e
 * as ações abertas sobre elas fecham na mesma transação.
 */

const QUIET_MS = 24 * 60 * 60_000;
const PENDING_STATES = ["created", "retry", "active"] as const;
const LISTED_FAILURES = 100;

export type RetiredQueuePlan = {
  fila: string;
  estado: "apagar" | "ausente" | "recusada";
  recusa?: string;
  deadLetter: string | null;
  /** Jobs por fila (origem e dead-letter) e estado. */
  jobs: Record<string, Record<string, number>>;
  ultimoJobEm: string | null;
  falhasTotal: number;
  /** As falhas que vão junto com a fila (até 100 listadas). */
  falhas: Array<{ id: string; fila: string; criadoEm: string; erro: string | null }>;
  acoesAbertas: Array<{ id: string; titulo: string }>;
};

type ActionRow = { id: string; title: string; resource: string; resourceId: string };

function validateNames(filas: readonly string[]): string[] {
  const unique = [...new Set(filas.map((fila) => fila.trim()))];
  if (unique.length === 0 || unique.some((fila) => fila === "")) throw new Error("informe ao menos uma fila");
  for (const fila of unique) {
    if (fila.endsWith(".dlq")) throw new Error(`${fila} é dead-letter: passe a fila de origem, e a dead-letter sai junto`);
    if (isContractQueue(fila)) throw new Error(`${fila} é do contrato desta versão; o worker a consome`);
  }
  return unique;
}

async function planQueue(
  tx: Prisma.TransactionClient,
  queue: { name: string; deadLetter: string | null },
  now: Date,
): Promise<{ plan: RetiredQueuePlan; actions: ActionRow[] }> {
  const names = queue.deadLetter ? [queue.name, queue.deadLetter] : [queue.name];
  // Em sequência: a transação interativa usa uma conexão só.
  const stats = await tx.$queryRaw<Array<{ name: string; state: string; n: number; latest: Date }>>`
    SELECT name, state::text AS state, count(*)::int AS n, max(created_on) AS latest
    FROM pgboss.job WHERE name = ANY(${names}::text[]) GROUP BY 1, 2`;
  const failures = await tx.$queryRaw<Array<{ id: string; name: string; createdOn: Date; message: string | null }>>`
    SELECT id::text AS id, name, created_on AS "createdOn", output->>'message' AS message
    FROM pgboss.job WHERE name = ANY(${names}::text[]) AND state = 'failed'
    ORDER BY created_on LIMIT ${LISTED_FAILURES}`;
  const actions = await tx.$queryRaw<ActionRow[]>`
    SELECT id, title, resource, "resourceId" FROM operational_actions
    WHERE status::text IN (${Prisma.join([...ACTIVE_OPERATIONAL_ACTION_STATUSES])})
      AND (
        (resource = 'pgboss-job'
          AND "resourceId" IN (SELECT id::text FROM pgboss.job WHERE name = ANY(${names}::text[])))
        OR (resource = 'pgboss-queue' AND "resourceId" = ANY(${names}::text[]))
      )
    ORDER BY "openedAt"`;
  const sharedDeadLetter = queue.deadLetter
    ? await tx.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM pgboss.queue WHERE dead_letter = ${queue.deadLetter} AND name <> ${queue.name}`
    : [];

  const jobs: RetiredQueuePlan["jobs"] = {};
  let latest: Date | null = null;
  for (const row of stats) {
    (jobs[row.name] ??= {})[row.state] = row.n;
    if (!latest || row.latest > latest) latest = row.latest;
  }
  const count = (states: readonly string[]) =>
    stats.filter((row) => states.includes(row.state)).reduce((sum, row) => sum + row.n, 0);
  const pending = count(PENDING_STATES);

  const recusa = pending > 0
    ? `${pending} job(s) ainda por rodar; apagar a fila os perderia`
    : latest && now.getTime() - latest.getTime() < QUIET_MS
      ? `recebeu job em ${latest.toISOString()}, há menos de 24 h: alguém ainda manda trabalho para ela`
      : sharedDeadLetter.length > 0
        ? `a dead-letter ${queue.deadLetter} também serve ${sharedDeadLetter.map((row) => row.name).join(", ")}`
        : null;

  return {
    plan: {
      fila: queue.name,
      estado: recusa ? "recusada" : "apagar",
      ...(recusa ? { recusa } : {}),
      deadLetter: queue.deadLetter,
      jobs,
      ultimoJobEm: latest?.toISOString() ?? null,
      falhasTotal: count(["failed"]),
      falhas: failures.map((row) => ({
        id: row.id,
        fila: row.name,
        criadoEm: row.createdOn.toISOString(),
        erro: row.message ? scrubSecrets(row.message).slice(0, 200) : null,
      })),
      acoesAbertas: actions.map((row) => ({ id: row.id, titulo: row.title })),
    },
    actions,
  };
}

/**
 * Simula por padrão. Com `aplicar`, apaga só se nenhuma fila pedida for
 * recusada: é tudo ou nada, numa transação, com auditoria em nome de `executor`.
 */
export async function deleteRetiredQueues(params: {
  filas: readonly string[];
  motivo: string;
  executor: string;
  aplicar: boolean;
  now?: Date;
}): Promise<{ filas: RetiredQueuePlan[]; aplicado: boolean }> {
  if (!isDelegatedActor(params.executor)) throw new Error("executor precisa ser agent:<nome>:por:<dono>");
  const names = validateNames(params.filas);
  const motivo = params.motivo.trim();
  if (!motivo) throw new Error("informe o motivo: ele fica na auditoria junto com as falhas descartadas");
  const now = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    // Com `aplicar`, trava as linhas das filas até o fim: ninguém recria nem
    // reconfigura a fila entre a conferência e a remoção.
    const existing = await tx.$queryRaw<Array<{ name: string; deadLetter: string | null }>>`
      SELECT name, dead_letter AS "deadLetter" FROM pgboss.queue
      WHERE name = ANY(${names}::text[]) ORDER BY name
      ${params.aplicar ? Prisma.sql`FOR UPDATE` : Prisma.empty}`;
    const byName = new Map(existing.map((row) => [row.name, row]));

    const planned: Array<{ plan: RetiredQueuePlan; actions: ActionRow[] }> = [];
    for (const fila of names) {
      const queue = byName.get(fila);
      planned.push(queue ? await planQueue(tx, queue, now) : {
        plan: {
          fila, estado: "ausente", deadLetter: null, jobs: {}, ultimoJobEm: null,
          falhasTotal: 0, falhas: [], acoesAbertas: [],
        },
        actions: [],
      });
    }
    const plans = planned.map((item) => item.plan);
    const toDelete = planned.filter((item) => item.plan.estado === "apagar");
    if (!params.aplicar || toDelete.length === 0 || plans.some((plan) => plan.estado === "recusada")) {
      return { filas: plans, aplicado: false };
    }

    for (const { plan, actions } of toDelete) {
      for (const action of actions) {
        await resolverAcoesDoRecursoTx(tx, {
          resource: action.resource,
          resourceId: action.resourceId,
          actor: params.executor,
          now,
          resolutionNote: `A fila ${plan.fila} saiu do código e foi apagada com os jobs. ${motivo}`,
        });
      }
      await tx.auditEvent.create({
        data: {
          actor: params.executor,
          action: "pgboss_queue.delete",
          resource: "pgboss_queue",
          resourceId: plan.fila,
          details: {
            deadLetter: plan.deadLetter,
            jobs: plan.jobs,
            falhasDescartadas: plan.falhasTotal,
            falhas: plan.falhas.map((falha) => ({ id: falha.id, fila: falha.fila })),
            acoesFechadas: actions.map((action) => action.id),
            motivo,
          },
        },
      });
      // Origem antes da dead-letter: a origem aponta para ela (FK do pg-boss).
      await tx.$queryRaw`SELECT 1 AS ok FROM pgboss.delete_queue(${plan.fila})`;
      if (plan.deadLetter) await tx.$queryRaw`SELECT 1 AS ok FROM pgboss.delete_queue(${plan.deadLetter})`;
    }
    return { filas: plans, aplicado: true };
  }, { timeout: 60_000 });
}
