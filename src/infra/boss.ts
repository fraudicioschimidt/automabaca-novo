import { PgBoss } from "pg-boss";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";

const log = createLogger("pgboss");
export const PGBOSS_SCHEMA = "pgboss";
// Mantém um piso de correção curto caso um NOTIFY seja perdido, ainda reduzindo
// em 60% o polling ocioso anterior (2s → 5s) nas filas opt-in.
export const PGBOSS_NOTIFY_BACKSTOP_SECONDS = 5;

/** O pg-boss pode emitir este evento benigno enquanto o próprio stop drena workers. */
export function isExpectedBossShutdownError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const item = error as { message?: unknown; stack?: unknown };
  return typeof item.message === "string" &&
    item.message.includes("Database connection is not opened") &&
    typeof item.stack === "string" &&
    item.stack.includes("Worker.stop");
}

/**
 * Fila persistente do projeto (pg-boss, schema "pgboss" no mesmo Postgres).
 * Todo trabalho assíncrono que afeta dados passa por aqui: retry com backoff,
 * dead-letter e agendamento cron.
 */
export function createBoss(options?: { producerOnly?: boolean }): PgBoss {
  const boss = new PgBoss({
    connectionString: getEnv().DATABASE_URL,
    schema: PGBOSS_SCHEMA,
    // Filas opt-in usam LISTEN/NOTIFY para acordar imediatamente e deixam o
    // polling de 2s apenas como fallback. O produtor web emite NOTIFY, mas não
    // abre uma conexão de listener própria.
    useListenNotify: !options?.producerOnly,
    // `schedule` e `supervise` são true por padrão. Quem só ENFILEIRA não
    // precisa de nenhum dos dois: são pollers permanentes de manutenção e de
    // cron. (A emissão de cron não duplica entre processos — o pg-boss usa
    // UPDATE condicional em `pgboss.version.cron_on` — mas o trabalho de poll
    // e as conexões são desperdício no processo web.)
    ...(options?.producerOnly ? { schedule: false, supervise: false } : {}),
  });
  boss.on("error", (err: Error) => {
    if (isExpectedBossShutdownError(err)) {
      log.warn({ err }, "pg-boss encerrou worker durante o drain esperado");
    } else {
      log.error({ err }, "Erro interno do pg-boss");
    }
  });
  return boss;
}

// Instância compartilhada para PRODUTORES (web envia jobs; quem processa é o
// worker). Lazy + singleton global: sobrevive ao hot-reload do Next.
type BossGlobal = typeof globalThis & { __boss?: Promise<PgBoss> };

export function getSharedBoss(): Promise<PgBoss> {
  const g = globalThis as BossGlobal;
  if (g.__boss) return g.__boss;
  const starting = (async () => {
    // Producer-only: a web enfileira, o worker processa e agenda.
    const boss = createBoss({ producerOnly: true });
    await boss.start();
    return boss;
  })();
  g.__boss = starting;
  // Falha de startup não pode envenenar o singleton até reiniciar o processo.
  // A identidade impede uma tentativa antiga de apagar uma nova concorrente.
  starting.catch(() => {
    if (g.__boss === starting) g.__boss = undefined;
  });
  return starting;
}
