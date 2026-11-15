import type { Prisma } from "@/src/generated/prisma/client";
import { softDeleteBet, restoreRemovedBet } from "@/src/services/bets/remove";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { createBoss } from "@/src/infra/boss";
import { enrichSingletonKey, QUEUES } from "@/src/infra/queue-contract";
import { ensureQueueWithDeadLetter } from "@/src/jobs/queues";
import { WORKER_JOBS } from "@/src/jobs/worker-jobs";
import {
  CAPTURE_FOLLOWUP_ACTION, dispatchCaptureFollowupAudit, dispatchPendingCaptureFollowups, ensureCaptureFollowups,
} from "@/src/services/scheduling/enqueue-after-capture";
import { registerBet } from "@/src/services/bets/register";
import { reuseSerializableTransaction } from "@/src/services/shared/transaction";
import { prisma } from "@/src/infra/prisma";
import { createTestDb, type TestDb } from "../helpers/db";
import { CHANNEL_ID, seedChannelBankroll } from "../helpers/telegram-channel";

/**
 * A reentrega de um post já capturado refaz a fila que se perdeu entre o
 * commit da aposta e o enfileiramento, e só ela.
 */

let db: TestDb;
let boss: PgBoss;
const SOURCE = `telegram-channel:${CHANNEL_ID}`;

beforeAll(async () => {
  db = createTestDb();
  boss = createBoss();
  await boss.start();
  // As opções REAIS do worker: o banco de teste é compartilhado entre arquivos,
  // e a policy de uma fila não muda depois de criada.
  for (const queue of [QUEUES.sharpEnrich, QUEUES.sportResolve]) {
    await ensureQueueWithDeadLetter(boss, queue, WORKER_JOBS.find((job) => job.queue === queue)?.queueOptions);
  }
});

describe("próximo passo durável da captura", () => {
  async function captured(confirmed = true) {
    const bankroll = await seedChannelBankroll(db);
    return registerBet({
      bankrollId: bankroll.id, data: new Date(Date.now() + 3_600_000), evento: "Time A vs Time B",
      esporte: confirmed ? "Soccer" : "Unknown", sportResolutionStatus: confirmed ? "CONFIRMED" : "PENDING",
      mercado: "Money Line – Match", selecao: "Time A", odds: 2, stake: 1,
      source: `telegram-dm:123:${bankroll.id}`, sourceExternalId: "100", actor: "telegram-dm",
    }, { captureFollowupOrigin: "telegram-dm" });
  }

  it.each([true, false])("retoma depois de commit sem fast-path (esporte confirmado: %s)", async (confirmed) => {
    const saved = await captured(confirmed);
    expect(saved.captureFollowupId).toBeDefined();
    expect(await keys()).toEqual([]);
    expect(await db.prisma.auditEvent.findUniqueOrThrow({ where: { id: saved.captureFollowupId! } }))
      .toMatchObject({ action: CAPTURE_FOLLOWUP_ACTION, outcome: "pending", resourceId: saved.betId });
    expect(await dispatchPendingCaptureFollowups(boss)).toBe(1);
    expect(await keys()).toEqual([confirmed ? enrichSingletonKey(saved.betId) : `sport:${saved.betId}:0`]);
    expect(await dispatchPendingCaptureFollowups(boss)).toBe(0);
  });

  it("aposta e intenção voltam juntas se a transação do registro abortar", async () => {
    const bankroll = await seedChannelBankroll(db);
    await expect(db.prisma.$transaction(async (tx) => {
      const saved = await registerBet({
        bankrollId: bankroll.id, data: new Date(), evento: "Time A vs Time B", esporte: "Soccer",
        mercado: "Money Line – Match", selecao: "Time A", odds: 2, stake: 1,
      }, { client: reuseSerializableTransaction(tx), captureFollowupOrigin: "telegram-capture-fix" });
      expect(await tx.auditEvent.findUnique({ where: { id: saved.captureFollowupId! } })).not.toBeNull();
      throw new Error("abort fixture");
    })).rejects.toThrow("abort fixture");
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await db.prisma.auditEvent.count({ where: { action: CAPTURE_FOLLOWUP_ACTION } })).toBe(0);
  });

  it("relê o esporte confirmado entre o commit e o despacho", async () => {
    const saved = await captured(false);
    await db.prisma.bet.update({ where: { id: saved.betId }, data: { esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date() } });
    await dispatchCaptureFollowupAudit(boss, saved.captureFollowupId!);
    expect(await keys()).toEqual([enrichSingletonKey(saved.betId)]);
  });

  it.each(["deleted", "notTaken", "settled", "manual", "conflict", "off"])("respeita o estado atual %s antes de reenfileirar", async (state) => {
    const saved = await captured();
    if (state === "deleted") await db.prisma.bet.update({ where: { id: saved.betId }, data: { deletedAt: new Date() } });
    if (state === "notTaken") await db.prisma.bet.update({ where: { id: saved.betId }, data: { notTakenAt: new Date() } });
    if (state === "settled") await db.prisma.bet.update({ where: { id: saved.betId }, data: { status: "VOID", lucro: 0, settledAt: new Date() } });
    if (state === "manual") await db.prisma.betSharp.create({ data: { betId: saved.betId, identityStatus: "MANUAL" } });
    if (state === "conflict") await db.prisma.bet.update({ where: { id: saved.betId }, data: { esporte: "Unknown", sportResolutionStatus: "CONFLICT", sportResolvedAt: null } });
    if (state === "off") await db.prisma.bankroll.updateMany({ data: { sharpMode: "OFF" } });
    await dispatchCaptureFollowupAudit(boss, saved.captureFollowupId!);
    expect(await keys()).toEqual([]);
    expect(await db.prisma.auditEvent.findUniqueOrThrow({ where: { id: saved.captureFollowupId! } }))
      .toMatchObject({ outcome: "success", details: { disposition: "skipped" } });
  });

  it("retoma confirmação perdida depois de job já concluído sem repetir o trabalho", async () => {
    const saved = await captured();
    const realTx = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => realTx(async (tx) => {
      const updateSpy = vi.spyOn(tx.auditEvent, "updateMany").mockRejectedValueOnce(new Error("confirmação indisponível"));
      try { return await fn(tx); } finally { updateSpy.mockRestore(); }
    }, options)) as typeof prisma.$transaction);
    try { await expect(dispatchCaptureFollowupAudit(boss, saved.captureFollowupId!)).rejects.toThrow("confirmação indisponível"); }
    finally { spy.mockRestore(); }
    const [job] = await boss.fetch(QUEUES.sharpEnrich);
    await boss.complete(QUEUES.sharpEnrich, job!.id);
    await dispatchCaptureFollowupAudit(boss, saved.captureFollowupId!);
    expect(await keys()).toEqual([enrichSingletonKey(saved.betId)]);
    expect(await db.prisma.auditEvent.findUniqueOrThrow({ where: { id: saved.captureFollowupId! } })).toMatchObject({ outcome: "success" });
  });

  it("não reinicia uma cadeia de esporte que já teve tentativa concluída", async () => {
    const saved = await captured(false);
    await boss.send(QUEUES.sportResolve, { betId: saved.betId, attempt: 8 }, { singletonKey: `sport:${saved.betId}:8` });
    const [job] = await boss.fetch(QUEUES.sportResolve);
    await boss.complete(QUEUES.sportResolve, job!.id);
    await dispatchCaptureFollowupAudit(boss, saved.captureFollowupId!);
    expect(await keys()).toEqual([`sport:${saved.betId}:8`]);
  });

  it("tentativa avulsa de esporte não substitui a cadeia inicial da captura", async () => {
    const saved = await captured(false);
    await boss.send(QUEUES.sportResolve, { betId: saved.betId, attempt: 0, oneShot: true },
      { singletonKey: `sport:${saved.betId}:0:one-shot` });
    await dispatchCaptureFollowupAudit(boss, saved.captureFollowupId!);
    expect(await keys()).toEqual([`sport:${saved.betId}:0`, `sport:${saved.betId}:0:one-shot`]);
  });

  it("send recusado sem job deixa a intenção pendente para nova tentativa", async () => {
    const saved = await captured();
    const rejectedBoss = { send: async () => null } as unknown as PgBoss;
    await expect(dispatchCaptureFollowupAudit(rejectedBoss, saved.captureFollowupId!)).rejects.toThrow("sem job correspondente");
    expect(await db.prisma.auditEvent.findUniqueOrThrow({ where: { id: saved.captureFollowupId! } })).toMatchObject({ outcome: "pending" });
    await dispatchCaptureFollowupAudit(boss, saved.captureFollowupId!);
    expect(await keys()).toHaveLength(1);
  });

  it("dois despachantes do mesmo intent geram só um job", async () => {
    const saved = await captured(false);
    await Promise.all([dispatchCaptureFollowupAudit(boss, saved.captureFollowupId!), dispatchCaptureFollowupAudit(boss, saved.captureFollowupId!)]);
    expect(await keys()).toEqual([`sport:${saved.betId}:0`]);
  });
});

describe("próximo passo durável da restauração", () => {
  async function restored(confirmed = false) {
    const bankroll = await seedChannelBankroll(db);
    const saved = await bet(bankroll.id, "restored", confirmed ? {} : { esporte: "Unknown", sportResolutionStatus: "PENDING", sportResolvedAt: null });
    const queue = confirmed ? QUEUES.sharpEnrich : QUEUES.sportResolve;
    const key = confirmed ? enrichSingletonKey(saved.id) : `sport:${saved.id}:0`;
    const oldId = await boss.send(queue, { betId: saved.id, attempt: 0 }, { singletonKey: key });
    await boss.cancel(queue, oldId!);
    await softDeleteBet({ betId: saved.id, actor: "test", motivo: "removida", origin: "painel" }, { deferEffects: true });
    const result = await restoreRemovedBet({ betId: saved.id, actor: "test", motivo: "restaurada", by: "painel" }, { deferEffects: true });
    return { saved, queue, oldId, auditId: result.captureFollowupId! };
  }

  it.each([false, true])("outbox retoma depois de falha da fila, ignorando cadeia cancelada (confirmado: %s)", async (confirmed) => {
    const { saved, queue, oldId, auditId } = await restored(confirmed);
    const sendSpy = vi.spyOn(boss, "send").mockRejectedValueOnce(new Error("fila indisponível"));
    try { await expect(dispatchCaptureFollowupAudit(boss, auditId)).rejects.toThrow("fila indisponível"); }
    finally { sendSpy.mockRestore(); }
    expect(await db.prisma.auditEvent.findUniqueOrThrow({ where: { id: auditId } })).toMatchObject({ outcome: "pending" });
    expect(await dispatchPendingCaptureFollowups(boss)).toBe(1);
    const [job] = await boss.fetch(queue);
    expect(job!.id).not.toBe(oldId);
    expect(job!.data).toMatchObject({ betId: saved.id });
    await boss.complete(queue, job!.id);
    // Simula perda da confirmação: job concluído com o id deste intent basta.
    await db.prisma.auditEvent.update({ where: { id: auditId }, data: { outcome: "pending" } });
    await dispatchCaptureFollowupAudit(boss, auditId);
    expect(await boss.fetch(queue)).toHaveLength(0);
  });

  it.each(["removed", "settled", "manual", "confirmed"])("relê o estado %s antes de retomar", async (state) => {
    const { saved, auditId } = await restored();
    if (state === "removed") await softDeleteBet({ betId: saved.id, actor: "test", motivo: "nova remoção", origin: "painel" }, { deferEffects: true });
    if (state === "settled") await db.prisma.bet.update({ where: { id: saved.id }, data: { status: "VOID", lucro: 0, settledAt: new Date() } });
    if (state === "manual" || state === "confirmed") await db.prisma.bet.update({ where: { id: saved.id }, data: { esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date() } });
    if (state === "manual") await db.prisma.betSharp.create({ data: { betId: saved.id, identityStatus: "MANUAL" } });
    await dispatchCaptureFollowupAudit(boss, auditId);
    expect(await boss.fetch(QUEUES.sportResolve)).toHaveLength(0);
    expect(await boss.fetch(QUEUES.sharpEnrich)).toHaveLength(state === "confirmed" ? 1 : 0);
    expect(await db.prisma.auditEvent.findUniqueOrThrow({ where: { id: auditId } })).toMatchObject({ outcome: "success" });
  });

  it("nova restauração substitui o intent antigo sem reiniciar duas cadeias", async () => {
    const { saved, auditId } = await restored();
    await softDeleteBet({ betId: saved.id, actor: "test", motivo: "nova remoção", origin: "painel" }, { deferEffects: true });
    const next = await restoreRemovedBet({ betId: saved.id, actor: "test", motivo: "nova volta", by: "painel" }, { deferEffects: true });
    expect(await dispatchCaptureFollowupAudit(boss, auditId)).toBe(false);
    expect(await db.prisma.auditEvent.findUniqueOrThrow({ where: { id: auditId } })).toMatchObject({ outcome: "success" });
    await Promise.all([dispatchCaptureFollowupAudit(boss, next.captureFollowupId!), dispatchCaptureFollowupAudit(boss, next.captureFollowupId!)]);
    expect(await boss.fetch(QUEUES.sportResolve, { batchSize: 10 })).toHaveLength(1);
  });
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  await db.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name IN ('${QUEUES.sharpEnrich}', '${QUEUES.sportResolve}')`);
});

async function bet(bankrollId: string, sourceExternalId: string, patch: Record<string, unknown> = {}) {
  return db.prisma.bet.create({ data: {
    bankrollId, source: SOURCE, sourceExternalId, data: new Date("2026-10-01T18:00:00Z"), evento: `Item ${sourceExternalId}`,
    esporte: "Soccer", mercado: "Money Line – Match", selecao: "Casa", odds: 2, stake: 1, casaDeAposta: "Betano",
    sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), ...patch,
  } });
}

async function keys(): Promise<string[]> {
  const rows = await db.prisma.$queryRaw<Array<{ key: string }>>`
    SELECT singleton_key AS key FROM pgboss.job WHERE name IN (${QUEUES.sharpEnrich}, ${QUEUES.sportResolve}) ORDER BY 1
  `;
  return rows.map((row) => row.key);
}

describe("ensureCaptureFollowups", () => {
  it("enfileira preço e esporte que faltam para todo o lote do post", async () => {
    const bankroll = await seedChannelBankroll(db);
    const confirmed = await bet(bankroll.id, "50:1");
    const pending = await bet(bankroll.id, "50:2", { sportResolutionStatus: "PENDING", sportResolvedAt: null, esporte: "Unknown" });
    await bet(bankroll.id, "500", { sportResolutionStatus: "PENDING", sportResolvedAt: null, esporte: "Unknown" });

    expect(await ensureCaptureFollowups(boss, confirmed.id, "telegram-capture")).toBe(2);
    expect(await keys()).toEqual([enrichSingletonKey(confirmed.id), `sport:${pending.id}:0`].sort());
  });

  it("não repete o que já passou pela fila, nem mexe em aposta não pega, removida ou liquidada", async () => {
    const bankroll = await seedChannelBankroll(db);
    const queued = await bet(bankroll.id, "60:1");
    await boss.send(QUEUES.sharpEnrich, { betId: queued.id }, { singletonKey: enrichSingletonKey(queued.id) });
    const priced = await bet(bankroll.id, "60:2");
    await db.prisma.betSharp.create({ data: { betId: priced.id } });
    await bet(bankroll.id, "60:3", { notTakenAt: new Date() });
    await bet(bankroll.id, "60:4", { deletedAt: new Date() });
    await bet(bankroll.id, "60:5", { status: "WON", settledAt: new Date() });

    expect(await ensureCaptureFollowups(boss, queued.id, "telegram-capture")).toBe(0);
    expect(await keys()).toEqual([enrichSingletonKey(queued.id)]);
  });
});
