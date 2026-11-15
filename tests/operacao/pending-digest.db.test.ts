import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { sendPendingDigest } from "@/src/services/ops/digests/pending-digest";

const notifications = vi.hoisted(() => ({ send: vi.fn<typeof import("@/src/services/ops/alerts").sendRequiredOperatorNotification>() }));
vi.mock("@/src/services/ops/alerts", () => ({ sendRequiredOperatorNotification: notifications.send }));
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
beforeEach(async () => { await db.reset(); notifications.send.mockReset().mockResolvedValue("delivered"); });
afterAll(async () => { await db.dispose(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetEnvCacheForTests(); });

it("separa tipsters homônimos e aplica o limite de linhas em cada um", async () => {
  const now = new Date("2026-09-23T22:00:00Z");
  for (const slug of ["alfa", "alfa-2"]) {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Alfa", slug } });
    await db.prisma.bet.createMany({ data: Array.from({ length: 26 }, () => ({
      bankrollId: bank.id, data: new Date("2026-09-23T12:00:00Z"), evento: "A vs B", esporte: "Soccer",
      mercado: "ML", selecao: "A", stake: 1, odds: 2, sportResolvedAt: now,
    })) });
  }
  expect(await sendPendingDigest(now)).toEqual({ pendentes: 52 });
  const text = notifications.send.mock.calls[0]![0];
  expect(text).toContain("📁 Alfa (alfa) (26)");
  expect(text).toContain("📁 Alfa (alfa-2) (26)");
  expect(text.split("… e mais 1.")).toHaveLength(3);
  expect(Array.from(text).length).toBeLessThanOrEqual(3900);
});

it("a retentativa do mesmo dia não duplica o digest de pendentes com números novos", async () => {
  const actual = await vi.importActual<typeof import("@/src/services/ops/alerts")>("@/src/services/ops/alerts");
  notifications.send.mockImplementation(actual.sendRequiredOperatorNotification);
  vi.stubEnv("TELEGRAM_NOTIFICATION_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_NOTIFICATION_CHAT_ID", "123");
  resetEnvCacheForTests();
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const now = new Date("2026-09-24T15:00:00Z");
  const bank = await db.prisma.bankroll.create({ data: { nome: "Alfa", slug: "alfa" } });
  const addBet = () => db.prisma.bet.create({ data: { bankrollId: bank.id, data: new Date("2026-09-23T18:00:00Z"), evento: "A vs B", esporte: "Soccer", mercado: "ML", selecao: "A", stake: 1, odds: 2, sportResolvedAt: now } });
  await addBet();
  await sendPendingDigest(now);
  await addBet();
  await sendPendingDigest(new Date(now.getTime() + 300_000));
  expect(fetchMock).toHaveBeenCalledOnce();
  await sendPendingDigest(new Date(now.getTime() + 86_400_000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
