import { getEnv } from "@/src/infra/env";

export const ARCHIVE_MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
export const ARCHIVE_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const ARCHIVE_MAX_OBSERVATIONS = 50_000;
export function priceArchiveConfig() {
  const env = getEnv();
  return { enabled: env.PRICE_ARCHIVE_ENABLED === true,
    retentionMs: (env.PRICE_ARCHIVE_RETENTION_DAYS ?? 30) * 86_400_000,
    maxBytes: (env.PRICE_ARCHIVE_MAX_COMPRESSED_MB ?? 256) * 1024 * 1024 };
}
