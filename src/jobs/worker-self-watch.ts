import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { formatSpTime } from "@/src/domain/dates";
import {
  WORKER_SELF_RESTART_LIMIT,
  WORKER_SELF_RESTART_STALE_MS,
  WORKER_SELF_RESTART_WINDOW_MS,
  workerSelfWatchVerdict,
} from "@/src/domain/health";
import { OperationalRisk } from "@/src/generated/prisma/client";
import { PGBOSS_SCHEMA } from "@/src/infra/boss";
import { getEnv } from "@/src/infra/env";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { QUEUES } from "@/src/infra/queue-contract";
import type { WorkerInstance } from "@/src/infra/worker-instance";
import { raiseOperationalAlertOnce, sendOperationalAlert } from "@/src/services/ops/alerts";
import { resolveOperationalActionBySourceKey } from "@/src/services/ops/operational-actions";

const log = createLogger("worker");

const SELF_WATCH_INTERVAL_MS = 60_000;
/** Bem menor que o intervalo: uma volta presa no banco não encosta na seguinte. */
const SELF_WATCH_QUERY_TIMEOUT_MS = 5_000;
export const SELF_RESTART_ACTION = "worker.self_restart";
const SELF_RESTART_ANNOUNCED_ACTION = "worker.self_restart_announced";
const ALERT_SOURCE = "worker.self-restart";
const STALE_MIN = WORKER_SELF_RESTART_STALE_MS / 60_000;
const WINDOW_H = WORKER_SELF_RESTART_WINDOW_MS / 3_600_000;

/** A mesma prova que o healthcheck do Docker procura, e os reinícios que já gastaram a cota. */
const SELF_WATCH_SQL = `SELECT
  (SELECT max(completed_on) FROM "${PGBOSS_SCHEMA}"."job"
    WHERE name = $1 AND state = 'completed' AND output @> $2::jsonb) AS last_proof,
  (SELECT count(*)::int FROM audit_events
    WHERE action = $3 AND "createdAt" >= now() - ($4::double precision * interval '1 millisecond')) AS restarts,
  now() AS db_now`;

const RECORD_RESTART_SQL = `INSERT INTO audit_events (id, actor, action, resource, "resourceId", outcome, details)
  VALUES ($1, 'system', $2, 'worker', $3, 'success', $4::jsonb)`;

type SelfWatchRow = { last_proof: Date | null; restarts: number; db_now: Date };

export type WorkerSelfWatch = {
  /**
   * Uma volta da vigia, com o aviso que ela dispara; o intervalo chama sozinho,
   * e o teste chama direto e confere o efeito quando ela termina.
   */
  tick: () => Promise<void>;
  stop: () => Promise<void>;
};

/**
 * O worker confere a própria prova de vida de minuto em minuto e sai com
 * código 1 quando passa do limite sem ela, para o Docker subir outro processo:
 * o `restart: unless-stopped` só age em processo que saiu, e o container
 * `unhealthy` ficaria parado. A conexão é própria e curta, fora do pool do
 * Prisma, porque o pool esgotado é um dos jeitos de o worker travar.
 *
 * Banco que não responde não conta: reiniciar não o traz de volta, e quem avisa
 * é a web (`services/ops/production-outage-watch.ts`).
 */
export function startWorkerSelfWatch(
  instance: Pick<WorkerInstance, "proof">,
  options: { onStale: () => void; intervalMs?: number },
): WorkerSelfWatch {
  const pool = new Pool({
    connectionString: getEnv().DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: SELF_WATCH_QUERY_TIMEOUT_MS,
    statement_timeout: SELF_WATCH_QUERY_TIMEOUT_MS,
    query_timeout: SELF_WATCH_QUERY_TIMEOUT_MS,
    allowExitOnIdle: true,
  });
  pool.on("error", (err) => log.warn({ err }, "conexão da vigia do worker caiu; a próxima volta abre outra"));
  let running = false;
  let stopped = false;
  let closing: Promise<void> | null = null;
  let returnAnnounced = false;
  let exhaustionReported = false;

  async function tick(): Promise<void> {
    const proof = instance.proof();
    const readyAt = proof?.workerInstance.readyAt;
    if (running || stopped || !proof || !readyAt) return;
    running = true;
    let row: SelfWatchRow | undefined;
    try {
      const result = await pool.query<SelfWatchRow>(SELF_WATCH_SQL, [
        QUEUES.healthHeartbeat, JSON.stringify(proof), SELF_RESTART_ACTION, WORKER_SELF_RESTART_WINDOW_MS,
      ]);
      row = result.rows[0];
    } catch (err) {
      log.warn({ err }, "vigia do worker não leu a prova de vida; com o banco fora, reiniciar não cura");
    }
    try {
      if (!row || stopped) return;

      const lastProofAt = row.last_proof;
      const verdict = workerSelfWatchVerdict({
        readyAt: new Date(readyAt), lastProofAt, restartsInWindow: row.restarts, now: row.db_now,
      });
      if (verdict.kind === "alive") {
        if (lastProofAt && !returnAnnounced) {
          try {
            await announceReturn(proof.workerInstance.instanceId, row.db_now);
            returnAnnounced = true;
          } catch (err) {
            log.error({ err }, "falha ao avisar a volta do worker depois do reinício automático");
          }
        }
        return;
      }
      if (verdict.kind === "exhausted") {
        if (exhaustionReported) return;
        log.error(
          { eventCode: LOG_EVENTS.WORKER_SELF_RESTART_EXHAUSTED, staleSince: verdict.staleSince, restarts: row.restarts },
          "worker sem prova de vida e sem reinício automático sobrando na janela",
        );
        try {
          exhaustionReported = await raiseOperationalAlertOnce(exhaustedMessage(verdict.staleSince, lastProofAt, row.restarts), {
            source: ALERT_SOURCE,
            key: "exhausted",
            title: "Autocura do worker esgotada",
            risk: OperationalRisk.HIGH,
            resource: "worker",
            evidence: { staleSince: verdict.staleSince.toISOString(), restartsInWindow: row.restarts },
            autoResolve: false,
          });
        } catch (err) {
          log.error({ err }, "falha ao avisar a autocura esgotada");
        }
        return;
      }

      stopped = true;
      clearInterval(timer);
      const details = {
        instanceId: proof.workerInstance.instanceId,
        readyAt,
        lastProofAt: lastProofAt?.toISOString() ?? null,
        staleSince: verdict.staleSince.toISOString(),
        restartedAt: row.db_now.toISOString(),
        release: process.env.AUTOMABACA_RELEASE_SHA ?? null,
      };
      try {
        await pool.query(RECORD_RESTART_SQL, [
          randomUUID(), SELF_RESTART_ACTION, proof.workerInstance.instanceId, JSON.stringify(details),
        ]);
      } catch (err) {
        // Sem o registro o teto não conta esta volta, mas o reinício é a cura.
        log.error({ err }, "não gravei o reinício automático; ele não entra no teto da janela");
      }
      log.fatal(
        { eventCode: LOG_EVENTS.WORKER_SELF_RESTART, ...details, restartsInWindow: row.restarts + 1 },
        "worker sem prova de vida — saindo para o Docker subir outro",
      );
      options.onStale();
    } finally {
      // A volta inclui os efeitos: outra sonda não pode disputar o mesmo aviso.
      running = false;
    }
  }

  const timer = setInterval(() => {
    tick().catch((err: unknown) => log.error({ err }, "volta da vigia do worker falhou"));
  }, options.intervalMs ?? SELF_WATCH_INTERVAL_MS);
  timer.unref();
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
      closing ??= pool.end();
      return closing;
    },
  };
}

/**
 * Primeira prova de vida deste processo: avisa o reinício automático que o
 * trouxe, uma vez só (o recibo em `audit_events` impede repetir no deploy
 * seguinte), e fecha a autocura esgotada que tenha ficado aberta.
 */
async function announceReturn(instanceId: string, now: Date): Promise<void> {
  await resolveOperationalActionBySourceKey(
    ALERT_SOURCE, "exhausted", "O worker voltou a concluir o heartbeat.", now,
  );
  const restarts = await prisma.auditEvent.findMany({
    where: { action: SELF_RESTART_ACTION, createdAt: { gte: new Date(now.getTime() - WORKER_SELF_RESTART_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, resourceId: true, details: true },
  });
  const latest = restarts[0];
  if (!latest || latest.resourceId === instanceId) return;
  const receipt = await prisma.auditEvent.findFirst({
    where: { action: SELF_RESTART_ANNOUNCED_ACTION, resource: "worker", resourceId: latest.id },
    select: { id: true },
  });
  if (receipt) return;
  const details = latest.details as { lastProofAt?: string | null; staleSince?: string; restartedAt?: string } | null;
  const delivered = await sendOperationalAlert(returnMessage(details, now, restarts.length), {
    source: ALERT_SOURCE,
    key: "restart",
    title: "Worker se reiniciou sozinho",
    resource: "worker",
    evidence: { restartEventId: latest.id, restartsInWindow: restarts.length, ...(details ?? {}) },
  });
  if (!delivered) throw new Error("Aviso do reinício automático ainda não entregue.");
  await prisma.auditEvent.create({
    data: { action: SELF_RESTART_ANNOUNCED_ACTION, resource: "worker", resourceId: latest.id, details: { instanceId } },
  });
}

function timeOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? formatSpTime(date) : null;
}

function returnMessage(
  details: { lastProofAt?: string | null; staleSince?: string; restartedAt?: string } | null,
  now: Date,
  restartsInWindow: number,
): string {
  const lastProof = timeOf(details?.lastProofAt);
  const staleSince = timeOf(details?.staleSince);
  const restartedAt = timeOf(details?.restartedAt);
  const cause = lastProof
    ? `Ficou ${STALE_MIN} min sem concluir o heartbeat (o último às ${lastProof})`
    : `Subiu${staleSince ? ` às ${staleSince}` : ""} e não concluiu nenhum heartbeat em ${STALE_MIN} min`;
  const lookAt = lastProof ?? staleSince ?? restartedAt;
  return "🔁 O worker se reiniciou sozinho\n"
    + `${cause}${restartedAt ? ` e saiu às ${restartedAt}` : ""}; o processo novo provou vida às ${formatSpTime(now)}.\n`
    + `Reinícios automáticos nas últimas ${WINDOW_H} h: ${restartsInWindow} de ${WORKER_SELF_RESTART_LIMIT}.\n`
    + `👉 Se repetir, veja o log do worker${lookAt ? ` perto das ${lookAt}` : ""}.`;
}

function exhaustedMessage(staleSince: Date, lastProofAt: Date | null, restarts: number): string {
  return "🛑 O worker está travado e parou de se reiniciar sozinho\n"
    + `${lastProofAt ? `Sem heartbeat desde ${formatSpTime(staleSince)}` : `Sem nenhum heartbeat desde o boot, às ${formatSpTime(staleSince)}`}, `
    + `e já foram ${restarts} reinícios automáticos nas últimas ${WINDOW_H} h: reiniciar não está curando. `
    + "Enquanto isso, captura, fechamento e liquidação podem estar parados.\n"
    + "👉 Veja o log do worker e o banco na VPS; depois do conserto, `docker restart automabaca-novo-worker`.";
}
