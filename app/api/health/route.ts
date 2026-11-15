import { NextResponse } from "next/server";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { PGBOSS_SCHEMA } from "@/src/infra/boss";
import { QUEUES } from "@/src/infra/queue-contract";
import { WORKER_HEARTBEAT_STALE_MS, WORKER_SINGLETON_LOCK_HELD_SQL } from "@/src/domain/health";
import { observedRoute } from "@/src/services/ops/http-telemetry";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import {
  resetProductionOutageWatch,
  watchProductionOutage,
  type HealthSample,
} from "@/src/services/ops/production-outage-watch";

export const dynamic = "force-dynamic";
const log = createLogger("health");
const HEALTH_CACHE_MS = 2_000;
const CACHE_CONTROL = "public, max-age=2";

type HealthBody = {
  ok: boolean;
  db: boolean;
  worker: boolean;
  heartbeat: "fresh" | "stale" | "unavailable";
  release: string;
};

/**
 * A sonda roda a cada 2 s de cache, e uma métrica por sonda faria do health
 * quase metade da tabela. Grava quando o status muda (a queda e a volta entram
 * na hora) e, com o status parado, uma amostra a cada 5 min.
 */
const HEALTH_METRIC_SAMPLE_MS = 5 * 60_000;

type Probed = { status: number; body: HealthBody };

let cache: ({ expiresAt: number } & Probed) | null = null;
let inFlight: Promise<Probed> | null = null;
let lastHealthMetric: { status: number; at: number } | null = null;

/** Só para testes: o cache de 2s, a última amostra e a queda acompanhada cruzariam casos no mesmo processo. */
export function resetPublicHealthCache(): void {
  cache = null;
  inFlight = null;
  lastHealthMetric = null;
  resetProductionOutageWatch();
}

function shouldSampleHealthMetric(
  last: { status: number; at: number } | null,
  status: number,
  now: number,
): boolean {
  return last === null || last.status !== status || now - last.at >= HEALTH_METRIC_SAMPLE_MS;
}

/**
 * Health do sistema (rota pública — whitelisted no middleware):
 * - db: SELECT 1 contra o Postgres.
 * - worker: advisory lock do singleton (cai se o processo morrer) E heartbeat
 *   fresco. Só o heartbeat deixava o site 200 por até ~15 min após o crash.
 * Cache de 2s: flood anônimo não abre uma query por GET.
 * Cada sonda também alimenta o aviso de queda (`production-outage-watch.ts`).
 */

async function probe(): Promise<Probed & { sample: HealthSample }> {
  let dbOk = false;
  let lastHeartbeat: Date | null = null;
  let lockHeld = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (err) {
    log.error(
      { eventCode: LOG_EVENTS.HEALTH_DATABASE_QUERY_FAILED, err },
      "sonda do banco no health falhou",
    );
  }

  let heartbeat: HealthBody["heartbeat"] = "unavailable";
  if (dbOk) {
    try {
      const lockRows = await prisma.$queryRawUnsafe<Array<{ held: boolean }>>(
        WORKER_SINGLETON_LOCK_HELD_SQL,
      );
      lockHeld = lockRows[0]?.held === true;
    } catch (err) {
      log.error(
        { eventCode: LOG_EVENTS.HEALTH_LOCK_QUERY_FAILED, err },
        "sonda do lock singleton no health falhou",
      );
    }
    try {
      const queueTable = Prisma.raw(`"${PGBOSS_SCHEMA}"."job"`);
      const rows = await prisma.$queryRaw<Array<{ completed_on: Date | null }>>(Prisma.sql`
        SELECT max(completed_on) AS completed_on
        FROM ${queueTable}
        WHERE name = ${QUEUES.healthHeartbeat} AND state = 'completed'
          AND output ? 'workerInstance'
      `);
      lastHeartbeat = rows[0]?.completed_on ?? null;
      heartbeat = "stale";
    } catch (err) {
      log.error(
        { eventCode: LOG_EVENTS.HEALTH_HEARTBEAT_QUERY_FAILED, err },
        "consulta do heartbeat do worker falhou",
      );
    }
  }

  const heartbeatFresh =
    lastHeartbeat !== null && Date.now() - lastHeartbeat.getTime() < WORKER_HEARTBEAT_STALE_MS;
  if (heartbeatFresh) heartbeat = "fresh";
  const workerOk = dbOk && lockHeld && heartbeatFresh;
  const ok = dbOk && workerOk;
  return {
    sample: { ok, db: dbOk, lockHeld, lastHeartbeat },
    status: ok ? 200 : 503,
    body: {
      ok,
      db: dbOk,
      worker: workerOk,
      heartbeat,
      release: (process.env.AUTOMABACA_RELEASE_SHA ?? "development").slice(0, 12),
    },
  };
}

async function handleGet(_request: Request): Promise<NextResponse> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.body, {
      status: cache.status,
      headers: { "Cache-Control": CACHE_CONTROL },
    });
  }
  if (!inFlight) {
    inFlight = (async () => {
      const startedAt = Date.now();
      const { sample, ...probed } = await probe();
      // O aviso de queda sai por fora: a sonda não espera banco nem Telegram.
      watchProductionOutage(sample);
      if (shouldSampleHealthMetric(lastHealthMetric, probed.status, Date.now())) {
        lastHealthMetric = { status: probed.status, at: Date.now() };
        // Sem `await`: a resposta não espera a gravação (nunca lança).
        recordOperationalMetric({
          kind: "http", name: "/api/health", outcome: probed.status >= 500 ? "error" : "success",
          statusCode: probed.status, durationMs: Date.now() - startedAt,
          labels: { method: "GET", sampling: "status_change_or_5min" },
        }).catch(() => undefined);
      }
      cache = { expiresAt: Date.now() + HEALTH_CACHE_MS, ...probed };
      return probed;
    })().finally(() => { inFlight = null; });
  }
  const probed = await inFlight;
  return NextResponse.json(probed.body, {
    status: probed.status,
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}

// Correlação/log por request; persistência só na mudança de status ou a cada 5 min.
export const GET = observedRoute("/api/health", handleGet, { metric: false });
