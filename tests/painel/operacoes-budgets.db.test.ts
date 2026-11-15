import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getProviderBudgets } from "@/src/services/painel/operacoes/budgets";
import { periodKeyFor, PROVIDER_CAPS } from "@/src/providers/budget-config";
import { createTestDb, type TestDb } from "../helpers/db";

/** Card de budgets em Monitoramento: aparece a frota em uso; some quem não consome há 7 dias. */

let db: TestDb;

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

async function consumo(provider: string, diasAtras: number) {
  const cap = PROVIDER_CAPS.find((c) => c.provider === provider);
  if (!cap) throw new Error(`teste desatualizado: ${provider} não está em PROVIDER_CAPS`);
  const quando = new Date(Date.now() - diasAtras * 24 * 3_600_000);
  await db.prisma.providerBudget.create({
    data: { provider, periodKey: periodKeyFor(cap.period, quando), spent: 3 },
  });
  // `updatedAt` é do Prisma (@updatedAt) e ignora o valor do create; a idade do
  // consumo é justamente o que este teste manipula.
  await db.prisma.$executeRaw`
    UPDATE provider_budgets SET "updatedAt" = ${quando} WHERE provider = ${provider}
  `;
}

describe("getProviderBudgets", () => {
  it("provider que consumiu nos últimos 7 dias aparece", async () => {
    await consumo("bridgeodds", 0);
    const budgets = await getProviderBudgets();
    expect(budgets.map((b) => b.name)).toContain("bridgeodds");
  });

  it("provider parado há mais de 7 dias sai da tela", async () => {
    await consumo("bridgeodds", 0);
    await consumo("pinnacle17", 8);
    const budgets = await getProviderBudgets();
    expect(budgets.map((b) => b.name)).toEqual(["bridgeodds"]);
  });

  it("provider sem consumo nenhum não ocupa espaço", async () => {
    await consumo("flashscore", 1);
    const budgets = await getProviderBudgets();
    expect(budgets.map((b) => b.name)).toEqual(["flashscore"]);
  });

  it("o resultado entregue conta a observação do FlashScore em bet_result", async () => {
    await consumo("flashscore", 0);
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Resultado", slug: "resultado" } });
    const bet = await db.prisma.bet.create({ data: { bankrollId: bankroll.id, data: new Date(), evento: "Alpha vs Beta",
      esporte: "Soccer", mercado: "Moneyline", selecao: "Alpha", odds: 2, stake: 1, sportResolvedAt: new Date() } });
    await db.prisma.betResult.create({ data: { betId: bet.id, resultProvider: "flashscore",
      resultSnapshot: { outcome: "matched" }, resultCheckedAt: new Date() } });
    const budgets = await getProviderBudgets();
    expect(budgets.find((b) => b.name === "flashscore")?.rendimento).toEqual({ resultado: 1 });
  });

  it("o card não fica vazio quando o dia ainda não teve consumo", async () => {
    // Recência de 7 dias, não "gastou no período corrente": o budget do
    // bridgeodds é HORÁRIO e zera na virada — o critério errado apagaria o
    // provider principal toda hora cheia.
    await consumo("bridgeodds", 2);
    const budgets = await getProviderBudgets();
    expect(budgets.map((b) => b.name)).toEqual(["bridgeodds"]);
    expect(budgets[0]?.used).toBe(0); // período corrente ainda zerado
  });
});
