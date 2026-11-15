import { prisma } from "@/src/infra/prisma";
import type { Prisma } from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";
import { priceArchiveConfig, ARCHIVE_MAX_OBSERVATIONS } from "./config";
import { packPriceResponse, type ArchivedPriceEnvelope } from "./codec";

const log = createLogger("price-archive");
async function lockPriceArchive(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('price-response-archive-v1', 0))`;
}
async function trimArchive(tx: Prisma.TransactionClient, now: Date, incoming = 0) {
  const config = priceArchiveConfig();
  // Limita cada transação; pendências de purga continuam na próxima manutenção.
  const expired = await tx.priceArchiveObservation.findMany({ where: { OR: [{ expiresAt: { lte: now } },
    { observedAt: { lte: new Date(now.getTime() - config.retentionMs) } }] }, select: { id: true }, take: 500 });
  if (expired.length) await tx.priceArchiveObservation.deleteMany({ where: { id: { in: expired.map((r) => r.id) } } });
  let usage = await tx.priceArchiveUsage.findUniqueOrThrow({ where: { id: 1 } });
  if (Number(usage.bytes) + incoming > config.maxBytes || usage.observations >= ARCHIVE_MAX_OBSERVATIONS) {
    const oldest = await tx.priceArchiveObservation.findMany({ orderBy: [{ observedAt: "asc" }, { id: "asc" }],
      select: { id: true, payloadBytes: true }, take: 500 });
    let bytes = Number(usage.bytes), count = usage.observations; const ids: string[] = [];
    for (const row of oldest) {
      if (bytes + incoming <= config.maxBytes && count < ARCHIVE_MAX_OBSERVATIONS) break;
      ids.push(row.id); bytes -= row.payloadBytes; count--;
    }
    if (ids.length) await tx.priceArchiveObservation.deleteMany({ where: { id: { in: ids } } });
    usage = await tx.priceArchiveUsage.findUniqueOrThrow({ where: { id: 1 } });
  }
  return usage;
}
/** Falha no arquivo não repete HTTP nem impede o fluxo de preço já existente. */
export async function archivePriceResponse(envelope: ArchivedPriceEnvelope, secrets: readonly string[] = []): Promise<string | null> {
  const config = priceArchiveConfig(); if (!config.enabled) return null;
  try {
    const packed = await packPriceResponse(envelope, secrets); if (!packed || packed.payloadBytes > config.maxBytes) return null;
    const observedAt = new Date(envelope.observedAt), now = new Date();
    if (observedAt > now || now.getTime() - observedAt.getTime() > config.retentionMs) return null;
    return await prisma.$transaction(async (tx) => {
      await lockPriceArchive(tx);
      const usage = await trimArchive(tx, now, packed.payloadBytes);
      if (Number(usage.bytes) + packed.payloadBytes > config.maxBytes || usage.observations >= ARCHIVE_MAX_OBSERVATIONS) return null;
      const row = await tx.priceArchiveObservation.create({ data: { ...packed, provider: envelope.provider,
        endpoint: envelope.endpoint, eventIds: envelope.eventIds, requestedAt: new Date(envelope.requestedAt), observedAt,
        expiresAt: new Date(observedAt.getTime() + config.retentionMs) }, select: { id: true } });
      return row.id;
    }, { timeout: 10_000 });
  } catch (error) {
    log.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "resposta de preço não arquivada; cotação atual preservada");
    return null;
  }
}
export async function purgePriceArchive(now = new Date()) {
  return prisma.$transaction(async (tx) => {
    await lockPriceArchive(tx);
    const usage = await trimArchive(tx, now);
    return { enabled: priceArchiveConfig().enabled, bytes: Number(usage.bytes), observations: usage.observations };
  }, { timeout: 10_000 });
}
