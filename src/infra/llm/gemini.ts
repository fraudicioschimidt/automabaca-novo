import { GoogleGenAI, MediaResolution, type GenerateContentParameters } from "@google/genai";
import { getEnv } from "@/src/infra/env";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { privacyHash } from "@/src/infra/privacy";
import { llmErrorStatus, llmRequestFailure, startLlmAttempt, type LlmAttempt, type LlmAttemptResult } from "./attempt-metrics";
import type { LlmGenerateJsonParams } from "./cascade";
import { cascadeModels, csvList, evaluationOrder, googleUsesPromptJson, modelsForRequest, visionEvaluationEnabled } from "./models";
import { parseStrictLlmJsonText } from "./parse-json";
import { cachedLlmReading, saveLlmReading } from "./reading-cache";
import { deferLlmRoute, llmRouteAvailable, reportUnavailableRoute } from "./route-cooldown";

/*
 * Gemini: pool de chaves × modelos compartilhado pela extração JSON e pela
 * busca web. Cada tentativa tem timeout curto, poucas chaves por modelo e um
 * orçamento total, para a cascata chegar a Groq/Mistral a tempo. A última
 * combinação (modelo + chave) que funcionou fica gravada e vai para o começo
 * da fila na próxima chamada; todos os modelos do catálogo continuam na fila.
 */

const log = createLogger("llm-gemini");

export const GEMINI_REQUEST_TIMEOUT_MS = 20_000;
const BUDGET_MS = 45_000;
/** 503 e timeout costumam ser do modelo: poucas chaves por modelo antes de pular. */
const MAX_KEYS_PER_MODEL = 2;
const STICKY_PROVIDER = "gemini";

/** Chaves gratuitas (csv) e a paga. Strings vazias no .env não bloqueiam o
 * fallback `GEMINI_API_KEYS` → `GEMINI_API_KEY`. */
export function geminiKeyPool(): string[] {
  const env = getEnv();
  const pool = [...new Set(csvList(env.GEMINI_API_KEYS || env.GEMINI_API_KEY || ""))];
  const paid = env.GEMINI_PAID_API_KEY?.trim();
  if (paid && !pool.includes(paid)) pool.push(paid);
  return pool;
}

export function geminiConfigured(): boolean {
  return geminiKeyPool().length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGeminiQuotaError(error: unknown): boolean {
  return /429|RESOURCE_EXHAUSTED|quota/i.test(errorMessage(error));
}

/** Sobrecarga e timeout pertencem ao modelo, não à chave de API. */
function isGeminiTransientError(error: unknown): boolean {
  return /AbortError|aborted|TimeoutError|timeout|503|UNAVAILABLE|high demand|overloaded/i.test(errorMessage(error));
}

type GeminiSticky = { model: string; keyHint: string };

/** Identificador HMAC estável da chave: não revela prefixo nem sufixo. */
export function geminiKeyHint(apiKey: string): string {
  return privacyHash(apiKey.trim(), "gemini-api-key");
}

/** Modelo preferido primeiro (se ainda estiver na lista); os demais na ordem da lista. */
export function orderModelsPreferring(models: readonly string[], preferred: string | null): string[] {
  if (!preferred) return [...models];
  const idx = models.indexOf(preferred);
  if (idx <= 0) return [...models];
  return [preferred, ...models.slice(0, idx), ...models.slice(idx + 1)];
}

/** Chave preferida primeiro, achada pelo HMAC mesmo se a ordem do .env mudou. */
export function orderKeysPreferring(keys: string[], preferredHint: string | null): string[] {
  if (!preferredHint) return [...keys];
  const idx = keys.findIndex((k) => geminiKeyHint(k) === preferredHint);
  const preferredKey = keys[idx];
  if (idx <= 0 || preferredKey === undefined) return [...keys];
  return [preferredKey, ...keys.slice(0, idx), ...keys.slice(idx + 1)];
}

export async function loadGeminiSticky(): Promise<GeminiSticky | null> {
  try {
    const row = await prisma.llmStickyPreference.findUnique({ where: { provider: STICKY_PROVIDER } });
    if (!row?.model || !row.keyHint) return null;
    return { model: row.model, keyHint: row.keyHint };
  } catch (err) {
    log.warn({ err }, "falha ao ler sticky Gemini — segue a ordem da lista");
    return null;
  }
}

export async function saveGeminiSticky(model: string, apiKey: string, current: GeminiSticky | null): Promise<void> {
  const keyHint = geminiKeyHint(apiKey);
  if (current?.model === model && current.keyHint === keyHint) return;
  try {
    await prisma.llmStickyPreference.upsert({
      where: { provider: STICKY_PROVIDER },
      create: { provider: STICKY_PROVIDER, model, keyHint },
      update: { model, keyHint },
    });
  } catch (err) {
    // A leitura já foi obtida; falhar ao lembrar a rota não a desfaz.
    log.error({ err, model, keyHint }, "falha ao gravar sticky Gemini");
  }
}

/** `value` encerra a busca; `failed_key` conta contra o limite de chaves do modelo. */
/**
 * A cascata pergunta a cada provedor se ele pode ler. O Gemini não tem
 * circuito: quem segura a rota em falha é o cooldown dela (`route-cooldown.ts`).
 */
export async function geminiAvailable(): Promise<boolean> {
  return geminiConfigured();
}

type GeminiRouteOutcome<T> = { value: T } | "failed_key" | "next_model";

/**
 * Percorre modelos × chaves com a política única do Gemini: quota é da
 * combinação modelo+chave (adia a rota e tenta a próxima chave, sem contar
 * falha); outro erro conta falha, adia a rota e, se for sobrecarga/timeout,
 * pula o modelo.
 */
export async function tryGeminiRoutes<T>(run: {
  endpoint: "generate" | "search";
  models: readonly string[];
  sticky: GeminiSticky | null;
  /** Descreve a tentativa nas métricas; prompt e imagem nunca são gravados. */
  attemptParams: LlmGenerateJsonParams;
  log: ReturnType<typeof createLogger>;
  hasTime: () => boolean;
  onBudgetExhausted?: () => void;
  /** Resposta já conhecida para o modelo (cache), antes de gastar chamada. */
  beforeModel?: (model: string) => Promise<GeminiRouteOutcome<T> | undefined>;
  classifyFailure: (error: unknown) => LlmAttemptResult;
  attempt: (call: { ai: GoogleGenAI; apiKey: string; model: string; keyIndex: number; finish: LlmAttempt }) => Promise<GeminiRouteOutcome<T>>;
}): Promise<T | null> {
  const pool = geminiKeyPool();
  const paidKey = getEnv().GEMINI_PAID_API_KEY?.trim() || null;
  const label = run.attemptParams.label;
  for (const [index, model] of run.models.entries()) {
    if (!run.hasTime()) {
      run.onBudgetExhausted?.();
      // Modelo que o orçamento não alcançou não foi ouvido.
      for (const skipped of run.models.slice(index)) run.attemptParams.onRouteOutcome?.("unavailable", skipped);
      break;
    }
    const known = await run.beforeModel?.(model);
    if (known === "next_model") continue;
    if (typeof known === "object") return known.value;

    const keys = run.sticky && model === run.sticky.model ? orderKeysPreferring(pool, run.sticky.keyHint) : pool;
    let failedKeys = 0;
    // Chave fora da rotação não é tentativa: só a chamada feita conta. O tempo
    // que acaba antes da primeira chamada deixa o modelo sem resposta.
    let called = false;
    let cutShort = false;
    for (const [keyIndex, apiKey] of keys.entries()) {
      if (failedKeys >= MAX_KEYS_PER_MODEL || !run.hasTime()) {
        cutShort = true;
        break;
      }
      const route = { provider: "gemini", key: apiKey, model, endpoint: run.endpoint };
      if (!(await llmRouteAvailable(route))) {
        await reportUnavailableRoute(route, run.attemptParams.onRouteOutcome, model);
        continue;
      }
      called = true;
      const finish = startLlmAttempt(run.attemptParams, "gemini", model, run.endpoint);
      try {
        const ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
        const outcome = await run.attempt({ ai, apiKey, model, keyIndex, finish });
        if (outcome === "next_model") break;
        if (outcome === "failed_key") {
          failedKeys += 1;
          continue;
        }
        return outcome.value;
      } catch (err) {
        const status = llmErrorStatus(err);
        // A rota é informada depois do cooldown: a que acabou de sair da
        // rotação (cota do dia, chave recusada) não é queda e não relança o post.
        if (isGeminiQuotaError(err)) {
          await finish("rate_limit", status, { reportRoute: false });
          const message = errorMessage(err);
          const retryDelay = message.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i)?.[1];
          await deferLlmRoute(route, 429, message, retryDelay);
          await reportUnavailableRoute(route, run.attemptParams.onRouteOutcome, model);
          run.log.info(
            { eventCode: LOG_EVENTS.LLM_QUOTA_DEFERRED, label, model, endpoint: run.endpoint, keyIndex, isPaid: apiKey === paidKey },
            "quota Gemini esgotada nesta combinação — avançando no pool",
          );
          continue;
        }
        const result = run.classifyFailure(err);
        // JSON malformado é defeito da resposta, não da rota.
        const routeFailed = result !== "invalid_json";
        await finish(result, status, { reportRoute: !routeFailed });
        failedKeys += 1;
        if (routeFailed) {
          await deferLlmRoute(route, status ?? 0, errorMessage(err));
          await reportUnavailableRoute(route, run.attemptParams.onRouteOutcome, model);
        }
        run.log.warn(
          { eventCode: LOG_EVENTS.LLM_ATTEMPT_FAILED, provider: "gemini", err, label, model, endpoint: run.endpoint, keyIndex },
          "erro Gemini — tentando próxima combinação",
        );
        if (isGeminiTransientError(err)) break;
      }
    }
    if (!called && cutShort) run.attemptParams.onRouteOutcome?.("unavailable", model);
  }
  return null;
}

function generateModelOrder(params: LlmGenerateJsonParams, sticky: GeminiSticky | null): string[] {
  const models = modelsForRequest(cascadeModels("gemini"), params);
  // A leitura de precisão não herda a rota lembrada, que costuma ser de um
  // modelo leve; a avaliação de visão sorteia a primeira rota.
  if (params.precisionVision || visionEvaluationEnabled(params)) return evaluationOrder(models, params);
  return evaluationOrder(orderModelsPreferring(models, sticky?.model ?? null), params);
}

/** Pedido de leitura a um modelo. A bancada de modelos (`scripts/bench-leitura.ts`)
 * manda este mesmo pedido, para medir o que a captura receberia. */
export function geminiGenerateRequest(params: LlmGenerateJsonParams, model: string, abortSignal: AbortSignal): GenerateContentParameters {
  const promptJson = googleUsesPromptJson(model);
  return {
    model,
    contents: [{ role: "user", parts: params.parts }],
    config: {
      systemInstruction: promptJson ? `${params.systemInstruction}\nResponda somente JSON, sem imagens ou markdown, seguindo integralmente este schema: ${JSON.stringify(params.responseSchema)}` : params.systemInstruction,
      ...(promptJson ? { responseModalities: ["TEXT"] } : {
        responseMimeType: "application/json", responseJsonSchema: params.responseSchema,
      }),
      abortSignal,
      temperature: 0,
      ...(params.precisionVision ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH } : {}),
    },
  };
}

function isJsonFailure(error: unknown): LlmAttemptResult {
  if (error instanceof SyntaxError) return "invalid_json";
  return llmErrorStatus(error) ? "http_error" : llmRequestFailure(error);
}

export async function geminiGenerateJson(params: LlmGenerateJsonParams): Promise<unknown | null> {
  if (!geminiConfigured()) return null;

  const sticky = await loadGeminiSticky();
  const rememberRoute = !params.precisionVision && !visionEvaluationEnabled(params);
  const started = Date.now();
  const budget = Math.min(BUDGET_MS, Math.max(0, (params.deadlineAt ?? Infinity) - started));
  const remaining = () => budget - (Date.now() - started);
  const cacheRoute = (model: string) => ({ provider: "gemini", model, endpoint: "generate" as const });

  const result = await tryGeminiRoutes({
    endpoint: "generate",
    models: generateModelOrder(params, sticky),
    sticky,
    attemptParams: params,
    log,
    hasTime: () => remaining() > 0,
    onBudgetExhausted: () => log.info(
      { eventCode: LOG_EVENTS.LLM_PROVIDER_EXHAUSTED, provider: "gemini", label: params.label, budgetMs: BUDGET_MS },
      "Gemini: orçamento esgotado — cascata",
    ),
    beforeModel: async (model) => {
      if (params.skipRemainingModels?.("gemini")) return "next_model";
      const cached = await cachedLlmReading(params, cacheRoute(model));
      if (!cached) return undefined;
      return !params.accept || params.accept(cached.data) ? { value: cached.data } : "next_model";
    },
    classifyFailure: isJsonFailure,
    attempt: async ({ ai, apiKey, model, keyIndex, finish }) => {
      const response = await ai.models.generateContent(geminiGenerateRequest(params, model,
        AbortSignal.timeout(Math.max(1, Math.min(GEMINI_REQUEST_TIMEOUT_MS, remaining())))));
      finish.usage(response);
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== "STOP") {
        await finish("truncated", 200);
        return "next_model";
      }
      const text = response.text;
      if (!text) {
        await finish("empty", 200);
        log.warn({ eventCode: LOG_EVENTS.LLM_RESPONSE_INVALID, label: params.label, model }, "Gemini retornou vazio");
        return "failed_key";
      }
      const parsed = parseStrictLlmJsonText(text);
      if (parsed === null) {
        await finish("invalid_json", 200);
        return "next_model";
      }
      finish.reading(parsed, response.modelVersion);
      await saveLlmReading(params, cacheRoute(model), parsed, parsed, response.modelVersion);
      if (params.accept && !params.accept(parsed)) {
        await finish("rejected", 200);
        // O mesmo modelo costuma repetir a lacuna (ex.: sem odd): pula o modelo.
        log.info({ eventCode: LOG_EVENTS.LLM_PARSE_REJECTED, label: params.label, model, keyIndex }, "Gemini JSON rejeitado pelo accept — próximo modelo");
        return "next_model";
      }
      await finish("accepted", 200);
      if (rememberRoute) await saveGeminiSticky(model, apiKey, sticky);
      if (!params.precisionVision && sticky && (sticky.model !== model || sticky.keyHint !== geminiKeyHint(apiKey))) {
        log.info({ label: params.label, model, prevModel: sticky.model }, "Gemini sticky atualizado");
      }
      return { value: parsed };
    },
  });
  if (result !== null) return result;

  // `null` é a passagem esperada para Groq/Mistral, não falha da operação:
  // cada exceção já foi registrada acima.
  log.info({ eventCode: LOG_EVENTS.LLM_PROVIDER_EXHAUSTED, provider: "gemini", label: params.label }, "Gemini esgotou combinações (ou orçamento) — cascata");
  return null;
}
