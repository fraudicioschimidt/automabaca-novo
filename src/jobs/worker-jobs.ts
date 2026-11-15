import type { Job, PgBoss, SendOptions } from "pg-boss";
import { cronMaxGapMinutes } from "@/src/domain/cron-cadence";
import { classifyDlqError, isDatabaseFailure } from "@/src/domain/dlq-classification";
import { createLogger } from "@/src/infra/logger";
import { QUEUES, type QueueName, type QueueOptions } from "@/src/infra/queue-contract";
import { registerQueue, scheduledJobRetentionSeconds } from "@/src/jobs/queues";
import {
  checkFinancialConsistency,
  checkObservability,
  checkReviewConsistency,
  closeStaleTrainingCases,
  dispatchOutbox,
  purgeExpiredRecords,
  reconcileOperationalInbox,
} from "@/src/jobs/maintenance-jobs";
import {
  CLOSING_SYNC_BUDGET_MS,
  enrichBets,
  reviveSharpEnrich,
  syncClosings,
  watchClosingSeries,
} from "@/src/jobs/sharp-jobs";
import { notifySportResolutionGaveUp, resolveBetSports } from "@/src/jobs/sport-resolution-jobs";
import { sendExecutiveBriefing } from "@/src/services/ops/digests/executive-briefing";
import { sendHealthDigest } from "@/src/services/ops/digests/health-digest";
import { sendPendingDigest } from "@/src/services/ops/digests/pending-digest";
import { sendRelatorioInferencia } from "@/src/services/ops/digests/relatorio-inferencia";
import { sendWeeklyChannelDigest, WEEKLY_CHANNEL_DIGEST_CRON } from "@/src/services/ops/digests/weekly-channel-digest";
import { scheduledDeadLetterPolicy } from "@/src/services/ops/dlq/handler";
import { workObserved } from "@/src/services/ops/telemetry";
import { runPlayerPropsMaintenance } from "@/src/services/players/maintenance";
import { runFlashscoreObservationOnce } from "@/src/services/settlement/flashscore/observation";
import { runIaJudgeCycle } from "@/src/services/settlement/ia-judge/cycle";
import { runFlashscoreRecheckOnce } from "@/src/services/settlement/flashscore/recheck";
import { maintainClosingSeries } from "@/src/services/sharp/closing/series";
import { markEnrichDeadLettered } from "@/src/services/sharp/enrich/upsert-sharp";
import { runBridgePostgameOnce } from "@/src/services/sharp/bridge-postgame";
import { evaluateSegmentPolicies } from "@/src/services/sharp/segment-policy";
import { runSilenceWatch } from "@/src/services/capture/channel/channel-activity";
import { judgePendingReleases } from "@/src/services/ops/release-verdict";
import { runCatalogPairingRound } from "@/src/services/teams/catalog-pairing-round";

const log = createLogger("worker-maintenance");

type WorkOptions = NonNullable<Parameters<typeof workObserved>[3]>;

export type WorkerJob = {
  queue: QueueName;
  /** Retry, backoff, policy e tratamento extra da dead-letter. */
  queueOptions: QueueOptions;
  /** Cron no horário de São Paulo; entra no manifesto que o boot instala e confere. */
  schedule?: { cron: string; purpose: string };
  /** Ausente só no heartbeat, cujo consumidor sobe depois do worker pronto. */
  handler?: (jobs: Job[], boss: PgBoss) => Promise<unknown>;
  work?: WorkOptions;
  /** Enfileira uma execução no boot, sem esperar o primeiro cron. */
  runOnBoot?: SendOptions;
};

/**
 * Espera esperada de provider (circuito aberto, Pinnacle ainda sem o jogo):
 * a retentativa é o caminho normal e não conta como erro da fila. Falha do
 * banco também é retentada, mas conta como erro no SLO e vai ao log com código
 * e mensagem: é sinal de pool, lock ou banco fora, e não pode sumir.
 */
const isTransientFailure = (error: unknown) =>
  classifyDlqError(error) === "transient" && !isDatabaseFailure(error);

/**
 * As candidatas do IA-Judge são avaliadas em série, e o LLM degradado leva
 * minutos em cada uma: aos 30 min a rodada para de pegar candidata, antes do
 * teto de 40 da fila.
 */
const IA_JUDGE_BUDGET_MS = 30 * 60_000;

/**
 * O sinal do job (expirou, ou o worker está encerrando) junto com o prazo
 * próprio da rodada, que tem de ser menor que o `expireInSeconds` da fila: a
 * rodada para sozinha antes de o pg-boss a dar por perdida.
 */
function roundSignal(jobs: Job[], budgetMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(budgetMs);
  const jobSignal = jobs[0]?.signal;
  return jobSignal ? AbortSignal.any([jobSignal, deadline]) : deadline;
}

/**
 * Toda fila que o worker consome, na ordem de registro do boot. Daqui saem a
 * topologia (fila + DLQ + política de retry), os consumidores e o manifesto de
 * agendamentos. As filas do Telegram ficam em `telegram/bot.ts`, que sobe
 * depois do manifesto porque depende do bot.
 *
 * Os crons de 5 a 20 minutos se espalham pelos minutos da hora: alinhados,
 * disputariam o pool do banco no mesmo segundo. Cada família de minuto (o
 * resto por 5) tem no máximo um cron de 5 em 5 e outro mais espaçado:
 * `closing.sync` (0) com o vigia de canal, `sharp.revive` (1) com os
 * resultados, a caixa de ações (2) com a busca pós-jogo na Bridge, o
 * heartbeat (4) com os SLOs e o veredito das releases (3), sozinho.
 */
export const WORKER_JOBS: readonly WorkerJob[] = [
  {
    queue: QUEUES.healthHeartbeat,
    queueOptions: { retryLimit: 1, policy: "exclusive" },
    schedule: { cron: "4-59/5 * * * *", purpose: "prova de vida do worker" },
  },
  {
    queue: QUEUES.outboxDispatch,
    queueOptions: { retryLimit: 2, policy: "exclusive" },
    schedule: { cron: "* * * * *", purpose: "despacho da outbox persistente" },
    handler: (_jobs, boss) => dispatchOutbox(boss),
  },
  {
    queue: QUEUES.sportResolve,
    queueOptions: {
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      policy: "exclusive",
      onDeadLetter: notifySportResolutionGaveUp,
    },
    handler: resolveBetSports,
    work: { includeMetadata: true },
  },
  {
    queue: QUEUES.sharpEnrich,
    queueOptions: {
      // Espera de 60s que dobra até o teto de 30min. Quem cai aqui são as
      // apostas recém-capturadas, as mais sensíveis a CLV, e o erro mais comum
      // é o worker sair no meio de um deploy: esperar 30min já na primeira
      // tentativa seguraria a aposta fresca sem motivo. O teto mantém a cauda
      // em 30min (sem ele, 12 retries chegariam a ~68h).
      retryLimit: 12,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 1800,
      policy: "exclusive",
      onDeadLetter: async (data) => {
        const { betId } = data as { betId?: string };
        if (betId) await markEnrichDeadLettered(betId);
      },
    },
    handler: enrichBets,
    work: { localConcurrency: 2, isExpectedRetry: isTransientFailure },
  },
  {
    queue: QUEUES.sharpRevive,
    queueOptions: { retryLimit: 1, policy: "exclusive" },
    // O cron é o piso da cadência de `enrich-cadence.ts`: com o catálogo do dia
    // a tentativa extra é gratuita, e o caro era a espera para casar identidade.
    schedule: { cron: "1-59/5 * * * *", purpose: "repescagem pré-Pinnacle" },
    handler: (_jobs, boss) => reviveSharpEnrich(boss),
  },
  {
    queue: QUEUES.closingSeries,
    queueOptions: { retryLimit: 0, policy: "exclusive" },
    handler: watchClosingSeries,
    work: { localConcurrency: 3 },
  },
  {
    queue: QUEUES.closingSeriesSweep,
    queueOptions: { retryLimit: 0, policy: "exclusive" },
    schedule: { cron: "* * * * *", purpose: "recuperação da agenda de fechamento pré-jogo" },
    handler: (_jobs, boss) => maintainClosingSeries(boss),
    runOnBoot: {},
  },
  {
    queue: QUEUES.closingSync,
    // O ciclo se encerra sozinho aos 4 min (`CLOSING_SYNC_BUDGET_MS`); o teto
    // de 10 deixa terminar a consulta em voo e a manutenção do arquivo.
    queueOptions: { retryLimit: 2, retryDelay: 120, policy: "exclusive", expireInSeconds: 600 },
    schedule: { cron: "*/5 * * * *", purpose: "fechamento e CLV depois do kickoff, e o arquivo de preços" },
    handler: (jobs) => syncClosings(roundSignal(jobs, CLOSING_SYNC_BUDGET_MS)),
  },
  {
    queue: QUEUES.bridgePostgame,
    // Cada consulta espera o portão de ~40 s da BridgeOdds. O teto de 20 min
    // vale junto com o prazo da rodada (`POSTGAME_STOP_TAKING_AFTER_MS`): o
    // lote que não cabe fica para a rodada seguinte, e nunca rodam duas ao
    // mesmo tempo.
    queueOptions: { retryLimit: 1, retryDelay: 600, policy: "exclusive", expireInSeconds: 1200 },
    schedule: { cron: "2-59/20 * * * *", purpose: "abertura e fechamento na BridgeOdds depois do jogo" },
    handler: (jobs) => runBridgePostgameOnce({ signal: jobs[0]?.signal }),
  },
  {
    queue: QUEUES.policyEvaluate,
    queueOptions: { retryLimit: 2, retryDelay: 300, policy: "exclusive" },
    // Um segmento só é julgado com 100 apostas com fechamento: uma passada por
    // dia muda a fase no máximo um dia depois.
    schedule: { cron: "45 5 * * *", purpose: "avaliação de probation" },
    handler: () => evaluateSegmentPolicies(),
  },
  {
    queue: QUEUES.consistencyFinancial,
    queueOptions: { retryLimit: 2, retryDelay: 300, policy: "exclusive" },
    schedule: { cron: "40 3 * * *", purpose: "consistência diária do dinheiro" },
    handler: () => checkFinancialConsistency(),
  },
  {
    queue: QUEUES.consistencyReview,
    queueOptions: { retryLimit: 2, retryDelay: 300, policy: "exclusive" },
    schedule: { cron: "45 3 * * *", purpose: "revisão diária de catálogo e escritas" },
    handler: () => checkReviewConsistency(),
  },
  {
    queue: QUEUES.healthDigest,
    queueOptions: { retryLimit: 2, retryDelay: 300, policy: "exclusive" },
    schedule: { cron: "0 8 * * *", purpose: "digest diário de saúde da captura" },
    handler: async () => {
      const digest = await sendHealthDigest();
      log.info({ ...digest }, "digest de saúde da captura");
    },
  },
  {
    queue: QUEUES.pendingDigest,
    queueOptions: { retryLimit: 2, retryDelay: 300, policy: "exclusive" },
    schedule: { cron: "0 11 * * *", purpose: "digest diário das apostas pendentes com jogo encerrado" },
    handler: () => sendPendingDigest(),
  },
  {
    queue: QUEUES.trainingCasesCleanup,
    queueOptions: { retryLimit: 2, retryDelay: 300, policy: "exclusive" },
    // De madrugada, fora do pico: nada depende da hora exata, e a caixa de
    // ações da manhã já chega sem os casos vencidos.
    schedule: { cron: "50 3 * * *", purpose: "fecha os casos de treino de jogo antigo ou de aposta removida" },
    handler: () => closeStaleTrainingCases(),
  },
  {
    queue: QUEUES.executiveBriefing,
    queueOptions: { retryLimit: 2, retryDelay: 300, policy: "exclusive" },
    // Logo depois da meia-noite, sobre o dia que terminou: assim a aposta
    // liquidada na última hora do dia entra no resumo dele.
    schedule: { cron: "5 0 * * *", purpose: "briefing executivo do dia anterior no Telegram" },
    handler: () => sendExecutiveBriefing(),
  },
  {
    queue: QUEUES.weeklyChannelDigest,
    queueOptions: { retryLimit: 2, retryDelay: 300, policy: "exclusive" },
    // Segunda de manhã, sobre os 7 dias até o disparo: a retentativa refaz o
    // mesmo disparo e não manda um segundo boletim.
    schedule: { cron: WEEKLY_CHANNEL_DIGEST_CRON, purpose: "boletim semanal dos canais no Telegram" },
    handler: () => sendWeeklyChannelDigest(),
  },
  {
    queue: QUEUES.iaJudge,
    queueOptions: { retryLimit: 2, retryDelay: 300, policy: "exclusive", expireInSeconds: 2400 },
    schedule: { cron: "15 1-23/2 * * *", purpose: "ciclo do IA-Judge com auto-liquidação" },
    handler: (jobs) => runIaJudgeCycle(new Date(), {
      includeStalled: true, autoSettle: true, signal: roundSignal(jobs, IA_JUDGE_BUDGET_MS),
    }),
  },
  {
    queue: QUEUES.flashscoreResults,
    queueOptions: { retryLimit: 2, retryDelay: 300, policy: "exclusive" },
    // Única API de resultados: precisa de várias passadas enquanto as partidas
    // terminam. Cada ciclo custa ~1 chamada por esporte×dia (payload reutilizado
    // entre apostas). Casado com `OBSERVATION_RETRY_MS`, que é quem limita a
    // repescagem por aposta.
    schedule: { cron: "1-59/10 * * * *", purpose: "resultados FlashScore" },
    handler: async () => {
      await runFlashscoreObservationOnce();
      await runPlayerPropsMaintenance();
    },
  },
  {
    queue: QUEUES.flashscoreRecheck,
    // A janela de 15 dias e a marca `recheck` tornam a repetição idempotente.
    queueOptions: { retryLimit: 2, retryDelay: 600, policy: "exclusive" },
    // 07:10 e 07:40 de São Paulo, nesta ordem: a rechecagem descobre a
    // divergência e o relatório a leva no resumo do mesmo dia.
    schedule: { cron: "10 7 * * *", purpose: "rechecagem das liquidações por inferência" },
    handler: async () => {
      const run = await runFlashscoreRecheckOnce();
      log.info(run, "rechecagem das liquidações por inferência");
    },
  },
  {
    queue: QUEUES.flashscoreInferenceReport,
    queueOptions: { retryLimit: 2, retryDelay: 300, policy: "exclusive" },
    schedule: { cron: "40 7 * * *", purpose: "relatório diário das liquidações por inferência" },
    handler: async () => {
      const relatorio = await sendRelatorioInferencia();
      log.info(relatorio, "relatório de liquidações por inferência");
    },
  },
  {
    queue: QUEUES.observabilitySlo,
    queueOptions: { retryLimit: 1, policy: "exclusive" },
    schedule: { cron: "4-59/15 * * * *", purpose: "avaliação dos SLOs" },
    handler: () => checkObservability(),
  },
  {
    queue: QUEUES.operationalActions,
    queueOptions: { retryLimit: 2, policy: "exclusive" },
    schedule: { cron: "2-59/5 * * * *", purpose: "reconciliação da inbox operacional" },
    handler: (_jobs, boss) => reconcileOperationalInbox(boss, discardableScheduledQueueNames()),
    runOnBoot: {},
  },
  {
    queue: QUEUES.telegramSilenceWatch,
    queueOptions: { retryLimit: 1, policy: "exclusive" },
    schedule: { cron: "5-59/15 * * * *", purpose: "canal do Telegram calado e bot sem receber" },
    handler: () => runSilenceWatch(),
  },
  {
    queue: QUEUES.releaseVerdict,
    queueOptions: { retryLimit: 1, policy: "exclusive" },
    // A release fica 45 min em observação: de 15 em 15, o veredito sai entre
    // 45 min e 1 h depois de ela ficar pronta.
    schedule: { cron: "3-59/15 * * * *", purpose: "veredito das releases: erro novo junto com cada uma" },
    handler: async () => {
      const result = await judgePendingReleases();
      if (result.judged + result.notified > 0) log.info(result, "veredito das releases");
    },
  },
  {
    queue: QUEUES.teamsCatalogPairing,
    queueOptions: { retryLimit: 1, retryDelay: 600, policy: "exclusive" },
    // Fora do minuto cheio e das horas dos resumos; quatro vezes pegam os
    // jogos que a Pinnacle17 lista ao longo do dia antes de começarem.
    schedule: { cron: "37 8,12,16,20 * * *", purpose: "pareamento dos catálogos Pinnacle17 × FlashScore (só grava)" },
    handler: async () => {
      const round = await runCatalogPairingRound();
      log.info(round, "pareamento dos catálogos");
    },
  },
  {
    queue: QUEUES.auditPurge,
    queueOptions: { retryLimit: 1, policy: "exclusive" },
    schedule: { cron: "20 2 * * *", purpose: "retenção de auditoria, métricas e caches" },
    handler: () => purgeExpiredRecords(),
  },
];

/**
 * Opções efetivas da fila: a de cron leva o intervalo dela (que decide o
 * destino da dead-letter) e a mesma retenção do agendamento, que vale também
 * para o disparo de boot.
 */
export function effectiveQueueOptions(job: WorkerJob): QueueOptions {
  if (!job.schedule) return job.queueOptions;
  return {
    ...job.queueOptions,
    cronMaxGapMinutes: cronMaxGapMinutes(job.schedule.cron),
    deleteAfterSeconds: scheduledJobRetentionSeconds(job.schedule.cron),
  };
}

/**
 * Filas de cron curto: a dead-letter delas sai sem voltar à fila, e a
 * reconciliação descarta a que ficou retida. A de cron longo volta à fila.
 */
export function discardableScheduledQueueNames(): string[] {
  return WORKER_JOBS.flatMap((job) =>
    job.schedule && scheduledDeadLetterPolicy(cronMaxGapMinutes(job.schedule.cron)) === "discard" ? [job.queue] : []);
}

const roundsInProgress = new Set<QueueName>();

/**
 * Uma rodada por vez em cada cron. O handler que passa do `expireInSeconds`
 * continua rodando depois que o pg-boss o dá por perdido, e a retentativa (ou
 * o disparo seguinte) começaria outra em cima dele: a que chega com a
 * anterior em andamento conclui sem rodar. O worker é um processo só (lock
 * singleton), então a trava do processo basta. O erro da rodada já abandonada
 * não chega mais ao pg-boss e fica no log.
 */
function oneRoundAtATime(queue: QueueName, handler: NonNullable<WorkerJob["handler"]>): NonNullable<WorkerJob["handler"]> {
  return async (jobs, boss) => {
    if (roundsInProgress.has(queue)) {
      log.warn({ queue }, "rodada anterior ainda em andamento depois do teto da fila — esta não roda");
      return undefined;
    }
    roundsInProgress.add(queue);
    const startedAt = Date.now();
    const expireMs = Math.max(0, ...jobs.map((job) => job.expireInSeconds)) * 1000;
    try {
      return await handler(jobs, boss);
    } catch (err) {
      if (expireMs > 0 && Date.now() - startedAt >= expireMs) {
        log.error({ err, queue, elapsedMs: Date.now() - startedAt },
          "rodada falhou depois do teto da fila — o pg-boss já a tinha dado por perdida");
      }
      throw err;
    } finally {
      roundsInProgress.delete(queue);
    }
  };
}

/** Cria cada fila com sua DLQ e liga o consumidor observado, na ordem da tabela. */
export async function registerWorkerJobs(boss: PgBoss): Promise<void> {
  for (const job of WORKER_JOBS) {
    await registerQueue(boss, job.queue, effectiveQueueOptions(job));
    if (!job.handler) continue;
    const handler = job.schedule ? oneRoundAtATime(job.queue, job.handler) : job.handler;
    await workObserved(boss, job.queue, (jobs) => handler(jobs, boss), job.work);
    if (job.runOnBoot) await boss.send(job.queue, null, job.runOnBoot);
  }
}
