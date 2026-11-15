import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

const effects = vi.hoisted(() => ({ enqueue: vi.fn().mockResolvedValue("job") }));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => ({}) }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ enqueueSharpEnrich: effects.enqueue, cancelPendingSharpEnrich: vi.fn() }));
import { registerManualBet } from "@/src/services/bets/manual";
import { softDeleteBet } from "@/src/services/bets/remove";

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); vi.clearAllMocks(); });

it.each(["editada", "removida"])("reenvio do formulário não recria aposta manual %s", async (change) => {
  const bank = await db.prisma.bankroll.create({ data: { nome: "Teste", slug: "teste" } });
  const input = { home: "Flamengo", away: "Palmeiras", date: "2026-10-10", time: "15:00",
    market: "Moneyline", line: "Flamengo", odds: 2, stake: 1 };
  const requestId = randomUUID();
  const original = await registerManualBet(bank.id, input, "test", requestId);
  expect(original.created).toBe(true);
  if (change === "removida") await softDeleteBet({ betId: original.betId, actor: "test", motivo: "teste", origin: "painel" }, { deferEffects: true });
  else await db.prisma.bet.update({ where: { id: original.betId }, data: { odds: 3 } });
  const replay = await registerManualBet(bank.id, input, "test", requestId);
  expect(replay).toMatchObject({ created: false, betId: original.betId, duplicateWasDeleted: change === "removida" });
  expect(await db.prisma.bet.count()).toBe(1);
  expect(effects.enqueue).toHaveBeenCalledOnce();
});

it("formulário corrigido depois de um 'já cadastrada' registra a aposta nova, e o reenvio idêntico continua idempotente", async () => {
  const bank = await db.prisma.bankroll.create({ data: { nome: "Teste", slug: "teste" } });
  const input = { home: "Flamengo", away: "Palmeiras", date: "2026-10-10", time: "15:00",
    market: "Moneyline", line: "Flamengo", odds: 2, stake: 1 };
  const existing = await registerManualBet(bank.id, input, "test", randomUUID());
  const requestId = randomUUID();
  expect(await registerManualBet(bank.id, input, "test", requestId))
    .toMatchObject({ created: false, betId: existing.betId });
  const corrected = await registerManualBet(bank.id, { ...input, odds: 2.1 }, "test", requestId);
  expect(corrected.created).toBe(true);
  expect(corrected.betId).not.toBe(existing.betId);
  expect(await registerManualBet(bank.id, { ...input, odds: "2,10" }, "test", requestId))
    .toMatchObject({ created: false, betId: corrected.betId });
  expect(await db.prisma.bet.count()).toBe(2);
});
