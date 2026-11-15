import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { getBankrollsData } from "@/app/_design/adapters/bankrolls";
import { VEREDITO_NA_TELA } from "@/src/domain/analyzer/shared";
import { queryChannelDecisions } from "@/src/services/bankrolls/channel-decision";
import { softDeleteBet } from "@/src/services/bets/remove";
import { writeClosingOnce } from "@/src/services/sharp/closing-guard";

/**
 * A régua do canal fora do Next: o boletim do worker lê o mesmo veredito que
 * Bancas mostra para a banca.
 */
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

const MIN = 60_000;

async function seedBankroll() {
  return db.prisma.bankroll.create({
    data: { nome: "Canal", slug: "canal", valorUnidade: 50, capitalInicial: 100, sharpMode: "CLV_ONLY", telegramChannelId: -100123n },
  });
}

function seedBet(bankrollId: string, ext: string, over: {
  data: Date; status?: "PENDING" | "WON" | "LOST"; lucro?: number; clv?: number; registradoEm?: Date;
}) {
  const status = over.status ?? "PENDING";
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: over.data,
      bankrollId,
      data: over.data,
      evento: `Casa ${ext} vs Fora ${ext}`,
      esporte: "Soccer",
      mercado: "Total de gols",
      selecao: "Mais de 2.5",
      odds: 1.95,
      stake: 2,
      valorUnidade: 50,
      status,
      lucro: over.lucro ?? 0,
      settledAt: status === "PENDING" ? null : over.data,
      source: "telegram-channel:-100123",
      sourceExternalId: ext,
      registradoEm: over.registradoEm ?? new Date(Date.now() - 10 * MIN),
      sourcePostedAt: new Date(Date.now() - 10 * MIN),
      ...(over.clv !== undefined ? { closing: { create: { clv: over.clv, clvReliable: true, fetchedAt: over.data, updatedAt: over.data } } } : {}),
    },
  });
}

describe("queryChannelDecisions de uma banca", () => {
  it("o veredito é o de Bancas, sem a aposta removida", async () => {
    const bankroll = await seedBankroll();
    const past = (i: number) => new Date(Date.now() - (3 * 1440 + i) * MIN);
    // 32 fechamentos confiáveis, CLV médio +3%: amostra suficiente e edge.
    for (let i = 0; i < 32; i++) {
      const won = i % 2 === 0;
      await seedBet(bankroll.id, `h${i}`, { data: past(i), status: won ? "WON" : "LOST", lucro: won ? 1.9 : -2, clv: won ? 4 : 2 });
    }
    // Removida (👎) com lucro e CLV alto: não entra na régua.
    const removed = await seedBet(bankroll.id, "removida", { data: past(40), status: "WON", lucro: 50, clv: 90 });
    await softDeleteBet({ betId: removed.id, actor: "agent:teste", motivo: "teste", origin: "painel" });

    const [channel] = await queryChannelDecisions(new Date(), { bankrollId: bankroll.id });
    expect(channel?.decisao).toMatchObject({ clvMedio: expect.closeTo(3, 10), nClv: 32, veredito: "EDGE" });

    const [tipster] = (await getBankrollsData()).tipsters;
    expect(VEREDITO_NA_TELA[channel!.decisao.veredito]).toBe(tipster!.dec.verdict);
  });

  it("banca sem fechamento: sem CLV e amostra curta", async () => {
    const bankroll = await seedBankroll();
    const [channel] = await queryChannelDecisions(new Date(), { bankrollId: bankroll.id });
    expect(channel?.decisao).toMatchObject({ clvMedio: null, nClv: 0, veredito: "AMOSTRA_CURTA" });
  });

  it("banca que não existe não tem régua", async () => {
    expect(await queryChannelDecisions(new Date(), { bankrollId: "banca-que-nao-existe" })).toEqual([]);
  });
});

describe("queryChannelDecisions com asOf", () => {
  it("a régua de antes só conta a aposta registrada, o fechamento buscado e a liquidação de antes do corte", async () => {
    const bankroll = await seedBankroll();
    const cut = new Date(Date.now() - 7 * 1440 * MIN);
    const day = (offset: number) => new Date(cut.getTime() + offset * 1440 * MIN);
    // Conhecida no corte: registrada, fechada e liquidada antes dele.
    await seedBet(bankroll.id, "antes", { registradoEm: day(-3), data: day(-2), status: "WON", lucro: 1.9, clv: 4 });
    // Registrada antes do corte, com o jogo, o fechamento e a liquidação depois.
    await seedBet(bankroll.id, "virou", { registradoEm: day(-1), data: day(1), status: "LOST", lucro: -2, clv: -6 });
    // Registrada depois do corte.
    await seedBet(bankroll.id, "depois", { registradoEm: day(2), data: day(3), status: "WON", lucro: 1.9, clv: 10 });

    const [then] = await queryChannelDecisions(cut, { asOf: true });
    expect(then?.decisao).toMatchObject({ apostas: 2, nClv: 1, clvMedio: 4, nFinal: 1, veredito: "AMOSTRA_CURTA" });
    expect(then?.decisao.roiReal).toBeCloseTo(95, 6);

    const [today] = await queryChannelDecisions(new Date());
    expect(today?.decisao).toMatchObject({ apostas: 3, nClv: 3, nFinal: 3 });
    expect(today?.decisao.clvMedio).toBeCloseTo(8 / 3, 10);
    // Com o corte agora, é a régua de Bancas.
    const [asOfNow] = await queryChannelDecisions(new Date(), { asOf: true });
    expect(asOfNow?.decisao).toEqual(today?.decisao);
  });

  it("o fechamento que a busca pós-jogo completou depois do corte não está na régua de antes, mesmo com o fetchedAt de antes", async () => {
    const bankroll = await seedBankroll();
    const cut = new Date(Date.now() - 7 * 1440 * MIN);
    const day = (offset: number) => new Date(cut.getTime() + offset * 1440 * MIN);
    // Congelado sem preço antes do corte; a Bridge achou a linha depois dele.
    const bet = await seedBet(bankroll.id, "completada", { registradoEm: day(-3), data: day(-2), status: "WON", lucro: 1.9 });
    await db.prisma.betClosing.create({
      data: { betId: bet.id, clvReliable: false, noOddsReason: "partida_nao_localizada", source: "CRON", fetchedAt: day(-2), updatedAt: day(-2) },
    });
    // A mesma escrita da busca pós-jogo: guarda `closingOdd`, sem mexer no `fetchedAt`.
    const completed = await writeClosingOnce({ ...bet, sharp: null }, "closingOdd", {
      closingOdd: 1.8,
      closingRawOdd: 1.8,
      closingPriceSnapshot: { version: 1, combination: "single", components: [{ lineQ: null, rawOdds: [1.8, 2.25], selectedIndex: 0, devig: "power" }] },
      closingPriceReference: "bridgeodds:v1:completada",
      closingPriceObservedAt: day(-2),
      clv: 8.3333,
      clvReliable: true,
      noOddsReason: null,
      source: "REPROCESS",
      provider: "bridgeodds",
    });
    expect(completed).toBe(true);

    const [then] = await queryChannelDecisions(cut, { asOf: true });
    expect(then?.decisao).toMatchObject({ apostas: 1, nClv: 0, nFinal: 1 });
    const [asOfNow] = await queryChannelDecisions(new Date(), { asOf: true });
    expect(asOfNow?.decisao).toMatchObject({ apostas: 1, nClv: 1, clvMedio: 8.3333 });
  });
});
