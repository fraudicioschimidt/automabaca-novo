import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { getBankrollChart, getBankrollEquityCurves } from "@/src/services/painel/queries/bankroll-curves";
import type { BetStatus } from "@/src/generated/prisma/client";

/**
 * Curvas de lucro realizado: a da ficha da banca (getBankrollChart) e as do
 * Dashboard (getBankrollEquityCurves). O realizado fica plano nas pendentes e
 * acumula só nas liquidadas, no dia do jogo em SP.
 */
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

async function seed(slug = "banca") {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: slug, slug, valorUnidade: 50 },
  });
  const mk = (over: { data: Date; status: BetStatus; lucro?: number; settledAt?: Date }) =>
    db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: over.data,
        registradoEm: over.data,
        settledAt: over.status === "PENDING" ? null : (over.settledAt ?? over.data),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "ML",
        selecao: "A",
        odds: 2,
        stake: 1,
        status: over.status,
        lucro: over.lucro ?? 0,
      },
    });
  return { bankroll, mk };
}

describe("getBankrollChart (Postgres real)", () => {
  it("realized fica plano na pendente e acumula nas finalizadas; um ponto por aposta", async () => {
    const { bankroll, mk } = await seed();
    await mk({ data: new Date("2026-06-01T12:00:00Z"), status: "PENDING" });
    await mk({ data: new Date("2026-06-02T12:00:00Z"), status: "WON", lucro: 1 });
    await mk({ data: new Date("2026-06-03T12:00:00Z"), status: "LOST", lucro: -1 });

    const chart = await getBankrollChart(bankroll.id);
    expect(chart).toHaveLength(3);
    // pendente não move a curva; WON +1; LOST -1 → volta a 0.
    expect(chart[0]!.realized).toBeCloseTo(0, 6);
    expect(chart[1]!.realized).toBeCloseTo(1, 6);
    expect(chart[2]!.realized).toBeCloseTo(0, 6);
  });

  it("banca sem apostas → série vazia (a borda preenche ≥2 pontos)", async () => {
    const { bankroll } = await seed();
    expect(await getBankrollChart(bankroll.id)).toEqual([]);
  });

  it("preserva microunidades no acumulado em vez de arredondar cada ponto para centésimos", async () => {
    const { bankroll, mk } = await seed();
    await mk({ data: new Date("2026-06-01T12:00:00Z"), status: "WON", lucro: 0.004321 });
    await mk({ data: new Date("2026-06-02T12:00:00Z"), status: "WON", lucro: 0.004321 });

    const chart = await getBankrollChart(bankroll.id);
    expect(chart.map((point) => point.realized)).toEqual([0.004321, 0.008642]);
  });

  it("realiza o lucro no dia do jogo, não no da liquidação", async () => {
    const { bankroll, mk } = await seed();
    await mk({
      data: new Date("2026-06-01T12:00:00Z"),
      settledAt: new Date("2026-06-03T12:00:00Z"),
      status: "WON",
      lucro: 1,
    });
    // 01h UTC do dia 3 ainda é dia 2 em São Paulo.
    await mk({ data: new Date("2026-06-03T01:00:00Z"), status: "PENDING" });
    const chart = await getBankrollChart(bankroll.id);
    expect(chart.map((point) => [point.day, point.realized])).toEqual([
      ["2026-06-01", 1],
      ["2026-06-02", 1],
    ]);
  });
});

describe("getBankrollChart: pendente de jogo futuro", () => {
  it("não cria ponto depois de hoje em São Paulo; a de hoje e a de dias passados continuam no eixo", async () => {
    const { bankroll, mk } = await seed();
    // Agora é 10/06 22h em São Paulo (01h UTC do dia 11).
    const now = new Date("2026-06-11T01:00:00Z");
    await mk({ data: new Date("2026-06-08T12:00:00Z"), status: "PENDING" });
    await mk({ data: new Date("2026-06-09T12:00:00Z"), status: "WON", lucro: 1 });
    // 02h59 UTC do dia 11 ainda é hoje (10/06) em São Paulo; 03h já é amanhã.
    await mk({ data: new Date("2026-06-11T02:59:00Z"), status: "PENDING" });
    await mk({ data: new Date("2026-06-11T03:00:00Z"), status: "PENDING" });

    const chart = await getBankrollChart(bankroll.id, now);
    expect(chart.map((point) => [point.day, point.realized])).toEqual([
      ["2026-06-08", 0],
      ["2026-06-09", 1],
      ["2026-06-10", 1],
    ]);
  });
});

describe("getBankrollEquityCurves (Postgres real)", () => {
  it("todas as bancas no mesmo eixo de dias, com o acumulado carregado nos dias sem liquidação", async () => {
    const a = await seed("alfa");
    const b = await seed("beta");
    await a.mk({ data: new Date("2026-06-01T12:00:00Z"), status: "WON", lucro: 1 });
    await a.mk({ data: new Date("2026-06-01T15:00:00Z"), status: "HALF_LOST", lucro: -0.25 });
    await a.mk({ data: new Date("2026-06-03T12:00:00Z"), status: "LOST", lucro: -1 });
    await b.mk({ data: new Date("2026-06-02T12:00:00Z"), status: "WON", lucro: 0.5 });
    // Fora da curva: pendente, anulada e excluída.
    await b.mk({ data: new Date("2026-06-02T13:00:00Z"), status: "PENDING" });
    await b.mk({ data: new Date("2026-06-04T12:00:00Z"), status: "VOID" });
    const excluida = await b.mk({ data: new Date("2026-06-04T13:00:00Z"), status: "WON", lucro: 9 });
    await db.prisma.bet.update({ where: { id: excluida.id }, data: { deletedAt: new Date() } });

    const { days, curves } = await getBankrollEquityCurves();

    expect(days).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
    const bySlug = Object.fromEntries(curves.map((c) => [c.slug, c]));
    expect(bySlug.alfa).toEqual({ bankrollId: a.bankroll.id, slug: "alfa", acumulado: [0.75, 0.75, -0.25], accumulatedBrl: [37.5, 37.5, -12.5] });
    expect(bySlug.beta).toEqual({ bankrollId: b.bankroll.id, slug: "beta", acumulado: [0, 0.5, 0.5], accumulatedBrl: [0, 25, 25] });
  });

  it("usa o dia de São Paulo do jogo, não o da liquidação", async () => {
    const { mk } = await seed();
    // 01h UTC do dia 2 ainda é dia 1 em São Paulo; a liquidação veio no dia 5.
    await mk({ data: new Date("2026-06-02T01:00:00Z"), settledAt: new Date("2026-06-05T12:00:00Z"), status: "WON", lucro: 1 });
    expect((await getBankrollEquityCurves()).days).toEqual(["2026-06-01"]);
  });

  it("sem liquidação nenhuma, não há dias nem curvas", async () => {
    const { mk } = await seed();
    await mk({ data: new Date("2026-06-01T12:00:00Z"), status: "PENDING" });
    expect(await getBankrollEquityCurves()).toEqual({ days: [], curves: [] });
  });
});
