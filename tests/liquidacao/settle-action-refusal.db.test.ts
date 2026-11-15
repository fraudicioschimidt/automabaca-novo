import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { prisma } from "@/src/infra/prisma";

const mocks = vi.hoisted(() => ({ user: "tester", revalidate: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => ({ get: () => mocks.user || null }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => ({}) }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ cancelPendingSharpEnrich: vi.fn() }));

import { settleBetAction, type SettleResult } from "@/app/(painel)/tipsters/[slug]/actions";

let db: TestDb;
async function settle(betId: string, result: SettleResult, cashout?: number) {
  const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  return settleBetAction("recusa", betId, result, cashout, { expectedVersion: bet.manualSettlementVersion, requestId: randomUUID() });
}
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => {
  vi.restoreAllMocks();
  mocks.user = "tester";
  mocks.revalidate.mockClear();
  await db.reset();
});

async function seed(future = false) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Recusa", slug: "recusa", valorUnidade: 50, sharpMode: "OFF", vincularContas: false },
  });
  return db.prisma.bet.create({ data: {
    bankrollId: bankroll.id, evento: "France vs Spain", esporte: "Soccer",
    sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(),
    mercado: "Money Line – Match", selecao: "France", odds: 2, stake: 1, valorUnidade: 50,
    data: new Date(Date.now() + (future ? 86_400_000 : -86_400_000)),
  } });
}

it("recusa pré-jogo chega como mensagem pública e não muda o resultado", async () => {
  const bet = await seed(true);
  expect(await settle(bet.id, "won")).toEqual({
    erro: "Este evento é futuro. Aguarde o início do evento para registrar o resultado.",
  });
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
  expect(await db.prisma.settlementEvent.count()).toBe(0);
  expect(await db.prisma.movimentacao.count()).toBe(0);
  expect(mocks.revalidate).not.toHaveBeenCalled();
});

it("preserva a recusa de esporte e de meio resultado em mercado binário", async () => {
  const bet = await seed();
  expect(await settle(bet.id, "halfwon")).toMatchObject({ erro: expect.stringMatching(/não admite/) });
  await db.prisma.bet.update({ where: { id: bet.id }, data: {
    esporte: "Unknown", sportResolutionStatus: "PENDING", sportResolvedAt: null,
  } });
  expect(await settle(bet.id, "won")).toMatchObject({ erro: expect.stringMatching(/esporte confirmado/) });
});

it("cashout fora do intervalo retorna a regra sem movimentar dinheiro", async () => {
  const bet = await seed();
  expect(await settle(bet.id, "cashout", 10)).toMatchObject({ erro: expect.stringMatching(/entre -1 e 1 unidades/) });
  expect(await settle(bet.id, "cashout", Number.NaN)).toMatchObject({ erro: expect.stringMatching(/Cashout exige/) });
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
});

it("sucesso mantém o contrato de lucro e invalida as telas", async () => {
  const bet = await seed();
  expect(await settle(bet.id, "won")).toMatchObject({ kind: "saved", lucro: 1 });
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("WON");
  expect(mocks.revalidate).toHaveBeenCalledWith("/");
});

it("erro inesperado e sessão inválida continuam como falhas", async () => {
  const bet = await seed();
  const databaseFailure = new Error("Falha inesperada de conexão");
  vi.spyOn(prisma.bankroll, "findFirst").mockRejectedValueOnce(databaseFailure);
  await expect(settle(bet.id, "won")).rejects.toBe(databaseFailure);
  mocks.user = "";
  await expect(settle(bet.id, "won")).rejects.toThrow(/Sessão inválida/);
});
