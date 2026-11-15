import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { awaitProviderCadence } from "@/src/providers/request-cadence";
import { readProviderCache, writeProviderCache } from "@/src/providers/provider-cache";

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
});

describe("estado compartilhado de provider", () => {
  it("devolve espera longa ao job sem ocupar um slot nem empurrar o gate", async () => {
    const nextAllowedAt = new Date(Date.now() + 60_000);
    await db.prisma.providerRequestGate.create({ data: { provider: "bridgeodds", route: "global", nextAllowedAt } });
    await expect(awaitProviderCadence({ provider: "bridgeodds", route: "global", cooldownMs: 40_000, deadlineMs: Date.now() + 5_000 }))
      .rejects.toMatchObject({ name: "ProviderCadenceDeferredError", retryAt: nextAllowedAt });
    const gate = await db.prisma.providerRequestGate.findUniqueOrThrow({ where: { provider_route: { provider: "bridgeodds", route: "global" } } });
    expect(gate.nextAllowedAt).toEqual(nextAllowedAt);
  });
  it("serializa cooldown concorrente no gate persistente", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await Promise.all(Array.from({ length: 5 }, () => awaitProviderCadence({
      provider: "pinnacle17",
      route: "fixture",
      cooldownMs: 500,
      now: () => now,
    })));
    const gate = await db.prisma.providerRequestGate.findUniqueOrThrow({
      where: { provider_route: { provider: "pinnacle17", route: "fixture" } },
    });
    expect(gate.nextAllowedAt).toEqual(new Date("2026-01-01T00:00:02.500Z"));
  });

  it("serve versão stale explicitamente sem confundi-la com cache fresco", async () => {
    const writtenAt = new Date("2026-08-01T00:00:00Z");
    await writeProviderCache({
      provider: "pinnacle17",
      key: "markets:supported:v1",
      data: [{ marketId: 1 }],
      ttlMs: 1_000,
      now: writtenAt,
    });
    const afterExpiry = new Date("2026-08-01T00:00:02Z");
    await expect(readProviderCache({
      provider: "pinnacle17",
      key: "markets:supported:v1",
      now: afterExpiry,
    })).resolves.toBeNull();
    await expect(readProviderCache<{ marketId: number }[]>({
      provider: "pinnacle17",
      key: "markets:supported:v1",
      allowStale: true,
      now: afterExpiry,
    })).resolves.toEqual({
      data: [{ marketId: 1 }],
      stale: true,
      fetchedAt: writtenAt,
      expiresAt: new Date("2026-08-01T00:00:01Z"),
    });
  });
});
