import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createTestDb, type TestDb } from "../helpers/db";
import { upsertSharp } from "@/src/services/sharp/enrich/upsert-sharp";
import {
  recomputePriceSnapshot,
  singlePriceSnapshot,
} from "@/src/domain/price-provenance";

let db: TestDb;

beforeAll(() => {
  db = createTestDb({ strictPriceProvenance: true });
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
});

async function seedBet() {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Schema", slug: "schema" },
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date("2026-08-01T11:59:00Z"),
      bankrollId: bankroll.id,
      data: new Date("2026-08-01T12:00:00Z"),
      evento: "A vs B",
      esporte: "Soccer",
      mercado: "Total",
      selecao: "Under 2.5",
      odds: 1.9,
      stake: 1,
    },
  });
}

describe("invariantes SQL do schema", () => {
  it("mantém o índice parcial da fila de apostas pendentes ativas", async () => {
    const indexes = await db.prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'bets'
        AND indexname = 'bets_pending_active_data_idx'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.indexdef).toContain("status");
    expect(indexes[0]!.indexdef).toContain("PENDING");
    expect(indexes[0]!.indexdef).toContain("deletedAt");
  });

  it("CONFIRMED exige sportResolvedAt e estado pendente exige null", async () => {
    const bet = await seedBet();
    await expect(
      db.prisma.bet.update({
        where: { id: bet.id },
        data: { sportResolvedAt: null },
      }),
    ).rejects.toThrow();

    await db.prisma.bet.update({
      where: { id: bet.id },
      data: {
        esporte: "Unknown",
        sportResolutionStatus: "PENDING",
        sportConfidence: 0,
        sportSource: "UNRESOLVED",
        sportResolvedAt: null,
      },
    });
    await expect(
      db.prisma.bet.update({
        where: { id: bet.id },
        data: { sportResolvedAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it("status terminal exige settledAt e PENDING exige null", async () => {
    const bet = await seedBet();

    await expect(
      db.prisma.$executeRawUnsafe(
        `UPDATE "bets" SET "status" = 'WON' WHERE "id" = $1`,
        bet.id,
      ),
    ).rejects.toThrow();

    const settledAt = new Date("2026-08-01T16:00:00Z");
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { status: "WON", lucro: 0.9, settledAt },
    });
    await expect(
      db.prisma.$executeRawUnsafe(
        `UPDATE "bets" SET "status" = 'PENDING' WHERE "id" = $1`,
        bet.id,
      ),
    ).rejects.toThrow();
  });

  it("referência de preço do sharp só entra em formato conhecido", async () => {
    const bet = await seedBet();
    await upsertSharp(bet.id, {
      identityStatus: "MATCHED", confidence: 100, provider: "pinnacle17",
      providerMatchId: "1634172613",
      priceReference: "pinnacle17:v1:1634172613:0:moneyline:ml:home",
    }, db.prisma);
    // Aqui mora só o ponteiro do evento, e torto ele faz o fechamento pedir
    // preço no evento errado.
    await expect(db.prisma.$executeRawUnsafe(
      `UPDATE "bet_sharp" SET "priceReference" = 'bridgeodds:v1:1634172613' WHERE "betId" = $1`,
      bet.id,
    )).rejects.toThrow(/bet_sharp_price_reference_check/);
    await expect(db.prisma.$executeRawUnsafe(
      `UPDATE "bet_sharp" SET provider = NULL WHERE "betId" = $1`,
      bet.id,
    )).rejects.toThrow(/bet_sharp_price_reference_check/);
    // Sem referência nenhuma continua válido: identidade casada pode não ter
    // evento precificável.
    await expect(db.prisma.$executeRawUnsafe(
      `UPDATE "bet_sharp" SET "priceReference" = NULL WHERE "betId" = $1`,
      bet.id,
    )).resolves.toBe(1);
  });

  it("o SharpMode tem só CLV_ONLY, IDENTITY_ONLY e OFF, e bet_sharp não guarda preço de entrada", async () => {
    const modos = await db.prisma.$queryRaw<Array<{ modo: string }>>`
      SELECT unnest(enum_range(NULL::"SharpMode"))::text AS modo`;
    expect(modos.map((m) => m.modo).sort()).toEqual(["CLV_ONLY", "IDENTITY_ONLY", "OFF"]);
    const colunas = await db.prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'bet_sharp'`;
    const nomes = colunas.map((c) => c.column_name);
    for (const antiga of ["evEntrada", "evAbertura", "entryFairOdd", "listedAtEntry", "openingOdd", "houseEdgeBps"]) {
      expect(nomes).not.toContain(antiga);
    }
  });

  it.each(["pinnacle17:v1:1634172613:0:moneyline:ml:home", "pinnacle17:v2:1634172613:0:moneyline:ml:home:sets"])("aceita proveniência Pinnacle17 tipada no fechamento: %s", async reference => {
    const bet = await seedBet();
    const snapshot = singlePriceSnapshot({ rawOdds: [1.9, 2.02], selectedIndex: 0, devig: "power" });
    const price = recomputePriceSnapshot(snapshot)!;
    const observedAt = new Date("2026-08-25T18:55:00Z");
    await upsertSharp(bet.id, {
      identityStatus: "MATCHED",
      confidence: 100,
      provider: "pinnacle17",
      providerMatchId: "1634172613",
      priceReference: reference,
    }, db.prisma);
    await db.prisma.betClosing.create({ data: {
      betId: bet.id,
      closingOdd: price.fair,
      closingRawOdd: price.raw,
      closingPriceSnapshot: snapshot,
      closingPriceReference: reference,
      closingPriceObservedAt: observedAt,
      provider: "pinnacle17",
      fetchedAt: observedAt,
      clv: 1,
      clvReliable: true,
    } });
    expect((await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } })).provider)
      .toBe("pinnacle17");
    await expect(db.prisma.$executeRawUnsafe(
      `UPDATE "bet_closing" SET "provider" = NULL WHERE "betId" = $1`,
      bet.id,
    )).rejects.toThrow(/bet_closing_price_provenance_check/);
  });

  it("confianças rejeitam valores fora de 0..100 e 0..1 via SQL direto", async () => {
    const bet = await seedBet();
    await db.prisma.betSharp.create({ data: { betId: bet.id, confidence: 50 } });
    await db.prisma.betClosing.create({ data: { betId: bet.id } });
    const trainingCase = await db.prisma.trainingCase.create({
      data: {
        betId: bet.id,
        evento: bet.evento,
        esporte: bet.esporte,
        candidatesJson: [],
        autoScore: 50,
      },
    });

    const invalidIntConfidence = [
      ["bet_sharp", "betId", bet.id, "confidence"],
      ["training_cases", "id", trainingCase.id, "autoScore"],
    ] as const;
    for (const [table, key, id, column] of invalidIntConfidence) {
      for (const value of [-1, 101]) {
        await expect(
          db.prisma.$executeRawUnsafe(
            `UPDATE "${table}" SET "${column}" = ${value} WHERE "${key}" = $1`,
            id,
          ),
          `${table}.${column}=${value}`,
        ).rejects.toThrow();
      }
    }

    for (const value of [-0.01, 1.01]) {
      await expect(
        db.prisma.$executeRawUnsafe(
          `UPDATE "bet_closing" SET "resultMatchConfidence" = ${value} WHERE "betId" = $1`,
          bet.id,
        ),
        `bet_closing.resultMatchConfidence=${value}`,
      ).rejects.toThrow();
    }
  });

  // Conexão sem as marcas do pool, como a de um psql ou script à parte: os
  // CHECKs recusam em vez de algum trigger reescrever a linha.
  it("escrita fora do pool é recusada pelos CHECKs, sem reparo silencioso", async () => {
    const bet = await seedBet();
    await db.prisma.betClosing.create({ data: { betId: bet.id } });
    const avulsa = new Client({ connectionString: process.env.DATABASE_URL });
    await avulsa.connect();
    try {
      const { rows: [marca] } = await avulsa.query<{ contrato: string | null }>(
        "SELECT current_setting('automabaca.writer_contract', true) AS contrato",
      );
      expect(marca?.contrato ?? "").toBe("");
      const { rows: [restos] } = await avulsa.query<{ n: number }>(`
        SELECT (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%compat%')::int
             + (SELECT count(*) FROM pg_proc WHERE proname LIKE 'automabaca_compat_%')::int AS n
      `);
      expect(restos?.n).toBe(0);

      await expect(avulsa.query(
        `UPDATE "bets" SET "status" = 'WON' WHERE "id" = $1`, [bet.id],
      )).rejects.toThrow(/bets_status_settled_at_check/);
      await expect(avulsa.query(
        `INSERT INTO "training_cases" ("id", "evento", "esporte", "autoScore") VALUES ('tc-fora', 'A vs B', 'Soccer', 101)`,
      )).rejects.toThrow(/training_cases_auto_score_check/);
      await expect(avulsa.query(
        `UPDATE "bet_closing" SET "resultMatchConfidence" = 1.5 WHERE "betId" = $1`, [bet.id],
      )).rejects.toThrow(/bet_closing_result_match_confidence_check/);
      await expect(avulsa.query(
        `UPDATE "bet_closing" SET "closingOdd" = 1.9, "closingRawOdd" = 1.95 WHERE "betId" = $1`, [bet.id],
      )).rejects.toThrow(/bet_closing_price_provenance_check/);
    } finally {
      await avulsa.end();
    }
  });
});
