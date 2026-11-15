// Dados de demonstração da banca "Big Data", na forma do adaptador
// (`adapters/aposta.ts` → `toBet`): campo que só existe no real nunca seria
// exercitado pelos testes se o mock tivesse outra forma.
import type { getBankrollData } from "../adapters/bankroll";
import type { TrilhaDaAposta } from "@/src/services/painel/aposta/trilha";
import type { CapturaDaFicha, SettlementCard } from "../adapters/aposta";
import { tipoDeMovimento } from "@/src/domain/analyzer/steam";
import { admitsAsianFractionalSettlement } from "@/src/domain/settlement/half-guard";

type BankrollData = NonNullable<Awaited<ReturnType<typeof getBankrollData>>>;
type Bet = BankrollData["BETS"][number];

type DetailSeed = {
  open: number; odds: number; close?: number;
  eventAt: string; cap: string; before: string;
};
type BetSeed = Pick<Bet, "id" | "day" | "time" | "home" | "away" | "region" | "league" | "market" | "line" | "odds" | "clv" | "stake" | "status" | "profit">
  & { liveScoreAtTip?: string | null; d: DetailSeed };

// Liquidez Pinnacle (abertura, fechamento) por aposta; as demais não têm.
const LIQUIDEZ: Record<string, [number, number]> = { b4: [90, 100], b5: [110, 115], b6: [125, 200], b7: [130, 210], b8: [120, 130], b9: [100, 105], b11: [140, 130], b12: [125, 140], b13: [90, 95] };

function bet({ d: o, liveScoreAtTip = null, ...row }: BetSeed): Bet {
  const close = o.close ?? null;
  const liq = LIQUIDEZ[row.id];
  return {
    ...row,
    settlementView: null,
    bkSlug: "main",
    resultDay: row.status === "pending" ? null : row.day,
    resultTime: null,
    kickoffInferido: false,
    esporte: "Soccer",
    sportPending: false,
    liveScoreAtTip,
    allowsHalfResult: admitsAsianFractionalSettlement(row.market, row.line),
    movimento: close != null ? (close / o.open - 1) * 100 : null,
    clvSituacao: row.clv != null ? "tem" : row.status === "pending" ? "cedo" : "sem_explicacao",
    reliq: false,
    d: {
      open: o.open,
      close,
      liqOpen: liq ? liq[0] : null,
      liqClose: liq ? liq[1] : null,
      eventAt: o.eventAt,
      casa: null,
      capturedAt: o.cap,
      before: o.before,
      aposApito: null,
      settledAt: null,
      takenAt: null,
      contaTitular: null,
      contaApelido: null,
      liveScoreAtTip,
      origin: "Canal Telegram",
      msg: null,
      moveType: tipoDeMovimento(close != null ? (close / o.open - 1) * 100 : null),
      noOdds: null,
      // Sem fechamento congelado não há cadeia, igual ao real. O CLV sai da mesma
      // conta do domínio (`percentualContraFair`), então a cadeia fecha.
      clvOrigem: {
        cravada: o.odds,
        fechamentoBruto: close != null ? Number((close * 0.97).toFixed(3)) : null,
        fechamentoFair: close,
        clv: close != null ? Number(((o.odds / close - 1) * 100).toFixed(1)) : null,
        confiavel: close != null ? true : null,
        provider: close != null ? "bridgeodds" : null,
        mecanismo: close != null ? "captura automática" : null,
        congeladoEm: close != null ? o.eventAt : null,
        motivo: null,
      },
    },
  };
}

export const BETS: Bet[] = [
  // DOMINGO 14/06 — 3 pendentes
  bet({ id: 'b1', day: '2026-06-14', time: '00:00', home: 'Illawarra F', away: 'Northern Tigers F',
    region: 'Soccer', league: null, market: 'Asian Handicap', line: 'Northern Tigers F +0.25', liveScoreAtTip: '1-0', odds: 1.950,
    clv: null, stake: 0.50, status: 'pending', profit: null,
    d: { open: 1.960, odds: 1.950, eventAt: '14/06 00:00', cap: '13/06 19:14', before: '4h46 antes' } }),
  bet({ id: 'b2', day: '2026-06-14', time: '00:00', home: 'Sorrento F', away: 'UWA Nedlands FC F',
    region: 'Soccer', league: null, market: 'Total', line: 'Under 4', odds: 1.975,
    clv: null, stake: 0.50, status: 'pending', profit: null,
    d: { open: 1.940, odds: 1.975, eventAt: '14/06 00:00', cap: '13/06 19:14', before: '4h46 antes' } }),
  bet({ id: 'b3', day: '2026-06-14', time: '00:00', home: 'Ängby IF', away: 'Skiljebo SK',
    region: 'Soccer', league: null, market: 'Total', line: 'Under 3.25', odds: 1.925,
    clv: null, stake: 0.50, status: 'pending', profit: null,
    d: { open: 1.910, odds: 1.925, eventAt: '14/06 00:00', cap: '13/06 19:14', before: '4h46 antes' } }),

  // SÁBADO 13/06 — 7 pendentes
  bet({ id: 'b4', day: '2026-06-13', time: '10:00', home: 'Magesi', away: 'Milford',
    region: 'South Africa', league: 'PSL', market: 'Total', line: 'Under 2.5', odds: 2.070,
    clv: null, stake: 0.50, status: 'pending', profit: null,
    d: { open: 2.090, odds: 2.070, eventAt: '13/06 10:00', cap: '13/06 06:02', before: '3h58 antes' } }),
  bet({ id: 'b5', day: '2026-06-13', time: '08:00', home: 'Ogre United', away: 'Riga FC',
    region: 'Latvia', league: 'Virsliga', market: 'Total', line: 'Under 4', odds: 1.875,
    clv: null, stake: 0.50, status: 'pending', profit: null,
    d: { open: 1.900, odds: 1.875, eventAt: '13/06 08:00', cap: '13/06 04:11', before: '3h49 antes' } }),
  bet({ id: 'b6', day: '2026-06-13', time: '04:30', home: 'The Cove', away: 'Modbury Jets',
    region: 'Australia', league: 'South Australia State League 1', market: 'Total', line: 'Under 3.75', odds: 1.950,
    clv: 29.5, stake: 0.50, status: 'pending', profit: null,
    d: { open: 2.180, odds: 1.950, close: 1.506, eventAt: '13/06 04:30', cap: '12/06 23:40', before: '4h50 antes' } }),
  bet({ id: 'b7', day: '2026-06-13', time: '02:00', home: 'Brindabella Blues', away: 'Belconnen United',
    region: 'Australia', league: 'NPL Capital Territory', market: 'Total', line: 'Under 4', odds: 1.900,
    clv: 18.0, stake: 0.50, status: 'pending', profit: null,
    d: { open: 2.040, odds: 1.900, close: 1.610, eventAt: '13/06 02:00', cap: '12/06 21:25', before: '4h35 antes' } }),
  bet({ id: 'b8', day: '2026-06-13', time: '00:00', home: 'Jacobina', away: 'Fluminense de Feira',
    region: 'Soccer', league: null, market: 'Total', line: 'Under 2.5', odds: 1.975,
    clv: 16.2, stake: 0.50, status: 'pending', profit: null,
    d: { open: 1.960, odds: 1.975, close: 1.700, eventAt: '13/06 00:00', cap: '12/06 19:02', before: '4h58 antes' } }),
  bet({ id: 'b9', day: '2026-06-13', time: '00:00', home: 'Montgomery', away: 'Swarm',
    region: 'Soccer', league: null, market: 'Total', line: 'Under 4', odds: 1.925,
    clv: null, stake: 0.50, status: 'pending', profit: null,
    d: { open: 1.915, odds: 1.925, eventAt: '13/06 00:00', cap: '12/06 19:02', before: '4h58 antes' } }),
  bet({ id: 'b10', day: '2026-06-13', time: '00:00', home: 'Birmingham Legion', away: 'Apotheos',
    region: 'Soccer', league: null, market: 'Total', line: 'Under 3.5', odds: 1.850,
    clv: null, stake: 0.50, status: 'pending', profit: null,
    d: { open: 1.870, odds: 1.850, eventAt: '13/06 00:00', cap: '12/06 19:02', before: '4h58 antes' } }),

  // SEXTA 12/06 — 1 perdida
  bet({ id: 'b11', day: '2026-06-12', time: '13:00', home: 'Gerasdorf Stammersdorf', away: 'SV Wienerberg',
    region: 'Austria', league: 'Landesliga', market: 'Total', line: 'Under 4.5', odds: 1.850,
    clv: -3.1, stake: 0.50, status: 'lost', profit: -0.50,
    d: { open: 1.880, odds: 1.850, close: 1.910, eventAt: '12/06 13:00', cap: '12/06 09:12', before: '3h48 antes' } }),

  // QUARTA 10/06 — 2 (meia perda em quarter line)
  bet({ id: 'b12', day: '2026-06-10', time: '21:00', home: 'Saint Croix', away: 'Minnesota Thunder',
    region: 'USA', league: 'Women Premier Soccer League', market: 'Total', line: 'Under 3.75', odds: 1.950,
    clv: 23.0, stake: 0.25, status: 'half', profit: -0.13,
    d: { open: 1.990, odds: 1.950, close: 1.585, eventAt: '10/06 21:00', cap: '10/06 16:07', before: '4h52 antes' } }),
  bet({ id: 'b13', day: '2026-06-10', time: '20:00', home: 'AC Connecticut', away: 'Vermont Green',
    region: 'USA', league: 'USL League 2', market: 'Total', line: 'Under 4.75', odds: 1.900,
    clv: 26.6, stake: 0.50, status: 'half', profit: -0.25,
    d: { open: 1.940, odds: 1.900, close: 1.500, eventAt: '10/06 20:00', cap: '10/06 16:07', before: '3h52 antes' } }),
];

// Métricas de topo ---------------------------------------------
export const METRICS: BankrollData["METRICS"] = {
  capital: 100.00,
  ops: 13,
  lucro: -0.88, settled: 3, acerto: 0,
  roi: -70.0,
  hasRoi: true,
  clvMean: 18.4, clvShare: 46,
  hasClv: true,
  open: 10, openUnits: 5.00,
};

// Série do gráfico "Evolução do lucro" -------------------------
// realized = lucro acumulado realizado
export const CHART: BankrollData["CHART"] = [
  { label: '10/06', realized: 0.00 },
  { label: '10/06', realized: -0.13 },
  { label: '10/06', realized: -0.38 },
  { label: '11/06', realized: -0.38 },
  { label: '12/06', realized: -0.88 },
  { label: '12/06', realized: -0.88 },
  { label: '13/06', realized: -0.88 },
  { label: '13/06', realized: -0.88 },
  { label: '13/06', realized: -0.88 },
  { label: '13/06', realized: -0.88 },
  { label: '13/06', realized: -0.88 },
  { label: '14/06', realized: -0.88 },
  { label: '14/06', realized: -0.88 },
  { label: '14/06', realized: -0.88 },
];

/** O post de origem da aposta de demonstração, como a ficha o recebe. */
export const CAPTURA: CapturaDaFicha = {
  texto: "⚽ Illawarra F x Northern Tigers F\nEntrada: Northern Tigers +0.25\nODD: 1.95\nStake: 1u",
  leitura: "Lida por regra",
  link: "https://t.me/c/4262961788/5120",
};

/**
 * A liquidação de uma aposta de demonstração (`?mock=1&id=b11`), pelo IA-Judge
 * automático com o placar e a conferência do FlashScore. As outras ficam sem
 * cartão, em vez de mostrar um jogo que não é o delas.
 */
export const SETTLEMENT_CARDS: Readonly<Record<string, SettlementCard>> = {
  b11: {
    source: "IA-Judge automático",
    at: "12/06 15:10",
    score: { value: "3-2", kind: "seen", detail: null },
    fixture: "SC Gerasdorf/Stammersdorf vs SV Wienerberg · casamento 100%",
    outcome: null,
    player: null,
    crossCheck: "o FlashScore confirmou o resultado da IA",
    judge: {
      found: "Gerasdorf 3-2 Wienerberg",
      confidence: "97%",
      link: "https://www.sofascore.com/football/match/gerasdorf-wienerberg/abc",
      site: "sofascore.com",
      fromFlashscore: false,
      reason: "O placar final foi 3-2, cinco gols no total, acima da linha de 4.5: o Under perdeu.",
      model: "gemini",
    },
  },
};

/**
 * Trilha de exemplo da ficha (`?mock=1`), no formato de `domain/trilha-da-aposta`.
 * Datas fixas para o conteúdo não mudar sozinho; cobre as três formas próprias
 * (re-liquidação, edição com diff e captura).
 */
export const TRILHA: TrilhaDaAposta = {
  completa: true,
  comecaEm: null,
  retencaoDias: 365,
  reliquidada: true,
  linhas: [
    {
      id: 't1', chave: 'reliquidacao', rotulo: 'Resultado alterado', ator: 'system',
      ok: true, em: '2026-07-12T17:12:00.000Z', mudancas: [],
      frase: [
        { texto: 'Resultado alterado de ' }, { texto: 'reembolso', forte: true },
        { texto: ' para ' }, { texto: 'perdida', forte: true },
        { texto: ' por ' }, { texto: 'ação manual (new-bot:recalc-ah-live)', forte: true },
        { texto: ' — o ledger passou a ' }, { texto: '-2.00u', forte: true }, { texto: '.' },
      ],
    },
    {
      id: 't2', chave: 'liquidacao', rotulo: 'Liquidada', ator: 'system',
      ok: true, em: '2026-07-11T23:35:00.000Z', mudancas: [],
      frase: [
        { texto: 'Liquidada como ' }, { texto: 'reembolso', forte: true },
        { texto: ' por ' }, { texto: 'liquidação automática pelo FlashScore', forte: true },
        { texto: ' — ' }, { texto: '0.00u', forte: true }, { texto: '.' },
      ],
    },
    {
      id: 't3', chave: 'edicao', rotulo: 'Editada', ator: 'sport-resolver',
      ok: true, em: '2026-07-11T20:52:00.000Z',
      mudancas: [
        { campo: 'esporte', de: 'Unknown', para: 'Soccer' },
        { campo: 'mercado', de: 'Asian Handicap', para: 'Handicap – Match' },
      ],
      frase: [
        { texto: 'Aposta editada por ' }, { texto: 'sport-resolver', forte: true }, { texto: '.' },
      ],
    },
    {
      id: 't4', chave: 'captura', rotulo: 'Capturada', ator: 'telegram-channel:universal',
      ok: true, em: '2026-07-11T20:52:00.000Z', mudancas: [],
      frase: [
        { texto: 'Aposta capturada de ' }, { texto: 'canal do Telegram (universal)', forte: true },
        { texto: ' — ' }, { texto: 'Mirassol +0', forte: true },
        { texto: ' em ' }, { texto: 'Asian Handicap', forte: true },
        { texto: ' a ' }, { texto: '1.900', forte: true },
        { texto: ', stake ' }, { texto: '2.00u', forte: true }, { texto: '.' },
      ],
    },
  ],
};
