import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { enrichBetSharp } from "@/src/services/sharp/enrich/enrich-bet";
import { upsertSharp, markEnrichDeadLettered } from "@/src/services/sharp/enrich/upsert-sharp";

/**
 * Early-exit + anti-regressão UNMATCHED — jobs stale não batem Bridge.
 */

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
  process.env.BRIDGEODDS_URL ??= "https://fake.local";
  process.env.BRIDGEODDS_USER ??= "test";
  process.env.BRIDGEODDS_PASS ??= "test";
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
});

async function seed(params: {
  status?: "PENDING" | "WON";
  sharpMode?: "CLV_ONLY" | "OFF";
  kickoffInferido?: boolean;
  sharp?: {
    identityStatus: "PENDING" | "MATCHED" | "UNMATCHED" | "UNSUPPORTED" | "MANUAL";
    noOddsReason?: string | null;
    provider?: "bridgeodds" | "pinnacle17" | null;
  };
}) {
  const bankroll = await db.prisma.bankroll.create({
    data: {
      nome: "E",
      slug: `e-${Math.random().toString(36).slice(2, 8)}`,
      sharpMode: params.sharpMode ?? "CLV_ONLY",
    },
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: (params.status ?? "PENDING") === "PENDING"
        ? null
        : new Date("2026-07-11T12:00:00Z"),
      bankrollId: bankroll.id,
      data: new Date("2026-07-11T12:00:00Z"),
      evento: "Home vs Away",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Home",
      odds: 1.9,
      stake: 1,
      status: params.status ?? "PENDING",
      kickoffInferido: params.kickoffInferido ?? false,
      sharp: params.sharp
        ? {
            create: {
              identityStatus: params.sharp.identityStatus,
              provider: params.sharp.provider ?? null,
              confidence: 50,
              noOddsReason: params.sharp.noOddsReason ?? null,
            },
          }
        : undefined,
    },
  });
}

describe("enrich early-exit + upsert guards", () => {
  it("aposta WON fora da janela histórica: não chama Bridge", async () => {
    const bet = await seed({ status: "WON" });
    const query = vi.fn(async () => []);
    await enrichBetSharp(
      { betId: bet.id },
      { query: query as never, now: new Date("2026-08-20T12:00:00Z") },
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("múltipla de dois jogos não consulta Bridge", async () => {
    const bet = await seed({});
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: {
        evento: "Mogi das Cruzes vs Bauru | Bayamon vs Aguadas",
        selecao: "Mogi ML HT FT / Bayamon ML",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "Mogi das Cruzes vs Bauru", mercado: "Moneyline", selecao: "Mogi" },
            { evento: "Bayamon vs Aguadas", mercado: "Moneyline", selecao: "Bayamon" },
          ],
        },
      },
    });
    const query = vi.fn(async () => []);
    await enrichBetSharp({ betId: bet.id }, { query: query as never });
    expect(query).not.toHaveBeenCalled();
    await expect(db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } }))
      .resolves.toMatchObject({ identityStatus: "UNSUPPORTED", noOddsReason: "multipla" });
  });

  it("MATCHED não volta à Bridge: com a identidade feita, o preço fica para o fechamento", async () => {
    const bet = await seed({
      sharp: { identityStatus: "MATCHED", provider: "bridgeodds" },
    });
    await db.prisma.betSharp.update({
      where: { betId: bet.id },
      data: { providerMatchId: "1632128232" },
    });
    const query = vi.fn(async () => []);
    await enrichBetSharp({ betId: bet.id }, { query: query as never });
    expect(query).not.toHaveBeenCalled();
  });

  it("UNMATCHED sem kickoffInferido: não chama Bridge", async () => {
    const bet = await seed({
      sharp: { identityStatus: "UNMATCHED" },
    });
    const query = vi.fn(async () => []);
    await enrichBetSharp({ betId: bet.id }, { query: query as never });
    expect(query).not.toHaveBeenCalled();
  });

  it("upsert PENDING não reabre UNMATCHED", async () => {
    const bet = await seed({ sharp: { identityStatus: "UNMATCHED" } });
    await upsertSharp(bet.id, { identityStatus: "PENDING", confidence: 0 });
    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("UNMATCHED");
  });

  it.each(["MATCHED", "MANUAL"] as const)("upsert PENDING não regride %s", async (status) => {
    const bet = await seed({ sharp: { identityStatus: status } });
    await upsertSharp(bet.id, {
      identityStatus: "PENDING",
      confidence: 0,
      noOddsReason: "sport_pending",
    });
    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe(status);
    expect(sharp.noOddsReason).not.toBe("sport_pending");
  });

  it("upsert UNMATCHED não pisa MATCHED", async () => {
    const bet = await seed({
      sharp: { identityStatus: "MATCHED" },
    });
    await upsertSharp(bet.id, { identityStatus: "UNMATCHED", confidence: 0 });
    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("MATCHED");
  });

  it("markEnrichDeadLettered cria UNMATCHED + training case se não havia sharp", async () => {
    const bet = await seed({});
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { registradoEm: new Date("2026-07-10T10:00:00Z") },
    });
    await markEnrichDeadLettered(bet.id, new Date("2026-07-12T12:00:00Z"));
    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("UNMATCHED");
    expect(await db.prisma.trainingCase.count({ where: { betId: bet.id, status: "OPEN" } })).toBe(
      1,
    );
  });

  it("dead-letter antes do evento mantém PENDING para o revival", async () => {
    const bet = await seed({ sharp: { identityStatus: "PENDING" } });
    await markEnrichDeadLettered(bet.id, new Date("2026-07-10T12:00:00Z"));
    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("PENDING");
    expect(sharp.identityResolvedAt).toBeNull();
    expect(await db.prisma.trainingCase.count({ where: { betId: bet.id, status: "OPEN" } })).toBe(
      1,
    );
  });
});
