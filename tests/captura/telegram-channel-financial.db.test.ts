import { handleChannelReaction } from "../helpers/telegram-reaction";
// Garantias financeiras da captura de canal (lote, edição, reação): persistência real.
// Real PostgreSQL; LLMs, notifications and sports-provider calls are mocked.
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@/tests/helpers/db';
import type { SportResolutionDecision } from '@/src/domain/sports/detect';
import type { ParsedBetPost } from '@/src/domain/bet-capture';
const mocks = vi.hoisted(() => ({ text: vi.fn(), image: vi.fn(), registrations: 0, failAt: 0 }));
vi.mock(import('@/src/services/capture/reading/extract-bet'), () => ({
  extractBetFromText: mocks.text, extractBetFromImage: mocks.image,
  extractPlayerBetsFromImage: mocks.image, extractBetsFromImages: mocks.image,
}));

vi.mock(import('@/src/services/bets/sport-resolution/capture'), async (original) => ({
  ...await original(),
  resolveSportForCaptureAsync: vi.fn(async () => ({ sport: 'Soccer', status: 'CONFIRMED', confidence: 100, source: 'LEGACY', evidence: [], resolverVersion: 1 }) satisfies SportResolutionDecision),
}));
import { handleChannelPost, handleChannelPhotoPost } from '@/src/services/capture/channel/capture-new';
import { emojisFromReactionCounts } from '@/src/services/capture/channel/reactions';
import { registerCaptureBatch } from '@/src/services/capture/channel/register-post';
import { runSerializableTransaction } from '@/src/services/shared/transaction';
import { applyManualBetStatusChangeTx } from '@/src/services/bets/settle';
import { resetEnvCacheForTests } from '@/src/infra/env';

vi.mock(import('@/src/services/bets/register'), async (original) => {
  const actual = await original();
  return { ...actual, registerBet: async (...args: Parameters<typeof actual.registerBet>) => {
    const result = await actual.registerBet(...args);
    if (++mocks.registrations === mocks.failAt) throw new Error('transient failure after item write');
    return result;
  } };
});

let db: TestDb;
const channel = -999901n;
const source = `telegram-channel:${channel}`;
const postDate = new Date('2026-09-09T10:00:00Z');
const kickoff = new Date('2026-09-09T12:00:00Z');
const image = { base64: 'AQID', mimeType: 'image/png' };
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });
beforeEach(async () => {
  vi.stubEnv('TELEGRAM_ALLOWED_CHATS', '123'); resetEnvCacheForTests();
  mocks.registrations = 0; mocks.failAt = 0;
  await db.reset(); vi.clearAllMocks();
  mocks.text.mockResolvedValue({ bet: null, provider: 'gemini', notBet: true });
});
async function bank() {
  return db.prisma.bankroll.create({ data: {
    nome: 'Audit isolated', slug: 'audit-isolated', telegramChannelId: channel,
    defaultBookmaker: 'Betano', valorUnidade: 100,
  } });
}
function total(evento = 'Flamengo vs Palmeiras', selecao = 'Over 2.5'): ParsedBetPost {
  return { evento, selecao, mercado: 'Total – Match', esporte: 'Soccer',
    competicao: 'Brasileirao', pais: 'BR', data: kickoff, odds: 2, stake: 1,
    casaDeAposta: 'Betano', stakeSource: 'caption' };
}
async function seed(bankrollId: string, externalId = '42') {
  return db.prisma.bet.create({ data: {
    bankrollId, source, sourceExternalId: externalId, data: kickoff,
    evento: 'Flamengo vs Palmeiras', mercado: 'Handicap – Match', selecao: 'Palmeiras +0.25',
    esporte: 'Soccer', sportResolutionStatus: 'CONFIRMED', sportResolvedAt: postDate,
    odds: 2.1, stake: 2, casaDeAposta: 'Betano', competicao: 'Brasileirao', pais: 'BR',
    captureEvidence: { create: { parser: 'gemini', caption: 'Flamengo x Palmeiras\nPalmeiras +0.25\n@2.10\n2u', parsedJson: {}, expiresAt: new Date('2026-12-01T00:00:00Z') } },
  } });
}

it('reação identificada de quem não é autorizado não mexe na aposta nem abre revisão', async () => {
  const b = await bank();
  const c = await db.prisma.conta.create({ data: { casaDeAposta: 'Betano', titular: 'teste', saldoInicial: 0, saldoAtual: 0 } });
  const bet = await seed(b.id);
  await db.prisma.bet.update({ where: { id: bet.id }, data: { contaId: c.id } });
  await runSerializableTransaction('test.settle', tx => applyManualBetStatusChangeTx(tx, { betId: bet.id, newStatus: 'WON', source: 'manual:teste' }));
  const event = { chatId: channel, messageId: 42, actorUserId: '999', emojis: ['👎'], thumbsDownPresent: true };
  expect(await handleChannelReaction(event)).toEqual({ kind: 'ignored', reason: 'autor_nao_autorizado' });
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).deletedAt).toBeNull();
  expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: c.id } })).saldoAtual)).toBe(220);
  expect(await db.prisma.operationalAction.count()).toBe(0);
});

it('👎 anônimo do canal é do dono: remove com estorno, e tirar o 👎 restaura', async () => {
  const b = await bank();
  const c = await db.prisma.conta.create({ data: { casaDeAposta: 'Betano', titular: 'teste', saldoInicial: 0, saldoAtual: 0 } });
  const bet = await seed(b.id);
  await db.prisma.bet.update({ where: { id: bet.id }, data: { contaId: c.id } });
  await runSerializableTransaction('test.settle', tx => applyManualBetStatusChangeTx(tx, { betId: bet.id, newStatus: 'WON', source: 'manual:teste' }));
  const counts = [{ type: { type: 'emoji', emoji: '👎' }, total_count: 1 }];
  const down = { chatId: channel, messageId: 42, emojis: emojisFromReactionCounts(counts), thumbsDownPresent: true };
  expect(await handleChannelReaction(down)).toEqual({ kind: 'removed', betId: bet.id });
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).notTakenAt).not.toBeNull();
  expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: c.id } })).saldoAtual)).toBe(0);
  expect(await db.prisma.operationalAction.count()).toBe(0);

  expect(await handleChannelReaction({ chatId: channel, messageId: 42, emojis: [], thumbsDownPresent: false }))
    .toEqual({ kind: 'neutralized', betId: bet.id });
  const restored = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
  expect(restored).toMatchObject({ deletedAt: null, notTakenAt: null, status: 'WON' });
  expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: c.id } })).saldoAtual)).toBe(220);
});

it('👎 no post de lote vale para todas as seleções do post, sem alcançar outro post', async () => {
  const b = await bank();
  const a = await seed(b.id, '42:1'); const c = await seed(b.id, '42:2');
  const other = await seed(b.id, '420:1');
  const outcome = await handleChannelReaction({ chatId: channel, messageId: 42, emojis: ['👎'], thumbsDownPresent: true });
  expect(outcome.kind).toBe('removed');
  const removed = await db.prisma.bet.findMany({ where: { notTakenAt: { not: null } }, select: { id: true } });
  expect(removed.map((row) => row.id).sort()).toEqual([a.id, c.id].sort());
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: other.id } })).deletedAt).toBeNull();
  expect(await db.prisma.operationalAction.count()).toBe(0);
});

it.each(['foto', 'texto'])('lote de %s reverte falha parcial e repete com ordem invertida sem perda', async (via) => {
  await bank();
  const a = { ...total(), mercado: 'Money Line – Match', selecao: 'Flamengo' };
  const b = { ...total('Santos vs Corinthians'), mercado: 'Money Line – Match', selecao: 'Santos' };
  const post = { chatId: channel, messageId: 42, postDate, caption: '1u cada', mediaFileId: 'test-image' };
  const capture = () => via === 'foto' ? handleChannelPhotoPost(post, { loadImage: async () => image })
    : handleChannelPost({ ...post, text: 'Bilhete com duas simples @2.00 1u cada' });
  mocks.image.mockResolvedValue({ bet: a, bets: [a, b], provider: 'gemini' });
  mocks.text.mockResolvedValue({ bet: a, bets: [a, b], provider: 'gemini' });
  mocks.failAt = 2;
  await expect(capture()).rejects.toThrow('transient failure');
  expect(await db.prisma.bet.count()).toBe(0);
  expect(await db.prisma.betCaptureEvidence.count()).toBe(0);
  mocks.failAt = 0;
  mocks.image.mockResolvedValue({ bet: b, bets: [b, a], provider: 'gemini' });
  mocks.text.mockResolvedValue({ bet: b, bets: [b, a], provider: 'gemini' });
  expect(await capture()).toMatchObject({ kind: 'registered', betIds: expect.any(Array) });
  const rows = await db.prisma.bet.findMany({ orderBy: { sourceExternalId: 'asc' }, select: { id: true, evento: true, sourceExternalId: true } });
  expect(rows.map(row => row.evento).sort()).toEqual(['Flamengo vs Palmeiras', 'Santos vs Corinthians']);
  mocks.image.mockResolvedValue({ bet: a, bets: [a, b], provider: 'gemini' });
  mocks.text.mockResolvedValue({ bet: a, bets: [a, b], provider: 'gemini' });
  expect(await capture()).toMatchObject({ kind: 'duplicate' });
  expect(await db.prisma.bet.count()).toBe(2);
});

it('item do lote que já chegou por outro caminho é pulado, e os outros picks entram', async () => {
  const b = await bank();
  const a = { ...total(), mercado: 'Money Line – Match', selecao: 'Flamengo' };
  const other = { ...total('Santos vs Corinthians'), mercado: 'Money Line – Match', selecao: 'Santos' };
  const { registerBet } = await import('@/src/services/bets/register');
  // O dono passou o pick do Flamengo pela DM antes do post do canal.
  const dm = await registerBet({ bankrollId: b.id, source: 'telegram-dm:77', sourceExternalId: 'dm-1', data: kickoff, evento: a.evento,
    esporte: 'Soccer', mercado: a.mercado, selecao: a.selecao, odds: a.odds, stake: a.stake, casaDeAposta: 'Betano', competicao: a.competicao, pais: a.pais });
  const bankroll = { id: b.id, nome: b.nome, slug: b.slug, capturePolicy: b.capturePolicy, defaultBookmaker: b.defaultBookmaker };

  const outcome = await registerCaptureBatch({ bankroll, post: { chatId: channel, messageId: 43, postDate }, bets: [other, a], via: 'gemini', caption: '1u cada' });
  expect(outcome).toMatchObject({ kind: 'registered', betIds: [expect.any(String)] });
  const rows = await db.prisma.bet.findMany({ select: { id: true, evento: true, source: true } });
  expect(rows.map((row) => `${row.source} ${row.evento}`).sort()).toEqual([`${source} Santos vs Corinthians`, `telegram-dm:77 ${a.evento}`]);
  // O item pulado fica registrado na aposta que o engoliu.
  expect(await db.prisma.auditEvent.findFirstOrThrow({ where: { resource: 'bet', resourceId: dm.betId, action: 'bet.duplicate_absorbed' } }))
    .toMatchObject({ details: expect.objectContaining({ source, sourceExternalId: expect.stringMatching(/^43:\d$/) }) });

  // Tudo já registrado: o post responde como duplicata, sem recusa.
  expect(await registerCaptureBatch({ bankroll, post: { chatId: channel, messageId: 44, postDate }, bets: [a], via: 'gemini', caption: '1u cada' }))
    .toEqual({ kind: 'duplicate', betId: dm.betId });
  expect(await db.prisma.bet.count()).toBe(2);
});

it('lote parcial legado vira revisão e não é tratado como captura completa', async () => {
  const b = await bank(); await seed(b.id, '42:1');
  const a = { ...total(), mercado: 'Money Line – Match', selecao: 'Flamengo' };
  const other = { ...total('Santos vs Corinthians'), mercado: 'Money Line – Match', selecao: 'Santos' };
  const bankroll = { id: b.id, nome: b.nome, slug: b.slug, capturePolicy: b.capturePolicy, defaultBookmaker: b.defaultBookmaker };
  expect(await registerCaptureBatch({ bankroll, post: { chatId: channel, messageId: 42, postDate }, bets: [other, a], via: 'gemini', caption: '1u cada' }))
    .toEqual({ kind: 'unparseable', missing: ['lote_alterado_precisa_revisao'] });
  expect(await db.prisma.bet.count()).toBe(1);
  // A reentrega do post nem chega à leitura: o item já gravado responde.
  expect(await handleChannelPhotoPost({ chatId: channel, messageId: 42, postDate, caption: '1u cada', mediaFileId: 'test-image' }, { loadImage: async () => image }))
    .toMatchObject({ kind: 'duplicate' });
  expect(mocks.image).not.toHaveBeenCalled();
});

it('lote inteiramente absorvido não ganha outro pick nem relê o post na reentrega', async () => {
  const b = await bank();
  const a = total();
  const { registerBet } = await import('@/src/services/bets/register');
  const dm = await registerBet({ bankrollId: b.id, source: 'telegram-dm:77', sourceExternalId: 'dm-1', data: kickoff,
    evento: a.evento, esporte: 'Soccer', mercado: a.mercado, selecao: a.selecao, odds: a.odds, stake: a.stake,
    casaDeAposta: 'Betano', competicao: a.competicao, pais: a.pais });
  const bankroll = { id: b.id, nome: b.nome, slug: b.slug, capturePolicy: b.capturePolicy, defaultBookmaker: b.defaultBookmaker };
  const batch = { bankroll, post: { chatId: channel, messageId: 43, postDate }, via: 'gemini' as const, caption: '1u cada' };
  expect(await registerCaptureBatch({ ...batch, bets: [a] })).toEqual({ kind: 'duplicate', betId: dm.betId });
  expect(await registerCaptureBatch({ ...batch, bets: [a, total('Santos vs Corinthians')] }))
    .toEqual({ kind: 'duplicate', betId: dm.betId });
  expect(await db.prisma.bet.count()).toBe(1);
  expect(await handleChannelPhotoPost({ ...batch.post, caption: '1u cada', mediaFileId: 'test-image' }, { loadImage: async () => image }))
    .toEqual({ kind: 'duplicate', betId: dm.betId });
  expect(mocks.image).not.toHaveBeenCalled();
});

it('falha parcial do lote reverte também a origem absorvida antes de repetir', async () => {
  const b = await bank();
  const a = total();
  const { registerBet } = await import('@/src/services/bets/register');
  const dm = await registerBet({ bankrollId: b.id, source: 'telegram-dm:77', sourceExternalId: 'dm-1', data: kickoff,
    evento: a.evento, esporte: 'Soccer', mercado: a.mercado, selecao: a.selecao, odds: a.odds, stake: a.stake,
    casaDeAposta: 'Betano', competicao: a.competicao, pais: a.pais });
  const bankroll = { id: b.id, nome: b.nome, slug: b.slug, capturePolicy: b.capturePolicy, defaultBookmaker: b.defaultBookmaker };
  const params = { bankroll, post: { chatId: channel, messageId: 43, postDate }, via: 'gemini' as const,
    caption: '1u cada', bets: [a, total('Santos vs Corinthians')] };
  mocks.registrations = 0; mocks.failAt = 2;
  await expect(registerCaptureBatch(params)).rejects.toThrow('transient failure');
  expect(await db.prisma.absorbedBetSource.count()).toBe(0);
  expect(await db.prisma.auditEvent.count({ where: { action: 'bet.duplicate_absorbed' } })).toBe(0);
  expect((await db.prisma.bet.findMany()).map(row => row.id)).toEqual([dm.betId]);
  mocks.failAt = 0;
  expect(await registerCaptureBatch(params)).toMatchObject({ kind: 'registered' });
  expect(await db.prisma.bet.count()).toBe(2);
  expect(await db.prisma.absorbedBetSource.count()).toBe(1);
});
