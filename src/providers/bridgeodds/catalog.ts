import { BoundedTtlCache } from "@/src/infra/bounded-ttl-cache";
import { createLogger } from "@/src/infra/logger";
import type { Prisma } from "@/src/generated/prisma/client";
import { readProviderCache, writeProviderCache } from "@/src/providers/provider-cache";
import { SingleFlight } from "@/src/providers/core/single-flight";
import {
  BRIDGE_MAX_PAGES_CATALOG,
  queryOpeningClosing,
  unwrapOpeningClosing,
  type BridgeQueryFilters,
} from "./client";
import {
  prepareBridgeMatches,
  type BridgeQueryFn,
  type PreparedBridgeMatch,
} from "./scoring";
import { isBridgeMatchPayload, type BridgeMatch } from "./types";

const log = createLogger("bridgeodds-catalog");

/**
 * Cache de identidade de uma busca BridgeOdds. Busca filtrada é a rota quente;
 * catálogo completo fica disponível somente para consumidores explícitos.
 *
 * Identidade e preço têm frescores diferentes: a lista de fixtures pode ser
 * reaproveitada por 30min, mas odds com mais de 60s são revalidadas por
 * `match_id` antes de virar CLV (frescor por observação em `match.ts`). Cache
 * em memória é legítimo aqui: dado re-derivável, nenhum gasto depende dele.
 */

export const BRIDGE_CATALOG_TTL_MS = 30 * 60_000;
/** Entrada com menos disto é preço utilizável sem novo fetch. */
export const BRIDGE_CATALOG_FRESH_MS = 60_000;
/**
 * Catálogo truncado não deve ser relido por aposta: 15 páginas podem consumir
 * um sexto da hora. O fallback filtrado continua disponível durante o debounce
 * e uma nova leitura completa é liberada depois de 15min.
 */
export const BRIDGE_TRUNCATED_CACHE_TTL_MS = 15 * 60_000;
/** Buscas recentes (evento × esporte × dia), pequenas quando filtradas. */
const CATALOG_MAX_ENTRIES = 512;

type BridgeDayCatalog = {
  prepared: PreparedBridgeMatch[];
  /** true = paginação interrompida: o dia NÃO está completo. */
  truncated: boolean;
  /** A interrupção foi a cota ou o prazo, e não o teto de páginas. */
  incomplete?: boolean;
  fetchedAt: number;
  observedAtByMatchId?: Record<string, number>;
};

const cache = new BoundedTtlCache<string, BridgeDayCatalog>(
  CATALOG_MAX_ENTRIES,
  BRIDGE_CATALOG_TTL_MS,
);
const flights = new SingleFlight<BridgeDayCatalog>();

type PersistedBridgeCatalog = {
  version: 1;
  matches: BridgeMatch[];
  truncated: boolean;
  incomplete?: boolean;
  observedAtByMatchId?: Record<string, number>;
};

function parsePersistedCatalog(value: unknown): PersistedBridgeCatalog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !Array.isArray(row.matches) || typeof row.truncated !== "boolean") {
    return null;
  }
  if (!row.matches.every(isBridgeMatchPayload)) return null;
  const times = row.observedAtByMatchId;
  if (times != null && (typeof times !== "object" || Array.isArray(times) ||
    !Object.values(times).every((value) => typeof value === "number" && Number.isFinite(value)))) return null;
  return { version: 1, matches: row.matches, truncated: row.truncated,
    ...(row.incomplete === true ? { incomplete: true } : {}),
    ...(times ? { observedAtByMatchId: times as Record<string, number> } : {}) };
}

export function clearBridgeCatalogCache(): void {
  cache.clear();
  flights.clear();
}

/**
 * Chave sem separadores de controle: PostgreSQL rejeita byte NUL em `text`.
 * JSON também mantém a composição inequívoca quando nomes contêm `:`.
 */
export function bridgeCatalogCacheKey(params: {
  sport: string;
  date: string;
  filters?: BridgeQueryFilters;
}): string {
  return `v3:${JSON.stringify([
    params.sport,
    params.date,
    params.filters?.home ?? "",
    params.filters?.away ?? "",
    params.filters?.league ?? "",
  ])}`;
}

/**
 * Catálogo do dia, do cache quando válido. Um catálogo truncado é devolvido
 * como está (o chamador decide o fallback) e recebe TTL próprio, menor que o
 * catálogo completo, para evitar stampede sem esconder o dia indefinidamente.
 */
/** Catálogo persistido por web/worker/deploy; também aquece o cache em memória. */
async function readPersistedCatalog(key: string, now: number): Promise<BridgeDayCatalog | null> {
  const persisted = await readProviderCache<unknown>({
    provider: "bridgeodds",
    key: `search:${key}`,
    now: new Date(now),
  });
  const parsed = persisted ? parsePersistedCatalog(persisted.data) : null;
  if (!persisted || !parsed) return null;
  const catalog: BridgeDayCatalog = {
    prepared: prepareBridgeMatches(parsed.matches),
    truncated: parsed.truncated,
    ...(parsed.incomplete ? { incomplete: true } : {}),
    fetchedAt: persisted.fetchedAt.getTime(),
    observedAtByMatchId: parsed.observedAtByMatchId,
  };
  cache.set(key, catalog, now, Math.max(1, persisted.expiresAt.getTime() - now));
  return catalog;
}

/**
 * Catálogo do dia, do cache quando válido. Um catálogo truncado é devolvido
 * como está (o chamador decide o fallback) e recebe TTL próprio, menor que o
 * catálogo completo, para evitar stampede sem esconder o dia indefinidamente.
 */
export async function getBridgeDayCatalog(params: {
  sport: string;
  date: string;
  filters?: BridgeQueryFilters;
  query?: BridgeQueryFn;
  now?: number;
  deadlineMs?: number;
}): Promise<BridgeDayCatalog> {
  const now = params.now ?? Date.now();
  const key = bridgeCatalogCacheKey(params);
  const cached = cache.get(key, now);
  if (cached) {
    if (!cached.truncated) return cached;
    if (now - cached.fetchedAt <= BRIDGE_TRUNCATED_CACHE_TTL_MS) return cached;
    cache.delete(key);
  }

  const persistentEligible = !params.query && Boolean(params.filters);
  const query = params.query ?? queryOpeningClosing;
  return flights.run(key, async () => {
    // Compartilha também leitura, validação e preparação do cache persistido,
    // evitando repetir todo o catálogo para cada consumidor simultâneo.
    if (persistentEligible) {
      const persisted = await readPersistedCatalog(key, now);
      if (persisted) return persisted;
    }
    const { matches, truncated, incomplete, observedAtByMatchId } = unwrapOpeningClosing(
      await query({
        date: params.date,
        sport: params.sport,
        filters: params.filters,
        deadlineMs: params.deadlineMs,
        ...(params.deadlineMs != null ? { resumeIdentityPages: true } : {}),
        ...(params.filters ? {} : { maxPages: BRIDGE_MAX_PAGES_CATALOG }),
      }),
    );
    // A observação nasce quando a resposta chegou, não antes da espera do
    // gate/paginação. `now` explícito continua sendo relógio determinístico.
    const fetchedAt = params.now ?? Date.now();
    const catalog: BridgeDayCatalog = {
      prepared: prepareBridgeMatches(matches),
      truncated,
      ...(incomplete ? { incomplete: true } : {}),
      fetchedAt,
      ...(observedAtByMatchId ? { observedAtByMatchId } : {}),
    };
    if (truncated) {
      log.warn(
        { sport: params.sport, date: params.date, filters: params.filters, jogos: matches.length },
        "busca BridgeOdds truncada — resultado parcial preservado no debounce",
      );
    }
    cache.set(key, catalog, fetchedAt);
    if (persistentEligible) {
      const payload: PersistedBridgeCatalog = { version: 1, matches, truncated, ...(incomplete ? { incomplete: true } : {}),
        ...(observedAtByMatchId ? { observedAtByMatchId } : {}) };
      try {
        await writeProviderCache({
          provider: "bridgeodds",
          key: `search:${key}`,
          data: payload as unknown as Prisma.InputJsonValue,
          ttlMs: truncated ? BRIDGE_TRUNCATED_CACHE_TTL_MS : BRIDGE_CATALOG_TTL_MS,
          now: new Date(fetchedAt),
        });
      } catch {
        // O catálogo já está no L1 com a observação original do preço.
        log.warn({ sport: params.sport, date: params.date },
          "falha ao persistir catálogo BridgeOdds — resposta preservada no L1");
      }
    }
    return catalog;
  });
}
