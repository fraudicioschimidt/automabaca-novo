import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ rows: new Map<string, unknown>(), metrics: vi.fn(), enabled: "1" }));
vi.mock("@/src/infra/env", () => ({ getEnv: () => ({ NODE_ENV: "test", LLM_OCR_CACHE: state.enabled }) }));
vi.mock("@/src/infra/prisma", () => ({ prisma: { providerCache: {
  findUnique: vi.fn(async ({ where }) => state.rows.get(where.provider_key.key) ?? null),
  upsert: vi.fn(async ({ where, create }) => { state.rows.set(where.provider_key.key, create); }),
} } }));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: state.metrics }));
import { cachedLlmReading, saveLlmReading, llmReadingCacheKey } from "@/src/infra/llm/reading-cache";
import type { LlmGenerateJsonParams } from "@/src/infra/llm/cascade";
const route = { provider: "gemini", model: "fixture-model", endpoint: "generate" as const };
const params: LlmGenerateJsonParams = { parts: [{ inlineData: { mimeType: "image/jpeg", data: "first-image" } }, { text: "1u" }],
  label: "channel-image", systemInstruction: "extract", responseSchema: { type: "object" },
  contractVersion: "v2", cacheContext: "source-revision-1", contentState: () => "draft" };
beforeEach(() => { state.rows.clear(); state.metrics.mockClear(); state.enabled = "1"; vi.useRealTimers(); });
it("reaproveita resposta e identidade sem inflar contagem de chamadas HTTP", async () => {
  const raw = { isBet: true, odds: null, stake: "0,5" }, normalized = { ...raw, stake: .5 };
  await saveLlmReading(params, route, normalized, raw, "fixture-version");
  const onReading = vi.fn();
  const found = await cachedLlmReading({ ...params, onReading }, route);
  expect(found).toMatchObject({ data: normalized, sourceData: raw, reading: { modelVersion: "fixture-version" } });
  expect(onReading).toHaveBeenCalledWith(expect.objectContaining({ cached: true, contractVersion: "v2" }), raw);
  expect(state.metrics.mock.calls.map(([metric]) => metric.name)).toEqual(["llm.cache"]);
});
it("invalida por imagem, legenda, revisão, política, schema, protocolo e leitor", async () => {
  await saveLlmReading(params, route, { isBet: true });
  const changes = [
    { parts: [{ text: "2u" }] }, { cacheContext: "source-revision-2" }, { contractVersion: "v3" },
    { systemInstruction: "new policy" }, { responseSchema: { type: "array" } },
    { ocrSystemInstruction: "new OCR" },
  ];
  for (const change of changes) expect(await cachedLlmReading({ ...params, ...change }, route)).toBeNull();
  expect(await cachedLlmReading(params, { ...route, model: "other-model" })).toBeNull();
});
it("não reutiliza leitura expirada, inválida ou adulterada", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
  await saveLlmReading(params, route, { isBet: true });
  expect(await cachedLlmReading({ ...params, contentState: () => "invalid" }, route)).toBeNull();
  vi.setSystemTime(new Date("2026-09-12T13:00:01Z"));
  expect(await cachedLlmReading(params, route)).toBeNull();
  vi.setSystemTime(new Date("2026-09-12T12:01:00Z"));
  const entry = state.rows.get(llmReadingCacheKey(params, route)) as { payload: { reading: { model: string } } };
  entry.payload.reading.model = "another-reader";
  expect(await cachedLlmReading(params, route)).toBeNull();
});
it("rejeita entrada inválida, payload excessivo e permite desligar o cache", async () => {
  await saveLlmReading({ ...params, contentState: () => "invalid" }, route, {});
  await saveLlmReading(params, route, { text: "x".repeat(256001) });
  state.enabled = "0";
  await saveLlmReading(params, route, {});
  expect(state.rows.size).toBe(0);
});
