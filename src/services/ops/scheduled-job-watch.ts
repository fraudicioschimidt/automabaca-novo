import { Prisma } from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { raiseOperationalAlertOnce } from "@/src/services/ops/alerts";
import { SCHEDULED_FAILURE_ALERT_SOURCE } from "@/src/services/ops/dlq/handler";
import { SCHEDULED_TICK_DISCARD_ACTION } from "@/src/services/ops/dlq/repository";
import { reconcileOperationalActionSource } from "@/src/services/ops/operational-actions";

const log = createLogger("scheduled-job-watch");

/** Fonte da ação "tarefa agendada parou de rodar". */
export const SCHEDULE_STALE_ALERT_SOURCE = "jobs.schedule-stale";

export type ScheduledQueueCadence = { queue: string; maxGapMinutes: number };

type QueueRun = { name: string; createdOn: Date; lastCompletedAt: Date | null };

/**
 * Quanto tempo sem concluir ainda é normal: o maior intervalo do cron mais uma
 * folga para retentativas e execução longa (15 min no mínimo, até 1 h para os
 * crons espaçados).
 */
export function scheduledJobToleranceMinutes(maxGapMinutes: number): number {
  return maxGapMinutes + Math.max(15, Math.min(maxGapMinutes, 60));
}

/**
 * Carência depois do boot: o disparo de recuperação (`missed: "once"`) dos
 * crons espaçados sai no primeiro ciclo, e o dos curtos em até um intervalo.
 */
function bootGraceMinutes(toleranceMinutes: number): number {
  return Math.min(toleranceMinutes, 60);
}

/**
 * Filas agendadas cuja última conclusão (ou a criação da fila, se ela nunca
 * concluiu) passou da tolerância. Logo depois do boot a fila atrasada não abre
 * aviso novo (`raise: false`): o deploy não pode alarmar por um disparo que
 * ainda nem teve chance de sair. O boot não apaga o atraso: a ação que já
 * estava aberta continua aberta.
 */
export function staleScheduledQueues(
  schedules: readonly ScheduledQueueCadence[],
  runs: readonly QueueRun[],
  now: Date,
  bootedAt: Date | null = null,
): Array<{ queue: string; lastCompletedAt: Date | null; toleranceMinutes: number; raise: boolean }> {
  const byName = new Map(runs.map((run) => [run.name, run]));
  return schedules.flatMap((schedule) => {
    const run = byName.get(schedule.queue);
    // Sem fila registrada não há o que vigiar: o boot a cria antes do manifesto.
    if (!run) return [];
    const toleranceMinutes = scheduledJobToleranceMinutes(schedule.maxGapMinutes);
    const lastEvidence = (run.lastCompletedAt ?? run.createdOn).getTime();
    if (now.getTime() - lastEvidence <= toleranceMinutes * 60_000) return [];
    const inBootGrace = bootedAt !== null
      && now.getTime() - bootedAt.getTime() < bootGraceMinutes(toleranceMinutes) * 60_000;
    return [{ queue: schedule.queue, lastCompletedAt: run.lastCompletedAt, toleranceMinutes, raise: !inBootGrace }];
  });
}

async function readQueueRuns(queues: readonly string[]): Promise<QueueRun[]> {
  if (queues.length === 0) return [];
  return prisma.$queryRaw<QueueRun[]>(Prisma.sql`
    SELECT q.name, q.created_on AS "createdOn", done."lastCompletedAt"
    FROM pgboss.queue q
    LEFT JOIN (
      SELECT name, max(completed_on) AS "lastCompletedAt"
      FROM pgboss.job
      WHERE name IN (${Prisma.join([...queues])}) AND state = 'completed'
      GROUP BY name
    ) done ON done.name = q.name
    WHERE q.name IN (${Prisma.join([...queues])})
  `);
}

/**
 * Até onde procurar a última falha de cada fila. O aviso de falha só fecha com
 * uma conclusão depois dela, então a busca passa da retenção (2 dias) dos jobs
 * concluídos dos crons diários, e a auditoria guarda 30 dias.
 */
const LAST_DISCARD_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/** Última dead-letter descartada de cada fila agendada. */
async function readLastTickDiscards(queues: readonly string[], now: Date): Promise<Map<string, Date>> {
  const rows = await prisma.auditEvent.groupBy({
    by: ["resource"],
    where: {
      action: SCHEDULED_TICK_DISCARD_ACTION,
      resource: { in: [...queues] },
      createdAt: { gte: new Date(now.getTime() - LAST_DISCARD_LOOKBACK_MS) },
    },
    _max: { createdAt: true },
  });
  return new Map(rows.flatMap((row) => row.resource && row._max.createdAt ? [[row.resource, row._max.createdAt]] : []));
}

function describeLastRun(lastCompletedAt: Date | null, now: Date): string {
  if (!lastCompletedAt) return "Não há conclusão dela no histórico guardado.";
  const minutes = Math.round((now.getTime() - lastCompletedAt.getTime()) / 60_000);
  return minutes < 120 ? `Última conclusão há ${minutes} min.` : `Última conclusão há ${Math.round(minutes / 60)} h.`;
}

/**
 * Vigia dos agendamentos: a fila de cron que parou de concluir (schedule
 * perdido, job preso ocupando a vaga da fila `exclusive`, falha em toda
 * execução) abre UMA ação por fila, e ela fecha sozinha quando a fila volta a
 * concluir. O mesmo vale para o aviso de "falhando de novo" que o watcher da
 * dead-letter abre: ele fecha quando a fila conclui depois da última falha.
 *
 * O `/api/health` olha só o heartbeat; é o heartbeat que chama este vigia, e
 * por isso ele não vigia a si mesmo.
 */
export async function watchScheduledJobs(
  schedules: readonly ScheduledQueueCadence[],
  options: { now?: Date; bootedAt?: Date | null } = {},
): Promise<{ stale: string[]; failing: string[] }> {
  const now = options.now ?? new Date();
  const queues = schedules.map((schedule) => schedule.queue);
  const runs = await readQueueRuns(queues);
  const stale = staleScheduledQueues(schedules, runs, now, options.bootedAt ?? null);
  for (const item of stale.filter((entry) => entry.raise)) {
    await raiseOperationalAlertOnce(
      `⏰ Tarefa agendada parada · ${item.queue}\n`
        + `Ela deveria ter concluído nos últimos ${item.toleranceMinutes} min. ${describeLastRun(item.lastCompletedAt, now)}\n`
        + "👉 Veja no log do worker se ela falha ou se ficou presa, e em pgboss.schedule se o agendamento existe. "
        + "O aviso fecha sozinho quando ela voltar a concluir.",
      {
        source: SCHEDULE_STALE_ALERT_SOURCE,
        key: item.queue,
        title: `Tarefa agendada parada: ${item.queue}`,
        resource: "pgboss-queue",
        resourceId: item.queue,
        evidence: {
          queue: item.queue,
          lastCompletedAt: item.lastCompletedAt?.toISOString() ?? null,
          toleranceMinutes: item.toleranceMinutes,
        },
      },
    );
  }
  await reconcileOperationalActionSource(SCHEDULE_STALE_ALERT_SOURCE, stale.map((item) => item.queue), now);

  const lastCompleted = new Map(runs.map((run) => [run.name, run.lastCompletedAt]));
  const failing = [...(await readLastTickDiscards(queues, now))]
    .filter(([queue, discardedAt]) => {
      const completedAt = lastCompleted.get(queue);
      return !completedAt || completedAt < discardedAt;
    })
    .map(([queue]) => queue);
  await reconcileOperationalActionSource(SCHEDULED_FAILURE_ALERT_SOURCE, failing, now);

  if (stale.length > 0) log.warn({ stale: stale.map((item) => item.queue) }, "tarefas agendadas sem concluir além da tolerância");
  return { stale: stale.map((item) => item.queue), failing };
}
