import { canonicalSport } from "@/src/domain/sports/registry";
import { createHash } from "node:crypto";
import type { Prisma } from "@/src/generated/prisma/client";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { chargeProviderRequest } from "@/src/providers/budget";
import { BudgetExhaustedError, ProviderCadenceDeferredError, ProviderRequestError } from "@/src/domain/provider-error";
import { contractBroken } from "@/src/providers/core/contract-issues";
import { fetchJsonWithRetry } from "@/src/providers/core/http";
import { withBreaker } from "@/src/infra/circuit-breaker";
import { readProviderCache, writeProviderCache } from "@/src/providers/provider-cache";
import { awaitProviderCadence } from "@/src/providers/request-cadence";
import { BRIDGEODDS_REQUEST_COOLDOWN_MS } from "./limits";
import { isBridgeMatchPayload, sanitizeBridgeMatch, type BridgeMatch } from "./types";

const log = createLogger("bridgeodds");

/**
 * Adapter fino BridgeOdds: auth com cache de token + query opening-closing.
 * Cada tentativa HTTP custa uma unidade do teto horário. Paginação
 * conservadora: filtrado ≤3, sem filtro ≤5; o catálogo do dia tem teto
 * próprio de 15 páginas.
 */

const TOKEN_DEFAULT_TTL_MS = 15 * 60 * 1000;
const TOKEN_SAFETY_MS = 30_000;
const TOKEN_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A resposta documentada do login não publica `expires_in`, embora o token
 * seja JWT. O `exp` não é usado para AUTORIZAR nada (isso continua sendo
 * responsabilidade do servidor); ele só evita descartar localmente uma
 * credencial ainda válida a cada 15 minutos.
 */
export function bridgeTokenTtlMs(
  token: string,
  expiresIn: unknown,
  now = Date.now(),
): number {
  const declaredSeconds = Number(expiresIn);
  if (Number.isFinite(declaredSeconds) && declaredSeconds > 0) {
    return Math.min(declaredSeconds * 1_000, TOKEN_MAX_TTL_MS);
  }
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return TOKEN_DEFAULT_TTL_MS;
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    const expSeconds = Number(payload.exp);
    if (!Number.isFinite(expSeconds) || expSeconds <= 0) return TOKEN_DEFAULT_TTL_MS;
    const remaining = expSeconds * 1_000 - now;
    return Math.max(1_000, Math.min(remaining, TOKEN_MAX_TTL_MS));
  } catch {
    return TOKEN_DEFAULT_TTL_MS;
  }
}

const BRIDGE_PER_PAGE = 100;
/** Teto com filtro home/away/league (quase sempre 1 página). */
const BRIDGE_MAX_PAGES_FILTERED = 3;
/** Teto sem filtro (dia cheio / ById fallback). */
const BRIDGE_MAX_PAGES_UNFILTERED = 5;
/**
 * Teto da leitura de CATÁLOGO do dia (`catalog.ts`): um dia de futebol já
 * passou de 1.000 jogos (11 páginas). Um catálogo truncado usa debounce menor
 * e degrada as apostas para busca filtrada; 15 páginas custam 1/6 do teto
 * horário, por isso só via catálogo compartilhado/cacheado.
 */
export const BRIDGE_MAX_PAGES_CATALOG = 15;

let _token: string | null = null;
let _tokenExpiry = 0;
let _refreshing: Promise<string> | null = null;

function bridgeEnv(): { url: string; user: string; pass: string } {
  const env = getEnv();
  const url = env.BRIDGEODDS_URL;
  const user = env.BRIDGEODDS_USER;
  const pass = env.BRIDGEODDS_PASS;
  if (!url || !user || !pass) {
    throw new Error("BridgeOdds não configurado (BRIDGEODDS_URL/USER/PASS).");
  }
  return { url: url.replace(/\/$/, ""), user, pass };
}

export function bridgeConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.BRIDGEODDS_URL && env.BRIDGEODDS_USER && env.BRIDGEODDS_PASS);
}

function invalidateToken(rejectedToken: string): void {
  // Outra consulta pode ter renovado enquanto esta aguardava a cadência.
  // Um 401 do token antigo não invalida a credencial recém-obtida.
  if (_token !== rejectedToken) return;
  _token = null;
  _tokenExpiry = 0;
}

/**
 * Folga mínima entre a vaga do portão e o prazo do chamador. Com menos que
 * isso o timeout da chamada seria o resto do prazo: ela gastaria a cota e
 * contaria no circuito uma falha que é do nosso prazo, e não da Bridge.
 */
const BRIDGE_MIN_RESPONSE_MS = 3_000;

async function chargeBridgeRequest(route: string, deadlineMs?: number): Promise<void> {
  // Gate global no Postgres: login, web, worker e todas as páginas dividem a
  // mesma cadência. Assim 90/h é capacidade sustentável, não uma rajada que
  // dispara 429 antes de o contador horário proteger a conta.
  await awaitProviderCadence({
    provider: "bridgeodds",
    route: "global",
    cooldownMs: BRIDGEODDS_REQUEST_COOLDOWN_MS,
    ...(deadlineMs != null ? { deadlineMs: deadlineMs - BRIDGE_MIN_RESPONSE_MS } : {}),
  });
  if (deadlineMs != null && deadlineMs - Date.now() < BRIDGE_MIN_RESPONSE_MS) {
    throw new ProviderCadenceDeferredError("bridgeodds", new Date(Date.now() + 1_000));
  }
  await chargeProviderRequest("bridgeodds", route);
}

async function login(deadlineMs?: number): Promise<string> {
  return withBreaker("bridgeodds-auth", async () => {
    const { url, user, pass } = bridgeEnv();
    const res = await fetchJsonWithRetry<{ token?: string; expires_in?: unknown }>({
      url: `${url}/api/auth/login`,
      label: "bridgeodds.login",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: user, password: pass }),
      },
      maxRetries: deadlineMs == null ? 2 : 0,
      ...(deadlineMs != null ? { timeoutMs: Math.max(1, Math.min(15_000, deadlineMs - Date.now())),
        signal: AbortSignal.timeout(Math.max(1, deadlineMs - Date.now())) } : {}),
      beforeAttempt: () => chargeBridgeRequest("auth.login", deadlineMs),
    });
    if (!res.ok || !res.data.token) {
      const falha = new ProviderRequestError("BridgeOdds login falhou", {
        status: res.ok ? undefined : res.status,
        error: res.ok ? "sem token" : res.error,
        blocked: res.ok ? false : res.blocked,
      });
      throw falha;
    }
    const ttlMs = bridgeTokenTtlMs(res.data.token, res.data.expires_in);
    _token = res.data.token;
    _tokenExpiry = Date.now() + Math.max(1_000, ttlMs - TOKEN_SAFETY_MS);
    return _token;
  });
}

async function getToken(deadlineMs?: number): Promise<string> {
  if (_token && Date.now() < _tokenExpiry) return _token;
  _refreshing ??= login(deadlineMs).finally(() => {
    _refreshing = null;
  });
  return _refreshing;
}

export type BridgeQueryFilters = {
  home?: string;
  away?: string;
  league?: string;
};

type QueryOpeningClosingParams = {
  date: string; // YYYY-MM-DD
  sport: string; // nome BridgeOdds ("Futebol")
  filters?: BridgeQueryFilters;
  /** Para na página em que o predicado fica true (ex.: ById achou match_id). */
  stopWhen?: (accumulated: BridgeMatch[]) => boolean;
  /** Teto de páginas explícito (leitura de catálogo). Default: 3 filtrado / 5 sem filtro. */
  maxPages?: number;
  /** Deadline wall-clock do chamador; consultado entre páginas. */
  deadlineMs?: number;
  /** Reutiliza páginas de identidade durante retomadas; nunca para preço/fechamento. */
  resumeIdentityPages?: boolean;
};

/**
 * `rawCount` é o tamanho da página como a Bridge respondeu, antes da
 * sanitização: o fim da paginação e o `total` se medem por ele, porque uma
 * linha descartada não faz a página ser a última.
 */
type OpeningClosingPage = { results: BridgeMatch[]; rawCount: number; total: number | undefined; observedAt: number };

/**
 * 4xx de uma consulta é recusa DELA (a data, o filtro): o serviço respondeu, e
 * o circuito não conta falha. Credencial (401, 403), 408, 429 e bloqueio valem
 * para o serviço todo e continuam contando (ou abrindo o circuito).
 */
function isQueryRejection(error: ProviderRequestError): boolean {
  const status = error.status;
  return status !== undefined && status >= 400 && status < 500 && !error.blocked
    && status !== 401 && status !== 403 && status !== 408 && status !== 429;
}

async function fetchOpeningClosingPage(params: {
  url: string;
  date: string;
  sport: string;
  filters?: BridgeQueryFilters;
  page: number;
  deadlineMs?: number;
}): Promise<OpeningClosingPage> {
  // Resolve a credencial por página. Se uma página renovar após 401, a próxima
  // já usa o token novo em vez de provocar outra reautenticação desnecessária.
  const token = await getToken(params.deadlineMs);
  const query = new URL(`${params.url}/api/odds/opening-closing`);
  query.searchParams.set("sport", params.sport);
  query.searchParams.set("date", params.date);
  query.searchParams.set("per_page", String(BRIDGE_PER_PAGE));
  query.searchParams.set("page", String(params.page));
  if (params.filters?.home) query.searchParams.set("home", params.filters.home);
  if (params.filters?.away) query.searchParams.set("away", params.filters.away);
  if (params.filters?.league) query.searchParams.set("league", params.filters.league);

  const outcome = await withBreaker("bridgeodds", async (): Promise<OpeningClosingPage | ProviderRequestError> => {
    const res = await fetchJsonWithRetry<unknown>({
      url: query.toString(),
      label: `bridgeodds.opening-closing/${params.page}`,
      // 429 é pressão terminal (o helper não repete 429): o breaker contém a
      // conta pela janela horária medida. A documentação não publica a janela.
      maxRetries: params.deadlineMs == null ? 1 : 0,
      ...(params.deadlineMs != null ? { timeoutMs: Math.max(1, Math.min(15_000, params.deadlineMs - Date.now())),
        signal: AbortSignal.timeout(Math.max(1, params.deadlineMs - Date.now())) } : {}),
      beforeAttempt: () => chargeBridgeRequest("opening-closing", params.deadlineMs),
      init: { headers: { Authorization: `Bearer ${token}` } },
      onUnauthorized: async () => {
        invalidateToken(token);
        const fresh = await getToken(params.deadlineMs);
        return { Authorization: `Bearer ${fresh}` };
      },
    });
    if (!res.ok) {
      const err = new ProviderRequestError("BridgeOdds query falhou", res);
      if (isQueryRejection(err)) return err;
      throw err;
    }
    const observedAt = Date.now();
    // Placar e resultado saem aqui, antes de identidade/odds.
    if (!res.data || typeof res.data !== "object" || Array.isArray(res.data) ||
      !("results" in res.data) || !Array.isArray(res.data.results) ||
      ("total" in res.data && res.data.total != null &&
        (typeof res.data.total !== "number" || !Number.isSafeInteger(res.data.total) || res.data.total < 0))) {
      throw new ProviderRequestError("BridgeOdds query", { status: res.status, error: "envelope fora do contrato esperado" });
    }
    const raw: unknown[] = res.data.results;
    const expectedSport = canonicalSport(params.sport);
    const results = raw
      .map((row) => sanitizeBridgeMatch(row))
      .filter((m): m is BridgeMatch => m !== null)
      .filter((match) => !expectedSport || canonicalSport(match.sport) === expectedSport);
    // A maioria fora do contrato é o formato que mudou: falha, em vez de a
    // página virar "jogo não listado" ou "sem preço".
    if (contractBroken(raw.length - results.length, raw.length)) {
      log.warn({ eventCode: "PROVIDER_CONTRACT_INVALID", provider: "bridgeodds", endpoint: "opening-closing",
        rejected: raw.length - results.length, total: raw.length }, "resposta BridgeOdds fora do contrato");
      throw new ProviderRequestError("BridgeOdds query", { status: res.status, error: "payload fora do contrato esperado" });
    }
    const total = "total" in res.data && typeof res.data.total === "number" ? res.data.total : undefined;
    return { results, rawCount: raw.length, total, observedAt };
  });
  if (outcome instanceof ProviderRequestError) throw outcome;
  return outcome;
}

/**
 * Progresso durável da paginação de identidade, com o relógio original do
 * preço: uma retomada não paga de novo a página já lida. Só identidade usa;
 * preço e fechamento sempre consultam a API.
 */
async function readIdentityPage(
  params: { url: string; date: string; sport: string; page: number;
    filters?: { home?: string; away?: string; league?: string }; deadlineMs?: number },
  fetchPage: () => Promise<OpeningClosingPage>,
): Promise<OpeningClosingPage> {
  const key = "identity-page:v2:" + createHash("sha256").update(JSON.stringify([
    params.url, params.date, params.sport, params.page,
    params.filters?.home ?? "", params.filters?.away ?? "", params.filters?.league ?? "",
  ])).digest("hex");
  const cached = await readProviderCache<unknown>({ provider: "bridgeodds", key });
  const row = cached?.data as Partial<OpeningClosingPage> | null;
  if (row && Array.isArray(row.results) && row.results.every(isBridgeMatchPayload) &&
    typeof row.observedAt === "number" && Number.isFinite(row.observedAt) &&
    (row.total == null || (typeof row.total === "number" && Number.isFinite(row.total))) &&
    (row.rawCount == null || (typeof row.rawCount === "number" && Number.isFinite(row.rawCount)))) {
    // Página gravada antes de `rawCount` existir: o tamanho lido é o que há.
    return { results: row.results, rawCount: row.rawCount ?? row.results.length,
      total: row.total ?? undefined, observedAt: row.observedAt };
  }
  if (params.deadlineMs != null && params.deadlineMs - Date.now() < BRIDGE_MIN_RESPONSE_MS) {
    throw new ProviderCadenceDeferredError("bridgeodds", new Date(Date.now() + 1_000));
  }
  const page = await fetchPage();
  await writeProviderCache({ provider: "bridgeodds", key, ttlMs: 30 * 60_000,
    now: new Date(page.observedAt),
    data: { results: page.results, rawCount: page.rawCount, total: page.total ?? null,
      observedAt: page.observedAt } as unknown as Prisma.InputJsonValue });
  return page;
}

export type QueryOpeningClosingResult = {
  matches: BridgeMatch[];
  /** true se a paginação parou sem comprovar o fim, inclusive sem total publicado. */
  truncated: boolean;
  /**
   * A cota ou o prazo acabaram no meio da paginação: a Bridge não respondeu
   * tudo. O teto de páginas não conta, porque ali a resposta veio.
   */
  incomplete?: boolean;
  observedAtByMatchId?: Record<string, number>;
};

const warnedPaginationKeys = new Set<string>();

function warnPaginationOnce(
  reason: "budget" | "deadline" | "page-cap" | "discarded",
  params: QueryOpeningClosingParams,
  details: Record<string, unknown>,
): void {
  const hour = new Date().toISOString().slice(0, 13);
  const key =
    reason === "budget" || reason === "deadline"
      ? `${reason}:${hour}`
      : `${reason}:${hour}:${params.date}:${params.sport}:${Boolean(
          params.filters?.home || params.filters?.away || params.filters?.league,
        )}`;
  if (warnedPaginationKeys.has(key)) return;
  warnedPaginationKeys.add(key);
  if (warnedPaginationKeys.size > 256) warnedPaginationKeys.clear();
  log.warn({ ...details, sport: params.sport, date: params.date },
    reason === "budget"
      ? "BridgeOdds: budget esgotado mid-paginacao — devolvendo parcial"
      : reason === "deadline"
        ? "BridgeOdds: deadline da busca atingido mid-paginacao — devolvendo parcial"
        : reason === "discarded"
          ? "BridgeOdds: partidas fora do contrato descartadas na paginacao"
          : "BridgeOdds: paginacao interrompida antes de consumir total");
}

export function unwrapOpeningClosing(
  r: BridgeMatch[] | QueryOpeningClosingResult,
): QueryOpeningClosingResult {
  if (Array.isArray(r)) return { matches: r, truncated: false };
  return r;
}

export async function queryOpeningClosing(
  params: QueryOpeningClosingParams,
): Promise<QueryOpeningClosingResult> {
  const { url } = bridgeEnv();
  const filtered = Boolean(
    params.filters?.home || params.filters?.away || params.filters?.league,
  );
  const maxPages = params.maxPages
    ?? (filtered ? BRIDGE_MAX_PAGES_FILTERED : BRIDGE_MAX_PAGES_UNFILTERED);

  const all: BridgeMatch[] = [];
  const observedAtByMatchId: Record<string, number> = {};
  const resumePages = params.resumeIdentityPages === true && !params.stopWhen;
  let total: number | undefined;
  /** Linhas que a Bridge respondeu, inclusive as descartadas na sanitização. */
  let rawRead = 0;
  let stoppedEarly = false;
  let stoppedByBudget = false;
  let stoppedByDeadline = false;

  for (let page = 1; page <= maxPages; page++) {
    if (!resumePages && params.deadlineMs != null && params.deadlineMs - Date.now() < BRIDGE_MIN_RESPONSE_MS) {
      warnPaginationOnce("deadline", params, { page, lidos: all.length, total });
      stoppedEarly = true;
      stoppedByDeadline = true;
      break;
    }
    let pageResult: OpeningClosingPage | null;
    try {
      const pageParams = {
        url,
        date: params.date,
        sport: params.sport,
        filters: params.filters,
        page,
        deadlineMs: params.deadlineMs,
      };
      pageResult = resumePages
        ? await readIdentityPage(pageParams, () => fetchOpeningClosingPage(pageParams))
        : await fetchOpeningClosingPage(pageParams);
    } catch (err) {
      if (!(err instanceof BudgetExhaustedError)) throw err;
      pageResult = null;
    }

    if (pageResult === null) {
      warnPaginationOnce(
        "budget",
        params,
        {
          page,
          lidos: all.length,
          total,
        },
      );
      stoppedEarly = true;
      stoppedByBudget = true;
      break;
    }

    all.push(...pageResult.results);
    rawRead += pageResult.rawCount;
    for (const match of pageResult.results) observedAtByMatchId[String(match.match_id)] = pageResult.observedAt;
    if (pageResult.total !== undefined) total = pageResult.total;

    if (params.stopWhen?.(all)) break;
    if (total !== undefined && rawRead >= total) break;
    if (pageResult.rawCount === 0) {
      stoppedEarly = total !== undefined && rawRead < total;
      break;
    }
    if (total === undefined && pageResult.rawCount < BRIDGE_PER_PAGE) break;

    if (page === maxPages) stoppedEarly = true;
  }

  if (rawRead > all.length) {
    warnPaginationOnce("discarded", params, { descartadas: rawRead - all.length, lidos: all.length });
  }
  const truncated =
    stoppedByBudget ||
    stoppedByDeadline ||
    Boolean(stoppedEarly && (total === undefined || total > rawRead));
  if (truncated && all.length > 0 && !stoppedByBudget && !stoppedByDeadline) {
    warnPaginationOnce(
      "page-cap",
      params,
      {
        total,
        lidos: all.length,
        filtered,
        maxPages,
      },
    );
  }

  return {
    matches: all,
    truncated,
    ...(stoppedByBudget || stoppedByDeadline ? { incomplete: true } : {}),
    ...(resumePages ? { observedAtByMatchId } : {}),
  };
}
