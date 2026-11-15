import { isBreakerOpen } from "@/src/infra/circuit-breaker";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import type { LlmGenerateJsonParams } from "./cascade";
import { requestChatJson } from "./chat-json";
import { cascadeModels, chatModels, evaluationOrder, modelsForRequest } from "./models";

const log = createLogger("llm-groq");

const CIRCUIT = "llm:groq";
const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

export const GROQ_REQUEST_TIMEOUT_MS = 25_000;
const TOTAL_BUDGET_MS = 35_000;

function apiKey(): string | null {
  return getEnv().GROQ_API_KEY?.trim() || null;
}

function baseUrl(): string {
  return (getEnv().GROQ_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function modelCircuit(model: string): string {
  return `${CIRCUIT}:${model}`;
}

export function groqConfigured(): boolean {
  if (getEnv().LLM_DISABLE_GROQ === "1") return false;
  return Boolean(apiKey());
}

export async function groqAvailable(): Promise<boolean> {
  if (!groqConfigured()) return false;
  for (const m of chatModels(cascadeModels("groq"))) {
    if (!(await isBreakerOpen(modelCircuit(m)))) return true;
  }
  return false;
}

function isRateLimit(status: number, msg: string): boolean {
  return status === 429 || /rate limit|quota|tokens per minute/i.test(msg);
}

/** Endereço e ajustes do chat de um modelo da Groq; a bancada de modelos
 * (`scripts/bench-leitura.ts`) manda o mesmo pedido. */
export function groqChatRoute(params: LlmGenerateJsonParams, model: string) {
  // Qualificado em bilhetes simples revisados. O raciocínio padrão do Qwen
  // pode esgotar o teto de 1.000 tokens de saída da conta antes do JSON.
  const qualifiedOcr = /^qwen\/qwen3\.[68]-27b$/.test(model) && !params.precisionVision
    && params.parts.filter((part) => "inlineData" in part).length === 1;
  return {
    baseUrl: baseUrl(),
    jsonInstruction: "Responda estritamente com um único objeto JSON válido, sem markdown.",
    ...(qualifiedOcr ? { maxCompletionTokens: 1000, reasoningEffort: "none" as const } : {}),
  };
}

function groqOne(params: LlmGenerateJsonParams, model: string, timeoutMs: number): Promise<unknown | null> {
  const key = apiKey();
  if (!key) return Promise.resolve(null);
  return requestChatJson(params, {
    provider: "Groq", model, key,
    timeoutMs, circuit: modelCircuit(model),
    isRateLimit, log,
    adaptOutputLimit: true,
    ...groqChatRoute(params, model),
  });
}

/** Chat OpenAI-compat com `json_object` — percorre os modelos do catálogo até obter JSON válido. */
export async function groqGenerateJson(
  params: LlmGenerateJsonParams,
): Promise<unknown | null> {
  if (!(await groqAvailable())) return null;
  const deadline = Math.min(params.deadlineAt ?? Infinity, Date.now() + TOTAL_BUDGET_MS);

  const order = evaluationOrder(modelsForRequest(cascadeModels("groq"), params), params);
  for (const [index, model] of order.entries()) {
    const remaining = deadline - Date.now();
    if (params.skipRemainingModels?.("groq")) break;
    if (remaining <= 0) {
      // Modelo que o orçamento não alcançou não foi ouvido.
      for (const skipped of order.slice(index)) params.onRouteOutcome?.("unavailable", skipped);
      break;
    }
    const data = await groqOne(params, model, Math.min(GROQ_REQUEST_TIMEOUT_MS, remaining));
    if (data !== null) return data;
  }
  return null;
}
