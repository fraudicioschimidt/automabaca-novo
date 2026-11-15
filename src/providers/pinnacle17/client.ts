import type { Prisma } from "@/src/generated/prisma/client";
import { withBreaker } from "@/src/infra/circuit-breaker";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { BudgetExhaustedError, ProviderCadenceDeferredError, ProviderRequestError } from "@/src/domain/provider-error";
import { chargeProviderRequest, reconcileProviderBudgetFromProvider } from "@/src/providers/budget";
import { contractBroken } from "@/src/providers/core/contract-issues";
import { fetchJsonWithRetry } from "@/src/providers/core/http";
import { SingleFlight } from "@/src/providers/core/single-flight";
import { readProviderCache, writeProviderCache } from "@/src/providers/provider-cache";
import { awaitProviderCadence } from "@/src/providers/request-cadence";
import { archivePriceResponse } from "@/src/providers/price-archive/store";
import {
  PINNACLE17_EVENTS_TTL_MS,
  PINNACLE17_GLOBAL_COOLDOWN_MS,
  PINNACLE17_PRICE_TTL_MS,
  PINNACLE17_TRANSIENT_RETRIES,
} from "./limits";
import {
  parsePinnacle17Events,
  parsePinnacle17Markets,
  type Pinnacle17Event,
  type Pinnacle17Market,
  type Pinnacle17Parsed,
} from "./types";

const BASE_URL = "https://pinnacle17.p.rapidapi.com/api/pinnacle/v1";
const RAPIDAPI_HOST = "pinnacle17.p.rapidapi.com";
const TIMEOUT_MS = 30_000;
const log = createLogger("pinnacle17");
const flights = new SingleFlight<Pinnacle17Outcome<unknown>>();

type RateHeaders = { remaining: number | null; resetSeconds: number | null };
type Pinnacle17Observed<T> = { data: T; observedAt: Date };
const cacheReads = new SingleFlight<Pinnacle17Observed<unknown> | null>();
/**
 * O que a consulta deu. `failed` (HTTP, timeout, circuito, cota) não é
 * `not_observed` (resposta que não vale como observação): "não perguntei" não
 * pode virar "o fornecedor não tem a linha".
 */
export type Pinnacle17Outcome<T> =
  | { kind: "observed"; observed: Pinnacle17Observed<T> }
  | { kind: "not_observed" }
  | { kind: "failed"; budget: boolean };

function observedOrNull<T>(outcome: Pinnacle17Outcome<T>): Pinnacle17Observed<T> | null {
  return outcome.kind === "observed" ? outcome.observed : null;
}

/**
 * Consulta com prazo, a da agenda do fechamento: fila de cadência curta e, por
 * padrão, uma tentativa HTTP de até 8 s. Quem pede mais tempo por tentativa ou
 * uma retentativa (a consulta primária) ainda termina até `deadlineMs`.
 */
export type Pinnacle17Deadline = {
  deadlineMs: number;
  purpose?: "closing-series" | "closing-schedule";
  cadenceWaitMs?: number;
  attemptTimeoutMs?: number;
  retries?: number;
};

export function pinnacle17Configured(): boolean {
  const env = getEnv();
  return env.PINNACLE17_MODE !== "off" && Boolean(env.PINNACLE17_RAPIDAPI_KEY);
}

export function pinnacle17Enabled(): boolean {
  const env = getEnv();
  return env.PINNACLE17_MODE === "on" && Boolean(env.PINNACLE17_RAPIDAPI_KEY);
}

function numericHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readPinnacle17RateHeaders(headers: Headers, now = new Date()): RateHeaders {
  const remaining = numericHeader(headers, "x-ratelimit-requests-remaining");
  const rawReset = numericHeader(headers, "x-ratelimit-requests-reset");
  if (rawReset === null) return { remaining, resetSeconds: null };
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const epochSeconds = rawReset > 10_000_000_000 ? rawReset / 1_000 : rawReset;
  return {
    remaining,
    resetSeconds: epochSeconds > nowSeconds
      ? Math.max(1, Math.ceil(epochSeconds - nowSeconds))
      : Math.max(1, Math.ceil(rawReset)),
  };
}

async function request<T>(params: {
  path: "sport/matches" | "match/odds";
  query: Record<string, string | number>;
  reservationAttempt?: () => Promise<void>;
  event?: Pinnacle17Event;
  deadline?: Pinnacle17Deadline;
}): Promise<Pinnacle17Observed<T>> {
  const apiKey = getEnv().PINNACLE17_RAPIDAPI_KEY;
  if (!apiKey) throw new Error("Pinnacle17 não configurada");
  const url = new URL(`${BASE_URL}/${params.path}`);
  for (const [key, value] of Object.entries(params.query)) url.searchParams.set(key, String(value));
  let rate: RateHeaders = { remaining: null, resetSeconds: null };
  let attempts = 0;
  let requestedAt = new Date();
  let httpDate: string | null = null;
  const response = await fetchJsonWithRetry<T>({
    url: url.toString(),
    label: `pinnacle17/${params.path}`,
    init: { headers: { "x-rapidapi-key": apiKey, "x-rapidapi-host": RAPIDAPI_HOST } },
    timeoutMs: params.deadline
      ? Math.max(1, Math.min(params.deadline.attemptTimeoutMs ?? 8_000, params.deadline.deadlineMs - Date.now()))
      : TIMEOUT_MS,
    maxRetries: params.deadline ? params.deadline.retries ?? 0 : PINNACLE17_TRANSIENT_RETRIES,
    // O prazo vale para a consulta inteira: a retentativa não passa dele.
    ...(params.deadline ? { signal: AbortSignal.timeout(Math.max(1, params.deadline.deadlineMs - Date.now())) } : {}),
    beforeAttempt: async () => {
      // O primeiro slot foi reservado por cachedRequest, antes de reler o cache.
      // Toda tentativa adicional também passa pelo gate global e paga sua cota.
      const retrying = attempts++ > 0;
      if (retrying) {
        // Retentativa sem tempo até o prazo não paga cota.
        if (params.deadline && params.deadline.deadlineMs - Date.now() < 2_000) {
          throw new ProviderCadenceDeferredError("pinnacle17", new Date(Date.now() + 1_000));
        }
        await awaitProviderCadence({
          provider: "pinnacle17",
          route: "global",
          cooldownMs: PINNACLE17_GLOBAL_COOLDOWN_MS,
          ...(params.deadline ? { deadlineMs: params.deadline.deadlineMs - 2_000 } : {}),
        });
      }
      if (params.deadline && params.deadline.deadlineMs - Date.now() < (retrying ? 2_000 : 1_000)) {
        throw new ProviderCadenceDeferredError("pinnacle17", new Date(Date.now() + 1_000));
      }
      await (params.reservationAttempt?.() ?? chargeProviderRequest("pinnacle17", params.path));
      requestedAt = new Date();
    },
    onResponse: (raw) => { rate = readPinnacle17RateHeaders(raw.headers); httpDate = raw.headers.get("date"); },
  });
  // O recebimento do corpo fixa o instante; orçamento e arquivo podem demorar.
  const observedAt = new Date();
  if (rate.remaining !== null) {
    await reconcileProviderBudgetFromProvider("pinnacle17", rate.remaining, rate.resetSeconds);
  }
  if (!response.ok) throw new ProviderRequestError(`Pinnacle17 ${params.path}`, response);
  if (params.path === "match/odds") await archivePriceResponse({ version: 1, provider: "pinnacle17",
    endpoint: "/api/pinnacle/v1/match/odds", requestedAt: requestedAt.toISOString(), observedAt: observedAt.toISOString(),
    eventIds: [String(params.query.match_id)], context: { host: RAPIDAPI_HOST, query: params.query,
      event: params.event ?? null, httpDate }, body: response.data }, [apiKey]);
  return { data: response.data, observedAt };
}

/**
 * As linhas válidas da resposta. A maioria fora do contrato é o formato que
 * mudou: falha, em vez de entrar no cache como "sem jogos" ou "sem preço".
 */
function contractRows<T>(path: "sport/matches" | "match/odds", parsed: Pinnacle17Parsed<T> | null, accepts?: (row: T) => boolean): T[] {
  if (!parsed) throw new Error(`Pinnacle17 /${path} sem envelope válido`);
  const total = parsed.rows.length + parsed.rejected;
  const rows = accepts ? parsed.rows.filter(accepts) : parsed.rows;
  const rejected = total - rows.length;
  if (contractBroken(rejected, total)) {
    log.warn({ eventCode: "PROVIDER_CONTRACT_INVALID", provider: "pinnacle17", endpoint: path,
      rejected, total }, "resposta Pinnacle17 fora do contrato");
    throw new ProviderRequestError(`Pinnacle17 ${path}`, { status: 200, error: "payload fora do contrato esperado" });
  }
  if (rejected > 0) {
    log.debug({ provider: "pinnacle17", endpoint: path, rejected, total },
      "linhas Pinnacle17 fora do contrato descartadas; o resto segue");
  }
  return rows;
}

function logPinnacle17Failure(error: unknown, cacheKey: string): void {
  if (error instanceof BudgetExhaustedError) return;
  if (error instanceof Error && error.name === "CircuitOpenError") {
    log.debug(
      { eventCode: LOG_EVENTS.PROVIDER_CIRCUIT_BLOCKED, provider: "pinnacle17", cacheKey },
      "Pinnacle17 em circuit breaker — requisição suprimida",
    );
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const isAntiBot = message.includes("bloqueio anti-bot") || message.includes("text/html");
  const isTimeout =
    (error instanceof Error && error.name === "AbortError") ||
    message.includes("timeout") ||
    message.includes("aborted");
  log.warn(
    {
      eventCode: isAntiBot
        ? LOG_EVENTS.PROVIDER_ANTI_BOT_CHALLENGE
        : isTimeout ? LOG_EVENTS.PROVIDER_TIMEOUT : LOG_EVENTS.HTTP_REQUEST_FAILED,
      err: error,
      provider: "pinnacle17",
      cacheKey,
      actionableHint: isAntiBot
        ? "Cloudflare ou WAF bloqueou a chamada. O circuit breaker tratará o cooldown automaticamente."
        : isTimeout
          ? "Timeout ao consultar Pinnacle17. O próximo ciclo de agendamento tentará novamente."
          : undefined,
    },
    "consulta Pinnacle17 falhou",
  );
}

function readCached<T>(cacheKey: string): Promise<Pinnacle17Observed<T> | null> {
  // Deduplica somente a leitura em voo, sem manter preço depois que ela termina.
  return cacheReads.run(cacheKey, async () => {
    const hit = await readProviderCache<unknown>({ provider: "pinnacle17", key: cacheKey });
    return hit ? { data: hit.data, observedAt: hit.fetchedAt } : null;
  }) as Promise<Pinnacle17Observed<T> | null>;
}

async function cachedRequest<T>(params: {
  cacheKey: string;
  ttlMs: number;
  load: () => Promise<Pinnacle17Observed<T>>;
  deadline?: Pinnacle17Deadline;
  /** Resposta que não vale como observação: não entra no cache e volta `not_observed`. */
  isTransient?: (data: T) => boolean;
}): Promise<Pinnacle17Outcome<T>> {
  const hit = await readCached<T>(params.cacheKey);
  if (hit) return { kind: "observed", observed: hit };
  // Coleta oportunista pega carona numa consulta normal em voo, mas a consulta
  // normal não herda uma recusa de quota da coleta.
  const flightKey = params.deadline ? `${params.cacheKey}:${params.deadline.purpose ?? "archive"}` : params.cacheKey;
  const flight = flights.inFlight(params.cacheKey) ?? flights.run(flightKey, async () => {
    try {
      await awaitProviderCadence({
        provider: "pinnacle17",
        route: "global",
        cooldownMs: PINNACLE17_GLOBAL_COOLDOWN_MS,
        ...(params.deadline ? { deadlineMs: Math.min(Date.now() + Math.min(5000, params.deadline.cadenceWaitMs ?? 250), params.deadline.deadlineMs - 1000) } : {}),
      });
      const afterWait = await readCached<T>(params.cacheKey);
      if (afterWait) return { kind: "observed", observed: afterWait };
      const { data, observedAt } = await withBreaker("pinnacle17", params.load);
      if (params.isTransient?.(data)) {
        log.info({ provider: "pinnacle17", cacheKey: params.cacheKey }, "resposta Pinnacle17 transitória — sem cache, próxima tentativa consulta de novo");
        return { kind: "not_observed" };
      }
      try {
        await writeProviderCache({
          provider: "pinnacle17",
          key: params.cacheKey,
          data: data as Prisma.InputJsonValue,
          ttlMs: params.ttlMs,
          now: observedAt,
        });
      } catch {
        // A observação já foi obtida; este cache só evita futuras consultas.
        log.warn({ provider: "pinnacle17", cacheKey: params.cacheKey },
          "falha ao persistir cache Pinnacle17 — resposta preservada");
      }
      return { kind: "observed", observed: { data, observedAt } };
    } catch (error) {
      logPinnacle17Failure(error, params.cacheKey);
      return { kind: "failed", budget: error instanceof BudgetExhaustedError };
    }
  });
  return flight as Promise<Pinnacle17Outcome<T>>;
}

type Pinnacle17EventsParams = {
  sportId: number;
  kickoffUtc: Date;
  deadline?: Pinnacle17Deadline;
};

export async function fetchPinnacle17Events(
  params: Pinnacle17EventsParams,
): Promise<Pinnacle17Observed<Pinnacle17Event[]> | null> {
  return observedOrNull(await fetchPinnacle17EventsOutcome(params));
}

/** Como `fetchPinnacle17Events`, separando a consulta que falhou do dia sem jogos. */
export async function fetchPinnacle17EventsOutcome(
  params: Pinnacle17EventsParams,
): Promise<Pinnacle17Outcome<Pinnacle17Event[]>> {
  const date = params.kickoffUtc.toISOString().slice(0, 10);
  return cachedRequest({
    cacheKey: `matches:${params.sportId}:${date}:UTC:v3`,
    ttlMs: PINNACLE17_EVENTS_TTL_MS,
    deadline: params.deadline,
    load: async () => {
      const observed = await request<unknown>({
        path: "sport/matches",
        query: { sport_id: params.sportId, date, timezone: "UTC" },
        deadline: params.deadline,
      });
      return { ...observed, data: contractRows("sport/matches", parsePinnacle17Events(observed.data),
        (event) => event.sport.id === params.sportId) };
    },
  });
}

/**
 * O jogo da Pinnacle17 pelo id, na lista de jogos do dia (`sport/matches`, em
 * cache), procurando nos dias UTC dos instantes dados. O `match_id` da
 * BridgeOdds é o mesmo id. Null sem a Pinnacle17 ou sem o jogo.
 */
export async function findPinnacle17EventById(params: {
  sportId: number;
  eventId: string;
  around: readonly Date[];
  deadline?: Pinnacle17Deadline;
}): Promise<Pinnacle17Event | null> {
  if (!pinnacle17Enabled()) return null;
  const days = new Map(params.around
    .filter((instant) => Number.isFinite(instant.getTime()))
    .map((instant) => [instant.toISOString().slice(0, 10), instant] as const));
  for (const kickoffUtc of days.values()) {
    const feed = await fetchPinnacle17Events({ sportId: params.sportId, kickoffUtc, deadline: params.deadline });
    const event = feed?.data.find((row) => String(row.id) === params.eventId);
    if (event) return event;
  }
  return null;
}

function isPrematch(event: Pinnacle17Event | undefined): boolean {
  if (!event || event.status.isStarted || event.status.isInProgress || event.status.isInterrupted) return false;
  return new Date(event.startTime).getTime() > Date.now();
}

export async function fetchPinnacle17Odds(
  matchId: number,
  reservationAttempt?: () => Promise<void>,
  event?: Pinnacle17Event,
  deadline?: Pinnacle17Deadline,
): Promise<Pinnacle17Observed<Pinnacle17Market[]> | null> {
  return observedOrNull(await fetchPinnacle17OddsOutcome(matchId, reservationAttempt, event, deadline));
}

/** Como `fetchPinnacle17Odds`, separando a falha da consulta da resposta sem observação. */
export async function fetchPinnacle17OddsOutcome(
  matchId: number,
  reservationAttempt?: () => Promise<void>,
  event?: Pinnacle17Event,
  deadline?: Pinnacle17Deadline,
): Promise<Pinnacle17Outcome<Pinnacle17Market[]>> {
  return cachedRequest({
    cacheKey: `odds:${matchId}:prematch:v2`,
    ttlMs: PINNACLE17_PRICE_TTL_MS,
    deadline,
    // Evento pré-jogo sem nenhum mercado é falha passageira do feed, não
    // "sem linha": guardado, esconderia a linha do fechamento até o TTL vencer.
    isTransient: (markets) => markets.length === 0 && isPrematch(event),
    load: async () => {
      const observed = await request<unknown>({
        path: "match/odds",
        query: { match_id: matchId, timezone: "UTC" },
        reservationAttempt,
        event,
        deadline,
      });
      return { ...observed, data: contractRows("match/odds", parsePinnacle17Markets(observed.data)) };
    },
  });
}
