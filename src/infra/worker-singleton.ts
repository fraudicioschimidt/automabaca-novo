import { Client } from "pg";
import { WORKER_SINGLETON_LOCK_KEY } from "@/src/domain/health";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";

const log = createLogger("worker-singleton");

/**
 * Lock de PROCESSO ÚNICO do worker. pg-boss desduplica crons/jobs,
 * mas isto impede um segundo worker de subir (um segundo container ou um
 * `npm run worker` manual apontando para o mesmo banco). Advisory lock de sessão numa
 * conexão dedicada — Postgres libera sozinho se a sessão cair.
 */
const LOCK_SQL =
  `SELECT pg_try_advisory_lock(hashtextextended('${WORKER_SINGLETON_LOCK_KEY}', 0)) AS locked`;
const UNLOCK_SQL =
  `SELECT pg_advisory_unlock(hashtextextended('${WORKER_SINGLETON_LOCK_KEY}', 0))`;

export type WorkerLockRelease = () => Promise<void>;

export type AcquireWorkerLockOptions = {
  attempts?: number;
  delayMs?: number;
  onLost?: (err: Error) => void;
};

export async function acquireWorkerSingletonLock(
  opts?: AcquireWorkerLockOptions,
): Promise<WorkerLockRelease> {
  const attempts = opts?.attempts ?? 40;
  const delayMs = opts?.delayMs ?? 1000;
  const client = new Client({ connectionString: getEnv().DATABASE_URL });
  await client.connect();

  let acquired = false;
  for (let i = 0; i < attempts; i++) {
    const res = await client.query<{ locked: boolean }>(LOCK_SQL);
    if (res.rows[0]?.locked) {
      acquired = true;
      break;
    }
    if (i === 0) {
      log.warn("outro worker ainda segura o lock singleton — aguardando ele drenar");
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (!acquired) {
    await client.end().catch(() => undefined);
    throw new Error(
      `worker singleton: lock ocupado após ${attempts} tentativa(s) — outro automabaca-worker já está ativo`,
    );
  }

  let releasing = false;
  let lossReported = false;
  const reportLockLoss = (err: Error) => {
    if (releasing || lossReported) return;
    lossReported = true;
    log.fatal({ err }, "conexão do lock singleton caiu — worker não é mais exclusivo");
    opts?.onLost?.(err);
  };
  client.on("error", reportLockLoss);
  client.on("end", () => {
    reportLockLoss(new Error("conexão do lock singleton encerrada pelo PostgreSQL"));
  });
  log.info("lock singleton do worker adquirido");

  return async () => {
    if (releasing) return;
    releasing = true;
    try {
      if (!lossReported) {
        await client.query(UNLOCK_SQL);
      }
    } catch (err) {
      log.error({ err }, "falha ao soltar o lock singleton (a sessão encerrando já libera)");
    } finally {
      await client.end().catch(() => undefined);
    }
  };
}
