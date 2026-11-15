import type { PgBoss } from "pg-boss";
import { autoResolveStaleOperationalAlerts, sendOperationalAlert } from "@/src/services/ops/alerts";
import { prisma } from "@/src/infra/prisma";
import { createLogger } from "@/src/infra/logger";
import { QUEUES } from "@/src/infra/queue-contract";
import type { WorkerInstance } from "@/src/infra/worker-instance";
import { watchScheduledJobs } from "@/src/services/ops/scheduled-job-watch";
import { workObserved } from "@/src/services/ops/telemetry";
import { SCHEDULE_MANIFEST } from "@/src/jobs/schedules";

const log = createLogger("worker");

/** Instalar somente depois da inicialização completa. O pg-boss grava a prova
 * em output junto com a conclusão do job, sem tabela ou escrita adicional. */
export async function startWorkerHeartbeat(boss: PgBoss, instance: WorkerInstance) {
  await workObserved(boss, QUEUES.healthHeartbeat, async () => {
    await prisma.$queryRaw`SELECT 1`;
    try {
      await autoResolveStaleOperationalAlerts();
    } catch (err) {
      log.error({ err }, "auto-resolve de alertas falhou — heartbeat segue");
      await sendOperationalAlert(
        "⚠️ Avisos de provider podem chegar atrasados\n"
          + "O heartbeat não conseguiu liberar o silêncio dos avisos de provider que já voltaram ao normal; "
          + "se o mesmo provider falhar de novo, o Telegram pode demorar a avisar (a caixa de ações continua registrando).\n"
          + `Erro: ${err instanceof Error ? err.message : String(err)}\n`
          + "👉 Se repetir, veja o log do worker (heartbeat).",
        { source: "ops.auto-resolve", key: "auto-resolve-stale-alerts", title: "Auto-resolve de alertas operacionais falhando", resource: "ops.alert", autoResolve: true },
      ).catch((alertErr) => log.error({ err: alertErr }, "falha ao alertar auto-resolve travado"));
    }
    // O heartbeat vigia as outras filas agendadas; ele mesmo é vigiado pelo /api/health.
    try {
      const readyAt = instance.proof()?.workerInstance.readyAt;
      await watchScheduledJobs(SCHEDULE_MANIFEST.filter((item) => item.queue !== QUEUES.healthHeartbeat), {
        bootedAt: readyAt ? new Date(readyAt) : null,
      });
    } catch (err) {
      log.error({ err }, "vigia das tarefas agendadas falhou — heartbeat segue");
    }
    log.info("heartbeat: worker vivo, banco acessível");
    // Se começou a encerrar durante o handler, não publica prova de prontidão.
    return instance.proof();
  });
}
