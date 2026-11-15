import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { toNumber } from "@/src/domain/money";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";

/**
 * Conferência tipster × placar: aposta JÁ liquidada pelo tipster recebe o
 * placar do feed, diverge → alerta UMA vez, status intocado (palavra final
 * é do operador). + Digest de PENDING vencidas.
 */

const alertSpy = vi.fn(async (_msg: string) => true);
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperationalAlert: (msg: string) => alertSpy(msg),
  sendOperatorNotification: (msg: string) => alertSpy(msg),
  sendRequiredOperatorNotification: async (msg: string) => {
    await alertSpy(msg);
    return "delivered" as const;
  },
}));

// Imports após o mock (vitest hoisting cuida, mas dynamic deixa explícito).
const { settleFromFlashscoreScore } = await import("@/src/services/settlement/flashscore/score-settle");
const { sendPendingDigest } = await import("@/src/services/ops/digests/pending-digest");
const NOW = new Date("2026-06-10T23:00:00Z");

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  alertSpy.mockClear();
});

async function loadEligible(betId: string): Promise<EligibleBet> {
  return db.prisma.bet.findUniqueOrThrow({
    where: { id: betId },
    include: { closing: true, result: true, sharp: true, captureEvidence: true },
  }) as unknown as EligibleBet;
}

describe("conflito tipster × placar", () => {
  it("liquidada como LOST mas placar diz WON → alerta 1×, status intocado, placar ingerido", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "T", slug: "t", valorUnidade: 100, sharpMode: "CLV_ONLY" },
    });
    // Tipster (👎 errado do operador, por ex.) marcou LOST — placar 3×0 diz WON.
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: new Date("2026-06-10T20:00:00Z"),
        bankrollId: bankroll.id,
        data: new Date("2026-06-10T20:00:00Z"),
        evento: "Birmingham Legion vs Corpus Christi",
        esporte: "Soccer",
        competicao: "USL Cup",
        pais: "USA",
        mercado: "Moneyline",
        selecao: "Birmingham Legion",
        odds: 1.5,
        stake: 1,
        status: "LOST",
        lucro: -1,
        source: "test",
        sourceExternalId: "conflict-1",
        sharp: {
          create: {
            identityStatus: "MATCHED",
            provider: "bridgeodds",
            providerMatchId: "historical-sharp-id",
            confidence: 90,
          },
        },
        // closing já congelado antes (CLV ok) — só o placar falta.
        closing: { create: { fetchedAt: new Date("2026-06-10T20:01:00Z"), clvReliable: true } },
      },
    });

    await expect(settleFromFlashscoreScore(
      await loadEligible(bet.id),
      { homeScore: 3, awayScore: 0 },
    )).resolves.toBe(false);

    const after = await db.prisma.bet.findUniqueOrThrow({
      where: { id: bet.id },
      include: { result: true },
    });
    expect(after.status).toBe("LOST"); // intocado
    expect(after.result?.scoreHome).toBe(3);
    const conflitos = alertSpy.mock.calls.filter(([m]) => String(m).includes("Resultado diferente do placar"));
    expect(conflitos).toHaveLength(1);
    expect(String(conflitos[0]![0])).toContain("seria Ganha");

    // Segundo ciclo: placar já ingerido → nada novo.
    alertSpy.mockClear();
    await expect(settleFromFlashscoreScore(
      await loadEligible(bet.id),
      { homeScore: 3, awayScore: 0 },
    )).resolves.toBe(false);
    expect(alertSpy.mock.calls.filter(([m]) => String(m).includes("Resultado diferente do placar"))).toHaveLength(0);
  });

  it("liquidada IGUAL ao placar → ingere sem alerta", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "T2", slug: "t2", valorUnidade: 100, sharpMode: "CLV_ONLY" },
    });
    await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: new Date("2026-06-10T20:00:00Z"),
        bankrollId: bankroll.id,
        data: new Date("2026-06-10T20:00:00Z"),
        evento: "Birmingham Legion vs Corpus Christi",
        esporte: "Soccer",
        competicao: "USL Cup",
        pais: "USA",
        mercado: "Moneyline",
        selecao: "Birmingham Legion",
        odds: 1.5,
        stake: 1,
        status: "WON",
        lucro: 0.5,
        source: "test",
        sourceExternalId: "conflict-2",
        sharp: {
          create: {
            identityStatus: "MATCHED",
            provider: "bridgeodds",
            providerMatchId: "historical-sharp-id",
            confidence: 90,
          },
        },
        closing: { create: { fetchedAt: new Date("2026-06-10T20:01:00Z"), clvReliable: true } },
      },
    });
    const bet = await db.prisma.bet.findFirstOrThrow({ where: { sourceExternalId: "conflict-2" } });
    await settleFromFlashscoreScore(
      await loadEligible(bet.id),
      { homeScore: 3, awayScore: 0 },
    );
    expect(alertSpy.mock.calls.filter(([m]) => String(m).includes("Resultado diferente do placar"))).toHaveLength(0);
  });
});

describe("digest de PENDING vencidas", () => {
  it("lista apostas com kickoff >6h agrupadas por banca; sem vencidas fica em silêncio", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Big Data", slug: "bd", valorUnidade: 100, sharpMode: "CLV_ONLY" },
    });
    await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date(NOW.getTime() - 7 * 3_600_000), // 7h atrás
        evento: "Qatar vs Switzerland",
        esporte: "Soccer",
        competicao: "World Cup",
        pais: "FIFA",
        mercado: "Total (Corners) – Match",
        selecao: "Over 8.5",
        odds: 1.75,
        stake: 1,
        status: "PENDING",
        source: "test",
        sourceExternalId: "digest-1",
      },
    });
    await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date(NOW.getTime() + 3_600_000), // futuro — fora do digest
        evento: "Canada vs Bosnia and Herzegovina",
        esporte: "Soccer",
        competicao: "World Cup",
        pais: "FIFA",
        mercado: "Total",
        selecao: "Over 2.5",
        odds: 1.6,
        stake: 1,
        status: "PENDING",
        source: "test",
        sourceExternalId: "digest-2",
      },
    });

    const r = await sendPendingDigest(NOW);
    expect(r.pendentes).toBe(1);
    const msg = String(alertSpy.mock.calls.at(-1)![0]);
    expect(msg).toContain("Qatar vs Switzerland");
    expect(msg).toContain("Big Data");
    expect(msg).not.toContain("Canada");

    alertSpy.mockClear();
    await db.prisma.bet.updateMany({ data: { status: "WON", settledAt: NOW } });
    const r2 = await sendPendingDigest(NOW);
    expect(r2.pendentes).toBe(0);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe("falha financeira durante settlement FlashScore", () => {
  it("conta soft-deletada → aposta segue PENDING e saldo fica intacto", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "FailLoud", slug: "fail-loud", valorUnidade: 100, sharpMode: "CLV_ONLY" },
    });
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Betano",
        titular: "F",
        saldoInicial: 1000,
        saldoAtual: 1000,
        bankrollLinks: { create: { bankrollId: bankroll.id } },
      },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        contaId: conta.id,
        data: new Date("2026-06-10T20:00:00Z"),
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
        sourceExternalId: "failloud-1",
        sharp: {
          create: {
            identityStatus: "MATCHED",
            provider: "bridgeodds",
            providerMatchId: "historical-sharp-id",
            confidence: 90,
          },
        },
      },
    });

    // A conta vinculada some (soft-delete) ANTES do ciclo — o settlement por
    // placar vai lançar ContaIndisponivelError no meio da transação.
    await db.prisma.conta.update({
      where: { id: conta.id },
      data: { deletedAt: new Date() },
    });

    await expect(settleFromFlashscoreScore(
      await loadEligible(bet.id),
      { homeScore: 3, awayScore: 0 },
    )).rejects.toThrow();

    // Rollback atômico: a aposta NÃO liquidou e o saldo ficou intacto
    // (o estorno/lançamento nunca foi meio-aplicado).
    const still = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(still.status).toBe("PENDING");
    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(contaDb.saldoAtual)).toBe(1000);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);

  });

  it("recupera no ciclo seguinte: placar NÃO fica gravado ao falhar, então re-tenta quando a conta volta", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Recover", slug: "recover", valorUnidade: 100, sharpMode: "CLV_ONLY" },
    });
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Betano",
        titular: "F",
        saldoInicial: 1000,
        saldoAtual: 1000,
        bankrollLinks: { create: { bankrollId: bankroll.id } },
      },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        contaId: conta.id,
        data: new Date("2026-06-10T20:00:00Z"),
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
        sourceExternalId: "recover-1",
        sharp: {
          create: {
            identityStatus: "MATCHED",
            provider: "bridgeodds",
            providerMatchId: "historical-sharp-id",
            confidence: 90,
          },
        },
      },
    });

    // Ciclo 1: conta indisponível → settlement falha.
    await db.prisma.conta.update({ where: { id: conta.id }, data: { deletedAt: new Date() } });
    await expect(settleFromFlashscoreScore(
      await loadEligible(bet.id),
      { homeScore: 3, awayScore: 0 },
    )).rejects.toThrow();

    // O cerne: o placar NÃO foi gravado. Gravado antes do settlement, a
    // aposta encalharia PENDING para sempre, fora da query.
    const result1 = await db.prisma.betResult.findUnique({ where: { betId: bet.id } });
    expect(result1?.scoreHome ?? null).toBeNull();
    const bet1 = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(bet1.status).toBe("PENDING");

    // Conta volta → a próxima observação FlashScore re-seleciona e liquida.
    await db.prisma.conta.update({ where: { id: conta.id }, data: { deletedAt: null } });
    await expect(settleFromFlashscoreScore(
      await loadEligible(bet.id),
      { homeScore: 3, awayScore: 0 },
    )).resolves.toBe(true);

    const bet2 = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(bet2.status).toBe("WON");
    expect(toNumber(bet2.lucro)).toBeCloseTo(0.5, 6);
    const result2 = await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(result2.scoreHome).toBe(3);
    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(contaDb.saldoAtual)).toBe(1050); // 1000 + 0.5u × R$100
  });

  it("atomicidade: liquidação por placar e persistência de score gravam juntos em transação única", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "AtomicBankroll", slug: "atomic-bankroll", valorUnidade: 100, sharpMode: "CLV_ONLY" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date("2026-06-10T20:00:00Z"),
        evento: "Flamengo vs Vasco",
        esporte: "Soccer",
        competicao: "Brasileirao",
        pais: "Brazil",
        mercado: "Moneyline",
        selecao: "Flamengo",
        odds: 2.0,
        stake: 1,
        status: "PENDING",
        source: "test",
        sourceExternalId: "atomic-1",
        sharp: {
          create: {
            identityStatus: "MATCHED",
            provider: "bridgeodds",
            providerMatchId: "match-flavas",
            confidence: 95,
          },
        },
      },
    });

    const settled = await settleFromFlashscoreScore(
      await loadEligible(bet.id),
      { homeScore: 2, awayScore: 1 },
    );
    expect(settled).toBe(true);

    const betAfter = await db.prisma.bet.findUniqueOrThrow({
      where: { id: bet.id },
      include: { result: true },
    });
    expect(betAfter.status).toBe("WON");
    expect(betAfter.result?.scoreHome).toBe(2);
    expect(betAfter.result?.scoreAway).toBe(1);
    expect(betAfter.settledAt).not.toBeNull();
  });
});
