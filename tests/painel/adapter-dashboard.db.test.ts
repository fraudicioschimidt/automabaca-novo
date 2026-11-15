import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import * as bankrolls from "@/src/services/painel/queries/bankrolls";
import * as curves from "@/src/services/painel/queries/bankroll-curves";
import * as dashboard from "@/src/services/painel/queries/dashboard";
import * as channels from "@/src/services/painel/canais";
import { getDashboardData } from "@/app/_design/adapters/dashboard";
import { getBankrollsData } from "@/app/_design/adapters/bankrolls";
import { getBankrollData } from "@/app/_design/adapters/bankroll";
import { reliableClvSql } from "@/src/services/sharp/closing-evidence";

vi.mock("@/src/services/painel/operacoes/saude", async (original) => ({
  ...await original<typeof import("@/src/services/painel/operacoes/saude")>(),
  getSaudeMotor: async () => ({ dbOk: true, ultimoHeartbeat: new Date() }),
}));
vi.mock("@/src/services/painel/operacoes/alertas", () => ({ getAlertas: async () => [] }));
const proof = vi.hoisted(() => ({ validations: 0 }));
vi.mock("@/src/domain/price-provenance", async (original) => {
  const actual = await original<typeof import("@/src/domain/price-provenance")>();
  return { ...actual, hasRecomputableClvEvidence: (...args: Parameters<typeof actual.hasRecomputableClvEvidence>) => {
    proof.validations += 1;
    return actual.hasRecomputableClvEvidence(...args);
  } };
});
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
beforeEach(async () => { await db.reset(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await db.dispose(); });

async function pendingBet() {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Teste", slug: "teste", valorUnidade: 50 } });
  return db.prisma.bet.create({ data: {
    bankrollId: bankroll.id, data: new Date("2026-10-01T12:00:00Z"), evento: "A vs B", esporte: "Soccer",
    sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), mercado: "ML", selecao: "A", odds: 2, stake: 1,
  } });
}

it.each(["liquidação", "remoção", "captura"])("%s entre resumo e curva não mistura estados no Dashboard", async (change) => {
  const bet = await pendingBet();
  if (change === "remoção") await db.prisma.bet.update({ where: { id: bet.id }, data: { status: "WON", lucro: 1, settledAt: new Date() } });
  const summary = bankrolls.getBankrollSummaries;
  const equity = curves.getBankrollEquityCurves;
  const today = dashboard.getResumoHoje;
  let release!: () => void;
  const written = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(bankrolls, "getBankrollSummaries").mockImplementation(async (...args) => {
    const before = await summary(...args);
    if (change === "captura") {
      await db.prisma.bet.create({ data: {
        bankrollId: bet.bankrollId, valorUnidade: 50, data: bet.data, evento: "C vs D", esporte: "Soccer",
        sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(),
        mercado: "ML", selecao: "C", odds: 2, stake: 1, status: "PENDING",
      } });
    } else {
      await db.prisma.bet.update({ where: { id: bet.id }, data: change === "remoção"
        ? { deletedAt: new Date(), status: "CANCELED", lucro: 0 }
        : { status: "WON", lucro: 1, settledAt: new Date() } });
    }
    release();
    return before;
  });
  vi.spyOn(curves, "getBankrollEquityCurves").mockImplementation(async (...args) => { await written; return equity(...args); });
  vi.spyOn(dashboard, "getResumoHoje").mockImplementation(async (...args) => { await written; return today(...args); });
  const result = await getDashboardData("Dono", "dono");
  expect(result.tipsters[0]!.profitBrl).toBe(change === "remoção" ? 50 : 0);
  expect(result.tipsters[0]!.equityBrl.at(-1)).toBe(result.tipsters[0]!.profitBrl);
  expect(result.today.aResolver).toBe(result.tipsters[0]!.open);
  expect(result.today.tips).toBe(result.tipsters[0]!.n);
  expect(await db.prisma.bet.count({ where: { deletedAt: null } })).toBe(change === "remoção" ? 0 : change === "captura" ? 2 : 1);
});

it("liquidação entre resumo e decisão não mistura bases em Tipsters", async () => {
  const bet = await pendingBet();
  const summary = bankrolls.getBankrollSummaries;
  const decisions = channels.getCanaisDecisao;
  let release!: () => void;
  const written = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(bankrolls, "getBankrollSummaries").mockImplementation(async (...args) => {
    const before = await summary(...args);
    await db.prisma.bet.update({ where: { id: bet.id }, data: { status: "WON", lucro: 1, settledAt: new Date() } });
    await db.prisma.betClosing.create({ data: { betId: bet.id, clv: 3, clvReliable: true } });
    release();
    return before;
  });
  vi.spyOn(channels, "getCanaisDecisao").mockImplementation(async (...args) => { await written; return decisions(...args); });
  const { tipsters } = await getBankrollsData();
  expect(tipsters[0]!.resolved).toBe(0);
  expect(tipsters[0]!.dec.nRoi).toBe(tipsters[0]!.resolved);
  expect(tipsters[0]!.dec.roiReal).toBeNull();
  expect(tipsters[0]!.dec.amostra).toBe(tipsters[0]!.clvSamples);
  expect(tipsters[0]!.hasClv).toBe(false);
});

it("liquidação entre detalhe e curva conserva os números e as linhas da ficha", async () => {
  const bet = await pendingBet();
  const detail = bankrolls.getBankrollDetail;
  vi.spyOn(bankrolls, "getBankrollDetail").mockImplementation(async (...args) => {
    const before = await detail(...args);
    await db.prisma.bet.update({ where: { id: bet.id }, data: { status: "WON", lucro: 1, settledAt: new Date() } });
    return before;
  });
  const result = await getBankrollData("teste");
  expect(result!.METRICS.lucro).toBe(0);
  expect(result!.CHART.at(-1)!.realized).toBe(result!.METRICS.lucro);
  expect(result!.BETS[0]!.status).toBe("pending");
});

const IRREPRODUCIBLE_SNAPSHOT = { version: 1, combination: "single", components: [] };

/** Três fechamentos marcados confiáveis; o último não sustenta o CLV gravado. */
async function closingsWithOneBrokenProof() {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Prova", slug: "prova", valorUnidade: 50 } });
  const at = new Date("2026-10-01T12:00:00Z");
  await db.prisma.dashboardVisit.create({ data: { username: "dono", lastSeenAt: at } });
  for (const [id, clv] of [["proof-a", 3], ["proof-b", 5], ["proof-c", 40]] as const) {
    await db.prisma.bet.create({ data: {
      id, bankrollId: bankroll.id, data: at, settledAt: at, evento: "A vs B", esporte: "Soccer",
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: at, mercado: "ML", selecao: "A", odds: 2, stake: 1,
      status: "WON", lucro: 1,
      closing: { create: { clv, clvReliable: true, fetchedAt: at,
        ...(id === "proof-c" ? { closingPriceSnapshot: IRREPRODUCIBLE_SNAPSHOT } : {}) } },
    } });
  }
  return bankroll;
}

it("o Dashboard valida cada prova de fechamento uma vez e todos os agregados usam o mesmo conjunto", async () => {
  await closingsWithOneBrokenProof();
  proof.validations = 0;
  const result = await getDashboardData("Dono", "dono");
  expect(proof.validations).toBe(3);
  expect(result.tipsters[0]).toMatchObject({ clvSamples: 2, clvMedio: 4 });
  expect(result.visit.since).toMatchObject({ closings: 2, clvMean: 4 });
  // Os mesmos números de cada agregado lido sozinho, na própria transação.
  const [summary] = await bankrolls.getBankrollSummaries();
  const [channel] = await channels.getCanaisDecisao();
  expect(summary).toMatchObject({ clv: 4, clvSamples: result.tipsters[0]!.clvSamples });
  expect(channel!.decisao).toMatchObject({ nClv: 2, clvMedio: result.tipsters[0]!.clvMedio });
});

it("Tipsters valida cada prova de fechamento uma vez para o resumo e a decisão", async () => {
  await closingsWithOneBrokenProof();
  proof.validations = 0;
  const { tipsters } = await getBankrollsData();
  expect(proof.validations).toBe(3);
  expect(tipsters[0]).toMatchObject({ clvSamples: 2, dec: { amostra: 2, clvMedio: 4 } });
});

it("a ficha valida só as provas do tipster aberto", async () => {
  await closingsWithOneBrokenProof();
  const other = await db.prisma.bankroll.create({ data: { nome: "Outro", slug: "outro", valorUnidade: 50 } });
  const at = new Date("2026-10-01T12:00:00Z");
  await db.prisma.bet.create({ data: {
    bankrollId: other.id, data: at, evento: "C vs D", esporte: "Soccer", sportResolutionStatus: "CONFIRMED",
    sportResolvedAt: at, mercado: "ML", selecao: "C", odds: 2, stake: 1,
    closing: { create: { clv: 7, clvReliable: true, fetchedAt: at } },
  } });
  proof.validations = 0;
  const detail = await db.prisma.$transaction((tx) => bankrolls.getBankrollDetail("outro", tx), { isolationLevel: "RepeatableRead" });
  // Uma no agregado e uma na linha exibida; nenhuma das três do outro tipster.
  expect(proof.validations).toBe(2);
  expect(detail!.resumo).toMatchObject({ clv: 7, clvSamples: 1 });
});

it("a prova corrigida entre duas leituras vale na seguinte: o veredito não sobrevive à transação", async () => {
  await closingsWithOneBrokenProof();
  expect((await getBankrollsData()).tipsters[0]).toMatchObject({ clvSamples: 2 });
  const valid = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: "proof-a" } });
  await db.prisma.betClosing.update({ where: { betId: "proof-c" }, data: {
    clv: valid.clv, closingOdd: valid.closingOdd, closingRawOdd: valid.closingRawOdd,
    closingPriceSnapshot: valid.closingPriceSnapshot!,
  } });
  expect((await getBankrollsData()).tipsters[0]).toMatchObject({ clvSamples: 3, dec: { amostra: 3 } });
});

it("fora de transação cada leitura revalida a prova", async () => {
  await closingsWithOneBrokenProof();
  proof.validations = 0;
  expect((await reliableClvSql(db.prisma)).values).toContainEqual(["proof-c"]);
  await db.prisma.betClosing.update({ where: { betId: "proof-c" }, data: { clvReliable: false } });
  expect((await reliableClvSql(db.prisma)).values).not.toContainEqual(["proof-c"]);
  expect(proof.validations).toBe(5);
});
