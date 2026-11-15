import { describe, expect, it } from "vitest";
import { computeClvV1 } from "@/src/domain/analyzer/clv";
import {
  comparaDecisao,
  computeDecisaoCanal,
  type DecisaoBetInput,
  type DecisaoCanal,
  rankingDaDecisaoNaTela,
  type RankingDecisao,
} from "@/src/domain/analyzer/decisao";
import { computeOverviewV1 } from "@/src/domain/analyzer/overview";
import { tCritico95, vereditoEdge, vereditoEdgeFromStats } from "@/src/domain/analyzer/shared";
import type { BetRowData } from "@/src/domain/bet-read-model";

/** Métricas de decisão de assinatura (contrato do Analyzer) — lógica pura. */

const REF = new Date("2026-06-11T00:00:00Z");
const DIA = 86_400_000;
const diasAntes = (n: number) => new Date(REF.getTime() - n * DIA);

function bet(p: Partial<DecisaoBetInput> = {}): DecisaoBetInput {
  const data = p.data ?? diasAntes(5);
  return {
    data,
    status: "WON",
    stake: 1,
    lucro: 0,
    clv: null,
    clvReliable: null,
    closingFetchedAt: diasAntes(5), // default = fechamento CONGELADO (CLV final)
    ...p,
  };
}

function betRow(p: Partial<BetRowData> = {}): BetRowData {
  const data = p.data ?? diasAntes(5);
  return {
    id: "b",
    data,
    settledAt: p.status === "PENDING" ? null : (p.settledAt ?? data),
    evento: "Time A x Time B",
    competicao: "",
    pais: "",
    esporte: "Soccer",
    mercado: "Total",
    selecao: "Over 2.5",
    casaDeAposta: "",
    tipster: "",
    odds: 1.9,
    stake: 1,
    status: "WON",
    lucro: 0.9,
    closingOdd: null,
    openingMaxBet: null,
    closingMaxBet: null,
    openingOdd: null,
    openingRawOdd: null,
    closingRawOdd: null,
    registradoEm: diasAntes(5),
    clv: null,
    clvReliable: null,
    closingFetchedAt: diasAntes(5), // default = fechamento CONGELADO (CLV final)
    identityStatus: null,
    noOddsReason: null,
    closingNoOddsReason: null,
    source: "web",
    sourceExternalId: null,
    contaTitular: null,
    ...p,
  };
}

describe("vereditoEdge", () => {
  it("amostra vazia ou abaixo de 30 → AMOSTRA_CURTA", () => {
    expect(vereditoEdge([]).veredito).toBe("AMOSTRA_CURTA");
    expect(vereditoEdge(Array.from({ length: 29 }, () => 2)).veredito).toBe("AMOSTRA_CURTA");
  });

  it("30 CLVs idênticos (sd 0): decide pelo sinal, sem t-stat", () => {
    const pos = vereditoEdge(Array.from({ length: 30 }, () => 2));
    expect(pos).toEqual({ veredito: "EDGE", tStat: null });
    const neg = vereditoEdge(Array.from({ length: 30 }, () => -2));
    expect(neg.veredito).toBe("SEM_EDGE");
  });

  it("variância numérica desprezível não produz t-stat artificialmente gigante", () => {
    const clvs = Array.from({ length: 30 }, (_, i) => 2 + (i % 2 ? 1e-12 : -1e-12));
    expect(vereditoEdge(clvs)).toEqual({ veredito: "EDGE", tStat: null });
  });

  it("CLV médio positivo consistente → EDGE com t acima do crítico", () => {
    const clvs = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 1.5 : 2.5));
    const r = vereditoEdge(clvs);
    expect(r.veredito).toBe("EDGE");
    expect(r.tStat).not.toBeNull();
    expect(r.tStat!).toBeGreaterThan(1.96);
  });

  it("CLV médio negativo consistente → SEM_EDGE", () => {
    const clvs = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? -1.5 : -2.5));
    expect(vereditoEdge(clvs).veredito).toBe("SEM_EDGE");
  });

  it("ruído em torno de zero → INCONCLUSIVO", () => {
    const clvs = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 5 : -4.8));
    expect(vereditoEdge(clvs).veredito).toBe("INCONCLUSIVO");
  });

  it("usa o crítico t, não z: t-stat em [1.96, 2.045) com n=30 → INCONCLUSIVO", () => {
    // 15× 1.37 + 15× -0.63: média 0.37, t-stat ≈ 1.99 (df 29, crítico t 2.045).
    // Com z=1.96 seria EDGE; com o t real é INCONCLUSIVO.
    const clvs = [
      ...Array.from({ length: 15 }, () => 1.37),
      ...Array.from({ length: 15 }, () => -0.63),
    ];
    const r = vereditoEdge(clvs);
    expect(r.tStat).not.toBeNull();
    expect(r.tStat!).toBeGreaterThan(1.96);
    expect(r.tStat!).toBeLessThan(2.045);
    expect(r.veredito).toBe("INCONCLUSIVO");
  });
});

describe("tCritico95 (distribuição t bicaudal 95%)", () => {
  it("~2.045 em df 29, ~2.262 em df 9, tende a 1.96 em df grande", () => {
    expect(tCritico95(29)).toBeCloseTo(2.045, 2);
    expect(tCritico95(9)).toBeCloseTo(2.262, 2);
    expect(tCritico95(1_000_000)).toBeCloseTo(1.96, 3);
  });
});

describe("computeOverviewV1 — roiClvGap sobre o mesmo subconjunto", () => {
  it("contagens e sequências são inteiras; meias decisões ficam explícitas", () => {
    const o = computeOverviewV1([
      betRow({ id: "w", data: diasAntes(4), status: "WON" }),
      betRow({ id: "hw", data: diasAntes(3), status: "HALF_WON", lucro: 0.45 }),
      betRow({ id: "l", data: diasAntes(2), status: "LOST", lucro: -1 }),
      betRow({ id: "hl", data: diasAntes(1), status: "HALF_LOST", lucro: -0.5 }),
    ]);
    expect(o).toMatchObject({
      wonBets: 1,
      halfWonBets: 1,
      lostBets: 1,
      halfLostBets: 1,
      maxWinStreak: 2,
      maxLossStreak: 2,
    });
  });

  it("ROI esperado e gap saem das resolvidas COM CLV; PENDING não infla o esperado", () => {
    const bets = [
      betRow({ status: "WON", stake: 100, lucro: 10, clv: 5, clvReliable: true }),
      betRow({ status: "PENDING", stake: 900, lucro: 0, clv: 20, clvReliable: true }),
    ];
    const o = computeOverviewV1(bets);
    // Só a WON (resolvida + CLV) entra: esperado 5%, realizado 10% → gap +5%.
    // Se a PENDING (stake 900, clv 20%) entrasse, o esperado iria a 18,5% e o gap a −8,5%.
    expect(o.expectedRoi).toBeCloseTo(5, 6);
    expect(o.realizedRoiClv).toBeCloseTo(10, 6);
    expect(o.realizedRoiClvN).toBe(1);
    expect(o.roiClvGap).toBeCloseTo(5, 6);
  });

  it("ROI real do trio é o das resolvidas COM CLV; resolvida sem CLV não move o trio", () => {
    const comClv = betRow({ id: "clv", status: "WON", stake: 100, lucro: 10, clv: 5, clvReliable: true });
    const semClv = betRow({
      id: "sem",
      status: "LOST",
      stake: 100,
      lucro: -100,
      clv: null,
      clvReliable: null,
      closingFetchedAt: null,
    });
    const o = computeOverviewV1([comClv, semClv]);
    expect(o.roi).toBeCloseTo(-45, 6);
    expect(o.realizedRoiClv).toBeCloseTo(10, 6);
    expect(o.expectedRoi).toBeCloseTo(5, 6);
    expect(o.realizedRoiClvN).toBe(1);
    expect(o.realizedRoiClv! - o.expectedRoi!).toBeCloseTo(o.roiClvGap!, 6);
    const soComClv = computeOverviewV1([comClv]);
    expect(soComClv.realizedRoiClv).toBeCloseTo(o.realizedRoiClv!, 6);
    expect(soComClv.expectedRoi).toBeCloseTo(o.expectedRoi!, 6);
    expect(soComClv.roiClvGap).toBeCloseTo(o.roiClvGap!, 6);
  });

  it("ordena e agrupa o PnL pelo dia do jogo, mesmo com a liquidação atrasada", () => {
    const o = computeOverviewV1([
      betRow({
        id: "late-settle",
        data: new Date("2026-01-31T15:00:00Z"),
        settledAt: new Date("2026-02-02T15:00:00Z"),
        lucro: 1,
      }),
      betRow({
        id: "early-settle",
        data: new Date("2026-02-01T15:00:00Z"),
        settledAt: new Date("2026-02-01T15:00:00Z"),
        lucro: 2,
      }),
    ]);
    expect(o.pnl.map((point) => point.dayKey)).toEqual(["2026-01-31", "2026-02-01"]);
    expect(o.pnl.map((point) => point.cum)).toEqual([1, 3]);
  });
});

describe("computeDecisaoCanal", () => {
  it("canal vazio: zera contagens, anula métricas e marca amostra curta", () => {
    const d = computeDecisaoCanal([], REF);
    expect(d.apostas).toBe(0);
    expect(d.nClv).toBe(0);
    expect(d.beatClosePct).toBeNull();
    expect(d.clvMedio).toBeNull();
    expect(d.roiReal).toBeNull();
    expect(d.deltaClv30d).toBeNull();
    expect(d.veredito).toBe("AMOSTRA_CURTA");
    expect(d.distClv).toHaveLength(5);
    expect(d.distClv.every((f) => f.count === 0)).toBe(true);
  });

  it("beat-the-close e distribuição cobrem as 5 faixas de CLV", () => {
    const bets = [-6, -2, 3, 7, 12].map((clv) => bet({ clv, clvReliable: true }));
    const d = computeDecisaoCanal(bets, REF);
    expect(d.nClv).toBe(5);
    expect(d.beatClosePct).toBeCloseTo(60);
    expect(d.clvMedio).toBeCloseTo(2.8);
    expect(d.distClv.map((f) => f.count)).toEqual([1, 1, 1, 1, 1]);
  });

  it("CLV com clvReliable=false fica fora da amostra", () => {
    const d = computeDecisaoCanal([bet({ clv: 10, clvReliable: false })], REF);
    expect(d.nClv).toBe(0);
    expect(d.beatClosePct).toBeNull();
  });

  it("CLV PROVISÓRIO (closingFetchedAt null) fica fora do veredito", () => {
    // Provider não-bridge captura linha pré-kickoff (clvReliable=true, fetchedAt=null);
    // esse CLV ainda em movimento não pode entrar no t-test/EDGE do canal.
    const d = computeDecisaoCanal(
      [bet({ clv: 8, clvReliable: true, closingFetchedAt: null })],
      REF,
    );
    expect(d.nClv).toBe(0);
    expect(d.clvMedio).toBeNull();
    expect(d.beatClosePct).toBeNull();
  });

  it("ROI real sai de todas as liquidadas (pendente e VOID fora)", () => {
    const bets = [
      bet({ status: "WON", stake: 1, lucro: 1 }),
      bet({ status: "LOST", stake: 1, lucro: -1 }),
      bet({ status: "PENDING", stake: 1, lucro: 0 }),
      bet({ status: "VOID", stake: 1, lucro: 0 }),
      bet({ status: "WON", stake: 1, lucro: 0.9 }),
    ];
    const d = computeDecisaoCanal(bets, REF);
    expect(d.nFinal).toBe(3);
    expect(d.roiReal).toBeCloseTo(30);
  });

  it("decaimento: CLV médio dos últimos 30d menos o dos 30d anteriores", () => {
    const bets = [
      bet({ data: diasAntes(5), clv: 3, clvReliable: true }),
      bet({ data: diasAntes(10), clv: 1, clvReliable: true }),
      bet({ data: diasAntes(35), clv: 5, clvReliable: true }),
      bet({ data: diasAntes(50), clv: 7, clvReliable: true }),
      bet({ data: diasAntes(90), clv: 100, clvReliable: true }),
    ];
    const d = computeDecisaoCanal(bets, REF);
    expect(d.clv30d).toBeCloseTo(2);
    expect(d.n30d).toBe(2);
    expect(d.n30a60d, "a base do outro lado vem junto").toBe(2);
    expect(d.deltaClv30d).toBeCloseTo(2 - 6);
  });

  it("janela de decisão segue o dia do jogo, não a liquidação", () => {
    // Jogo de 50 dias atrás liquidado há 5: fica nos 30 dias anteriores.
    const atrasada = { ...bet({ data: diasAntes(50), clv: 4, clvReliable: true }), settledAt: diasAntes(5) };
    // Jogo de 5 dias atrás ainda sem resultado: fica nos últimos 30.
    const d = computeDecisaoCanal(
      [atrasada, bet({ data: diasAntes(5), status: "PENDING", clv: 1, clvReliable: true })],
      REF,
    );
    expect([d.n30d, d.clv30d]).toEqual([1, 1]);
    expect(d.n30a60d).toBe(1);
    expect(d.deltaClv30d).toBeCloseTo(1 - 4);
  });

  it("as janelas viram à meia-noite de São Paulo", () => {
    // REF é 10/06 21h em SP: os últimos 30 dias começam em 12/05 00h de SP (03h UTC).
    const d = computeDecisaoCanal(
      [
        bet({ data: new Date("2026-05-12T03:00:00Z"), clv: 2, clvReliable: true }),
        bet({ data: new Date("2026-05-12T02:59:00Z"), clv: 6, clvReliable: true }),
        bet({ data: new Date("2026-04-12T02:59:00Z"), clv: 50, clvReliable: true }),
      ],
      REF,
    );
    expect([d.n30d, d.n30a60d]).toEqual([1, 1]);
    expect(d.deltaClv30d).toBeCloseTo(2 - 6);
  });

  it("não compara os últimos 30d com histórico anterior à janela precedente", () => {
    const d = computeDecisaoCanal(
      [
        bet({ data: diasAntes(3), clv: 2, clvReliable: true }),
        bet({ data: diasAntes(61), clv: -20, clvReliable: true }),
      ],
      REF,
    );
    expect(d.clv30d).toBeCloseTo(2);
    expect(d.deltaClv30d).toBeNull();
  });

  it("sem apostas antigas não há base de comparação → delta null", () => {
    const d = computeDecisaoCanal([bet({ data: diasAntes(3), clv: 2, clvReliable: true })], REF);
    expect(d.clv30d).toBeCloseTo(2);
    expect(d.deltaClv30d).toBeNull();
  });

  it("CLV de aposta pendente conta para a amostra (padrão da aba de CLV)", () => {
    const d = computeDecisaoCanal([bet({ status: "PENDING", clv: 4, clvReliable: true })], REF);
    expect(d.nClv).toBe(1);
    expect(d.nFinal).toBe(0);
  });
});

describe("comparaDecisao", () => {
  function dec(p: Partial<DecisaoCanal>): DecisaoCanal {
    return {
      apostas: 0,
      nClv: 0,
      beatClosePct: null,
      clvMedio: null,
      distClv: [],
      nFinal: 0,
      roiReal: null,
      clv30d: null,
      n30d: 0,
      n30a60d: 0,
      deltaClv30d: null,
      veredito: "AMOSTRA_CURTA",
      tStat: null,
      ...p,
    };
  }

  it("ordena por evidência: EDGE, INCONCLUSIVO, AMOSTRA_CURTA, SEM_EDGE", () => {
    const lista = [
      dec({ veredito: "SEM_EDGE", tStat: -3 }),
      dec({ veredito: "EDGE", tStat: 2.5 }),
      dec({ veredito: "AMOSTRA_CURTA" }),
      dec({ veredito: "INCONCLUSIVO", tStat: 1 }),
    ];
    expect([...lista].sort(comparaDecisao).map((d) => d.veredito)).toEqual([
      "EDGE",
      "INCONCLUSIVO",
      "AMOSTRA_CURTA",
      "SEM_EDGE",
    ]);
  });

  it("dentro do mesmo veredito vence o maior t; t null vai pro fim", () => {
    const a = dec({ veredito: "EDGE", tStat: 4 });
    const b = dec({ veredito: "EDGE", tStat: 2 });
    const c = dec({ veredito: "EDGE", tStat: null, clvMedio: 9 });
    expect([c, b, a].sort(comparaDecisao)).toEqual([a, b, c]);
  });
});

describe("robustez a entrada suja", () => {
  it("comparaDecisao não retorna NaN quando ambos tStat ou clvMedio são nulos ou recebem chaves especiais", () => {
    const a: RankingDecisao = { veredito: "AMOSTRA_CURTA", tStat: null, clvMedio: null };
    const b: RankingDecisao = { veredito: "AMOSTRA_CURTA", tStat: null, clvMedio: null };
    const cmp = comparaDecisao(a, b);
    expect(Number.isFinite(cmp)).toBe(true);
    expect(cmp).toBe(0);

    const special = { veredito: "toString" as unknown as RankingDecisao["veredito"], tStat: null, clvMedio: null };
    expect(Number.isFinite(comparaDecisao(special, a))).toBe(true);
  });

  it("rankingDaDecisaoNaTela rejeita propriedades herdadas como toString", () => {
    const dec = { verdict: "toString", tStat: 2.5, clvMedio: 3.1 };
    const rank = rankingDaDecisaoNaTela(dec);
    expect(rank.veredito).toBe("AMOSTRA_CURTA");
  });

  it("lucro realizado em computeClvV1 é case-insensitive e suporta trim", () => {
    const now = new Date();
    const bets: BetRowData[] = [
      {
        id: "1",
        data: now,
        evento: "Time A x Time B",
        competicao: "Brasileirao",
        pais: "BR",
        esporte: "Futebol",
        sportResolutionStatus: "RESOLVED",
        mercado: "ML",
        selecao: "Casa",
        liveScoreHome: null,
        liveScoreAway: null,
        kickoffInferido: false,
        casaDeAposta: "Pinnacle",
        tipster: "Tipster 1",
        odds: 1.9,
        stake: 100,
        status: " won ",
        lucro: 90,
        closingOdd: 1.8,
        openingMaxBet: null,
        closingMaxBet: null,
        openingOdd: null,
        openingRawOdd: null,
        closingRawOdd: null,
        registradoEm: now,
        settledAt: now,
        clv: 3.5,
        clvReliable: true,
        closingFetchedAt: now,
        identityStatus: null,
        noOddsReason: null,
        closingNoOddsReason: null,
        source: "TELEGRAM",
        sourceExternalId: null,
        contaTitular: null,
      },
    ];

    const evClv = computeClvV1(bets);
    expect(evClv.totalWithClv).toBe(1);
    expect(evClv.actualLucro).toBe(90);
  });

  it("overview streaks e contagens são case-insensitive e suportam trim", () => {
    const now = new Date();
    const baseBet = {
      data: now,
      competicao: "Brasileirao",
      pais: "BR",
      esporte: "Futebol",
      sportResolutionStatus: "RESOLVED",
      mercado: "ML",
      selecao: "1",
      liveScoreHome: null,
      liveScoreAway: null,
      kickoffInferido: false,
      casaDeAposta: "Bet",
      tipster: "Tipster 1",
      odds: 2.0,
      stake: 10,
      closingOdd: null,
      openingMaxBet: null,
      closingMaxBet: null,
      openingOdd: null,
      openingRawOdd: null,
      closingRawOdd: null,
      registradoEm: now,
      clv: null,
      clvReliable: null,
      closingFetchedAt: null,
      identityStatus: null,
      noOddsReason: null,
      closingNoOddsReason: null,
      source: "TELEGRAM",
      sourceExternalId: null,
      contaTitular: null,
    };

    const bets: BetRowData[] = [
      { ...baseBet, id: "1", evento: "Jogo 1", settledAt: now, status: " won ", lucro: 10 },
      { ...baseBet, id: "2", evento: "Jogo 2", settledAt: now, status: "WON", lucro: 10 },
      { ...baseBet, id: "3", evento: "Jogo 3", settledAt: now, status: "lost\n", lucro: -10 },
      { ...baseBet, id: "4", evento: "Jogo 4", settledAt: null, status: " pending ", lucro: 0 },
    ];

    const ov = computeOverviewV1(bets);
    expect(ov.totalBets).toBe(4);
    expect(ov.resolvedBets).toBe(3);
    expect(ov.pendingBets).toBe(1);
    expect(ov.wonBets).toBe(2);
    expect(ov.lostBets).toBe(1);
    expect(ov.maxWinStreak).toBe(2);
    expect(ov.maxLossStreak).toBe(1);
  });
});

describe("reconstrução da ordem dos indicadores", () => {
  it("o drawdown independe da ordem de chegada de apostas com kickoff igual", () => {
    const rows = [
      betRow({ id: "a", status: "WON", lucro: 2 }),
      betRow({ id: "b", status: "LOST", lucro: -3 }),
      betRow({ id: "c", status: "WON", lucro: 5 }),
    ];
    expect(computeOverviewV1(rows).pnl).toEqual(computeOverviewV1([...rows].reverse()).pnl);
    expect(computeOverviewV1(rows).maxDrawdown).toBe(-3);
  });
  it("reembolso interrompe a sequência sem entrar no ROI", () => {
    const rows = [
      betRow({ id: "a", data: diasAntes(3), status: "WON", lucro: 1 }),
      betRow({ id: "b", data: diasAntes(2), status: "VOID", lucro: 0, stake: 10 }),
      betRow({ id: "c", data: diasAntes(1), status: "WON", lucro: 1 }),
    ];
    expect(computeOverviewV1(rows)).toMatchObject({ maxWinStreak: 1, totalStake: 2, totalLucro: 2 });
  });
});

describe("desempate estável de drawdown", () => {
  it("mantém o drawdown ao intercalar perdas do mesmo kickoff em outra leitura", () => {
    const a = betRow({ id: "a", status: "WON", lucro: 2 });
    const b = betRow({ id: "b", status: "LOST", lucro: -3 });
    const c = betRow({ id: "c", status: "LOST", lucro: -4 });
    const d = betRow({ id: "d", status: "WON", lucro: 5 });
    expect(computeOverviewV1([a, b, c, d]).maxDrawdown).toBe(-7);
    expect(computeOverviewV1([b, a, c, d]).maxDrawdown).toBe(-7);
  });
});

it("CLV de decisão explicitamente ausente não é substituído pelo número de exibição", () => {
  expect(rankingDaDecisaoNaTela({ veredito: "AMOSTRA_CURTA", tStat: null, clvMedio: null, clv: 20 }))
    .toEqual({ veredito: "AMOSTRA_CURTA", tStat: null, clvMedio: null });
});


describe("vereditoEdge — integridade da amostra e da dispersão", () => {
  it("não conta valores não finitos para alcançar o piso de 30", () => {
    const clvs = [...Array.from({ length: 29 }, () => 2), NaN, Infinity, -Infinity];
    expect(vereditoEdge(clvs)).toEqual({ veredito: "AMOSTRA_CURTA", tStat: null });
  });

  it.each([NaN, Infinity, -1, 30.5])("recusa contagem inválida %s", (n) => {
    expect(vereditoEdgeFromStats(n, 2, 1)).toEqual({ veredito: "AMOSTRA_CURTA", tStat: null });
  });

  it.each([
    [null, 1], [NaN, 1], [Infinity, 1], [2, null], [2, -1], [2, NaN], [2, Infinity],
  ])("estatística indisponível não sustenta veredito: média %s, desvio %s", (mean, sd) => {
    expect(vereditoEdgeFromStats(30, mean, sd)).toEqual({ veredito: "INCONCLUSIVO", tStat: null });
  });

  it("o teste é invariante à escala, inclusive perto de zero", () => {
    const clvs = Array.from({ length: 40 }, (_, i) => i % 2 ? 5 : -4.8);
    const original = vereditoEdge(clvs);
    const scaled = vereditoEdge(clvs.map((v) => v * 1e-12));
    expect(original.veredito).toBe("INCONCLUSIVO");
    expect(scaled.veredito).toBe(original.veredito);
    expect(scaled.tStat).toBeCloseTo(original.tStat!, 12);
  });
});


it("a evolução semanal conta só os fechamentos que sustentam a média", () => {
  const rows = [
    betRow({ id: "final", clv: 8, clvReliable: true }),
    betRow({ id: "missing" }),
    betRow({ id: "provisional", clv: 12, clvReliable: true, closingFetchedAt: null }),
    betRow({ id: "unreliable", clv: 20, clvReliable: false }),
  ];
  expect(computeClvV1(rows).clvEvolution).toEqual([{ week: expect.any(String), avgClv: 8, count: 1 }]);
  expect(computeClvV1(rows.slice(1)).clvEvolution).toEqual([{ week: expect.any(String), avgClv: null, count: 0 }]);
});
