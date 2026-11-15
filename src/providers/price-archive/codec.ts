import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { ARCHIVE_MAX_PAYLOAD_BYTES, ARCHIVE_MAX_UNPACKED_BYTES } from "./config";

const compress = promisify(gzip), decompress = promisify(gunzip);
const envelopeSchema = z.object({ version: z.literal(1),
  provider: z.enum(["pinnacle17", "bridgeodds"]), endpoint: z.string(),
  requestedAt: z.string().datetime(), observedAt: z.string().datetime(),
  eventIds: z.array(z.string().regex(/^\d+$/)).min(1).max(500),
  context: z.record(z.string(), z.unknown()), body: z.unknown() });
export type ArchivedPriceEnvelope = z.infer<typeof envelopeSchema>;
export function archiveHash(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}
export async function packPriceResponse(input: ArchivedPriceEnvelope, secrets: readonly string[] = []) {
  const envelope = envelopeSchema.parse(input);
  if (Date.parse(envelope.requestedAt) > Date.parse(envelope.observedAt)) return null;
  // JSON original completo + contexto. Não é o hash dos bytes HTTP (whitespace).
  const text = JSON.stringify(envelope), raw = Buffer.from(text);
  if (raw.byteLength > ARCHIVE_MAX_UNPACKED_BYTES || secrets.some((s) => s.length >= 4 && text.includes(s))) return null;
  const payload = await compress(raw, { level: 6 });
  if (payload.byteLength > ARCHIVE_MAX_PAYLOAD_BYTES) return null;
  return { payload, payloadBytes: payload.byteLength, unpackedBytes: raw.byteLength, sha256: archiveHash(payload) };
}
export async function unpackPriceResponse(row: {
  payload: Uint8Array; payloadBytes: number; unpackedBytes: number; sha256: string;
  provider: string; endpoint: string; eventIds: string[]; requestedAt: Date; observedAt: Date;
}): Promise<ArchivedPriceEnvelope | null> {
  if (row.payloadBytes !== row.payload.byteLength || row.payloadBytes > ARCHIVE_MAX_PAYLOAD_BYTES
    || row.unpackedBytes > ARCHIVE_MAX_UNPACKED_BYTES || archiveHash(row.payload) !== row.sha256) return null;
  try {
    const raw = await decompress(row.payload, { maxOutputLength: ARCHIVE_MAX_UNPACKED_BYTES });
    if (raw.byteLength !== row.unpackedBytes) return null;
    const e = envelopeSchema.parse(JSON.parse(raw.toString("utf8")));
    if (e.provider !== row.provider || e.endpoint !== row.endpoint
      || e.requestedAt !== row.requestedAt.toISOString() || e.observedAt !== row.observedAt.toISOString()
      || JSON.stringify(e.eventIds) !== JSON.stringify(row.eventIds)) return null;
    return e;
  } catch { return null; }
}
