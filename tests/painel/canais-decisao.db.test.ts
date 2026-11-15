import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getBankrollsData } from "@/app/_design/adapters/bankrolls";
import { compareTipstersByKey } from "@/app/_design/lib/tipster-metrics";
import { computeDecisaoCanal } from "@/src/domain/analyzer/decisao";
import { getCanaisDecisao } from "@/src/services/painel/canais";
import { fetchAllBankrollBetsForExport, getBankrollSummaries } from "@/src/services/painel/queries/bankrolls";
import { getSinceLastVisit } from "@/src/services/painel/queries/dashboard";
import { readAnalyzer } from "@/src/services/painel/queries/analyzer";
import { parseAnalyzerQuery } from "@/src/domain/analyzer-query";
import { singlePriceSnapshot } from "@/src/domain/price-provenance";
import { createTestDb, type TestDb } from "../helpers/db";

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

describe("getCanaisDecisao — agregado SQL equivalente", () => {
  it("preserva as métricas do cálculo de referência sem hidratar apostas", async () => {
    const ref = new Date("2026-08-01T12:00:00Z");
    const bankroll = await db.prisma.bankroll.create({
      data: {
        nome: "Canal SQL",
        slug: "canal-sql",
        valorUnidade: 100,
        telegramChannelId: 123n,
      },
    });
    const fixtures = [
      {
        date: new Date("2026-07-28T12:00:00Z"),
        status: "WON" as const,
        stake: 1,
        lucro: 0.9,
        clv: 4,
        reliable: true,
      },
      {
        // Jogo nos 30 dias anteriores, liquidado dentro dos últimos 30.
        date: new Date("2026-06-20T12:00:00Z"),
        settledAt: new Date("2026-07-15T12:00:00Z"),
        status: "LOST" as const,
        stake: 2,
        lucro: -2,
        clv: -6,
        reliable: true,
      },
      {
        // 02h59 UTC de 03/07 ainda é 02/07 em São Paulo: último dia da janela anterior.
        date: new Date("2026-07-03T02:59:00Z"),
        status: "WON" as const,
        stake: 1,
        lucro: 0.9,
        clv: 2,
        reliable: true,
      },
      {
        date: new Date("2026-06-15T12:00:00Z"),
        status: "PENDING" as const,
        stake: 1,
        lucro: 0,
        clv: 8,
        reliable: null,
      },
      {
        date: new Date("2026-07-29T12:00:00Z"),
        status: "WON" as const,
        stake: 10,
        lucro: 9,
        clv: null,
        reliable: null,
      },
      {
        date: new Date("2026-07-30T12:00:00Z"),
        status: "WON" as const,
        stake: 10,
        lucro: 9,
        clv: 100,
        reliable: null,
      },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      await db.prisma.bet.create({
        data: {
          sportResolutionStatus: "CONFIRMED",
          sportResolvedAt: new Date(),
          bankrollId: bankroll.id,
          data: fixture.date,
          settledAt: fixture.status === "PENDING" ? null : (fixture.settledAt ?? fixture.date),
          evento: `Time ${index} vs Rival`,
          esporte: "Soccer",
          mercado: "Total",
          selecao: "Over 2.5",
          odds: 1.9,
          stake: fixture.stake,
          status: fixture.status,
          lucro: fixture.lucro,
          sharp: {
            create: {
              identityStatus: "MATCHED",
              confidence: 95,
            },
          },
          closing: {
            create: {
              clv: fixture.clv,
              clvReliable: fixture.reliable,
              fetchedAt: fixture.date,
            },
          },
        },
      });
    }

    const expected = computeDecisaoCanal(
      fixtures.map((fixture) => ({
        data: fixture.date,
        status: fixture.status,
        stake: fixture.stake,
        lucro: fixture.lucro,
        clv: fixture.clv,
        clvReliable: fixture.reliable,
        closingFetchedAt: fixture.date,
      })),
      ref,
    );
    const actual = (await getCanaisDecisao(ref)).find(
      (row) => row.id === bankroll.id,
    )?.decisao;

    expect(expected.nClv).toBe(3);
    expect([expected.n30d, expected.n30a60d]).toEqual([1, 2]);
    expect(expected.deltaClv30d).toBeCloseTo(4 - (-6 + 2) / 2);
    expect(actual).toBeDefined();
    expect(actual).toEqual({
      ...expected,
      roiReal: expect.closeTo(expected.roiReal ?? 0, 10),
      clvMedio: expect.closeTo(expected.clvMedio ?? 0, 10),
      clv30d: expect.closeTo(expected.clv30d ?? 0, 10),
      deltaClv30d:
        expected.deltaClv30d === null
          ? null
          : expect.closeTo(expected.deltaClv30d, 10),
      tStat:
        expected.tStat === null
          ? null
          : expect.closeTo(expected.tStat, 10),
    });
  });

  it("notTakenAt sem deletedAt (e exclusão só do painel) ficam fora da amostra de edge", async () => {
    const ref = new Date("2026-08-01T12:00:00Z");
    const bankroll = await db.prisma.bankroll.create({
      data: {
        nome: "Canal 👎",
        slug: "canal-nao-peguei",
        valorUnidade: 100,
        telegramChannelId: 456n,
      },
    });
    const data = new Date("2026-07-28T12:00:00Z");
    const seed = (evento: string, over: {
      status: "WON" | "CANCELED";
      lucro: number;
      clv: number;
      deletedAt?: Date | null;
      notTakenAt?: Date | null;
    }) => db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data,
        settledAt: data,
        evento,
        esporte: "Soccer",
        mercado: "Total",
        selecao: "Over 2.5",
        odds: 1.9,
        stake: 1,
        status: over.status,
        lucro: over.lucro,
        deletedAt: over.deletedAt ?? null,
        notTakenAt: over.notTakenAt ?? null,
        sharp: {
          create: {
            identityStatus: "MATCHED",
            confidence: 95,
          },
        },
        closing: {
          create: { clv: over.clv, clvReliable: true, fetchedAt: data },
        },
      },
    });
    // Isola o predicado de notTakenAt: sem deletedAt, só notTakenAt. Uma guarda
    // só por deletedAt IS NULL deixaria esta linha contaminar nClv/nFinal.
    await seed("Time A vs Time B", {
      status: "WON",
      lucro: 0.9,
      clv: 80,
      notTakenAt: data,
    });
    await seed("Time C vs Time D", {
      status: "CANCELED",
      lucro: 0,
      clv: 50,
      deletedAt: data,
    });
    await seed("Time E vs Time F", {
      status: "WON",
      lucro: 0.9,
      clv: 4,
    });

    const actual = (await getCanaisDecisao(ref)).find((row) => row.id === bankroll.id)?.decisao;
    expect(actual?.nClv).toBe(1);
    expect(actual?.clvMedio).toBeCloseTo(4);
    expect(actual?.nFinal).toBe(1);
  });

  it("com bankrollId devolve só a decisão daquela banca, igual à da lista", async () => {
    const a = await db.prisma.bankroll.create({ data: { nome: "A", slug: "canal-a", valorUnidade: 10 } });
    const b = await db.prisma.bankroll.create({ data: { nome: "B", slug: "canal-b", valorUnidade: 10 } });
    const data = new Date("2026-07-28T12:00:00Z");
    for (const [bankrollId, clv] of [[a.id, 3], [b.id, 7]] as const) {
      await db.prisma.bet.create({
        data: {
          sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), bankrollId, data, settledAt: data,
          evento: "X vs Y", esporte: "Soccer", mercado: "Total", selecao: "Over 2.5", odds: 1.9, stake: 1,
          status: "WON", lucro: 0.9, closing: { create: { clv, clvReliable: true, fetchedAt: data } },
        },
      });
    }
    const todas = await getCanaisDecisao(new Date("2026-08-01T12:00:00Z"));
    const soA = await getCanaisDecisao(new Date("2026-08-01T12:00:00Z"), { bankrollId: a.id });
    expect(soA.map((row) => row.id)).toEqual([a.id]);
    expect(soA[0]!.decisao).toEqual(todas.find((row) => row.id === a.id)!.decisao);
  });
});

describe("coerência da fórmula do CLV", () => {
  it.each([15, -5, 0])("preço válido não torna confiável um CLV divergente (%s)", async (clv) => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Fórmula", slug: "formula" } });
    const at = new Date("2026-10-09T12:00:00Z");
    await db.prisma.bet.create({ data: {
      bankrollId: bank.id, data: at, evento: "A vs B", esporte: "Soccer", mercado: "Total", selecao: "Over 2.5",
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: at, odds: 2.1, stake: 1, status: "WON", lucro: 1.1, settledAt: at,
      closing: { create: { closingOdd: 2, closingRawOdd: 2, clv, clvReliable: true, fetchedAt: at, updatedAt: at,
        provider: "bridgeodds", closingPriceReference: "bridgeodds:v1:formula", closingPriceObservedAt: at,
        closingPriceSnapshot: singlePriceSnapshot({ rawOdds: [2, 2], selectedIndex: 0, devig: "power", lineQ: 10 }) } },
    } });
    const [detail] = await fetchAllBankrollBetsForExport(bank.id);
    expect(detail).toMatchObject({ closingOdd: 2, clv: null, clvReliable: false });
    const analyzer = await readAnalyzer(bank.id, parseAnalyzerQuery(), "2026-10-09");
    expect(analyzer.rows[0]).toMatchObject({ clv: null, clvReliable: false });
    expect((await getCanaisDecisao(at))[0]?.decisao.nClv).toBe(0);
    expect((await getBankrollSummaries())[0]).toMatchObject({ clv: null, clvSamples: 0 });
    expect(await getSinceLastVisit(new Date(at.getTime() - 1), at)).toMatchObject({ closings: 0, clvMean: null });
  });
});

describe("evidência dos agregados", () => {
  it.each([
    { version: 1, combination: "single", components: [] },
    { version: 1, combination: "single", components: [{ lineQ: null, rawOdds: [1.8, 2.2], selectedIndex: 0, devig: "power" }] },
  ])("snapshot irreproduzível não sustenta CLV no agregado, na cobertura ou no dashboard (%j)", async (snapshot) => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Evidência", slug: "evidencia" } });
    const at = new Date("2026-10-09T12:00:00Z");
    await db.prisma.bet.create({ data: {
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: at, bankrollId: bank.id, data: at, evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "Casa",
      odds: 2, stake: 1, status: "WON", lucro: 1, settledAt: at,
      closing: { create: { clv: 8, clvReliable: true, fetchedAt: at, updatedAt: at,
        closingPriceSnapshot: snapshot } },
    } });
    const [detail] = await fetchAllBankrollBetsForExport(bank.id);
    expect(detail?.clv).toBeNull();
    const [decision] = await getCanaisDecisao(at);
    expect(decision?.decisao.nClv).toBe(0);
    const [summary] = await getBankrollSummaries();
    expect(summary).toMatchObject({ clv: null, clvSamples: 0, clvBase: 1 });
    expect(await getSinceLastVisit(new Date(at.getTime() - 1), at)).toMatchObject({ closings: 0, clvMean: null });
  });
});

describe("validação paginada da prova", () => {
  it("valida também além dos primeiros 500 fechamentos sem truncar o agregado", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Páginas", slug: "paginas" } });
    const at = new Date("2026-10-09T12:00:00Z");
    await db.prisma.bet.createMany({ data: Array.from({ length: 501 }, (_, i) => ({
      id: `proof-${String(i).padStart(3, "0")}`, bankrollId: bank.id, data: at, evento: "A vs B", esporte: "Soccer",
      sportResolutionStatus: "CONFIRMED" as const, sportResolvedAt: at, mercado: "Total", selecao: "Over 2.5", odds: 2, stake: 1,
    })) });
    await db.prisma.betClosing.createMany({ data: Array.from({ length: 501 }, (_, i) => ({
      betId: `proof-${String(i).padStart(3, "0")}`, clv: 4, clvReliable: true, fetchedAt: at,
      ...(i === 500 ? { closingPriceSnapshot: { version: 1, combination: "single", components: [] } } : {}),
    })) });
    const [decision] = await getCanaisDecisao(at);
    expect(decision?.decisao).toMatchObject({ apostas: 501, nClv: 500, clvMedio: 4 });
  });
});

describe("o ranking da tela preserva a evidência do banco", () => {
  it.each([
    { scenario: "desempate abaixo da precisão de exibição", firstCount: 30, firstClv: 2.01, secondCount: 30, secondClv: 2.04 },
    { scenario: "sem fechamento contra CLV negativo medido", firstCount: 0, firstClv: 0, secondCount: 1, secondClv: -2 },
  ])("$scenario", async ({ firstCount, firstClv, secondCount, secondClv }) => {
    const date = new Date("2026-08-01T12:00:00Z");
    for (const [name, count, clv] of [["Alfa", firstCount, firstClv], ["Zeta", secondCount, secondClv]] as const) {
      const bankroll = await db.prisma.bankroll.create({ data: {
        nome: name, slug: name.toLowerCase(), valorUnidade: 100, sharpMode: "CLV_ONLY",
      } });
      for (let i = 0; i < count; i++) {
        await db.prisma.bet.create({ data: {
          bankrollId: bankroll.id, sportResolutionStatus: "CONFIRMED", sportResolvedAt: date,
          data: date, registradoEm: new Date("2026-08-01T10:00:00Z"), settledAt: date,
          evento: `Time ${i} vs Rival`, esporte: "Soccer", mercado: "Total", selecao: "Over 2.5",
          odds: 2, stake: 1, status: "WON", lucro: 1,
          closing: { create: { clv, clvReliable: true, fetchedAt: date } },
        } });
      }
    }
    expect((await getCanaisDecisao()).map((row) => row.nome)).toEqual(["Zeta", "Alfa"]);
    const { tipsters } = await getBankrollsData();
    expect([...tipsters].sort((a, b) => compareTipstersByKey(a, b, "decisao")).map((row) => row.name))
      .toEqual(["Zeta", "Alfa"]);
  });
});
