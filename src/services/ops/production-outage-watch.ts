import { formatDurationMinutes, formatSpTime } from "@/src/domain/dates";
import { nextProductionOutage, type ProductionOutage } from "@/src/domain/health";
import { OperationalRisk } from "@/src/generated/prisma/client";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { sendOperationalAlertEvenIfDatabaseDown, sendRequiredOperatorNotification } from "@/src/services/ops/alerts";
import {
  reconcileOperationalActionSource,
  resolveOperationalActionBySourceKey,
} from "@/src/services/ops/operational-actions";

const log = createLogger("health");
const ALERT_SOURCE = "health.outage";

/** O que a sonda do `/api/health` viu, inclusive o que não vai no corpo público. */
export type HealthSample = { ok: boolean; db: boolean; lockHeld: boolean; lastHeartbeat: Date | null };

const EFFECT_RETRY_MS = 60_000;
type Recovery = { ended: ProductionOutage; at: Date; actionResolved: boolean; notified: boolean };
type WatchState = {
  outage: ProductionOutage | null;
  deliveredFor: ProductionOutage | null;
  recovery: Recovery | null;
  openActionsChecked: boolean;
  running: boolean;
  retryAt: number;
  sample: HealthSample | null;
  now: Date;
};
function initialState(): WatchState {
  return { outage: null, deliveredFor: null, recovery: null, openActionsChecked: false,
    running: false, retryAt: 0, sample: null, now: new Date() };
}
let state = initialState();

/**
 * A web acompanha a queda pelas sondas do healthcheck, mesmo com worker ou
 * banco fora. Detectar continua síncrono; efeitos têm uma única execução em
 * voo e retentativa limitada, sem segurar a resposta do health.
 */
export function watchProductionOutage(sample: HealthSample, now = new Date()): void {
  const current = state;
  if (current.sample?.ok !== sample.ok) current.retryAt = 0;
  const step = nextProductionOutage(current.outage, sample, now);
  current.outage = step.outage;
  current.sample = sample;
  current.now = now;
  if (!sample.ok) {
    // Uma nova queda torna obsoleto o aviso de volta pendente. A próxima
    // sonda boa confere todas as ações, inclusive a causa da queda anterior.
    current.recovery = null;
    current.openActionsChecked = false;
  } else if (step.effect === "recovered") {
    current.recovery = { ended: step.ended, at: now, actionResolved: false, notified: false };
  }
  flushEffects(current);
}

function flushEffects(current: WatchState): void {
  if (current.running || Date.now() < current.retryAt || !current.sample) return;
  const recovery = current.sample.ok ? current.recovery : null;
  const outage = current.outage?.alerted && current.deliveredFor !== current.outage ? current.outage : null;
  const reconcile = current.sample.ok && !current.openActionsChecked;
  if (!recovery && !outage && !reconcile) return;
  const sample = current.sample;
  const now = current.now;
  current.running = true;
  (async () => {
    if (recovery) {
      if (!recovery.actionResolved) {
        await resolveRecoveryAction(recovery.ended, recovery.at);
        recovery.actionResolved = true;
      }
      if (current.recovery !== recovery || !current.sample?.ok) return;
      if (!recovery.notified) {
        await announceRecovery(recovery.ended, recovery.at);
        recovery.notified = true;
      }
      if (current.recovery === recovery) current.recovery = null;
    } else if (outage) {
      if (!await alertOutage(outage, sample, now)) throw new Error("Aviso da queda ainda não entregue.");
      current.deliveredFor = outage;
    } else {
      await reconcileOperationalActionSource(ALERT_SOURCE, [], now);
      if (current.sample?.ok) current.openActionsChecked = true;
    }
  })().catch((err: unknown) => {
    // A próxima condição tem prioridade: falha no aviso da queda anterior
    // não pode atrasar o fechamento quando o sistema já voltou.
    if (current.outage === outage && current.recovery === recovery) current.retryAt = Date.now() + EFFECT_RETRY_MS;
    log.warn({ err }, "efeito da vigia da produção pendente; nova tentativa em até um minuto");
  }).finally(() => {
    current.running = false;
    flushEffects(current);
  });
}

/** Só para testes: callbacks de uma execução antiga não alteram o novo estado. */
export function resetProductionOutageWatch(): void {
  state = initialState();
}

async function alertOutage(current: ProductionOutage, sample: HealthSample, now: Date): Promise<boolean> {
  const minutes = formatDurationMinutes((now.getTime() - current.since.getTime()) / 60_000);
  log.error(
    { eventCode: LOG_EVENTS.HEALTH_OUTAGE_ALERTED, cause: current.cause, since: current.since, lockHeld: sample.lockHeld, lastHeartbeat: sample.lastHeartbeat },
    "produção fora do ar além do limite — avisando o dono",
  );
  const lastHeartbeat = sample.lastHeartbeat ? ` O último heartbeat foi às ${formatSpTime(sample.lastHeartbeat)}.` : "";
  const message = current.cause === "database"
    ? `🛑 O banco não responde há ${minutes}\n`
      + "Sem banco não há captura, fechamento, liquidação nem painel.\n"
      + "👉 Na VPS, veja o container automabaca-novo-db (`docker ps`, `journalctl CONTAINER_NAME=automabaca-novo-db`)."
    : sample.lockHeld
      ? `🛑 O worker está travado há ${minutes}\n`
        + `O processo está de pé, mas não conclui o heartbeat, e o reinício automático não resolveu.${lastHeartbeat}\n`
        + "Sem worker não há captura, fechamento nem liquidação.\n"
        + "👉 Veja o log do worker; depois, `docker restart automabaca-novo-worker` na VPS."
      : `🛑 O worker está fora do ar há ${minutes}\n`
        + `O processo não está de pé: o container parou ou não consegue subir.${lastHeartbeat}\n`
        + "Sem worker não há captura, fechamento nem liquidação.\n"
        + "👉 Na VPS, veja `docker ps` e o log do automabaca-novo-worker; numa migration longa, o migrar.py para o worker de propósito.";
  return sendOperationalAlertEvenIfDatabaseDown(message, {
    source: ALERT_SOURCE,
    key: current.cause,
    title: current.cause === "database" ? "Banco fora do ar" : "Worker fora do ar",
    risk: OperationalRisk.HIGH,
    resource: current.cause,
    evidence: { since: current.since.toISOString(), lastHeartbeat: sample.lastHeartbeat?.toISOString() ?? null, lockHeld: sample.lockHeld },
  });
}

async function resolveRecoveryAction(ended: ProductionOutage, now: Date): Promise<void> {
  const minutes = formatDurationMinutes((now.getTime() - ended.since.getTime()) / 60_000);
  const who = ended.cause === "database" ? "O banco" : "O worker";
  await resolveOperationalActionBySourceKey(
    ALERT_SOURCE, ended.cause, `${who} voltou depois de ${minutes} fora.`, now,
  );
}

async function announceRecovery(ended: ProductionOutage, now: Date): Promise<void> {
  const minutes = formatDurationMinutes((now.getTime() - ended.since.getTime()) / 60_000);
  const who = ended.cause === "database" ? "O banco" : "O worker";
  await sendRequiredOperatorNotification(
    `✅ ${who} voltou\nO /api/health ficou fora ${minutes}, de ${formatSpTime(ended.since)} a ${formatSpTime(now)}.`,
  );
  log.info(
    { eventCode: LOG_EVENTS.HEALTH_OUTAGE_RECOVERED, cause: ended.cause, since: ended.since },
    "produção de volta depois da queda avisada",
  );
}
