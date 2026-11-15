import { Bot, BotError, GrammyError, HttpError } from "grammy";
import type { Update } from "grammy/types";
import type { Job, JobResult, PgBoss } from "pg-boss";
import {
  InvalidTelegramJobError,
  parseMediaAlbumFlushJob,
  parseTelegramJob,
  type TelegramJob,
} from "@/src/domain/telegram-job";
import { getEnv } from "@/src/infra/env";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { privacyHash } from "@/src/infra/privacy";
import { QUEUES, type QueueOptions } from "@/src/infra/queue-contract";
import { registerQueue } from "@/src/jobs/queues";
import { isLastTelegramAttempt } from "@/src/services/ops/dlq/handler";
import { workObserved } from "@/src/services/ops/telemetry";
import { MediaAlbumWinnerChangedError } from "@/src/services/capture/channel/capture-new";
import { completeMediaAlbum } from "@/src/services/capture/channel/media-album";
import { MediaAlbumCaptionPendingError, processTelegramDeferredJob } from "./deferred";
import { registerCaptureFixHandlers } from "./capture-fix";
import { registerDmCallbackHandler } from "./dm";
import { registerTelegramLiveHandlers } from "./live-handlers";
import { TelegramParseRetryError } from "@/src/services/capture/reading/retry-error";
import { logAndScheduleFollowups, processTelegramJob, telegramLogContext, type TelegramJobContext } from "./processing";
import { startWebhookHealthCheck } from "./webhook-health";

const log = createLogger("telegram");

const TELEGRAM_ALLOWED_UPDATES = [
  "channel_post",
  "edited_channel_post",
  "message_reaction",
  "message_reaction_count",
  "message",
  "callback_query",
] as const;

/**
 * Bot do AutomaBACA dentro do worker, só por webhook: a rota web põe o update
 * em `telegram.updates` e o worker o processa ali, na ordem de cada post. Falha volta pelo retry da fila e, esgotada, vai para a
 * dead-letter com aviso ao dono.
 */
export async function startTelegramBot(boss: PgBoss): Promise<void> {
  const env = getEnv();
  const token = env.TELEGRAM_TOKEN;
  if (!token) {
    log.warn("TELEGRAM_TOKEN ausente — worker sobe sem o módulo Telegram");
    return;
  }
  // A validação do env já exige os dois com o token; sem eles o bot não teria
  // como receber nada, e apagar o webhook tiraria a produção do ar.
  if (!env.TELEGRAM_WEBHOOK_URL || !env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error("TELEGRAM_WEBHOOK_URL e TELEGRAM_WEBHOOK_SECRET são obrigatórios com TELEGRAM_TOKEN");
  }

  const bot = new Bot(token);
  // Fora do bot.start(), o grammY não inicializa o bot antes de handleUpdate.
  // Falhar no boot é mais seguro do que aceitar updates que ficariam presos.
  await initWithinBootTimeout(bot);

  // Filas e handlers existem antes de qualquer consumidor: um update pendente
  // pode ser entregue durante boss.work().
  await registerTelegramQueues(boss);
  const context: TelegramJobContext = { api: bot.api, boss, token };
  // Antes do botão e da mensagem da DM: o clique `fx:` e a resposta a uma
  // pergunta de conserto não são escolha de banca nem aposta nova.
  registerCaptureFixHandlers(bot, boss);
  registerDmCallbackHandler(bot, boss, token);
  registerTelegramLiveHandlers(bot, context);

  await startTelegramWorkers(bot, context);
  const webhookUrl = env.TELEGRAM_WEBHOOK_URL;
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
  await withTelegramBootRetry(() => bot.api.setWebhook(webhookUrl, {
    secret_token: webhookSecret,
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    drop_pending_updates: false,
  }));
  log.info({ username: bot.botInfo.username, webhookUrl: env.TELEGRAM_WEBHOOK_URL }, "bot em webhook persistente");
  startWebhookHealthCheck(bot.api, env.TELEGRAM_WEBHOOK_URL);
}

/**
 * Quanto o boot espera o Telegram. O `init` do grammY repete sem limite
 * enquanto a rede falha: com o Telegram fora, o boot ficaria parado ali, sem
 * prova de vida e sem a autocura. No prazo, o boot falha, avisa e o Docker
 * sobe o worker de novo.
 */
const TELEGRAM_BOOT_TIMEOUT_MS = 60_000;
const TELEGRAM_BOOT_ATTEMPTS = 3;
const TELEGRAM_BOOT_RETRY_DELAY_MS = 2_000;

async function initWithinBootTimeout(bot: Bot): Promise<void> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TELEGRAM_BOOT_TIMEOUT_MS);
  try {
    // O grammY tipa o sinal pelo shim `abort-controller`; em runtime é o nativo.
    await bot.init(timeout.signal as Parameters<Bot["init"]>[0]);
  } catch (error) {
    if (!timeout.signal.aborted) throw error;
    throw new Error(`Telegram não respondeu ao getMe em ${TELEGRAM_BOOT_TIMEOUT_MS / 1000}s no boot`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** Falha de rede, 5xx e 429 do Telegram passam sozinhos; o resto (token, URL recusada) não muda repetindo. */
function isTransientTelegramError(error: unknown): boolean {
  if (error instanceof HttpError) return true;
  return error instanceof GrammyError && (error.error_code >= 500 || error.error_code === 429);
}

/** Um erro pontual numa chamada do boot não vira falha de boot e reinício do worker. */
async function withTelegramBootRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= TELEGRAM_BOOT_ATTEMPTS || !isTransientTelegramError(error)) throw error;
      log.warn({ err: error, attempt }, "chamada do Telegram falhou no boot — tentando de novo");
      await new Promise((resolve) => setTimeout(resolve, TELEGRAM_BOOT_RETRY_DELAY_MS));
    }
  }
}

/** Topologia das filas do Telegram; os testes de banco criam as filas com estas mesmas opções. */
export const TELEGRAM_QUEUE_OPTIONS = {
  // Espera curta no começo (rede, Telegram) e teto de 4 min; a chave do post
  // fica presa durante o retry, então o próximo update do mesmo post espera.
  [QUEUES.telegramUpdates]: {
    retryLimit: 4,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 240,
    policy: "key_strict_fifo",
    heartbeatSeconds: 30,
    // Foto com OCR e resolução de esporte cabe com folga.
    expireInSeconds: 600,
  },
  // 3 esperas pela legenda do álbum (MEDIA_ALBUM_FLUSH_MAX_DEFERRALS) +
  // 3 retries preservados para falhas reais da captura.
  [QUEUES.telegramDeferred]: { retryLimit: 6, retryDelay: 8, retryBackoff: false, policy: "exclusive" },
} as const satisfies Record<string, QueueOptions>;

async function registerTelegramQueues(boss: PgBoss): Promise<void> {
  for (const [queue, options] of Object.entries(TELEGRAM_QUEUE_OPTIONS)) {
    await registerQueue(boss, queue, options);
  }
}

/** O update cru passa pelo grammY; o job normalizado vai direto ao processamento. */
async function runTelegramJob(bot: Bot, context: TelegramJobContext, job: TelegramJob): Promise<void> {
  if (job.kind !== "telegram_update") {
    await processTelegramJob(context, job);
    return;
  }
  try {
    await bot.handleUpdate(job.update as unknown as Update);
  } catch (error) {
    // O erro do handler é o que a dead-letter precisa classificar, não o envelope.
    throw error instanceof BotError ? error.error : error;
  }
}

/**
 * Payload fora do contrato vai direto para a dead-letter, com o motivo: repetir
 * não muda nada e, na fila ordenada, seguraria a chave do post. O resto
 * conclui, ou falha e volta pelo retry da fila.
 */
type JobAttempt = Job & { retryCount?: number; retryLimit?: number };

async function settleTelegramJobs(
  queue: string,
  jobs: JobAttempt[],
  run: (job: TelegramJob, attempt: JobAttempt) => Promise<void>,
): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const job of jobs) {
    let telegramJob: TelegramJob;
    try {
      telegramJob = parseTelegramJob(queue, job.data);
    } catch (error) {
      if (!(error instanceof InvalidTelegramJobError)) throw error;
      log.error({ eventCode: LOG_EVENTS.TELEGRAM_UPDATE_FAILED, err: error, queue, jobId: job.id },
        "job do Telegram fora do contrato — direto para a dead-letter");
      results.push({ id: job.id, status: "deadletter", output: { name: error.name, message: error.message } });
      continue;
    }
    await run(telegramJob, job);
    results.push({ id: job.id, status: "completed" });
  }
  return results;
}

/**
 * Na última tentativa, a leitura que um provedor recusou enquanto outro seguia
 * fora vira recusa, em vez de parar o post na dead-letter. Devolve se recusou.
 */
async function refuseOnLastAttempt(queue: string, error: unknown, job: JobAttempt, logContext: Record<string, unknown>): Promise<boolean> {
  if (!(error instanceof TelegramParseRetryError && error.onExhausted && await isLastTelegramAttempt(queue, job))) return false;
  log.warn({ eventCode: LOG_EVENTS.TELEGRAM_UPDATE_FAILED, err: error, ...logContext, attempt: (job.retryCount ?? 0) + 1 },
    "tentativas esgotadas com provedor fora — recusa no lugar da dead-letter");
  await error.onExhausted();
  return true;
}

async function startTelegramWorkers(bot: Bot, context: TelegramJobContext): Promise<void> {
  const { boss } = context;
  const updates = QUEUES.telegramUpdates;
  await workObserved(boss, updates, (jobs) => settleTelegramJobs(updates, jobs,
    async (telegramJob, job) => {
      try {
        await runTelegramJob(bot, context, telegramJob);
      } catch (error) {
        if (await refuseOnLastAttempt(updates, error, job, telegramLogContext(telegramJob))) return;
        log.error({
          eventCode: LOG_EVENTS.TELEGRAM_UPDATE_FAILED,
          err: error,
          ...telegramLogContext(telegramJob),
          attempt: (job.retryCount ?? 0) + 1,
        }, "falha ao processar update do Telegram — o retry da fila repete");
        throw error;
      }
    }), { localConcurrency: 4, localGroupConcurrency: 2, perJobResults: true });

  // O mesmo job faz debounce, espera pela legenda e ainda preserva budget
  // próprio para falhas reais de captura.
  await workObserved(boss, QUEUES.telegramDeferred, async (jobs) => {
    for (const job of jobs) {
      const data = parseMediaAlbumFlushJob(QUEUES.telegramDeferred, job.data);
      if (job.retryCount === undefined) {
        throw new Error("telegram.deferred sem retryCount apesar de includeMetadata");
      }
      const logContext = { kind: data.kind, chatIdHash: privacyHash(data.chatId, "telegram-chat"), mediaGroupId: data.mediaGroupId };
      let outcome: Awaited<ReturnType<typeof processTelegramDeferredJob>>;
      try {
        outcome = await processTelegramDeferredJob(data, {
          api: bot.api,
          token: context.token,
          retryCount: job.retryCount,
        });
      } catch (error) {
        if (!(await refuseOnLastAttempt(QUEUES.telegramDeferred, error, job, logContext))) throw error;
        // O álbum recusado fecha como o lido: nada o relê, e o 👍 ou o 👎 numa
        // foto irmã continua achando a vencedora.
        await completeMediaAlbum(data.mediaGroupId);
        continue;
      }
      await logAndScheduleFollowups(boss, logContext, outcome);
    }
  }, {
    includeMetadata: true,
    localConcurrency: 2,
    isExpectedRetry: (error) =>
      error instanceof MediaAlbumCaptionPendingError || error instanceof MediaAlbumWinnerChangedError,
  });
}
