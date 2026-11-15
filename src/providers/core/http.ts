import { ProviderRequestGateError } from "@/src/domain/provider-error";
import { BodyTooLargeError, readJsonCapped } from "@/src/infra/http-request";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";

const log = createLogger("provider-http");

/**
 * HTTP compartilhado dos providers: a implementação única de timeout, retry
 * com backoff+jitter, retry-after, re-auth em 401 e telemetria por chamada.
 */

type FetchJsonResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status?: number; error: string; blocked?: boolean };

type FetchJsonParams = {
  url: string;
  init?: RequestInit;
  label: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  /**
   * Hook de re-autenticação: chamado UMA vez num 401; retorna headers novos
   * (ex.: Bearer re-emitido) para retentar, ou null para desistir.
   */
  onUnauthorized?: () => Promise<Record<string, string> | null>;
  /**
   * Observador dos headers da resposta, chamado em TODA tentativa — inclusive
   * na que falha. É por onde o provider conta a própria cota (`x-ratelimit-*`),
   * e o 429 é justamente a resposta que carrega o número mais importante.
   * Síncrono de propósito: efeito com I/O é do chamador, depois do retorno;
   * um hook assíncrono aqui viraria promessa solta no caminho de retry.
   */
  onResponse?: (res: Response) => void;
  /**
   * Executado imediatamente antes de CADA `fetch` físico. Budget por request
   * mora aqui: 5xx, erro de rede, JSON inválido e reauth também chegam ao
   * fornecedor e portanto precisam de uma unidade própria.
   */
  beforeAttempt?: () => Promise<void>;
  /** Recusa de negócio comprovada pelo corpo da resposta; não é queda da API. */
  isExpectedFailure?: (result: { status?: number; error: string }) => boolean | Promise<boolean>;
  /**
   * Abort externo (ex.: budget da resposta no Telegram). Combinado com o
   * timeout por tentativa; se este sinal abortar, não há retry.
   */
  signal?: AbortSignal;
};

function decodeChunks(chunks: readonly Uint8Array[], total: number): string {
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

/** Amostra diagnóstica realmente limitada; `res.text().slice()` lê tudo antes de cortar. */
async function readTextSample(res: Response, limit = 4 * 1024): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = limit - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A amostra já foi coletada; cancelamento é best-effort.
    }
    reader.releaseLock();
  }
  return decodeChunks(chunks, total);
}

type Retry = {
  waitMs: number;
  eventCode: string;
  details: Record<string, unknown>;
  message: string;
};

type ResponseOutcome<T> =
  | { result: FetchJsonResult<T> }
  | { retry: Retry }
  | { reauthenticated: true };

function backoffMs(attempt: number, base: number): number {
  const exp = base * Math.pow(2, attempt);
  return exp + Math.floor(Math.random() * exp * 0.5);
}

/** Retry-After: segundos (numérico) OU HTTP-date. Tetado em 15s. */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15_000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), 15_000));
  return null;
}

function isServerError(status: number): boolean {
  return status >= 500 && status < 600;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

/** Estado que atravessa as tentativas de uma chamada. */
type AttemptState = { init: RequestInit; reauthUsed: boolean; lastError: string };

/** Decide o que fazer com a resposta de uma tentativa: resultado final, retry ou credencial nova. */
async function handleResponse<T>(
  res: Response,
  attempt: number,
  params: FetchJsonParams,
  policy: { maxRetries: number; base: number },
  state: AttemptState,
): Promise<ResponseOutcome<T>> {
  const canRetry = attempt < policy.maxRetries;
  const retryAfterOrBackoff = () =>
    parseRetryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt, policy.base);
  if (res.status === 401 && params.onUnauthorized && !state.reauthUsed) {
    state.reauthUsed = true;
    const newHeaders = await params.onUnauthorized();
    if (!newHeaders) return { result: { ok: false, status: 401, error: "re-autenticação falhou" } };
    const headers = new Headers(state.init.headers);
    for (const [name, value] of Object.entries(newHeaders)) headers.set(name, value);
    state.init = { ...state.init, headers };
    log.warn({ label: params.label }, "401 — credencial re-emitida, retentando");
    return { reauthenticated: true };
  }

  // Rate limit é um status válido mesmo quando o corpo é texto. Terminal:
  // o breaker aplica o cooldown e a próxima tentativa ganha nova reserva.
  // Outros 4xx são erros terminais de contrato/autorização, não páginas
  // transitórias de gateway.
  if (res.status === 429 || (!res.ok && res.status >= 400 && res.status < 500)) {
    return { result: { ok: false, status: res.status, error: `HTTP ${res.status}` } };
  }

  // O contrato deste helper é JSON em qualquer status. HTML/texto anti-bot
  // é bloqueio terminal; gateway 5xx genérico continua transitório mesmo
  // sem JSON. A amostra é limitada a 4 KiB durante a leitura.
  const contentType = res.headers.get("content-type") ?? "";
  if (!/\bjson\b/i.test(contentType)) {
    let amostra = "";
    try {
      amostra = await readTextSample(res);
    } catch {
      // O status/content-type já bastam para recusar sem retry.
    }
    const antiBot = /just a moment|cf-browser-verification|captcha|cloudflare/i.test(amostra);
    if (!antiBot && isServerError(res.status) && canRetry) {
      return { retry: {
        waitMs: retryAfterOrBackoff(),
        eventCode: LOG_EVENTS.PROVIDER_TRANSIENT_RETRY,
        details: { status: res.status, contentType },
        message: "gateway respondeu sem JSON — retry",
      } };
    }
    log.error(
      { label: params.label, status: res.status, contentType, amostra: amostra.slice(0, 200) },
      "provider respondeu sem JSON — sem retry",
    );
    const motivo = antiBot ? "bloqueio anti-bot" : "resposta não-JSON";
    return { result: {
      ok: false,
      status: res.status,
      error: `${motivo} (${contentType || "sem content-type"})`,
      blocked: antiBot || res.ok,
    } };
  }

  if (res.ok) {
    try {
      return { result: { ok: true, status: res.status, data: await readJsonCapped<T>(res) } };
    } catch (err) {
      state.lastError = err instanceof BodyTooLargeError ? err.message : "JSON inválido na resposta";
      if (err instanceof BodyTooLargeError || !canRetry) {
        return { result: { ok: false, status: res.status, error: state.lastError } };
      }
      return { retry: {
        waitMs: backoffMs(attempt, policy.base),
        eventCode: LOG_EVENTS.PROVIDER_NETWORK_RETRY,
        details: { errorName: errorName(err) },
        message: "corpo da resposta não pôde ser decodificado — retry",
      } };
    }
  }

  if (!isServerError(res.status) || !canRetry) {
    return { result: { ok: false, status: res.status, error: `HTTP ${res.status}` } };
  }
  return { retry: {
    waitMs: retryAfterOrBackoff(),
    eventCode: LOG_EVENTS.PROVIDER_TRANSIENT_RETRY,
    details: { status: res.status },
    message: "resposta transitória — retry",
  } };
}

export async function fetchJsonWithRetry<T>(
  params: FetchJsonParams,
): Promise<FetchJsonResult<T>> {
  const timeoutMs = params.timeoutMs ?? 15_000;
  const externalSignal = params.signal;
  const maxRetries = params.maxRetries ?? 3;
  const base = params.baseBackoffMs ?? 400;

  const state: AttemptState = { init: params.init ?? {}, reauthUsed: false, lastError: "sem resposta" };
  let lastStatus: number | undefined;
  let attempts = 0;
  let httpDurationMs = 0;

  const finish = async (result: FetchJsonResult<T>): Promise<FetchJsonResult<T>> => {
    const expectedFailure = !result.ok && await params.isExpectedFailure?.(result) === true;
    await recordOperationalMetric({
      kind: "provider",
      name: params.label,
      outcome: result.ok ? "success" : expectedFailure ? "expected_retry" : "error",
      durationMs: httpDurationMs,
      statusCode: result.status,
      labels: { attempts, error: result.ok ? null : result.error.slice(0, 120) },
    });
    return result;
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (externalSignal?.aborted) {
      state.lastError = externalSignal.reason instanceof Error ? externalSignal.reason.message : "requisição cancelada";
      break;
    }
    try {
      await params.beforeAttempt?.();
    } catch (error) {
      // Uma tentativa já chegou ao fornecedor. Falta de cota no retry não
      // pode apagar essa falha da telemetria nem gerar outro fetch.
      if (attempts > 0) await finish({ ok: false, status: lastStatus, error: state.lastError });
      throw error;
    }
    if (externalSignal?.aborted) {
      state.lastError = externalSignal.reason instanceof Error ? externalSignal.reason.message : "requisição cancelada";
      break;
    }
    attempts += 1;
    const requestStart = Date.now();
    let res: Response | undefined;
    let retry: Retry;
    try {
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;
      res = await fetch(params.url, { ...state.init, signal });
      httpDurationMs += Date.now() - requestStart;
      lastStatus = res.status;
      if (!res.ok) state.lastError = `HTTP ${res.status}`;
      params.onResponse?.(res);
      const outcome = await handleResponse<T>(res, attempt, params, { maxRetries, base }, state);
      if ("result" in outcome) return finish(outcome.result);
      if ("reauthenticated" in outcome) {
        attempt--; // re-auth não consome retry transitório
        continue;
      }
      retry = outcome.retry;
    } catch (err) {
      if (err instanceof ProviderRequestGateError) {
        await finish({ ok: false, status: lastStatus, error: state.lastError });
        throw err;
      }
      httpDurationMs += Date.now() - requestStart;
      if (!res) lastStatus = undefined;
      state.lastError = err instanceof Error ? err.message : String(err);
      // Budget/abort externo: para na hora — retry só consumiria cota morta.
      if (params.signal?.aborted || attempt === maxRetries) break;
      retry = {
        waitMs: backoffMs(attempt, base),
        eventCode: LOG_EVENTS.PROVIDER_NETWORK_RETRY,
        details: { errorName: errorName(err) },
        message: "erro de rede — retry",
      };
    } finally {
      // 401/429/4xx/5xx e limites de tamanho podem dispensar a leitura do
      // corpo. Libera a conexão também nesses caminhos, antes da próxima tentativa.
      try {
        await res?.body?.cancel();
      } catch {
        // Um stream já encerrado/com erro não muda o resultado da requisição.
      }
    }
    log.warn(
      { eventCode: retry.eventCode, label: params.label, ...retry.details, attempt, waitMs: retry.waitMs },
      retry.message,
    );
    // Cancelamento encerra também a espera: não paga outra tentativa com sinal morto.
    await new Promise<void>((resolve) => {
      if (externalSignal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, retry.waitMs);
      externalSignal?.addEventListener("abort", done, { once: true });
    });
  }
  return finish({ ok: false, error: state.lastError });
}
