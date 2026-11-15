import { LOG_EVENTS } from "@/src/infra/log-events";
import { PrismaClient } from "@/src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { redactSensitiveValue } from "@/src/infra/redaction";

const log = createLogger("db");

export const DB_STATEMENT_TIMEOUT_MS = 120_000;
export const DB_QUERY_TIMEOUT_MS = 130_000;

const DATA_WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
]);

/** Coluna do banco não tem framing de linha: a quebra real fica para o painel mostrar. */
const DB_SINK_REDACTION = { preserveNewlines: true } as const;

function redactWriteArgs<T>(operation: string, args: T): T {
  if (!args || typeof args !== "object") return args;
  const record = args as Record<string, unknown>;
  if (DATA_WRITE_OPERATIONS.has(operation) && "data" in record) {
    return { ...record, data: redactSensitiveValue(record.data, DB_SINK_REDACTION) } as T;
  }
  if (operation === "upsert") {
    return {
      ...record,
      create: redactSensitiveValue(record.create, DB_SINK_REDACTION),
      update: redactSensitiveValue(record.update, DB_SINK_REDACTION),
    } as T;
  }
  return args;
}

/** Defesa final dos três sinks Prisma, inclusive dentro de `$transaction`. */
function withRedactedOperationalSinks(client: PrismaClient): PrismaClient {
  return client.$extends({
    name: "redacted-operational-sinks",
    query: {
      auditEvent: {
        $allOperations({ operation, args, query }) {
          return query(redactWriteArgs(operation, args));
        },
      },
      operationalAction: {
        $allOperations({ operation, args, query }) {
          return query(redactWriteArgs(operation, args));
        },
      },
      operationalMetric: {
        $allOperations({ operation, args, query }) {
          return query(redactWriteArgs(operation, args));
        },
      },
    },
  }) as unknown as PrismaClient;
}

type PrismaGlobal = typeof globalThis & {
  __prisma?: PrismaClient;
  __pgPool?: Pool;
  __metricsPool?: Pool;
};

const globalRef = globalThis as PrismaGlobal;

function buildPool(): Pool {
  const env = getEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // O servidor cancela primeiro; o timeout do cliente é a última barreira
    // para falhas de rede que não chegam ao PostgreSQL.
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
    query_timeout: DB_QUERY_TIMEOUT_MS,
    // Desliga os triggers de compatibilidade (`automabaca_compat_*`) enquanto
    // existirem num banco: sem a marca, eles reescreveriam o fechamento em vez
    // de deixar os CHECKs recusarem. A migration 20260924000100_remove_compat_writers
    // os apaga; a marca só pode sair numa release posterior à aplicação dela.
    options: "-c automabaca.writer_contract=v2 -c automabaca.price_contract=v1",
  });
  pool.on("error", (err) => {
    log.error({ eventCode: LOG_EVENTS.DATABASE_POOL_FAILED, err }, "Erro inesperado no pool de conexões PostgreSQL");
  });
  return pool;
}

// Singleton global: sobrevive ao hot-reload do Next em dev sem vazar conexões.
export const pgPool: Pool = globalRef.__pgPool ?? buildPool();
export const prisma: PrismaClient =
  globalRef.__prisma ?? withRedactedOperationalSinks(
    new PrismaClient({ adapter: new PrismaPg(pgPool) }),
  );

globalRef.__pgPool = pgPool;
globalRef.__prisma = prisma;

/** Teto que o servidor cobra de cada gravação de métrica. */
export const METRICS_STATEMENT_TIMEOUT_MS = 250;
/** Conexões da telemetria: o mesmo teto de escritas simultâneas de `operational-metrics.ts`. */
export const METRICS_POOL_MAX = 2;

/**
 * Pool próprio da telemetria operacional. Cada métrica é um INSERT de um
 * comando só, com `statement_timeout` e `lock_timeout` da conexão: sem
 * transação interativa, que custaria ~5 idas ao banco por métrica e falharia
 * justamente sob carga, e sem disputar conexão com o negócio. Criado na
 * primeira métrica; `allowExitOnIdle` não segura processo curto (script, teste).
 */
export function getMetricsPool(): Pool {
  if (globalRef.__metricsPool) return globalRef.__metricsPool;
  const pool = new Pool({
    connectionString: getEnv().DATABASE_URL,
    max: METRICS_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 1_000,
    statement_timeout: METRICS_STATEMENT_TIMEOUT_MS,
    lock_timeout: 100,
    query_timeout: 1_000,
    allowExitOnIdle: true,
  });
  pool.on("error", (err) => {
    log.error({ eventCode: LOG_EVENTS.DATABASE_POOL_FAILED, err }, "Erro inesperado no pool de conexões da telemetria");
  });
  globalRef.__metricsPool = pool;
  return pool;
}

/**
 * Encerramento explícito — chamado por quem é dono do ciclo de vida do
 * processo (worker, instrumentation do Next). Este módulo NÃO instala
 * handlers de sinal: registrar process.once aqui competiria com o shutdown
 * ordenado do worker (parar filas ANTES de fechar o banco).
 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  await pgPool.end();
  const metricsPool = globalRef.__metricsPool;
  globalRef.__metricsPool = undefined;
  await metricsPool?.end();
}
