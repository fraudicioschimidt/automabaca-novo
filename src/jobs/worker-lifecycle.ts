import type { PgBoss } from "pg-boss";
import type { WorkerLockRelease } from "@/src/infra/worker-singleton";

type LifecycleLogger = {
  error: (context: unknown, message: string) => void;
};

type WorkerResources = {
  boss: PgBoss | null;
  releaseSingletonLock: WorkerLockRelease | null;
  disconnect: () => Promise<void>;
  log: LifecycleLogger;
};

/**
 * Teto do shutdown inteiro. O `stop_grace_period` do worker em
 * `deploy/compose.yaml` é 110s: passar disso é SIGKILL, e o job fica `active`
 * no limbo até expirar. A margem deixa o processo sair sozinho e registrar por
 * que saiu. O tamanho vem do TEMPO em voo do `sharp.enrich` (não da fração de
 * jobs): um reload em instante aleatório tende a cair num job lento.
 */
export const WORKER_SHUTDOWN_BUDGET_MS = 97_000;

/**
 * Reserva para os passos que rodam DEPOIS do drain: soltar o lock singleton e
 * fechar Prisma + pool. São rápidos, mas não são grátis, e nenhum deles roda se
 * o orçamento estourar antes.
 */
export const POST_DRAIN_RESERVE_MS = 7_000;

/**
 * Drain do pg-boss, derivado do orçamento e nunca escrito à mão: um drain maior
 * que o orçamento faz o `Promise.race` do worker vencer antes, e o processo
 * morre no meio do drain sem soltar o lock nem fechar as conexões.
 *
 * 90s cobrem ~93% do tempo em voo do enrich (p90 73,8s; p99 117s). É ESPERA
 * MÁXIMA, não custo fixo: `boss.stop` retorna assim que o trabalho em voo acaba.
 */
export const BOSS_DRAIN_TIMEOUT_MS = WORKER_SHUTDOWN_BUDGET_MS - POST_DRAIN_RESERVE_MS;

/** Libera todos os recursos mesmo quando um dos passos de shutdown falha. */
export async function shutdownWorkerResources(resources: WorkerResources): Promise<void> {
  if (resources.boss) {
    try {
      await resources.boss.stop({ graceful: true, timeout: BOSS_DRAIN_TIMEOUT_MS });
    } catch (err) {
      resources.log.error({ err }, "erro ao parar pg-boss durante shutdown");
    }
  }
  if (resources.releaseSingletonLock) {
    try {
      await resources.releaseSingletonLock();
    } catch (err) {
      resources.log.error({ err }, "erro ao soltar lock singleton durante shutdown");
    }
  }
  try {
    await resources.disconnect();
  } catch (err) {
    resources.log.error({ err }, "erro ao desconectar do banco durante shutdown");
  }
}
