import { TOLERANCIA_DE_CICLOS, toleranciaDeCadencia } from "@/src/domain/frescor";

/**
 * Limite único usado pela API, monitor e painéis para considerar o worker vivo.
 *
 * DERIVADO, não escolhido: são três ciclos perdidos do `health.heartbeat`, que
 * roda de 5 em 5 min no `SCHEDULE_MANIFEST` (hoje, 15 min de tolerância), para não ser uma
 * segunda verdade a manter sincronizada com o cron. Apertar a cadência do
 * heartbeat sem revisar a tolerância reprova em `tests/painel/frescor-na-tela.test.ts`.
 */
export const WORKER_HEARTBEAT_STALE_MIN = toleranciaDeCadencia("motor");
export const WORKER_HEARTBEAT_STALE_MS = WORKER_HEARTBEAT_STALE_MIN * 60_000;

/** Mesma chave de `pg_try_advisory_lock` no worker. A web só LÊ `pg_locks`. */
export const WORKER_SINGLETON_LOCK_KEY = "automabaca-worker-singleton";
export const WORKER_SINGLETON_LOCK_HELD_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_locks
  WHERE locktype = 'advisory' AND granted AND objsubid = 1
    AND classid = ((hashtextextended('${WORKER_SINGLETON_LOCK_KEY}', 0) >> 32) & 4294967295)::oid
    AND objid = (hashtextextended('${WORKER_SINGLETON_LOCK_KEY}', 0) & 4294967295)::oid
) AS held`;

/**
 * O worker se reinicia sozinho um heartbeat depois de o `/api/health` o dar
 * como parado: quatro ciclos perdidos, e não três, para um heartbeat que só
 * atrasou não derrubar um processo que ainda ia provar vida.
 */
export const WORKER_SELF_RESTART_STALE_MS =
  WORKER_HEARTBEAT_STALE_MS + WORKER_HEARTBEAT_STALE_MS / TOLERANCIA_DE_CICLOS;

/**
 * Teto dos reinícios automáticos. Cada volta de um laço (20 min sem prova desde
 * o boot, mais drenagem e boot) leva uns 23 min, então uma janela de 1 h nunca
 * chegaria a 3: a de 3 h para o laço no terceiro, e a causa que o reinício não
 * cura (banco, migration, pg-boss) vira aviso em vez de uma drenagem a cada
 * 20 min.
 */
export const WORKER_SELF_RESTART_LIMIT = 3;
export const WORKER_SELF_RESTART_WINDOW_MS = 3 * 60 * 60_000;

export type WorkerSelfWatchVerdict =
  | { kind: "alive" }
  | { kind: "restart" | "exhausted"; staleSince: Date };

/**
 * O que o próprio worker faz com a última prova de vida que ele gravou. Sem
 * prova nenhuma desde o boot, conta a partir do `readyAt`: o boot já pede um
 * heartbeat, e um processo que nunca provou vida também está travado.
 */
export function workerSelfWatchVerdict(input: {
  readyAt: Date;
  lastProofAt: Date | null;
  restartsInWindow: number;
  now: Date;
}): WorkerSelfWatchVerdict {
  const staleSince = input.lastProofAt && input.lastProofAt > input.readyAt ? input.lastProofAt : input.readyAt;
  if (input.now.getTime() - staleSince.getTime() < WORKER_SELF_RESTART_STALE_MS) return { kind: "alive" };
  return { kind: input.restartsInWindow < WORKER_SELF_RESTART_LIMIT ? "restart" : "exhausted", staleSince };
}

/**
 * Quanto tempo a web espera com o `/api/health` fora antes de avisar. A queda
 * já aparece 15 min depois do último heartbeat, e a autocura age 5 min depois
 * dela e volta em uns 4 (drenagem e boot): 20 min fora é a autocura que não
 * resolveu, ou o que ela não cobre (banco fora, processo que não sobe, event
 * loop travado).
 */
export const PRODUCTION_OUTAGE_ALERT_MS = 20 * 60_000;

/** `database`: o banco não responde. `worker`: banco no ar, worker sem lock ou sem heartbeat. */
export type ProductionOutageCause = "database" | "worker";
export type ProductionOutage = { since: Date; cause: ProductionOutageCause; alerted: boolean };
export type ProductionOutageStep =
  | { outage: ProductionOutage | null; effect: null }
  | { outage: ProductionOutage; effect: "alert" }
  | { outage: null; effect: "recovered"; ended: ProductionOutage };

/**
 * Próximo estado da queda que a web acompanha a cada sonda do `/api/health`.
 * Avisa uma vez por queda, com a causa daquele momento; a volta só vira aviso
 * quando a queda tinha sido avisada.
 */
export function nextProductionOutage(
  current: ProductionOutage | null,
  sample: { ok: boolean; db: boolean },
  now: Date,
): ProductionOutageStep {
  if (sample.ok) {
    return current?.alerted ? { outage: null, effect: "recovered", ended: current } : { outage: null, effect: null };
  }
  if (!current) return { outage: { since: now, cause: sample.db ? "worker" : "database", alerted: false }, effect: null };
  if (current.alerted) return { outage: current, effect: null };
  const outage: ProductionOutage = { ...current, cause: sample.db ? "worker" : "database" };
  if (now.getTime() - current.since.getTime() < PRODUCTION_OUTAGE_ALERT_MS) return { outage, effect: null };
  return { outage: { ...outage, alerted: true }, effect: "alert" };
}
