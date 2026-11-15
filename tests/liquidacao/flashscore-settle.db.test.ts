import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bet } from "@/src/generated/prisma/client";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { applyManualBetStatusChangeTx } from "@/src/services/bets/settle";
import { settleFlashscoreBet } from "@/src/services/settlement/flashscore/settle";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => {
  await db.reset();
  vi.stubEnv("TELEGRAM_NOTIFICATION_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_NOTIFICATION_CHAT_ID", "123");
  resetEnvCacheForTests();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetEnvCacheForTests(); });

describe("avisos de liquidação pelo FlashScore", () => {
  it("avisa as duas apostas distintas com resultado idêntico e não repete a liquidação", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const bets: Bet[] = [];
    for (const slug of ["primeiro", "segundo"]) {
      const bankroll = await db.prisma.bankroll.create({ data: { nome: "Mesmo nome", slug } });
      bets.push(await db.prisma.bet.create({ data: {
        bankrollId: bankroll.id, data: new Date("2026-09-24T15:00:00Z"),
        evento: "Casa vs Fora", esporte: "Soccer", mercado: "Moneyline", selecao: "Casa",
        odds: 2, stake: 1, sportResolvedAt: new Date(), sportResolutionStatus: "CONFIRMED",
      } }));
    }
    for (const bet of bets) {
      await expect(settleFlashscoreBet({ bet, status: "WON", label: "2–0" })).resolves.toBe(true);
    }
    expect(await db.prisma.bet.count({ where: { status: "WON", lucro: 1 } })).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(settleFlashscoreBet({ bet: bets[0]!, status: "WON", label: "2–0" })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await db.prisma.$transaction((tx) => applyManualBetStatusChangeTx(tx, {
      betId: bets[0]!.id, newStatus: "PENDING", source: "manual",
    }));
    const reopened = await db.prisma.bet.findUniqueOrThrow({ where: { id: bets[0]!.id } });
    await expect(settleFlashscoreBet({ bet: reopened, status: "WON", label: "2–0" })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
