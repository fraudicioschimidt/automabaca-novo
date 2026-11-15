import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { reopenSharpIdentityAfterKickoffChange } from "@/src/services/sharp/kickoff-revive";

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

describe("kickoff revive de identidade já confirmada", () => {
  it("preserva MATCHED e seu providerMatchId após mudança material", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Kickoff", slug: "kickoff", sharpMode: "CLV_ONLY" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: new Date("2026-08-10T18:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        sharp: {
          create: {
            identityStatus: "MATCHED",
            confidence: 95,
            provider: "bridgeodds",
            providerMatchId: "123",
          },
        },
      },
    });

    await expect(reopenSharpIdentityAfterKickoffChange({
      betId: bet.id,
      anterior: new Date("2026-08-10T18:00:00Z"),
      novo: new Date("2026-08-10T21:00:00Z"),
    })).resolves.toEqual({ reopened: false, reason: "already_matched" });
    await expect(db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } }))
      .resolves.toMatchObject({ identityStatus: "MATCHED", providerMatchId: "123" });
  });
});

describe("kickoff revive de identidade encerrada", () => {
  it("devolve a identidade ao enrich e abre o caso para o dono", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Kickoff", slug: "kickoff", sharpMode: "CLV_ONLY" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), bankrollId: bankroll.id,
        data: new Date("2026-08-10T18:00:00Z"), evento: "A vs B", esporte: "Soccer", mercado: "Moneyline",
        selecao: "A", odds: 2, stake: 1, status: "PENDING",
        sharp: { create: { identityStatus: "UNMATCHED", confidence: 0 } },
      },
    });

    await expect(reopenSharpIdentityAfterKickoffChange({
      betId: bet.id,
      anterior: new Date("2026-08-10T18:00:00Z"),
      novo: new Date("2026-08-10T21:00:00Z"),
    })).resolves.toMatchObject({ reopened: true });
    await expect(db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } }))
      .resolves.toMatchObject({ identityStatus: "PENDING" });
    await expect(db.prisma.trainingCase.findFirstOrThrow({ where: { betId: bet.id, status: "OPEN" } }))
      .resolves.toMatchObject({
        evento: "A vs B",
        llmVerdictJson: { source: "matching", reason: "kickoff_changed_reopened" },
      });
  });
});
