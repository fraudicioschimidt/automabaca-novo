"use client";
// Dados das abas do Analyzer (D/E/S/Z/segData/P/C): roda os compute*V1 do domínio
// (src/domain/analyzer/*) e o `agregaGrupo` canônico sobre BetRowData[] (cada um
// com `day` = spDayKey) e remapeia a saída para os shapes que as abas consomem.
// Nenhuma conta financeira é refeita aqui.
import { spDayKey, utcToSpParts, WEEKDAY_ABBREVIATIONS } from "@/src/domain/dates";
import { createMoneyAccumulator, sumMoneyBy } from "@/src/domain/money";
import { FINAL_BET_STATUSES_SET } from "@/src/domain/bet-status";
import { instanteDaEntrada } from "@/src/domain/instante-da-entrada";
import { comparableUsdLiquidity } from "@/src/domain/liquidity";
import { fechamentoConfirmado } from "@/src/domain/no-odds-reason";
import { computeOverviewV1 } from "@/src/domain/analyzer/overview";
import { computeClvV1 } from "@/src/domain/analyzer/clv";
import { computeSteamV1, rawPriceDeltaPct } from "@/src/domain/analyzer/steam";
import { computeTimingV1 } from "@/src/domain/analyzer/timing";
import { computeLiquidezV1 } from "@/src/domain/analyzer/liquidez";
import { computeMonthlyPeriods, computePeriodoV1 } from "@/src/domain/analyzer/periodo";
import { channelMarketGrid, suggestedCuts, type ChannelMarketCell } from "@/src/domain/analyzer/portfolio";
import { simulateStakePolicies } from "@/src/domain/analyzer/stake-policy";
import {
  agregaGrupo,
  clvConfiavel,
  media,
  resolvidas,
} from "@/src/domain/analyzer/shared";
import type { GrupoAgg } from "@/src/domain/analyzer/shared";
import {
  baseAlcancavel,
  situacaoDoClv,
  situacaoDaAbertura,
} from "@/src/domain/analyzer/cobertura";
import type { BetDestaque } from "@/src/domain/analyzer/overview";
import type { BetRowData } from "@/src/domain/bet-read-model";
import { splitEvento } from "../adapters/_evento";
import { diaMesDaChave } from "./calendar-date";
import { sportLabel } from "./sport-options";
const isFinal = (b: BetRowData): boolean => FINAL_BET_STATUSES_SET.has(b.status);
const plusClv = (b: BetRowData): boolean => (clvConfiavel(b) ?? 0) > 0;

function groupBy<T>(arr: T[], key: (b: T) => string): Record<string, T[]> {
  const m: Record<string, T[]> = Object.create(null);
  arr.forEach((b) => {
    const k = key(b);
    (m[k] ?? (m[k] = [])).push(b);
  });
  return m;
}

// GrupoAgg (canônico, às vezes com label/name/key) → linha no shape das abas.
type RemapInput = GrupoAgg & { label?: string; name?: string; key?: string };
type AggRow = {
  l: string;
  /**
   * As apostas que produziram esta linha — o array que `agregaGrupo` agregou,
   * repassado inteiro. É o que a gaveta lista ao clicar, então linha e gaveta
   * não têm como discordar.
   */
  membros: BetRowData[];
  n: number;
  stake: number;
  settledN: number;
  pendingN: number;
  clvN: number;
  lucro: number;
  roi: number | null;
  clv: number | null;
  clvPct: number | null;
  acerto: number | null;
  [extra: string]: unknown;
};
function remap(g: RemapInput): AggRow {
  return {
    l: g.label ?? g.name ?? g.key ?? "",
    membros: g.membros,
    n: g.bets,
    stake: g.stake,
    settledN: g.resolvedBets,
    pendingN: g.pendingBets,
    clvN: g.nClv,
    lucro: g.lucro,
    roi: g.roi,
    clv: g.avgClv,
    clvPct: g.pctPositiveClv,
    acerto: g.sucessoPct,
  };
}

function D(FB: BetRowData[]) {
  const o = computeOverviewV1(FB);
  const equity = [{ label: "", v: 0 }];
  const dd = [{ label: "", v: 0 }];
  o.pnl.forEach((p) => {
    equity.push({ label: diaMesDaChave(p.dayKey), v: p.cum });
    dd.push({ label: diaMesDaChave(p.dayKey), v: p.drawdown });
  });
  const clvBets = FB.filter((b) => clvConfiavel(b) != null);
  const settled = resolvidas(FB);
  const dest = (x: BetDestaque | null | undefined) =>
    x ? { ...splitEvento(x.evento), day: spDayKey(x.data), odds: x.odds, stake: x.stake, profit: x.lucro } : null;
  return {
    settled,
    pendingBets: o.pendingBets,
    voidBets: o.voidBets,
    equity,
    dd,
    maxDD: o.maxDrawdown,
    stakeSettled: o.totalStake,
    lucro: o.totalLucro,
    roi: o.roi,
    expectedRoi: o.expectedRoi,
    realizedRoiClv: o.realizedRoiClv,
    realizedRoiClvN: o.realizedRoiClvN,
    roiClvGap: o.roiClvGap,
    clvMean: o.avgClv,
    clvPlus: clvBets.filter(plusClv).length,
    clvBets,
    /**
     * A cobertura de CLV sobre a base que o CLV alcança: entrada ao vivo e
     * pendente não são falha de cobertura.
     */
    clvCobertura: baseAlcancavel(FB, situacaoDoClv),
    mw: o.maxWinStreak,
    ml: o.maxLossStreak,
    win: o.wonBets,
    halfWin: o.halfWonBets,
    lose: o.lostBets,
    halfLose: o.halfLostBets,
    acerto: o.sucessoPct,
    oddMean: o.avgOdds,
    stakeMean: o.avgStake,
    best: dest(o.bestBet),
    worst: dest(o.worstBet),
    // Os mesmos baldes do Período (todas as apostas, pendente no mês do jogo):
    // `pendingN` separa o que ainda se move dos reembolsos encerrados.
    monthly: computeMonthlyPeriods(FB).map((m) => ({
      label: m.label, v: m.lucro, roi: m.roi, n: m.bets, settledN: m.resolvedBets, pendingN: m.pendingBets,
    })),
  };
}

function E(FB: BetRowData[]) {
  const e = computeClvV1(FB);
  const clvB = FB.filter((b) => clvConfiavel(b) != null);
  const expectedSampleN = FB.filter((b) => isFinal(b) && clvConfiavel(b) != null).length;
  return {
    clvB,
    clvMean: e.avgClv,
    clvMedian: e.medianClv,
    clvPos: clvB.filter(plusClv).length,
    expectedSampleN,
    expProfit: e.expectedLucro,
    realProfit: e.actualLucro,
    totalStake: sumMoneyBy(FB, (b) => b.stake),
    clvDist: e.clvDistribution.map((d) => ({ l: d.label, n: d.count })),
    clvPerf: e.roiByClvBucket.map((b) => remap(b)),
  };
}

const temAbertura = (b: BetRowData): b is BetRowData & { openingRawOdd: number } =>
  b.openingRawOdd != null && Number.isFinite(b.openingRawOdd) && b.openingRawOdd > 1;
const temFechamento = (b: BetRowData): boolean =>
  b.closingRawOdd != null && Number.isFinite(b.closingRawOdd) && b.closingRawOdd > 1
  && fechamentoConfirmado(b);

function S(FB: BetRowData[]) {
  const s = computeSteamV1(FB);
  return {
    withOpen: FB.filter(temAbertura),
    withClose: FB.filter(temFechamento),
    // Cada cobertura segue a disponibilidade do seu preço. Fechamento rejeitado
    // não ganha cobertura só porque a tentativa de congelamento foi gravada.
    aberturaCobertura: baseAlcancavel(FB, (b) => situacaoDaAbertura(b, temAbertura(b))),
    fechamentoCobertura: baseAlcancavel(FB, (b) =>
      temFechamento(b) ? "tem" : situacaoDoClv(b)),
    meanOE: s.avgOpeningToEntry,
    meanEF: s.avgEntryToClosing,
    steam: remap(s.steam),
    neutro: remap(s.noSteam),
    reverse: remap(s.reverseLine),
    distOE: s.openingDeltaDist.map((d) => ({ l: d.label, n: d.count })),
    distEF: s.closingDeltaDist.map((d) => ({ l: d.label, n: d.count })),
    perfOE: s.byOpeningDelta.map((b) => remap(b)),
    perfEF: s.byClosingDelta.map((b) => remap(b)),
    traj: s.pricePaths.map((p) => ({
      day: diaMesDaChave(p.dayKey),
      ...splitEvento(p.evento),
      open: p.opening,
      entry: p.taken,
      close: p.closing,
      profit: p.lucro,
    })),
  };
}

function Z(FB: BetRowData[]) {
  const t = computeTimingV1(FB);
  const lq = computeLiquidezV1(FB);
  const tRows = t.byAntecedencia.map((b) => remap(b));
  const tBk = t.byAntecedencia.map((b) => [b.label, 0, 0]);
  const win = (w: RemapInput | null) =>
    w ? { ...remap(w), score: (w.roi ?? 0) + (w.avgClv ?? 0) } : null;
  const mom = (key: string) => {
    const r = lq.momentum.find((m) => m.key === key);
    return r ? remap(r) : { membros: [], n: 0, stake: 0, lucro: 0, roi: null, clv: null, clvPct: null, acerto: null };
  };
  // Heatmap: dia (SP) × faixa de 4h do post, mesma convenção de timing.ts (lá o
  // HeatCell não expõe o stake que a tela usa para o ROI).
  //
  // A célula é o ÚNICO lugar do Analyzer onde contagem e soma têm bases
  // diferentes de propósito: `n` conta todas (inclusive pendentes), profit/stake
  // só as liquidadas. Por isso guarda as duas listas: `membros` é o que a gaveta
  // mostra, `liquidadas` é o que virou dinheiro.
  const cells: Record<string, { membros: BetRowData[]; liquidadas: BetRowData[] }> = {};
  FB.forEach((b) => {
    const sp = utcToSpParts(instanteDaEntrada(b));
    const k = sp.getUTCDay() + "_" + Math.floor(sp.getUTCHours() / 4);
    const cell = cells[k] ?? (cells[k] = { membros: [], liquidadas: [] });
    cell.membros.push(b);
    if (isFinal(b)) cell.liquidadas.push(b);
  });
  const heat: Record<
    string,
    { n: number; profit: number; stake: number; membros: BetRowData[]; liquidadas: BetRowData[] }
  > = {};
  for (const [k, cell] of Object.entries(cells)) {
    heat[k] = {
      n: cell.membros.length,
      profit: sumMoneyBy(cell.liquidadas, (b) => b.lucro),
      stake: sumMoneyBy(cell.liquidadas, (b) => b.stake),
      membros: cell.membros,
      liquidadas: cell.liquidadas,
    };
  }
  const closingLiq = (bet: BetRowData) =>
    fechamentoConfirmado(bet) ? comparableUsdLiquidity(bet.closingMaxBet, bet.closingMaxBetCurrency) : null;
  const lqClosing = FB.filter((b) => {
    const value = closingLiq(b);
    return value != null && Number.isFinite(value) && value > 0;
  });
  return {
    tBk,
    tRows,
    leadN: t.coveredBets,
    leadMean: t.avgAntecedenciaHours,
    bestW: win(t.bestWindow),
    worstW: win(t.worstWindow),
    activeW: tRows.filter((r) => r.n > 0).length,
    WD: WEEKDAY_ABBREVIATIONS,
    hBk: [["0–3h", 0, 3], ["4–7h", 4, 7], ["8–11h", 8, 11], ["12–15h", 12, 15], ["16–19h", 16, 19], ["20–23h", 20, 23]],
    heat,
    lq: lqClosing,
    lqOpenN: lq.totalWithOpeningLiq,
    lqClosingN: lq.totalWithClosingLiq,
    // Liquidez do fechamento: mesma base alcançável do CLV, não o conjunto
    // inteiro. CLV presente sem limite USD continua sendo lacuna de liquidez.
    liquidezCobertura: baseAlcancavel(FB, (b) => {
      if (closingLiq(b) != null) return "tem";
      const situation = situacaoDoClv(b);
      return situation === "tem" ? "lacuna" : situation;
    }),
    lqOpenMean: lq.avgOpeningLiq,
    lqClosingMean: lq.avgClosingLiq,
    lqOpenRows: lq.byOpeningLiq.map((b) => remap(b)),
    lqClosingRows: lq.byClosingLiq.map((b) => remap(b)),
    lqBest: lq.bestBucket ? remap(lq.bestBucket) : null,
    cresc: mom("crescendo"),
    estavel: mom("estavel"),
    secando: mom("secando"),
    agg: (inb: BetRowData[]) => remap(agregaGrupo(inb)),
  };
}

/** A banca da aposta na carteira: a dimensão Canal e as linhas da matriz. */
const canalDaAposta = (b: BetRowData): string => b.bankrollName || "(sem tipster)";

type SegView = "canal" | "esporte" | "mercado" | "competicao" | "pais";
function segData(segView: SegView, Zobj: { agg: (inb: BetRowData[]) => AggRow }, FB: BetRowData[]) {
  const dim: Record<SegView, (b: BetRowData) => string> = {
    canal: canalDaAposta,
    esporte: (b) => (b.esporte ? sportLabel(b.esporte) : "(sem esporte)"),
    mercado: (b) => b.mercado,
    // A liga vem da Pinnacle sem o país ("Serie A" é a do Brasil e a da Itália).
    // A liga na frente: o rótulo cortado no ranking perde o país, não o nome.
    competicao: (b) => [b.competicao || "(sem liga)", b.pais].filter(Boolean).join(" · "),
    pais: (b) => b.pais || "(sem país)",
  };
  const groups = groupBy(FB, dim[segView]);
  return Object.entries(groups)
    .map(([k, g]) => ({ k, ...Zobj.agg(g) }))
    .sort((a, b) => b.n - a.n);
}

function P(FB: BetRowData[]) {
  const cg = groupBy(FB, (b) => b.casaDeAposta || "(sem casa)");
  const casas = Object.entries(cg).map(([k, g]) => {
    const withOpening = g.filter(temAbertura);
    const openingDeltas = withOpening.map(
      (b) => rawPriceDeltaPct(b.odds, b.openingRawOdd)!,
    );
    const steamN = openingDeltas.filter((delta) => delta >= 2).length;
    return {
      ...remap(agregaGrupo(g)),
      k,
      steamN,
      steamSamples: withOpening.length,
      steamPct: withOpening.length ? (steamN / withOpening.length) * 100 : null,
      dAb: media(openingDeltas),
      oddM: media(g.map((b) => b.odds)) ?? 0,
    };
  });
  const per = computePeriodoV1(FB);
  const daily = [{ label: "", v: 0 }];
  const dailyAcc = createMoneyAccumulator();
  per.daily90.forEach((d) => {
    daily.push({ label: diaMesDaChave(d.dayKey), v: dailyAcc.add(d.lucro) });
  });
  const a = agregaGrupo(FB);
  return {
    casas,
    daily,
    monthly: per.monthly.map((m) => ({
      label: m.label, membros: m.membros, n: m.bets, settledN: m.resolvedBets, pendingN: m.pendingBets, stake: m.stake, lucro: m.lucro, roi: m.roi,
      clv: m.avgClv, acerto: m.sucessoPct, v: m.lucro, cum: m.cumLucro,
    })),
    weekly: per.weekly.map((w) => ({ l: w.label, membros: w.membros, n: w.bets, settledN: w.resolvedBets, pendingN: w.pendingBets, stake: w.stake, roi: w.roi, clv: w.avgClv, lucro: w.lucro })),
    lucro: a.lucro,
    roi: a.roi,
    clv: a.avgClv,
  };
}

/** A célula canal × mercado no shape de linha: a gaveta e as tabelas a leem como qualquer outra. */
function celula(c: ChannelMarketCell<BetRowData>) {
  return { ...remap(c), l: `${c.channel} · ${c.market}`, channel: c.channel, market: c.market, verdict: c.verdict, tStat: c.tStat };
}

/** Carteira: matriz canal × mercado e os cortes sugeridos pelo CLV. */
function C(FB: BetRowData[]) {
  const grid = channelMarketGrid(FB, canalDaAposta);
  const cortes = suggestedCuts(FB, grid);
  return {
    markets: grid.markets,
    otherMarketsLabel: grid.otherMarketsLabel,
    rows: grid.rows.map((r) => ({ channel: r.channel, total: remap(r.total), cells: r.cells.map((c) => (c ? celula(c) : null)) })),
    cuts: cortes.cuts.map(celula),
    testedPairs: cortes.testedPairs,
    totalPairs: cortes.totalPairs,
    portfolio: remap(cortes.portfolio),
    withoutCuts: remap(cortes.withoutCuts),
    cut: remap(cortes.cut),
  };
}

/**
 * Simulador de stake: cada política sobre as liquidadas do recorte e a curva
 * dela no fim de cada dia de jogo. O canal é a banca (na carteira, a de
 * cada aposta); a linha da carteira volta às unidades pelo valor da unidade.
 */
function K(FB: BetRowData[]) {
  const sim = simulateStakePolicies(FB, {
    channelOf: canalDaAposta,
    unitValueOf: (b) => b.valorUnidade ?? 1,
  });
  // Todas as políticas passam pelas mesmas liquidadas na mesma ordem: os dias
  // da curva são os mesmos, e o último ponto de cada dia é o fechamento dele.
  const days = [...new Set(sim.policies[0]?.pnl.map((p) => p.dayKey) ?? [])];
  const endOfDay = (pnl: typeof sim.policies[number]["pnl"]) => {
    const byDay = new Map(pnl.map((p) => [p.dayKey, p.cum]));
    return [0, ...days.map((d) => byDay.get(d) ?? 0)];
  };
  return {
    settledN: sim.settledBets,
    // A política que não pôs stake em nenhuma aposta não empatou: os números dela ficam vazios, não zero.
    rows: sim.policies.map((p) => {
      const placed = p.bets > 0;
      return {
        policy: p.policy, n: p.bets, roi: p.roi,
        stake: placed ? p.stake : null, lucro: placed ? p.lucro : null,
        maxDD: placed ? p.maxDrawdown : null, maxStake: placed ? p.maxStake : null,
      };
    }),
    labels: ['', ...days.map(diaMesDaChave)],
    // Pela mesma razão, sem curva: a linha em zero seria lida como empate.
    curves: sim.policies.map((p) => ({ policy: p.policy, values: p.bets > 0 ? endOfDay(p.pnl) : null })),
  };
}

export const testedAnData = { D, E, S, Z, segData, P, C, K };
