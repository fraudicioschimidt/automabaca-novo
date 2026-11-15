import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { hasFreshBridgeMiss, rememberBridgeMiss } from "@/src/providers/bridgeodds/match";

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

describe("debounce compartilhado de miss BridgeOdds", () => {
  it("reutiliza no-results, mas uma tradução de alias diferente abre nova busca", async () => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    const base = {
      home: "Verdão",
      away: "Santos",
      sport: "Futebol",
      kickoffUtc: new Date("2026-08-24T18:00:00.000Z"),
      now,
    };
    await rememberBridgeMiss(base);

    await expect(hasFreshBridgeMiss(base)).resolves.toBe(true);
    await expect(hasFreshBridgeMiss({ ...base, home: "Palmeiras" })).resolves.toBe(false);
    await expect(hasFreshBridgeMiss({
      ...base,
      now: new Date("2026-08-24T12:31:00.000Z"),
    })).resolves.toBe(false);
  });
});
