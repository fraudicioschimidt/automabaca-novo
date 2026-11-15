import { readJsonCapped } from "@/src/infra/http-request";
import { z } from "zod";
import { closeExpiredBreaker, isBreakerOpen, tripBreaker } from "@/src/infra/circuit-breaker";
import { LOG_EVENTS } from "@/src/infra/log-events";
import type { createLogger } from "@/src/infra/logger";
import { llmRequestFailure, startLlmAttempt, type LlmAttempt } from "./attempt-metrics";
import type { LlmGenerateJsonParams, LlmPart } from "./cascade";
import { mistralModelFamily } from "./models";
import { parseLlmJsonText } from "./parse-json";
import { cachedLlmReading, saveLlmReading } from "./reading-cache";
import { deferLlmRoute, llmRouteAvailable, reportUnavailableRoute } from "./route-cooldown";

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullish() }).optional(),
    finish_reason: z.string().nullish(),
  })).optional(),
});
const errorSchema = z.object({
  message: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

/** Mensagem de erro dos corpos OpenAI-compatíveis e da Mistral. */
export function httpErrorMessage(body: unknown): string | undefined {
  const details = errorSchema.safeParse(body);
  return details.success ? details.data.message ?? details.data.error?.message : undefined;
}

const rejectedGenerationSchema = z.object({ error: z.object({ code: z.unknown(), failed_generation: z.unknown() }).partial() });

/** A Groq valida o `json_object` no servidor: o JSON inválido do modelo volta
 * como 400 `json_validate_failed`, com a geração recusada no corpo. O modelo
 * respondeu; a falha é do conteúdo, não da rota. `null` quando é outro erro.
 * A bancada de modelos (`scripts/lib/bench-call.ts`) lê a geração do mesmo jeito. */
export function rejectedGeneration(status: number, body: unknown, message: string): { content: string | null } | null {
  if (status !== 400) return null;
  const error = rejectedGenerationSchema.safeParse(body).data?.error;
  if (error?.code !== "json_validate_failed" && !/failed to generate json/i.test(message)) return null;
  const generation = error?.failed_generation;
  return { content: typeof generation === "string" && generation.trim() ? generation : null };
}

function chatContent(parts: LlmPart[]): ChatContentPart[] {
  return parts.map((part) => "text" in part
    ? { type: "text", text: part.text }
    : {
      type: "image_url",
      image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` },
    });
}

type ChatConfig = {
  provider: string;
  model: string;
  key: string;
  baseUrl: string;
  timeoutMs: number;
  circuit: string;
  jsonInstruction: string;
  isRateLimit: (status: number, message: string) => boolean;
  adaptOutputLimit?: boolean;
  maxCompletionTokens?: number;
  reasoningEffort?: "none";
  normalize?: (data: unknown) => unknown;
  log: ReturnType<typeof createLogger>;
};

/** Corpo do chat/completions; a bancada de modelos (`scripts/bench-leitura.ts`) manda o mesmo. */
export function chatRequestBody(
  params: LlmGenerateJsonParams,
  config: Pick<ChatConfig, "model" | "jsonInstruction" | "reasoningEffort">,
  outputLimit: number | undefined,
): string {
  return JSON.stringify({
    model: config.model,
    messages: [
      { role: "system", content: `${params.systemInstruction}\n\n${config.jsonInstruction}\nSiga os tipos e campos deste JSON Schema; omita campos opcionais ausentes:\n${JSON.stringify(params.responseSchema)}` },
      { role: "user", content: chatContent(params.parts) },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
    ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
    ...(outputLimit ? { max_completion_tokens: outputLimit } : {}),
  });
}

/** Teto de saída que a API anuncia ao recusar um pedido grande demais. */
export function advertisedOutputLimit(status: number, message: string): number | null {
  if (status !== 429 || !/request too large/i.test(message)) return null;
  const advertised = message.match(/output tokens per minute[^:]*:\s*Limit\s+([\d,]+)/i)?.[1];
  const limit = advertised ? Number(advertised.replace(/,/g, "")) : NaN;
  return Number.isSafeInteger(limit) && limit > 0 && limit <= 32768 ? limit : null;
}

/** Envelope → conteúdo → JSON → normalização → accept de uma resposta HTTP 2xx. */
async function acceptChatResponse(
  params: LlmGenerateJsonParams,
  config: ChatConfig,
  response: { status: number; body: unknown },
  finishAttempt: LlmAttempt,
  context: Record<string, unknown>,
): Promise<unknown | null> {
  const { provider, log } = config;
  const { status, body } = response;
  finishAttempt.usage(body);
  const envelope = responseSchema.safeParse(body);
  if (!envelope.success) {
    await finishAttempt("invalid_json", status);
    log.warn({ ...context, eventCode: LOG_EVENTS.LLM_RESPONSE_INVALID }, `${provider} retornou envelope inválido`);
    return null;
  }
  const finishReason = envelope.data.choices?.[0]?.finish_reason;
  if (finishReason && finishReason !== "stop") {
    await finishAttempt("truncated", status);
    log.warn({ ...context, eventCode: LOG_EVENTS.LLM_RESPONSE_INVALID }, `${provider} interrompeu a geração do JSON`);
    return null;
  }
  const content = envelope.data.choices?.[0]?.message?.content;
  if (!content) {
    await finishAttempt("empty", status);
    log.warn({ ...context, eventCode: LOG_EVENTS.LLM_RESPONSE_INVALID }, `${provider} retornou vazio`);
    return null;
  }
  const decoded = parseLlmJsonText(content);
  if (decoded === null) {
    await finishAttempt("invalid_json", status);
    log.warn({
      ...context,
      eventCode: LOG_EVENTS.LLM_SCHEMA_REJECTED,
      responseChars: content.length,
      reason: "invalid_json",
      actionableHint: "Resposta da API não pôde ser decodificada como JSON. Avalie temperatura ou exemplos no prompt.",
    }, `${provider} retornou JSON inválido`);
    return null;
  }
  const parsed = config.normalize ? config.normalize(decoded) : decoded;
  finishAttempt.reading(parsed, undefined, decoded);
  await saveLlmReading(params, { provider, model: config.model, endpoint: "chat" }, parsed, decoded);
  if (params.accept && !params.accept(parsed)) {
    await finishAttempt("rejected", status);
    const presentKeys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
    // Recusa de conteúdo é o fluxo esperado da cascata (o próximo leitor
    // tenta); a métrica llm.content já a conta como expected_retry.
    log.info({
      ...context,
      eventCode: LOG_EVENTS.LLM_PARSE_REJECTED,
      presentKeys,
      actionableHint: "O JSON extraído pelo LLM falhou no predicado accept (campos obrigatórios faltando ou tipo inválido). Avalie o prompt ou normalização.",
    }, `${provider} JSON rejeitado pelo accept — próximo modelo`);
    return null;
  }
  await finishAttempt("accepted", status);
  // Só sucesso comprovado fecha um trip já vencido; a guarda de cooldown
  // dentro dela preserva um trip recente diante de uma resposta lenta.
  await closeExpiredBreaker(config.circuit);
  log.info({ ...context, eventCode: LOG_EVENTS.LLM_ATTEMPT_ACCEPTED }, `${provider} extraiu JSON aceito`);
  return parsed;
}

/** Transporte compartilhado pelos provedores com chat/completions e json_object. */
export async function requestChatJson(params: LlmGenerateJsonParams, config: ChatConfig): Promise<unknown | null> {
  const { provider, model, circuit, log } = config;
  const cached = await cachedLlmReading(params, { provider, model, endpoint: "chat" });
  if (cached) return !params.accept || params.accept(cached.data) ? cached.data : null;
  const route = { provider, model: provider.toLowerCase() === "mistral" ? mistralModelFamily(model) : model, key: config.key, endpoint: "chat", baseUrl: config.baseUrl };
  if (await isBreakerOpen(circuit)) {
    params.onRouteOutcome?.("unavailable", model);
    return null;
  }
  if (!(await llmRouteAvailable(route))) {
    await reportUnavailableRoute(route, params.onRouteOutcome, model);
    return null;
  }
  const start = Date.now();
  const signal = AbortSignal.timeout(config.timeoutMs);
  let finishAttempt: LlmAttempt | undefined;
  try {
    let outputLimit: number | undefined = config.maxCompletionTokens;
    for (let attempt = 0; attempt < 2; attempt++) {
      finishAttempt = startLlmAttempt(params, provider, model, "chat");
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
        body: chatRequestBody(params, config, outputLimit),
        signal,
      });

      let body: unknown;
      try {
        body = await readJsonCapped(response);
      } catch (error) {
        log.warn(
          { eventCode: LOG_EVENTS.LLM_RESPONSE_INVALID, provider, err: error, label: params.label, model, status: response.status },
          `${provider} retornou corpo HTTP inválido`,
        );
      }
      const context = { provider, label: params.label, model, latency: Date.now() - start };
      if (response.ok) return await acceptChatResponse(params, config, { status: response.status, body }, finishAttempt, context);

      const message = httpErrorMessage(body) ?? `HTTP ${response.status}`;
      const rejected = rejectedGeneration(response.status, body, message);
      // Lida como o conteúdo de um 200, a geração recusada conta como resposta
      // (lida, recusada ou JSON inválido): não relança a captura nem adia a
      // rota, e a tentativa grava 200, porque o transporte funcionou. O 400
      // fica no log (`status`, `rejectedByProvider`).
      if (rejected) {
        const rejectedContext = { ...context, status: response.status, rejectedByProvider: true };
        if (rejected.content !== null) {
          return await acceptChatResponse(params, config,
            { status: 200, body: { choices: [{ message: { content: rejected.content } }] } }, finishAttempt, rejectedContext);
        }
        await finishAttempt("invalid_json", 200);
        log.warn({ ...rejectedContext, eventCode: LOG_EVENTS.LLM_SCHEMA_REJECTED, reason: "invalid_json" },
          `${provider} recusou o JSON gerado pelo modelo`);
        return null;
      }
      const failure = response.status === 429 ? "rate_limit" : "http_error";
      const limit = config.adaptOutputLimit && attempt === 0 ? advertisedOutputLimit(response.status, message) : null;
      if (limit !== null) {
        // A rota segue no mesmo modelo: o desfecho dela é o da nova tentativa.
        await finishAttempt(failure, response.status, { reportRoute: false });
        outputLimit = limit;
        log.info({ ...context, maxCompletionTokens: limit }, `${provider}: ajustando saída ao limite informado pela API`);
        continue;
      }
      await finishAttempt(failure, response.status, { reportRoute: false });
      log.warn({ eventCode: LOG_EVENTS.LLM_ATTEMPT_FAILED, ...context, status: response.status, err: message }, `${provider} retornou erro HTTP`);
      // O status continua válido mesmo quando o corpo não é JSON (ex.: proxy).
      await deferLlmRoute(route, response.status, message, response.headers?.get("retry-after"));
      // Informada depois do cooldown: a rota que acabou de sair da rotação
      // (chave recusada, cota do dia) não é queda e não relança o post.
      await reportUnavailableRoute(route, params.onRouteOutcome, model);
      // Respostas de quota antigas, fora do 429, ainda abrem o breaker estrutural.
      if (response.status !== 429 && config.isRateLimit(response.status, message)) await tripBreaker(circuit);
      return null;
    }
    return null;
  } catch (error) {
    await finishAttempt?.(llmRequestFailure(error));
    await deferLlmRoute(route, 0);
    log.error(
      { eventCode: LOG_EVENTS.LLM_ATTEMPT_FAILED, provider, err: error, label: params.label, model, latency: Date.now() - start },
      `${provider} request falhou`,
    );
    return null;
  }
}
