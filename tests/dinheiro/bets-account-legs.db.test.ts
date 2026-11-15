import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/tests/helpers/db';
import { toNumber } from '@/src/domain/money';
import { registerBet } from '@/src/services/bets/register';
import { applyBetEdit } from '@/src/services/bets/edit';
import { applyManualBetStatusChangeTx } from '@/src/services/bets/settle';
import { criarConta, alterarStatusConta, registrarMovimentacaoManual, removerConta } from '@/src/services/contas/manage';
import type { BetStatus } from '@/src/generated/prisma/client';

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });
const opts = () => ({ client: db.prisma });
const kickoff = new Date('2026-08-20T18:00:00Z');
/** Conta da aposta ao longo do ciclo de vida da conta, e múltiplas com pernas explícitas. */
const settle = (betId: string, newStatus: BetStatus) => db.prisma.$transaction(
  (tx) => applyManualBetStatusChangeTx(tx, { betId, newStatus, source: 'manual:audit' }),
  { isolationLevel: 'Serializable' },
);

async function seed() {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: 'Auditoria', slug: 'auditoria', valorUnidade: 50, sharpMode: 'OFF' },
  });
  const { contaId } = await criarConta({
    casaDeAposta: 'Betano', titular: 'Teste de auditoria', saldoInicial: 100,
    bankrollIds: [bankroll.id], actor: 'audit',
  }, opts());
  return { bankroll, contaId };
}

function input(bankrollId: string) {
  return {
    bankrollId, data: kickoff, evento: 'France vs Spain', esporte: 'Soccer',
    mercado: 'Moneyline', selecao: 'France', odds: 2, stake: 1,
    casaDeAposta: 'Betano', source: 'audit', actor: 'audit',
  };
}

const balanceOf = async (contaId: string) =>
  toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual);
const betLedgerEffect = async (betId: string, contaId: string) =>
  toNumber((await db.prisma.movimentacao.aggregate({ where: { betId, contaId }, _sum: { valor: true } }))._sum.valor ?? 0);

/**
 * LIMITADA: a casa restringiu apostas NOVAS. A aposta que já estava na conta
 * liquida nela, inclusive correção e reabertura.
 */
it('aposta WON numa conta que virou LIMITADA e é corrigida para LOST estorna o ganho e lança a perda', async () => {
  const { bankroll, contaId } = await seed();
  const { betId } = await registerBet(input(bankroll.id), opts());
  await settle(betId, 'WON');
  expect(await balanceOf(contaId)).toBe(150);
  await alterarStatusConta({ contaId, status: 'LIMITADA', expectedStatus: 'ATIVA', actor: 'audit' }, opts());

  const corrected = await settle(betId, 'LOST');

  expect(corrected.semContaElegivel).toBeUndefined();
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).contaId).toBe(contaId);
  expect(await balanceOf(contaId)).toBe(50);
  expect(await betLedgerEffect(betId, contaId)).toBe(-50);
  const tipos = (await db.prisma.movimentacao.findMany({
    where: { betId }, orderBy: { createdAt: 'asc' }, select: { tipo: true, valor: true },
  })).map((m) => [m.tipo, toNumber(m.valor)]);
  expect(tipos).toEqual([['GANHO_APOSTA', 50], ['ESTORNO', -50], ['PERDA_APOSTA', -50]]);
  expect(await db.prisma.operationalAction.count({ where: { title: 'Liquidada sem movimentar conta' } })).toBe(0);
});

it('repetir o WON e reabrir a aposta da conta LIMITADA mexem só na própria conta', async () => {
  const { bankroll, contaId } = await seed();
  const { betId } = await registerBet(input(bankroll.id), opts());
  await settle(betId, 'WON');
  await alterarStatusConta({ contaId, status: 'LIMITADA', expectedStatus: 'ATIVA', actor: 'audit' }, opts());

  const repetida = await settle(betId, 'WON');
  expect(repetida.semContaElegivel).toBeUndefined();
  expect(await balanceOf(contaId)).toBe(150);

  await settle(betId, 'PENDING');
  expect(await balanceOf(contaId)).toBe(100);
  expect(await betLedgerEffect(betId, contaId)).toBe(0);
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).contaId).toBe(contaId);
});

it('edição que reabre a aposta mantém o vínculo com a conta LIMITADA', async () => {
  const { bankroll, contaId } = await seed();
  const { betId } = await registerBet(input(bankroll.id), opts());
  await settle(betId, 'WON');
  await alterarStatusConta({ contaId, status: 'LIMITADA', expectedStatus: 'ATIVA', actor: 'audit' }, opts());
  const before = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } });

  await applyBetEdit({
    betId, actor: 'audit', financialAuthority: 'operator', expectedVersion: before.manualSettlementVersion, fields: {
      data: before.data, evento: before.evento, esporte: before.esporte,
      competicao: before.competicao, pais: before.pais, mercado: before.mercado,
      selecao: before.selecao, odds: 2.5, stake: toNumber(before.stake),
      casaDeAposta: before.casaDeAposta,
    },
  }, opts());
  await settle(betId, 'WON');

  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).contaId).toBe(contaId);
  expect(await balanceOf(contaId)).toBe(175);
});

it('edição mantém a aposta na conta LIMITADA mesmo com outra conta ATIVA da casa', async () => {
  const { bankroll, contaId } = await seed();
  const { betId } = await registerBet(input(bankroll.id), opts());
  await settle(betId, 'WON');
  await alterarStatusConta({ contaId, status: 'LIMITADA', expectedStatus: 'ATIVA', actor: 'audit' }, opts());
  const { contaId: activeAccount } = await criarConta({
    casaDeAposta: 'Betano', titular: 'Outro titular', saldoInicial: 100,
    bankrollIds: [bankroll.id], actor: 'audit',
  }, opts());
  const before = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } });

  await applyBetEdit({
    betId, actor: 'audit', financialAuthority: 'operator', expectedVersion: before.manualSettlementVersion, fields: {
      data: before.data, evento: before.evento, esporte: before.esporte,
      competicao: before.competicao, pais: before.pais, mercado: before.mercado,
      selecao: before.selecao, odds: 2.5, stake: toNumber(before.stake),
      casaDeAposta: before.casaDeAposta,
    },
  }, opts());
  await settle(betId, 'WON');

  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).contaId).toBe(contaId);
  expect(await balanceOf(contaId)).toBe(175);
  expect(await balanceOf(activeAccount)).toBe(100);
});

/** A casa da conta é a do vínculo: grafia, caixa e acento não separam a mesma casa. */
async function seedWithCasa(casaDeAposta: string) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: 'Grafia', slug: 'grafia', valorUnidade: 50, sharpMode: 'OFF' },
  });
  const { contaId } = await criarConta({
    casaDeAposta, titular: 'Teste de grafia', saldoInicial: 100,
    bankrollIds: [bankroll.id], actor: 'audit',
  }, opts());
  return { bankroll, contaId };
}

it('conta LIMITADA com outra grafia da casa continua recebendo a correção da aposta', async () => {
  const { bankroll, contaId } = await seedWithCasa('Betano BR');
  const { betId } = await registerBet(input(bankroll.id), opts());
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).contaId).toBe(contaId);
  await settle(betId, 'WON');
  await alterarStatusConta({ contaId, status: 'LIMITADA', expectedStatus: 'ATIVA', actor: 'audit' }, opts());

  const corrected = await settle(betId, 'LOST');

  expect(corrected.semContaElegivel).toBeUndefined();
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).contaId).toBe(contaId);
  expect(await balanceOf(contaId)).toBe(50);
});

it('edição da pendente mantém a conta LIMITADA escrita com acento diferente', async () => {
  const { bankroll, contaId } = await seedWithCasa('Lotérica Bet');
  const { betId } = await registerBet({ ...input(bankroll.id), casaDeAposta: 'Loterica Bet' }, opts());
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).contaId).toBe(contaId);
  await alterarStatusConta({ contaId, status: 'LIMITADA', expectedStatus: 'ATIVA', actor: 'audit' }, opts());
  const before = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } });

  await applyBetEdit({
    betId, actor: 'audit', financialAuthority: 'operator', expectedVersion: before.manualSettlementVersion, fields: {
      data: before.data, evento: before.evento, esporte: before.esporte,
      competicao: before.competicao, pais: before.pais, mercado: before.mercado,
      selecao: before.selecao, odds: 2.5, stake: toNumber(before.stake),
      casaDeAposta: before.casaDeAposta,
    },
  }, opts());

  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).contaId).toBe(contaId);
});

it('aposta NOVA não entra na conta LIMITADA e o aviso não manda ligar a conta', async () => {
  const { bankroll, contaId } = await seed();
  await alterarStatusConta({ contaId, status: 'LIMITADA', expectedStatus: 'ATIVA', actor: 'audit' }, opts());
  const { betId } = await registerBet(input(bankroll.id), opts());
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).contaId).toBeNull();

  const result = await settle(betId, 'WON');

  expect(result.semContaElegivel).toMatchObject({ casaDeAposta: 'Betano', reason: 'conta_limitada' });
  expect(await balanceOf(contaId)).toBe(100);
  const acao = await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: betId } });
  expect(acao.description).toContain('está limitada');
  expect(acao.description).not.toContain('ligue a conta certa');
});

it('conta ENCERRADA: o resultado fica sem ledger, o lançamento anterior é estornado e o aviso diz o motivo', async () => {
  const { bankroll, contaId } = await seed();
  const { betId } = await registerBet(input(bankroll.id), opts());
  await settle(betId, 'WON');
  await alterarStatusConta({ contaId, status: 'ENCERRADA', expectedStatus: 'ATIVA', actor: 'audit' }, opts());

  const corrigida = await settle(betId, 'LOST');

  expect(corrigida.semContaElegivel).toMatchObject({ reason: 'conta_encerrada' });
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).contaId).toBeNull();
  expect(await balanceOf(contaId)).toBe(100);
  expect(await betLedgerEffect(betId, contaId)).toBe(0);
  const acao = await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: betId } });
  expect(acao.description).toContain('foi encerrada');
  await expect(settle(betId, 'PENDING')).resolves.toMatchObject({ status: 'PENDING' });
});

function ticket(selection: string) {
  return {
    kind: 'same_game' as const,
    legs: [
      { evento: 'France vs Spain', mercado: 'Moneyline', selecao: 'France' },
      { evento: 'France vs Spain', mercado: 'Total', selecao: selection },
    ],
  };
}

it('preserva duas múltiplas de pernas diferentes com o mesmo resumo', async () => {
  const { bankroll } = await seed();
  const base = { ...input(bankroll.id), selecao: 'Seleções confirmadas' };
  const first = await registerBet({ ...base, sourceExternalId: 'ticket-1', legsJson: ticket('Over 2.5') }, opts());
  const second = await registerBet({ ...base, sourceExternalId: 'ticket-2', legsJson: ticket('Under 2.5') }, opts());
  expect(first.created).toBe(true);
  expect(second.created).toBe(true);
  expect(second.betId).not.toBe(first.betId);
  expect(await db.prisma.bet.count()).toBe(2);
});

it('mudança explícita de perna reabre a aposta e estorna o lucro anterior', async () => {
  const { bankroll, contaId } = await seed();
  const { betId } = await registerBet({ ...input(bankroll.id), selecao: 'Seleções confirmadas', legsJson: ticket('Over 2.5') }, opts());
  await db.prisma.betSharp.create({ data: { betId, identityStatus: 'MANUAL' } });
  await settle(betId, 'WON');
  await db.prisma.betClosing.create({ data: { betId, fetchedAt: new Date() } });
  await db.prisma.betResult.create({ data: { betId, resultFinal: true, scoreHome: 3, scoreAway: 0 } });
  const before = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  const edited = await applyBetEdit({
    betId, actor: 'telegram-edit', fields: {
      data: before.data, evento: before.evento, esporte: before.esporte,
      competicao: before.competicao, pais: before.pais, mercado: before.mercado,
      selecao: before.selecao, odds: toNumber(before.odds), stake: toNumber(before.stake),
      casaDeAposta: before.casaDeAposta, legsJson: ticket('Under 2.5'),
    },
  }, opts());
  const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(edited.settlementPreserved).toBe(false);
  expect(edited.requiresEnrich).toBe(true);
  expect(after.status).toBe('PENDING');
  expect(toNumber(after.lucro)).toBe(0);
  expect(after.settledAt).toBeNull();
  expect(await db.prisma.betSharp.count({ where: { betId } })).toBe(0);
  expect(await db.prisma.betClosing.count({ where: { betId } })).toBe(0);
  expect(await db.prisma.betResult.count({ where: { betId } })).toBe(0);
  expect(after.legsJson).toMatchObject({ legs: [expect.anything(), { selecao: 'Under 2.5' }] });
  expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual)).toBe(100);
});

it('remoção recusa efeito financeiro órfão mesmo com saldo total zerado', async () => {
  const { bankroll, contaId } = await seed();
  const { betId } = await registerBet(input(bankroll.id), opts());
  await settle(betId, 'WON');
  // Aposta desvinculada que deixou lançamento na conta; saldo e ledger ainda batem.
  await db.prisma.bet.update({ where: { id: betId }, data: { contaId: null } });
  await registrarMovimentacaoManual({ contaId, tipo: 'SAQUE', valor: 150, clientMutationId: 'legacy-withdraw-01' }, opts());
  await expect(removerConta({ contaId }, opts())).rejects.toThrow(/Reconcilie os lançamentos/);
  expect((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).deletedAt).toBeNull();
});

it('reversão de perda em conta encerrada não duplica estornos no retry', async () => {
  const { bankroll, contaId } = await seed();
  const { betId } = await registerBet(input(bankroll.id), opts());
  await settle(betId, 'LOST');
  await alterarStatusConta({ contaId, status: 'ENCERRADA' }, opts());
  await settle(betId, 'LOST');
  const movimentos = await db.prisma.movimentacao.count({ where: { betId } });
  await settle(betId, 'LOST');
  expect(await db.prisma.movimentacao.count({ where: { betId } })).toBe(movimentos);
  expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual)).toBe(100);
});

it('reentrega da mesma múltipla continua idempotente', async () => {
  const { bankroll } = await seed();
  const base = { ...input(bankroll.id), selecao: 'Seleções confirmadas', legsJson: ticket('Over 2.5') };
  const first = await registerBet({ ...base, sourceExternalId: 'original' }, opts());
  const duplicate = await registerBet({ ...base, sourceExternalId: 'reentrega' }, opts());
  expect(duplicate).toMatchObject({ created: false, betId: first.betId });
  expect(await db.prisma.bet.count()).toBe(1);
});

it('reordenar as mesmas pernas preserva o resultado e o lançamento', async () => {
  const { bankroll, contaId } = await seed();
  const { betId } = await registerBet({ ...input(bankroll.id), selecao: 'Seleções confirmadas', legsJson: ticket('Over 2.5') }, opts());
  await db.prisma.betSharp.create({ data: { betId, identityStatus: 'MANUAL' } });
  await settle(betId, 'WON');
  const before = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  const legs = before.legsJson as ReturnType<typeof ticket>;
  const movementCount = await db.prisma.movimentacao.count({ where: { betId } });
  const edited = await applyBetEdit({ betId, actor: 'telegram-edit', fields: {
    data: before.data, evento: before.evento, esporte: before.esporte,
    pais: before.pais, competicao: before.competicao, mercado: before.mercado,
    selecao: before.selecao, odds: toNumber(before.odds), stake: toNumber(before.stake),
    casaDeAposta: before.casaDeAposta, legsJson: { ...legs, legs: [...legs.legs].reverse() },
  } }, opts());
  expect(edited).toMatchObject({ settlementPreserved: true, requiresEnrich: false });
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe('WON');
  expect(await db.prisma.movimentacao.count({ where: { betId } })).toBe(movementCount);
  expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual)).toBe(150);
});
