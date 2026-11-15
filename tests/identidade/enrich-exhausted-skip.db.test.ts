import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { enrichBetSharp } from "@/src/services/sharp/enrich/enrich-bet";
import { KICKOFF_RESOLVE_ATTEMPT_ACTION } from "@/src/services/sharp/enrich/kickoff-attempts";

/**
 * Tip com kickoffInferido não desiste após um miss e respeita o dia completo.
 */

let db: TestDb;
let seq = 0;

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
  seq = 0;
});

describe("enrich com kickoff provisório", () => {
  it("miss anterior ainda permite nova busca e mantém PENDING durante o dia", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "T", slug: `exh-${seq++}`, sharpMode: "CLV_ONLY" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date("2026-07-10T03:00:00Z"),
        registradoEm: new Date("2026-07-09T12:00:00Z"),
        evento: "Time A vs Time B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 1.9,
        stake: 1,
        kickoffInferido: true,
        status: "PENDING",
      },
    });
    await db.prisma.auditEvent.create({
      data: {
        actor: "system",
        action: KICKOFF_RESOLVE_ATTEMPT_ACTION,
        resource: "bet",
        resourceId: bet.id,
        details: { source: "web", aplicado: false },
      },
    });

    const query = vi.fn(async () => []);
    await enrichBetSharp(
      { betId: bet.id },
      {
        query: query as never,
        webSearch: async () => null,
        now: new Date("2026-07-09T18:00:00Z"),
      },
    );

    expect(query.mock.calls.length).toBeGreaterThan(0);
    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("PENDING");
  });

  it("encerra UNMATCHED apenas depois de completar a janela do dia", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "T", slug: `exh-${seq++}`, sharpMode: "CLV_ONLY" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date("2026-07-01T03:00:00Z"),
        registradoEm: new Date("2026-06-30T12:00:00Z"),
        evento: "Time A vs Time B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 1.9,
        stake: 1,
        kickoffInferido: true,
        status: "PENDING",
        sharp: { create: { identityStatus: "PENDING", confidence: 0 } },
      },
    });
    await db.prisma.auditEvent.create({
      data: {
        actor: "system",
        action: KICKOFF_RESOLVE_ATTEMPT_ACTION,
        resource: "bet",
        resourceId: bet.id,
        details: { source: "web", aplicado: false },
      },
    });

    const query = vi.fn(async () => []);
    await enrichBetSharp(
      { betId: bet.id },
      {
        query: query as never,
        webSearch: async () => null,
        now: new Date("2026-07-09T18:00:00Z"),
      },
    );

    expect(query.mock.calls.length).toBeGreaterThan(0);
    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("UNMATCHED");
  });
});
