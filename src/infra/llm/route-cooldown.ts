import { prisma } from "@/src/infra/prisma";
import { privacyHash } from "@/src/infra/privacy";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";

const log = createLogger("llm-cooldown");
export type LlmRoute = { provider: string; key: string; model: string; endpoint: string; baseUrl?: string };
type Cooldown = { reason: string; scope: "route" | "credential"; until: Date };
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A cota diária do Gemini (RPD) volta à meia-noite do Pacífico, com horário
 * de verão. https://ai.google.dev/gemini-api/docs/rate-limits */
export function nextGeminiDailyReset(now: number): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = (time: number) => {
    const formatted = formatter.formatToParts(time);
    const field = (type: Intl.DateTimeFormatPartTypes) => {
      const value = formatted.find((part) => part.type === type);
      if (!value) throw new Error(`Missing Pacific date field: ${type}`);
      return Number(value.value);
    };
    return { year: field("year"), month: field("month"), day: field("day"),
      hour: field("hour"), minute: field("minute"), second: field("second") };
  };
  const date = parts(now);
  const target = Date.UTC(date.year, date.month - 1, date.day + 1);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const local = parts(guess);
    guess += target - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  }
  return guess;
}

/** Modelo inexistente ou não liberado para a conta não volta sozinho: um
 * cooldown curto só adia a próxima chamada perdida. Fica uma semana fora da
 * rotação (ou o que o Retry-After pedir), até o dono tirá-lo da configuração. */
const PERMANENT_MODEL_COOLDOWN_MS = 7 * DAY;
/** Nenhuma espera de cota passa de um dia; acima disso a rota foi estacionada. */
const PARKED_ROUTE_MIN_MS = DAY + 2 * 60 * MINUTE;
/** Chave inválida, expirada, bloqueada ou vazada: o Gemini responde 400 ou
 * 403, não 401, e nenhum modelo aceita a chave. */
const REJECTED_CREDENTIAL = /API_KEY_INVALID|API key not valid|API key expired|API_KEY_SERVICE_BLOCKED|reported as leaked/i;
const PERMANENT_MODEL_ERROR = /labs model|must enable|decommissioned|model[^.]{0,80}(?:not found|does not exist|not supported|not available)|(?:invalid|unknown) model|model_not_found|do(?:es)? not have access/i;

/** Availability and configuration failures do not count as failed readings.
 * A 403 can deny one model (e.g. Labs), so only 401/402 and a rejected key
 * block the credential. */
export function llmHttpCooldown(status: number, message: string, retryAfter: string | null | undefined, now = Date.now(), provider = ""): Cooldown | null {
  const raw = retryAfter?.trim();
  const retryAt = raw ? /^\d+(?:\.\d+)?$/.test(raw) ? now + Number(raw) * 1000 : Date.parse(raw) : NaN;
  const until = (fallback: number) => {
    const timestamp = Math.max(now + 1000, Number.isFinite(retryAt) ? Math.min(now + DAY, retryAt) : now + fallback);
    return new Date(timestamp);
  };
  if (status === 401 || status === 402) return { reason: status === 401 ? "authentication" : "billing", scope: "credential", until: until(60 * MINUTE) };
  if ((status === 400 || status === 403) && REJECTED_CREDENTIAL.test(message)) return { reason: "authentication", scope: "credential", until: until(60 * MINUTE) };
  if (status === 404 || ((status === 400 || status === 403) && PERMANENT_MODEL_ERROR.test(message))) {
    return { reason: "model_permanently_unavailable", scope: "route",
      until: new Date(Number.isFinite(retryAt) ? Math.max(now + 1000, retryAt) : now + PERMANENT_MODEL_COOLDOWN_MS) };
  }
  if (status === 403) return { reason: "model_unavailable", scope: "route", until: until(6 * 60 * MINUTE) };
  if (status === 429) {
    if (/(?:credit|balance).{0,60}(?:exhausted|insufficient|depleted)|(?:exhausted|insufficient|depleted).{0,60}(?:credit|balance)/i.test(message)) {
      return { reason: "billing", scope: "credential", until: new Date(now + 60 * MINUTE) };
    }
    const daily = /per.?day|requestsperday|tokensperday|daily|\brpd\b|\btpd\b/i.test(message);
    const zero = /limit\s*[:=]\s*0\b|quota.?value["\s:]*0\b/i.test(message);
    if (zero) return { reason: "quota_zero", scope: "route", until: new Date(now + 6 * 60 * MINUTE) };
    // O retryDelay curto do Gemini engana: a cota do dia só volta à meia-noite
    // do Pacífico. A Groq repõe TPD e RPD aos poucos, e o Retry-After dela diz
    // quando cabe o próximo pedido; sem o header, espera-se um dia.
    if (daily) return { reason: "daily_quota", scope: "route", until: provider.toLowerCase() === "gemini"
      ? new Date(Math.max(nextGeminiDailyReset(now), Number.isFinite(retryAt) ? retryAt : 0))
      : until(DAY) };
    return { reason: "rate_limit", scope: "route", until: until(MINUTE) };
  }
  if (status >= 500 || status === 408 || status === 0) return { reason: "transient", scope: "route", until: until(5000) };
  return null;
}
function identity(route: LlmRoute) {
  return { provider: `llm:${route.provider.toLowerCase()}:${privacyHash(`${route.baseUrl ?? ""}:${route.key}`, "llm-credential")}`, route: `${route.endpoint}:${route.model}` };
}
/** Shared across web/worker. No request sleeps while another family can run. */
export async function llmRouteAvailable(route: LlmRoute): Promise<boolean> {
  const id = identity(route);
  try {
    const row = await prisma.providerRequestGate.findFirst({ where: { provider: id.provider, route: { in: [id.route, "*"] }, nextAllowedAt: { gt: new Date() } }, select: { route: true } });
    return !row;
  } catch {
    log.warn({ provider: route.provider, model: route.model }, "falha ao consultar cooldown LLM — segue breaker existente");
    return true;
  }
}
/**
 * Bloqueio que só acaba daqui a mais de 1 h sobrevive a todas as novas
 * tentativas do job de captura: 5 na fila (de 15 s a 4 min entre elas) e mais
 * 3 reenvios da dead-letter (depois de 2, 10 e 30 min), cerca de 50 min ao
 * todo. Cota do dia do Gemini, modelo indisponível para a conta e Retry-After
 * longo deixam o modelo fora da configuração para a cascata, não caído:
 * relançar o post só gastaria a fila e atrasaria o aviso. Abaixo do corte, o
 * bloqueio conta como queda: o cooldown do circuito dos LLMs (15 min) e a cota
 * do dia da Groq quando o Retry-After promete vaga em menos de 1 h. A
 * credencial bloqueada (401, 402, crédito esgotado, chave recusada com 400 ou
 * 403) fica sempre fora: ela não volta sozinha em minutos, e o bloqueio dela
 * tem 60 min exatos.
 */
const OUT_OF_ROTATION_MIN_MS = 60 * MINUTE;

async function routeOutOfRotation(route: LlmRoute, now = new Date()): Promise<boolean> {
  const id = identity(route);
  try {
    const row = await prisma.providerRequestGate.findFirst({
      where: { provider: id.provider, OR: [
        { route: id.route, nextAllowedAt: { gt: new Date(now.getTime() + OUT_OF_ROTATION_MIN_MS) } },
        { route: "*", nextAllowedAt: { gt: now } },
      ] },
      select: { route: true },
    });
    return Boolean(row);
  } catch {
    // Sem saber, a cascata supõe que o modelo voltaria: relançar é o lado seguro.
    return false;
  }
}

/** Rota em cooldown curto avisa a cascata que o modelo não foi ouvido; fora da rotação, não. */
export async function reportUnavailableRoute(route: LlmRoute, report: ((outcome: "unavailable", model: string) => void) | undefined, model: string): Promise<void> {
  if (!report || await routeOutOfRotation(route)) return;
  report("unavailable", model);
}

export async function deferLlmRoute(route: LlmRoute, status: number, message = "", retryAfter?: string | null): Promise<void> {
  const cooldown = llmHttpCooldown(status, message, retryAfter, Date.now(), route.provider);
  if (!cooldown) return;
  const id = identity(route), routeId = cooldown.scope === "credential" ? "*" : id.route;
  try {
    // A late shorter response must never shorten a longer concurrent cooldown.
    await prisma.$executeRaw`
      INSERT INTO provider_request_gates (provider, route, "nextAllowedAt", "updatedAt")
      VALUES (${id.provider}, ${routeId}, ${cooldown.until}, ${new Date()})
      ON CONFLICT (provider, route) DO UPDATE SET
        "nextAllowedAt" = GREATEST(provider_request_gates."nextAllowedAt", EXCLUDED."nextAllowedAt"),
        "updatedAt" = EXCLUDED."updatedAt"`;
    const details = { provider: route.provider, model: route.model, endpoint: route.endpoint, reason: cooldown.reason, status, retryAt: cooldown.until.toISOString() };
    if (cooldown.reason === "model_permanently_unavailable") {
      log.warn({ ...details, eventCode: LOG_EVENTS.LLM_MODEL_PARKED,
        actionableHint: "Modelo inexistente ou não liberado para a conta: tire-o do catálogo (src/infra/llm/models.ts) ou, sem deploy, ponha-o em LLM_MODELS_DISABLED." },
      "modelo LLM fora da rotação — tire-o do catálogo");
    } else if (cooldown.scope === "credential") {
      // A chave fica fora da rotação e deixa de ser chamada: sem este aviso,
      // a chave morta sumiria num log info por hora.
      log.warn({ ...details, eventCode: LOG_EVENTS.LLM_CREDENTIAL_BLOCKED,
        actionableHint: "Chave recusada pelo provedor (inválida, expirada, bloqueada ou sem crédito): troque-a ou tire-a do runtime.env (GEMINI_API_KEYS, GEMINI_PAID_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY)." },
      "chave LLM recusada — fora da rotação");
    } else {
      log.info(details, "rota LLM em cooldown — próximas famílias continuam disponíveis");
    }
  } catch {
    log.warn({ provider: route.provider, model: route.model }, "falha ao persistir cooldown LLM");
  }
}

export type ParkedLlmRoute = { provider: string; endpoint: string; model: string; until: Date; credentials: number };

/** Rotas estacionadas (modelo indisponível para a conta), agregadas por modelo
 * entre as credenciais, para o painel mostrar o que saiu da rotação. */
export async function parkedLlmRoutes(now = new Date()): Promise<ParkedLlmRoute[]> {
  const rows = await prisma.providerRequestGate.findMany({
    where: { provider: { startsWith: "llm:" }, route: { not: "*" }, nextAllowedAt: { gt: new Date(now.getTime() + PARKED_ROUTE_MIN_MS) } },
    select: { provider: true, route: true, nextAllowedAt: true },
  });
  const parked = new Map<string, ParkedLlmRoute>();
  for (const row of rows) {
    const provider = row.provider.split(":")[1] ?? "";
    const separator = row.route.indexOf(":");
    if (!provider || separator < 0) continue;
    const endpoint = row.route.slice(0, separator), model = row.route.slice(separator + 1);
    const key = `${provider}/${model}/${endpoint}`;
    const current = parked.get(key);
    parked.set(key, current
      ? { ...current, credentials: current.credentials + 1, until: row.nextAllowedAt > current.until ? row.nextAllowedAt : current.until }
      : { provider, endpoint, model, until: row.nextAllowedAt, credentials: 1 });
  }
  return [...parked.values()];
}
