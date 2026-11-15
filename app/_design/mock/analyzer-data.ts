// Histórico da banca "Big Data" para o Analyzer (`?mock=1`): as apostas de
// `./bet` empacotadas como o adaptador empacota. Sem `query`, a tela filtra o
// período localmente.
import type { AnalyzerFixtureData } from "../screen-types";
import type { AnalyzerPackedBet } from "../lib/analyzer-pack";
import { shiftDayKey } from "@/src/domain/dates";
import { BETS } from "./bet";

const STATUS: Record<(typeof BETS)[number]["status"], string> = {
  pending: 'PENDING',
  won: 'WON',
  halfwon: 'HALF_WON',
  lost: 'LOST',
  half: 'HALF_LOST',
  void: 'VOID',
  cashout: 'CASHOUT',
};

export const ANALYZER_MOCK_DATA: AnalyzerFixtureData = {
  scope: 'bankroll',
  bets: BETS.map((bet) => {
    const eventAt = `${bet.day}T${bet.time}:00.000Z`;
    const status = STATUS[bet.status];
    return [
      bet.day,
      eventAt,
      `${bet.home} vs ${bet.away}`,
      bet.league || '',
      bet.region,
      bet.esporte || 'Soccer',
      bet.market,
      bet.d?.casa || 'Pinnacle',
      bet.odds,
      bet.stake,
      status,
      bet.profit || 0,
      eventAt,
      bet.d?.close ?? null,
      bet.d?.liqOpen ?? null,
      bet.d?.open ?? null,
      bet.d?.open ?? null,
      bet.d?.close ?? null,
      bet.clv,
      bet.d?.close != null,
      bet.d?.close != null ? eventAt : null,
      status === 'PENDING' ? null : eventAt,
      bet.id,
      bet.line,
      null,
      null,
      bet.d?.liqOpen != null ? 'USD' : null,
      bet.d?.liqClose ?? null,
      bet.d?.liqClose != null ? 'USD' : null,
      null,
      null,
      false,
      '',
      null,
      bet.d?.close != null ? eventAt : null,
      null, null,
    ];
  }),
  bk: { name: 'Big Data', logoUrl: null, slug: 'main' },
  today: '2026-06-13',
  // Mesma forma que `getFrescorDosDados` devolve; fixo para não envelhecer.
  frescor: [
    { chave: 'captura', rotulo: 'captura', idadeMin: 12, emISO: null, texto: 'há 12 min', atrasada: false },
    { chave: 'fechamento', rotulo: 'fechamento', idadeMin: 47, emISO: null, texto: 'há 47 min', atrasada: false },
  ],
};

// Carteira (`/analyzer?mock=1`): quatro bancas sintéticas com valores de
// unidade diferentes e um canal × mercado com CLV claramente negativo, para a
// matriz e os cortes terem o que mostrar. Sorteio com semente fixa: o mock não
// muda entre leituras.
const CARTEIRA: ReadonlyArray<[canal: string, esporte: string, reaisPorUnidade: number,
  mercados: ReadonlyArray<[mercado: string, apostas: number, clvMedio: number, espalhamento: number]>]> = [
  ['Tênis Pro', 'Tennis', 50, [['Money Line – Match', 40, -3, 4], ['Handicap (Games) – Match', 15, 2, 4]]],
  ['Gols & Cantos', 'Soccer', 20, [['Total – Match', 35, 2.5, 5], ['Total (Corners) – Match', 20, -1, 6], ['Both Teams to Score', 6, 1, 4]]],
  ['Basquete Lab', 'Basketball', 100, [['Total Points', 25, 1, 5], ['Point Spread', 12, -0.5, 5]]],
  ['Handicap BR', 'Soccer', 25, [['Handicap – Match', 30, -0.6, 8], ['Money Line – Match', 8, 0.5, 4]]],
];

let semente = 7;
const sorteio = () => ((semente = (semente * 9301 + 49297) % 233280) / 233280);

function apostaDaCarteira(canal: string, esporte: string, reais: number, mercado: string, clv: number, i: number): AnalyzerPackedBet {
  const day = shiftDayKey('2026-06-13', -Math.floor(sorteio() * 80));
  const eventAt = `${day}T21:00:00.000Z`;
  const odds = 1.8 + Math.round(sorteio() * 30) / 100;
  const pendente = day >= '2026-06-12';
  const ganhou = sorteio() < 0.5;
  const stake = reais;
  const lucro = pendente ? 0 : ganhou ? Math.round(stake * (odds - 1) * 100) / 100 : -stake;
  const fechamento = Math.round((odds / (1 + clv / 100)) * 1000) / 1000;
  return [
    day, eventAt, `Mandante ${i + 1} vs Visitante ${i + 1}`, 'Liga', 'Brasil', esporte, mercado, 'Pinnacle',
    odds, stake, pendente ? 'PENDING' : ganhou ? 'WON' : 'LOST', lucro, eventAt,
    fechamento, null, null, null, fechamento, Math.round(clv * 100) / 100, true, eventAt,
    pendente ? null : eventAt, `${canal}-${mercado}-${i}`, 'Mandante', null, null, null, null, null, null,
    null, false, canal, reais,
    eventAt, 1, lucro / reais,
  ];
}

export const ANALYZER_PORTFOLIO_MOCK_DATA: AnalyzerFixtureData = {
  scope: 'portfolio',
  bets: CARTEIRA.flatMap(([canal, esporte, reais, mercados]) => mercados.flatMap(([mercado, n, clvMedio, espalhamento]) =>
    Array.from({ length: n }, (_, i) => apostaDaCarteira(canal, esporte, reais, mercado, clvMedio + (sorteio() - 0.5) * espalhamento, i)))),
  bk: { name: 'Carteira', logoUrl: null, slug: null },
  today: '2026-06-13',
  frescor: ANALYZER_MOCK_DATA.frescor,
};
