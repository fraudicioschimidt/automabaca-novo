/** Mensagem curta para alertas humanos, preservando códigos nativos úteis. */
export function errorMessageWithCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof error !== "object" || error === null || !("code" in error)) return message;
  const rawCode = (error as { code?: unknown }).code;
  if (typeof rawCode !== "string" && typeof rawCode !== "number") return message;
  const code = String(rawCode).trim();
  return code && !message.includes(code) ? `${message} (${code})` : message;
}
