import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { toNumber } from "@/src/domain/money";

/**
 * Fechamento fora da Bridge (`pinnacle17-snapshot.ts` + série). Caminho
 * financeiro: congela a linha provisória no kickoff, calcula CLV e marca
 * clvReliable. Testa contra Postgres
 * real; só o alerta operacional (Telegram) é mockado — o resto é
 * lógica real de freeze/CLV/race-guard (contrato de providers do Blueprint).
 */

const alertSpy = vi.fn(async (_msg: string) => true);
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperatorNotification: (msg: string) => alertSpy(msg),
}));

const { snapshotClosingForBet } = await import("@/src/services/sharp/closing/pinnacle17-snapshot");

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

const KICK = new Date("2026-06-10T20:00:00Z");

async function seedBet(over: {
  slug: string;
  ext: string;
  provider?: string;
  providerMatchId?: string | null;
  odds?: number;
  withProvisional?: { closingOdd: number; clv: number };
  withFrozen?: { closingOdd: number; clv: number; fetchedAt: Date };
}) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: over.slug, slug: over.slug, valorUnidade: 100, sharpMode: "CLV_ONLY" },
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      data: KICK,
      registradoEm: new Date(KICK.getTime() - 60 * 60_000),
      evento: "Time A vs Time B",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Time A",
      odds: over.odds ?? 2,
      stake: 1,
      status: "PENDING",
      source: "test",
      sourceExternalId: over.ext,
      ...(over.provider
        ? {
            sharp: {
              create: {
                identityStatus: "MATCHED",
                provider: over.provider,
                providerMatchId: over.providerMatchId ?? null,
                confidence: 90,
              },
            },
          }
        : {}),
      ...(over.withProvisional
        ? {
            closing: {
              create: {
                closingOdd: over.withProvisional.closingOdd,
                closingRawOdd: over.withProvisional.closingOdd + 0.1,
                clv: over.withProvisional.clv,
                clvReliable: true,
                source: "CRON",
                // Cotada nos minutos finais: é o fechamento se nada mais novo chegar.
                closingPriceObservedAt: new Date(KICK.getTime() - 2 * 60_000),
                // fetchedAt fica null → ainda não congelado
              },
            },
          }
        : {}),
      ...(over.withFrozen
        ? {
            closing: {
              create: {
                closingOdd: over.withFrozen.closingOdd,
                closingRawOdd: over.withFrozen.closingOdd + 0.1,
                clv: over.withFrozen.clv,
                clvReliable: true,
                source: "CRON",
                fetchedAt: over.withFrozen.fetchedAt,
              },
            },
          }
        : {}),
    },
  });
  return { bet, provider: over.provider ?? "", providerMatchId: over.providerMatchId ?? null };
}

function snapBet(bet: { id: string }, opts: {
  provider: string;
  providerMatchId: string | null;
  odds: number;
  closingOdd: number | null;
  fetchedAt?: Date | null;
}) {
  return {
    id: bet.id,
    evento: "Time A vs Time B",
    esporte: "Soccer",
    mercado: "Moneyline",
    selecao: "Time A",
    odds: opts.odds,
    data: KICK,
    // Pré-kickoff: estes casos exercitam a janela de captura, não a regra de
    // entrada ao vivo (`domain/entrada-ao-vivo.ts`), que sai antes dela.
    registradoEm: new Date(KICK.getTime() - 60 * 60_000),
    sharp: { provider: opts.provider, providerMatchId: opts.providerMatchId },
    closing: { fetchedAt: opts.fetchedAt ?? null, closingOdd: opts.closingOdd },
  };
}

describe("snapshotClosingForBet (Postgres real, providers não-bridge)", () => {
  it("longe do kickoff: não faz nada (sem captura, sem betClosing)", async () => {
    const { bet } = await seedBet({ slug: "far", ext: "snap-far", provider: "pinnacle17", providerMatchId: "123" });
    const now = new Date(KICK.getTime() - 2 * 3_600_000); // 2h antes da janela de captura
    const r = await snapshotClosingForBet(snapBet(bet, { provider: "pinnacle17", providerMatchId: "123", odds: 2, closingOdd: null }), now);
    expect(r.closed).toBe(false);
    expect(await db.prisma.betClosing.count({ where: { betId: bet.id } })).toBe(0);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("kickoff passou com provisória: CONGELA, calcula CLV e alerta 1×", async () => {
    // odds 2.0 vs closing fair 1.8 → CLV = (2/1.8 - 1)*100 = +11.1%
    const { bet } = await seedBet({
      slug: "freeze",
      ext: "snap-freeze",
      provider: "pinnacle17",
      providerMatchId: "777",
      odds: 2,
      withProvisional: { closingOdd: 1.8, clv: 11.1 },
    });
    const now = new Date(KICK.getTime() + 60_000); // 1min após o kickoff
    const r = await snapshotClosingForBet(
      snapBet(bet, { provider: "pinnacle17", providerMatchId: "777", odds: 2, closingOdd: 1.8 }),
      now,
    );
    expect(r.closed).toBe(true);
    const c = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(c.fetchedAt).not.toBeNull(); // congelado
    expect(c.clvReliable).toBe(true);
    expect(toNumber(c.clv!)).toBeCloseTo(11.1, 1); // CLV provisório preservado
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const msg = String(alertSpy.mock.calls[0]![0]);
    expect(msg).toContain("Time A vs Time B");
    expect(msg).toContain("+11.1%"); // CLV calculado de odds × closing
  });

  it("idempotência: 2ª passagem após congelado não recongela nem realerta (race-guard)", async () => {
    const { bet } = await seedBet({
      slug: "idem",
      ext: "snap-idem",
      provider: "pinnacle17",
      providerMatchId: "777",
      odds: 2,
      withProvisional: { closingOdd: 1.8, clv: 11.1 },
    });
    const now = new Date(KICK.getTime() + 60_000);
    const sb = snapBet(bet, { provider: "pinnacle17", providerMatchId: "777", odds: 2, closingOdd: 1.8 });
    const r1 = await snapshotClosingForBet(sb, now);
    expect(r1.closed).toBe(true);
    alertSpy.mockClear();
    const r2 = await snapshotClosingForBet(sb, now); // mesma entrada, já congelado no banco
    expect(r2.closed).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("kickoff passou sem provisória e sem captura: congela com clvReliable=false (sem alerta)", async () => {
    // Identidade válida, mas nenhuma cotação pré-jogo armazenada: após kickoff não busca preço ao vivo.
    const { bet } = await seedBet({ slug: "miss", ext: "snap-miss", provider: "pinnacle17", providerMatchId: "888" });
    const now = new Date(KICK.getTime() + 60_000);
    const r = await snapshotClosingForBet(
      snapBet(bet, { provider: "pinnacle17", providerMatchId: "888", odds: 2, closingOdd: null }),
      now,
    );
    expect(r.closed).toBe(true);
    const c = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(c.fetchedAt).not.toBeNull();
    expect(c.clvReliable).toBe(false);
    expect(c.noOddsReason).toBe("kickoff_sem_captura");
    expect(alertSpy).not.toHaveBeenCalled(); // caminho "perdeu janela" só loga
  });

  it("sem ID de fixture: não mede preço e congela sem CLV no kickoff", async () => {
    const { bet } = await seedBet({ slug: "no-id", ext: "snap-no-id", provider: "pinnacle17" });
    const input = snapBet(bet, { provider: "pinnacle17", providerMatchId: null, odds: 2, closingOdd: null });
    expect((await snapshotClosingForBet(input, new Date(KICK.getTime() - 60_000))).closed).toBe(false);
    expect(await db.prisma.betClosing.count({ where: { betId: bet.id } })).toBe(0);
    const r = await snapshotClosingForBet(input, new Date(KICK.getTime() + 60_000));
    expect(r.closed).toBe(true);
    const c = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect([c.closingOdd, c.clvReliable, c.noOddsReason]).toEqual([null, false, "kickoff_sem_captura"]);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  const LEGS = { kind: "same_game", legs: [
    { evento: "Time A vs Time B", mercado: "Moneyline", selecao: "Time A" },
    { evento: "Time A vs Time B", mercado: "Total", selecao: "Over 2.5" },
  ] };
  it.each([
    ["múltipla", { legsJson: LEGS }, "multipla"],
    ["mercado sem referência sharp", { mercado: "Total (Shots) – Match", selecao: "Over 25.5" }, "sem_referencia_sharp"],
    ["mercado que a Pinnacle17 não precifica", { mercado: "Both Teams to Score", selecao: "Sim" }, "unsupported_market"],
  ] as const)("fora da série, %s congela no kickoff com o motivo dela", async (nome, over, motivo) => {
    const { bet } = await seedBet({ slug: `fora-${motivo}`, ext: `snap-fora-${nome}`, provider: "pinnacle17", providerMatchId: "777" });
    await db.prisma.bet.update({ where: { id: bet.id }, data: over });
    const input = { ...snapBet(bet, { provider: "pinnacle17", providerMatchId: "777", odds: 2, closingOdd: null }), ...over };
    expect((await snapshotClosingForBet(input, new Date(KICK.getTime() + 60_000))).closed).toBe(true);
    expect(await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ closingOdd: null, clvReliable: false, noOddsReason: motivo });
  });

  it("concorrência/race: passagem tardia NÃO sobrescreve linha já congelada", async () => {
    const frozenAt = new Date(KICK.getTime() + 30_000);
    const { bet } = await seedBet({
      slug: "race-frozen",
      ext: "snap-race-frozen",
      provider: "pinnacle17",
      providerMatchId: "777",
      odds: 2,
      withFrozen: { closingOdd: 1.75, clv: 14.28, fetchedAt: frozenAt },
    });

    // Se um snapshot tardio tentar processar, a linha já congelada no banco deve permanecer intacta
    const now = new Date(KICK.getTime() + 60_000);
    const r = await snapshotClosingForBet(
      snapBet(bet, { provider: "pinnacle17", providerMatchId: "777", odds: 2, closingOdd: 1.75, fetchedAt: null }),
      now,
    );
    expect(r.closed).toBe(false);

    const c = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(c.fetchedAt?.toISOString()).toBe(frozenAt.toISOString());
    expect(toNumber(c.closingOdd!)).toBe(1.75);
    expect(toNumber(c.clv!)).toBeCloseTo(14.28, 2);
  });
});
