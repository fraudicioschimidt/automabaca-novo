import "dotenv/config";
import type { PgBoss } from "pg-boss";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { createBoss } from "@/src/infra/boss";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { disconnectPrisma, pgPool } from "@/src/infra/prisma";
import { assertRuntimeConnectionIsUnprivileged } from "@/src/infra/runtime-db-role";
import {
  acquireWorkerSingletonLock,
  type WorkerLockRelease,
} from "@/src/infra/worker-singleton";
import { QUEUES } from "@/src/infra/queue-contract";
import { tunePgBossCronDispatchRetention } from "@/src/jobs/queues";
import { startTelegramBot } from "@/src/telegram/bot";
import {
  shutdownWorkerResources,
  WORKER_SHUTDOWN_BUDGET_MS,
} from "@/src/jobs/worker-lifecycle";
import {
  installScheduleManifest,
  readLastCronPass,
  reportMissedScheduleTicks,
  verifyScheduleManifest,
} from "@/src/jobs/schedules";
import { registerWorkerJobs } from "@/src/jobs/worker-jobs";
import { errorMessageWithCode } from "@/src/infra/error-details";
import { geminiConfigured } from "@/src/infra/llm/gemini";
import { groqConfigured } from "@/src/infra/llm/groq";
import { mistralConfigured } from "@/src/infra/llm/mistral";
import { beginWorkerInstance, type WorkerInstance } from "@/src/infra/worker-instance";
import { startWorkerHeartbeat } from "@/src/jobs/worker-heartbeat";
import { startWorkerSelfWatch, type WorkerSelfWatch } from "@/src/jobs/worker-self-watch";
import { recordReleaseReady } from "@/src/services/ops/release-verdict";

const log = createLogger("worker");

/**
 * Processo único de jobs do AutomaBACA (container `automabaca-novo-worker`):
 * lock singleton, filas de `WORKER_JOBS`, manifesto de agendamentos, bot do
 * Telegram e SIGTERM gracioso. Job novo entra em `worker-jobs.ts`.
 */

// ── Shutdown: handlers instalados ANTES de qualquer boot assíncrono — um
// SIGTERM no meio do boot (timing comum em deploy/reload) também sai limpo.
let bossRef: PgBoss | null = null;
let releaseSingletonLock: WorkerLockRelease | null = null;
let shuttingDown = false;
let instance: WorkerInstance | null = null;
let selfWatch: WorkerSelfWatch | null = null;

function stopInstanceHealth() {
  selfWatch?.stop().catch((err: unknown) => log.warn({ err }, "falha ao fechar a conexão da vigia do worker"));
  try { instance?.stop(); }
  catch (err) { log.error({ err }, "falha ao retirar marcador de saúde do worker"); }
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  stopInstanceHealth();
  log.info({ signal }, "encerrando worker — parando filas e drenando conexões");
  const limpo = await Promise.race([
    shutdownWorkerResources({
      boss: bossRef,
      releaseSingletonLock,
      disconnect: disconnectPrisma,
      log,
    }).then(() => true),
    new Promise<false>((resolve) => {
      // `unref` para o timer não segurar o processo se o shutdown terminar antes.
      setTimeout(() => resolve(false), WORKER_SHUTDOWN_BUDGET_MS).unref();
    }),
  ]);
  if (!limpo) {
    log.error(
      { signal, budgetMs: WORKER_SHUTDOWN_BUDGET_MS },
      "shutdown estourou o orçamento — saindo com erro antes do SIGKILL do Docker",
    );
    process.exit(1);
  }
  log.info("worker encerrado limpo");
  process.exit(exitCode);
}

function onSignal(signal: string, exitCode = 0): void {
  shutdown(signal, exitCode).catch((err) => {
    log.error({ err }, "falha no shutdown — saindo com erro");
    process.exit(1);
  });
}

process.once("SIGTERM", () => onSignal("SIGTERM"));
process.once("SIGINT", () => onSignal("SIGINT"));
// Sem estes, o Node sai na hora e os jobs em voo ficam `active`, travando as
// filas `exclusive` até expirarem: o desligamento os devolve antes de sair.
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "exceção não tratada — encerrando o worker");
  onSignal("UNCAUGHT_EXCEPTION", 1);
});
process.on("unhandledRejection", (reason) => {
  log.fatal({ err: reason }, "promessa rejeitada sem tratamento — encerrando o worker");
  onSignal("UNHANDLED_REJECTION", 1);
});

async function main(): Promise<void> {
  instance = beginWorkerInstance();
  const env = getEnv(); // fail-fast: ambiente inválido derruba o boot com a lista de problemas
  if (
    env.NODE_ENV === "production" &&
    !geminiConfigured() &&
    !groqConfigured() &&
    !mistralConfigured()
  ) {
    throw new Error("Nenhum provider LLM configurado; captura fallback e IA-Judge ficariam inoperantes.");
  }
  // O worker lê post, saída de LLM e liquida: com role privilegiada, um defeito
  // aqui alcançaria o cluster. Falha antes do lock, do pg-boss e do bot.
  await assertRuntimeConnectionIsUnprivileged(pgPool);

  releaseSingletonLock = await acquireWorkerSingletonLock({
    onLost: () => {
      log.fatal("lock singleton perdido — encerrando para o Docker re-subir limpo");
      onSignal("LOCK_LOST", 1);
    },
  });
  if (shuttingDown) return;

  // O último ciclo do cron do processo anterior, antes que o deste o sobrescreva.
  const lastCronPass = await readLastCronPass();
  const bootedAt = new Date();
  const boss = createBoss();
  bossRef = boss;
  await boss.start();
  if (shuttingDown) return; // sinal chegou durante o start
  log.info("pg-boss iniciado");
  // O agendamento que o primeiro ciclo do cron usa é o gravado pelo boot anterior.
  let storedSchedules: Awaited<ReturnType<PgBoss["getSchedules"]>> = [];
  try {
    storedSchedules = await boss.getSchedules();
  } catch (err) {
    log.warn({ err }, "não li os agendamentos gravados; o registro de disparo perdido fica sem esse dado");
  }

  // Só retenção: falhar aqui não pode derrubar captura, fechamento e liquidação.
  await tunePgBossCronDispatchRetention(boss).catch((err: unknown) => {
    log.warn({ err }, "não ajustei a retenção da fila de disparo dos crons; segue com a do pg-boss");
  });
  await registerWorkerJobs(boss);

  // Manifesto único: instala e lê de volta antes de declarar o worker pronto.
  await installScheduleManifest(boss);
  await verifyScheduleManifest(boss);
  reportMissedScheduleTicks({ lastCronPass, bootedAt, storedSchedules });

  // ── Telegram: webhook e fila ordenada por post ──
  await startTelegramBot(boss);

  // Só publica prova de vida depois de filas, schedules e Telegram estarem
  // prontos. Se qualquer etapa anterior falhar, o health não ganha um verde
  // enganoso deste processo incompleto.
  if (shuttingDown) return;
  instance.ready();
  await startWorkerHeartbeat(boss, instance);
  if (shuttingDown) return;
  await boss.send(QUEUES.healthHeartbeat, null);
  if (shuttingDown) return;
  // Sem prova de vida além do limite, o worker sai com 1 e o Docker sobe outro.
  selfWatch = startWorkerSelfWatch(instance, { onStale: () => onSignal("HEARTBEAT_STALE", 1) });
  log.info({ eventCode: LOG_EVENTS.RELEASE_READY }, "worker pronto — filas registradas");
  // Início da observação da release (`ops.release_verdict`). Sem o registro a
  // release fica sem veredito, e isso não vale derrubar um worker pronto.
  await recordReleaseReady({ bootedAt }).catch((err: unknown) => {
    log.error({ err }, "não registrei a release pronta; ela fica sem veredito");
  });
}

main().catch(async (err) => {
  if (shuttingDown) {
    // Um sinal já está drenando, e o pg-boss parado faz o próximo `boss.work`
    // do boot lançar: não é falha de boot, e o shutdown em curso sai sozinho.
    log.warn({ err }, "boot interrompido pelo encerramento em andamento");
    return;
  }
  stopInstanceHealth();
  log.fatal({ err }, "worker falhou no boot");
  await sendOperationalAlert(
    `🛑 O worker não conseguiu iniciar\nErro: ${errorMessageWithCode(err)}\n`
      + "Sem worker não há captura, fechamento nem liquidação; o Docker tenta subir de novo sozinho.\n"
      + "👉 Se repetir, confira o /api/health e o log do worker; se veio com a última release, publique a anterior.",
    {
      source: "worker.boot",
      key: "boot-failure",
      title: "Worker falhou no boot",
      resource: "worker",
      autoResolve: false,
    },
  ).catch((alertErr) => log.error({ err: alertErr }, "falha ao enviar alerta de boot"));
  // Os consumidores podem já estar ligados: parar o pg-boss devolve os jobs em
  // voo, que senão ficam `active` e travam as filas exclusive até expirar.
  onSignal("BOOT_FAILURE", 1);
});
