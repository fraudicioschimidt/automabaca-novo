/**
 * Toda mensagem do Prisma começa com "Invalid `prisma.x()` invocation" (ou
 * `tx.x()`, dentro de transação), e o marcador genérico `"invalid "` abaixo a
 * tomaria por recusa de negócio. O erro do Prisma é classificado pelo código
 * (`prismaFailureClass`); aqui só se tira o cabeçalho para ele não contaminar
 * os marcadores de texto.
 */
const PRISMA_INVOCATION_HEADER = /invalid `[\w$]+(?:\.[\w$]+)+\(\)` invocation:?/gi;

/** Erros de negócio/validação não devem requeue na DLQ. */
export function isBusinessLogicError(msg: string): boolean {
  const normalized = msg.replace(PRISMA_INVOCATION_HEADER, "").toLowerCase();
  return (
    normalized.includes("requirepending") ||
    normalized.includes("betnotpendingerror") ||
    normalized.includes("zod") ||
    normalized.includes("validation") ||
    normalized.includes("invalid ") ||
    normalized.includes("not found") ||
    normalized.includes("unique constraint") ||
    normalized.includes("forbidden") ||
    normalized.includes("unauthorized") ||
    normalized.includes("bloqueado") ||
    normalized.includes("não permitido") ||
    normalized.includes("nao permitido") ||
    normalized.includes("está removida") ||
    normalized.includes("esta removida")
  );
}

const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Códigos do Prisma que dizem "o banco não atendeu agora": conexão, pool,
 * transação expirada, conflito de escrita. O trabalho está intacto.
 */
const PRISMA_TRANSIENT_CODES = new Set([
  "P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2034", "P2037",
]);
/** Violação de unicidade e registro sumido: o dado mudou, repetir não resolve. */
const PRISMA_BUSINESS_CODES = new Set(["P2002", "P2025"]);
/**
 * SQLSTATE do PostgreSQL de falha que passa: cancelamento por
 * `statement_timeout`, banco reiniciando, lock, falta de recurso, conexão,
 * serialização e deadlock. Vale no `code` do erro do driver e no texto que o
 * Prisma repassa quando não tem código próprio, sempre no formato
 * ``Code: `57014` ``: um número solto no meio da mensagem não conta.
 */
const TRANSIENT_SQLSTATE = /^(57014|57p0[1-3]|55p03|40001|40p01|53\d{3}|08\d{3})$/i;
const TRANSIENT_SQLSTATE_IN_MESSAGE = /\bcode:\s*`(57014|57p0[1-3]|55p03|40001|40p01|53\d{3}|08\d{3})`/i;
/** Texto do Prisma e do driver `pg` para conexão, pool e transação que não atenderam. */
const DATABASE_TRANSIENT_MARKERS = [
  "timed out fetching a new connection", "transaction api error", "terminating connection",
  "can't reach database", "server has closed the connection", "connection pool", "connection reset",
  "client has encountered a connection error", "connection terminated",
  "timeout exceeded when trying to connect",
];

function isPrismaFailure(name: string, code: string | undefined, message: string): boolean {
  return name.startsWith("PrismaClient")
    || (code !== undefined && /^P\d{4}$/.test(code))
    || /^\s*invalid `[\w$]+(?:\.[\w$]+)+\(\)` invocation/i.test(message);
}

function isTransientDatabaseText(code: string | undefined, message: string): boolean {
  if (code !== undefined && TRANSIENT_SQLSTATE.test(code)) return true;
  const normalized = message.toLowerCase();
  return TRANSIENT_SQLSTATE_IN_MESSAGE.test(normalized)
    || DATABASE_TRANSIENT_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Falha do banco (Prisma, SQLSTATE do PostgreSQL ou driver `pg`), passageira
 * ou não. Quem mede a fila precisa separar isto da espera esperada de um
 * provider: o banco que não atende é erro, mesmo quando a retentativa resolve.
 */
export function isDatabaseFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return typeof err === "string" && (isPrismaFailure("", undefined, err) || isTransientDatabaseText(undefined, err));
  }
  const value = err as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof value.name === "string" ? value.name : "";
  const message = typeof value.message === "string" ? value.message : "";
  const code = typeof value.code === "string" ? value.code : undefined;
  return isPrismaFailure(name, code, message) || isTransientDatabaseText(code, message);
}

/**
 * Erro do Prisma pelo código, não pelo texto: quase todo é falha de banco ou de
 * schema, e só a unicidade e o registro sumido são recusa do dado. Schema
 * divergente (coluna inexistente, valor de enum removido) é `other`: não se
 * resolve sozinho com requeue e precisa de alguém olhar.
 */
function prismaFailureClass(name: string, code: string | undefined, message: string): "transient" | "business" | "other" {
  if (code && PRISMA_TRANSIENT_CODES.has(code)) return "transient";
  if (code && PRISMA_BUSINESS_CODES.has(code)) return "business";
  if (name === "PrismaClientInitializationError") return "transient";
  if (isTransientDatabaseText(undefined, message)) return "transient";
  return "other";
}

/** Classifica Error, payload tipado ou mensagem legada retida pelo pg-boss. */
export function classifyDlqError(err: unknown): "transient" | "business" | "other" {
  if (err == null) return "other";
  if (typeof err === "object") {
    const value = err as { name?: unknown; status?: unknown; message?: unknown; businessRefusal?: unknown; code?: unknown };
    const name = typeof value.name === "string" ? value.name : "";
    const status = typeof value.status === "number" ? value.status : undefined;
    const message = typeof value.message === "string" ? value.message : "";
    const code = typeof value.code === "string" ? value.code : undefined;
    if (isPrismaFailure(name, code, message)) return prismaFailureClass(name, code, message);
    if (isTransientDatabaseText(code, message)) return "transient";
    // Vem antes da recusa de negócio: SportNotConfirmedError é uma recusa que
    // se resolve sozinha quando o esporte for confirmado.
    if (
      name === "SportNotConfirmedError" ||
      name === "PrePinnacleRetryError" ||
      name === "TelegramParseRetryError"
    ) return "transient";
    if (
      value.businessRefusal === true ||
      name === "RecusaDeNegocioError" ||
      name === "BetNotPendingError" ||
      name === "BetRemovedError" ||
      name === "ZodError" ||
      name === "ContaIndisponivelError" ||
      (message && isBusinessLogicError(message))
    ) return "business";
    if (name === "CircuitOpenError") return "transient";
    if (name === "ProviderRequestError" && status != null && TRANSIENT_HTTP_STATUSES.has(status)) {
      return "transient";
    }
    if (message && isTransientDlqError(message)) return "transient";
    return "other";
  }
  if (typeof err === "string") {
    if (isPrismaFailure("", undefined, err)) return prismaFailureClass("", undefined, err);
    if (isTransientDatabaseText(undefined, err)) return "transient";
    if (isBusinessLogicError(err)) return "business";
    if (isTransientDlqError(err)) return "transient";
  }
  return "other";
}

/** 429 / breaker / rede / 5xx recebem requeue controlado. */
export function isTransientDlqError(msg: string): boolean {
  if (!msg || isBusinessLogicError(msg)) return false;
  const normalized = msg.toLowerCase();
  return [
    "ainda não possui esporte confirmado", "ainda nao possui esporte confirmado",
    "timeout", "fetch failed", "bad gateway", "service unavailable", "socket hang up",
    "502", "503", "504", "429", "too many requests", "rate limit", "ratelimit",
    "circuit breaker aberto", "circuitopenerror", "connection refused", "econnrefused",
    "etimedout",
    // Vocabulário do PRÓPRIO pg-boss (`manager.js`): o timer do worker vivo
    // reprovando o handler que passou do prazo da fila, o supervisor expirando
    // o job que ninguém reprovou (processo morto) e o drain do reload. O
    // trabalho está intacto; só a execução saiu. `"timeout"` acima NÃO cobre
    // nenhuma das duas primeiras grafias; sem estas, o job ficaria retido
    // para replay MANUAL.
    "handler execution exceeded", "timed out", "pg-boss shut down",
  ].some((marker) => normalized.includes(marker));
}

export function extractDlqErrorPayload(output: unknown): {
  message: string;
  name?: string;
  code?: string;
  status?: number;
  businessRefusal?: boolean;
  waitsFor?: string;
} {
  if (!output) return { message: "" };
  if (typeof output === "string") return { message: output };
  if (typeof output === "object" && output !== null) {
    const value = output as { message?: unknown; name?: unknown; code?: unknown; status?: unknown; businessRefusal?: unknown; waitsFor?: unknown };
    let message: string;
    if (typeof value.message === "string") message = value.message;
    else {
      try {
        message = JSON.stringify(output);
      } catch {
        message = String(output);
      }
    }
    return {
      message,
      name: typeof value.name === "string" ? value.name : undefined,
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      status: typeof value.status === "number" ? value.status : undefined,
      ...(value.businessRefusal === true ? { businessRefusal: true } : {}),
      ...(typeof value.waitsFor === "string" && value.waitsFor.trim() ? { waitsFor: value.waitsFor.trim().slice(0, 120) } : {}),
    };
  }
  return { message: String(output) };
}

/**
 * O que dizer ao dono sobre uma dead-letter retida: se o replay resolve, e
 * quando. A recusa de negócio que espera algo (`waitsFor`) volta a valer depois
 * disso; a definitiva só depois de o dado mudar. Com post do Telegram por trás,
 * o caminho mais curto costuma ser registrar a aposta à mão.
 */
export function deadLetterGuidance(params: {
  dlqClass: string | null;
  waitsFor: string | null;
  hasPost: boolean;
}): { status: string; nextStep: string } {
  const { dlqClass, waitsFor, hasPost } = params;
  if (dlqClass === "business" && waitsFor) {
    return {
      status: `A regra recusou por enquanto: isso se resolve quando ${waitsFor}. Reprocessar antes disso falha de novo.`,
      nextStep: `Quando ${waitsFor}, reprocesse em Monitoramento${hasPost ? " para o post entrar" : ""}; se não vale mais, descarte a falha.`,
    };
  }
  if (dlqClass === "business") {
    return {
      status: "A regra recusou o trabalho; o replay falha de novo enquanto o dado não mudar.",
      nextStep: hasPost
        ? "Se o post era aposta, registre-a à mão e descarte a falha em Monitoramento."
        : "Corrija o dado e reprocesse em Monitoramento, ou descarte a falha.",
    };
  }
  return {
    status: "A falha ficou guardada até revisão e preview do replay.",
    nextStep: hasPost
      ? "Se o post era aposta, registre-a à mão; depois reprocesse ou descarte a falha em Monitoramento."
      : "Veja o erro e reprocesse em Monitoramento depois de corrigir a causa.",
  };
}
