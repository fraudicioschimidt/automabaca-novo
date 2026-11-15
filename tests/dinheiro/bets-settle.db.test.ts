import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { applyManualBetStatusChange as applyBetStatusChange } from "../helpers/settle";
import {
  applyAutomaticBetStatusChange,
  BetNotPendingError,
  SportNotConfirmedError,
} from "@/src/services/bets/settle";
import { purgeOldAuditEvents } from "@/src/services/ops/audit-purge";
import { sumMoneyBy, toNumber } from "@/src/domain/money";
import { registerBet } from "@/src/services/bets/register";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { MERCADOS_FINAIS } from "@/src/domain/mercados/catalog";
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { playerPropRule } from "@/src/domain/settlement/player-prop-rules";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

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
  const conta = await db.prisma.conta.create({
    data: { casaDeAposta: "Betano", titular: "Fabricio", saldoInicial: 500, saldoAtual: 500 },
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      contaId: conta.id,
      data: new Date("2026-08-02T19:00:00Z"),
      evento: "Santos vs Grêmio",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Santos",
      odds: 1.8,
      stake: 2,
      valorUnidade: 50,
      status: "PENDING",
    },
  });
  return { bankroll, conta, bet };
}

const opts = () => ({ client: db.prisma });

describe("applyBetStatusChange (Postgres real)", () => {
  it("bloqueia liquidação automática enquanto o esporte estiver pendente", async () => {
    const { bet } = await seed();
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: {
        esporte: "Unknown",
        sportResolutionStatus: "PENDING",
        sportConfidence: 0,
        sportSource: "UNRESOLVED",
        sportResolvedAt: null,
      },
    });
    await expect(
      applyAutomaticBetStatusChange(
        {
          betId: bet.id,
          newStatus: "WON",
          source: "score",
        },
        opts(),
      ),
    ).rejects.toBeInstanceOf(SportNotConfirmedError);
    const unchanged = await db.prisma.bet.findUniqueOrThrow({
      where: { id: bet.id },
    });
    expect(unchanged.status).toBe("PENDING");
    expect(toNumber(unchanged.lucro)).toBe(0);
  });

  it("permite VOID/CANCELED manual sem esperar confirmação do esporte", async () => {
    const { bet } = await seed();
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: {
        esporte: "Unknown",
        sportResolutionStatus: "PENDING",
        sportConfidence: 0,
        sportSource: "UNRESOLVED",
        sportResolvedAt: null,
      },
    });
    for (const newStatus of ["VOID", "CANCELED"] as const) {
      await expect(
        applyBetStatusChange({ betId: bet.id, newStatus, source: "manual:tester" }, opts()),
      ).resolves.toMatchObject({ status: newStatus });
    }
  });

  it("sem esporte confirmado só o VOID/CANCELED manual passa; o antigo marcador do tipster não", async () => {
    const { bet } = await seed();
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: {
        esporte: "Unknown",
        sportResolutionStatus: "PENDING",
        sportConfidence: 0,
        sportSource: "UNRESOLVED",
        sportResolvedAt: null,
      },
    });
    for (const source of ["score", "telegram-edit"]) {
      for (const newStatus of ["WON", "VOID"] as const) {
        await expect(applyBetStatusChange({ betId: bet.id, newStatus, source }, opts())).rejects.toBeInstanceOf(SportNotConfirmedError);
      }
    }
    await expect(applyBetStatusChange({ betId: bet.id, newStatus: "VOID", source: "manual:teste" }, opts()))
      .resolves.toMatchObject({ status: "VOID" });
  });

  it("PENDING→WON: status, lucro, ledger e evento numa transação só", async () => {
    const { conta, bet } = await seed();
    const result = await applyBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "manual" },
      opts(),
    );

    expect(result.previousStatus).toBe("PENDING");
    expect(result.lucro).toBeCloseTo(1.6, 6);

    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.status).toBe("WON");
    expect(toNumber(updated.lucro)).toBeCloseTo(1.6, 6);

    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(contaDb.saldoAtual)).toBe(580); // 500 + 1.6u × R$50

    const events = await db.prisma.settlementEvent.findMany({ where: { betId: bet.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("STATUS_CHANGED");
  });

  it("settledAt marca a resolução e zera ao reverter para PENDING", async () => {
    const { bet } = await seed();
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).settledAt).toBeNull();

    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual" }, opts());
    expect(
      (await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).settledAt,
    ).toBeInstanceOf(Date);

    // 👎/correção volta a PENDING → settledAt limpo (não conta mais como "resolvida hoje").
    await applyBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual" }, opts());
    const revertida = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(revertida.status).toBe("PENDING");
    expect(revertida.settledAt).toBeNull();
  });

  it("correção WON→LOST NÃO reescreve settledAt (KPI do dia estável)", async () => {
    const { bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual" }, opts());
    const first = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(first.settledAt).toBeInstanceOf(Date);
    const settledAt = first.settledAt!.getTime();

    await new Promise((r) => setTimeout(r, 20));
    await applyBetStatusChange({ betId: bet.id, newStatus: "LOST", source: "manual" }, opts());
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after.status).toBe("LOST");
    expect(after.settledAt!.getTime()).toBe(settledAt);
  });

  it("repetir a MESMA transição é no-op: 1 evento, 1 movimentação, zero churn", async () => {
    const { bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "cron" }, opts());
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "cron" }, opts());

    expect(
      await db.prisma.settlementEvent.count({ where: { betId: bet.id } }),
    ).toBe(1);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(1);
  });

  it("duas liquidações automáticas iguais concorrentes geram um único efeito financeiro", async () => {
    const { conta, bet } = await seed();

    const results = await Promise.all([
      applyAutomaticBetStatusChange(
        { betId: bet.id, newStatus: "WON", source: "score:a" },
        opts(),
      ),
      applyAutomaticBetStatusChange(
        { betId: bet.id, newStatus: "WON", source: "score:a" },
        opts(),
      ),
    ]);

    expect(results.map((result) => result.status)).toEqual(["WON", "WON"]);
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id } })).toBe(1);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(1);
    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(contaDb.saldoAtual)).toBe(580);
  });

  it("liquidações automáticas conflitantes concorrentes têm um único vencedor", async () => {
    const { bet } = await seed();
    const settled = await Promise.allSettled([
      applyAutomaticBetStatusChange(
        { betId: bet.id, newStatus: "WON", source: "score:a" },
        opts(),
      ),
      applyAutomaticBetStatusChange(
        { betId: bet.id, newStatus: "LOST", source: "score:b" },
        opts(),
      ),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(BetNotPendingError) });
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id } })).toBe(1);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(1);
  });

  it("no-op financeiro respeita a borda de seis casas do lucro", async () => {
    const { bet } = await seed();
    await applyBetStatusChange(
      { betId: bet.id, newStatus: "CASHOUT", cashoutLucro: 0.1, source: "manual" },
      opts(),
    );
    await applyBetStatusChange(
      { betId: bet.id, newStatus: "CASHOUT", cashoutLucro: 0.1000004, source: "manual" },
      opts(),
    );
    expect(
      await db.prisma.settlementEvent.count({ where: { betId: bet.id } }),
    ).toBe(1);

    await applyBetStatusChange(
      { betId: bet.id, newStatus: "CASHOUT", cashoutLucro: 0.100001, source: "manual" },
      opts(),
    );
    expect(
      await db.prisma.settlementEvent.count({ where: { betId: bet.id } }),
    ).toBe(2);
  });

  it("ciclo WON→VOID→WON termina consistente em bet, conta e ledger", async () => {
    const { conta, bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual" }, opts());
    await applyBetStatusChange({ betId: bet.id, newStatus: "VOID", source: "manual" }, opts());
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual" }, opts());

    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(contaDb.saldoAtual)).toBe(580);

    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(toNumber(updated.lucro)).toBeCloseTo(1.6, 6);
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id } })).toBe(3);
  });

  it("API automática: tip já liquidada → BetNotPendingError (ledger intacto)", async () => {
    const { conta, bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "LOST", source: "manual" }, opts());
    const afterTipster = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(afterTipster.status).toBe("LOST");
    expect(toNumber(afterTipster.lucro)).toBeCloseTo(-2, 6);

    const { BetNotPendingError } = await import("@/src/services/bets/settle");
    await expect(
      applyAutomaticBetStatusChange(
        { betId: bet.id, newStatus: "WON", source: "score" },
        opts(),
      ),
    ).rejects.toBeInstanceOf(BetNotPendingError);

    const still = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(still.status).toBe("LOST");
    expect(toNumber(still.lucro)).toBeCloseTo(-2, 6);
    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(contaDb.saldoAtual)).toBe(400); // 500 - 2u×50
  });

  it("API manual explícita pode corrigir um resultado já liquidado", async () => {
    const { bet } = await seed();
    await applyBetStatusChange({ betId: bet.id, newStatus: "LOST", source: "manual" }, opts());
    const corrected = await applyBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "manual:correcao" },
      opts(),
    );
    expect(corrected.status).toBe("WON");
    expect(corrected.previousStatus).toBe("LOST");
  });

  it("reverter para PENDING limpa placar e observação final (reabre auto-settle)", async () => {
    const { bet } = await seed();
    await db.prisma.betResult.create({
      data: {
        betId: bet.id,
        scoreHome: 2,
        scoreAway: 1,
        resultProvider: "flashscore",
        resultMatchId: "fs-123",
        resultMatchConfidence: 0.98,
        resultSnapshot: { outcome: "matched" },
        resultCheckedAt: new Date(),
        resultFinal: true,
      },
    });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual" }, opts());
    await applyBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual" }, opts());

    const result = await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(result.scoreHome).toBeNull();
    expect(result.scoreAway).toBeNull();
    expect(result.resultProvider).toBeNull();
    expect(result.resultMatchId).toBeNull();
    expect(result.resultMatchConfidence).toBeNull();
    expect(result.resultSnapshot).toBeNull();
    expect(result.resultCheckedAt).toBeNull();
    expect(result.resultFinal).toBe(false);
    const still = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(still.status).toBe("PENDING");
  });

  it("reabrir aposta já PENDING limpa evidência de resultado sem alterar CLV ou ledger", async () => {
    const { bet, conta } = await seed();
    const before = await db.prisma.betClosing.create({
      data: {
        betId: bet.id, fetchedAt: new Date(),
        closingOdd: 2, closingRawOdd: 2, clv: -10,
        closingPriceSnapshot: {
          version: 1, combination: "single",
          components: [{ lineQ: null, rawOdds: [2, 2], selectedIndex: 0, devig: "power" }],
        },
        closingPriceReference: "bridgeodds:v1:reopen-test",
        closingPriceObservedAt: new Date(), provider: "bridgeodds",
        clvReliable: true,
      },
    });
    await db.prisma.betResult.create({
      data: {
        betId: bet.id, scoreHome: 2, scoreAway: 1, resultProvider: "flashscore", resultMatchId: "stale-result",
        resultMatchConfidence: 0.98, resultSnapshot: { outcome: "matched" },
        resultCheckedAt: new Date(), resultFinal: true,
      },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await applyBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual" }, opts());
    }
    expect(await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } })).toMatchObject({
      scoreHome: null, scoreAway: null, resultProvider: null, resultMatchId: null,
      resultMatchConfidence: null, resultSnapshot: null, resultCheckedAt: null, resultFinal: false,
    });
    const after = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(after).toMatchObject({
      clvReliable: before.clvReliable, closingPriceSnapshot: before.closingPriceSnapshot,
      fetchedAt: before.fetchedAt,
    });
    expect(toNumber(after.clv)).toBe(-10);
    expect(toNumber(after.closingOdd)).toBe(2);
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(500);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id, type: "EVIDENCE_CLEARED" } })).toBe(2);
    const cleared = await db.prisma.settlementEvent.findFirstOrThrow({ where: { betId: bet.id, type: "EVIDENCE_CLEARED" }, orderBy: { createdAt: "asc" } });
    expect(cleared.payload).toMatchObject({ previousEvidence: { result: { scoreHome: 2, scoreAway: 1, resultMatchId: "stale-result" } } });
  });

  it("reverter WON→PENDING limpa BetPlayerProp.evidence e sobe revision", async () => {
    const { bet, bankroll } = await seed();
    await db.prisma.bankroll.update({
      where: { id: bankroll.id },
      data: { playerPropsAutoSettlement: true },
    });
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { mercado: "Player Shots", selecao: "Tom Fellows Over 1.5", casaDeAposta: "Betano" },
    });
    const terms = buildPlayerPropTerms({
      mercado: "Player Shots",
      selecao: "Tom Fellows Over 1.5",
      evento: bet.evento,
      esporte: "Soccer",
    })!;
    await db.prisma.betPlayerProp.create({
      data: {
        betId: bet.id,
        terms,
        rule: playerPropRule("Betano", "shots_total"),
        revision: 1,
        resolutionStatus: "MATCHED",
        evidence: { stable: true, proposedStatus: "WON", reason: "stale_fuel" },
      },
    });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual" }, opts());
    await applyBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual" }, opts());

    const prop = await db.prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(prop.evidence).toBeNull();
    expect(prop.revision).toBe(2);
    const reopened = await db.prisma.settlementEvent.findFirstOrThrow({ where: { betId: bet.id, type: "STATUS_CHANGED", payload: { path: ["to"], equals: "PENDING" } } });
    expect(reopened.payload).toMatchObject({ previousEvidence: { playerProp: { terms, revision: 1,
      evidence: { stable: true, proposedStatus: "WON", reason: "stale_fuel" } } } });
    expect(prop.resolutionStatus).toBe("PENDING");
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
  });

  it("reopen já PENDING limpa prop stale e bloqueia auto-settle sem evidência nova", async () => {
    const { bet, bankroll } = await seed();
    await db.prisma.bankroll.update({
      where: { id: bankroll.id },
      data: { playerPropsAutoSettlement: true },
    });
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { mercado: "Player Shots", selecao: "Tom Fellows Over 1.5", casaDeAposta: "Betano" },
    });
    const terms = buildPlayerPropTerms({
      mercado: "Player Shots",
      selecao: "Tom Fellows Over 1.5",
      evento: bet.evento,
      esporte: "Soccer",
    })!;
    await db.prisma.betPlayerProp.create({
      data: {
        betId: bet.id,
        terms,
        rule: playerPropRule("Betano", "shots_total"),
        revision: 3,
        resolutionStatus: "MATCHED",
        evidence: { stable: true, proposedStatus: "WON" },
      },
    });
    // sameOutcome PENDING: limpa mesmo sem mudar status
    await applyBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual" }, opts());
    const prop = await db.prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(prop.evidence).toBeNull();
    expect(prop.revision).toBe(4);
    expect(prop.resolutionStatus).toBe("PENDING");

    // Worker com revision antiga ou sem stable: falha fail-closed (sem combustível stale).
    const current = await db.prisma.bet.findUniqueOrThrow({
      where: { id: bet.id },
      include: { captureEvidence: { select: { caption: true } } },
    });
    const baseTerms = {
      id: current.id,
      mercado: current.mercado,
      selecao: current.selecao,
      odds: current.odds,
      stake: current.stake,
      evento: current.evento,
      esporte: current.esporte,
      competicao: current.competicao,
      pais: current.pais,
      data: current.data,
      registradoEm: current.registradoEm,
      sourcePostedAt: current.sourcePostedAt,
      kickoffInferido: current.kickoffInferido,
      liveScoreHome: current.liveScoreHome,
      liveScoreAway: current.liveScoreAway,
      legsJson: current.legsJson,
      captureEvidence: current.captureEvidence,
      casaDeAposta: current.casaDeAposta ?? "Betano",
    };
    await expect(
      applyAutomaticBetStatusChange(
        {
          betId: bet.id,
          newStatus: "WON",
          source: "flashscore",
          expectedTerms: { ...baseTerms, playerPropRevision: 3 },
        },
        opts(),
      ),
    ).rejects.toThrow();
    await expect(
      applyAutomaticBetStatusChange(
        {
          betId: bet.id,
          newStatus: "WON",
          source: "flashscore",
          expectedTerms: { ...baseTerms, playerPropRevision: 4 },
        },
        opts(),
      ),
    ).rejects.toBeInstanceOf(RecusaDeNegocioError);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
  });

  it("ciclo HALF_WON→VOID→HALF_WON: meio-ganho asiático consistente no ledger", async () => {
    const { conta, bet } = await seed();
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { mercado: "Handicap Asiático", selecao: "Santos -0.25" },
    });
    // odds 1.8, stake 2: half-win = (1.8-1)×2/2 = +0.8u → +R$40.
    const first = await applyBetStatusChange(
      { betId: bet.id, newStatus: "HALF_WON", source: "score" },
      opts(),
    );
    expect(first.lucro).toBeCloseTo(0.8, 6);

    await applyBetStatusChange({ betId: bet.id, newStatus: "VOID", source: "manual" }, opts());
    const aposVoid = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(aposVoid.saldoAtual)).toBe(500);

    await applyBetStatusChange(
      { betId: bet.id, newStatus: "HALF_WON", source: "manual" },
      opts(),
    );
    const final = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(final.saldoAtual)).toBe(540);

    // Invariante: saldoInicial + Σ movimentações = saldoAtual.
    const movs = await db.prisma.movimentacao.findMany({ where: { contaId: conta.id } });
    expect(500 + sumMoneyBy(movs, (m) => toNumber(m.valor), 2)).toBe(540);
    expect(movs.filter((m) => m.tipo === "GANHO_APOSTA")).toHaveLength(2);
    // Estorno é do LÍQUIDO: após o VOID o net da aposta é zero, então o
    // segundo HALF_WON não precisa estornar nada — só 1 ESTORNO no extrato.
    expect(movs.filter((m) => m.tipo === "ESTORNO")).toHaveLength(1);
  });

  it("HALF_LOST lança PERDA_APOSTA de meia stake", async () => {
    const { conta, bet } = await seed();
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { mercado: "Handicap Asiático", selecao: "Santos -0.25" },
    });
    // half-loss = -stake/2 = -1u → -R$50.
    const result = await applyBetStatusChange(
      { betId: bet.id, newStatus: "HALF_LOST", source: "score" },
      opts(),
    );
    expect(result.lucro).toBeCloseTo(-1, 6);

    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(contaDb.saldoAtual)).toBe(450);
    const movs = await db.prisma.movimentacao.findMany({ where: { betId: bet.id } });
    expect(movs).toHaveLength(1);
    expect(movs[0]!.tipo).toBe("PERDA_APOSTA");
  });

  it("CASHOUT sem lucro explícito é rejeitado; com lucro válido lança e registra", async () => {
    const { conta, bet } = await seed();
    await expect(
      applyBetStatusChange({ betId: bet.id, newStatus: "CASHOUT", source: "manual" }, opts()),
    ).rejects.toThrow(/cashout/i);

    await applyBetStatusChange(
      { betId: bet.id, newStatus: "CASHOUT", cashoutLucro: -0.8, source: "manual" },
      opts(),
    );
    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(contaDb.saldoAtual)).toBe(460); // 500 − 0.8u × R$50

    const movs = await db.prisma.movimentacao.findMany({ where: { betId: bet.id } });
    expect(movs).toHaveLength(1);
    expect(movs[0]!.tipo).toBe("PERDA_APOSTA");
  });

  it("correção de 0.004u no mesmo CASHOUT não é descartada pelo limiar em BRL", async () => {
    const { conta, bet } = await seed();
    await applyBetStatusChange(
      { betId: bet.id, newStatus: "CASHOUT", cashoutLucro: 0, source: "manual" },
      opts(),
    );
    await applyBetStatusChange(
      { betId: bet.id, newStatus: "CASHOUT", cashoutLucro: 0.004, source: "manual" },
      opts(),
    );

    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(updated.lucro)).toBe(0.004);
    expect(toNumber(contaDb.saldoAtual)).toBe(500.2);
  });

  it("snapshot: mudar Bankroll.valorUnidade NÃO altera R$ da liquidação", async () => {
    const { bankroll, conta, bet } = await seed();
    // Aposta nasceu com VU=50; banca sobe para 100 antes do settle.
    await db.prisma.bankroll.update({
      where: { id: bankroll.id },
      data: { valorUnidade: 100 },
    });

    await applyBetStatusChange(
      { betId: bet.id, newStatus: "WON", source: "manual" },
      opts(),
    );

    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    // 1.6u × R$50 (snapshot) = +80 → 580; se usasse banca viva seria +160 → 660.
    expect(toNumber(contaDb.saldoAtual)).toBe(580);

    const snap = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(toNumber(snap.valorUnidade)).toBe(50);
  });

  it("bloqueia resultado terminal se kickoffInferido for true no mesmo dia do evento", async () => {
    const { bankroll, conta } = await seed();
    const hoje = new Date();
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        contaId: conta.id,
        data: hoje,
        kickoffInferido: true,
        evento: "Flamengo vs Fluminense",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Flamengo",
        odds: 2.0,
        stake: 1,
        status: "PENDING",
      },
    });

    for (const termStatus of ["WON", "LOST"] as const) {
      await expect(
        applyBetStatusChange(
          {
            betId: bet.id,
            newStatus: termStatus,
            source: "manual",
          },
          opts(),
        ),
      ).rejects.toThrow(/kickoff provisório/i);
    }

    // VOID e CANCELED devem continuar permitidos mesmo com kickoffInferido no mesmo dia
    const voidRes = await applyBetStatusChange(
      { betId: bet.id, newStatus: "VOID", source: "manual" },
      opts(),
    );
    expect(voidRes.status).toBe("VOID");
  });

  it("requirePending: true rejeita com BetNotPendingError aposta não-PENDING", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Batch CAS Bankroll", slug: "batch-cas-bankroll" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        evento: "Cruzeiro vs Atletico MG",
        esporte: "Soccer",
        competicao: "Mineiro",
        pais: "Brasil",
        mercado: "Match Odds",
        selecao: "Cruzeiro",
        odds: 2.10,
        stake: 1.0,
        status: "WON", // Já liquidada automaticamente
        settledAt: new Date(),
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        data: new Date(),
        registradoEm: new Date(),
      },
    });

    await expect(
      applyBetStatusChange(
        {
          betId: bet.id,
          newStatus: "LOST",
          source: "manual:operator",
          requirePending: true,
        },
        { client: db.prisma },
      ),
    ).rejects.toThrow(BetNotPendingError);
  });
});

it.each(["manual", "automatic"])("registra e liquida HALF com linha no mercado pela porta %s", async (authority) => {
  await db.prisma.mercadoPadrao.createMany({ data: MERCADOS_FINAIS.map(nome => ({ nome })) });
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Linha no mercado", slug: "market-line", valorUnidade: 100, vincularContas: true } });
  const conta = await db.prisma.conta.create({ data: { casaDeAposta: "Bet365", titular: "Sintetico", saldoInicial: 0, saldoAtual: 0,
    bankrollLinks: { create: { bankrollId: bankroll.id } } } });
  const registered = await registerBet({ bankrollId: bankroll.id, data: new Date(Date.now() - 86_400_000),
    evento: "Flamengo vs Palmeiras", esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportSource: "MANUAL", sportConfidence: 100,
    competicao: "", pais: "", mercado: "Total 2.25", selecao: "Over", odds: 2, stake: 1, casaDeAposta: "Bet365", source: "test" });
  const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: registered.betId } });
  expect(bet).toMatchObject({ mercado: "Total 2.25", selecao: "Over" });
  const decision = resolveResultFromScore({ mercado: bet.mercado, selecao: bet.selecao, evento: bet.evento,
    esporte: bet.esporte, homeScore: 1, awayScore: 1, odds: 2, stake: 1 });
  expect(decision).toMatchObject({ ok: true, status: "HALF_LOST" });
  if (!decision.ok) throw new Error("Resultado esperado ausente");
  const apply = authority === "manual" ? applyBetStatusChange : applyAutomaticBetStatusChange;
  await apply({ betId: bet.id, newStatus: decision.status, source: authority === "manual" ? "manual:test" : "flashscore" });
  await apply({ betId: bet.id, newStatus: decision.status, source: authority === "manual" ? "manual:test" : "flashscore" });
  expect(toNumber((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).lucro)).toBe(-0.5);
  expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(-50);
  expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(1);
});


describe("prova histórica da liquidação", () => {
  it("reabrir preserva a prova anterior antes de limpar o resultado operacional", async () => {
    const { bet } = await seed();
    const checkedAt = new Date();
    await db.prisma.betResult.create({ data: { betId: bet.id, resultProvider: "flashscore", resultMatchId: "fs-proof",
      scoreHome: 2, scoreAway: 1, resultCheckedAt: checkedAt, resultFinal: true,
      resultSnapshot: { placar: "2-1", stats: { corners: [6, 3] } } } });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual:teste" }, opts());
    await applyBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual:teste" }, opts());
    expect((await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } })).resultSnapshot).toBeNull();
    const event = await db.prisma.settlementEvent.findFirstOrThrow({ where: { betId: bet.id, type: "STATUS_CHANGED", payload: { path: ["to"], equals: "PENDING" } } });
    await purgeOldAuditEvents(new Date(Date.now() + 366 * 86_400_000));
    expect(await db.prisma.settlementEvent.findUnique({ where: { id: event.id } })).not.toBeNull();
    expect(event.payload).toMatchObject({ previousLucro: 1.6, odds: 1.8, stake: 2, valorUnidade: 50,
      terms: { evento: bet.evento, mercado: bet.mercado, selecao: bet.selecao, data: bet.data.toISOString() },
      previousEvidence: { result: { resultMatchId: "fs-proof", scoreHome: 2, scoreAway: 1,
        resultCheckedAt: checkedAt.toISOString(), resultSnapshot: { placar: "2-1", stats: { corners: [6, 3] } } } } });
  });
});


describe("cash-out financeiro", () => {
  it.each([false, true])("permite encerramento manual antes do jogo, kickoff provisório=%s", async (kickoffInferido) => {
    const { bet, conta } = await seed();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { data: new Date("2099-01-01T19:00:00Z"), kickoffInferido } });
    const params = { betId: bet.id, newStatus: "CASHOUT" as const, cashoutLucro: -0.25, source: "manual" };
    expect(await applyBetStatusChange(params, opts())).toMatchObject({ status: "CASHOUT", lucro: -0.25 });
    await applyBetStatusChange(params, opts());
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(487.5);
    expect(await db.prisma.settlementEvent.count()).toBe(1);
    await db.prisma.bet.update({ where: { id: bet.id }, data: { data: new Date("2026-01-01T19:00:00Z"), kickoffInferido: false } });
    await expect(applyAutomaticBetStatusChange({ betId: bet.id, newStatus: "WON", source: "flashscore" }, opts())).rejects.toBeInstanceOf(BetNotPendingError);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("CASHOUT");
  });
  it("cash-out manual não depende de resolver o esporte", async () => {
    const { bet } = await seed();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { esporte: "Unknown", sportResolutionStatus: "PENDING", sportResolvedAt: null } });
    expect(await applyBetStatusChange({ betId: bet.id, newStatus: "CASHOUT", cashoutLucro: 0.5, source: "manual:tester" }, opts()))
      .toMatchObject({ status: "CASHOUT", lucro: 0.5 });
  });
  it("placar automático nunca escolhe um lucro de cash-out", async () => {
    const { bet, conta } = await seed();
    await expect(applyAutomaticBetStatusChange({ betId: bet.id, newStatus: "CASHOUT", cashoutLucro: 0.5, source: "flashscore" }, opts()))
      .rejects.toThrow(/cash.?out.*manual/i);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(500);
    expect(await db.prisma.settlementEvent.count()).toBe(0);
  });
});


describe("cobertura com bilhetes independentes a favor", () => {
  it.each([
    ["WON", "LOST", 520], ["LOST", "WON", 520], ["LOST", "LOST", 340],
  ] as const)("original %s e cobertura %s: saldo %s sem compensação implícita", async (firstStatus, secondStatus, balance) => {
    const { bet, conta } = await seed();
    const cover = await db.prisma.bet.create({ data: { bankrollId: bet.bankrollId, contaId: conta.id,
      data: bet.data, evento: bet.evento, esporte: bet.esporte, sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(),
      mercado: "Moneyline", selecao: "Grêmio", odds: 3, stake: 1.2, valorUnidade: 50 } });
    await applyBetStatusChange({ betId: bet.id, newStatus: firstStatus, source: "manual" }, opts());
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: cover.id } })).status).toBe("PENDING");
    await applyBetStatusChange({ betId: cover.id, newStatus: secondStatus, source: "manual" }, opts());
    await applyBetStatusChange({ betId: cover.id, newStatus: secondStatus, source: "manual" }, opts());
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(balance);
    expect(await db.prisma.movimentacao.count()).toBe(2);
    expect(await db.prisma.settlementEvent.count()).toBe(2);
  });
});
