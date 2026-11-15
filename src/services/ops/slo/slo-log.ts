import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { prisma } from "@/src/infra/prisma";
import type { OperationalSloRow } from "@/src/services/ops/slo/slo";

const log = createLogger("ops-slo");
const SUMMARY_MS = 60 * 60_000;

export type SloLogRow = OperationalSloRow & {
  /** Até 5 correlationIds recentes da série (investigação no journal). */
  sampleCorrelationIds?: string[];
};

/** Estado de emissão por processo; os incidentes continuam persistidos no banco. */
export function createSloLogReporter() {
  const states = new Map<string, { signature: string; at: number; suppressed: number }>();
  return (rows: SloLogRow[], now = Date.now()) => {
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.kind}:${row.name}`;
      seen.add(key);
      const previous = states.get(key);
      if (row.status !== "breach") {
        // Amostra curta/ausência de tráfego não prova recuperação.
        if (previous && row.status === "healthy") {
          log.info({ eventCode: LOG_EVENTS.SLO_RECOVERED, kind: row.kind, name: row.name,
            suppressed: previous.suppressed, samples: row.samples }, "SLO recuperado");
          states.delete(key);
        }
        continue;
      }
      // Variação numérica a cada consulta não representa nova causa.
      const signature = JSON.stringify(row.reasons.map((reason) => {
        const exceeded = reason.match(/([\d.]+)(?:ms|%) > ([\d.]+)/);
        const severity = exceeded
          ? Math.floor(Math.log2(Math.max(1, Number(exceeded[1]) / Number(exceeded[2]))))
          : reason.startsWith("sucesso ") ? Math.floor(row.successPct / 5) : 0;
        return [reason.replace(/\d+(?:\.\d+)?/g, "#"), severity];
      }).sort());
      const changed = previous && previous.signature !== signature;
      if (previous && !changed && now - previous.at < SUMMARY_MS) {
        previous.suppressed += 1;
        continue;
      }
      log.warn({
        eventCode: !previous ? LOG_EVENTS.SLO_BREACH_DETECTED
          : changed ? LOG_EVENTS.SLO_BREACH_CHANGED : LOG_EVENTS.SLO_BREACH_SUMMARY,
        kind: row.kind, name: row.name, reasons: row.reasons,
        samples: row.samples, errors: row.errors, retries: row.retries,
        successPct: row.successPct, p95DurationMs: row.p95DurationMs,
        suppressed: previous?.suppressed ?? 0,
        ...(row.sampleCorrelationIds?.length
          ? { sampleCorrelationIds: row.sampleCorrelationIds }
          : {}),
      }, "SLO operacional violado; consulte /operacoes");
      states.set(key, { signature, at: now, suppressed: 0 });
    }
    for (const [key, state] of states) {
      if (!seen.has(key)) {
        log.info({ eventCode: LOG_EVENTS.SLO_NO_RECENT_SAMPLES, series: key,
          suppressed: state.suppressed }, "SLO sem amostras recentes; recuperação não confirmada");
        states.delete(key);
      }
    }
  };
}

export const reportSloLogs = createSloLogReporter();

const SAMPLE_CORRELATION_LIMIT = 5;

type SloSeriesRow = {
  kind: string;
  name: string;
  status: "healthy" | "warning" | "breach";
};

/** CorrelationIds recentes da série violada — ponte journal ↔ /operacoes. */
async function sampleCorrelationIdsForSeries(
  kind: string,
  name: string,
  hours = 1,
): Promise<string[]> {
  const intervalHours = Math.max(1, Math.min(168, Math.floor(hours)));
  const rows = await prisma.$queryRaw<Array<{ correlationId: string | null }>>`
    SELECT labels->>'correlationId' AS "correlationId"
    FROM operational_metrics
    WHERE kind = ${kind}
      AND name = ${name}
      AND "occurredAt" >= now() - (${intervalHours}::text || ' hours')::interval
      AND labels->>'correlationId' IS NOT NULL
      AND labels->>'correlationId' <> ''
    ORDER BY "occurredAt" DESC
    LIMIT 40
  `;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const id = row.correlationId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= SAMPLE_CORRELATION_LIMIT) break;
  }
  return out;
}

export async function withSampleCorrelationIds<T extends SloSeriesRow>(
  rows: T[],
): Promise<Array<T & Pick<SloLogRow, "sampleCorrelationIds">>> {
  const breaches = rows.filter((row) => row.status === "breach");
  if (breaches.length === 0) return rows;
  const samples = await Promise.all(
    breaches.map(async (row) => ({
      key: `${row.kind}:${row.name}`,
      ids: await sampleCorrelationIdsForSeries(row.kind, row.name, 1),
    })),
  );
  const byKey = new Map(samples.map((item) => [item.key, item.ids]));
  return rows.map((row) => {
    if (row.status !== "breach") return row;
    const ids = byKey.get(`${row.kind}:${row.name}`);
    return ids?.length ? { ...row, sampleCorrelationIds: ids } : row;
  });
}
