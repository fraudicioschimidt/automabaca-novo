const REDACTED = "[redacted]";

const SENSITIVE_KEYS = new Set([
  "apikey",
  "authorization",
  "bearer",
  "bottoken",
  "connectionstring",
  "cookie",
  "databaseurl",
  "password",
  "passwd",
  "secret",
  "senha",
  "sessioncookie",
  "setcookie",
  "token",
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * "Key" só é segredo quando o nome diz de quê: credencial (`apiKey`,
 * `privateKey`, `signingKey`…) ou a chave de um serviço (`geminiKey`). Sozinho
 * ou depois de outra palavra (`cacheKey`, `dayKey`, `singletonKey`) é chave
 * operacional, que o log e a auditoria precisam mostrar.
 */
const SECRET_KEY_NAME = new RegExp(
  "(api|secret|private|access|auth|signing|encryption|master|license|hmac|ssh|credential|session|client|service"
    + "|gemini|groq|mistral|openai|flashscore|pinnacle|pinnacle17|bridgeodds|rapidapi|telegram|webhook)keys?$",
);

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SENSITIVE_KEYS.has(normalized)) return true;
  if (SECRET_KEY_NAME.test(normalized)) return true;
  return ["password", "passwd", "secret", "senha", "token", "cookie"]
    .some((suffix) => normalized.endsWith(suffix));
}

/** Remove segredo embutido sem transformar texto operacional comum em segredo. */
export function scrubSecrets<T>(value: T, options: { preserveNewlines?: boolean } = {}): T {
  if (typeof value !== "string") return value;
  return value
    // Mensagens interpoladas (%j/%o) podem conter chaves/valores entre aspas,
    // inclusive espaços e escapes. Remova o valor inteiro antes das regras
    // para atribuições sem aspas; só o formatter de objetos não cobre isso.
    .replace(/\b([a-z0-9_-]*(?:api[_-]?key|password|passwd|senha|token|secret|cookie)|authorization)\s*["']?\s*[=:]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
      `$1=${REDACTED}`)
    // A URL PostgreSQL inteira é credencial/infra: host e database também não
    // pertencem a alerta, auditoria, métrica ou mensagem ao Telegram.
    .replace(/\b(postgres(?:ql)?):\/\/[^\s"'`,)]+/gi, `$1://${REDACTED}`)
    // Credenciais em outros esquemas preservam só o destino técnico.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^:@\s/]+:[^@\s/]+@/gi, `$1${REDACTED}@`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `Bearer ${REDACTED}`)
    .replace(/([?&](?:key|api[_-]?key|access[_-]?token|token|secret|password)=)[^&\s#]+/gi,
      `$1${REDACTED}`)
    .replace(/\/bot\d{6,}:[A-Za-z0-9_-]{8,}/g, `/bot${REDACTED}`)
    .replace(/\bcookie\s*=\s*("?)[^\s&"'`,)]+\1/gi, `cookie=${REDACTED}`)
    .replace(/\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, `$1: ${REDACTED}`)
    .replace(/\b([a-z0-9_-]*(?:api[_-]?key|password|passwd|senha|token|secret|cookie)|authorization)(\s*[=:]\s*)("?)[^\s&"'`,)]+\3/gi,
      `$1$2${REDACTED}`)
    // Framing NDJSON fica por último para as regras de header ainda enxergarem
    // a quebra real e não consumirem a mensagem seguinte.
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\r\n|\r|\n/g, options.preserveNewlines ? "\n" : "\\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, " ") as T;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Scrub recursivo para fronteiras de observabilidade. Preserva Date, Decimal,
 * Buffer e demais objetos de domínio; os sinks só precisam percorrer JSON.
 * `preserveNewlines` vale para o que é gravado em coluna do banco, onde a
 * quebra real não é framing e o painel a mostra.
 */
export function redactSensitiveValue<T>(value: T, options: { preserveNewlines?: boolean } = {}): T {
  return redactNested(value, options, 0);
}

function redactNested<T>(value: T, options: { preserveNewlines?: boolean }, depth: number): T {
  if (typeof value === "string") return scrubSecrets(value, options);
  if (value === null || typeof value !== "object") return value;
  // Limite é minimização fail-closed: estrutura hostil não ganha um caminho
  // para esconder segredo abaixo do teto de recursão.
  if (depth >= 12) return REDACTED as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactNested(item, options, depth + 1)) as T;
  }
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key)
      ? REDACTED
      : redactNested(nested, options, depth + 1);
  }
  return out as T;
}
