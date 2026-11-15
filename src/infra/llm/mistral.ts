import { readJsonCapped } from "@/src/infra/http-request";
import { z } from "zod";
import { closeExpiredBreaker, isBreakerOpen } from "@/src/infra/circuit-breaker";
import { getEnv } from "@/src/infra/env";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { llmRequestFailure, startLlmAttempt } from "./attempt-metrics";
import type { LlmGenerateJsonParams, LlmPart } from "./cascade";
import { httpErrorMessage, requestChatJson } from "./chat-json";
import { cascadeModels, chatModels, evaluationOrder, mistralModelFamily, modelsForRequest, visionEvaluationEnabled } from "./models";
import { parseLlmJsonText } from "./parse-json";
import { cachedLlmReading, saveLlmReading } from "./reading-cache";
import { deferLlmRoute, llmRouteAvailable, reportUnavailableRoute } from "./route-cooldown";

/*
 * Mistral: chat/completions com json_object e o endpoint dedicado de OCR.
 * O OCR só lê um bilhete simples com contrato próprio; o chat é o fallback.
 */

const log = createLogger("llm-mistral");
const ocrLog = createLogger("llm-mistral-ocr");

const CIRCUIT = "llm:mistral";
const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
export const MISTRAL_REQUEST_TIMEOUT_MS = 30_000;
const TOTAL_BUDGET_MS = 45_000;
export const MISTRAL_OCR_REQUEST_TIMEOUT_MS = 15_000;
const OCR_TOTAL_BUDGET_MS = 30_000;

function apiKey(): string | null {
  return getEnv().MISTRAL_API_KEY?.trim() || null;
}

function baseUrl(): string {
  return (getEnv().MISTRAL_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function chatCircuit(model: string): string {
  return `${CIRCUIT}:${mistralModelFamily(model)}`;
}

function ocrCircuit(model: string): string {
  return `${CIRCUIT}:ocr:${mistralModelFamily(model)}`;
}

export function mistralConfigured(): boolean {
  if (getEnv().LLM_DISABLE_MISTRAL === "1") return false;
  return Boolean(apiKey());
}

export async function mistralAvailable(): Promise<boolean> {
  if (!mistralConfigured()) return false;
  if (await mistralOcrAvailable()) return true;
  if (getEnv().LLM_DISABLE_MISTRAL_CHAT === "1") return false;
  for (const m of chatModels(cascadeModels("mistral"))) {
    if (!(await isBreakerOpen(chatCircuit(m)))) return true;
  }
  return false;
}

function isRateLimit(status: number, msg: string): boolean {
  return status === 429 || /rate limit|quota|capacity|too many/i.test(msg);
}

const CHAT_JSON_INSTRUCTION = "Responda somente com JSON válido (objeto), sem markdown.";

function mistralChat(params: LlmGenerateJsonParams, model: string, timeoutMs: number, normalize?: (data: unknown) => unknown): Promise<unknown | null> {
  const key = apiKey();
  if (!key) return Promise.resolve(null);
  return requestChatJson(params, {
    provider: "Mistral", model, key, baseUrl: baseUrl(),
    timeoutMs, circuit: chatCircuit(model),
    jsonInstruction: CHAT_JSON_INSTRUCTION,
    isRateLimit, log, normalize,
  });
}

/**
 * Pedido de chat desta leitura. Bilhete simples com contrato estreito usa a
 * instrução, o schema e o accept do OCR. A bancada de modelos
 * (`scripts/bench-leitura.ts`) manda o mesmo pedido.
 */
export function mistralChatRoute(params: LlmGenerateJsonParams) {
  const narrow = supportsMistralOcr(params);
  const chatParams: LlmGenerateJsonParams = narrow ? {
    ...params,
    // A legenda já está na instrução estreita. Mandá-la de novo fazia leitores
    // pequenos confundirem o rótulo do autor com os participantes da imagem.
    parts: params.parts.filter((part) => "inlineData" in part),
    systemInstruction: params.ocrSystemInstruction ?? params.systemInstruction,
    responseSchema: params.ocrResponseSchema ?? params.responseSchema,
    accept: (data) => Boolean(params.ocrAccept?.(data)) && (!params.accept || params.accept(data)),
  } : params;
  return { narrow, params: chatParams, normalize: narrow ? params.ocrNormalize : undefined,
    baseUrl: baseUrl(), jsonInstruction: CHAT_JSON_INSTRUCTION };
}

/** Tenta o OCR dedicado e depois os modelos de chat, priorizando visão se houver imagens. */
export async function mistralGenerateJson(params: LlmGenerateJsonParams): Promise<unknown | null> {
  if (!(await mistralAvailable())) return null;

  const deadline = Math.min(params.deadlineAt ?? Infinity, Date.now() + TOTAL_BUDGET_MS);
  const evaluate = visionEvaluationEnabled(params);
  if (!evaluate) {
    const ocr = await mistralOcrGenerateJson(params, deadline);
    if (ocr !== null) return ocr;
  }
  // `LLM_DISABLE_MISTRAL_CHAT` deixa só o OCR; `MISTRAL_CHAT_NARROW_ONLY`
  // deixa o chat só para o bilhete que o contrato estreito cobre.
  const chat = mistralChatRoute(params);
  const { narrow } = chat;
  const chatEnabled = getEnv().LLM_DISABLE_MISTRAL_CHAT !== "1"
    && (getEnv().MISTRAL_CHAT_NARROW_ONLY !== "1" || narrow);

  const models = cascadeModels("mistral");
  const routes = evaluationOrder([
    ...(evaluate && narrow ? models.ocr : []),
    ...(chatEnabled ? modelsForRequest(models, params) : []),
  ], params);
  for (const [index, model] of routes.entries()) {
    const remaining = deadline - Date.now();
    if (params.skipRemainingModels?.("mistral")) break;
    if (remaining <= 0) {
      // Modelo que o orçamento não alcançou não foi ouvido.
      for (const skipped of routes.slice(index)) params.onRouteOutcome?.("unavailable", skipped);
      break;
    }
    const data = model.startsWith("mistral-ocr-")
      ? await mistralOcrGenerateJson(params, deadline, model)
      : await mistralChat(chat.params, model, Math.min(MISTRAL_REQUEST_TIMEOUT_MS, remaining), chat.normalize);
    if (data !== null) return data;
  }
  return null;
}

const ocrEnvelopeSchema = z.object({ document_annotation: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish() });

async function mistralOcrAvailable(): Promise<boolean> {
  if (!mistralConfigured()) return false;
  for (const model of cascadeModels("mistral").ocr) if (!(await isBreakerOpen(ocrCircuit(model)))) return true;
  return false;
}

/** O OCR só tem evidência para um bilhete simples comum. Ícones de jogador e
 * álbuns ordenados seguem na leitura de precisão até serem validados. */
export function supportsMistralOcr(params: LlmGenerateJsonParams): boolean {
  if (getEnv().MISTRAL_CHAT_NARROW_ONLY === "1" && params.ocrImageProfile !== "compact-bet365-slip-v1") return false;
  const images = params.parts.filter((p) => !("text" in p));
  const image = images[0];
  return Boolean(params.ocrSystemInstruction && params.ocrResponseSchema && params.ocrAccept)
    && !params.precisionVision && images.length === 1 && image !== undefined
    && "inlineData" in image && image.inlineData.mimeType.startsWith("image/");
}

/** Corpo do OCR com anotação; a bancada de modelos (`scripts/bench-leitura.ts`) manda o mesmo. */
export function mistralOcrRequestBody(params: LlmGenerateJsonParams, image: Extract<LlmPart, { inlineData: unknown }>, model: string): string {
  return JSON.stringify({
    model,
    document: { type: "image_url", image_url: `data:${image.inlineData.mimeType};base64,${image.inlineData.data}` },
    include_image_base64: false,
    document_annotation_format: { type: "json_schema", json_schema: { name: params.ocrSchemaName || "structured_document", strict: true, schema: params.ocrResponseSchema } },
    document_annotation_prompt: params.ocrSystemInstruction,
  });
}

async function requestOcrJson(
  params: LlmGenerateJsonParams,
  image: Extract<LlmPart, { inlineData: unknown }>,
  model: string,
  timeoutMs: number,
): Promise<unknown | null> {
  const cacheRoute = { provider: "mistral", model, endpoint: "ocr" as const };
  const cached = await cachedLlmReading(params, cacheRoute);
  if (cached) return params.ocrAccept?.(cached.data) && (!params.accept || params.accept(cached.data)) ? cached.data : null;
  const env = getEnv();
  const route = { provider: "mistral", key: env.MISTRAL_API_KEY?.trim() ?? "", model: mistralModelFamily(model), endpoint: "ocr", baseUrl: env.MISTRAL_BASE_URL?.trim() || DEFAULT_BASE_URL };
  if (!(await llmRouteAvailable(route))) {
    await reportUnavailableRoute(route, params.onRouteOutcome, model);
    return null;
  }
  const started = Date.now();
  const finishAttempt = startLlmAttempt(params, "mistral", model, "ocr");
  try {
    const response = await fetch(`${baseUrl()}/ocr`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.MISTRAL_API_KEY?.trim()}`, "Content-Type": "application/json" },
      body: mistralOcrRequestBody(params, image, model),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown;
    try { body = await readJsonCapped(response); } catch { /* O status HTTP ainda decide o cooldown. */ }
    const context = { provider: "mistral", label: params.label, model, status: response.status, latency: Date.now() - started };
    if (!response.ok) {
      await finishAttempt(response.status === 429 ? "rate_limit" : "http_error", response.status, { reportRoute: false });
      ocrLog.warn({ ...context, eventCode: LOG_EVENTS.LLM_ATTEMPT_FAILED }, "Mistral OCR retornou erro HTTP");
      await deferLlmRoute(route, response.status, httpErrorMessage(body) ?? "", response.headers?.get("retry-after"));
      await reportUnavailableRoute(route, params.onRouteOutcome, model);
      return null;
    }
    finishAttempt.usage(body);
    const envelope = ocrEnvelopeSchema.safeParse(body);
    const annotation = envelope.success ? envelope.data.document_annotation : null;
    if (!annotation) {
      await finishAttempt("empty", response.status);
      ocrLog.warn({ ...context, eventCode: LOG_EVENTS.LLM_RESPONSE_INVALID }, "Mistral OCR não retornou anotação JSON");
      return null;
    }
    const decoded = typeof annotation === "string" ? parseLlmJsonText(annotation) : annotation;
    if (decoded === null) {
      await finishAttempt("invalid_json", response.status);
      ocrLog.warn({ ...context, eventCode: LOG_EVENTS.LLM_RESPONSE_INVALID }, "Mistral OCR retornou anotação JSON inválida");
      return null;
    }
    const data = params.ocrNormalize ? params.ocrNormalize(decoded) : decoded;
    finishAttempt.reading(data, undefined, decoded);
    if (params.ocrSchemaName === "automabaca_narrow_core" && conflictsWithOcrSplitHandicap(data, body)) {
      params.onOcrConflict?.(data);
      await finishAttempt("ocr_conflict", response.status);
      ocrLog.info({ ...context, eventCode: LOG_EVENTS.LLM_PARSE_REJECTED }, "Mistral OCR anotação diverge do handicap dividido transcrito — próximo modelo");
      return null;
    }
    await saveLlmReading(params, cacheRoute, data, decoded);
    if (!params.ocrAccept?.(data) || (params.accept && !params.accept(data))) {
      await finishAttempt("rejected", response.status);
      ocrLog.info({ ...context, eventCode: LOG_EVENTS.LLM_PARSE_REJECTED }, "Mistral OCR JSON rejeitado pelo contrato — próximo modelo");
      return null;
    }
    await finishAttempt("accepted", response.status);
    return data;
  } catch (error) {
    await finishAttempt(llmRequestFailure(error));
    await deferLlmRoute(route, 0);
    ocrLog.warn({ eventCode: LOG_EVENTS.LLM_ATTEMPT_FAILED, provider: "mistral", err: error, label: params.label, model, latency: Date.now() - started, errorName: error instanceof Error ? error.name : "unknown" }, "Mistral OCR request falhou");
    return null;
  }
}

/** Usa o subconjunto OCR do chamador e depois o accept compartilhado. Cada
 * modelo é tentado uma vez dentro do orçamento; o fallback de chat é de quem chama. */
async function mistralOcrGenerateJson(params: LlmGenerateJsonParams, outerDeadline = Infinity, onlyModel?: string): Promise<unknown | null> {
  if (!supportsMistralOcr(params)) return null;
  const models = cascadeModels("mistral").ocr.filter((model) => !onlyModel || model === onlyModel);
  if (!(await mistralOcrAvailable())) {
    // Com a Mistral configurada, só os circuitos abertos de todos os modelos
    // de OCR a deixam indisponível: o leitor qualificado não foi ouvido.
    for (const model of models) params.onRouteOutcome?.("unavailable", model);
    return null;
  }
  const image = params.parts.find((p): p is Extract<LlmPart, { inlineData: unknown }> => !("text" in p));
  if (!image) return null;
  const deadline = Math.min(params.deadlineAt ?? Infinity, outerDeadline, Date.now() + OCR_TOTAL_BUDGET_MS);
  for (const [index, model] of models.entries()) {
    const remaining = deadline - Date.now();
    if (params.skipRemainingModels?.("mistral")) break;
    if (remaining <= 0) {
      for (const skipped of models.slice(index)) params.onRouteOutcome?.("unavailable", skipped);
      break;
    }
    const circuit = ocrCircuit(model);
    if (await isBreakerOpen(circuit)) {
      params.onRouteOutcome?.("unavailable", model);
      continue;
    }
    const data = await requestOcrJson(params, image, model, Math.min(MISTRAL_OCR_REQUEST_TIMEOUT_MS, remaining));
    if (data === null) continue;
    await closeExpiredBreaker(circuit);
    ocrLog.info({ label: params.label, model }, "Mistral OCR extraiu JSON aceito");
    return data;
  }
  return null;
}

const numberPattern = "[+-]?\\d+(?:[.,]\\d+)?";
const splitPattern = new RegExp(`^(.*?)\\s+(${numberPattern})\\s*[,/]\\s*(${numberPattern})(?:\\s+@?\\d+(?:[.,]\\d+)?)?\\s*$`);
const selectionPattern = new RegExp(`^(.*?)\\s+(${numberPattern})(?:\\s*[,/]\\s*(${numberPattern}))?\\s*$`);
const normalizeText = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[−–]/g, "-");
const teamKey = (value: string) => normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
const asNumber = (value: string) => Number(value.replace(",", "."));
const isHalfLine = (value: number) => Number.isFinite(value) && Math.abs(value * 2 - Math.round(value * 2)) < 1e-8;
const isSplit = (a: number, b: number) => isHalfLine(a) && isHalfLine(b) && Math.abs(Math.abs(a - b) - 0.5) < 1e-8;

/** Só veta: nunca troca a anotação por uma linha calculada. Um par de meias
 * linhas transcrito no markdown precisa concordar com o time da anotação e com
 * o mesmo par ou a linha de quarto equivalente. */
export function conflictsWithOcrSplitHandicap(annotation: unknown, envelope: unknown): boolean {
  if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)
      || !("isBet" in annotation) || annotation.isBet !== true) return false;
  if (!envelope || typeof envelope !== "object" || !("pages" in envelope) || !Array.isArray(envelope.pages)) return false;
  const markdown = envelope.pages.map((page: unknown) => page && typeof page === "object"
    && "markdown" in page && typeof page.markdown === "string" ? page.markdown : "").join("\n");
  if (!/\b(?:handicap|ah)\b/i.test(normalizeText(markdown))) return false;
  const splits = new Map<string, { team: string; line: number }>();
  for (const cell of normalizeText(markdown).replace(/<br\s*\/?\s*>/gi, "\n").split(/[\n|]/)) {
    const match = cell.replace(/[*_`]/g, "").trim().match(splitPattern);
    if (!match?.[1] || !match[2] || !match[3] || !isSplit(asNumber(match[2]), asNumber(match[3]))) continue;
    const team = teamKey(match[1]), line = (asNumber(match[2]) + asNumber(match[3])) / 2;
    if (team) splits.set(`${team}:${line}`, { team, line });
  }
  if (!splits.size) return false;
  // Várias seleções divididas diferentes não provam uma anotação única.
  if (splits.size !== 1 || !("selecao" in annotation) || typeof annotation.selecao !== "string") return true;
  const selected = normalizeText(annotation.selecao).trim().match(selectionPattern);
  if (!selected?.[1] || !selected[2]) return true;
  let line = asNumber(selected[2]);
  if (selected[3] !== undefined) {
    if (!isSplit(line, asNumber(selected[3]))) return true;
    line = (line + asNumber(selected[3])) / 2;
  }
  const source = [...splits.values()][0];
  if (!source) return true;
  return teamKey(selected[1]) !== source.team || !Number.isFinite(line) || Math.abs(line - source.line) > 1e-8;
}
