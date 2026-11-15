import { createHmac } from "node:crypto";

/** Hash estável e não reversível para correlacionar PII sem gravá-la no log. */
export function privacyHash(value: string, namespace = "value"): string {
  const configuredSecret = process.env.LOG_HASH_SECRET;
  if (!configuredSecret && process.env.NODE_ENV === "production") {
    throw new Error("LOG_HASH_SECRET ausente em produção.");
  }
  const secret = configuredSecret ?? "automabaca-local-observability";
  return createHmac("sha256", secret)
    .update(`${namespace}:${value}`)
    .digest("hex")
    .slice(0, 16);
}
