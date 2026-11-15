import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/src/generated/prisma/client";
import { applyBridgeIdentity } from "@/src/services/sharp/enrich/apply-identity";
import { toNumber } from "@/src/domain/money";
import { settleFromFlashscoreScore, settleFromFlashscoreScoreTx } from "@/src/services/settlement/flashscore/score-settle";
import { persistFlashscoreObservation } from "@/src/services/settlement/flashscore/observation-store";
import { refundFlashscorePostponedOrCancelled, settleFlashscoreBet } from "@/src/services/settlement/flashscore/settle";
import { applyManualBetStatusChange } from "../helpers/settle";
import { softDeleteBet, restoreRemovedBet } from "@/src/services/bets/remove";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { createTestDb, type TestDb } from "../helpers/db";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";
import { operationalActionFingerprint } from "@/src/services/ops/operational-actions";

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
beforeEach(async () => db.reset());
afterAll(async () => db.dispose());

async function capturedBet() {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Corrida de placar", slug: "score-race", valorUnidade: 50 },
  });
  const conta = await db.prisma.conta.create({
    data: { casaDeAposta: "Betano", titular: "Teste", saldoInicial: 500, saldoAtual: 500 },
  });
  const bet = await db.prisma.bet.create({
    data: {
      bankrollId: bankroll.id, contaId: conta.id, valorUnidade: 50,
      evento: "Santos vs Grêmio", data: new Date("2026-08-02T19:00:00Z"),
      esporte: "Soccer", competicao: "Brasileirão", pais: "Brasil",
      mercado: "Total", selecao: "Over 2.5", odds: 2, stake: 1,
      status: "PENDING", sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(),
    },
    include: { sharp: true, closing: true, result: true, captureEvidence: true },
  });
  return { bet, conta };
}

it("identidade com mando invertido preserva o resultado e o ledger do criar-aposta", async () => {
  const { bet: created, conta } = await capturedBet();
  const bet = await db.prisma.bet.update({ where: { id: created.id }, data: {
    evento: "Flamengo vs Palmeiras", mercado: "Criar Aposta", selecao: "Flamengo ML + Over 1.5", casaDeAposta: "Betano",
    legsJson: { kind: "same_game", legs: [
      { evento: "Flamengo vs Palmeiras", mercado: "Moneyline", selecao: "Flamengo" },
      { evento: "Flamengo vs Palmeiras", mercado: "Total", selecao: "Over 1.5" },
    ] },
  } });
  await applyBridgeIdentity({
    bet, teams: { home: "Flamengo", away: "Palmeiras" }, via: "LLM", confidence: 95, gameStart: null,
    best: { match: { match_id: 991, sport: "Soccer", home: "Palmeiras SP", away: "Flamengo RJ", league: "Brazil - Serie A", match_date: bet.data.toISOString() },
      swapped: true, score: 1.9 },
  });
  const enriched = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id },
    include: { sharp: true, closing: true, result: true, captureEvidence: true } });
  expect(enriched.evento).toBe("Palmeiras SP vs Flamengo RJ");
  await expect(settleFromFlashscoreScore(enriched, { homeScore: 2, awayScore: 0 })).resolves.toBe(true);
  expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "LOST" });
  expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(450);
  expect(await db.prisma.movimentacao.findMany({ where: { betId: bet.id } }))
    .toMatchObject([{ tipo: "PERDA_APOSTA", valor: expect.anything() }]);
});

it("perna anulada com outra perdida fica pendente, sem debitar a conta", async () => {
  const { bet: created, conta } = await capturedBet();
  const bet = await db.prisma.bet.update({ where: { id: created.id }, data: {
    mercado: "Criar Aposta", selecao: "Over 2.5 + Santos 0", casaDeAposta: "Betano",
    legsJson: { kind: "same_game", legs: [
      { evento: "Santos vs Grêmio", mercado: "Total", selecao: "Over 2.5" },
      { evento: "Santos vs Grêmio", mercado: "Asian Handicap", selecao: "Santos 0" },
    ] },
  }, include: { sharp: true, closing: true, result: true, captureEvidence: true } });
  await expect(settleFromFlashscoreScore(bet, { homeScore: 0, awayScore: 0 })).resolves.toBe(false);
  expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "PENDING" });
  expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(500);
  expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
  expect(await db.prisma.operationalAction.findUnique({
    where: { fingerprint: operationalActionFingerprint("settlement.score-unsupported", bet.id) },
  })).toMatchObject({ status: "OPEN" });
});

const mutations: Array<{ field: string; data: Prisma.BetUpdateInput }> = [
  { field: "evento", data: { evento: "Flamengo vs Palmeiras" } },
  { field: "horário", data: { data: new Date("2026-08-02T20:00:00Z") } },
  { field: "esporte", data: { esporte: "Basketball" } },
  { field: "competição", data: { competicao: "Copa do Brasil" } },
  { field: "país", data: { pais: "Portugal" } },
  { field: "placar na entrada", data: { liveScoreHome: 1, liveScoreAway: 0 } },
  { field: "pernas", data: { legsJson: {
    kind: "parlay",
    legs: [
      { evento: "Santos vs Grêmio", mercado: "Total", selecao: "Over 2.5" },
      { evento: "Flamengo vs Palmeiras", mercado: "Total", selecao: "Under 3.5" },
    ],
  } } },
  { field: "stake", data: { stake: 2 } },
];

describe("placar recebido após edição da aposta", () => {
  it.each([false, true])("protege evidência de mercado não suportado com edição=%s", async (edited) => {
    const { bet: created } = await capturedBet();
    const bet = await db.prisma.bet.update({
      where: { id: created.id },
      data: { esporte: "Basketball", mercado: "Puck Line", selecao: "Santos -1.5" },
      include: { sharp: true, closing: true, result: true, captureEvidence: true },
    });
    if (edited) {
      await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: "Flamengo vs Palmeiras" } });
    }
    const operation = settleFromFlashscoreScore(bet, { homeScore: 100, awayScore: 90 });
    if (edited) {
      await expect(operation).rejects.toThrow(/mutação material de termos/i);
      expect(await db.prisma.betResult.count({ where: { betId: bet.id } })).toBe(0);
    } else {
      await expect(operation).resolves.toBe(false);
      expect(await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } }))
        .toMatchObject({ scoreHome: 100, scoreAway: 90 });
    }
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "PENDING" });
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
  });

  it.each(["estatística", "reembolso", "observação"])("recusa %s do evento anterior", async (kind) => {
    const { bet, conta } = await capturedBet();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: "Flamengo vs Palmeiras" } });
    const operation = kind === "estatística"
      ? settleFlashscoreBet({ bet, status: "WON", label: "5-2" })
      : kind === "reembolso"
        ? refundFlashscorePostponedOrCancelled(bet)
        : persistFlashscoreObservation({ bet, checkedAt: new Date(), final: true, snapshot: { outcome: "matched" } });
    await expect(operation).rejects.toThrow(/mutação material de termos/i);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "PENDING" });
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(500);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id } })).toBe(0);
    expect(await db.prisma.betResult.count({ where: { betId: bet.id } })).toBe(0);
  });

  it.each(mutations)("recusa snapshot anterior à alteração de $field", async ({ data }) => {
    const { bet, conta } = await capturedBet();
    // A consulta externa começou com `bet`; a edição termina antes de a resposta voltar.
    await db.prisma.bet.update({ where: { id: bet.id }, data });
    await expect(runSerializableTransaction("score-race", (tx) =>
      settleFromFlashscoreScoreTx(tx, bet, { status: "WON", homeScore: 2, awayScore: 1 }),
    { client: db.prisma })).rejects.toThrow(/mutação material de termos/i);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .toMatchObject({ status: "PENDING", settledAt: null });
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(500);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(0);
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id } })).toBe(0);
    expect(await db.prisma.betResult.count({ where: { betId: bet.id } })).toBe(0);
  });

  it("aceita snapshot atual e contabiliza o resultado uma única vez", async () => {
    const { bet, conta } = await capturedBet();
    for (let attempt = 0; attempt < 2; attempt++) {
      await runSerializableTransaction("score-current", (tx) =>
        settleFromFlashscoreScoreTx(tx, bet, { status: "WON", homeScore: 2, awayScore: 1 }),
      { client: db.prisma });
    }
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "WON" });
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(550);
    expect(await db.prisma.movimentacao.count({ where: { betId: bet.id } })).toBe(1);
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id } })).toBe(1);
  });
});

async function seed(params: { mercado: string; selecao: string }) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Recusa de score", slug: `recusa-${params.mercado.length}` },
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      data: new Date("2026-08-13T20:00:00Z"),
      registradoEm: new Date("2026-08-13T18:00:00Z"),
      evento: "France vs Morocco",
      esporte: "Soccer",
      competicao: "World Cup",
      pais: "FIFA",
      mercado: params.mercado,
      selecao: params.selecao,
      odds: 2,
      stake: 1,
      status: "PENDING",
    },
    include: { closing: true, result: true, sharp: true, captureEvidence: true },
  }) as unknown as Promise<EligibleBet>;
}

describe("persistência do placar após recusa", () => {
  it("FlashScore recusou prorrogação — o agregado não é liquidado", async () => {
    const bet = await seed({
      mercado: "Moneyline",
      selecao: "France",
    });
    await db.prisma.betResult.create({
      data: {
        betId: bet.id,
        resultSnapshot: {
          settlementOutcome: "manual_extra_time",
          stage: "Finished after extra time",
        },
        resultFinal: false,
      },
    });
    const withSnapshot = {
      ...bet,
      result: {
        scoreHome: null,
        resultSnapshot: {
          settlementOutcome: "manual_extra_time",
          stage: "Finished after extra time",
        },
      },
    };

    await expect(settleFromFlashscoreScore(withSnapshot, { homeScore: 2, awayScore: 1 }))
      .resolves.toBe(false);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "PENDING" });
    // A recusa nunca fica muda: a aposta parada aparece em Operações.
    await expect(db.prisma.operationalAction.findUnique({
      where: { fingerprint: operationalActionFingerprint("settlement.flashscore-extra-time", bet.id) },
    })).resolves.toMatchObject({ status: "OPEN" });
  });

  it("leitura anterior feita DURANTE a prorrogação não impede liquidar o mercado que inclui prorrogação", async () => {
    const bet = await seed({ mercado: "Total incluindo prorrogação", selecao: "Over 2.5" });
    const liveSnapshot = { outcome: "matched", settlementOutcome: "not_attempted", stage: "Extra Time", placar: "1x1" };
    await db.prisma.betResult.create({
      data: { betId: bet.id, resultSnapshot: liveSnapshot, resultFinal: false },
    });
    const withSnapshot = {
      ...bet,
      result: { scoreHome: null, resultSnapshot: liveSnapshot },
    };

    await expect(settleFromFlashscoreScore(withSnapshot, { homeScore: 2, awayScore: 1 }))
      .resolves.toBe(true);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "WON" });
  });

  it("mercado do tempo regulamentar liquida pelo placar regulamentar declarado, nunca pelo do jogo", async () => {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Regulamentar", slug: "regulamentar" } });
    const create = (selecao: string) => db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), settledAt: null,
        bankrollId: bankroll.id, data: new Date("2026-08-13T20:00:00Z"), registradoEm: new Date("2026-08-13T18:00:00Z"),
        evento: "Lakers vs Celtics", esporte: "Basketball", competicao: "NBA", pais: "USA",
        mercado: "Money Line – Regulation Time", selecao, odds: 3, stake: 1, status: "PENDING",
      },
      include: { closing: true, result: true, sharp: true, captureEvidence: true },
    }) as unknown as Promise<EligibleBet>;
    const empate = await create("Empate");
    const lakers = await create("Lakers");

    await expect(settleFromFlashscoreScore(empate, { homeScore: 100, awayScore: 100 }, {
      scoredEvento: "Lakers vs Celtics", regulationScore: { home: 100, away: 100 },
    })).resolves.toBe(true);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: empate.id } }))
      .resolves.toMatchObject({ status: "WON" });

    // Sem o placar regulamentar (jogo foi à prorrogação), o 110-105 não decide.
    await expect(settleFromFlashscoreScore(lakers, { homeScore: 110, awayScore: 105 }, {
      scoredEvento: "Lakers vs Celtics",
    })).resolves.toBe(false);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: lakers.id } }))
      .resolves.toMatchObject({ status: "PENDING" });
  });

  it("wrong_period não cega o ciclo e a evidência corrigida ainda liquida", async () => {
    const bet = await seed({
      mercado: "Total – Match",
      selecao: "Over 1.5 1st half",
    });
    const score = { homeScore: 2, awayScore: 1 };

    await expect(settleFromFlashscoreScore(bet, score)).resolves.toBe(false);
    await expect(db.prisma.betResult.findUnique({ where: { betId: bet.id } }))
      .resolves.toBeNull();
    await expect(db.prisma.operationalAction.findUnique({
      where: {
        fingerprint: operationalActionFingerprint("settlement.score-unsupported", bet.id),
      },
    })).resolves.toMatchObject({ status: "OPEN", resourceId: bet.id });

    const corrected = await db.prisma.bet.update({
      where: { id: bet.id },
      data: { selecao: "Over 1.5" },
      include: { sharp: true, closing: true, result: true },
    });
    await expect(settleFromFlashscoreScore(corrected, score))
      .resolves.toBe(true);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "WON" });
    await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } }))
      .resolves.toMatchObject({ scoreHome: 2, scoreAway: 1 });
  });

  it("conflicting_live_score não transforma evidência contraditória em final", async () => {
    const seeded = await seed({
      mercado: "Asian Handicap",
      selecao: "(0-0) Morocco +0.25",
    });
    const bet = await db.prisma.bet.update({
      where: { id: seeded.id },
      data: { liveScoreHome: 1, liveScoreAway: 0 },
      include: { closing: true, result: true, sharp: true },
    }) as unknown as EligibleBet;

    await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 })).resolves.toBe(false);

    await expect(db.prisma.betResult.findUnique({ where: { betId: bet.id } }))
      .resolves.toBeNull();
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "PENDING" });
  });

  it("estatística ingere o FT sem abrir ticket de placar", async () => {
    const bet = await seed({
      mercado: "Total (Bookings) – Match",
      selecao: "Under 5.5",
    });

    await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 }))
      .resolves.toBe(false);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "PENDING" });
    await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } }))
      .resolves.toMatchObject({ scoreHome: 2, scoreAway: 1 });
    await expect(db.prisma.operationalAction.findUnique({
      where: {
        fingerprint: operationalActionFingerprint("settlement.score-unsupported", bet.id),
      },
    })).resolves.toBeNull();
  });

  it("combo ML + Over sem legsJson liquida pelo placar do mesmo jogo", async () => {
    const created = await seed({
      mercado: "Moneyline",
      selecao: "France ML + Over 1.5",
    });
    await db.prisma.bet.update({
      where: { id: created.id },
      data: { evento: "France vs Morocco" },
    });
    const bet = {
      ...created,
      evento: "France vs Morocco",
      selecao: "France ML + Over 1.5",
    };

    await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 })).resolves.toBe(true);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "WON" });
  });

  it("dupla gravada com evento amassado liquida por placar de cada jogo", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Dupla", slug: "dupla-placar" },
    });
    const created = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date("2026-08-13T20:00:00Z"),
        registradoEm: new Date("2026-08-13T18:00:00Z"),
        evento: "France vs Morocco | Spain vs Italy",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "France / Spain",
        odds: 2,
        stake: 1,
        status: "PENDING",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
            { evento: "Spain vs Italy", mercado: "Moneyline", selecao: "Spain" },
          ],
        },
      },
      include: { closing: true, result: true, sharp: true, captureEvidence: true },
    });
    const bet = created as unknown as EligibleBet;

    await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 }, {
      scoresByEvento: [
        { evento: "France vs Morocco", home: 2, away: 1 },
      ],
    })).resolves.toBe(false);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "PENDING" });
    await expect(db.prisma.betResult.findUnique({ where: { betId: bet.id } }))
      .resolves.toBeNull();
    await expect(db.prisma.operationalAction.findUnique({
      where: {
        fingerprint: operationalActionFingerprint("settlement.score-unsupported", bet.id),
      },
    })).resolves.toBeNull();

    await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 }, {
      scoresByEvento: [
        { evento: "France vs Morocco", home: 2, away: 1 },
        { evento: "Spain vs Italy", home: 0, away: 1 },
      ],
    })).resolves.toBe(true);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "LOST" });
  });

  it("dupla com scoreHome amassado ainda dobra pelo mapa de confrontos", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Dupla scoreHome", slug: "dupla-scorehome" },
    });
    const created = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date("2026-08-13T20:00:00Z"),
        registradoEm: new Date("2026-08-13T18:00:00Z"),
        evento: "France vs Morocco | Spain vs Italy",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "France / Spain",
        odds: 2,
        stake: 1,
        status: "PENDING",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
            { evento: "Spain vs Italy", mercado: "Moneyline", selecao: "Spain" },
          ],
        },
        result: { create: { scoreHome: 2, scoreAway: 1 } },
      },
      include: { closing: true, result: true, sharp: true, captureEvidence: true },
    });
    const bet = created as unknown as EligibleBet;

    await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 }, {
      scoresByEvento: [
        { evento: "France vs Morocco", home: 2, away: 1 },
        { evento: "Spain vs Italy", home: 1, away: 0 },
      ],
    })).resolves.toBe(true);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "WON" });
  });

  it("dupla com os dois confrontos ganhos liquida WON pelo caminho canônico", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Dupla won", slug: "dupla-placar-won" },
    });
    const created = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date("2026-08-13T20:00:00Z"),
        registradoEm: new Date("2026-08-13T18:00:00Z"),
        evento: "France vs Morocco | Spain vs Italy",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "France / Spain",
        odds: 2,
        stake: 1,
        status: "PENDING",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
            { evento: "Spain vs Italy", mercado: "Moneyline", selecao: "Spain" },
          ],
        },
      },
      include: { closing: true, result: true, sharp: true, captureEvidence: true },
    });
    const bet = created as unknown as EligibleBet;

    await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 }, {
      scoresByEvento: [
        { evento: "France vs Morocco", home: 2, away: 1 },
        { evento: "Spain vs Italy", home: 1, away: 0 },
      ],
    })).resolves.toBe(true);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "WON" });
  });

  it("dupla terminal WON + VOID permanece PENDING mas abre ação manual durável", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Dupla revisão", slug: "dupla-won-void" },
    });
    const created = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: new Date("2026-08-13T20:00:00Z"),
        registradoEm: new Date("2026-08-13T18:00:00Z"),
        evento: "France vs Morocco | Spain vs Italy",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "France / Under 2.0",
        odds: 2,
        stake: 1,
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
            { evento: "Spain vs Italy", mercado: "Total – Match", selecao: "Under 2.0" },
          ],
        },
      },
      include: { closing: true, result: true, sharp: true, captureEvidence: true },
    });
    const bet = created as unknown as EligibleBet;

    await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 }, {
      alertIncompleteLegs: true,
      scoresByEvento: [
        { evento: "France vs Morocco", home: 2, away: 1 },
        { evento: "Spain vs Italy", home: 1, away: 1 },
      ],
    })).resolves.toBe(false);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "PENDING" });
    await expect(db.prisma.operationalAction.findUnique({
      where: {
        fingerprint: operationalActionFingerprint("settlement.score-unsupported", bet.id),
      },
    })).resolves.toMatchObject({ status: "OPEN", resourceId: bet.id });
  });

  describe("criar-aposta com perna de artilheiro", () => {
    const legs = {
      kind: "same_game",
      legs: [
        { evento: "France vs Morocco", mercado: "Total – Match", selecao: "Over 1.5" },
        { evento: "France vs Morocco", mercado: "Marcar a Qualquer Momento", selecao: "Kylian Mbappe" },
      ],
    };
    async function criarAposta() {
      const created = await seed({ mercado: "Criar Aposta", selecao: "Over 1.5 + Kylian Mbappe" });
      return db.prisma.bet.update({ where: { id: created.id }, data: { legsJson: legs },
        include: { sharp: true, closing: true, result: true } });
    }
    const jogador = (nome: string, gols: number) => ({ playerId: `p-${nome}`, nome, gols, golsContra: 0, minutosJogados: 90 });
    const scoreUnsupported = (betId: string) => db.prisma.operationalAction.findUnique({
      where: { fingerprint: operationalActionFingerprint("settlement.score-unsupported", betId) },
    });

    it("à espera da lista de jogadores, a recusa não grava o placar nem chama o dono", async () => {
      const bet = await criarAposta();

      await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 }, { players: null, awaitingData: true }))
        .resolves.toBe(false);

      expect(await db.prisma.betResult.findUnique({ where: { betId: bet.id } })).toBeNull();
      expect(await scoreUnsupported(bet.id)).toBeNull();
    });

    it("perna que já perdeu decide o bilhete mesmo à espera da lista", async () => {
      const bet = await criarAposta();

      await expect(settleFromFlashscoreScore(bet, { homeScore: 1, awayScore: 0 }, { players: null, awaitingData: true }))
        .resolves.toBe(true);

      await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).resolves.toMatchObject({ status: "LOST" });
    });

    it("jogador que a lista não resolve vai para o dono, com o placar gravado", async () => {
      const bet = await criarAposta();

      await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 }, {
        players: [jogador("Dembele Ousmane", 1), jogador("Griezmann Antoine", 1)],
        alertStatQualifier: true,
      })).resolves.toBe(false);

      await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } }))
        .resolves.toMatchObject({ scoreHome: 2, scoreAway: 1 });
      await expect(scoreUnsupported(bet.id)).resolves.toMatchObject({ status: "OPEN" });
    });
  });

  it("mercado realmente unsupported preserva o FT para o card manual", async () => {
    const bet = await seed({
      mercado: "Mercado sem motor",
      selecao: "Escolha sem motor",
    });

    await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 }))
      .resolves.toBe(false);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "PENDING" });
    await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } }))
      .resolves.toMatchObject({ scoreHome: 2, scoreAway: 1 });
    await expect(db.prisma.operationalAction.findUnique({
      where: {
        fingerprint: operationalActionFingerprint("settlement.score-unsupported", bet.id),
      },
    })).resolves.toMatchObject({ status: "OPEN", resourceId: bet.id });
  });
});


describe("resposta do FlashScore de um ciclo anterior", () => {
  it.each(["reabrir", "restaurar", "editar e desfazer", "limpar pendente"])("recusa resultado antigo após %s", async (operation) => {
    const { bet, conta } = await capturedBet();
    if (operation === "reabrir") {
      await applyManualBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual:teste" });
      await applyManualBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual:teste" });
    } else if (operation === "restaurar") {
      await softDeleteBet({ betId: bet.id, actor: "test", motivo: "remover", origin: "painel" }, { deferEffects: true });
      await restoreRemovedBet({ betId: bet.id, actor: "test", motivo: "restaurar", by: "painel" }, { deferEffects: true });
    } else if (operation === "editar e desfazer") {
      await db.prisma.bet.update({ where: { id: bet.id }, data: { stake: 2 } });
      await db.prisma.bet.update({ where: { id: bet.id }, data: { stake: 1 } });
    } else {
      await applyManualBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual:teste" });
    }
    await expect(settleFromFlashscoreScore(bet, { homeScore: 2, awayScore: 1 }))
      .rejects.toMatchObject({ name: "BetSettlementTermsChangedError" });
    await expect(persistFlashscoreObservation({ bet, checkedAt: new Date(), final: true, snapshot: { outcome: "matched" } }))
      .rejects.toMatchObject({ name: "BetSettlementTermsChangedError" });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "PENDING" });
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(500);
    expect(await db.prisma.betResult.findUnique({ where: { betId: bet.id } })).not.toMatchObject({ resultFinal: true });
    const fresh = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, include: { sharp: true, closing: true, result: true } });
    await expect(settleFromFlashscoreScore(fresh, { homeScore: 2, awayScore: 1 })).resolves.toBe(true);
  });
});


it("observação em voo não repõe evidência em aposta removida", async () => {
  const { bet } = await capturedBet();
  await softDeleteBet({ betId: bet.id, actor: "test", motivo: "remover", origin: "painel" }, { deferEffects: true });
  await expect(persistFlashscoreObservation({ bet, checkedAt: new Date(), final: true, snapshot: { outcome: "matched" } }))
    .rejects.toMatchObject({ name: "BetSettlementTermsChangedError" });
  expect(await db.prisma.betResult.findUnique({ where: { betId: bet.id } })).toBeNull();
});
