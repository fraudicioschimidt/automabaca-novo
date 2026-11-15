import { readLogArchiveHealth } from "@/src/infra/observability-status";
import { observedRoute } from "@/src/services/ops/http-telemetry";

export const dynamic = "force-dynamic";

const HEALTH_CACHE_MS = 2_000;
const CACHE_CONTROL = "public, max-age=2";

type ObservabilityBody = {
  ok: boolean;
  collection: string;
  export: string;
  offsite: string;
  reasons: string[];
};

let cache: { expiresAt: number; status: number; body: ObservabilityBody } | null = null;
let inFlight: Promise<{ status: number; body: ObservabilityBody }> | null = null;

/** Só para testes: o cache de 2s cruzaria casos no mesmo processo. */
export function resetObservabilityHealthCache(): void {
  cache = null;
  inFlight = null;
}

async function probe(): Promise<{ status: number; body: ObservabilityBody }> {
  // A rota é pública: sai só o veredito. O detalhe do backup (horários, apostas) fica no painel.
  const { ok, collection, export: exported, offsite, reasons } = await readLogArchiveHealth();
  return {
    status: ok ? 200 : 503,
    body: { ok, collection, export: exported, offsite, reasons },
  };
}

async function handleGet(_request: Request): Promise<Response> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return Response.json(cache.body, {
      status: cache.status,
      headers: { "cache-control": CACHE_CONTROL },
    });
  }
  if (!inFlight) {
    inFlight = (async () => {
      const probed = await probe();
      cache = { expiresAt: Date.now() + HEALTH_CACHE_MS, ...probed };
      return probed;
    })().finally(() => {
      inFlight = null;
    });
  }
  const probed = await inFlight;
  return Response.json(probed.body, {
    status: probed.status,
    headers: { "cache-control": CACHE_CONTROL },
  });
}

// Rota pública: um flood anônimo não pode abrir I/O de disco (cache em memória com
// coalescência, SEC-04) nem gravar uma métrica por GET. O 503 é o veredito do vigia
// do arquivo de logs, que já alerta; o log da requisição continua.
export const GET = observedRoute("/api/health/observability", handleGet, { metric: false });
