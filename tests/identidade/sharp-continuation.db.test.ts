import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as bossModule from "@/src/infra/boss";
import { finishSoftDeleteBet } from "@/src/services/bets/remove-effects";
import { finishBetStatusChange } from "@/src/services/bets/settle-effects";
import { softDeleteBet, restoreRemovedBet } from "@/src/services/bets/remove";
import { applyManualBetStatusChangeTx } from "@/src/services/bets/settle";
import { applyManualBetStatusChange } from "../helpers/settle";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../helpers/db";
import { continueSharpEnrich, type SharpJobData } from "@/src/services/scheduling/continue-sharp-enrich";
import { enqueueSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import { QUEUES } from "@/src/infra/queue-contract";
import { upsertSharp } from "@/src/services/sharp/enrich/upsert-sharp";
import { withProviderWorkBudget } from "@/src/infra/provider-work-budget";
import { awaitProviderCadence } from "@/src/providers/request-cadence";
import { getBankrollVersion } from "@/src/services/painel/queries/bankrolls";
import { expectEnrichTerms, withEnrichWriteScope } from "@/src/services/sharp/enrich/write-guard";

let db: TestDb;
let boss: PgBoss;
beforeAll(async () => {
  db = createTestDb();
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schedule: false, supervise: false });
  await boss.start();
  await boss.createQueue(QUEUES.sharpEnrich, { policy: "exclusive" });
});
beforeEach(async () => { vi.restoreAllMocks(); await boss.deleteAllJobs(QUEUES.sharpEnrich); await db.reset(); });
afterAll(async () => { await boss.stop(); await db.dispose(); });

async function activeJob() {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Latency", slug: "latency", sharpMode: "CLV_ONLY" } });
  const bet = await db.prisma.bet.create({ data: { bankrollId: bankroll.id, data: new Date(Date.now() + 86_400_000),
    evento: "Alpha vs Bravo", esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), mercado: "Moneyline", selecao: "Alpha", odds: 2, stake: 1 } });
  await enqueueSharpEnrich(boss, bet.id);
  const [job] = await boss.fetch<SharpJobData>(QUEUES.sharpEnrich);
  return { bet, bankroll, job: job! };
}

it("conclui e cria exatamente uma continuação, preservando cursor após reiniciar o produtor", async () => {
  const { job } = await activeJob();
  const retryAt = new Date(Date.now() + 40_000);
  const continuation = { betSignature: "terms-v1", pinnacle17TriedAt: Date.now() };
  await Promise.all([continueSharpEnrich(boss, job, retryAt, continuation), continueSharpEnrich(boss, job, retryAt, continuation)]);
  await boss.stop();
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schedule: false, supervise: false });
  await boss.start();
  const jobs = await boss.findJobs<SharpJobData>(QUEUES.sharpEnrich, { queued: true });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.data.continuation).toEqual(continuation);
  expect(jobs[0]?.data.continuations).toBe(1);
  expect(new Date(jobs[0]!.startAfter).getTime()).toBe(retryAt.getTime());
  expect((await boss.getJobById(QUEUES.sharpEnrich, job.id))?.state).toBe("completed");
});

it("falha ao criar sucessor reverte a conclusão e mantém o original ativo", async () => {
  const { job } = await activeJob();
  vi.spyOn(boss, "send").mockRejectedValueOnce(new Error("database interrupted"));
  await expect(continueSharpEnrich(boss, job, new Date(), {})).rejects.toThrow("database interrupted");
  expect((await boss.getJobById(QUEUES.sharpEnrich, job.id))?.state).toBe("active");
});

it.each(["cancel", "remove"])("não recria trabalho após %s", async (operation) => {
  const { bet, job } = await activeJob();
  if (operation === "cancel") await boss.cancel(QUEUES.sharpEnrich, job.id);
  else await db.prisma.bet.update({ where: { id: bet.id }, data: { deletedAt: new Date() } });
  await continueSharpEnrich(boss, job, new Date(), {});
  expect(await boss.findJobs(QUEUES.sharpEnrich, { queued: true })).toHaveLength(0);
});

it("bloqueia escrita sharp após remoção ocorrida durante consulta externa", async () => {
  const { bet } = await activeJob();
  await db.prisma.bet.update({ where: { id: bet.id }, data: { deletedAt: new Date() } });
  await expect(upsertSharp(bet.id, { identityStatus: "MATCHED", confidence: 99 })).rejects.toMatchObject({ name: "EnrichObsoleteError" });
  expect(await db.prisma.betSharp.findUnique({ where: { betId: bet.id } })).toBeNull();
});

it("orçamento da etapa alcança chamadas internas e não ocupa slot quando falta cota", async () => {
  const retryAt = new Date(Date.now() + 40_000);
  await db.prisma.providerRequestGate.create({ data: { provider: "bridgeodds", route: "global", nextAllowedAt: retryAt } });
  await expect(withProviderWorkBudget("bridgeodds", 5_000, () =>
    awaitProviderCadence({ provider: "bridgeodds", route: "global", cooldownMs: 40_000 })))
    .rejects.toMatchObject({ name: "ProviderCadenceDeferredError", retryAt });
  expect((await db.prisma.providerRequestGate.findFirstOrThrow()).nextAllowedAt).toEqual(retryAt);
  await withProviderWorkBudget("bridgeodds", 1, () =>
    awaitProviderCadence({ provider: "pinnacle17", route: "fixture", cooldownMs: 1 }));
});

it("recusa preço calculado antes de uma edição concorrente dos termos", async () => {
  const { bet } = await activeJob();
  await withEnrichWriteScope(async () => {
    expectEnrichTerms(bet);
    await db.prisma.bet.update({ where: { id: bet.id }, data: { selecao: "Bravo" } });
    await expect(upsertSharp(bet.id, { identityStatus: "MATCHED", confidence: 99 }))
      .rejects.toMatchObject({ name: "EnrichObsoleteError" });
  });
  expect(await db.prisma.betSharp.findUnique({ where: { betId: bet.id } })).toBeNull();
});

it("versão da banca detecta identidade, preço, fechamento, abertura e remoção", async () => {
  const { bet } = await activeJob();
  const versions = [await getBankrollVersion("latency")];
  await upsertSharp(bet.id, { identityStatus: "MATCHED", confidence: 99, provider: "bridgeodds", providerMatchId: "123" });
  versions.push(await getBankrollVersion("latency"));
  await db.prisma.betSharp.update({ where: { betId: bet.id }, data: { noOddsReason: "no_prices", updatedAt: new Date(Date.now() + 1000) } });
  versions.push(await getBankrollVersion("latency"));
  await db.prisma.betClosing.create({ data: { betId: bet.id, noOddsReason: "no_prices" } });
  versions.push(await getBankrollVersion("latency"));
  // A abertura chega depois do kickoff, sem tocar na aposta nem no fechamento.
  await db.prisma.betOpening.create({ data: { betId: bet.id, noOpeningReason: "no_prices" } });
  versions.push(await getBankrollVersion("latency"));
  await db.prisma.bet.update({ where: { id: bet.id }, data: { deletedAt: new Date() } });
  versions.push(await getBankrollVersion("latency"));
  expect(new Set(versions).size).toBe(6);
  expect(await getBankrollVersion("missing")).toBeNull();
});


it("efeito atrasado da remoção preserva a cadeia da aposta já restaurada", async () => {
  const { bet, job } = await activeJob();
  vi.spyOn(bossModule, "getSharedBoss").mockResolvedValue(boss);
  const removed = await softDeleteBet({ betId: bet.id, actor: "test", motivo: "remover", origin: "painel" }, { deferEffects: true });
  await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "restaurar", by: "painel" }, { deferEffects: true });
  await finishSoftDeleteBet(bet.id, removed);
  expect((await boss.getJobById(QUEUES.sharpEnrich, job.id))?.state).toBe("active");
});

it("efeito atrasado da liquidação preserva a cadeia da aposta já reaberta", async () => {
  const { bet, job } = await activeJob();
  vi.spyOn(bossModule, "getSharedBoss").mockResolvedValue(boss);
  await db.prisma.bet.update({ where: { id: bet.id }, data: { data: new Date(Date.now() - 86_400_000) } });
  const settled = await runSerializableTransaction("settle-without-effects", (tx) =>
    applyManualBetStatusChangeTx(tx, { betId: bet.id, newStatus: "WON", source: "manual:teste" }));
  await applyManualBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual:teste" });
  await finishBetStatusChange(bet.id, settled);
  expect((await boss.getJobById(QUEUES.sharpEnrich, job.id))?.state).toBe("active");
});

it("não agenda continuação para aposta liquidada com identidade já resolvida", async () => {
  const { bet, job } = await activeJob();
  await db.prisma.bet.update({ where: { id: bet.id }, data: { data: new Date(Date.now() - 86_400_000) } });
  await db.prisma.betSharp.create({ data: { betId: bet.id, identityStatus: "MATCHED", confidence: 99 } });
  await runSerializableTransaction("settle-without-effects", (tx) =>
    applyManualBetStatusChangeTx(tx, { betId: bet.id, newStatus: "WON", source: "manual:teste" }));
  await continueSharpEnrich(boss, job, new Date(), {});
  expect(await boss.findJobs(QUEUES.sharpEnrich, { queued: true })).toHaveLength(0);
});


it("mantém a continuação da recuperação de identidade histórica após a liquidação", async () => {
  const { bet, job } = await activeJob();
  await db.prisma.bet.update({ where: { id: bet.id }, data: { data: new Date(Date.now() - 86_400_000) } });
  await runSerializableTransaction("settle-without-effects", (tx) =>
    applyManualBetStatusChangeTx(tx, { betId: bet.id, newStatus: "WON", source: "manual:teste" }));
  await continueSharpEnrich(boss, job, new Date(), {});
  expect(await boss.findJobs(QUEUES.sharpEnrich, { queued: true })).toHaveLength(1);
});

it("cancelamento da liquidação preserva recuperação histórica criada depois dela", async () => {
  const { bet, job } = await activeJob();
  vi.spyOn(bossModule, "getSharedBoss").mockResolvedValue(boss);
  await db.prisma.bet.update({ where: { id: bet.id }, data: { data: new Date(Date.now() - 86_400_000) } });
  const settled = await runSerializableTransaction("settle-without-effects", (tx) =>
    applyManualBetStatusChangeTx(tx, { betId: bet.id, newStatus: "WON", source: "manual:teste" }));
  await boss.complete(QUEUES.sharpEnrich, job.id);
  const recovery = await enqueueSharpEnrich(boss, bet.id, { origem: "revive" });
  await finishBetStatusChange(bet.id, settled);
  expect((await boss.getJobById(QUEUES.sharpEnrich, recovery!))?.state).toBe("created");
});


it.each(["remover", "liquidar"])("cancelamento de %s ainda válido encerra o job antigo", async (operation) => {
  const { bet, job } = await activeJob();
  vi.spyOn(bossModule, "getSharedBoss").mockResolvedValue(boss);
  if (operation === "remover") {
    await softDeleteBet({ betId: bet.id, actor: "test", motivo: "remover", origin: "painel" });
  } else {
    await db.prisma.bet.update({ where: { id: bet.id }, data: { data: new Date(Date.now() - 86_400_000) } });
    await applyManualBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual:teste" });
  }
  expect((await boss.getJobById(QUEUES.sharpEnrich, job.id))?.state).toBe("cancelled");
});
