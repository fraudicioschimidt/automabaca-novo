// Dados de demonstração do Dashboard e da lista de bancas (`?mock=1`), na forma
// dos adaptadores: cada banca é um "tipster".
import type { getBankrollsData } from "../adapters/bankrolls";
import type { getDashboardData } from "../adapters/dashboard";
import { VEREDITO_NA_TELA, type EdgeVeredito } from "@/src/domain/analyzer/shared";

type DashboardData = Awaited<ReturnType<typeof getDashboardData>>;
type BankrollsData = Awaited<ReturnType<typeof getBankrollsData>>;
type BaseTipster = Omit<DashboardData["tipsters"][number], "equity" | "equityBrl" | "veredito" | "tStat" | "clvMedio">;

function mulberry32(a: number) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Equity sintética (sparkline): passeio aleatório reescalado para terminar no lucro.
function equity(seed: number, lucro: number, n: number): number[] {
  const rng = mulberry32(seed);
  const raw = [0];
  for (let i = 1; i < n; i++) raw.push(raw[i - 1]! + (lucro / n) * 0.7 + (rng() - 0.48) * Math.max(1, Math.abs(lucro)) * 0.5);
  const last = raw[n - 1] || 1;
  return raw.map((v) => +(v * (lucro / (Math.abs(last) < 0.01 ? (last < 0 ? -0.01 : 0.01) : last))).toFixed(2));
}

const clvDist = (counts: number[]) => ['< −5%', '−5–0%', '0–5%', '5–10%', '≥ 10%']
  .map((label, index) => ({ label, count: counts[index] || 0 }));

type Seed = Pick<BaseTipster, "id" | "name" | "sharpMode" | "unit" | "n" | "open" | "lucro" | "roi" | "clv" | "acerto" | "last">
  & { main?: boolean; dec: { amostra: number; beat: number | null; clv: number | null; dist: number[]; d30: number | null; roiReal: number | null; veredito: EdgeVeredito; faltam?: number } };

// `dec`: a decisão de assinatura (evidência de edge) de cada banca.
const SEEDS: Seed[] = [
  { id: 't1', name: 'Sharp Iberia', sharpMode: 'CLV_ONLY', unit: 'R$200/u', n: 412, open: 18, lucro: 38.6, roi: 7.1, clv: 9.4, acerto: 54, last: 'ativo há 12 min',
    dec: { amostra: 394, beat: 71, clv: 9.4, dist: [20, 94, 60, 120, 100], d30: 1.2, roiReal: 7.1, veredito: 'EDGE' } },
  { id: 't2', name: 'Value Hunter', sharpMode: 'CLV_ONLY', unit: 'R$100/u', n: 286, open: 11, lucro: 21.2, roi: 5.8, clv: 7.8, acerto: 49, last: 'ativo há 1 h',
    dec: { amostra: 275, beat: 66, clv: 7.8, dist: [25, 68, 52, 80, 50], d30: -0.4, roiReal: 5.8, veredito: 'EDGE' } },
  { id: 't3', name: 'Asian Lines BR', sharpMode: 'CLV_ONLY', unit: 'R$150/u', n: 538, open: 24, lucro: 16.9, roi: 2.4, clv: 4.1, acerto: 57, last: 'ativo há 30 min',
    dec: { amostra: 514, beat: 61, clv: 4.1, dist: [60, 140, 160, 100, 54], d30: 0.3, roiReal: 2.4, veredito: 'INCONCLUSIVO' } },
  { id: 't4', name: 'Corner Edge', sharpMode: 'IDENTITY_ONLY', unit: 'R$80/u', n: 94, open: 6, lucro: 7.4, roi: 9.6, clv: 11.2, acerto: 46, last: 'ativo há 3 h',
    dec: { amostra: 41, beat: 69, clv: 11.2, dist: [3, 10, 4, 9, 15], d30: null, roiReal: 9.6, veredito: 'AMOSTRA_CURTA', faltam: 0 } },
  { id: 't5', name: 'Big Data', sharpMode: 'CLV_ONLY', unit: 'R$100/u', n: 13, open: 10, lucro: -0.88, roi: -70.0, clv: 18.4, acerto: 0, last: 'ativo há 2 min', main: true,
    dec: { amostra: 7, beat: 83, clv: 18.4, dist: [0, 1, 0, 1, 5], d30: null, roiReal: -70.0, veredito: 'AMOSTRA_CURTA', faltam: 23 } },
  { id: 't6', name: 'Goalline Pro', sharpMode: 'CLV_ONLY', unit: 'R$50/u', n: 161, open: 4, lucro: -9.7, roi: -4.3, clv: -2.6, acerto: 44, last: 'ativo há 6 h',
    dec: { amostra: 157, beat: 38, clv: -2.6, dist: [40, 57, 35, 18, 7], d30: -1.8, roiReal: -4.3, veredito: 'SEM_EDGE' } },
  { id: 't7', name: 'BTTS Lab', sharpMode: 'IDENTITY_ONLY', unit: 'R$60/u', n: 78, open: 3, lucro: 4.2, roi: 5.4, clv: 5.1, acerto: 52, last: 'ativo há 5 h',
    dec: { amostra: 49, beat: 60, clv: 5.1, dist: [6, 14, 15, 9, 5], d30: 0.6, roiReal: 5.4, veredito: 'INCONCLUSIVO' } },
  { id: 't8', name: 'NorthOdds', sharpMode: 'CLV_ONLY', unit: 'R$120/u', n: 233, open: 9, lucro: 11.8, roi: 4.4, clv: 6.0, acerto: 51, last: 'ativo há 2 h',
    dec: { amostra: 221, beat: 64, clv: 6.0, dist: [25, 55, 61, 50, 30], d30: 0.1, roiReal: 4.4, veredito: 'EDGE' } },
  { id: 't9', name: 'DeLucca Tips', sharpMode: 'CLV_ONLY', unit: 'R$100/u', n: 0, open: 0, lucro: 0, roi: 0, clv: 0, acerto: 0, last: 'sem apostas ainda',
    dec: { amostra: 0, beat: null, clv: null, dist: [], d30: null, roiReal: null, veredito: 'AMOSTRA_CURTA', faltam: 30 } },
];

function baseTipster({ dec: _dec, main = false, ...seed }: Seed): BaseTipster {
  const staked = +(Math.abs(seed.lucro) / (Math.abs(seed.roi) / 100 || 1)).toFixed(1);
  const resolved = Math.max(0, seed.n - seed.open);
  const wins = Math.round(resolved * seed.acerto / 100);
  const losses = resolved - wins;
  const unitValue = Number(seed.unit.match(/[0-9]+/)?.[0] ?? 0);
  return {
    ...seed,
    profitBrl: seed.lucro * unitValue,
    stakedBrl: staked * unitValue,
    halfWins: 0,
    halfLosses: 0,
    main,
    logoUrl: null,
    staked,
    resolved,
    wins,
    losses,
    attempts: wins + losses,
    clvSamples: resolved,
    hasRoi: resolved > 0 && staked > 0,
    hasClv: resolved > 0,
    hasAcerto: wins + losses > 0,
  };
}

const alerts: DashboardData["alerts"] = [
  { id: 'al1', kind: 'warn', title: 'Cota pinnacle17 perto do limite', desc: '842/900 chamadas hoje · guarda-corpo diário', time: 'há 8 min' },
  { id: 'al2', kind: 'info', title: 'Steam capturado · Corner Edge', desc: 'The Cove vs Modbury — entrada 1.95 (abriu 2.18)', time: 'há 34 min' },
  { id: 'al3', kind: 'warn', title: 'Goalline Pro perdendo edge', desc: 'CLV médio −2.6% nas últimas 100 — avaliar pausa', time: 'há 2 h' },
  { id: 'al4', kind: 'ok', title: 'Reconciliação ok', desc: 'Ledger bate com o lucro recomputado', time: 'há 3 h' },
];

// Datas e médias fixas: o conteúdo do mock não pode mudar com o dia em que roda.
export const TIP: DashboardData = {
  tipsters: SEEDS.map((seed, i) => ({
    ...baseTipster(seed),
    equity: equity(7000 + i * 53, seed.lucro, 26),
    equityBrl: equity(7000 + i * 53, baseTipster(seed).profitBrl, 26),
    veredito: seed.dec.veredito,
    tStat: null,
    clvMedio: seed.dec.clv,
  })),
  alerts,
  engine: {
    alive: true,
    dbOk: true,
    frescor: [{ chave: 'motor', rotulo: 'motor', idadeMin: 1, emISO: null, texto: 'há 1 min', atrasada: false }],
  },
  greeting: 'Bom dia, Fabricio',
  sky: { moment: 'morning', moonPhase: 0.48, label: 'Nascer do sol às 06:47 · pôr do sol às 17:28' },
  todayLabel: 'Sábado, 13 de junho',
  todayTile: { weekday: 'Sáb', day: 13 },
  today: { lucroDia: 17.52, resolvidas: 7, tips: 10, aResolver: 5, mediaDiaria: 4.21, diasOperados: 34 },
  visit: {
    readAt: '2026-06-13T15:00:00.000Z',
    since: { sinceLabel: '12/06 22:10', newBets: 7, settled: 5, lucroUnits: 2.4, lucroReais: 240, closings: 4, clvMean: 3.1, openAlerts: 1 },
  },
};

export const BANKROLLS_TIP: BankrollsData = {
  tipsters: SEEDS.map((seed) => ({
    ...baseTipster(seed),
    dec: {
      amostra: seed.dec.amostra,
      beat: seed.dec.beat,
      clv: seed.dec.clv,
      clvMedio: seed.dec.clv,
      distClv: clvDist(seed.dec.dist),
      d30: seed.dec.d30,
      d30Note: seed.dec.d30 == null ? 'amostra curta: 3 agora vs 1 em 30 dias anteriores' : null,
      roiReal: seed.dec.roiReal,
      nRoi: seed.dec.amostra,
      verdict: VEREDITO_NA_TELA[seed.dec.veredito],
      veredito: seed.dec.veredito,
      tStat: null,
      faltam: seed.dec.faltam ?? 0,
    },
  })),
};
