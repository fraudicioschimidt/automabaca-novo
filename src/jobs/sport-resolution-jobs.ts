import type { Job, PgBoss } from "pg-boss";
import {
  MAX_SPORT_CAPACITY_CONTINUATIONS,
  SPORT_EXTENDED_RETRY_COUNT as EXTENDED_RETRY_COUNT,
  SPORT_EXTENDED_RETRY_DELAY_SECONDS as EXTENDED_RETRY_DELAY_SECONDS,
  SPORT_FAST_RETRY_DELAYS_SECONDS as FAST_RETRY_DELAYS_SECONDS,
} from "@/src/domain/sport-resolution-retry";
import { createLogger } from "@/src/infra/logger";
import { resolvePendingBetSport } from "@/src/services/bets/sport-resolution/resolve";
import { avisarBuscaDeEsporteDesistiu, avisarConflitoDeEsporte, avisarEsportePendente } from "@/src/services/bets/sport-resolution/notify";
import { enqueueSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import {
  enqueueSportResolution,
  type SportResolutionJobData,
} from "@/src/services/scheduling/enqueue-sport-resolution";

const log = createLogger("worker-sport-resolution");

/** Primeira tentativa sem próximo passo no backoff: é nela que o dono é avisado. */
const LAST_BACKOFF_ATTEMPT = FAST_RETRY_DELAYS_SECONDS.length + EXTENDED_RETRY_COUNT;

/** 30s/2min/30min e depois 2/2h por 24h; o job permanece deduplicado por aposta×tentativa. */
export function sportResolutionRetryDelaySeconds(attempt: number): number | null {
  if (attempt < 0 || !Number.isInteger(attempt)) return null;
  const fast = FAST_RETRY_DELAYS_SECONDS[attempt];
  if (fast != null) return fast;
  return attempt < FAST_RETRY_DELAYS_SECONDS.length + EXTENDED_RETRY_COUNT
    ? EXTENDED_RETRY_DELAY_SECONDS
    : null;
}

/**
 * Próxima tentativa: o passo do backoff, adiantado para a vez perto do jogo
 * (`nextWebSearchAt`: com menos de 3 h e com menos de 45 min para o kickoff),
 * quando o catálogo já tem o jogo e a web tem prévia e escalação. Esgotado o
 * backoff antes do jogo, só ela ainda acorda a aposta, com a web ou sem ela:
 * é a tentativa perto do jogo que ficou no lugar da triagem periódica.
 */
function nextAttemptDelaySeconds(attempt: number, nextWebSearchAt: Date | undefined, now: number): number | null {
  const backoff = sportResolutionRetryDelaySeconds(attempt);
  const untilWeb = nextWebSearchAt ? Math.max(1, Math.ceil((nextWebSearchAt.getTime() - now) / 1_000)) : null;
  if (backoff == null) return untilWeb;
  return untilWeb == null ? backoff : Math.min(backoff, untilWeb);
}

/**
 * `capture.sport_resolve`: confirma a modalidade e libera o enrich. Espera de
 * provider vira continuação (mesma tentativa); resultado pendente avança para a
 * próxima tentativa do backoff ou para a vez da busca web; esgotado o backoff,
 * o dono é avisado uma vez.
 */
export async function resolveBetSports(jobs: Job[], boss: PgBoss): Promise<void> {
  for (const job of jobs) {
    const data = job.data as SportResolutionJobData;
    const run = await resolvePendingBetSport(data.betId, {
      attempt: data.attempt,
      continuation: data.continuation ?? 0,
      bridgeCursor: data.bridgeCursor,
    });
    if (run.status === "resolved") {
      await enqueueSharpEnrich(boss, data.betId, {
        origem: "sport-resolved",
      });
      continue;
    }
    if (run.status === "conflict") {
      // O conflito para o resolvedor: sem o dono, a aposta fica sem esporte
      // (e sem identidade nem CLV) até o jogo.
      await avisarConflitoDeEsporte(run).catch((err: unknown) => {
        log.error({ err, betId: data.betId }, "falha ao avisar conflito de esporte — aposta segue na caixa de ações");
      });
    }
    const retryDelaySeconds = nextAttemptDelaySeconds(data.attempt, run.nextWebSearchAt, Date.now());
    const capacityExhausted = run.reason === "provider_capacity" &&
      (data.continuation ?? 0) >= MAX_SPORT_CAPACITY_CONTINUATIONS;
    if (run.status === "pending" && run.retryAt && !capacityExhausted) {
      await enqueueSportResolution(boss, data.betId, {
        attempt: data.attempt,
        continuation: (data.continuation ?? 0) + 1,
        startAfterSeconds: Math.max(1, Math.ceil((run.retryAt.getTime() - Date.now()) / 1_000)),
        origem: run.reason,
        bridgeCursor: run.bridgeCursor,
        ...(data.oneShot ? { oneShot: true } : {}),
      });
      continue;
    }
    // A tentativa avulsa não agenda a próxima nem avisa: a cadeia da aposta cuida disso.
    if (data.oneShot) continue;
    if (run.status === "pending" && retryDelaySeconds != null) {
      await enqueueSportResolution(boss, data.betId, {
        attempt: data.attempt + 1,
        startAfterSeconds: retryDelaySeconds,
        origem: run.status,
      });
    }
    if (run.status === "pending" && data.attempt === LAST_BACKOFF_ATTEMPT) {
      // Fim da linha automática: sem esporte não há identidade, CLV nem
      // resposta no canal. O aviso leva o que a busca achou, para a decisão ser
      // rápida.
      await avisarEsportePendente(run).catch((err: unknown) => {
        log.error({ err, betId: data.betId }, "falha ao avisar esporte pendente — aposta segue na caixa de ações");
      });
    }
    log.info(
      {
        betId: data.betId,
        attempt: data.attempt,
        result: run.status,
        reason: run.reason,
      },
      "resolução de esporte concluída",
    );
  }
}

/**
 * Dead-letter da resolução de esporte só NOTIFICA: a caixa de ações é do
 * coletor `sport-resolution`, que lê o estado atual da aposta e encerra sozinho
 * quando a modalidade é confirmada ou a aposta some.
 */
export async function notifySportResolutionGaveUp(data: unknown): Promise<void> {
  const betId = (data as Partial<SportResolutionJobData>).betId;
  if (!betId) return;
  await avisarBuscaDeEsporteDesistiu(betId);
}
