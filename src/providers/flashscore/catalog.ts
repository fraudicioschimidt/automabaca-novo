import { BudgetExhaustedError } from "@/src/domain/provider-error";
import { SingleFlight } from "@/src/providers/core/single-flight";
import { BoundedTtlCache } from "@/src/infra/bounded-ttl-cache";
import type { Prisma } from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";
import {
  deleteProviderCache,
  readProviderCache,
  writeProviderCache,
} from "@/src/providers/provider-cache";
import { listFlashscoreMatchesByDate } from "./client";
import {
  flashscoreMatchSchema,
  flattenFlashscoreMatches,
  type FlashscoreCatalogMatch,
} from "./types";
import { z } from "zod";

const log = createLogger("flashscore-catalog");

// Menor que o ciclo de resultados (10min): cada rodada enxerga um catálogo
// novo, mas todos os consumidores da mesma rodada ainda compartilham a chamada.
const CATALOG_TTL_MS = 9 * 60_000;
const EMPTY_TTL_MS = 60_000;
const CATALOG_MAX_ENTRIES = 64;

const cache = new BoundedTtlCache<
  string,
  { matches: FlashscoreCatalogMatch[] | null; at: number }
>(CATALOG_MAX_ENTRIES, CATALOG_TTL_MS);
const flights = new SingleFlight<FlashscoreCatalogMatch[] | null>();

const persistedCatalogSchema = z.object({
  version: z.literal(1),
  matches: z.array(flashscoreMatchSchema.extend({
    tournament: z.object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      countryName: z.string().nullable(),
    }),
  })).nullable(),
});

function persistentCatalogKey(key: string): string {
  return `catalog:${key}:v1`;
}

/** Catálogo rederivável e compartilhado entre settlement e resolução de esporte. */
export async function getFlashscoreCatalog(
  dayKey: string,
  sportId: number,
  deps: {
    fetch?: typeof listFlashscoreMatchesByDate;
    now?: () => number;
  } = {},
): Promise<FlashscoreCatalogMatch[] | null> {
  const key = `${sportId}:${dayKey}`;
  const now = deps.now?.() ?? Date.now();
  const hit = cache.get(key, now);
  if (hit) {
    const ttl = hit.matches ? CATALOG_TTL_MS : EMPTY_TTL_MS;
    if (now - hit.at < ttl) return hit.matches;
    cache.delete(key);
  }

  // A leitura e validação do cache também são trabalho compartilhado:
  // após reiniciar o processo, a mesma rodada pode pedir o catálogo muitas vezes.
  return flights.run(key, async () => {
    const persisted = await readProviderCache<unknown>({
      provider: "flashscore",
      key: persistentCatalogKey(key),
      now: new Date(now),
    });
    const parsed = persistedCatalogSchema.safeParse(persisted?.data);
    if (persisted && parsed.success) {
      const entry = { matches: parsed.data.matches, at: persisted.fetchedAt.getTime() };
      cache.set(key, entry, now, Math.max(1, persisted.expiresAt.getTime() - now));
      return entry.matches;
    }
    const fetcher = deps.fetch ?? listFlashscoreMatchesByDate;
    try {
      const groups = await fetcher(dayKey, sportId);
      const matches = groups ? flattenFlashscoreMatches(groups) : null;
      const cachedAt = deps.now?.() ?? Date.now();
      const ttl = matches ? CATALOG_TTL_MS : EMPTY_TTL_MS;
      cache.set(key, { matches, at: cachedAt }, cachedAt, ttl);
      try {
        await writeProviderCache({
          provider: "flashscore",
          key: persistentCatalogKey(key),
          data: { version: 1, matches } as unknown as Prisma.InputJsonValue,
          ttlMs: ttl,
          now: new Date(cachedAt),
        });
      } catch {
        // Este cache é rederivável; falhar ao compartilhá-lo não invalida
        // a resposta já obtida nem justifica gastar outra chamada.
        log.warn({ sportId, dayKey }, "falha ao persistir catálogo flashscore — resposta preservada no L1");
      }
      return matches;
    } catch (err) {
      // Budget esgotado NAO e resposta: nao entra no cache, senao "nao
      // perguntei" seria servido como "nao tem jogo".
      if (err instanceof BudgetExhaustedError) {
        log.warn({ sportId, dayKey }, "catalogo flashscore sem budget — sem cache negativo");
        return null;
      }
      throw err;
    }
  });
}

/** Simula a troca de processo sem invalidar o catálogo compartilhado. */
export function clearFlashscoreCatalogMemoryCache(): void {
  cache.clear();
  flights.clear();
}

/** Invalida o catálogo compartilhado em todos os processos. */
export async function clearFlashscoreCatalogCache(): Promise<void> {
  clearFlashscoreCatalogMemoryCache();
  await deleteProviderCache({ provider: "flashscore", keyPrefix: "catalog:" });
}
