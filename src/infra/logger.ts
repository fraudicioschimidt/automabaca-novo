import { pino } from "pino";
import { getObservabilityContext } from "@/src/infra/observability-store";
import {
  isSensitiveKey,
  redactSensitiveValue,
  scrubSecrets,
} from "@/src/infra/redaction";

/**
 * Logger estruturado único do projeto. Lê process.env direto (sem passar pela
 * validação de env) para ser utilizável em qualquer contexto, inclusive no
 * próprio erro de validação de ambiente.
 */
const isDev = process.env.NODE_ENV === "development";

function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  const value = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const pickPrimitive = (key: string) => {
    const candidate = value[key];
    return typeof candidate === "string" || typeof candidate === "number"
      ? candidate
      : undefined;
  };
  return {
    // O formatter de log pode materializar o Error antes do serializer. Nesse
    // caso `type` já contém o nome original e deve sobreviver à segunda passada.
    type:
      error instanceof Error
        ? error.name
        : pickPrimitive("type") ?? pickPrimitive("name") ?? typeof error,
    message: scrubSecrets(
      error instanceof Error ? error.message : pickPrimitive("message") ?? String(error),
    ),
    stack: scrubSecrets(error instanceof Error ? error.stack : pickPrimitive("stack")),
    code: pickPrimitive("code"),
    status: pickPrimitive("status") ?? pickPrimitive("statusCode"),
    errno: pickPrimitive("errno"),
    syscall: pickPrimitive("syscall"),
    digest: pickPrimitive("digest"),
    clientVersion: pickPrimitive("clientVersion"),
    statusText: pickPrimitive("statusText"),
    // `cause` é como o undici/fetch encadeia a causa raiz, e os providers daqui
    // usam `new Error(msg, { cause })`. Profundidade 3 evita ciclo.
    ...(depth < 3 && value["cause"] !== undefined
      ? { cause: serializeError(value["cause"], depth + 1) }
      : {}),
    ...(depth < 3 && Array.isArray(value["errors"])
      ? {
          errors: (value["errors"] as unknown[])
            .slice(0, 5)
            .map((nested) => serializeError(nested, depth + 1)),
        }
      : {}),
    // Extração segura de metadados do Prisma (ex.: { target: ['field'], modelName: 'Bet' })
    ...(depth < 3 && value["meta"] !== undefined && typeof value["meta"] === "object" && value["meta"] !== null
      ? { meta: scrubLogValues(value["meta"], depth + 1) as Record<string, unknown> }
      : {}),
    // Extração segura de issues do Zod (ex.: ZodError.issues)
    ...(depth < 3 && Array.isArray(value["issues"])
      ? {
          issues: (value["issues"] as unknown[])
            .slice(0, 10)
            .map((issue) => scrubLogValues(issue, depth + 1)),
        }
      : {}),
  };
}

/**
 * O `redact` do pino cobre CHAVES nomeadas (`token`, `*.url`), não o CONTEÚDO de
 * strings — e mensagem de erro de infra carrega credencial embutida:
 * `ConnectETIMEDOUT postgresql://user:senha@host`, URL de provider com
 * `?apiKey=`.
 */
/** Aplica `scrubSecrets` em toda string do record (profundidade limitada). */
function scrubLogValues(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubSecrets(value);
  // Pino executa o formatter antes dos serializers. Materializar Error por
  // Object.entries perderia name/message/stack, que não são enumeráveis.
  if (value instanceof Error) return serializeError(value, depth);
  if (depth >= 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubLogValues(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? "[redacted]" : scrubLogValues(nested, depth + 1);
  }
  return redactSensitiveValue(out);
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service: "automabaca",
    process: process.env.AUTOMABACA_PROCESS ?? "unknown",
    releaseSha: process.env.AUTOMABACA_RELEASE_SHA ?? "development",
    releaseId: process.env.AUTOMABACA_RELEASE_ID ?? "development",
  },
  // CÓPIA, nunca o objeto vivo: o merge padrão do pino é
  // `Object.assign(resultadoDoMixin, camposLogados)`, que ESCREVE dentro do
  // que o mixin devolve. Com o contexto por referência, cada campo logado
  // ficava soldado nele e voltava em todas as linhas seguintes do mesmo job.
  mixin: () => ({ ...getObservabilityContext() }),
  // Pino aplica este serializer DEPOIS de interpolar a mensagem. O formatter
  // de objetos não recebe o segundo argumento de log.info(obj, mensagem).
  serializers: { err: serializeError, msg: scrubSecrets },
  // `serializers.err` só alcança o campo `err`. Todo o RESTO do objeto logado
  // (resposta de provider, texto de update do Telegram) ia cru — inclusive com
  // quebra de linha, que rompe o framing NDJSON, e com credencial em texto
  // livre. O formatter passa cada string do record pelo mesmo scrub.
  formatters: { log: (obj) => scrubLogValues(obj) as Record<string, unknown> },
  redact: {
    // Profundidade 1 e 2 — segredos costumam aninhar (ex.: { req: { headers:
    // { authorization } } }, { conta: { token } }). Inclui variantes snake_case
    // e nomes específicos do projeto (gemini, bearer, hash de senha, sessão).
    paths: [
      "password",
      "senha",
      "token",
      "secret",
      "apiKey",
      "api_key",
      "authorization",
      "cookie",
      "*.password",
      "*.senha",
      "*.token",
      "*.secret",
      "*.apiKey",
      "*.api_key",
      "url",
      "*.url",
      "*.*.apiKey",
      "*.*.api_key",
      "*.*.authorization",
      "*.*.cookie",
      // Profundidades 2 e 3 fecham o padrão
      // `{ evidence: { payload: { auth: { token } } } }` que os alertas usam.
      "*.*.password",
      "*.*.senha",
      "*.*.token",
      "*.*.secret",
      "*.*.url",
      "*.*.*.password",
      "*.*.*.senha",
      "*.*.*.token",
      "*.*.*.secret",
      "*.*.*.apiKey",
      "*.*.*.authorization",
      "req.headers.authorization",
      "req.headers.cookie",
      "err.config.url",
      "err.requestUrl",
      "ip",
      "*.ip",
      "*.*.ip",
      "remoteAddress",
      "*.remoteAddress",
      "username",
      "*.username",
      "*.*.username",
      "chatId",
      "*.chatId",
      "*.*.chatId",
      "actor",
      "*.actor",
      "*.*.actor",
    ],
    censor: "[redacted]",
  },
  transport: isDev
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
    : undefined,
});

export function createLogger(mod: string) {
  return logger.child({ mod });
}
