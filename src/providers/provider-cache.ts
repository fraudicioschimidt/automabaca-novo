import type { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";

export async function readProviderCache<T>(params: {
  provider: string;
  key: string;
  allowStale?: boolean;
  now?: Date;
}): Promise<{ data: T; stale: boolean; fetchedAt: Date; expiresAt: Date } | null> {
  const row = await prisma.providerCache.findUnique({
    where: { provider_key: { provider: params.provider, key: params.key } },
  });
  if (!row) return null;
  const stale = row.expiresAt <= (params.now ?? new Date());
  if (stale && !params.allowStale) return null;
  return {
    data: row.payload as T,
    stale,
    fetchedAt: row.fetchedAt,
    expiresAt: row.expiresAt,
  };
}

export async function writeProviderCache(params: {
  provider: string;
  key: string;
  data: Prisma.InputJsonValue;
  ttlMs: number;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + params.ttlMs);
  await prisma.providerCache.upsert({
    where: { provider_key: { provider: params.provider, key: params.key } },
    create: {
      provider: params.provider,
      key: params.key,
      payload: params.data,
      fetchedAt: now,
      expiresAt,
    },
    update: { payload: params.data, fetchedAt: now, expiresAt },
  });
}

export async function deleteProviderCache(params: {
  provider: string;
  keyPrefix?: string;
}): Promise<void> {
  await prisma.providerCache.deleteMany({
    where: {
      provider: params.provider,
      ...(params.keyPrefix ? { key: { startsWith: params.keyPrefix } } : {}),
    },
  });
}
