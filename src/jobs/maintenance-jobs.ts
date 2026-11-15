import type { PgBoss } from "pg-boss";
import { createLogger } from "@/src/infra/logger";
import { cleanupOrphanedProviderBudgetReservations } from "@/src/providers/budget-reservations";
import { dispatchPendingCaptureFollowups } from "@/src/services/scheduling/enqueue-after-capture";
import { dispatchPendingBankrollLogoCleanups } from "@/src/services/bankrolls/logo-cleanup";
import { checkContasDrift } from "@/src/services/contas/drift";
import {
  resolverAcoesDeLiquidacaoResolvida,
  resolverAcoesSemRecurso,
  apagarLegendaDeRevisoesEncerradas,
  resolverRevisoesDeCapturaGravadas,
} from "@/src/services/ops/action-resource-gc";
import { reconcileCaptureRefusalClusters } from "@/src/services/capture/capture-review";
import {
  reconcileMappedTelegramChannelActions,
  reconcileOperationalActions,
} from "@/src/services/ops/action-sources";
import { purgeOldAuditEvents } from "@/src/services/ops/audit-purge";
import {
  checkBetLedgerConsistency,
  checkBetLucroConsistency,
} from "@/src/services/ops/consistency/bet-ledger";
import {
  descartarDeadLettersSemAssunto,
  discardRetainedScheduledDeadLetters,
  releaseStuckTelegramKeys,
} from "@/src/services/ops/dlq/handler";
import { dispatchPendingDeadLetterReplays } from "@/src/services/ops/dlq/replay";
import { checkEscritasForaDoFluxo } from "@/src/services/ops/consistency/escritas-fora-do-fluxo";
import { checkMercadoForaDoCatalogo } from "@/src/services/ops/consistency/mercado-catalogo";
import { purgeOldChannelActivity } from "@/src/services/capture/channel/channel-activity";
import { checkLogArchiveHealth } from "@/src/services/ops/log-archive-health";
import { checkOperationalSlos, purgeOldOperationalMetrics } from "@/src/services/ops/slo/slo";
import { purgeOldCatalogGameLinks } from "@/src/services/teams/catalog-links";
import { purgeExpiredTipsterNameWaits } from "@/src/services/teams/tipster-names";
import {
  dismissOrphanTrainingCases,
  expireStaleTrainingCases,
} from "@/src/services/sharp/enrich/training-cases";

const log = createLogger("worker-maintenance");

/** Efeitos gravados em transação que ainda não chegaram ao pg-boss ou ao disco. */
export async function dispatchOutbox(boss: PgBoss): Promise<void> {
  const [dlqReplays, bankrollLogos, captures] = await Promise.all([
    dispatchPendingDeadLetterReplays(boss),
    dispatchPendingBankrollLogoCleanups(),
    dispatchPendingCaptureFollowups(boss),
  ]);
  if (dlqReplays + bankrollLogos + captures > 0) {
    log.info(
      { dlqReplays, bankrollLogos, captures },
      "outbox: efeitos pendentes despachados",
    );
  }
}

type IsolatedStep = [run: () => Promise<unknown>, failureMessage: string];

/**
 * Etapas independentes de um mesmo job: cada uma roda mesmo se a anterior
 * falhar, com a falha no log; o job falha no fim com o primeiro erro, para a
 * retentativa (e a dead-letter) enxergarem o problema.
 */
async function runIsolatedSteps(steps: readonly IsolatedStep[]): Promise<void> {
  const errors: unknown[] = [];
  for (const [run, failureMessage] of steps) {
    try {
      await run();
    } catch (err) {
      log.error({ err }, failureMessage);
      errors.push(err);
    }
  }
  if (errors.length > 0) throw errors[0];
}

/**
 * `observability.slo`: a saúde do arquivo de logs vem de arquivos do host e
 * pode falhar sozinha; ela não pode deixar os SLOs sem avaliar.
 */
export async function checkObservability(): Promise<void> {
  await runIsolatedSteps([
    [checkLogArchiveHealth, "observability.slo: saúde do arquivo de logs falhou; SLOs seguem"],
    [checkOperationalSlos, "observability.slo: avaliação dos SLOs falhou"],
  ]);
}

/** `consistency.financeiro`: o dinheiro bate (saldo, lucro, ledger por aposta)? */
export async function checkFinancialConsistency(): Promise<void> {
  await runIsolatedSteps([
    [checkContasDrift, "consistency.financeiro: checagem de saldo falhou; lucro segue"],
    [checkBetLucroConsistency, "consistency.financeiro: checagem de lucro falhou"],
    [checkBetLedgerConsistency, "consistency.financeiro: checagem de ledger por aposta falhou"],
  ]);
}

/**
 * `consistency.revisao`: o que o dono revisa no dia. Fila separada do
 * financeiro para uma falha aqui não repetir nem esconder a conferência do
 * dinheiro, e cada uma aparecer com o próprio nome na DLQ.
 */
export async function checkReviewConsistency(): Promise<void> {
  await runIsolatedSteps([
    [checkMercadoForaDoCatalogo, "consistency.revisao: checagem de mercado fora do catálogo falhou"],
    [checkEscritasForaDoFluxo, "consistency.revisao: checagem de escritas fora do fluxo falhou"],
  ]);
}

/**
 * `training.close_stale_cases`: fecha os casos de treino que não têm mais o
 * que decidir. Os de jogo com mais de 3 dias expiram (o revival não os resolve
 * mais) e os órfãos (aposta removida) fecham. Um passo não impede o outro; o
 * job falha no fim com o primeiro erro, e a retentativa repete os dois, que
 * são idempotentes.
 */
export async function closeStaleTrainingCases(): Promise<{ expired: number; orphans: number }> {
  let expired = 0;
  let orphans = 0;
  const errors: unknown[] = [];
  try {
    expired = await expireStaleTrainingCases();
  } catch (err) {
    log.error({ err }, "training.close_stale_cases: expiração dos casos de jogo antigo falhou; órfãos seguem");
    errors.push(err);
  }
  try {
    orphans = await dismissOrphanTrainingCases();
  } catch (err) {
    log.error({ err }, "training.close_stale_cases: fechamento dos casos de aposta removida falhou");
    errors.push(err);
  }
  if (expired + orphans > 0) log.info({ expired, orphans }, "casos de treino fechados");
  if (errors.length > 0) throw errors[0];
  return { expired, orphans };
}

/**
 * `operational.actions`: manutenção leve que precisa rodar a cada 5 minutos e
 * termina reconciliando a caixa de ações com o estado do sistema.
 */
export async function reconcileOperationalInbox(boss: PgBoss, discardableScheduledQueues: readonly string[]): Promise<void> {
  // Antes da reconciliação da caixa: a ação da dead-letter descartada fecha
  // neste mesmo ciclo, dizendo que o próximo disparo refaz o trabalho.
  const scheduledDeadLetters = await discardRetainedScheduledDeadLetters(boss, discardableScheduledQueues);
  const actions = await reconcileOperationalActions();
  const mappedChannels = await reconcileMappedTelegramChannelActions();
  // Antes do GC de ações: descartar o job é o que faz a ação virar órfã. Na
  // ordem inversa o GC veria o job ainda vivo e deixaria a linha aberta por
  // mais um ciclo.
  const dlqSemAssunto = await descartarDeadLettersSemAssunto(boss);
  const telegramKeysReleased = await releaseStuckTelegramKeysSafely(boss);
  const semRecurso = await resolverAcoesSemRecurso();
  const liquidacaoResolvida = await resolverAcoesDeLiquidacaoResolvida();
  const capturaGravada = await resolverRevisoesDeCapturaGravadas();
  const legendasApagadas = await apagarLegendaDeRevisoesEncerradas();
  const recusasRepetidas = await reconcileCaptureRefusalClusters();
  log.info(
    {
      ...actions,
      mappedChannels,
      scheduledDeadLetters,
      dlqSemAssunto,
      telegramKeysReleased,
      semRecurso,
      liquidacaoResolvida,
      capturaGravada,
      legendasApagadas,
      recusasRepetidas,
    },
    "ações operacionais reconciliadas",
  );
}

/** A varredura das chaves presas não derruba o resto da reconciliação; volta no ciclo seguinte. */
async function releaseStuckTelegramKeysSafely(boss: PgBoss): Promise<number> {
  try {
    return await releaseStuckTelegramKeys(boss);
  } catch (err) {
    log.error({ err }, "varredura de chaves presas do Telegram falhou; reconciliação segue");
    return 0;
  }
}

/**
 * Retenção diária: auditoria, telemetria, atividade dos canais, ligações de
 * jogo dos catálogos e reservas de budget sem dono.
 */
export async function purgeExpiredRecords(): Promise<void> {
  await purgeOldAuditEvents();
  await purgeOldOperationalMetrics();
  const channelActivity = await purgeOldChannelActivity();
  if (channelActivity > 0) log.info({ channelActivity }, "atividade de canal antiga apagada");
  const catalogLinks = await purgeOldCatalogGameLinks();
  if (catalogLinks > 0) log.info({ catalogLinks }, "ligações de jogo dos catálogos antigas apagadas");
  const tipsterNameWaits = await purgeExpiredTipsterNameWaits();
  if (tipsterNameWaits > 0) log.info({ tipsterNameWaits }, "esperas de nome de tipster vencidas apagadas");
  const gc = await cleanupOrphanedProviderBudgetReservations();
  if (gc.cleaned > 0) log.info(gc, "reservas de budget órfãs limpas");
}
