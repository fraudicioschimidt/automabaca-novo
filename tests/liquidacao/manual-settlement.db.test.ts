import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { settleManualFromView } from "@/src/services/bets/manual-settlement";
import { applyAutomaticBetStatusChange } from "@/src/services/bets/settle";
import { applyManualBetStatusChange } from "../helpers/settle";
import { mapBetRow, BET_ROW_SELECT } from "@/src/services/painel/queries/bet-rows";
import { toBet } from "@/app/_design/adapters/aposta";

vi.mock("@/src/services/bets/settle-effects", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/services/bets/settle-effects")>(),
  finishBetStatusChange: vi.fn(),
}));
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });
async function seed() {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "C32 sintético", slug: "c32", valorUnidade: 50 } });
  const conta = await db.prisma.conta.create({ data: { titular: "Sintético", casaDeAposta: "Betano", saldoInicial: 500, saldoAtual: 500 } });
  const bet = await db.prisma.bet.create({ data: { bankrollId: bankroll.id, contaId: conta.id, casaDeAposta: "Betano", evento: "France vs Spain", esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), mercado: "Money Line – Match", selecao: "France", odds: 2, stake: 1, valorUnidade: 50, data: new Date("2026-09-01T12:00:00Z") } });
  return { bankroll, conta, bet };
}
const get = (id: string) => db.prisma.bet.findUniqueOrThrow({ where: { id } });
function request(bet: { id: string; manualSettlementVersion: number }, newStatus: "WON" | "LOST" | "PENDING" | "CASHOUT" = "WON", cashoutLucro?: number) {
  return { betId: bet.id, bankrollSlug: "c32", newStatus, cashoutLucro, source: "manual:test", confirmation: { expectedVersion: bet.manualSettlementVersion, requestId: randomUUID() } };
}
it("carrega a versão junto aos dados reais enviados à tela", async () => {
  const { bet } = await seed();
  const raw = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: BET_ROW_SELECT });
  const ui = toBet(mapBetRow(raw));
  expect(ui.settlementView).toMatchObject({ version: 1, event: "France vs Spain", stake: 1, unitValue: 50, status: "PENDING" });
});
it("uma confirmação altera resultado e ledger uma única vez", async () => {
  const { bet, conta } = await seed(); const req = request(bet);
  expect(await settleManualFromView(req)).toMatchObject({ kind: "saved", lucro: 1, duplicate: false, current: { version: 2 } });
  expect(await settleManualFromView(req)).toMatchObject({ kind: "saved", duplicate: true });
  expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(550);
  expect(await db.prisma.settlementEvent.count()).toBe(1);
  expect(await db.prisma.manualSettlementReceipt.count()).toBe(1);
});
it("recusa tela anterior à liquidação automática e aceita nova decisão explícita", async () => {
  const { bet, conta } = await seed(); const stale = request(bet, "LOST");
  await applyAutomaticBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
  expect(await settleManualFromView(stale)).toMatchObject({ kind: "conflict", current: { status: "WON", version: 2 } });
  expect(await db.prisma.manualSettlementReceipt.count()).toBe(0);
  expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(550);
  expect(await settleManualFromView(request(await get(bet.id), "LOST"))).toMatchObject({ kind: "saved", lucro: -1 });
  expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(450);
});
it("voltar ao mesmo resultado não torna uma tela antiga atual", async () => {
  const { bet } = await seed(); await settleManualFromView(request(bet)); const before = await get(bet.id);
  await applyManualBetStatusChange({ betId: bet.id, newStatus: "LOST", source: "manual:test" });
  await applyManualBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual:test" });
  expect(await settleManualFromView(request(before, "LOST"))).toMatchObject({ kind: "conflict", current: { status: "WON", version: 4 } });
});
it("recibo repetido após outra correção devolve o estado atual sem revertê-lo", async () => {
  const { bet } = await seed(); const req = request(bet); await settleManualFromView(req);
  await applyManualBetStatusChange({ betId: bet.id, newStatus: "LOST", source: "manual:test" });
  expect(await settleManualFromView(req)).toMatchObject({ kind: "saved", duplicate: true, lucro: -1, current: { status: "LOST" } });
  expect((await get(bet.id)).status).toBe("LOST");
  await expect(settleManualFromView({ ...req, newStatus: "PENDING" })).rejects.toThrow(/outros dados/);
});
it.each(["WON", "PENDING"] as const)("cliques concorrentes %s compartilham um único recibo", async (status) => {
  const { bet } = await seed(); const req = request(bet, status);
  const results = await Promise.all(Array.from({ length: 5 }, () => settleManualFromView(req)));
  expect(results.every((r) => r.kind === "saved")).toBe(true);
  expect(results.filter((r) => r.kind === "saved" && !r.duplicate)).toHaveLength(1);
  expect(await db.prisma.manualSettlementReceipt.count()).toBe(1);
  expect(await db.prisma.settlementEvent.count()).toBe(1);
  expect(await db.prisma.settlementEvent.findFirstOrThrow()).toMatchObject({ type: status === "WON" ? "STATUS_CHANGED" : "EVIDENCE_CLEARED" });
});
it("decisões concorrentes diferentes permitem só uma gravação da versão", async () => {
  const { bet } = await seed();
  const results = await Promise.all([settleManualFromView(request(bet)), settleManualFromView(request(bet, "LOST"))]);
  expect(results.map((r) => r.kind).sort()).toEqual(["conflict", "saved"]);
  expect(await db.prisma.settlementEvent.count()).toBe(1);
});
it("gravações de manutenção não invalidam a decisão", async () => {
  const { bet } = await seed();
  await db.prisma.bet.update({ where: { id: bet.id }, data: { sportConfidence: 99, sportEvidence: { maintenance: true }, tipster: "Título atualizado" } });
  await db.prisma.betSharp.create({ data: { betId: bet.id } });
  expect((await get(bet.id)).manualSettlementVersion).toBe(1);
  expect(await settleManualFromView(request(bet))).toMatchObject({ kind: "saved" });
});
it("protege alteração de stake/odd até quando escrita diretamente por SQL", async () => {
  const { bet } = await seed();
  await db.prisma.$executeRaw`UPDATE bets SET stake = 2, odds = 3 WHERE id = ${bet.id}`;
  expect(await settleManualFromView(request(bet, "CASHOUT", 0.5))).toMatchObject({ kind: "conflict", current: { stake: 2, odds: 3 } });
  expect((await get(bet.id)).status).toBe("PENDING");
});
it("contrato de jogador invalida a versão; nova evidência de coleta não invalida", async () => {
  const { bet } = await seed();
  const terms = { version: 1, jogador: "Ganso", family: "shots_on_target", period: "match", direction: "over", lineQuarters: 2, substituicao: "UNKNOWN" };
  await db.prisma.betPlayerProp.create({ data: { betId: bet.id, terms, rule: { version: 1, bookmaker: "Betano", family: terms.family, verified: false } } });
  const before = await get(bet.id);
  await db.prisma.betPlayerProp.update({ where: { betId: bet.id }, data: { evidence: { observed: true } } });
  expect((await get(bet.id)).manualSettlementVersion).toBe(before.manualSettlementVersion);
  await db.prisma.betPlayerProp.update({ where: { betId: bet.id }, data: { terms: { ...terms, lineQuarters: 6 } } });
  expect((await get(bet.id)).manualSettlementVersion).toBe(before.manualSettlementVersion + 1);
  expect(await settleManualFromView(request(before))).toMatchObject({ kind: "conflict" });
});
it("aposta removida ou de outra banca não pode receber a confirmação", async () => {
  const { bet } = await seed();
  expect(await settleManualFromView({ ...request(bet), bankrollSlug: "outra" })).toMatchObject({ kind: "unavailable" });
  await db.prisma.bet.update({ where: { id: bet.id }, data: { deletedAt: new Date() } });
  expect(await settleManualFromView(request(bet))).toMatchObject({ kind: "unavailable" });
  expect(await db.prisma.manualSettlementReceipt.count()).toBe(0);
});
it("exclusão da banca remove os recibos junto das apostas", async () => {
  const { bankroll, bet } = await seed(); await settleManualFromView(request(bet, "PENDING"));
  await db.prisma.bankroll.delete({ where: { id: bankroll.id } });
  expect(await db.prisma.manualSettlementReceipt.count()).toBe(0);
});
it.each([undefined, {}, { expectedVersion: 0, requestId: "bad" }])("recusa confirmação sem versão válida", async (confirmation) => {
  const { bet } = await seed();
  await expect(settleManualFromView({ ...request(bet), confirmation })).rejects.toThrow(/Atualize a página/);
  expect((await get(bet.id)).status).toBe("PENDING");
});
