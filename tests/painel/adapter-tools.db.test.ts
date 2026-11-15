import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { getToolsData } from "@/app/_design/adapters/tools";
import { getCanaisDecisao } from "@/src/services/painel/canais";

/**
 * Ferramentas: o Kelly usa o CLV médio do canal como vantagem estimada, na
 * MESMA régua da tela de Bancas (`getCanaisDecisao`), e só o oferece com a
 * amostra mínima.
 */
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

const KICKOFF = new Date("2026-06-10T20:00:00Z");

async function seed(bankrollId: string, i: number, over: { status?: "WON" | "LOST" | "PENDING"; clv?: number; provado?: boolean }) {
  const status = over.status ?? "WON";
  return db.prisma.bet.create({
    data: {
      bankrollId, data: KICKOFF, settledAt: status === "PENDING" ? null : KICKOFF,
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: KICKOFF,
      evento: `A${i} vs B`, esporte: "Soccer", mercado: "Moneyline", selecao: "A",
      odds: 2, stake: 1, status, lucro: status === "WON" ? 1 : 0, source: "test", sourceExternalId: `t-${bankrollId}-${i}`,
      // O helper de teste completa a evidência de preço do fechamento confiável.
      ...(over.clv === undefined ? {} : { closing: { create: {
        clv: over.clv, clvReliable: over.provado !== false, fetchedAt: KICKOFF,
      } } }),
    },
  });
}

describe("CLV do canal na tela Ferramentas", () => {
  it("é o CLV médio e a amostra da decisão de Bancas", async () => {
    const banca = await db.prisma.bankroll.create({ data: { nome: "Kelly", slug: "kelly", valorUnidade: 100 } });
    await seed(banca.id, 1, { clv: 4 });
    await seed(banca.id, 2, { status: "LOST", clv: 2 });
    await seed(banca.id, 3, { status: "PENDING", clv: 6 });
    // Fechamento não confiável: Bancas não conta, o Kelly também não.
    await seed(banca.id, 4, { clv: 100, provado: false });

    const dados = await getToolsData(banca.id);
    const decisao = (await getCanaisDecisao()).find((c) => c.id === banca.id)!.decisao;
    expect(dados.clvCanal).toMatchObject({ nome: "Kelly", n: decisao.nClv });
    expect(dados.clvCanal!.media).toBeCloseTo(decisao.clvMedio!, 10);
    expect(dados.clvCanal!.n).toBe(3);
    expect(dados.clvCanal!.media).toBeCloseTo(4, 10);
  });

  it("abaixo da amostra mínima diz quanto falta", async () => {
    const banca = await db.prisma.bankroll.create({ data: { nome: "Curta", slug: "curta", valorUnidade: 100 } });
    await seed(banca.id, 1, { clv: 28.4 });
    const dados = await getToolsData(banca.id);
    expect(dados.clvCanal).toMatchObject({ n: 1, faltam: 29, verdict: "amostra curta" });
  });

  it("banca sem CLV provado não inventa vantagem", async () => {
    const banca = await db.prisma.bankroll.create({ data: { nome: "Vazia", slug: "vazia", valorUnidade: 100 } });
    await seed(banca.id, 1, { clv: 100, provado: false });
    expect((await getToolsData(banca.id)).clvCanal).toBeNull();
  });
});
