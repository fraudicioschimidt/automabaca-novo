import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ metric: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: mocks.metric }));
import { paidEquivalentUsd, readLlmUsage, startLlmAttempt, usageLabels } from "@/src/infra/llm/attempt-metrics";
beforeEach(() => vi.clearAllMocks());

it("mede uma tentativa rejeitada uma vez, com modelo e duração, sem payload sensível", async () => {
  const finish = startLlmAttempt({ parts: [{ inlineData: { mimeType: "image/png", data: "private-image" } }], systemInstruction: "private-prompt", responseSchema: {}, label: "extract:image" }, "Mistral", "ocr-test", "ocr");
  await finish("rejected", 200);
  await finish("accepted", 200);
  expect(mocks.metric).toHaveBeenCalledTimes(3);
  expect(mocks.metric).toHaveBeenCalledWith(expect.objectContaining({ name: "llm.attempt", outcome: "error", statusCode: 200, durationMs: expect.any(Number), labels: { provider: "mistral", model: "ocr-test", endpoint: "ocr", result: "rejected", modality: "image", task: "extract:image" } }));
  expect(mocks.metric).toHaveBeenCalledWith(expect.objectContaining({ name: "llm.transport.mistral.ocr", outcome: "success" }));
  expect(mocks.metric).toHaveBeenCalledWith(expect.objectContaining({ name: "llm.content.mistral.ocr", outcome: "expected_retry" }));
  expect(JSON.stringify(mocks.metric.mock.calls)).not.toContain("private-");
});

it("distingue completude da fonte de aceite com stake fixa sem alterar a resposta", async () => {
  const data = { stake: null };
  const finish = startLlmAttempt({ parts: [{ inlineData: { mimeType: "image/png", data: "private-image" } }], systemInstruction: "private-prompt", responseSchema: {}, label: "channel-image",
    contentState: () => "complete", sourceContentState: () => "draft", stakePolicy: "ALWAYS" }, "gemini", "test", "generate");
  finish.reading(data);
  await finish("accepted", 200);
  expect(data).toEqual({ stake: null });
  expect(mocks.metric).toHaveBeenCalledWith(expect.objectContaining({ name: "llm.attempt", outcome: "success", labels: expect.objectContaining({ result: "accepted", extractionState: "complete", sourceExtractionState: "draft", stakePolicy: "ALWAYS" }) }));
  expect(JSON.stringify(mocks.metric.mock.calls)).not.toContain("private-");
});

it("soma pensamentos Gemini e não duplica pensamentos incluídos no completion_tokens Groq", () => {
  expect(readLlmUsage("gemini", "generate", { usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 300, thoughtsTokenCount: 700 } }))
    .toMatchObject({ inputTokens: 4000, outputTokens: 1000, reasoningTokens: 700 });
  const usage = readLlmUsage("groq", "chat", { usage: { prompt_tokens: 4000, completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 700 } } });
  expect(usage.outputTokens).toBe(1000);
  expect(paidEquivalentUsd("groq", "qwen/qwen3.8-27b", "chat", usage)).toBeCloseTo(0.0072);
});

it("ausência de usage ou tarifa não se transforma em custo zero", () => {
  expect(usageLabels("gemini", "gemini-3.1-flash-lite", "generate", {})).toEqual({});
  expect(paidEquivalentUsd("gemini", "unknown", "generate", { inputTokens: 10, outputTokens: 10 })).toBeNull();
  expect(usageLabels("groq", "qwen/qwen3.8-27b", "chat", { usage: { prompt_tokens: -1, completion_tokens: "20" } })).toEqual({});
});

it("cobra a página anotada, sem somar a transcrição básica", () => {
  expect(usageLabels("mistral", "mistral-ocr-4-0", "ocr", { usage_info: { pages_processed: 2 } }))
    .toMatchObject({ pages: 2, paidEquivalentUsd: 0.01 });
});

it("registra consumo de uma resposta rejeitada somente na tentativa física", async () => {
  const finish = startLlmAttempt({ parts: [{ text: "privado" }], systemInstruction: "privado", responseSchema: {}, label: "test" }, "gemini", "gemini-3.1-flash-lite", "generate");
  finish.usage({ usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 300 }, secret: "privado" });
  await finish("rejected", 200); await finish("accepted", 200);
  const rows = mocks.metric.mock.calls.map(([row]) => row);
  expect(rows.filter((row) => row.labels.paidEquivalentUsd !== undefined)).toHaveLength(1);
  expect(rows[0].labels.paidEquivalentUsd).toBeCloseTo(0.00145);
  expect(JSON.stringify(rows)).not.toContain("privado");
});
