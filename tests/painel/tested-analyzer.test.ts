import { describe, expect, it } from "vitest";
import { testedAnData } from "@/app/_design/lib/tested-analyzer";
import { aindaSeMove, emCursoDaLinha } from "@/app/_design/lib/balde-em-curso";
import { computeOverviewV1 } from "@/src/domain/analyzer/overview";
import { computeClvV1 } from "@/src/domain/analyzer/clv";
import { agregaGrupo } from "@/src/domain/analyzer/shared";
import { sumMoneyBy } from "@/src/domain/money";
import type { BetRowData } from "@/src/domain/bet-read-model";

/**
 * O shim (D/E/S/Z/segData/P) é fiel à saída dos compute*V1: não recalcula nem
 * corrompe.
 */
let id = 0;
function makeBet(over: Partial<BetRowData> = {}): BetRowData {
  id += 1;
  const data = over.data ?? new Date("2026-06-15T19:00:00Z");
  return {
    id: `bet-${id}`,
    data,
    settledAt: over.status === "PENDING" ? null : (over.settledAt ?? data),
    evento: "Flamengo vs Palmeiras",
    competicao: "Brasileirão",
    pais: "Brasil",
    esporte: "futebol",
    mercado: "Total de gols",
    selecao: "Mais de 2.5",
    casaDeAposta: "Bet365",
    tipster: "Canal X",
    odds: 1.95,
    stake: 2,
    status: "WON",
    lucro: 1.9,
    closingOdd: 1.85,
    closingMaxBet: 500,
    openingMaxBet: 300,
    openingOdd: 2.0,
    openingRawOdd: 2.0,
    closingRawOdd: 1.85,
    registradoEm: new Date("2026-06-15T15:00:00Z"),
    clv: 5.4,
    clvReliable: true,
    closingFetchedAt: new Date("2026-06-15T19:00:00Z"), // fechamento CONGELADO (CLV final)
    identityStatus: "MATCHED",
    noOddsReason: null,
    closingNoOddsReason: null,
    source: "telegram-channel:-100123",
    sourceExternalId: "123",
    contaTitular: "Fabricio",
    ...over,
  };
}

const FB: BetRowData[] = [
  makeBet({ esporte: "futebol", casaDeAposta: "Bet365", status: "WON", lucro: 1.9, data: new Date("2026-06-10T19:00:00Z") }),
  makeBet({ esporte: "futebol", casaDeAposta: "Betano", status: "LOST", lucro: -2, clv: -3, data: new Date("2026-06-11T19:00:00Z") }),
  makeBet({ esporte: "basquete", casaDeAposta: "Bet365", status: "PENDING", lucro: 0, clv: null, data: new Date("2026-06-12T19:00:00Z") }),
  makeBet({ esporte: "basquete", casaDeAposta: "Pinnacle", status: "HALF_WON", lucro: 0.8, data: new Date("2026-06-13T19:00:00Z") }),
];

describe("tested-analyzer shim", () => {
  it.each([
    { closingMaxBet: null, closingMaxBetCurrency: "USD" },
    { closingMaxBet: 500, closingMaxBetCurrency: null },
    { closingMaxBet: 500, closingMaxBetCurrency: "BRL" },
  ])("CLV disponível sem limite USD não é cobertura de liquidez (%j)", (missing) => {
    const z = testedAnData.Z([
      makeBet({ closingMaxBet: 1_000, closingMaxBetCurrency: "USD" }),
      makeBet(missing),
    ]);
    expect(z.lqClosingN).toBe(1);
    expect(z.liquidezCobertura.cobertas).toHaveLength(1);
    expect(z.liquidezCobertura.faltando).toHaveLength(1);
    expect(z.liquidezCobertura.pct).toBe(50);
  });

  it("D é fiel ao computeOverviewV1 (não recalcula)", () => {
    const o = computeOverviewV1(FB);
    const d = testedAnData.D(FB);
    expect(d.lucro).toBe(o.totalLucro);
    expect(d.stakeSettled).toBe(o.totalStake);
    expect(d.win).toBe(o.wonBets);
    expect(d.lose).toBe(o.lostBets);
    expect(d.roi).toBe(o.roi);
  });

  it("E.totalStake = soma BigInt-cents do stake; médias fiéis ao computeClvV1", () => {
    const e = computeClvV1(FB);
    const E = testedAnData.E(FB);
    expect(E.totalStake).toBe(sumMoneyBy(FB, (b) => b.stake));
    expect(E.clvMean).toBe(e.avgClv);
  });

  it("Z.heat: profit total das células = lucro das finalizadas; sem NaN/Infinity", () => {
    const z = testedAnData.Z(FB);
    const cells = Object.values(z.heat);
    const totalProfit = sumMoneyBy(cells, (c) => c.profit);
    const finalLucro = sumMoneyBy(
      FB.filter((b) => b.status !== "PENDING"),
      (b) => b.lucro,
    );
    expect(totalProfit).toBeCloseTo(finalLucro, 6);
    cells.forEach((c) => {
      expect(Number.isFinite(c.profit)).toBe(true);
      expect(Number.isFinite(c.stake)).toBe(true);
    });
  });

  it("Z.heat põe a aposta na célula do horário do post, não na do registro", () => {
    // Segunda 15/06: post 09:00 SP (faixa 8–11h), captura atrasada 14:00 SP (12–15h).
    const atrasada = makeBet({
      data: new Date("2026-06-15T19:00:00Z"),
      sourcePostedAt: new Date("2026-06-15T12:00:00Z"),
      registradoEm: new Date("2026-06-15T17:00:00Z"),
    });
    const heat = testedAnData.Z([atrasada]).heat;
    expect(Object.keys(heat)).toEqual(["1_2"]);
    expect(heat["1_2"]!.membros).toEqual([atrasada]);
  });

  it("segData agrupa por dimensão e soma das contagens = total de apostas", () => {
    const z = testedAnData.Z(FB);
    const seg = testedAnData.segData("esporte", z, FB);
    expect(seg.map((s) => s.k).sort()).toEqual(["basquete", "futebol"]);
    expect(seg.reduce((s, g) => s + g.n, 0)).toBe(FB.length);
    // ordenado por n desc
    expect(seg[0]!.n).toBeGreaterThanOrEqual(seg[seg.length - 1]!.n);
  });

  it.each(["constructor", "toString", "__proto__"])("preserva o canal de nome %s no ranking de segmentos", (name) => {
    const bets = [makeBet({ bankrollName: name }), makeBet({ bankrollName: name }), makeBet({ bankrollName: "Outro" })];
    expect(testedAnData.segData("canal", testedAnData.Z(bets), bets).map((group) => [group.k, group.n]))
      .toEqual([[name, 2], ["Outro", 1]]);
  });

  it.each(["constructor", "toString", "__proto__"])("preserva a casa de nome %s no ranking", (name) => {
    const bets = [makeBet({ casaDeAposta: name }), makeBet({ casaDeAposta: name })];
    expect(testedAnData.P(bets).casas.map((group) => [group.k, group.n])).toEqual([[name, 2]]);
  });

  it("segData mostra o esporte pelo nome em português, como o resto do painel", () => {
    const bets = [makeBet({ esporte: "Soccer" }), makeBet({ esporte: "Soccer" }), makeBet({ esporte: "Basketball" })];
    const seg = testedAnData.segData("esporte", testedAnData.Z(bets), bets);
    expect(seg.map((s) => [s.k, s.n])).toEqual([["Futebol", 2], ["Basquete", 1]]);
  });

  it("segData separa a liga de mesmo nome em países diferentes", () => {
    // A Pinnacle manda o nome da liga sem o país: "Serie A" é a do Brasil e a da Itália.
    const bets = [
      makeBet({ competicao: "Serie A", pais: "Brazil" }), makeBet({ competicao: "Serie A", pais: "Brazil" }),
      makeBet({ competicao: "Serie A", pais: "Italy" }),
      makeBet({ competicao: "", pais: "Chile" }), makeBet({ competicao: "", pais: "" }),
    ];
    const seg = testedAnData.segData("competicao", testedAnData.Z(bets), bets);
    expect(seg.map((s) => [s.k, s.n])).toEqual([
      ["Serie A · Brazil", 2], ["Serie A · Italy", 1], ["(sem liga) · Chile", 1], ["(sem liga)", 1],
    ]);
  });

  it("segData dá nome ao grupo das apostas sem país, como faz com o esporte", () => {
    const bets = [makeBet({ pais: "Brazil" }), makeBet({ pais: "" })];
    const seg = testedAnData.segData("pais", testedAnData.Z(bets), bets);
    expect(seg.map((s) => s.k).sort()).toEqual(["(sem país)", "Brazil"]);
  });

  it("P é fiel ao agregaGrupo e não gera Infinity mesmo com openingOdd=0", () => {
    const a = agregaGrupo(FB);
    const p = testedAnData.P(FB);
    expect(p.lucro).toBe(a.lucro);
    expect(p.roi).toBe(a.roi ?? 0);
    // bet defeituosa (openingOdd 0) não pode virar Infinity em dAb.
    const comZero = [...FB, makeBet({ casaDeAposta: "Casa Zero", openingOdd: 0 })];
    const pz = testedAnData.P(comZero);
    pz.casas.forEach((c) => {
      expect(c.dAb === null || Number.isFinite(c.dAb)).toBe(true);
      expect(Number.isFinite(c.oddM)).toBe(true);
    });
  });

  it("o Lucro mensal diz quanto do mês ainda não liquidou", () => {
    const [junho] = testedAnData.D(FB).monthly;
    expect(junho).toMatchObject({ label: "Jun/26", n: 4, settledN: 3 });
    expect(aindaSeMove(emCursoDaLinha(junho!))).toBe(true);

    const [soResolvidas] = testedAnData.D(FB.filter((b) => b.status !== "PENDING")).monthly;
    expect(aindaSeMove(emCursoDaLinha(soResolvidas!))).toBe(false);
  });

  it("preserva ausência financeira e mede registro pós-kickoff", () => {
    const pending = [makeBet({
      status: "PENDING",
      lucro: 0,
      clv: null,
      closingFetchedAt: null,
      openingRawOdd: null,
      closingRawOdd: null,
      openingMaxBet: null,
      closingMaxBet: null,
      data: new Date("2026-06-15T15:00:00Z"),
      registradoEm: new Date("2026-06-15T19:00:00Z"),
    })];
    const d = testedAnData.D(pending);
    const e = testedAnData.E(pending);
    const p = testedAnData.P(pending);
    const s = testedAnData.S(pending);
    const z = testedAnData.Z(pending);

    expect(d).toMatchObject({ roi: null, clvMean: null, acerto: null });
    expect(e).toMatchObject({ clvMean: null, clvMedian: null, expectedSampleN: 0 });
    expect(s).toMatchObject({ meanOE: null, meanEF: null });
    expect(z).toMatchObject({ leadMean: -4, leadN: 1, lqOpenMean: null, lqClosingMean: null, lqOpenN: 0, lqClosingN: 0 });
    expect(p.monthly[0]).toMatchObject({ roi: null, clv: null, acerto: null });
    expect(p.weekly[0]).toMatchObject({ roi: null, clv: null });
  });
});

/**
 * O cálculo do Analyzer (shim + compute*V1) roda fiel com os campos que o
 * SELECT enxuto (ANALYZER_ROW_SELECT) não traz, zerados por mapAnalyzerRow: se
 * algum cálculo passar a lê-los, esta suíte denuncia. `id` e `selecao` vêm do
 * banco para a gaveta, mas seguem zerados aqui porque só a tela os lê;
 * `noOddsReason`/`closingNoOddsReason` ficam `null`, um valor real de produção.
 */
function makeTrimmed(over: Partial<BetRowData> = {}): BetRowData {
  const data = over.data ?? new Date("2026-06-15T19:00:00Z");
  return {
    // dropados pelo SELECT enxuto → placeholders do mapAnalyzerRow:
    id: "", selecao: "", tipster: "", closingMaxBet: null,
    identityStatus: null,
    source: "", sourceExternalId: null, contaTitular: null,
    // vêm do banco; null aqui é ausência real de motivo, não placeholder:
    noOddsReason: null, closingNoOddsReason: null,
    // lidos pelo compute path:
    data,
    settledAt: over.status === "PENDING" ? null : (over.settledAt ?? data),
    evento: "Flamengo vs Palmeiras", competicao: "Brasileirão", pais: "Brasil",
    esporte: "futebol", mercado: "Total de gols", casaDeAposta: "Bet365",
    odds: 1.95, stake: 2, status: "WON", lucro: 1.9,
    closingOdd: 1.85,
    openingMaxBet: 300, openingOdd: 2.0, openingRawOdd: 2.0,
    closingRawOdd: 1.85, registradoEm: new Date("2026-06-15T15:00:00Z"),
    clv: 5.4, clvReliable: true, closingFetchedAt: new Date("2026-06-15T19:00:00Z"),
    ...over,
  };
}

const TRIMMED_BETS: BetRowData[] = [
  makeTrimmed({ esporte: "futebol", casaDeAposta: "Bet365", status: "WON", lucro: 1.9, data: new Date("2026-06-10T19:00:00Z") }),
  makeTrimmed({ esporte: "futebol", casaDeAposta: "Betano", status: "LOST", lucro: -2, clv: -3, data: new Date("2026-06-11T19:00:00Z") }),
  makeTrimmed({ esporte: "basquete", casaDeAposta: "Bet365", status: "PENDING", lucro: 0, clv: null, closingFetchedAt: null, data: new Date("2026-06-12T19:00:00Z") }),
  makeTrimmed({ esporte: "basquete", casaDeAposta: "Pinnacle", status: "HALF_WON", lucro: 0.8, data: new Date("2026-06-13T19:00:00Z") }),
];

describe("simulador de stake (K)", () => {
  it("a stake do tipster é o lucro, o ROI e o drawdown da visão geral, e a curva fecha cada dia", () => {
    const k = testedAnData.K(FB);
    const d = testedAnData.D(FB);
    expect(k.settledN).toBe(3);
    expect(k.rows.find((r) => r.policy === "tipster")).toMatchObject({
      n: 3, stake: d.stakeSettled, lucro: d.lucro, roi: d.roi, maxDD: d.maxDD,
    });
    // Os três dias com liquidação, depois do ponto de partida.
    expect(k.labels).toEqual(["", "10/06", "11/06", "13/06"]);
    expect(k.curves.find((c) => c.policy === "tipster")!.values).toEqual([0, 1.9, -0.1, 0.7]);
  });

  it("a política que não apostou fica sem curva, como fica sem lucro na tabela", () => {
    // Três liquidadas não dão os fechamentos do veredito Manter: a política não aposta.
    const k = testedAnData.K(FB);
    expect(k.rows.find((r) => r.policy === "edgeOnly")).toMatchObject({ n: 0, lucro: null });
    expect(k.curves.find((c) => c.policy === "edgeOnly")!.values).toBeNull();
    expect(k.curves.find((c) => c.policy === "flat")!.values).toHaveLength(k.labels.length);
  });

  it("na carteira a 1u fixa vale o valor da unidade da aposta", () => {
    const bets = [
      makeBet({ bankrollName: "Alfa", valorUnidade: 50, stake: 100, lucro: 95 }),
      makeBet({ bankrollName: "Beta", valorUnidade: 20, stake: 20, lucro: -20, status: "LOST" }),
    ];
    const k = testedAnData.K(bets);
    // 1u em cada: R$ 50 × 0,95 ganhos e R$ 20 perdidos.
    expect(k.rows.find((r) => r.policy === "flat")).toMatchObject({ n: 2, stake: 70, lucro: 27.5 });
  });
});

describe("Analyzer tolera SELECT enxuto (campos não-lidos zerados)", () => {
  it("D/E/S/Z/segData/P rodam sem ler id/selecao/tipster/source", () => {
    const d = testedAnData.D(TRIMMED_BETS);
    const e = testedAnData.E(TRIMMED_BETS);
    const s = testedAnData.S(TRIMMED_BETS);
    const z = testedAnData.Z(TRIMMED_BETS);
    const seg = testedAnData.segData("esporte", z, TRIMMED_BETS);
    const p = testedAnData.P(TRIMMED_BETS);
    expect(Number.isFinite(d.lucro)).toBe(true);
    expect(Number.isFinite(e.totalStake)).toBe(true);
    expect(Array.isArray(s.withOpen)).toBe(true);
    expect(seg.reduce((acc, g) => acc + g.n, 0)).toBe(TRIMMED_BETS.length);
    expect(Number.isFinite(p.roi)).toBe(true);
    expect(Array.isArray(d.settled)).toBe(true);
  });
});


describe("pendência dos períodos remapeados", () => {
  it.each([false, true])("anuladas e canceladas não contam como futuras (pendente real: %s)", (pending) => {
    const bets = [makeBet({ status: "WON", stake: 1, lucro: 1 }), makeBet({ status: "VOID", lucro: 0 }), makeBet({ status: "CANCELED", lucro: 0 })];
    if (pending) bets.push(makeBet({ status: "PENDING", lucro: 0 }));
    const d = testedAnData.D(bets);
    const p = testedAnData.P(bets);
    for (const row of [d.monthly[0]!, p.monthly[0]!, p.weekly[0]!]) {
      expect(emCursoDaLinha(row)).toEqual({ pendentes: pending ? 1 : 0, total: bets.length });
      expect(row.roi).toBe(100);
    }
  });
});
