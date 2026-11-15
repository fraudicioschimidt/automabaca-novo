import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeQueryPage } from "@/src/providers/bridgeodds/types";
import { runClosingSyncOnce } from "@/src/services/sharp/closing/sync";
import { createTestDb, type TestDb } from "../helpers/db";

const page = JSON.parse(
  readFileSync(new URL("../fixtures/bridgeodds/opening-closing-page.json", import.meta.url), "utf8"),
) as BridgeQueryPage;
const birmingham = page.results.find(
  (match) => match.home === "Birmingham Legion" && match.home_score === 3,
)!;
// Dez minutos depois do kickoff: a Bridge é do `closing.sync` só até 30 min.
const NOW = new Date("2026-06-10T20:10:00Z");

let db: TestDb;

beforeAll(() => { db = createTestDb(); });
afterAll(async () => db.dispose());
beforeEach(async () => db.reset());

async function seedBet(params: {
  provider: "bridgeodds" | "pinnacle17";
  fetchedAt?: Date;
}) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Provider boundary", slug: `provider-boundary-${params.provider}`, sharpMode: "CLV_ONLY" },
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      data: new Date("2026-06-10T20:00:00Z"),
      registradoEm: new Date("2026-06-10T18:00:00Z"),
      evento: "Birmingham Legion vs Corpus Christi",
      esporte: "Soccer",
      competicao: "USL Cup",
      pais: "USA",
      mercado: "Moneyline",
      selecao: "Birmingham Legion",
      odds: 1.5,
      stake: 1,
      status: "PENDING",
      source: "test",
      sourceExternalId: `provider-boundary-${params.provider}`,
      sharp: {
        create: {
          identityStatus: "MATCHED",
          provider: params.provider,
          providerMatchId: String(birmingham.match_id),
          confidence: 100,
        },
      },
      ...(params.fetchedAt
        ? {
            closing: {
              create: {
                closingOdd: 1.4,
                clvReliable: true,
                fetchedAt: params.fetchedAt,
                source: "CRON",
                provider: params.provider,
              },
            },
          }
        : {}),
    },
  });
}

describe("resultado externo pertence somente ao FlashScore", () => {
  it("não reconsulta Pinnacle17/Bridge quando o CLV já está congelado", async () => {
    const bet = await seedBet({
      provider: "pinnacle17",
      fetchedAt: new Date("2026-06-10T20:01:00Z"),
    });
    const query = vi.fn(async () => [birmingham]);

    const result = await runClosingSyncOnce({ query: query as never, now: NOW });

    expect(result).toMatchObject({ processed: 0, failures: 0 });
    expect(query).not.toHaveBeenCalled();
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "PENDING", settledAt: null });
    await expect(db.prisma.settlementEvent.count({ where: { betId: bet.id } }))
      .resolves.toBe(0);
  });

  it("aceita payload Bridge com placar só para capturar CLV", async () => {
    const bet = await seedBet({ provider: "bridgeodds" });
    const query = vi.fn(async () => [birmingham]);

    const result = await runClosingSyncOnce({ query: query as never, now: NOW });

    expect(result).toMatchObject({ processed: 1, failures: 0 });
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "PENDING", settledAt: null });
    // O placar do payload da Bridge não vira resultado.
    await expect(db.prisma.betResult.count({ where: { betId: bet.id } })).resolves.toBe(0);
    await expect(db.prisma.settlementEvent.count({ where: { betId: bet.id } }))
      .resolves.toBe(0);
  });
});
