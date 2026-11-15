import type { Job, PgBoss } from "pg-boss";
import { ProviderCadenceDeferredError } from "@/src/domain/provider-error";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { withProviderWorkBudget } from "@/src/infra/provider-work-budget";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { continueSharpEnrich, type SharpJobData } from "@/src/services/scheduling/continue-sharp-enrich";
import { enqueueSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import { maintainClosingArchive, runClosingWatch } from "@/src/services/sharp/closing/series";
import { runClosingSyncOnce } from "@/src/services/sharp/closing/sync";
import { enrichBetSharp, PrePinnacleRetryError } from "@/src/services/sharp/enrich/enrich-bet";
import { SharpContinuationError, SHARP_BRIDGE_SLICE_MS } from "@/src/services/sharp/enrich/continuation";
import { upsertSharp } from "@/src/services/sharp/enrich/upsert-sharp";
import { EnrichObsoleteError, expectEnrichTerms, withEnrichWriteScope } from "@/src/services/sharp/enrich/write-guard";
import { findBetsParaReviver } from "@/src/services/sharp/revive";

const log = createLogger("worker-sharp");

/** Os termos que o guarda do enrich confere antes de gravar (`write-guard.ts`). */
const enrichTermsSelect = {
  evento: true, esporte: true, mercado: true, selecao: true, odds: true, data: true, pais: true, competicao: true,
  bankroll: { select: { sharpMode: true } },
} as const;
type EnrichTerms = Parameters<typeof expectEnrichTerms>[0];

/**
 * A Pinnacle17 pode ter sido consultada antes de a Bridge recusar: gravar a
 * tentativa (`sharp.updatedAt`) faz o revival esperar a cadência, e não o
 * próximo cron. Só com os termos de antes do enrich: a edição no meio apagou o
 * sharp, e recriá-lo faria a aposta editada esperar a cadência.
 */
async function recordBreakerAttempt(betId: string, terms: EnrichTerms | null): Promise<void> {
  if (!terms) return;
  try {
    await withEnrichWriteScope(async () => {
      expectEnrichTerms(terms);
      await upsertSharp(betId, { identityStatus: "PENDING", confidence: 0 });
    });
  } catch (err) {
    if (!(err instanceof EnrichObsoleteError)) throw err;
  }
}

/**
 * `sharp.enrich`: identidade e preço de cada aposta. Esperas previstas
 * (continuação, cadência do provider, Pinnacle ainda sem a linha, breaker
 * aberto) concluem o job sem queimar retry; quem tenta de novo é a continuação
 * agendada ou o revival.
 */
export async function enrichBets(jobs: Job[], boss: PgBoss): Promise<void> {
  for (const job of jobs) {
    const data = job.data as SharpJobData;
    const terms = await prisma.bet.findUnique({ where: { id: data.betId }, select: enrichTermsSelect });
    try {
      await withProviderWorkBudget("bridgeodds", SHARP_BRIDGE_SLICE_MS, () =>
        enrichBetSharp({ betId: data.betId }, { boss, continuation: data.continuation }));
    } catch (err) {
      if (err instanceof EnrichObsoleteError) continue;
      // A continuação já tem hora marcada para terminar o próprio enrich.
      if (err instanceof SharpContinuationError || err instanceof ProviderCadenceDeferredError) {
        await continueSharpEnrich(boss, { id: job.id, data }, err.retryAt,
          err instanceof SharpContinuationError ? err.continuation : data.continuation ?? {});
        continue;
      }
      // Daqui para baixo a próxima tentativa é do revival ou do cooldown do breaker.
      if (err instanceof PrePinnacleRetryError) {
        log.info(
          { betId: data.betId, origem: data.origem ?? "capture" },
          "Pinnacle ainda não listou — aguardando próxima rodada do revival",
        );
        continue;
      }
      if (err instanceof CircuitOpenError) {
        await recordBreakerAttempt(data.betId, terms);
        log.info(
          { betId: data.betId, origem: data.origem ?? "capture", err: err.message },
          "breaker aberto — job concluído sem queimar retry; o revival tenta de novo na cadência",
        );
        continue;
      }
      throw err;
    }
  }
}

/** Re-enfileira o enrich das apostas que ainda precisam de identidade ou preço. */
export async function reviveSharpEnrich(boss: PgBoss): Promise<void> {
  const betIds = await findBetsParaReviver(new Date());
  let enfileiradas = 0;
  let puladas = 0;
  const erros: unknown[] = [];
  for (const betId of betIds) {
    try {
      const jobId = await enqueueSharpEnrich(boss, betId, {
        origem: "revive",
        singletonSeconds: 540,
      });
      if (jobId) enfileiradas += 1;
      else puladas += 1;
    } catch (err) {
      erros.push(err);
      log.error({ err, betId }, "revival: falha ao re-enfileirar enrich — lote segue");
    }
  }
  if (enfileiradas > 0 || puladas > 0 || erros.length > 0) {
    log.info(
      { enfileiradas, puladas, falhas: erros.length },
      "revival: apostas avaliadas para re-enfileirar enrich",
    );
  }
  if (erros.length > 0) {
    await sendOperationalAlert(
      `⚠️ Nova busca de preço falhou para ${erros.length} de ${betIds.length} apostas\nA tarefa vai tentar de novo sozinha.\n`
        + "👉 Nada a fazer agora. Feche este aviso em Monitoramento quando ele parar de repetir.",
      {
        source: "sharp.revival-enqueue",
        key: "batch-enqueue-failure",
        title: "Falha ao reenfileirar apostas no revival sharp",
        resource: "sharp-revival",
        evidence: { failed: erros.length, total: betIds.length },
        autoResolve: false,
      },
    );
    throw new AggregateError(erros, `Revival sharp teve ${erros.length} falha(s) de enqueue.`);
  }
}

/**
 * O ciclo roda de 5 em 5 min: aos 4 ele para de pegar aposta e de esperar o
 * portão da Bridge, e o que sobrou fica para o seguinte.
 */
export const CLOSING_SYNC_BUDGET_MS = 4 * 60_000;

/**
 * `closing.sync`: congela os fechamentos depois do kickoff e, na mesma volta,
 * limpa o arquivo de preços e recupera dele, sem HTTP, o fechamento que ficou
 * sem CLV confiável. A recuperação roda mesmo quando o ciclo falha.
 */
export async function syncClosings(signal: AbortSignal): Promise<void> {
  try {
    await withProviderWorkBudget("bridgeodds", CLOSING_SYNC_BUDGET_MS, () => runClosingSyncOnce({ signal }));
  } finally {
    const priceArchive = await maintainClosingArchive();
    log.info({ priceArchive }, "arquivo de preços mantido");
  }
}

export async function watchClosingSeries(jobs: Job[], boss: PgBoss): Promise<void> {
  for (const job of jobs) {
    const data = job.data as { watchId?: unknown };
    if (typeof data?.watchId === "string") await runClosingWatch(data.watchId, boss);
  }
}
