const UNSAFE_PATH = /[\\\u0000-\u001f\u007f]|%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/i;

/** Retorno pós-login estritamente relativo ao mesmo host. */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || UNSAFE_PATH.test(value)) {
    return null;
  }
  return value;
}
