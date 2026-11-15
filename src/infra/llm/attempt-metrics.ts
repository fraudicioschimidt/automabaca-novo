import { createHash } from "node:crypto";
import type { OcrReading } from "@/src/domain/capture-ocr-evidence";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import type { LlmGenerateJsonParams } from "./cascade";
import { googleModelFamily, mistralModelFamily } from "./models";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function llmReadingIdentity(params: LlmGenerateJsonParams, provider: string, model: string,
  endpoint: OcrReading["endpoint"], data: unknown, modelVersion?: string): OcrReading {
  return { provider: provider.toLowerCase() as OcrReading["provider"], model, ...(modelVersion ? { modelVersion } : {}), endpoint,
    contractVersion: params.contractVersion,
    contractHash: digest([params.contractVersion, endpoint === "ocr" ? params.ocrSystemInstruction : params.systemInstruction,
      endpoint === "ocr" ? params.ocrResponseSchema : params.responseSchema]),
    sourceHash: digest(params.parts), responseHash: digest(data), receivedAt: new Date().toISOString() };
}

export type LlmAttemptResult = "accepted" | "rate_limit" | "timeout" | "http_error" |
  "request_error" | "empty" | "invalid_json" | "truncated" | "rejected" | "ocr_conflict";

/** One row per adapter attempt; SDK-internal retries may issue more HTTP calls.
 * Accepted means its extraction contract passed, which can include incomplete
 * drafts. Never stores keys, prompts or image content. `reportRoute: false`
 * leaves the route outcome to the caller: after the cooldown
 * (`reportUnavailableRoute`), because a route that has just left rotation is
 * not down, or from the retry that follows on the same route. */
export function startLlmAttempt(
  params: LlmGenerateJsonParams,
  provider: string,
  model: string,
  endpoint: "generate" | "chat" | "ocr" | "search",
) {
  const started = Date.now();
  let recorded = false;
  let usage: Record<string, number | string> = {};
  let contentState: ReturnType<NonNullable<LlmGenerateJsonParams["contentState"]>> | undefined;
  let sourceContentState: typeof contentState;
  const finish = async (result: LlmAttemptResult, statusCode?: number, options: { reportRoute?: boolean } = {}): Promise<void> => {
    if (recorded) return;
    recorded = true;
    const durationMs = Date.now() - started;
    const labels = {
      provider: provider.toLowerCase(), model, endpoint, result,
      modality: params.parts.some((part) => "inlineData" in part) ? "image" : "text",
      task: params.label,
      ...(params.contractVersion ? { contractVersion: params.contractVersion } : {}),
      ...(contentState ? { extractionState: result === "rejected" && contentState === "complete" ? "review" : contentState } : {}),
      ...(sourceContentState ? { sourceExtractionState: sourceContentState } : {}),
      ...(params.stakePolicy ? { stakePolicy: params.stakePolicy } : {}),
      ...(params.itemRef ? { chatIdHash: params.itemRef.chatIdHash, messageId: params.itemRef.messageId } : {}),
    };
    const receivedContent = ["accepted", "empty", "invalid_json", "truncated", "rejected", "ocr_conflict"].includes(result);
    // Resposta vazia costuma ser passageira: não prova que o modelo leu.
    if (options.reportRoute !== false) params.onRouteOutcome?.(receivedContent && result !== "empty" ? "responded" : "unavailable", model);
    const transportOk = statusCode === undefined ? receivedContent : statusCode >= 200 && statusCode < 300;
    // Keep the existing adapter-attempt dataset for OCR acceptance reports.
    await recordOperationalMetric({
      kind: "provider",
      name: "llm.attempt",
      outcome: result === "accepted" ? "success" : "error",
      durationMs,
      statusCode,
      labels: { ...labels, ...usage },
    });
    await recordOperationalMetric({
      kind: "provider", name: `llm.transport.${provider.toLowerCase()}.${endpoint}`,
      outcome: transportOk ? "success" : "error", durationMs, statusCode, labels,
    });
    if (receivedContent) await recordOperationalMetric({
      kind: "provider", name: `llm.content.${provider.toLowerCase()}.${endpoint}`,
      outcome: result === "accepted" ? "success"
        : result === "rejected" || result === "ocr_conflict" ? "expected_retry" : "error",
      durationMs, statusCode, labels,
    });
  };
  finish.usage = (response: unknown) => { usage = usageLabels(provider, model, endpoint, response); };
  finish.reading = (data: unknown, modelVersion?: string, sourceData = data) => {
    contentState = params.contentState?.(data);
    sourceContentState = params.sourceContentState?.(sourceData);
    params.onReading?.(llmReadingIdentity(params, provider, model, endpoint, sourceData, modelVersion), sourceData);
  };
  return finish;
}

export type LlmAttempt = ReturnType<typeof startLlmAttempt>;

export function llmErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const value = Number(record.status ?? record.statusCode ?? record.code);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

export function llmRequestFailure(error: unknown): LlmAttemptResult {
  const name = error instanceof Error ? error.name : "";
  if (/timeout|abort/i.test(name)) return "timeout";
  return "request_error";
}

/* Consumo por tentativa e custo equivalente em tarifa paga (nunca é fatura). */

export type LlmUsage = {
  inputTokens?: number; outputTokens?: number; reasoningTokens?: number;
  cachedInputTokens?: number; pages?: number;
};
export const OCR_PRICE_VERSION = "2026-09-13";
// Tarifa por página em USD; não é o piso monetário do ledger.
const MISTRAL_OCR_USD_PER_PAGE = 0.005;
/** Standard list prices, USD per million tokens; excludes cache discounts/tax.
 * Unknown prices remain null. This is a paid equivalent, never an invoice. */
const TOKEN_PRICES: Record<string, readonly [number, number]> = {
  "gemini-3.1-flash-lite": [0.25, 1.5], "gemini-2.5-flash-lite": [0.1, 0.4],
  "gemini-2.5-flash": [0.3, 2.5], "gemini-3.5-flash": [1.5, 9],
  "gemini-3.5-flash-lite": [0.3, 2.5],
  "qwen/qwen3.8-27b": [0.8, 4],
  "mistral-small-2603": [0.15, 0.6], "mistral-medium-2604": [1.5, 7.5],
  "ministral-3b-2512": [0.1, 0.1], "ministral-8b-2512": [0.15, 0.15],
  "ministral-14b-2512": [0.2, 0.2], "labs-leanstral-1-5-1": [0, 0],
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function readLlmUsage(provider: string, endpoint: string, response: unknown): LlmUsage {
  const body = object(response);
  if (endpoint === "ocr") return { pages: count(object(body.usage_info).pages_processed) };
  if (provider.toLowerCase() === "gemini") {
    const usage = object(body.usageMetadata);
    const candidate = count(usage.candidatesTokenCount), thoughts = count(usage.thoughtsTokenCount);
    return { inputTokens: count(usage.promptTokenCount),
      outputTokens: candidate === undefined ? undefined : candidate + (thoughts ?? 0),
      reasoningTokens: thoughts, cachedInputTokens: count(usage.cachedContentTokenCount) };
  }
  const usage = object(body.usage);
  return { inputTokens: count(usage.prompt_tokens), outputTokens: count(usage.completion_tokens),
    // OpenAI-compatible completion_tokens ALREADY includes reasoning.
    reasoningTokens: count(object(usage.completion_tokens_details).reasoning_tokens),
    cachedInputTokens: count(object(usage.prompt_tokens_details).cached_tokens) };
}

export function paidEquivalentUsd(provider: string, model: string, endpoint: string, usage: LlmUsage): number | null {
  const family = provider.toLowerCase() === "gemini" ? googleModelFamily(model) : mistralModelFamily(model);
  if (endpoint === "ocr") return ["mistral-ocr-4-0", "mistral-ocr-4-1"].includes(family) && usage.pages !== undefined ? usage.pages * MISTRAL_OCR_USD_PER_PAGE : null;
  const price = provider.toLowerCase() === "gemini" && /^gemini-3\.[678]-flash$/.test(family)
    ? (Date.now() < Date.parse("2027-01-01T00:00:00Z") ? [0.75, 3.75] as const : [1.5, 7.5] as const)
    : TOKEN_PRICES[family];
  if (!price || usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
  return (usage.inputTokens * price[0] + usage.outputTokens * price[1]) / 1_000_000;
}

export function usageLabels(provider: string, model: string, endpoint: string, response: unknown): Record<string, number | string> {
  const usage = readLlmUsage(provider, endpoint, response);
  const labels: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(usage)) if (value !== undefined) labels[key] = value;
  const cost = paidEquivalentUsd(provider, model, endpoint, usage);
  if (cost !== null) { labels.paidEquivalentUsd = cost; labels.priceVersion = OCR_PRICE_VERSION; }
  return labels;
}
