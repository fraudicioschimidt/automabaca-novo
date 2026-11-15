import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { getBankrollDetail, getBankrollSummaries } from "@/src/services/painel/queries/bankrolls";
import { getBetDetail } from "@/src/services/painel/queries/bet-rows";
import { restoreBetsInBatch, softDeleteBet } from "@/src/services/bets/remove";
import { baseAlcancavel, situacaoDoClv } from "@/src/domain/analyzer/cobertura";

/**
 * Caracterização de getBankrollSummaries/getBankrollDetail: fixa lucro, ROI,
 * acerto e CLV no Postgres real, para o detalhe escopado a uma banca não mudar
 * a saída.
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

async function seed() {
  const alpha = await db.prisma.bankroll.create({
    data: { nome: "Alpha", slug: "alpha", valorUnidade: 100, capitalInicial: 1000, sharpMode: "CLV_ONLY" },
  });
  const beta = await db.prisma.bankroll.create({
    data: { nome: "Beta", slug: "beta", valorUnidade: 50, sharpMode: "OFF" },
  });
  const mk = (
    bankrollId: string,
    ext: string,
    over: {
      status: string;
      lucro?: number;
      stake?: number;
      clv?: number | null;
      clvReliable?: boolean | null;
      source?: string;
      deletedAt?: Date;
    },
  ) =>
    db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: over.status === "PENDING" ? null : new Date("2026-06-10T20:00:00Z"),
        bankrollId,
        data: new Date("2026-06-10T20:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: over.stake ?? 1,
        status: over.status as never,
        lucro: over.lucro ?? 0,
        source: over.source ?? "test",
        sourceExternalId: ext,
        ...(over.deletedAt ? { deletedAt: over.deletedAt } : {}),
        ...(over.clv !== undefined
          ? {
              closing: {
                create: {
                  clv: over.clv,
                  clvReliable: over.clvReliable === undefined ? true : over.clvReliable,
                  fetchedAt: new Date("2026-06-10T19:59:00Z"),
                },
              },
            }
          : {}),
      },
    });
  // Alpha: três financeiras, uma PENDING e uma VOID sem efeito financeiro.
  await mk(alpha.id, "a1", { status: "WON", lucro: 1, clv: 3 });
  await mk(alpha.id, "a2", { status: "LOST", lucro: -1, clv: -1 });
  await mk(alpha.id, "a3", { status: "PENDING" });
  await mk(alpha.id, "a4", { status: "WON", lucro: 0.5, clv: 5, clvReliable: false });
  await mk(alpha.id, "a5", { status: "VOID", stake: 10, lucro: 0 });
  // Beta: 1 aposta só, p/ garantir que não vaza no resumo de Alpha
  await mk(beta.id, "b1", { status: "WON", lucro: 9, clv: 99 });
  return { alpha, beta, mk };
}

describe("getBankrollSummaries (Postgres real) — números fixos", () => {
  it("agrega por banca sem vazar entre bancas", async () => {
    await seed();
    const sums = await getBankrollSummaries();
    const a = sums.find((s) => s.slug === "alpha")!;
    expect(a.apostas).toBe(5);
    expect(a.pendentes).toBe(1);
    expect(a.stakePendente).toBe(1);
    expect(a.resolvidas).toBe(4);
    expect(a.wins).toBe(2); // 2 WON
    expect(a.losses).toBe(1); // 1 LOST
    expect(a.lucro).toBeCloseTo(0.5, 6); // 1 - 1 + 0.5 (só finalizadas)
    expect(a.stakeFinalizada).toBeCloseTo(3, 6);
    expect(a.roi!).toBeCloseTo((0.5 / 3) * 100, 4); // 16.67%
    expect(a.acerto!).toBeCloseTo((2 / 3) * 100, 4); // 66.67%
    expect(a.clv!).toBeCloseTo(1, 6); // média JS de [3,-1] (o clv=5 é reliable:false)
    expect(a.clvSamples).toBe(2);

    const b = sums.find((s) => s.slug === "beta")!;
    expect(b.apostas).toBe(1);
    expect(b.lucro).toBeCloseTo(9, 6);
  });

  it("exclui CLV quando o marcador de confiabilidade é null", async () => {
    const { alpha, mk } = await seed();
    await mk(alpha.id, "sem-prova", {
      status: "WON",
      lucro: 1,
      clv: 100,
      clvReliable: null,
    });
    const a = (await getBankrollSummaries()).find((s) => s.slug === "alpha")!;
    expect(a.clv).toBeCloseTo(1, 6);
    expect(a.clvSamples).toBe(2);
  });
});

describe("cobertura de CLV divide pela base alcançável", () => {
  it("pendente e entrada ao vivo ficam fora; lacuna com motivo e liquidada sem motivo ficam dentro", async () => {
    const { alpha } = await seed();
    const closing = (betId: string, noOddsReason: string) =>
      db.prisma.betClosing.create({ data: { betId, noOddsReason, fetchedAt: new Date("2026-06-10T19:59:00Z") } });
    const extra = async (ext: string, status: string) => db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), bankrollId: alpha.id, data: new Date("2026-06-10T20:00:00Z"),
        settledAt: status === "PENDING" ? null : new Date("2026-06-10T22:00:00Z"),
        evento: "C vs D", esporte: "Soccer", mercado: "Moneyline", selecao: "C", odds: 2, stake: 1,
        status: status as never, lucro: 0, source: "test", sourceExternalId: ext,
      },
    });
    const identity = (betId: string, identityStatus: "UNMATCHED" | "UNSUPPORTED", noOddsReason: string) =>
      db.prisma.betSharp.create({ data: { betId, identityStatus, noOddsReason } });
    await closing((await extra("ao-vivo", "LOST")).id, "aposta_ao_vivo");
    await closing((await extra("ao-vivo-pendente", "PENDING")).id, "aposta_ao_vivo");
    await closing((await extra("lacuna", "WON")).id, "no_prices");
    // Sem bet_closing: o motivo que conta é o da identidade.
    await identity((await extra("multipla", "LOST")).id, "UNSUPPORTED", "multipla");
    await identity((await extra("nao-casada", "LOST")).id, "UNMATCHED", "identidade_nao_casada");
    await identity((await extra("nao-casada-pendente", "PENDING")).id, "UNMATCHED", "identidade_nao_casada");
    await identity((await extra("clv-only", "WON")).id, "UNSUPPORTED", "clv_only");

    const detail = (await getBankrollDetail("alpha"))!;
    const dominio = baseAlcancavel(detail.bets, situacaoDoClv);
    // O SQL do resumo e a regra do domínio contam a mesma base.
    expect(detail.resumo.clvBase).toBe(dominio.base.length);
    expect(detail.resumo.clvSamples).toBe(dominio.cobertas.length);
    // a1, a2 (com CLV), a4 (CLV não confiável), a5 (VOID sem motivo), a lacuna,
    // a não casada liquidada e a clv_only (fala da entrada); a3 pendente, as duas
    // ao vivo, a múltipla e a não casada pendente ficam fora.
    expect(detail.resumo.apostas).toBe(12);
    expect(detail.resumo.clvBase).toBe(7);
  });
});

describe("cobertura com liquidação ainda pendente", () => {
  it.each(["missing", "invalid"])("fechamento congelado %s entra na base mesmo com status PENDING", async (kind) => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Fechamento", slug: "fechamento", sharpMode: "CLV_ONLY" } });
    const at = new Date("2026-10-09T12:00:00Z");
    await db.prisma.bet.create({ data: { bankrollId: bank.id, data: at, evento: "A vs B", esporte: "Soccer", mercado: "Moneyline",
      selecao: "A", odds: 2, stake: 1, status: "PENDING", sportResolutionStatus: "CONFIRMED", sportResolvedAt: at,
      closing: { create: { fetchedAt: at, clvReliable: kind === "invalid", ...(kind === "invalid"
        ? { clv: 8, closingPriceSnapshot: { version: 1, combination: "single", components: [] } } : {}) } },
    } });
    const detail = (await getBankrollDetail(bank.slug))!;
    const coverage = baseAlcancavel(detail.bets, situacaoDoClv);
    expect(coverage.base).toHaveLength(1);
    expect(coverage.cedo).toHaveLength(0);
    expect(detail.resumo).toMatchObject({ clvBase: 1, clvSamples: 0, clv: null });
  });
});

describe("getBankrollDetail (Postgres real) — resumo idêntico + médias escopadas", () => {
  it("o resumo do detalhe bate com o do summary e as médias são da banca", async () => {
    await seed();
    const detail = await getBankrollDetail("alpha");
    expect(detail).not.toBeNull();
    expect(detail!.resumo.slug).toBe("alpha");
    expect(detail!.resumo.lucro).toBeCloseTo(0.5, 6);
    expect(detail!.resumo.clv!).toBeCloseTo(1, 6);
    expect(detail!.clvMedio!).toBeCloseTo(1, 6); // avg SQL clv reliable [3,-1]
    expect(detail!.historyTotal).toBe(detail!.resumo.apostas);
    expect(detail!.bets).toHaveLength(5);
  });

  it("as removidas vêm à parte, com a remoção de cada uma; a restaurada volta às apostas", async () => {
    const { alpha, beta, mk } = await seed();
    const a1 = await db.prisma.bet.findFirstOrThrow({ where: { sourceExternalId: "a1" } });
    const a3 = await db.prisma.bet.findFirstOrThrow({ where: { sourceExternalId: "a3" } });
    await softDeleteBet({ betId: a1.id, actor: "telegram-user:1", motivo: "nao_peguei (👎)", origin: "reacao" });
    await softDeleteBet({ betId: a3.id, actor: "fabricio", motivo: "Exclusão manual pelo painel", origin: "painel" });
    await mk(beta.id, "b-removida", { status: "PENDING", deletedAt: new Date() });

    const detail = (await getBankrollDetail("alpha"))!;
    expect(detail.bets.map((bet) => bet.id)).not.toContain(a1.id);
    expect(detail.removed.total).toBe(2);
    expect(detail.removed.bets.map((bet) => [bet.id, bet.removal.origin, bet.removal.restorable, bet.removal.previous])
      .sort(([, a], [, b]) => String(a).localeCompare(String(b)))).toEqual([
      [a3.id, "painel", true, { status: "PENDING", lucro: 0 }],
      [a1.id, "reacao", true, { status: "WON", lucro: 1 }],
    ]);
    // A ficha da removida abre, só de leitura.
    expect((await getBetDetail(a1.id))?.status).toBe("CANCELED");

    await restoreBetsInBatch({ bankrollId: alpha.id, betIds: [a1.id], actor: "fabricio" });
    const after = (await getBankrollDetail("alpha"))!;
    expect(after.removed).toMatchObject({ total: 1, bets: [{ id: a3.id }] });
    expect(after.bets.map((bet) => bet.id)).toContain(a1.id);
  });

  it("slug inexistente → null", async () => {
    await seed();
    expect(await getBankrollDetail("nao-existe")).toBeNull();
  });

  it("mantém PENDING antiga acessível mesmo fora das 300 apostas recentes", async () => {
    const { alpha } = await seed();
    await db.prisma.bet.createMany({
      data: Array.from({ length: 301 }, (_, index) => ({
        sportResolutionStatus: "CONFIRMED" as const,
        sportResolvedAt: new Date(),
        settledAt: new Date(Date.UTC(2027, 0, 1 + index)),
        bankrollId: alpha.id,
        data: new Date(Date.UTC(2027, 0, 1 + index)),
        evento: `Recente ${index} vs Rival`,
        esporte: "Soccer",
        mercado: "Total",
        selecao: "Under 2.5",
        odds: 1.9,
        stake: 1,
        status: "WON" as const,
        source: "test-cap",
        sourceExternalId: `recent-${index}`,
      })),
    });
    const antiga = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: alpha.id,
        data: new Date("2020-01-01T12:00:00Z"),
        evento: "Pendente Antiga vs Rival",
        esporte: "Soccer",
        mercado: "Total",
        selecao: "Under 2.5",
        odds: 1.9,
        stake: 1,
        status: "PENDING",
        source: "test-cap",
        sourceExternalId: "old-pending",
      },
    });

    const detail = await getBankrollDetail("alpha");
    expect(detail?.bets.some((bet) => bet.id === antiga.id)).toBe(true);
    expect(detail?.bets.length).toBe(302);
  });
});

it("consolida pelo snapshot monetário de cada aposta, mesmo depois de alterar a unidade do tipster", async () => {
  const { aggregateTipsterMetrics } = await import("@/app/_design/lib/tipster-metrics");
  const { baseTipster } = await import("@/app/_design/adapters/_tipster");
  const { getBankrollEquityCurves } = await import("@/src/services/painel/queries/bankroll-curves");
  const { getResumoHoje } = await import("@/src/services/painel/queries/dashboard");
  const a = await db.prisma.bankroll.create({ data: { nome: "A", slug: "a", valorUnidade: 999 } });
  const b = await db.prisma.bankroll.create({ data: { nome: "B", slug: "b", valorUnidade: 777 } });
  const fixture = { evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A", odds: 2, data: new Date(), sportResolvedAt: new Date(), settledAt: new Date() };
  await db.prisma.bet.create({ data: { ...fixture, bankrollId: a.id, valorUnidade: 10, stake: 2, lucro: 2, status: "WON" } });
  await db.prisma.bet.create({ data: { ...fixture, bankrollId: b.id, valorUnidade: 100, stake: 1, lucro: -1, status: "LOST" } });
  // Nem as pendentes, anuladas ou removidas entram no lucro/stake fechado.
  await db.prisma.bet.create({ data: { ...fixture, bankrollId: a.id, valorUnidade: 400, stake: 1, settledAt: null } });
  await db.prisma.bet.create({ data: { ...fixture, bankrollId: a.id, valorUnidade: 400, stake: 1, status: "VOID" } });
  await db.prisma.bet.create({ data: { ...fixture, bankrollId: a.id, valorUnidade: 400, stake: 1, lucro: 1, status: "WON", deletedAt: new Date() } });
  const totals = aggregateTipsterMetrics((await getBankrollSummaries()).map(baseTipster));
  expect(totals).toMatchObject({ lucro: -80, staked: 120 });
  expect(totals.roi).toBeCloseTo(-200 / 3);
  const curves = await getBankrollEquityCurves();
  expect(curves.curves.slice().sort((a, b) => a.slug.localeCompare(b.slug)).map(c => c.accumulatedBrl)).toEqual([[20], [-100]]);
  expect((await getResumoHoje()).lucroDia).toBe(-80);
  await db.prisma.bet.create({ data: { ...fixture, bankrollId: a.id, valorUnidade: 20, stake: 1, lucro: 1, status: "WON" } });
  await db.prisma.bankroll.update({ where: { id: a.id }, data: { valorUnidade: 1234 } });
  expect(aggregateTipsterMetrics((await getBankrollSummaries()).map(baseTipster)))
    .toMatchObject({ lucro: -60, staked: 140 });
  expect((await getBankrollEquityCurves()).curves.slice().sort((a, b) => a.slug.localeCompare(b.slug)).map(c => c.accumulatedBrl)).toEqual([[40], [-100]]);
});

it("conserva o arredondamento por aposta da carteira, inclusive em parcelas abaixo de um micro-real", async () => {
  const { getBankrollEquityCurves } = await import("@/src/services/painel/queries/bankroll-curves");
  const bank = await db.prisma.bankroll.create({ data: { nome: "Precisão", slug: "precisao" } });
  const fixture = { bankrollId: bank.id, data: new Date("2026-06-10T20:00:00Z"), settledAt: new Date("2026-06-10T22:00:00Z"), evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A", odds: 2, sportResolvedAt: new Date() };
  await db.prisma.bet.createMany({ data: [
    { stake: 0.123457, lucro: 0.123457, valorUnidade: 33.33, status: "WON" as const },
    { stake: 0.123457, lucro: -0.123457, valorUnidade: 7.07, status: "LOST" as const },
    ...Array.from({ length: 3 }, () => ({ stake: 0.000001, lucro: 0.000001, valorUnidade: 0.49, status: "WON" as const })),
  ].map(bet => ({ ...fixture, ...bet })) });
  const [summary] = await getBankrollSummaries();
  expect(summary).toMatchObject({ profitBrl: 3.241981, stakedBrl: 4.987663 });
  expect((await getBankrollEquityCurves()).curves[0]?.accumulatedBrl).toEqual([3.241981]);
});

describe("acerto esportivo no histórico completo", () => {
  it("pondera meia ganha e perda, exclui cash-out e conserva a amostra além das 300 linhas", async () => {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Histórico", slug: "historico" } });
    const data = new Date("2026-06-10T20:00:00Z");
    await db.prisma.bet.createMany({ data: [
      { id: "old-half-win", status: "HALF_WON" as const, lucro: 0.5, data: new Date("2026-06-01T20:00:00Z") },
      { id: "old-loss", status: "LOST" as const, lucro: -1, data: new Date("2026-06-02T20:00:00Z") },
      ...Array.from({ length: 300 }, (_, i) => ({ id: `cash-${i}`, status: "CASHOUT" as const, lucro: 0.25, data })),
    ].map((b) => ({
      ...b, bankrollId: bankroll.id, evento: "A vs B", esporte: "Soccer", mercado: "Asian Handicap", selecao: "A -0.25",
      odds: 2, stake: 1, settledAt: b.data, source: "test", sourceExternalId: b.id,
      sportResolutionStatus: "CONFIRMED" as const, sportResolvedAt: b.data,
    })) });
    const detail = (await getBankrollDetail(bankroll.slug))!;
    expect(detail.historyTotal).toBe(302);
    expect(detail.bets).toHaveLength(300);
    expect(detail.bets.every((b) => b.status === "CASHOUT")).toBe(true);
    expect(detail.resumo.acerto).toBeCloseTo(100 / 3);
    expect(detail.resumo.lucro).toBe(74.5);
  });
});
