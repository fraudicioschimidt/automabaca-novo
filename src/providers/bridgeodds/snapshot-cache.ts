import type { Prisma } from "@/src/generated/prisma/client";
import { readProviderCache, writeProviderCache } from "@/src/providers/provider-cache";
import { SingleFlight } from "@/src/providers/core/single-flight";
import { bridgeClosingIsFinal, isBridgeMatchPayload, type BridgeMatch } from "./types";

const CURRENT_PRICE_TTL_MS = 60_000;
const FINAL_PRICE_TTL_MS = 30 * 86_400_000;
const IDENTITY_MAX_AGE_MS = 30 * 86_400_000;
const SNAPSHOT_KEY_PREFIX = "match:v2:";

/**
 * A identidade lê o snapshot VENCIDO (até 30 dias depois de colhido): a purga
 * dos caches expirados precisa poupar essas linhas nesse prazo.
 */
export const BRIDGE_SNAPSHOT_STALE_READ = {
  provider: "bridgeodds",
  keyPrefix: SNAPSHOT_KEY_PREFIX,
  maxAgeMs: IDENTITY_MAX_AGE_MS,
} as const;

export type BridgeSnapshotPurpose = "identity" | "current_price" | "closing";
export type BridgeObservedMatch = { match: BridgeMatch; observedAt: Date };

type CachedBridgeSnapshot = {
  version: 1;
  phase: "current" | "final";
  match: BridgeMatch;
};

const flights = new SingleFlight<BridgeObservedMatch | null>();

function parseSnapshot(value: unknown): CachedBridgeSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || (row.phase !== "current" && row.phase !== "final")) return null;
  if (!isBridgeMatchPayload(row.match)) return null;
  return { version: 1, phase: row.phase, match: row.match };
}

function cacheKey(providerMatchId: string, phase: "current" | "final"): string {
  return `${SNAPSHOT_KEY_PREFIX}${providerMatchId}:${phase}`;
}

export async function readBridgeMatchSnapshot(params: {
  providerMatchId: string;
  purpose: BridgeSnapshotPurpose;
  now?: Date;
  /** Fechamento: a linha "final" colhida antes do horário da aposta não serve. */
  betKickoffUtc?: Date | null;
}): Promise<BridgeObservedMatch | null> {
  const now = params.now ?? new Date();
  const phases: Array<"current" | "final"> = params.purpose === "closing"
    ? ["final"]
    : params.purpose === "current_price"
      ? ["current"]
      : ["final", "current"];
  for (const phase of phases) {
    const cached = await readProviderCache<unknown>({
      provider: "bridgeodds",
      key: cacheKey(params.providerMatchId, phase),
      allowStale: params.purpose === "identity",
      now,
    });
    if (!cached) continue;
    const parsed = parseSnapshot(cached.data);
    if (
      !parsed ||
      parsed.phase !== phase ||
      String(parsed.match.match_id) !== params.providerMatchId
    ) continue;
    // Linha "final" colhida antes do início (na Bridge ou na aposta) era a
    // linha atual de um jogo remarcado; outra aposta do mesmo jogo pode tê-la
    // gravado com o horário velho.
    if (phase === "final" && !bridgeClosingIsFinal(parsed.match, cached.fetchedAt, params.betKickoffUtc)) continue;
    const ageMs = now.getTime() - cached.fetchedAt.getTime();
    if (params.purpose === "current_price" && ageMs > CURRENT_PRICE_TTL_MS) continue;
    if (params.purpose === "identity" && ageMs > IDENTITY_MAX_AGE_MS) continue;
    return { match: parsed.match, observedAt: cached.fetchedAt };
  }
  return null;
}

export async function writeBridgeMatchSnapshot(params: {
  match: BridgeMatch;
  purpose: BridgeSnapshotPurpose;
  observedAt?: Date;
}): Promise<BridgeObservedMatch> {
  const observedAt = params.observedAt ?? new Date();
  const phase = params.purpose === "closing" && bridgeClosingIsFinal(params.match, observedAt) ? "final" : "current";
  const payload: CachedBridgeSnapshot = { version: 1, phase, match: params.match };
  await writeProviderCache({
    provider: "bridgeodds",
    key: cacheKey(String(params.match.match_id), phase),
    data: payload as unknown as Prisma.InputJsonValue,
    ttlMs: phase === "final" ? FINAL_PRICE_TTL_MS : CURRENT_PRICE_TTL_MS,
    now: observedAt,
  });
  return { match: params.match, observedAt };
}

export async function withBridgeSnapshotSingleflight(
  providerMatchId: string,
  purpose: BridgeSnapshotPurpose,
  /** O alcance da busca (modo, exigência de resposta completa): voos de alcance diferente não se misturam. */
  variant: string,
  load: () => Promise<BridgeObservedMatch | null>,
): Promise<BridgeObservedMatch | null> {
  const phaseKey = purpose === "closing" ? "closing" : "current";
  return flights.run(`${providerMatchId}:${phaseKey}:${variant}`, load);
}

export function clearBridgeSnapshotInflight(): void {
  flights.clear();
}
