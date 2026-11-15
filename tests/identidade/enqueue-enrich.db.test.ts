import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { enqueueSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import { createTestDb, type TestDb } from "../helpers/db";

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

async function seedBet(sharpMode: "CLV_ONLY" | "IDENTITY_ONLY") {
  const bankroll = await db.prisma.bankroll.create({
    data: {
      nome: `B-${sharpMode}`,
      slug: `b-enq-${sharpMode.toLowerCase()}`,
      sharpMode,
    },
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      bankrollId: bankroll.id,
      data: new Date(),
      evento: "Time A vs Time B",
      esporte: "Soccer",
      mercado: "Total",
      selecao: "Under 2.5",
      odds: 1.9,
      stake: 1,
    },
  });
}

describe("enqueueSharpEnrich — retry centralizado no revival", () => {
  it("CLV_ONLY: não duplica a cadência com retry da fila", async () => {
    const bet = await seedBet("CLV_ONLY");
    const boss = {
      send: vi.fn().mockResolvedValue("job-id"),
    } as unknown as PgBoss;

    await enqueueSharpEnrich(boss, bet.id);

    const calls = (boss.send as unknown as Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).not.toHaveProperty("retryLimit");
    expect(calls[0]?.[2]).not.toHaveProperty("retryDelay");
  });

  it("IDENTITY_ONLY: também herda somente falhas técnicas da fila", async () => {
    const bet = await seedBet("IDENTITY_ONLY");
    const boss = {
      send: vi.fn().mockResolvedValue("job-id"),
    } as unknown as PgBoss;

    await enqueueSharpEnrich(boss, bet.id);

    const opts = (boss.send as unknown as Mock).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts.retryLimit).toBeUndefined();
    expect(opts.retryDelay).toBeUndefined();
  });

  it("revive herda a política da fila — sem retryLimit 0", async () => {
    const bet = await seedBet("CLV_ONLY");
    const boss = {
      send: vi.fn().mockResolvedValue("job-id"),
    } as unknown as PgBoss;

    await enqueueSharpEnrich(boss, bet.id, {
      origem: "revive",
      singletonSeconds: 540,
    });

    const opts = (boss.send as unknown as Mock).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts).toMatchObject({ singletonSeconds: 540 });
    expect(opts.retryLimit).toBeUndefined();
    expect(opts.retryDelay).toBeUndefined();
  });
});
