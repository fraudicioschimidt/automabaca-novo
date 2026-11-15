import { createHash } from "node:crypto";
import { truncateOperatorMessage } from "@/src/domain/mensagem-operador";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { redactSensitiveValue, scrubSecrets } from "@/src/infra/redaction";
import { OperationalRisk, type Prisma } from "@/src/generated/prisma/client";
import { ACTIVE_OPERATIONAL_ACTION_STATUSES } from "@/src/domain/operational-action-status";
import {
  operationalActionFingerprint,
  priorityForRisk,
  reportOperationalAction,
  reportOperationalActionTx,
  type OperationalActionEvidence,
  type ReportOperationalActionInput,
} from "@/src/services/ops/operational-actions";

const log = createLogger("alerts");

const THROTTLE_ACTION = "ops.alert_throttle";

export type OperationalAlertContext = {
  source: string;
  key: string;
  title: string;
  risk?: OperationalRisk;
  resource?: string | null;
  resourceId?: string | null;
  evidence?: OperationalActionEvidence;
  autoResolve?: boolean;
};

export function getMessageFingerprint(msg: string): string {
  const telegramIdToken = (value: string) => {
    const digest = createHash("sha256").update(value).digest();
    return Array.from(digest.subarray(0, 10), (byte) => String.fromCharCode(97 + (byte % 26))).join("");
  };
  return msg
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "[UUID]")
    .replace(/\b(chat_id|channel_id|user_id)\s*[:=]\s*(-?\d+)/gi, (_match, key, id) => (
      `${String(key).toLowerCase()}=[id_${telegramIdToken(String(id))}]`
    ))
    .replace(/\b429\b/g, "[HTTP_TOO_MANY_REQUESTS]")
    .replace(/\d+/g, "[NUM]")
    .trim()
    .slice(0, 150);
}

export function getOperationalAlertFingerprint(
  context: Pick<OperationalAlertContext, "source" | "key">,
): string {
  const identity = `${context.source.trim()}:${context.key.trim()}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `op:${identity.slice(0, 110)}:${digest}`.slice(0, 150);
}

const THROTTLE_TTL_MS = 10 * 60_000;
// Maior que o envio (10 s de fetch mais a reserva) e menor que a primeira
// retentativa de um job (5 min).
const DEDUPE_IN_FLIGHT_MS = 2 * 60_000;

/**
 * Escada de silêncio para a mesma falha repetida: 10min → 1h → 6h → 24h.
 * Silenciar o Telegram não perde informação: a ação continua aberta no painel.
 */
const THROTTLE_ESCALA_MS = [
  THROTTLE_TTL_MS,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

/** Maior que o degrau anterior para não zerar a escada entre dois ciclos. */
const RECORRENCIA_JANELA_MS = 2 * 60 * 60_000;

function nextThrottleStreak(raw: unknown): number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1
    ? raw + 1
    : 2;
}

/** Reserva sem entrega: falha técnica ou 429 não sobe a escada de silêncio. */
function sameThrottleStreak(raw: unknown): number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 ? raw : 1;
}

/** Espera pedida pelo Telegram num 429 (`parameters.retry_after`, em segundos), sem encurtar a espera informada. */
function telegramRetryAfterMs(body: string): number {
  let seconds: unknown;
  try {
    seconds = (JSON.parse(body) as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after;
  } catch {
    seconds = undefined;
  }
  const ms = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 30_000;
  return Number.isFinite(new Date(Date.now() + ms).getTime()) ? Math.max(ms, 1_000) : 30_000;
}

function throttleTtlMs(streak: number): number {
  const index = Math.min(Math.max(streak, 1), THROTTLE_ESCALA_MS.length) - 1;
  return THROTTLE_ESCALA_MS[index] ?? THROTTLE_TTL_MS;
}

type ThrottleDetails = {
  expiresAt: string;
  streak: number;
  preview: string;
  provider?: string;
  /** O Telegram recusou o envio (429): a reserva só guarda o `retry_after`. */
  rateLimited?: true;
  /** Reserva sem confirmação do Telegram; não prova entrega. */
  inFlight?: true;
};

type ThrottleReservation =
  | { status: "reserved"; id: string; details: ThrottleDetails }
  | { status: "active"; malformed: boolean; rateLimited: boolean; inFlight: boolean };

type OperatorDeliveryStatus =
  | "delivered"
  | "deduplicated"
  | "rate_limited"
  | "in_flight"
  | "not_configured"
  | "http_error"
  | "network_error";

/**
 * Provider a que o alerta se refere, quando ele DECLARA isso (`resource:
 * "provider"` com o nome em `resourceId`). É o que permite ao auto-resolve
 * comparar por igualdade: deduzir do fingerprint por substring pegaria toda a
 * família `settlement.flashscore*` e apagaria o throttle dela a cada heartbeat.
 */
function providerDeclarado(context?: OperationalAlertContext): string | null {
  if (!context || context.resource !== "provider") return null;
  const nome = context.resourceId?.trim().toLowerCase();
  return nome ? nome : null;
}

async function reserveThrottle(
  fingerprint: string,
  message: string,
  now: Date,
  provider: string | null,
  ttlMs?: number,
): Promise<ThrottleReservation> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ops.alert:${fingerprint}`}, 0))`;
    const row = await tx.auditEvent.findFirst({
      where: { action: THROTTLE_ACTION, resource: "ops.alert", resourceId: fingerprint },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, details: true },
    });
    let streak = 1;
    if (row) {
      const detalhes = row.details as { expiresAt?: unknown; streak?: unknown; rateLimited?: unknown; inFlight?: unknown } | null;
      const rateLimited = detalhes?.rateLimited === true;
      const inFlight = detalhes?.inFlight === true;
      const rawExpiresAt = detalhes?.expiresAt;
      const parsedExpiresAt = typeof rawExpiresAt === "string" ? new Date(rawExpiresAt) : null;
      const validExpiresAt = parsedExpiresAt && Number.isFinite(parsedExpiresAt.getTime())
        ? parsedExpiresAt
        : null;
      if (validExpiresAt ? validExpiresAt > now : row.createdAt.getTime() + THROTTLE_TTL_MS > now.getTime()) {
        return { status: "active", malformed: validExpiresAt === null, rateLimited, inFlight };
      }
      // Expirou HÁ POUCO = a falha não parou, só passou da janela. Sobe a
      // escada. Expirou há muito = incidente novo, começa de baixo.
      const venceuEm = validExpiresAt ?? new Date(row.createdAt.getTime() + THROTTLE_TTL_MS);
      if (now.getTime() - venceuEm.getTime() < RECORRENCIA_JANELA_MS) {
        streak = rateLimited || inFlight ? sameThrottleStreak(detalhes?.streak) : nextThrottleStreak(detalhes?.streak);
      }
    }
    const ttl = ttlMs ?? throttleTtlMs(streak);
    const details: ThrottleDetails = {
      expiresAt: new Date(now.getTime() + Math.min(ttl, DEDUPE_IN_FLIGHT_MS)).toISOString(),
      inFlight: true,
      streak,
      preview: message.slice(0, 200),
      // Só quando o alerta DECLARA ser sobre o provider. É o que o
      // auto-resolve compara — por igualdade, nunca por substring.
      ...(provider ? { provider } : {}),
    };
    const created = await tx.auditEvent.create({
      data: {
        actor: "system",
        action: THROTTLE_ACTION,
        resource: "ops.alert",
        resourceId: fingerprint,
        details,
      },
      select: { id: true },
    });
    return { status: "reserved", id: created.id, details };
  }, {
    // Sob pressão do pool, o default curto de aquisição faria a segunda reserva
    // cair no fail-open e duplicar o envio antes de sequer disputar o advisory lock.
    maxWait: 10_000,
    timeout: 15_000,
  });
}

async function releaseThrottleReservation(id: string): Promise<void> {
  await prisma.auditEvent.deleteMany({ where: { id, action: THROTTLE_ACTION } });
}

/**
 * 429: a reserva fica, para não virar uma rajada de novas tentativas, mas só
 * até o `retry_after` e marcada como não entregue. Assim a retentativa do
 * digest envia de novo em vez de achar que já entregou.
 */
async function holdThrottleForRateLimit(
  reservation: { id: string; details: ThrottleDetails },
  retryAfterMs: number,
): Promise<void> {
  await prisma.auditEvent.updateMany({
    where: { id: reservation.id, action: THROTTLE_ACTION },
    data: {
      details: {
        ...reservation.details,
        expiresAt: new Date(Date.now() + retryAfterMs).toISOString(),
        rateLimited: true,
      },
    },
  });
}

/** Depois da entrega confirmada, a reserva curta do envio passa a valer o prazo do dedupe. */
async function confirmThrottleDelivery(
  reservation: { id: string; details: ThrottleDetails },
  forMs: number,
): Promise<void> {
  const details = { ...reservation.details, expiresAt: new Date(Date.now() + forMs).toISOString() };
  delete details.inFlight;
  await prisma.auditEvent.updateMany({
    where: { id: reservation.id, action: THROTTLE_ACTION },
    data: { details },
  });
}

/**
 * Limpa o throttle dos alertas que DECLARAM ser sobre um provider cujo breaker
 * já fechou, para o próximo alerta real daquele provider não nascer abafado.
 * A identidade é comparada por igualdade contra o `provider` gravado no
 * throttle, nunca por substring do fingerprint.
 */
export async function autoResolveStaleOperationalAlerts(): Promise<number> {
  const closedProviders = await prisma.providerCircuit.findMany({
    where: { state: "CLOSED" },
    select: { provider: true },
  });
  if (closedProviders.length === 0) return 0;

  const providers = [...new Set(closedProviders.map((row) => row.provider.toLowerCase()))];
  const stale = await prisma.auditEvent.findMany({
    where: {
      action: THROTTLE_ACTION,
      resource: "ops.alert",
      // O predicado acionável vem antes do limite para garantir progresso.
      OR: providers.map((provider) => ({
        details: { path: ["provider"], equals: provider },
      })),
    },
    select: { resourceId: true, details: true },
    take: 200,
  });
  const ids = [
    ...new Set(
      stale
        // Defesa final contra adapter/mock que viole o filtro JSON da query.
        .filter((row) => {
          const declarado = (row.details as { provider?: unknown } | null)?.provider;
          return typeof declarado === "string" && providers.includes(declarado);
        })
        .map((row) => row.resourceId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return 0;
  const result = await prisma.auditEvent.deleteMany({
    where: { action: THROTTLE_ACTION, resource: "ops.alert", resourceId: { in: ids } },
  });
  if (result.count > 0) {
    log.info(
      { cleared: result.count, providers },
      "alertas operacionais auto-resolvidos (breaker CLOSED)",
    );
  }
  return result.count;
}

/** Entrega uma mensagem ao operador, sem alterar o estado de incidentes. */
async function deliverOperatorMessage(
  message: string,
  opts: { fingerprint?: string; provider?: string | null; ttlMs?: number; deliveredTtlMs?: number } = {},
): Promise<OperatorDeliveryStatus> {
  const safeMessage = scrubSecrets(message, { preserveNewlines: true });
  const env = getEnv();
  const token = env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
  const chatId = env.TELEGRAM_NOTIFICATION_CHAT_ID;
  const fingerprint = opts.fingerprint ?? getMessageFingerprint(safeMessage);
  const now = new Date();

  if (!token || !chatId) {
    log.warn({ message: safeMessage }, "Alerta operacional sem bot configurado — registrado apenas em log");
    return "not_configured";
  }

  let reserved: { id: string; details: ThrottleDetails } | null = null;
  try {
    const reservation = await reserveThrottle(
      fingerprint,
      safeMessage,
      now,
      opts.provider ?? null,
      opts.ttlMs,
    );
    if (reservation.status === "active") {
      if (reservation.malformed) {
        log.warn({ fingerprint }, "throttle sem expiresAt válido — mantendo cooldown fail-safe");
      } else {
        log.debug({ fingerprint, rateLimited: reservation.rateLimited }, "alerta operacional throttled");
      }
      // A reserva em voo e o 429 ainda não provaram a entrega.
      return reservation.rateLimited ? "rate_limited"
        : reservation.inFlight || reservation.malformed ? "in_flight" : "deduplicated";
    }
    reserved = { id: reservation.id, details: reservation.details };
  } catch (err) {
    log.warn({ err }, "falha ao reservar throttle de alerta — enviando em modo degradado");
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        // Sem cabeçalho fixo: o chat já é do bot, e o "🚨" em toda mensagem
        // faria uma captura de rotina parecer incidente. Cada texto abre com
        // o próprio emoji do assunto.
        text: truncateOperatorMessage(safeMessage),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error({ status: res.status, body, message: safeMessage }, "Telegram recusou alerta operacional");
      if (res.status === 429) {
        if (reserved) await holdThrottleForRateLimit(reserved, telegramRetryAfterMs(body)).catch(() => undefined);
        return "rate_limited";
      }
      if (reserved) await releaseThrottleReservation(reserved.id).catch(() => undefined);
      return "http_error";
    }
    if (reserved) {
      // Falhar aqui só deixa a reserva curta vencer: no pior caso sai repetido.
      await confirmThrottleDelivery(reserved, opts.deliveredTtlMs ?? throttleTtlMs(reserved.details.streak))
        .catch((err: unknown) => log.warn({ err, fingerprint }, "não consegui confirmar o dedupe da entrega"));
    }
    return "delivered";
  } catch (err) {
    log.error({ err, message: safeMessage }, "Falha ao enviar alerta operacional");
    if (reserved) await releaseThrottleReservation(reserved.id).catch(() => undefined);
    return "network_error";
  }
}

/**
 * Notificação de rotina no Telegram; nunca abre incidente.
 *
 * Dedupe pelo hash do texto CRU: normalizar números colapsaria duas
 * liquidações do mesmo confronto com placar/lucro diferentes e engoliria a
 * segunda. A chave distingue recursos que geram o mesmo texto; retries com
 * a mesma chave e conteúdo continuam deduplicados.
 */
export async function sendOperatorNotification(message: string, scope?: { key: string }): Promise<boolean> {
  const identity = scope ? JSON.stringify([scope.key, message]) : message;
  const fingerprint = `notif:${createHash("sha256").update(identity).digest("hex").slice(0, 40)}`;
  return (await deliverOperatorMessage(message, { fingerprint })) === "delivered";
}

/**
 * Para jobs cujo produto é a entrega: dedupe conclui; falha real (inclusive
 * 429) ativa retry/DLQ. Com `dedupe`, a entrega é única por `key` durante
 * `forMs`, e não pelo hash do texto: o job que refaz o mesmo disparo com um
 * número novo não manda uma segunda mensagem. A falha de rede ainda libera a
 * chave, porque o envio que não saiu tem de sair na retentativa. Durante o
 * envio a chave vale só `DEDUPE_IN_FLIGHT_MS`: o processo que morre no meio a
 * deixa vencer antes da retentativa do job, e o `forMs` passa a valer quando o
 * Telegram confirma a entrega.
 */
export async function sendRequiredOperatorNotification(
  message: string,
  dedupe?: { key: string; forMs: number },
): Promise<"delivered" | "deduplicated"> {
  const fingerprint = `notif:${dedupe?.key ?? createHash("sha256").update(message).digest("hex").slice(0, 40)}`;
  const status = await deliverOperatorMessage(
    message,
    dedupe ? { fingerprint, ttlMs: DEDUPE_IN_FLIGHT_MS, deliveredTtlMs: dedupe.forMs } : { fingerprint },
  );
  if (status === "delivered" || status === "deduplicated") return status;
  throw new Error(`Falha ao entregar notificação obrigatória ao operador (${status}).`);
}

/**
 * Registra uma falha acionável e também tenta notificá-la no Telegram. O contexto
 * obrigatório impede que mensagens normais de negócio contaminem o inbox.
 */
export async function sendOperationalAlert(
  message: string,
  context: OperationalAlertContext,
): Promise<boolean> {
  await persistOperationalAlert(message, context);
  return notifyPersistedOperationalAlert(message, context);
}

/**
 * Para o aviso de que o próprio banco pode estar fora: a caixa de ações é
 * tentada, mas a falha dela não segura o Telegram (a reserva do throttle, que
 * também é no banco, cai no envio degradado). Quem chama deduplica sozinho.
 */
export async function sendOperationalAlertEvenIfDatabaseDown(
  message: string,
  context: OperationalAlertContext,
): Promise<boolean> {
  try {
    await persistOperationalAlert(message, context);
  } catch (err) {
    log.warn({ err, source: context.source }, "caixa de ações indisponível; o aviso segue só pelo Telegram");
  }
  return notifyPersistedOperationalAlert(message, context);
}

/** O alerta desta fonte e chave já está aberto (ou assumido) na caixa de ações? */
export async function isOperationalAlertOpen(
  context: Pick<OperationalAlertContext, "source" | "key">,
): Promise<boolean> {
  const safeContext = redactSensitiveValue(context, { preserveNewlines: true }) as Pick<OperationalAlertContext, "source" | "key">;
  const open = await prisma.operationalAction.findFirst({
    where: {
      fingerprint: operationalActionFingerprint(safeContext.source, safeContext.key),
      status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
    },
    select: { id: true },
  });
  return open !== null;
}

/**
 * Condição que dura (canal calado, recusas repetidas): o Telegram recebe o
 * aviso quando ela abre; enquanto segue aberta, só a ação na caixa se
 * atualiza.
 */
export async function raiseOperationalAlertOnce(
  message: string,
  context: OperationalAlertContext,
): Promise<boolean> {
  const safeMessage = scrubSecrets(message, { preserveNewlines: true });
  const safeContext = redactSensitiveValue(context, { preserveNewlines: true }) as OperationalAlertContext;
  const action = await prisma.$transaction((tx) => reportOperationalActionTx(
    tx, operationalAlertInput(safeMessage, safeContext),
  ));
  // Uma ação aberta prova a condição, não a entrega. O ciclo distingue uma
  // reabertura mesmo que o Telegram ainda esteja no silêncio da anterior.
  const receiptId = `ops-alert-once:${action.id}:${action.reopenCount}`;
  if (await prisma.auditEvent.findUnique({ where: { id: receiptId }, select: { id: true } })) return true;
  const status = await deliverOperatorMessage(safeMessage, { fingerprint: receiptId });
  if (status !== "delivered" && status !== "deduplicated") return false;
  await prisma.auditEvent.upsert({
    where: { id: receiptId },
    create: { id: receiptId, action: "ops.alert_once_delivered", resource: "operational_action",
      resourceId: action.id, details: { cycle: action.reopenCount } },
    update: {},
  });
  return true;
}

/** Atualiza o inbox sem furar o throttle nem emitir uma nova notificação. */
export async function persistOperationalAlert(
  message: string,
  context: OperationalAlertContext,
  options: { incrementOccurrence?: boolean; client?: Prisma.TransactionClient } = {},
): Promise<void> {
  const safeMessage = scrubSecrets(message, { preserveNewlines: true });
  // Título e evidência vão para colunas do banco, como a mensagem: sem a
  // opção, a quebra de linha virava "\n" literal na Caixa de ações. A chave
  // passa pela mesma limpeza nas três leituras do contexto, para a impressão
  // digital da ação não mudar entre elas.
  const safeContext = redactSensitiveValue(context, { preserveNewlines: true }) as OperationalAlertContext;
  const now = new Date();
  const input = { ...operationalAlertInput(safeMessage, safeContext), incrementOccurrence: options.incrementOccurrence };
  if (options.client) await reportOperationalActionTx(options.client, input, now);
  else await reportOperationalAction(input, now);
}

function operationalAlertInput(
  message: string,
  context: OperationalAlertContext,
): ReportOperationalActionInput {
  const risk = context.risk ?? OperationalRisk.MEDIUM;
  return {
    source: context.source,
    key: context.key,
    area: "incidentes",
    actionType: "incident.review",
    title: context.title,
    description: message,
    priority: priorityForRisk(risk),
    risk,
    resource: context.resource,
    resourceId: context.resourceId,
    evidence: { message: message.slice(0, 2_000), ...(context.evidence ?? {}) },
    autoResolve: context.autoResolve ?? true,
  };
}

/** Entrega best-effort depois do commit; a ação já está durável no banco. */
export async function notifyPersistedOperationalAlert(
  message: string,
  context: OperationalAlertContext,
): Promise<boolean> {
  const safeMessage = scrubSecrets(message, { preserveNewlines: true });
  const safeContext = redactSensitiveValue(context, { preserveNewlines: true }) as OperationalAlertContext;
  const status = await deliverOperatorMessage(safeMessage, {
    fingerprint: getOperationalAlertFingerprint(safeContext),
    provider: providerDeclarado(safeContext),
  });
  return status === "delivered" || status === "deduplicated";
}
