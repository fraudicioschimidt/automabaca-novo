import { expect, it } from 'vitest';
import { normalizePlayerThreshold, buildPlayerPropTerms } from '@/src/domain/settlement/player-prop-terms';
import { captionStakeUnits, preparePlayerCaptureBatch } from '@/src/domain/player-prop-capture';
import type { ParsedBetPost } from '@/src/domain/bet-capture';
import { finalizeParsedBetForCapture } from '@/src/services/capture/preparation/parse-capture-guard';
it.each(['Mais 0.5+', 'Over 1,5+', '-2+', '+2+'])('não converte sufixo de número decimal/assinado: %s', (selection) => {
  expect(normalizePlayerThreshold(selection)).toBe(selection);
});
it('recusa linha decimal com + espúrio para a extração reler o bilhete', () => {
  expect(buildPlayerPropTerms({ mercado: 'Player Shots on Target', selecao: 'Thaciano Mais 0.5+', esporte: 'Soccer' })?.lineQuarters).toBeNull();
});
it.each([['Jogador 2+', 'Jogador Over 1.5'], ['Jogador 12+', 'Jogador Over 11.5'], ['Jogador 0.5', 'Jogador 0.5']])('preserva limiares válidos: %s', (original, expected) => {
  expect(normalizePlayerThreshold(original)).toBe(expected);
});
it('usa unidades da legenda e não os valores em reais lidos pelo modelo', () => {
  const bets = [62.5,25,12.5].map((stake, i): ParsedBetPost => ({ evento: 'Manchester United vs FC Sabah', esporte: 'Soccer', mercado: 'Total de Desarmes', selecao: `Christian Nwachukwu ${i+2}+`, playerProp: { jogador: 'Christian Nwachukwu', mercadoOriginal: 'Total de Desarmes', selecaoOriginal: `${i+2}+` }, competicao: '', pais: '', casaDeAposta: 'Betano', data: null, odds: [2.02,4.2,9.25][i]!, stake, stakeSource: 'caption', stakePolicySnapshot: { version: 1, stakePolicy: 'MESSAGE', defaultStakeUnits: null, originalStake: stake, source: 'message' } }));
  const batch = preparePlayerCaptureBatch(bets, 'Over 1.5 @2.02 — 1.25u — R$ 62,50\nOver 2.5 @4.20 — 0.5u — R$ 25,00\nOver 3.5 @9.25 — 0.25u — R$ 12,50', true);
  expect(batch.ok).toBe(true);
  if (!batch.ok) return;
  expect(batch.bets.map((b) => b.stake)).toEqual([1.25,.5,.25]);
  expect(batch.bets.map((b) => b.selecao)).toEqual(['Christian Nwachukwu Over 1.5','Christian Nwachukwu Over 2.5','Christian Nwachukwu Over 3.5']);
});

const propBet = (jogador: string, stake: number, stakeSource: ParsedBetPost['stakeSource']): ParsedBetPost => ({
  evento: 'Flamengo vs Palmeiras', esporte: 'Soccer', mercado: 'Player Shots on Target', selecao: `${jogador} Over 0.5`,
  competicao: '', pais: '', casaDeAposta: '', data: null, odds: 1.9, stake, stakeSource,
  stakePolicySnapshot: { version: 1, stakePolicy: 'MESSAGE', defaultStakeUnits: null, originalStake: stake, source: 'message' },
});
const twoProps = () => [propBet('Pedro', 1, 'caption'), propBet('Arrascaeta', 1, 'caption')];

it.each([
  'Máx 5u no dia\n1u cada',
  'Meta da semana: 10u\n1u cada',
  'Gestão: até 3u por jogo\n1u cada',
  '(máx 2u) 1u cada',
  'Meta da semana • 10u\n1u cada',
])("limite ou meta na legenda não vira a stake do lote: '%s'", (caption) => {
  const batch = preparePlayerCaptureBatch(twoProps(), caption, false);
  expect(batch).toMatchObject({ ok: true });
  if (batch.ok) expect(batch.bets.map((b) => b.stake)).toEqual([1, 1]);
});

it.each([
  ['0.5u cada (total 1u)', [0.5, 0.5]],
  ['Pedro 1u green\nArrascaeta 0.5u', [1, 0.5]],
  ['Pedro 1 unid\nArrascaeta 2 units', [1, 2]],
])("stake de cada prop na legenda '%s'", (caption, stakes) => {
  const batch = preparePlayerCaptureBatch(twoProps(), caption, false);
  expect(batch).toMatchObject({ ok: true });
  if (batch.ok) expect(batch.bets.map((b) => b.stake)).toEqual(stakes);
});

it.each(['1u\nMeta do mês: 10u', 'Meta da semana • 10u\n1u'])("meta na legenda não conta como a stake de uma segunda prop: '%s'", (caption) => {
  expect(preparePlayerCaptureBatch(twoProps(), caption, false))
    .toEqual({ ok: false, reason: 'quantidade_de_stakes_divergente' });
});

it("'cada' com stakes diferentes na legenda é recusa, não a primeira para todas", () => {
  expect(preparePlayerCaptureBatch(twoProps(), '1u cada\n2u na segunda', false))
    .toEqual({ ok: false, reason: 'quantidade_de_stakes_divergente' });
});

it('meta na legenda não passa por cima da stake em unidades lida do print', () => {
  const batch = preparePlayerCaptureBatch([propBet('Pedro', 1, 'image_units')], 'Meta do mês: 10u', true);
  expect(batch).toMatchObject({ ok: true });
  if (batch.ok) expect(batch.bets.map((b) => b.stake)).toEqual([1]);
});

it('a soma do lote na legenda não vira a stake de cada prop lida do print, nem no guard', () => {
  const caption = 'Props de hoje\nTotal: 2u';
  const batch = preparePlayerCaptureBatch([propBet('Pedro', 0.5, 'image_units'), propBet('Arrascaeta', 1.5, 'image_units')], caption, true);
  expect(batch).toMatchObject({ ok: true });
  if (!batch.ok) return;
  const guarded = batch.bets.map((bet) => finalizeParsedBetForCapture(bet, caption, 'AUTO', { readFromImage: true, sharedCaption: true }));
  expect(guarded.map((result) => result.ok && result.bet.stake)).toEqual([0.5, 1.5]);
});

it("stake da IA lida da legenda que só aparece nela como limite ou meta é recusa, não a stake de cada prop", () => {
  for (const caption of ['Máx 5u no dia', 'Meta da semana: 5u']) {
    expect(preparePlayerCaptureBatch([propBet('Pedro', 5, 'caption'), propBet('Arrascaeta', 5, 'caption')], caption, false))
      .toEqual({ ok: false, reason: 'stake_invalida' });
  }
  const batch = preparePlayerCaptureBatch(twoProps(), 'Máx 5u no dia', false);
  expect(batch).toMatchObject({ ok: true });
  if (batch.ok) expect(batch.bets.map((b) => b.stake)).toEqual([1, 1]);
});


it.each([
  ['1/2u cada', 0.5],
  ['3/4u cada', 0.75],
  ['½u cada', 0.5],
  ['1½u cada', 1.5],
  ['1,000.00u cada', 1000],
  ['1.000,00u cada', 1000],
])('a stake explícita %s prevalece sobre o valor monetário da imagem', (caption, stake) => {
  const bets = [propBet('Pedro', 50, 'image_units'), propBet('Arrascaeta', 50, 'image_units')];
  const batch = preparePlayerCaptureBatch(bets, caption, true);
  expect(batch).toMatchObject({ ok: true });
  if (batch.ok) {
    expect(batch.bets.map((bet) => bet.stake)).toEqual([stake, stake]);
    expect(batch.bets.map((bet) => bet.stakePolicySnapshot?.originalStake)).toEqual([stake, stake]);
    expect(batch.bets.map((bet) => bet.stakeSource)).toEqual(['caption', 'caption']);
  }
});

it.each(['1 a 2u cada', '1-2u cada', '1,2,3u cada', '-1u cada', '-1/2u cada'])('stake escrita inválida não recai no valor da imagem: %s', (caption) => {
  expect(preparePlayerCaptureBatch([propBet('Pedro', 50, 'image_units')], caption, true))
    .toEqual({ ok: false, reason: 'stake_invalida' });
});

it('resultado com sinal na legenda não substitui as unidades da imagem', () => {
  const batch = preparePlayerCaptureBatch([propBet('Pedro', 0.5, 'image_units')], 'Ontem +12u', true);
  expect(batch).toMatchObject({ ok: true });
  if (batch.ok) expect(batch.bets[0]?.stake).toBe(0.5);
});


it.each(['Semana: +8,5u', 'Fechamos o mês em +30u 🚀', 'Saldo do dia -2u', '✅ +1,5u no bolso', '+1,5u ✅', '❌ -1u'])('resultado com sinal não é stake do lote: %s', (result) => {
  expect(captionStakeUnits(`1u cada\n${result}`).stakes).toEqual([1]);
  const batch = preparePlayerCaptureBatch(twoProps(), `1u cada\n${result}`, false);
  expect(batch).toMatchObject({ ok: true });
  if (batch.ok) expect(batch.bets.map((bet) => bet.stake)).toEqual([1, 1]);
});

it('stake que a IA diz ter lido do saldo com sinal da legenda é recusa', () => {
  expect(preparePlayerCaptureBatch([propBet('Pedro', 8.5, 'caption')], 'Semana: +8,5u', false))
    .toEqual({ ok: false, reason: 'stake_invalida' });
});

it.each(['Máx 1/2u\n1/4u cada', '1/4u cada (total 1/2u)', 'Retorno 1/2u\n1/4u cada'])("fração em anotação não vira stake do lote: %s", (caption) => {
  const batch = preparePlayerCaptureBatch(twoProps(), caption, true);
  expect(batch).toMatchObject({ ok: true });
  if (batch.ok) expect(batch.bets.map((bet) => bet.stake)).toEqual([0.25, 0.25]);
});


it('stake fixa do tipster continua sem ler as unidades da legenda', () => {
  const bets = twoProps().map((bet) => ({ ...bet, stake: 0.25,
    stakePolicySnapshot: { version: 1 as const, stakePolicy: 'ALWAYS' as const, defaultStakeUnits: 0.25, originalStake: 50, source: 'bankroll_fixed' as const },
  }));
  const batch = preparePlayerCaptureBatch(bets, '-1u cada', true);
  expect(batch).toMatchObject({ ok: true });
  if (batch.ok) expect(batch.bets.map((bet) => bet.stake)).toEqual([0.25, 0.25]);
});
