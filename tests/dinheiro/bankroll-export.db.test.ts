import type { Prisma } from "@/src/generated/prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/src/infra/prisma";
import { createTestDb, type TestDb } from "../helpers/db";
import { betRowToExportInput } from "@/src/services/painel/bet-export-map";
import { fetchAllBankrollBetsForExport, getBankrollBySlug } from "@/src/services/painel/queries/bankrolls";
import { BET_EXPORT_COLUMNS, buildBetExportCsv, buildBetExportTsv } from "@/src/domain/bet-export";
import { percentualContraFair } from "@/src/domain/odds";
import { unitsToReais } from "@/src/domain/money";
import { recomputePriceSnapshot, singlePriceSnapshot } from "@/src/domain/price-provenance";

const h = vi.hoisted(() => ({ user: "tester" }));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k === "x-auth-user" ? h.user : null),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { exportBankrollCsvAction } = await import("@/app/(painel)/tipsters/[slug]/actions");

let db: TestDb;
beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  h.user = "tester";
});

describe("fetchAllBankrollBetsForExport (Postgres real)", () => {
  it("mantém o snapshot completo quando kickoff, remoção e novas apostas mudam entre páginas", async () => {
    const bk = await db.prisma.bankroll.create({ data: { nome: "Cursor móvel", slug: "cursor-movel" } });
    await db.prisma.bet.createMany({ data: Array.from({ length: 1001 }, (_, index) => ({
      bankrollId: bk.id, data: new Date(Date.UTC(2026, 8, 1) + index * 60_000),
      evento: `Item ${index} vs Rival`, esporte: "Soccer", sportResolutionStatus: "CONFIRMED" as const,
      sportResolvedAt: new Date(), mercado: "Moneyline", selecao: "Casa", odds: 2, stake: 1,
    })) });
    const realTx = prisma.$transaction.bind(prisma);
    let moved = false;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => realTx(async (tx) => {
      const read = tx.bet.findMany.bind(tx.bet);
      const pageSpy = vi.spyOn(tx.bet, "findMany").mockImplementation((async (args) => {
        const rows = await read(args);
        if (!moved && args?.take === 500) {
          moved = true;
          await db.prisma.bet.update({ where: { id: (rows.at(-1) as { id: string }).id }, data: { data: new Date("2026-10-30T12:00:00Z") } });
          await db.prisma.bet.update({ where: { id: (rows[0] as { id: string }).id }, data: { deletedAt: new Date() } });
          await db.prisma.bet.create({ data: { bankrollId: bk.id, evento: "Nova vs Rival", esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), mercado: "Moneyline", selecao: "Casa", odds: 2, stake: 1, data: new Date("2026-10-31T12:00:00Z") } });
        }
        return rows;
      }) as typeof tx.bet.findMany);
      try { return await fn(tx); } finally { pageSpy.mockRestore(); }
    }, options)) as typeof prisma.$transaction);
    try {
      const rows = await fetchAllBankrollBetsForExport(bk.id);
      expect(await db.prisma.bet.count({ where: { bankrollId: bk.id } })).toBe(1002);
      expect(moved).toBe(true);
      expect(rows).toHaveLength(1001);
      expect(new Set(rows.map((row) => row.id)).size).toBe(1001);
      expect(rows.some((row) => row.evento === "Nova vs Rival")).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("traz histórico completo além do cap da ficha e mapeia sharp no CSV", async () => {
    const bk = await db.prisma.bankroll.create({
      data: { nome: "Export", slug: "export-bk", valorUnidade: 100, sharpMode: "CLV_ONLY" },
    });

    const aberturaSnapshot = singlePriceSnapshot({ rawOdds: [1.9, 2.02], selectedIndex: 0, devig: "power" });
    const abertura = recomputePriceSnapshot(aberturaSnapshot)!;
    // 5 apostas — ordem de data ASC no export
    for (let i = 0; i < 5; i++) {
      await db.prisma.bet.create({
        data: {
          sportResolutionStatus: "CONFIRMED",
          sportResolvedAt: new Date(),
          settledAt: i === 0 ? new Date(`2026-06-${10 + i}T20:00:00Z`) : null,
          bankrollId: bk.id,
          data: new Date(`2026-06-${10 + i}T20:00:00Z`),
          evento: `Time${i} vs Rival${i}`,
          esporte: "Soccer",
          competicao: "Serie A",
          pais: "Brazil",
          mercado: "Total – Match",
          selecao: "Over 2.5",
          casaDeAposta: "Bet365",
          tipster: "Will",
          odds: 1.9 + i * 0.01,
          stake: 1,
          status: i === 0 ? "WON" : "PENDING",
          lucro: i === 0 ? 0.9 : 0,
          source: "telegram-channel:-100",
          sourceExternalId: `exp-${i}`,
          sharp: {
            create: {
              identityStatus: "MATCHED",
              confidence: 90,
            },
          },
          ...(i === 0
            ? {
                opening: {
                  create: {
                    provider: "bridgeodds",
                    priceReference: "bridgeodds:v1:exp-0",
                    openingOdd: abertura.fair,
                    openingRawOdd: abertura.raw,
                    openingPriceSnapshot: aberturaSnapshot,
                    openingPriceObservedAt: new Date("2026-06-09T12:00:00Z"),
                  },
                },
                closing: {
                  create: {
                    closingOdd: 1.8,
                    clv: 5.5556,
                    clvReliable: true,
                    fetchedAt: new Date("2026-06-10T19:59:00Z"),
                  },
                },
              }
            : {}),
        },
      });
    }

    const rows = await fetchAllBankrollBetsForExport(bk.id);
    expect(rows).toHaveLength(5);
    expect(rows[0]?.evento).toContain("Time0");
    expect(rows[4]?.evento).toContain("Time4");

    const mapped = rows.map(betRowToExportInput);
    expect(mapped[0]?.clv).toBeCloseTo(5.5556, 5);
    expect(mapped[0]?.opening).toBeCloseTo(abertura.fair, 5);
    expect(mapped[0]?.identity).toBe("Casada");
    expect(mapped[0]?.origin).toBe("Canal Telegram");
    // PENDING sem closing congelado → CLV vazio
    expect(mapped[1]?.clv).toBeNull();
    expect(mapped[1]?.movimento).toBeNull();

    const csv = buildBetExportCsv(mapped);
    expect(csv).toContain(BET_EXPORT_COLUMNS.join(";"));
    expect(csv).toContain("Opening");
    expect(csv).toContain("Bet365");
    expect(csv).toContain("Will");

    const found = await getBankrollBySlug("export-bk");
    expect(found?.id).toBe(bk.id);
  });

  it("pagina mais de 500 registros pela ordem composta sem pular nem duplicar", async () => {
    const bk = await db.prisma.bankroll.create({
      data: { nome: "Export grande", slug: "export-grande", valorUnidade: 100 },
    });
    await db.prisma.bet.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        sportResolutionStatus: "CONFIRMED" as const,
        sportResolvedAt: new Date(),
        bankrollId: bk.id,
        // Datas repetidas e fora da ordem de insercao exercitam o desempate por id.
        data: new Date(index % 2 === 0 ? "2026-06-12T20:00:00Z" : "2026-06-10T20:00:00Z"),
        evento: `Export ${index} vs Rival`,
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Export",
        odds: 2,
        stake: 1,
      })),
    });

    const rows = await fetchAllBankrollBetsForExport(bk.id);
    expect(rows).toHaveLength(501);
    expect(new Set(rows.map((row) => row.id)).size).toBe(501);
    expect(rows.every((row, index) =>
      index === 0 || row.data.getTime() >= rows[index - 1]!.data.getTime()
    )).toBe(true);
  });
});

describe("exportBankrollCsvAction", () => {
  it("com sessão exporta; sem sessão falha", async () => {
    const bk = await db.prisma.bankroll.create({
      data: { nome: "CSV", slug: "csv-bk", valorUnidade: 100, sharpMode: "CLV_ONLY" },
    });
    await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bk.id,
        data: new Date("2026-07-01T20:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        status: "PENDING",
        source: "web",
        sourceExternalId: "csv-1",
      },
    });

    const exportado = await exportBankrollCsvAction("csv-bk");
    if (!exportado.ok) throw new Error(exportado.erro);
    expect(exportado.count).toBe(1);
    expect(exportado.filename).toBe("csv-bk-apostas.csv");
    expect(exportado.csv).toContain("Opening");
    expect(exportado.csv).toContain(";A;B;Soccer;");
    expect(exportado.csv).toContain("Manual (web)");
    // Banca excluída em outra aba: a recusa chega com o motivo.
    await expect(exportBankrollCsvAction("sumiu")).resolves.toEqual({ ok: false, erro: 'Tipster "sumiu" não encontrado.' });

    h.user = "";
    await expect(exportBankrollCsvAction("csv-bk")).rejects.toThrow(/Sessão inválida/);
  });
});

describe("reconstrução pelo arquivo exportado", () => {
  it("reconstitui preço, CLV, reais e horários sem a unidade atual nem o cache do fornecedor", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Reconstrução", slug: "reconstrucao", valorUnidade: 200 } });
    const snapshot = singlePriceSnapshot({ rawOdds: [1.87, 2.03], selectedIndex: 0, devig: "power" });
    const quote = recomputePriceSnapshot(snapshot)!;
    const at = new Date("2026-10-08T15:00:12.345Z");
    const clv = percentualContraFair(1.93, quote.fair)!;
    const bet = await db.prisma.bet.create({ data: {
      bankrollId: bank.id, valorUnidade: 50.25, data: at, registradoEm: new Date(at.getTime() - 3600000), sourcePostedAt: new Date(at.getTime() - 3600100),
      evento: "A vs B", esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: at,
      mercado: "Total", selecao: "Over 2.5", odds: 1.93, stake: 0.333333, status: "WON", lucro: 0.309999,
      settledAt: new Date(at.getTime() + 7200000), source: "web-manual", sourceExternalId: "pedido-reconstrucao",
      closing: { create: { closingOdd: quote.fair, closingRawOdd: quote.raw, closingPriceSnapshot: snapshot,
        closingPriceReference: "bridgeodds:v1:reconstrucao", closingPriceObservedAt: at, provider: "bridgeodds", clv,
        clvReliable: true, fetchedAt: at } },
    } });
    const [row] = await fetchAllBankrollBetsForExport(bank.id);
    const cells = buildBetExportTsv([betRowToExportInput(row!)]).split("\n")[1]!.split("\t");
    const cell = (key: typeof BET_EXPORT_COLUMNS[number]) => cells[BET_EXPORT_COLUMNS.indexOf(key)]!;
    const num = (key: typeof BET_EXPORT_COLUMNS[number]) => Number(cell(key).replace(",", "."));
    expect(cell("IdAposta")).toBe(bet.id);
    expect(cell("TipsterSlug")).toBe(bank.slug);
    expect(num("UnidadeHistorica")).toBe(50.25);
    expect(num("StakeReais")).toBe(unitsToReais(0.333333, 50.25));
    expect(num("LucroReais")).toBe(unitsToReais(0.309999, 50.25));
    expect(cell("KickoffISO")).toBe(at.toISOString());
    expect(cell("RegistradoISO")).toBe(bet.registradoEm.toISOString());
    expect(cell("PostISO")).toBe(bet.sourcePostedAt!.toISOString());
    expect(cell("ClosingProvider")).toBe("bridgeodds");
    expect(cell("ClosingReferencia")).toBe("bridgeodds:v1:reconstrucao");
    expect(cell("CLVConfiavel")).toBe("true");
    const recomputed = recomputePriceSnapshot(JSON.parse(cell("ClosingSnapshot")))!;
    expect(recomputed.fair).toBe(quote.fair);
    expect(num("Closing")).toBe(Number(quote.fair.toFixed(6)));
    expect(num("ClosingBruta")).toBe(quote.raw);
    expect(percentualContraFair(num("Odds"), recomputed.fair)).toBeCloseTo(num("CLV%"), 4);
  });
});
