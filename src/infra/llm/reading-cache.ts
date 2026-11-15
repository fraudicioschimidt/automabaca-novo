import { createHash } from "node:crypto";
import { prisma } from "@/src/infra/prisma";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import type { Prisma } from "@/src/generated/prisma/client";
import type { LlmGenerateJsonParams } from "./cascade";
import type { OcrReading } from "@/src/domain/capture-ocr-evidence";
import { llmReadingIdentity } from "./attempt-metrics";

const PROVIDER = "llm:reading-cache:v1";
const TTL_MS = 60 * 60_000;
const MAX_BYTES = 256_000;
const log = createLogger("llm-reading-cache");
type Route = { provider: string; model: string; endpoint: OcrReading["endpoint"] };
type Entry = { version: 1; data: unknown; sourceData: unknown; reading: OcrReading };
function enabled(params: LlmGenerateJsonParams) {
  const env = getEnv();
  return Boolean(params.contractVersion) && env.LLM_OCR_CACHE !== "0"
    && (env.NODE_ENV !== "test" || env.LLM_OCR_CACHE === "1");
}
/** Caption, exact image bytes, policy text, contract and source revision/time
 * context all participate. Credentials never participate or enter the payload. */
export function llmReadingCacheKey(params: LlmGenerateJsonParams, route: Route): string {
  return createHash("sha256").update(JSON.stringify([route.provider.toLowerCase(), route.model, route.endpoint,
    params.contractVersion, params.cacheContext, params.systemInstruction, params.responseSchema,
    params.ocrSystemInstruction, params.ocrResponseSchema, params.parts])).digest("hex");
}
export async function cachedLlmReading(params: LlmGenerateJsonParams, route: Route): Promise<Entry | null> {
  if (!enabled(params)) return null;
  try {
    const row = await prisma.providerCache.findUnique({ where: { provider_key: { provider: PROVIDER, key: llmReadingCacheKey(params, route) } } });
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    const entry = row.payload as unknown as Entry;
    if (entry.version !== 1 || !entry.reading || entry.reading.model !== route.model
      || entry.reading.provider !== route.provider.toLowerCase() || entry.reading.endpoint !== route.endpoint) return null;
    if (params.contentState?.(entry.data) === "invalid") return null;
    params.onReading?.({ ...entry.reading, cached: true }, entry.sourceData);
    await recordOperationalMetric({ kind: "provider", name: "llm.cache", outcome: "success", durationMs: 0,
      labels: { provider: route.provider.toLowerCase(), model: route.model, endpoint: route.endpoint,
        contractVersion: params.contractVersion ?? "unversioned", task: params.label } });
    return entry;
  } catch {
    log.warn({ provider: route.provider, model: route.model }, "cache de leitura indisponível — tenta provedor");
    return null;
  }
}
export async function saveLlmReading(params: LlmGenerateJsonParams, route: Route, data: unknown,
  sourceData = data, modelVersion?: string): Promise<void> {
  if (!enabled(params) || !params.contentState || params.contentState(data) === "invalid") return;
  const entry: Entry = { version: 1, data, sourceData,
    reading: llmReadingIdentity(params, route.provider, route.model, route.endpoint, sourceData, modelVersion) };
  const encoded = JSON.stringify(entry);
  if (Buffer.byteLength(encoded) > MAX_BYTES) return;
  try {
    const fetchedAt = new Date(), expiresAt = new Date(fetchedAt.getTime() + TTL_MS);
    const payload = JSON.parse(encoded) as Prisma.InputJsonValue;
    await prisma.providerCache.upsert({ where: { provider_key: { provider: PROVIDER, key: llmReadingCacheKey(params, route) } },
      create: { provider: PROVIDER, key: llmReadingCacheKey(params, route), payload, fetchedAt, expiresAt },
      update: { payload, fetchedAt, expiresAt } });
  } catch {
    log.warn({ provider: route.provider, model: route.model }, "não foi possível preservar leitura no cache");
  }
}
