import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  markEnrichDeadLettered,
  upsertSharp,
} from "@/src/services/sharp/enrich/upsert-sharp";

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

async function createBet(
  ext: string,
  overrides?: { data?: Date; status?: "PENDING" | "WON"; registradoEm?: Date },
) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: `B-${ext}`, slug: `b-${ext}`, valorUnidade: 100, sharpMode: "CLV_ONLY" },
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      data: overrides?.data ?? new Date("2026-06-10T20:00:00Z"),
      registradoEm: overrides?.registradoEm ?? new Date("2026-06-10T19:00:00Z"),
      evento: "Time A vs Time B",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Time A",
      odds: 2,
      stake: 1,
      status: overrides?.status ?? "PENDING",
      source: "test",
      sourceExternalId: ext,
    },
  });
}

describe("upsertSharp (Atomic guards & P2002 Concurrency Handling)", () => {
  it("cria registro inicial como PENDING", async () => {
    const bet = await createBet("pending-init");
    await upsertSharp(bet.id, {
      identityStatus: "PENDING",
      confidence: 0,
    });

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({
      where: { betId: bet.id },
    });
    expect(sharp.identityStatus).toBe("PENDING");
    expect(sharp.identityResolvedAt).toBeNull();
  });

  it("não regride MATCHED para PENDING quando PENDING tenta gravar concorrentemente", async () => {
    const bet = await createBet("regress-pending");
    // Outra thread já resolveu a identidade para MATCHED
    await upsertSharp(bet.id, {
      identityStatus: "MATCHED",
      provider: "pinnacle17",
      providerMatchId: "match-123",
      confidence: 95,
    });

    // Thread atrasada tenta salvar PENDING (cai no P2002 se tentar create, ou updateMany retorna 0)
    await upsertSharp(bet.id, {
      identityStatus: "PENDING",
      confidence: 0,
    });

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({
      where: { betId: bet.id },
    });
    expect(sharp.identityStatus).toBe("MATCHED");
    expect(sharp.providerMatchId).toBe("match-123");
  });

  it("não regride UNSUPPORTED para PENDING nem para UNMATCHED", async () => {
    const bet = await createBet("unsupported-guard");
    await upsertSharp(bet.id, {
      identityStatus: "UNSUPPORTED",
      confidence: 0,
    });

    await upsertSharp(bet.id, {
      identityStatus: "PENDING",
      confidence: 0,
    });

    await upsertSharp(bet.id, {
      identityStatus: "UNMATCHED",
      confidence: 0,
    });

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({
      where: { betId: bet.id },
    });
    expect(sharp.identityStatus).toBe("UNSUPPORTED");
  });

  it("não sobrescreve UNSUPPORTED com MATCHED em concorrência tardia", async () => {
    const bet = await createBet("unsupported-matched");
    await upsertSharp(bet.id, {
      identityStatus: "UNSUPPORTED",
      confidence: 0,
    });

    await upsertSharp(bet.id, {
      identityStatus: "MATCHED",
      provider: "pinnacle17",
      providerMatchId: "match-999",
      confidence: 90,
    });

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({
      where: { betId: bet.id },
    });
    expect(sharp.identityStatus).toBe("UNSUPPORTED");
  });

  it("promove PENDING para MATCHED com sucesso", async () => {
    const bet = await createBet("pending-to-matched");
    await upsertSharp(bet.id, {
      identityStatus: "PENDING",
      confidence: 0,
    });

    await upsertSharp(bet.id, {
      identityStatus: "MATCHED",
      provider: "pinnacle17",
      providerMatchId: "match-456",
      confidence: 90,
    });

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({
      where: { betId: bet.id },
    });
    expect(sharp.identityStatus).toBe("MATCHED");
    expect(sharp.identityResolvedAt).not.toBeNull();
  });

  it("markEnrichDeadLettered: trata colisão P2002 sem quebrar e não sobrescreve MATCHED concorrente", async () => {
    const bet = await createBet("dlq-p2002-matched");

    // Simulando que bet foi carregada sem sharp (before = null),
    // mas antes do create de DLQ, outra thread insere MATCHED no banco
    await db.prisma.betSharp.create({
      data: {
        betId: bet.id,
        identityStatus: "MATCHED",
        provider: "pinnacle17",
        providerMatchId: "match-race",
        confidence: 99,
        identityResolvedAt: new Date(),
      },
    });

    // markEnrichDeadLettered tenta criar e colide em P2002
    await expect(
      markEnrichDeadLettered(bet.id, new Date()),
    ).resolves.not.toThrow();

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({
      where: { betId: bet.id },
    });
    // O MATCHED deve ter sido preservado
    expect(sharp.identityStatus).toBe("MATCHED");
    expect(sharp.providerMatchId).toBe("match-race");
  });

  it("markEnrichDeadLettered: trata colisão P2002 quando concorrente criou PENDING", async () => {
    const now = new Date("2026-06-10T23:00:00Z");
    const bet = await createBet("dlq-p2002-pending", { data: new Date("2026-06-10T20:00:00Z") });

    // Outra thread criou PENDING
    await db.prisma.betSharp.create({
      data: {
        betId: bet.id,
        identityStatus: "PENDING",
        confidence: 0,
      },
    });

    // Como bet é do passado (>30m de kickoff), targetStatus é UNMATCHED
    await expect(
      markEnrichDeadLettered(bet.id, now),
    ).resolves.not.toThrow();

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({
      where: { betId: bet.id },
    });
    expect(sharp.identityStatus).toBe("UNMATCHED");
  });
});

describe("upsertSharp não degrada identidade resolvida", () => {
  it("UNSUPPORTED não degrada linha MATCHED existente", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Sharp Test", slug: "sharp-test" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        evento: "Flamengo vs Fluminense",
        esporte: "Futebol",
        competicao: "Carioca",
        pais: "Brasil",
        mercado: "Match Odds",
        selecao: "Flamengo",
        odds: 2.0,
        stake: 1.0,
        status: "PENDING",
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        data: new Date(),
        registradoEm: new Date(),
      },
    });

    // Cria como MATCHED
    await db.prisma.betSharp.create({
      data: {
        betId: bet.id,
        identityStatus: "MATCHED",
        provider: "bridgeodds",
        providerMatchId: "match-flamengo-1",
        confidence: 99,
        identityResolvedAt: new Date(),
      },
    });

    // Tenta upsert como UNSUPPORTED
    await upsertSharp(
      bet.id,
      {
        identityStatus: "UNSUPPORTED",
        provider: "bridgeodds",
        confidence: 0,
      },
      db.prisma,
    );

    const sharpAfter = await db.prisma.betSharp.findUniqueOrThrow({
      where: { betId: bet.id },
    });
    expect(sharpAfter.identityStatus).toBe("MATCHED");
    expect(sharpAfter.providerMatchId).toBe("match-flamengo-1");
  });
});
