import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { reopenProviderlessIdentities } from "@/src/services/sharp/reopen-providerless-identity";

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

const EXECUTOR = "agent:claude:por:operador";

async function seedBet(evento: string, sharp: { identityStatus: "MATCHED" | "MANUAL" | "PENDING"; provider: string | null }) {
  const bankroll = await db.prisma.bankroll.upsert({
    where: { slug: "clv" }, update: {}, create: { nome: "CLV", slug: "clv", valorUnidade: 100, sharpMode: "CLV_ONLY" },
  });
  return db.prisma.bet.create({ data: {
    bankrollId: bankroll.id, evento, esporte: "Soccer", mercado: "Money Line – Match", selecao: "Santos",
    odds: 2, stake: 1, status: "PENDING", sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(),
    data: new Date(Date.now() + 3_600_000),
    sharp: { create: { ...sharp, confidence: 100, providerMatchId: sharp.provider ? "1634172613" : null, noOddsReason: "no_prices" } },
  } });
}

describe("reopenProviderlessIdentities (Postgres real)", () => {
  it("recusa executor que não seria classificado como escrita delegada", async () => {
    await seedBet("Santos vs Palmeiras", { identityStatus: "MATCHED", provider: null });
    for (const executor of ["agent:a:por:fabricio", "claude", "agent:claude"]) {
      await expect(reopenProviderlessIdentities({ executor, apply: true })).rejects.toThrow(/executor/);
    }
    expect(await db.prisma.betSharp.count({ where: { identityStatus: "MATCHED" } })).toBe(1);
  });

  it("simula sem gravar e aplica só nas MATCHED sem fornecedor, com auditoria e enrich", async () => {
    const semFornecedor = await seedBet("Santos vs Palmeiras", { identityStatus: "MATCHED", provider: null });
    const comFornecedor = await seedBet("Gremio vs Inter", { identityStatus: "MATCHED", provider: "pinnacle17" });
    const manual = await seedBet("Bahia vs Vitoria", { identityStatus: "MANUAL", provider: null });

    const plan = await reopenProviderlessIdentities({ executor: EXECUTOR, apply: false });
    expect(plan).toMatchObject({ applied: false, requeued: 0 });
    expect(plan.identities.map((item) => item.betId)).toEqual([semFornecedor.id]);
    expect((await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: semFornecedor.id } })).identityStatus).toBe("MATCHED");

    const enqueued: string[] = [];
    const applied = await reopenProviderlessIdentities({
      executor: EXECUTOR, apply: true, enqueueEnrich: async (betId) => { enqueued.push(betId); },
    });
    expect(applied).toMatchObject({ applied: true, requeued: 1 });
    expect(enqueued).toEqual([semFornecedor.id]);
    expect(await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: semFornecedor.id } })).toMatchObject({
      identityStatus: "PENDING", confidence: 0, identityResolvedAt: null, noOddsReason: null,
    });
    expect((await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: comFornecedor.id } })).identityStatus).toBe("MATCHED");
    expect((await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: manual.id } })).identityStatus).toBe("MANUAL");
    expect(await db.prisma.auditEvent.findMany({ where: { action: "bet_sharp.reopen_providerless_identity" } }))
      .toEqual([expect.objectContaining({ actor: EXECUTOR, resourceId: semFornecedor.id })]);

    // Repetir não muda nada.
    expect(await reopenProviderlessIdentities({ executor: EXECUTOR, apply: true })).toMatchObject({ identities: [], requeued: 0 });
  });
});
