import { readJsonCapped } from "@/src/infra/http-request";
import { flashscoreLineupsSchema, type FlashscoreLineups } from "./lineups";
import { CircuitOpenError, isBreakerOpen, withBreaker } from "@/src/infra/circuit-breaker";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { contractBroken, contractIssues } from "@/src/providers/core/contract-issues";
import { z } from "zod";
import {
  chargeProviderRequest,
  reconcileProviderBudgetFromProvider,
} from "@/src/providers/budget";
import { ProviderRequestError } from "@/src/domain/provider-error";
import { fetchJsonWithRetry } from "@/src/providers/core/http";
import { awaitProviderCadence } from "@/src/providers/request-cadence";
import { FLASHSCORE_REQUEST_COOLDOWN_MS, FLASHSCORE_TRANSIENT_RETRIES } from "./limits";
import {
  flashscoreDateRetryAt,
  FlashscoreDateWindowError,
  FlashscoreListByDateClientError,
  isFlashscoreFutureHorizonMessage,
} from "./date-window";
import { shiftDayKey, spDayKey } from "@/src/domain/dates";
import {
  flashscoreDateResponseSchema,
  flashscoreStatsResponseSchema,
  type FlashscoreStatsResponse,
  type FlashscoreTournamentGroup,
} from "./types";
import {
  flashscoreSummaryResponseSchema,
  type FlashscoreSummaryResponse,
} from "./summary";
import {
  flashscorePlayerStatsResponseSchema,
  type FlashscorePlayerStatsResponse,
} from "./player-stats";

const BASE_URL = "https://flashscore4.p.rapidapi.com/api/flashscore/v2";
const RAPIDAPI_HOST = "flashscore4.p.rapidapi.com";
const log = createLogger("flashscore-contract");

export function flashscoreConfigured(): boolean {
  const env = getEnv();
  return env.FLASHSCORE_MODE !== "off" && Boolean(env.FLASHSCORE_API_KEY);
}

/**
 * Envelope de rate-limit do fornecedor: `{ message: "You have exceeded the rate
 * limit per minute for your plan, ULTRA, by the API provider" }`, servido com
 * HTTP **200**. A chamada não é cobrada na cota diária (medido: o contador da
 * RapidAPI não anda), mas a nossa reserva de budget já foi consumida — a
 * contagem erra para MAIS, que é o lado seguro.
 */
/**
 * O que o RapidAPI diz sobre a cota DELE: quanto resta e quando a janela vira.
 *
 * `x-ratelimit-requests-remaining` é o único número honesto sobre o saldo: a
 * janela do fornecedor não é o nosso dia de São Paulo, então o contador local
 * pode mostrar folga com a API já recusando tudo.
 *
 * `x-ratelimit-requests-reset` (SEGUNDOS até a virada): sem ele o contador
 * reconciliado ficaria preso acima do teto até a NOSSA virada, e como nenhuma
 * chamada passaria, nunca chegaria o header que provaria a liberação. Saldo
 * diz "quanto"; reset diz "de quem é esta conta".
 */
export type FlashscoreQuotaHeaders = {
  restante: number | null;
  resetEmSegundos: number | null;
};

function inteiroNaoNegativo(bruto: string | null): number | null {
  if (bruto === null || bruto.trim() === "") return null;
  const valor = Number(bruto.trim());
  return Number.isInteger(valor) && valor >= 0 ? valor : null;
}

export function flashscoreQuotaFromHeaders(res: Response): FlashscoreQuotaHeaders {
  return {
    restante: inteiroNaoNegativo(res.headers.get("x-ratelimit-requests-remaining")),
    resetEmSegundos: inteiroNaoNegativo(res.headers.get("x-ratelimit-requests-reset")),
  };
}

export function isRateLimitEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" && /exceeded the rate limit/i.test(message);
}

async function request<T>(params: {
  path: string;
  query: Record<string, string | number>;
  parse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: readonly z.core.$ZodIssue[] } };
}): Promise<T | null> {
  const apiKey = getEnv().FLASHSCORE_API_KEY;
  if (!apiKey) return null;

  const url = new URL(`${BASE_URL}${params.path}`);
  for (const [key, value] of Object.entries(params.query)) {
    url.searchParams.set(key, String(value));
  }

  // O fornecedor publica o SALDO da cota em toda resposta — inclusive na que
  // recusa. Capturado aqui e gravado logo abaixo, fora do caminho de retry.
  // Objeto, não `let`: o valor é escrito dentro de um callback, e o
  // estreitamento de fluxo de uma variável solta a daria como `null` no uso.
  const cota: FlashscoreQuotaHeaders = { restante: null, resetEmSegundos: null };
  // Corpo do HTTP 400 em list-by-date: recusa de contrato (horizonte, params, etc.).
  // NÃO é falha estrutural — ver FlashscoreListByDateClientError.
  const listByDate400: { body: Promise<unknown> | null } = { body: null };

  // Curto-circuito barato para QUALQUER consumidor: com o circuito aberto a
  // chamada é recusada aqui, sem pagar cadência, cota nem escrever métrica. Quem
  // chamou trata `CircuitOpenError` como sempre (o job adia a rodada inteira) e
  // a sonda do cooldown continua passando — `isBreakerOpen` só é verdadeiro com
  // o circuito OPEN dentro do prazo.
  if (await isBreakerOpen("flashscore")) throw new CircuitOpenError("flashscore");

  // LANCA em vez de devolver null: o catalogo cacheia a resposta vazia por 60s,
  // e cachear "nao perguntei" como "nao tem jogo" empurraria a aposta para um
  // tier pior durante um minuto inteiro.
  return withBreaker("flashscore", async () => {
    const result = await fetchJsonWithRetry<unknown>({
        url: url.toString(),
        init: {
          headers: {
            "x-rapidapi-host": RAPIDAPI_HOST,
            "x-rapidapi-key": apiKey,
          },
        },
        label: `flashscore${params.path}`,
        timeoutMs: 20_000,
        // Recupera uma falha transitória; cada fetch paga cota e cadência.
        maxRetries: FLASHSCORE_TRANSIENT_RETRIES,
        isExpectedFailure: async (result) =>
          result.status === 400 && params.path === "/matches/list-by-date",
        beforeAttempt: async () => {
          // Um gate GLOBAL no Postgres soma web + worker + qualquer endpoint.
          // Sem isto, cada processo poderia respeitar 240/min sozinho e a soma
          // ainda derrubaria o provider inteiro. A espera acontece antes da
          // cobrança: slot sem budget não finge ser request física.
          await awaitProviderCadence({
            provider: "flashscore",
            route: "global",
            cooldownMs: FLASHSCORE_REQUEST_COOLDOWN_MS,
          });
          await chargeProviderRequest("flashscore", params.path);
        },
        onResponse: (res) => {
          if (res.status === 400 && params.path === "/matches/list-by-date") {
            listByDate400.body = readJsonCapped(res.clone()).catch(() => null);
          }
          const lido = flashscoreQuotaFromHeaders(res);
          cota.restante = lido.restante;
          cota.resetEmSegundos = lido.resetEmSegundos;
        },
    });
      // ANTES de qualquer `throw`: a resposta que mais importa reconciliar é
      // justamente o 429, porque é ela que prova que a nossa conta estava
      // otimista. `await` de propósito — cota é estado decisório e vai para o
      // Postgres, nunca uma promessa solta.
    if (cota.restante !== null) {
      await reconcileProviderBudgetFromProvider(
        "flashscore",
        cota.restante,
        cota.resetEmSegundos,
      );
    }
    if (result.status === 400 && params.path === "/matches/list-by-date") {
      const body = listByDate400.body ? await listByDate400.body : null;
      const message = body && typeof body === "object" && "message" in body
        ? (body as { message?: unknown }).message
        : null;
      const day = String(params.query.date);
      const sportId = Number(params.query.sport_id);
      if (isFlashscoreFutureHorizonMessage(message)) {
        throw new FlashscoreDateWindowError(day, flashscoreDateRetryAt(day) ??
          new Date(`${shiftDayKey(spDayKey(new Date()), 1)}T03:00:00.000Z`));
      }
      const providerMessage = typeof message === "string" ? message : null;
      log.warn({
        eventCode: "PROVIDER_CONTRACT_INVALID",
        provider: "flashscore",
        endpoint: params.path,
        date: day,
        sportId: Number.isFinite(sportId) ? sportId : params.query.sport_id,
        timezone: params.query.timezone,
        providerMessage,
        status: 400,
      }, "FlashScore list-by-date recusou a consulta (HTTP 400); breaker preservado");
      throw new FlashscoreListByDateClientError(
        day,
        Number.isFinite(sportId) ? sportId : 0,
        providerMessage,
      );
    }
    if (!result.ok) {
      throw new ProviderRequestError(`FlashScore ${params.path}`, result);
    }
      // O limite POR MINUTO não devolve 429: devolve HTTP 200 com
      // `{ message: "You have exceeded the rate limit per minute…" }`. Sem esta
      // checagem o corpo cairia no Zod como "payload fora do contrato" e o
      // breaker contaria FALHA ESTRUTURAL — cinco delas e o FlashScore sairia do
      // ar por 15min como se estivesse quebrado. Reclassificado como 429,
      // `withBreaker` abre o cooldown pelo caminho de pressão de cota, sem sujar
      // a contagem de falha nem a SLO.
    if (isRateLimitEnvelope(result.data)) {
      throw new ProviderRequestError(`FlashScore ${params.path}`, {
        status: 429,
        error: "limite por minuto do fornecedor",
      });
    }
    const parsed = params.parse(result.data);
    if (!parsed.success) {
      log.warn({ eventCode: "PROVIDER_CONTRACT_INVALID", provider: "flashscore",
        endpoint: params.path, matchId: params.query.match_id,
        issues: contractIssues(parsed.error.issues) }, "resposta FlashScore fora do contrato");
      throw new ProviderRequestError(`FlashScore ${params.path}`, {
        status: result.status,
        error: "payload fora do contrato esperado",
      });
    }
    return parsed.data;
  });
}

export async function listFlashscoreMatchesByDate(
  dayKey: string,
  sportId = 1,
): Promise<FlashscoreTournamentGroup[] | null> {
  const retryAt = flashscoreDateRetryAt(dayKey);
  if (retryAt) throw new FlashscoreDateWindowError(dayKey, retryAt);
  const path = "/matches/list-by-date";
  return request({
    path,
    query: { date: dayKey, sport_id: sportId, timezone: "America/Sao_Paulo" },
    parse: (value) => {
      const parsed = flashscoreDateResponseSchema.safeParse(value);
      if (!parsed.success) return parsed;
      const { groups, rejected } = parsed.data;
      if (rejected.length === 0) return { success: true, data: groups };
      const issues = rejected.flatMap((row) => row.issues);
      const total = rejected.length + groups.reduce((sum, group) => sum + group.matches.length, 0);
      // A maioria fora do contrato é o contrato que mudou: falha alto como antes.
      if (contractBroken(rejected.length, total)) {
        return { success: false, error: { issues } };
      }
      log.warn({
        eventCode: "PROVIDER_CONTRACT_INVALID", provider: "flashscore", endpoint: path,
        date: dayKey, sportId, rejected: rejected.length, total,
        sample: rejected.flatMap((row) => (row.matchId ? [row.matchId] : [])).slice(0, 5),
        issues: contractIssues(issues),
      }, "partidas FlashScore fora do contrato descartadas; o resto do dia segue");
      return { success: true, data: groups };
    },
  });
}

export async function getFlashscoreMatchStats(
  matchId: string,
): Promise<FlashscoreStatsResponse | null> {
  return request({
    path: "/matches/match/stats",
    query: { match_id: matchId },
    parse: (value) => flashscoreStatsResponseSchema.safeParse(value),
  });
}

/** Detalhes brutos: o consumidor valida identidade e contrato dos parciais. */
export async function getFlashscoreMatchDetails(
  matchId: string,
): Promise<Record<string, unknown> | null> {
  return request({
    path: "/matches/details",
    query: { match_id: matchId },
    parse: (value) => z.record(z.string(), z.unknown()).safeParse(value),
  });
}

/** Eventos da partida; usados para separar gols de 90' dos de prorrogação. */
export async function getFlashscoreMatchSummary(
  matchId: string,
): Promise<FlashscoreSummaryResponse | null> {
  return request({
    path: "/matches/match/summary",
    query: { match_id: matchId },
    parse: (value) => flashscoreSummaryResponseSchema.safeParse(value),
  });
}

/** Jogadores da partida com as 103 chaves — fonte do resolver de artilheiro. */
export async function getFlashscoreMatchPlayerStats(
  matchId: string,
): Promise<FlashscorePlayerStatsResponse | null> {
  return request({
    path: "/matches/match/player-stats",
    query: { match_id: matchId },
    parse: (value) => flashscorePlayerStatsResponseSchema.safeParse(value),
  });
}

export async function getFlashscoreMatchLineups(matchId: string): Promise<FlashscoreLineups | null> {
  return request({ path: "/matches/match/lineups", query: { match_id: matchId }, parse: (value) => flashscoreLineupsSchema.safeParse(value) });
}
