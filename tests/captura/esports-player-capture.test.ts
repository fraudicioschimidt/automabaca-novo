import { expect, it } from 'vitest';
import { parseUniversalBetPost } from '@/src/domain/parse-bet-post';
import { needsSoccerTotalMarketRetry } from '@/src/services/capture/preparation/parse-capture-market-retry';
import { pinnacleizeSelecao } from '@/src/domain/mercados/selecao';
import { marketKindOf } from '@/src/domain/mercados/classify';
import { detectSportFromText } from '@/src/domain/sports/detect';
const parse = (selecao: string) => parseUniversalBetPost(`Tipster: Target\nData: 10/09/2026\nJogo: 9Z vs. G2\nEntrada: ${selecao}\nODD: 1.66\nStake: 1u`);
it.each(['HUASOPEEK Under 8.5 kills map 1 HT','D1Ledez Under 8.5 kills map 2 HT','xiELO Under 8.5 Deaths map 1 HT'])('preserva o contrato individual: %s', (selection) => {
  const parsed = parse(selection);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.bet.mercado).toBe('Player Props');
  expect(marketKindOf(parsed.bet.mercado)).toBe('player_props');
  expect(needsSoccerTotalMarketRetry(parsed.bet)).toBe(false);
  expect(pinnacleizeSelecao({ selecao: selection, mercadoPinnacle: parsed.bet.mercado, evento: parsed.bet.evento })).toBe(selection);
  expect(parsed.bet.stake).toBe(1);
  expect(parsed.bet.sportResolution).toMatchObject({ sport: 'eSports', status: 'CONFIRMED' });
});
it('não atribui esporte só pela palavra kills e preserva sinais conflitantes', () => {
  expect(detectSportFromText('Player Kills Under 8.5').status).toBe('PENDING');
  expect(detectSportFromText('🏀 Player Kills Under 8.5 map 1').status).toBe('CONFLICT');
});
it.each(['G2 Under 8.5 kills map 1 HT','Under 25.5 kills map 1','Total kills Over 25.5'])('não inventa atleta em %s', (selection) => {
  const parsed = parse(selection);
  if (parsed.ok) expect(parsed.bet.mercado).not.toBe('Player Props');
});

it.each([
  ['Total', 'Handball', 'Total – Match'],
  ['Total', 'Futsal', 'Total – Match'],
  ['Total', 'Hockey', 'Total – Match'],
  ['Handicap (Soccer) – Match', 'Soccer', 'Handicap – Match'],
  ['Handicap (Asian) - Match', 'Soccer', 'Handicap – Match'],
  ['Asian Handicap (Bookings) – Match', 'Soccer', 'Handicap (Bookings) – Match'],
])('normaliza a forma registrada %s em %s sem perder a estatística', async (market, sport, expected) => {
  const { pinnacleizeMercado } = await import('@/src/domain/mercados/finalize');
  expect(pinnacleizeMercado(market, sport)).toBe(expected);
});
