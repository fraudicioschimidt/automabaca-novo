import { createHash } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import type { ParsedBetPost } from "@/src/domain/bet-capture";
import { reconcileImageCaptionSelection } from "@/src/domain/image-caption-selection";
import { preparePlayerCaptureBatch } from "@/src/domain/player-prop-capture";
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { getEnv } from "@/src/infra/env";
import { llmErrorStatus, llmReadingIdentity, readLlmUsage } from "@/src/infra/llm/attempt-metrics";
import type { LlmGenerateJsonParams, LlmJsonResult, LlmPart, LlmProviderId } from "@/src/infra/llm/cascade";
import { advertisedOutputLimit, chatRequestBody, httpErrorMessage, rejectedGeneration } from "@/src/infra/llm/chat-json";
import { GEMINI_REQUEST_TIMEOUT_MS, geminiGenerateRequest, geminiKeyPool } from "@/src/infra/llm/gemini";
import { GROQ_REQUEST_TIMEOUT_MS, groqChatRoute } from "@/src/infra/llm/groq";
import {
  conflictsWithOcrSplitHandicap, MISTRAL_OCR_REQUEST_TIMEOUT_MS, MISTRAL_REQUEST_TIMEOUT_MS, mistralChatRoute,
  mistralOcrRequestBody, supportsMistralOcr,
} from "@/src/infra/llm/mistral";
import { parseLlmJsonText, parseStrictLlmJsonText } from "@/src/infra/llm/parse-json";
import { scrubSecrets } from "@/src/infra/redaction";
import { finalizeParsedBetForCapture } from "@/src/services/capture/preparation/parse-capture-guard";
import { llmBetSchema } from "@/src/services/capture/reading/extraction-contract";
import { extractionRows } from "@/src/services/capture/reading/extraction-quality";
import {
  extractBetFromImage, extractBetFromText, extractBetsFromImages, extractPlayerBetsFromImage,
  type ExtractBetResult, type ExtractionGenerator,
} from "@/src/services/capture/reading/extract-bet";
import { failureAction, KeyRotation, type ProviderLane } from "./bench-schedule";
import type { AttemptOutcome, AttemptRecord, GabaritoItem, ReadBet, TransportStatus } from "./bench-scoring";

/*
 * Uma leitura de um item por UM modelo, com o mesmo pedido, o mesmo contrato
 * e o mesmo julgamento da captura. Os corpos das requisições vêm das funções
 * dos transportes de produção; o que fica aqui é só o que a produção faz com
 * banco (cache de leitura, cooldown, circuito, métricas), trocado por medição.
 * Por isso a leitura nunca vem de cache.
 */

export type BenchRoute = {
  provider: LlmProviderId;
  model: string;
  endpoint: "generate" | "chat" | "ocr";
  vision: boolean;
};
export const routeId = (route: Pick<BenchRoute, "provider" | "model">) => `${route.provider}/${route.model}`;

/** Prazo por requisição na produção; a bancada mede além dele e marca quem passou. */
export function productionTimeoutMs(route: { provider: string; endpoint: string }): number {
  if (route.endpoint === "ocr") return MISTRAL_OCR_REQUEST_TIMEOUT_MS;
  return route.provider === "gemini" ? GEMINI_REQUEST_TIMEOUT_MS
    : route.provider === "groq" ? GROQ_REQUEST_TIMEOUT_MS : MISTRAL_REQUEST_TIMEOUT_MS;
}

export type LoadedItem = {
  item: GabaritoItem;
  hash: string;
  text?: string;
  images: Array<{ base64: string; mimeType: string }>;
};

/** O modelo cabe neste item? OCR só lê o bilhete simples que a produção manda a ele. */
export function routeSupportsItem(route: BenchRoute, item: GabaritoItem): boolean {
  if (route.endpoint === "ocr") return item.leitor === "bilhete";
  return item.leitor === "texto" || route.vision;
}

type SendSuccess = {
  ok: true;
  latencyMs: number;
  usage: AttemptRecord["usage"];
  content: NonNullable<AttemptRecord["content"]>;
  data?: unknown;
  sourceData?: unknown;
  modelVersion?: string;
  /** Envelope do OCR, para a mesma checagem de handicap dividido. */
  envelope?: unknown;
  httpStatus: number;
};
type SendFailure = { ok: false; latencyMs: number; status: number; message: string; retryAfter?: string | null; timedOut: boolean };
type SendResult = SendSuccess | SendFailure;

function secrets(): string[] {
  const env = getEnv();
  return [...geminiKeyPool(), env.GROQ_API_KEY?.trim(), env.MISTRAL_API_KEY?.trim()].filter((key): key is string => Boolean(key));
}

/** Impressão da chave: 8 caracteres do sha256, o que o relatório mostra. */
export const keyHint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 8);

/** Chaves do Gemini na ordem do .env, cada uma com a sua impressão. */
export const geminiKeyRotation = () => new KeyRotation(geminiKeyPool().map((value) => ({ hint: keyHint(value), value })));

/** Mensagem de erro curta e sem credencial, para o JSONL e o relatório. */
export function safeMessage(message: string): string {
  let clean = scrubSecrets(message);
  for (const key of secrets()) clean = clean.split(key).join("[chave]");
  return clean.replace(/\s+/g, " ").slice(0, 300);
}

const isTimeout = (error: unknown) => error instanceof Error && /timeout|abort/i.test(`${error.name} ${error.message}`);

async function sendGemini(route: BenchRoute, params: LlmGenerateJsonParams, apiKey: string, timeoutMs: number): Promise<SendResult> {
  const started = Date.now();
  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
    const response = await ai.models.generateContent(geminiGenerateRequest(params, route.model, AbortSignal.timeout(timeoutMs)));
    const latencyMs = Date.now() - started;
    const usage = readLlmUsage("gemini", "generate", response);
    const base = { ok: true as const, latencyMs, usage, modelVersion: response.modelVersion, httpStatus: 200 };
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== "STOP") return { ...base, content: "truncado" };
    const text = response.text;
    if (!text) return { ...base, content: "vazio" };
    const parsed = parseStrictLlmJsonText(text);
    return parsed === null ? { ...base, content: "json_invalido" } : { ...base, content: "json", data: parsed, sourceData: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false, latencyMs: Date.now() - started, status: llmErrorStatus(error) ?? 0, message,
      // O Gemini informa a espera no corpo do erro, não no cabeçalho.
      retryAfter: message.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i)?.[1] ?? null,
      timedOut: isTimeout(error),
    };
  }
}

/**
 * A Mistral responde 429 "Rate limit exceeded" também para o modelo fora do
 * plano da conta; só o cabeçalho diz que o limite por minuto é zero. A marca
 * `limit: 0` faz a régua de cooldown tratá-lo como sem cota, e não esperar.
 */
function failureMessage(response: Response, message: string): string {
  return response.headers.get("x-ratelimit-limit-req-minute") === "0" ? `${message} (limit: 0 por minuto neste plano)` : message;
}

async function postJson(url: string, key: string, body: string, timeoutMs: number) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: unknown;
  try { json = await response.json(); } catch { /* O status ainda classifica a falha. */ }
  return { response, json };
}

type ChatPlan = { url: string; key: string; params: LlmGenerateJsonParams; normalize?: (data: unknown) => unknown;
  jsonInstruction: string; maxCompletionTokens?: number; reasoningEffort?: "none"; adaptOutputLimit: boolean };

/** Mesmo endereço, instrução e parâmetros que `groqOne`/`mistralChat` usam para este modelo. */
function chatPlan(route: BenchRoute, params: LlmGenerateJsonParams): ChatPlan {
  const env = getEnv();
  if (route.provider === "groq") {
    const groq = groqChatRoute(params, route.model);
    return { url: `${groq.baseUrl}/chat/completions`, key: env.GROQ_API_KEY?.trim() ?? "", params, adaptOutputLimit: true, ...groq };
  }
  const mistral = mistralChatRoute(params);
  return { url: `${mistral.baseUrl}/chat/completions`, key: env.MISTRAL_API_KEY?.trim() ?? "", params: mistral.params,
    normalize: mistral.normalize, jsonInstruction: mistral.jsonInstruction, adaptOutputLimit: false };
}

async function sendChat(route: BenchRoute, plan: ChatPlan, timeoutMs: number): Promise<SendResult> {
  const started = Date.now();
  try {
    let outputLimit = plan.maxCompletionTokens;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { response, json } = await postJson(plan.url, plan.key,
        chatRequestBody(plan.params, { model: route.model, jsonInstruction: plan.jsonInstruction, reasoningEffort: plan.reasoningEffort }, outputLimit), timeoutMs);
      const latencyMs = Date.now() - started;
      const message = response.ok ? "" : httpErrorMessage(json) ?? `HTTP ${response.status}`;
      // Como a captura, a geração que a Groq recusou (400 json_validate_failed)
      // é a resposta do modelo, não um erro HTTP.
      const rejected = response.ok ? null : rejectedGeneration(response.status, json, message);
      if (!response.ok && !rejected) {
        const limit = plan.adaptOutputLimit && attempt === 0 ? advertisedOutputLimit(response.status, message) : null;
        if (limit !== null) { outputLimit = limit; continue; }
        return { ok: false, latencyMs, status: response.status, message: failureMessage(response, message), retryAfter: response.headers.get("retry-after"), timedOut: false };
      }
      const usage = readLlmUsage(route.provider, "chat", json);
      const choice = (json as { choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }> } | undefined)?.choices?.[0];
      const base = { ok: true as const, latencyMs, usage, httpStatus: rejected ? 200 : response.status };
      if (!rejected && choice?.finish_reason === "length") return { ...base, content: "truncado" };
      const content = rejected ? rejected.content : choice?.message?.content;
      if (!content) return { ...base, content: rejected ? "json_invalido" : "vazio" };
      const decoded = parseLlmJsonText(content);
      if (decoded === null) return { ...base, content: "json_invalido" };
      return { ...base, content: "json", data: plan.normalize ? plan.normalize(decoded) : decoded, sourceData: decoded };
    }
    return { ok: false, latencyMs: Date.now() - started, status: 429, message: "limite de saída recusado duas vezes", timedOut: false };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, status: 0, message: error instanceof Error ? error.message : String(error), timedOut: isTimeout(error) };
  }
}

async function sendOcr(route: BenchRoute, params: LlmGenerateJsonParams, timeoutMs: number): Promise<SendResult> {
  const started = Date.now();
  const image = params.parts.find((part): part is Extract<LlmPart, { inlineData: unknown }> => "inlineData" in part);
  if (!image) return { ok: false, latencyMs: 0, status: 400, message: "item sem imagem para o OCR", timedOut: false };
  try {
    const { response, json } = await postJson(`${mistralChatRoute(params).baseUrl}/ocr`, getEnv().MISTRAL_API_KEY?.trim() ?? "",
      mistralOcrRequestBody(params, image, route.model), timeoutMs);
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { ok: false, latencyMs, status: response.status, message: failureMessage(response, httpErrorMessage(json) ?? `HTTP ${response.status}`),
        retryAfter: response.headers.get("retry-after"), timedOut: false };
    }
    const base = { ok: true as const, latencyMs, usage: readLlmUsage("mistral", "ocr", json), httpStatus: response.status, envelope: json };
    const annotation = (json as { document_annotation?: unknown } | undefined)?.document_annotation;
    if (!annotation) return { ...base, content: "vazio" };
    const decoded = typeof annotation === "string" ? parseLlmJsonText(annotation) : annotation;
    if (decoded === null) return { ...base, content: "json_invalido" };
    return { ...base, content: "json", data: params.ocrNormalize ? params.ocrNormalize(decoded) : decoded, sourceData: decoded };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, status: 0, message: error instanceof Error ? error.message : String(error), timedOut: isTimeout(error) };
  }
}

/** Parada que vale para o resto da rodada do modelo ou do provedor. */
export class RouteStopped extends Error {
  constructor(readonly scope: "model" | "provider", readonly status: TransportStatus, readonly pending: boolean, message: string,
    readonly keyTrail: KeyTrail = []) {
    super(message);
    this.name = "RouteStopped";
  }
}

type KeyTrail = NonNullable<AttemptRecord["keyTrail"]>;

type Measure = {
  keyTrail: KeyTrail;
  keyHint?: string;
  httpAttempts: number;
  rateLimitHits: number;
  final?: SendResult;
  transport?: TransportStatus;
  contractValid?: boolean;
  judgedData?: unknown;
};

/**
 * O gerador que a extração recebe no lugar da cascata: uma chamada a este
 * modelo (com as novas tentativas de 429 e 5xx), e depois o mesmo caminho do
 * transporte de produção — leitura registrada, veto de handicap dividido do
 * OCR, `ocrAccept` do contrato estreito e o `accept` da extração.
 */
function routeGenerator(route: BenchRoute, lane: ProviderLane, timeoutMs: number, measure: Measure, keys: KeyRotation): ExtractionGenerator {
  return async (params) => {
    const chat = route.endpoint === "chat" ? chatPlan(route, params) : undefined;
    const judged = chat?.params ?? params;
    let rateLimitRetries = 0, transientRetries = 0;
    // Chaves do Gemini já tentadas desde a última espera: a falha passageira
    // passa o item à outra chave antes de esperar.
    const tried = new Set<string>();
    let lastStop: { status: TransportStatus; pending: boolean; message: string } | undefined;
    for (;;) {
      const key = route.provider === "gemini" ? keys.next(route.model, tried) : null;
      if (route.provider === "gemini" && !key) {
        // Esgotado sai sempre, mesmo sem falha nesta chamada (chaves recusadas
        // antes, por outro modelo, ou .env sem chave): voltar ao topo sem await
        // prenderia o processo.
        const exhausted = keys.exhausted(route.model);
        if (exhausted) {
          throw new RouteStopped(keys.allDead() ? "provider" : "model", lastStop?.status ?? "credencial", exhausted.pending,
            lastStop?.message ?? "nenhuma chave do Gemini atende este modelo", measure.keyTrail);
        }
        tried.clear();
        continue;
      }
      measure.httpAttempts += 1;
      const result = await lane.run(route.model, () => route.endpoint === "generate"
        ? sendGemini(route, params, key?.value ?? "", timeoutMs)
        : route.endpoint === "ocr" ? sendOcr(route, params, timeoutMs) : sendChat(route, chat as ChatPlan, timeoutMs));
      measure.final = result;
      if (result.ok) {
        if (key) { measure.keyHint = key.hint; measure.keyTrail.push({ key: key.hint, outcome: "ok" }); }
        break;
      }
      if (result.status === 429) measure.rateLimitHits += 1;
      const action = failureAction({ provider: route.provider, status: result.status, message: result.message,
        retryAfter: result.retryAfter, timedOut: result.timedOut, attempt: result.status === 429 ? rateLimitRetries : transientRetries });
      const outcome = action.action === "retry" ? (action.reason === "rate_limit" ? "rate_limit" : "indisponivel") : action.status;
      if (key) {
        measure.keyTrail.push({ key: key.hint, outcome });
        tried.add(key.hint);
        if (action.action === "stop_model" || action.action === "stop_provider") {
          if (action.action === "stop_provider") keys.blockEverywhere(key.hint);
          else keys.block(route.model, key.hint, action.pending);
          lastStop = { status: action.status, pending: action.action === "stop_model" && action.pending, message: safeMessage(result.message) };
          continue;
        }
        // Outra chave ainda não tentada leva o item antes de qualquer espera.
        if (action.action === "retry" && keys.next(route.model, tried)) continue;
        if (action.action === "retry") tried.clear();
      }
      if (action.action === "retry") {
        if (action.reason === "rate_limit") rateLimitRetries += 1; else transientRetries += 1;
        lane.defer(route.model, Date.now() + action.waitMs);
        continue;
      }
      if (action.action === "record") { measure.transport = action.status; return null; }
      throw new RouteStopped(action.action === "stop_provider" ? "provider" : "model", action.status,
        action.action === "stop_model" && action.pending, safeMessage(result.message), measure.keyTrail);
    }
    const result = measure.final;
    measure.transport = "ok";
    if (!result.ok || result.content !== "json") return null;
    const data = result.data;
    measure.judgedData = data;
    measure.contractValid = llmBetSchema.safeParse(data).success;
    params.onReading?.(llmReadingIdentity(judged, route.provider, route.model, route.endpoint, result.sourceData, result.modelVersion), result.sourceData);
    if (route.endpoint === "ocr") {
      if (params.ocrSchemaName === "automabaca_narrow_core" && conflictsWithOcrSplitHandicap(data, result.envelope)) {
        params.onOcrConflict?.(data);
        return null;
      }
      if (!params.ocrAccept?.(data)) return null;
    }
    if (judged.accept && !judged.accept(data)) return null;
    return { data, provider: route.provider } satisfies LlmJsonResult;
  };
}

const toReadBet = (bet: Pick<ParsedBetPost, "evento" | "mercado" | "selecao" | "odds" | "stake" | "esporte">): ReadBet => ({
  evento: bet.evento, mercado: bet.mercado, selecao: bet.selecao,
  odds: Number.isFinite(bet.odds) ? bet.odds : null, stake: Number.isFinite(bet.stake) ? bet.stake : null, esporte: bet.esporte,
});

function readingRows(data: unknown): ReadBet[] {
  const parsed = llmBetSchema.safeParse(data);
  if (!parsed.success || !parsed.data.isBet) return [];
  return extractionRows(parsed.data).map((row) => ({
    evento: row.evento ?? "", mercado: row.mercado ?? "", selecao: row.selecao ?? "",
    odds: row.odds ?? null, stake: row.stake ?? null, esporte: row.esporte ?? "",
  }));
}

/**
 * O desfecho que a captura daria: extração, os mesmos passos puros de
 * `capture-new.ts` (conciliação com a legenda, lote de jogador) e o porteiro
 * de cada aposta, com a legenda que `register-post.ts` passa a ele.
 */
export function outcomeOf(extracted: ExtractBetResult, item: GabaritoItem, caption: string, judgedData: unknown): AttemptOutcome {
  const rows = readingRows(judgedData);
  const extractedBets = extracted.bets ?? (extracted.bet ? [extracted.bet] : []);
  const refused = (reason: string, missing: string[]): AttemptOutcome =>
    ({ kind: "incompleta", detail: `recusa na captura: ${reason}`, missing, bets: [], readingRows: rows });
  if (extractedBets.length && extracted.provider) {
    let bets = extractedBets;
    const imageStakeAsUnits = item.leitor === "jogador" || item.leitor === "album";
    if (item.leitor !== "texto") {
      const selected = reconcileImageCaptionSelection(bets, caption);
      if (!selected.ok) return refused(selected.reason, ["selecao"]);
      bets = selected.bets;
    }
    const batch = preparePlayerCaptureBatch(bets, caption, imageStakeAsUnits);
    if (!batch.ok) return refused(batch.reason, [item.leitor === "texto" ? batch.reason : "stake"]);
    bets = batch.bets;
    const asBatch = bets.length > 1 || bets.some((bet) => buildPlayerPropTerms(bet));
    const guarded = bets.map((bet) => finalizeParsedBetForCapture(bet,
      asBatch && (bet.stakeSource === "caption" || bet.stakePolicySnapshot?.source.startsWith("bankroll_")) ? `${bet.stake}u` : caption,
      item.politica));
    const rejected = guarded.find((result) => !result.ok);
    if (rejected && !rejected.ok) return refused(`porteiro ${rejected.reason}`, rejected.missing);
    return { kind: "aposta", detail: `${bets.length} aposta(s)`, missing: [],
      bets: guarded.flatMap((result) => (result.ok ? [toReadBet(result.bet)] : [])), readingRows: rows };
  }
  if (extracted.incompleteDraft) {
    const missing = extracted.missing ?? [];
    return { kind: "incompleta", detail: extracted.review ? `revisão: ${extracted.review.reason}` : `rascunho sem ${missing.join(", ")}`,
      missing, bets: [], readingRows: rows };
  }
  if (extracted.notBet) return { kind: "nao_e_aposta", detail: "não é aposta", missing: [], bets: [], readingRows: rows };
  return { kind: "falha", detail: judgedData === undefined ? "sem leitura no contrato" : "leitura recusada pelo contrato", missing: [], bets: [], readingRows: rows };
}

/** Chama a mesma função de extração que a captura usaria para este item. */
function extractItem(loaded: LoadedItem, now: Date, generate: ExtractionGenerator): Promise<ExtractBetResult> {
  const { item } = loaded;
  const stake = item.banca ? { stakePolicy: item.banca.stakePolicy, defaultStakeUnits: item.banca.defaultStakeUnits } : undefined;
  const [image] = loaded.images;
  if (item.leitor === "texto") return extractBetFromText(loaded.text ?? "", now, stake, undefined, generate);
  if (item.leitor === "album") return extractBetsFromImages(loaded.images, item.legenda, now, stake, undefined, generate);
  if (!image) throw new Error(`${item.id}: item sem imagem`);
  if (item.leitor === "jogador") return extractPlayerBetsFromImage(image, item.legenda, now, stake, undefined, generate);
  return extractBetFromImage(image, item.legenda, now, { ...stake, capturePolicy: item.politica }, undefined, generate);
}

/** O OCR só entra quando a produção o chamaria para este bilhete. */
export async function ocrApplies(loaded: LoadedItem): Promise<boolean> {
  let applies = false;
  await extractItem(loaded, new Date(), async (params) => { applies = supportsMistralOcr(params); return null; });
  return applies;
}

export async function runAttempt(options: {
  loaded: LoadedItem;
  route: BenchRoute;
  rep: number;
  key: string;
  lane: ProviderLane;
  timeoutMs: number;
  keys: KeyRotation;
}): Promise<AttemptRecord> {
  const { loaded, route } = options;
  const measure: Measure = { httpAttempts: 0, rateLimitHits: 0, keyTrail: [] };
  const started = Date.now();
  const now = loaded.item.dataPost ? new Date(loaded.item.dataPost) : new Date();
  const extracted = await extractItem(loaded, now, routeGenerator(route, options.lane, options.timeoutMs, measure, options.keys));
  const final = measure.final;
  const base = {
    key: options.key, itemId: loaded.item.id, itemHash: loaded.hash, route: routeId(route), provider: route.provider, model: route.model,
    endpoint: route.endpoint, rep: options.rep, at: new Date(started).toISOString(), totalMs: Date.now() - started,
    httpAttempts: measure.httpAttempts, rateLimitHits: measure.rateLimitHits,
    ...(measure.keyHint ? { keyHint: measure.keyHint } : {}),
    ...(measure.keyTrail.length ? { keyTrail: measure.keyTrail } : {}),
  };
  if (!final) return { ...base, transport: "erro_http", error: "a extração não chamou o modelo" };
  if (!final.ok) {
    return { ...base, transport: measure.transport ?? "erro_http", latencyMs: final.latencyMs,
      ...(final.status ? { httpStatus: final.status } : {}), error: safeMessage(final.message) };
  }
  const caption = loaded.item.leitor === "texto" ? loaded.text ?? "" : loaded.item.legenda;
  return {
    ...base, transport: "ok", httpStatus: final.httpStatus, latencyMs: final.latencyMs,
    overProductionTimeout: final.latencyMs > productionTimeoutMs(route),
    ...(final.usage && Object.keys(final.usage).length ? { usage: final.usage } : {}),
    content: final.content, contractValid: measure.contractValid ?? false,
    outcome: outcomeOf(extracted, loaded.item, caption, measure.judgedData),
    ...(measure.judgedData !== undefined && JSON.stringify(measure.judgedData).length <= 8000 ? { reading: measure.judgedData } : {}),
  };
}
