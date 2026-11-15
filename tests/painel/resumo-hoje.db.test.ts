import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BetStatus } from "@/src/generated/prisma/client";
import { createTestDb, type TestDb } from "../helpers/db";
import { getLastVisit, getResumoHoje, getSinceLastVisit, markVisit } from "@/src/services/painel/queries/dashboard";
import { spStartOfTodayUtc } from "@/src/domain/dates";

/**
 * getResumoHoje (KPIs "de hoje" do dashboard).
 * `resolvidasHoje` conta TUDO que deixou de ser PENDING hoje (settledAt) — inclui
 * VOID/CANCELED (push/devolução), que são resolvidas sem efeito no lucro. O lucro
 * do dia continua só dos status financeiros (FINAL_BET_STATUSES).
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

async function seed() {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Banca", slug: "banca", valorUnidade: 50 },
  });
  const mk = (over: { status: BetStatus; lucro?: number; settledAt: Date | null; registradoEm?: Date; deletedAt?: Date }) =>
    db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: new Date(),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "ML",
        selecao: "A",
        odds: 2,
        stake: 1,
        status: over.status,
        lucro: over.lucro ?? 0,
        settledAt: over.settledAt,
        registradoEm: over.registradoEm,
        deletedAt: over.deletedAt,
      },
    });
  return { mk };
}

describe("getResumoHoje (Postgres real)", () => {
  it("retorna zeros quando não há apostas", async () => {
    expect(await getResumoHoje()).toEqual({ lucroDia: 0, resolvidasHoje: 0, tipsNovas: 0, aResolver: 0 });
  });

  it("respeita a virada do dia em SP, pendências antigas e exclusões", async () => {
    const { mk } = await seed();
    const inicio = spStartOfTodayUtc();
    const antes = new Date(inicio.getTime() - 1);
    await mk({ status: "WON", lucro: 1.125, settledAt: inicio, registradoEm: antes });
    await mk({ status: "LOST", lucro: -1, settledAt: antes, registradoEm: antes });
    await mk({ status: "CANCELED", settledAt: inicio, registradoEm: inicio });
    await mk({ status: "PENDING", settledAt: null, registradoEm: antes });
    await mk({ status: "PENDING", settledAt: null, registradoEm: inicio, deletedAt: inicio });
    await mk({ status: "WON", lucro: 99, settledAt: inicio, registradoEm: inicio, deletedAt: inicio });

    expect(await getResumoHoje()).toEqual({ lucroDia: 56.25, resolvidasHoje: 2, tipsNovas: 1, aResolver: 1 });
  });

  it("resolvidasHoje inclui VOID; lucroDia só os status financeiros", async () => {
    const { mk } = await seed();
    const agora = new Date();
    const anteontem = new Date(Date.now() - 2 * 86_400_000);
    await mk({ status: "WON", lucro: 5, settledAt: agora });
    await mk({ status: "LOST", lucro: -3, settledAt: agora });
    await mk({ status: "VOID", lucro: 0, settledAt: agora }); // resolvida hoje, sem $$
    await mk({ status: "PENDING", settledAt: null }); // não resolvida
    await mk({ status: "WON", lucro: 9, settledAt: anteontem }); // resolvida em outro dia

    const r = await getResumoHoje();
    // WON + LOST + VOID de hoje (PENDING e a de anteontem ficam fora).
    expect(r.resolvidasHoje).toBe(3);
    // lucro só de WON(5) + LOST(-3); VOID não tem efeito e a de anteontem é de outro dia.
    expect(r.lucroDia).toBeCloseTo(100, 6);
    expect(r.aResolver).toBe(1); // a PENDING
  });
});

describe("desde a última visita (Postgres real)", () => {
  const since = new Date("2026-09-22T12:00:00Z");
  const until = new Date("2026-09-23T12:00:00Z");
  const dentro = new Date("2026-09-23T08:00:00Z");
  const fora = new Date("2026-09-21T08:00:00Z");

  it("a visita avança e nunca volta no tempo", async () => {
    expect(await getLastVisit("fabricio")).toBeNull();
    await markVisit("fabricio", until);
    await markVisit("fabricio", since);
    expect(await getLastVisit("fabricio")).toEqual(until);
    expect(await getLastVisit("outro")).toBeNull();
  });

  it("conta só o que mudou na janela: apostas novas, liquidadas com lucro, fechamentos com CLV e alertas abertos", async () => {
    const { mk } = await seed();
    await mk({ status: "PENDING", settledAt: null, registradoEm: dentro });
    await mk({ status: "PENDING", settledAt: null, registradoEm: fora });
    // Liquidadas na janela: 1,125u + (−1u); a VOID conta, sem lucro; a removida não.
    await mk({ status: "WON", lucro: 1.125, settledAt: dentro, registradoEm: fora });
    await mk({ status: "LOST", lucro: -1, settledAt: dentro, registradoEm: fora });
    await mk({ status: "VOID", settledAt: dentro, registradoEm: fora });
    await mk({ status: "WON", lucro: 5, settledAt: dentro, registradoEm: fora, deletedAt: dentro });
    await mk({ status: "WON", lucro: 3, settledAt: fora, registradoEm: fora });
    const comFechamento = await mk({ status: "PENDING", settledAt: null, registradoEm: fora });
    await db.prisma.betClosing.create({ data: { betId: comFechamento.id, clv: 4, clvReliable: true, fetchedAt: dentro, updatedAt: dentro } });
    const semConfianca = await mk({ status: "PENDING", settledAt: null, registradoEm: fora });
    await db.prisma.betClosing.create({ data: { betId: semConfianca.id, clv: 40, clvReliable: false, fetchedAt: dentro, updatedAt: dentro } });
    const acao = (status: "OPEN" | "RESOLVED", openedAt: Date, key: string) => db.prisma.operationalAction.create({
      data: { fingerprint: key, area: "apostas", actionType: "bet.review", title: key, description: key, status, openedAt },
    });
    await acao("OPEN", dentro, "nova");
    await acao("RESOLVED", dentro, "ja-resolvida");
    await acao("OPEN", fora, "antiga");

    const resumo = await getSinceLastVisit(since, until);

    expect(resumo).toEqual({
      since, until,
      newBets: 1,
      settled: 3,
      lucroUnits: 0.125,
      // A R$50 por unidade: 56,25 − 50,00.
      lucroReais: 6.25,
      closings: 1,
      clvMean: 4,
      openAlerts: 1,
    });
  });
  it("inclui o CLV completado pela busca pós-jogo desde a visita, com o fetchedAt antigo", async () => {
    const { mk } = await seed();
    const bet = await mk({ status: "PENDING", settledAt: null, registradoEm: fora });
    await db.prisma.betClosing.create({ data: {
      betId: bet.id, fetchedAt: fora, updatedAt: dentro, clv: 4, clvReliable: true,
    } });
    expect(await getSinceLastVisit(since, until)).toMatchObject({ closings: 1, clvMean: 4 });
  });

});

it("Hoje e desde a visita contam o mesmo cancelamento encerrado, sem lucro", async () => {
  const { mk } = await seed();
  const now = new Date();
  await mk({ status: "CANCELED", settledAt: now, registradoEm: now });
  const hoje = await getResumoHoje();
  const since = await getSinceLastVisit(spStartOfTodayUtc(now), now);
  expect(hoje.resolvidasHoje).toBe(1);
  expect(since.settled).toBe(hoje.resolvidasHoje);
  expect(since.lucroReais).toBe(0);
});

it("o resumo usa o dia informado mesmo se a consulta atravessar a meia-noite de SP", async () => {
  const { mk } = await seed();
  const readAt = new Date("2026-10-11T02:59:59.999Z");
  await mk({ status: "WON", lucro: 1, settledAt: readAt, registradoEm: readAt });
  const nextDay = new Date("2026-10-11T03:00:00Z");
  await mk({ status: "LOST", lucro: -2, settledAt: nextDay, registradoEm: nextDay });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nextDay);
  try {
    expect(await getResumoHoje(readAt)).toEqual({ lucroDia: 50, resolvidasHoje: 1, tipsNovas: 1, aResolver: 0 });
  } finally { vi.useRealTimers(); }
});
