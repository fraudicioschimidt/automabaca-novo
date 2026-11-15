import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDb, settleRaceAgainst, type TestDb } from "../helpers/db";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { registerBet, type RegisterBetInput } from "@/src/services/bets/register";
import { handleChannelReaction } from "@/src/services/capture/channel/reactions";
import { applyManualBetStatusChange } from "../helpers/settle";
import { planBatchRemoval, removeBetsInBatch, restoreBetsInBatch, softDeleteBet } from "@/src/services/bets/remove";
import { runSerializableTransaction, reuseSerializableTransaction } from "@/src/services/shared/transaction";
import { reconcileCapturedReactionTx } from "@/src/services/capture/channel/reaction-decisions";
import type { ReactionEvent } from "@/src/domain/telegram-reaction";
import { getTrilhaDaAposta } from "@/src/services/painel/aposta/trilha";

const effects = vi.hoisted(() => ({ removed: vi.fn(), restored: vi.fn(), notify: vi.fn() }));
vi.mock("@/src/services/bets/remove-effects", () => ({ finishSoftDeleteBet: effects.removed, finishNotTakenRestore: effects.restored }));
vi.mock("@/src/services/bets/settle-effects", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/services/bets/settle-effects")>(),
  finishBetStatusChange: vi.fn(),
}));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperatorNotification: effects.notify, sendOperationalAlert: vi.fn(), persistOperationalAlert: vi.fn() }));

let db: TestDb;
const chatId = -490000n;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => {
  await db.reset(); vi.clearAllMocks();
  vi.stubEnv("TELEGRAM_ALLOWED_CHATS", "123"); resetEnvCacheForTests();
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });
async function seed() {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "C49 sintético", slug: "c49", telegramChannelId: chatId, valorUnidade: 50 } });
  const conta = await db.prisma.conta.create({ data: { titular: "Sintético", casaDeAposta: "Betano", saldoInicial: 500, saldoAtual: 500, bankrollLinks: { create: { bankrollId: bankroll.id } } } });
  const input: RegisterBetInput = { bankrollId: bankroll.id, evento: "France vs Spain", esporte: "Soccer", mercado: "Money Line – Match", selecao: "France", odds: 2, stake: 1, casaDeAposta: "Betano", data: new Date("2026-09-01T12:00:00Z"), source: `telegram-channel:${chatId}`, sourceExternalId: "42" };
  return { bankroll, conta, input };
}
function event(updateId: number, decision: "down" | "up" | "neutral" = "down", extra: Partial<ReactionEvent> = {}): ReactionEvent {
  return { chatId, messageId: 42, actorUserId: "123", emojis: decision === "down" ? ["👎"] : decision === "up" ? ["👍"] : [], thumbsDownPresent: decision === "down", occurredAt: "2026-09-13T01:00:00.000Z", updateId, ...extra };
}
const get = (id: string) => db.prisma.bet.findUniqueOrThrow({ where: { id } });
const balance = async (id: string) => Number((await db.prisma.conta.findUniqueOrThrow({ where: { id } })).saldoAtual);
async function album(winnerMessageId = 42) {
  return db.prisma.telegramMediaAlbum.create({ data: { mediaGroupId: "synthetic-album", chatId: String(chatId), winnerMessageId, winnerFileId: "synthetic-photo", messageIds: [41, 42, 43], photos: [], postDate: new Date(), expiresAt: new Date(Date.now() + 60000) } });
}

/** Remove pelo painel como a tela faz: prévia confirmada e operador da sessão. */
async function removeFromPanel(bankrollId: string, betId: string) {
  const plan = await planBatchRemoval({ bankrollId, betIds: [betId] });
  const confirmed = plan.remove.map(({ id, status, lucro }) => ({ id, status, lucro }));
  await removeBetsInBatch({ bankrollId, betIds: [betId], confirmed, actor: "fabricio" });
}
// No canal a reação chega anônima: a contagem do post, sem usuário.
const anonymous = { actorUserId: undefined };

it.each([
  ["👍", [event(1, "up", anonymous)]],
  ["❤️", [event(1, "neutral", { ...anonymous, emojis: ["❤️"] })]],
  ["tirar o 👍", [event(1, "up", anonymous), event(2, "neutral", anonymous)]],
])("removida pelo painel continua removida depois de %s, com o saldo igual", async (_reaction, events) => {
  const { input, conta, bankroll } = await seed(); const created = await registerBet(input);
  await applyManualBetStatusChange({ betId: created.betId, newStatus: "WON", source: "manual:test" });
  await removeFromPanel(bankroll.id, created.betId);
  expect(await balance(conta.id)).toBe(500);
  for (const reaction of events) await handleChannelReaction(reaction);
  expect(await get(created.betId)).toMatchObject({ status: "CANCELED", deletedAt: expect.any(Date), notTakenAt: expect.any(Date) });
  expect(await balance(conta.id)).toBe(500);
  expect(await db.prisma.auditEvent.count({ where: { action: "bet.not_taken_undone" } })).toBe(0);
});

it("👎 no post trava o lote antes do primeiro estorno: a liquidação da irmã, que já travou a aposta, não fecha ciclo com a conta", async () => {
  const { input, conta } = await seed();
  const settled = await registerBet({ ...input, sourceExternalId: "42:1" });
  const sibling = await registerBet({ ...input, evento: "Italy vs Germany", selecao: "Italy", sourceExternalId: "42:2" });
  await applyManualBetStatusChange({ betId: settled.betId, newStatus: "WON", source: "manual:test" });
  expect(await balance(conta.id)).toBe(550);

  await settleRaceAgainst({ betId: sibling.betId, contaId: conta.id }, () => handleChannelReaction(event(1, "down", anonymous)));

  expect(await get(settled.betId)).toMatchObject({ status: "CANCELED", deletedAt: expect.any(Date) });
  expect(await get(sibling.betId)).toMatchObject({ status: "CANCELED", deletedAt: expect.any(Date) });
  expect(await balance(conta.id)).toBe(500);
});

it("👎 posto e tirado numa aposta que o painel removeu não a restaura: só o painel desfaz", async () => {
  const { input, conta, bankroll } = await seed(); const created = await registerBet(input);
  await applyManualBetStatusChange({ betId: created.betId, newStatus: "WON", source: "manual:test" });
  await removeFromPanel(bankroll.id, created.betId);
  await handleChannelReaction(event(1, "down", anonymous));
  expect(await handleChannelReaction(event(2, "neutral", anonymous))).toEqual({ kind: "ignored", reason: "removida_pelo_painel" });
  expect(await get(created.betId)).toMatchObject({ status: "CANCELED", deletedAt: expect.any(Date) });
  expect(await balance(conta.id)).toBe(500);
  await restoreBetsInBatch({ bankrollId: bankroll.id, betIds: [created.betId], actor: "fabricio" });
  expect(await get(created.betId)).toMatchObject({ status: "WON", deletedAt: null });
  expect(await balance(conta.id)).toBe(550);
});

it("👎 mantido com outra reação não mexe; tirar o 👎 restaura, como antes", async () => {
  const { input, conta } = await seed(); const created = await registerBet(input);
  await applyManualBetStatusChange({ betId: created.betId, newStatus: "WON", source: "manual:test" });
  expect(await handleChannelReaction(event(1, "down", anonymous))).toEqual({ kind: "removed", betId: created.betId });
  expect(await handleChannelReaction(event(2, "down", { ...anonymous, emojis: ["👎", "❤️"] }))).toEqual({ kind: "ignored", reason: "reacao_irrelevante" });
  expect(effects.removed).toHaveBeenCalledOnce();
  expect(await balance(conta.id)).toBe(500);
  expect(await handleChannelReaction(event(3, "neutral", anonymous))).toEqual({ kind: "neutralized", betId: created.betId });
  expect(await get(created.betId)).toMatchObject({ status: "WON", deletedAt: null, notTakenAt: null });
  expect(await balance(conta.id)).toBe(550);
});

it("restaurada pelo painel depois do 👎 não sai de novo com outra reação enquanto o 👎 fica", async () => {
  const { input, bankroll } = await seed(); const created = await registerBet(input);
  await handleChannelReaction(event(1, "down", anonymous));
  await restoreBetsInBatch({ bankrollId: bankroll.id, betIds: [created.betId], actor: "fabricio" });
  await handleChannelReaction(event(2, "down", { ...anonymous, emojis: ["👎", "❤️"] }));
  expect(await get(created.betId)).toMatchObject({ status: "PENDING", deletedAt: null, notTakenAt: null });
  // Tirar o 👎 depois não tem o que restaurar; pô-lo de novo remove.
  await handleChannelReaction(event(3, "neutral", anonymous));
  expect(await handleChannelReaction(event(4, "down", anonymous))).toEqual({ kind: "removed", betId: created.betId });
});

it("lembra 👎 antes da aposta e registra a exclusão no mesmo commit, sem saldo ou alerta extra", async () => {
  const { input, conta } = await seed();
  expect(await handleChannelReaction(event(1))).toEqual({ kind: "remembered" });
  const created = await registerBet(input);
  expect(created).toMatchObject({ created: true, notTaken: true });
  expect(await get(created.betId)).toMatchObject({ status: "CANCELED", deletedAt: expect.any(Date), notTakenAt: expect.any(Date) });
  expect(await balance(conta.id)).toBe(500);
  expect(await db.prisma.movimentacao.count()).toBe(0);
  expect(await db.prisma.operationalAction.count()).toBe(0);
  expect(effects.notify).not.toHaveBeenCalled();
  expect(effects.removed).not.toHaveBeenCalled();
  expect(await db.prisma.auditEvent.findFirst({ where: { action: "bet.soft_delete" } })).toMatchObject({ details: { previousStatus: "PENDING" } });
});

it.each(["up", "neutral"] as const)("decisão %s antes da captura supera 👎 e retentativa atrasada", async (decision) => {
  const { input } = await seed();
  await handleChannelReaction(event(2, decision));
  await handleChannelReaction(event(1));
  const created = await registerBet(input);
  expect(await get(created.betId)).toMatchObject({ status: "PENDING", notTakenAt: null, deletedAt: null });
  expect(await db.prisma.auditEvent.count({ where: { action: "telegram.reaction_decision" } })).toBe(1);
});

it("data original tem precedência sobre update_id, inclusive após a captura", async () => {
  const { input } = await seed(); const created = await registerBet(input);
  await handleChannelReaction(event(10, "up", { occurredAt: "2026-09-13T02:00:00.000Z" }));
  await handleChannelReaction(event(999, "down"));
  expect((await get(created.betId)).deletedAt).toBeNull();
});

it("reverte e restaura o ledger exatamente uma vez, mantendo o resultado anterior", async () => {
  const { input, conta } = await seed(); const created = await registerBet(input);
  await applyManualBetStatusChange({ betId: created.betId, newStatus: "WON", source: "manual:test" });
  expect(await balance(conta.id)).toBe(550);
  await handleChannelReaction(event(1)); await handleChannelReaction(event(1));
  expect(await balance(conta.id)).toBe(500);
  await handleChannelReaction(event(3, "neutral")); await handleChannelReaction(event(2)); await handleChannelReaction(event(3, "neutral"));
  expect(await balance(conta.id)).toBe(550);
  expect(await get(created.betId)).toMatchObject({ status: "WON", deletedAt: null, notTakenAt: null });
  expect(await db.prisma.auditEvent.count({ where: { action: "bet.soft_delete" } })).toBe(1);
  expect(await db.prisma.auditEvent.count({ where: { action: "bet.not_taken_undone" } })).toBe(1);
  expect(effects.removed).toHaveBeenCalledOnce(); expect(effects.restored).toHaveBeenCalledOnce();
});

it.each([true, false])("captura e 👎 concorrentes convergem sem perder a decisão (reação primeiro=%s)", async (reactionFirst) => {
  const { input } = await seed();
  const capture = () => registerBet(input); const reaction = () => handleChannelReaction(event(1));
  await Promise.all(reactionFirst ? [reaction(), capture()] : [capture(), reaction()]);
  const bet = await db.prisma.bet.findFirstOrThrow();
  expect(bet).toMatchObject({ status: "CANCELED", notTakenAt: expect.any(Date) });
  expect(await db.prisma.auditEvent.count({ where: { action: "bet.soft_delete" } })).toBe(1);
});

it("decisões concorrentes convergem para o maior update_id do mesmo segundo", async () => {
  const { input } = await seed(); const created = await registerBet(input);
  await Promise.all([handleChannelReaction(event(3, "neutral")), handleChannelReaction(event(1)), handleChannelReaction(event(2))]);
  expect(await get(created.betId)).toMatchObject({ status: "PENDING", notTakenAt: null, deletedAt: null });
});

it("reação em foto irmã acompanha promoção do vencedor e sobrevive à purga do álbum", async () => {
  const { input } = await seed(); await album(41);
  await handleChannelReaction(event(1, "down", { messageId: 43 }));
  await db.prisma.telegramMediaAlbum.update({ where: { mediaGroupId: "synthetic-album" }, data: { winnerMessageId: 42 } });
  const created = await registerBet(input);
  expect((await get(created.betId)).notTakenAt).not.toBeNull();
  await db.prisma.telegramMediaAlbum.deleteMany();
  // Sem o álbum, tirar o 👎 da foto irmã ainda restaura; o 👎 antigo da mesma foto, entregue depois, não volta.
  await handleChannelReaction(event(3, "neutral", { messageId: 43 }));
  await handleChannelReaction(event(2, "down", { messageId: 43 }));
  expect((await get(created.betId)).notTakenAt).toBeNull();
  expect(await db.prisma.telegramReactionState.count({ where: { targetMessageId: 42 } })).toBe(3);
});

it("registra vínculos das fotos mesmo sem reação prévia", async () => {
  const { input } = await seed(); await album(); const created = await registerBet(input);
  await db.prisma.telegramMediaAlbum.deleteMany();
  await handleChannelReaction(event(1, "down", { messageId: 43 }));
  expect((await get(created.betId)).notTakenAt).not.toBeNull();
});

it("👎 lembrado antes do lote remove todas as seleções no commit da captura", async () => {
  const { input } = await seed(); await handleChannelReaction(event(1));
  await runSerializableTransaction("test-batch", async tx => {
    const client = reuseSerializableTransaction(tx);
    await registerBet({ ...input, sourceExternalId: "42:1" }, { client });
    await registerBet({ ...input, sourceExternalId: "42:2", selecao: "Spain", odds: 3 }, { client });
    expect(await reconcileCapturedReactionTx(tx, { source: input.source!, sourceExternalId: "42", bankrollId: input.bankrollId })).toBe(true);
  });
  expect(await db.prisma.bet.count({ where: { notTakenAt: { not: null } } })).toBe(2);
  expect(await db.prisma.operationalAction.count({ where: { actionType: "bet.reaction.review" } })).toBe(0);
});

it("👎 anônimo que chega antes da aposta é lembrado e aplicado na captura", async () => {
  const { input } = await seed();
  expect(await handleChannelReaction(event(1, "down", { actorUserId: undefined }))).toEqual({ kind: "remembered" });
  const created = await registerBet(input);
  expect(created).toMatchObject({ created: true, notTaken: true });
  expect(await db.prisma.auditEvent.findFirst({ where: { action: "telegram.reaction_decision" } }))
    .toMatchObject({ actor: "telegram-user:123", details: { anonima: true } });
});

it.each(["999", "-123"])("autor identificado %s sem autorização não pode guardar intenção financeira", async actorUserId => {
  const { input } = await seed(); await handleChannelReaction(event(1, "down", { actorUserId }));
  expect(await db.prisma.telegramReactionState.count()).toBe(0);
  const created = await registerBet(input); expect((await get(created.betId)).notTakenAt).toBeNull();
});

it("revogação do operador antes da captura impede aplicação posterior", async () => {
  const { input } = await seed(); await handleChannelReaction(event(1));
  vi.stubEnv("TELEGRAM_ALLOWED_CHATS", "999"); resetEnvCacheForTests();
  const created = await registerBet(input); expect((await get(created.betId)).notTakenAt).toBeNull();
});

it.each([{ updateId: undefined }, { occurredAt: undefined }, { updateId: -1 }, { occurredAt: "inválida" }])("payload legado/inválido não recebe ordem inventada: %j", async extra => {
  const { input } = await seed(); const created = await registerBet(input);
  expect(await handleChannelReaction(event(1, "down", extra))).toMatchObject({ kind: "ignored", reason: "reacao_sem_ordem_original" });
  expect((await get(created.betId)).notTakenAt).toBeNull();
  expect(await db.prisma.telegramReactionState.count({ where: { decision: { not: null } } })).toBe(0);
});

it("não transfere intenção a outra banca após remapeamento de canal", async () => {
  const { input, bankroll } = await seed(); await handleChannelReaction(event(1));
  await db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { telegramChannelId: null } });
  const other = await db.prisma.bankroll.create({ data: { nome: "Outra", slug: "outra", telegramChannelId: chatId } });
  const created = await registerBet({ ...input, bankrollId: other.id });
  expect((await get(created.betId)).notTakenAt).toBeNull();
});

it("dedup por conteúdo de outro post não permite excluir a aposta anterior", async () => {
  const { input } = await seed(); const original = await registerBet(input);
  await handleChannelReaction(event(1, "down", { messageId: 44 }));
  expect(await registerBet({ ...input, sourceExternalId: "44" })).toMatchObject({ created: false, betId: original.betId });
  await handleChannelReaction(event(2, "neutral", { messageId: 44 }));
  await handleChannelReaction(event(3, "down", { messageId: 44 }));
  expect(await get(original.betId)).toMatchObject({ notTakenAt: null, deletedAt: null, takenAt: null });
});

it("retirada do 👎 e repetição de 👍 não desfazem exclusão manual", async () => {
  const { input } = await seed(); const created = await registerBet(input);
  await handleChannelReaction(event(1, "up"));
  await softDeleteBet({ betId: created.betId, actor: "manual:test", motivo: "manual", origin: "painel" });
  await handleChannelReaction(event(1, "up")); await handleChannelReaction(event(2, "neutral"));
  expect(await get(created.betId)).toMatchObject({ deletedAt: expect.any(Date), status: "CANCELED" });
});

it("👍 marca o lote do post como pego na hora da reação; repetido na contagem não muda; tirar desmarca", async () => {
  const { input } = await seed();
  const [first, second] = await runSerializableTransaction("test-batch", async (tx) => {
    const client = reuseSerializableTransaction(tx);
    return [
      await registerBet({ ...input, sourceExternalId: "42:1" }, { client }),
      await registerBet({ ...input, sourceExternalId: "42:2", selecao: "Spain", odds: 3 }, { client }),
    ];
  });
  const ids = [first!.betId, second!.betId];
  const takenAt = async () => (await db.prisma.bet.findMany({ where: { id: { in: ids } }, select: { takenAt: true } })).map((bet) => bet.takenAt);

  expect(await handleChannelReaction(event(1, "up", { ...anonymous, occurredAt: "2026-09-13T01:02:00.000Z" }))).toMatchObject({ kind: "taken" });
  expect(await takenAt()).toEqual([new Date("2026-09-13T01:02:00.000Z"), new Date("2026-09-13T01:02:00.000Z")]);
  // Outra reação muda a contagem e repete o 👍: nada muda, nem a hora.
  expect(await handleChannelReaction(event(2, "up", { ...anonymous, emojis: ["👍", "❤️"], occurredAt: "2026-09-13T01:05:00.000Z" })))
    .toEqual({ kind: "ignored", reason: "reacao_irrelevante" });
  expect(await takenAt()).toEqual([new Date("2026-09-13T01:02:00.000Z"), new Date("2026-09-13T01:02:00.000Z")]);
  expect(await db.prisma.auditEvent.count({ where: { action: "bet.taken" } })).toBe(2);

  expect(await handleChannelReaction(event(3, "neutral", { ...anonymous, emojis: ["❤️"], occurredAt: "2026-09-13T01:06:00.000Z" })))
    .toMatchObject({ kind: "untaken" });
  expect(await takenAt()).toEqual([null, null]);
  expect(await db.prisma.auditEvent.count({ where: { action: "bet.taken_undone" } })).toBe(2);
  // A ficha conta a história da marca.
  const trilha = (await getTrilhaDaAposta(ids[0]!)).linhas.filter((linha) => linha.chave.startsWith("peguei"));
  expect(trilha.map((linha) => linha.frase.map((trecho) => trecho.texto).join(""))).toEqual(expect.arrayContaining([
    "Entrada marcada como pega em 12/09 22:02 — 👍 no post do canal.",
    "Desfeita a marca de pega de 12/09 22:02 — 👍 retirado do post do canal.",
  ]));
  // Só marca: stake, status e ledger ficam como estavam, sem aviso.
  expect(await db.prisma.bet.findMany({ where: { id: { in: ids } }, select: { status: true, deletedAt: true, notTakenAt: true } }))
    .toEqual([{ status: "PENDING", deletedAt: null, notTakenAt: null }, { status: "PENDING", deletedAt: null, notTakenAt: null }]);
  expect(await db.prisma.movimentacao.count()).toBe(0);
  expect(effects.notify).not.toHaveBeenCalled();
});

/**
 * Cada foto do álbum tem as próprias reações, e o post é a soma delas: outro
 * emoji numa foto não tira o 👍 nem o 👎 que está em outra.
 */
it("❤️ em outra foto do álbum não desfaz o 👍 nem o 👎; só a saída deles age", async () => {
  const { input } = await seed(); await album(); const created = await registerBet(input);
  const at = (minute: number) => `2026-09-13T01:0${minute}:00.000Z`;
  const react = (updateId: number, decision: "down" | "up" | "neutral", messageId: number, emojis?: string[]) =>
    handleChannelReaction(event(updateId, decision, { ...anonymous, messageId, occurredAt: at(updateId), ...(emojis ? { emojis } : {}) }));

  expect(await react(1, "up", 43)).toEqual({ kind: "taken", betId: created.betId });
  expect(await react(2, "neutral", 41, ["❤️"])).toEqual({ kind: "ignored", reason: "reacao_irrelevante" });
  expect((await get(created.betId)).takenAt).toEqual(new Date(at(1)));
  // Tirar o 👍 da foto em que ele estava desmarca.
  expect(await react(3, "neutral", 43)).toEqual({ kind: "untaken", betId: created.betId });

  expect(await react(4, "down", 42)).toEqual({ kind: "removed", betId: created.betId });
  expect(await react(5, "neutral", 41, ["❤️"])).toEqual({ kind: "ignored", reason: "reacao_irrelevante" });
  // 👍 noutra foto não vence o 👎 que continua no post.
  expect(await react(6, "up", 43)).toEqual({ kind: "ignored", reason: "reacao_irrelevante" });
  expect(await get(created.betId)).toMatchObject({ deletedAt: expect.any(Date), notTakenAt: expect.any(Date), takenAt: null });
  // Tirar o 👎 restaura, e o 👍 que ficou na outra foto marca como pega.
  expect(await react(7, "neutral", 42)).toEqual({ kind: "neutralized", betId: created.betId });
  expect(await get(created.betId)).toMatchObject({ deletedAt: null, notTakenAt: null, takenAt: new Date(at(7)) });
  expect(effects.removed).toHaveBeenCalledOnce();
});

/**
 * As fotos do álbum chegam em filas paralelas: a reação atrasada vale pela
 * ordem da própria foto, e a mais nova de outra foto não a descarta.
 */
it("reação atrasada numa foto do álbum vale pela ordem da própria foto", async () => {
  const { input } = await seed(); await album(); const created = await registerBet(input);
  const at = (minute: number) => `2026-09-13T01:0${minute}:00.000Z`;
  const react = (updateId: number, decision: "down" | "neutral", messageId: number, emojis?: string[]) =>
    handleChannelReaction(event(updateId, decision, { ...anonymous, messageId, occurredAt: at(updateId), ...(emojis ? { emojis } : {}) }));

  // O 👎 na foto 42 entregue depois do ❤️ mais novo na 41 remove.
  expect(await react(4, "neutral", 41, ["❤️"])).toEqual({ kind: "ignored", reason: "reacao_irrelevante" });
  expect(await react(3, "down", 42)).toEqual({ kind: "removed", betId: created.betId });

  // Tirar o 👎 da 42 entregue depois do ❤️ mais novo na 41 restaura.
  expect(await react(6, "neutral", 41, ["❤️"])).toEqual({ kind: "ignored", reason: "reacao_irrelevante" });
  expect(await react(5, "neutral", 42)).toEqual({ kind: "neutralized", betId: created.betId });
  // O 👎 antigo da mesma foto, entregue por último, não volta.
  expect(await react(2, "down", 42)).toEqual({ kind: "ignored", reason: "reacao_ja_tratada" });
  expect(await get(created.betId)).toMatchObject({ status: "PENDING", deletedAt: null, notTakenAt: null });
  expect(effects.removed).toHaveBeenCalledOnce(); expect(effects.restored).toHaveBeenCalledOnce();
});

it("👍 que chega antes da aposta fica guardado, e a aposta nasce pega", async () => {
  const { input } = await seed();
  expect(await handleChannelReaction(event(1, "up", anonymous))).toEqual({ kind: "remembered" });
  const created = await registerBet(input);
  expect(await get(created.betId)).toMatchObject({ status: "PENDING", deletedAt: null, takenAt: new Date("2026-09-13T01:00:00.000Z") });
});

it("👍 não marca aposta removida pelo painel, e tirar o 👍 limpa a marca que ela tinha", async () => {
  const { input, bankroll } = await seed(); const created = await registerBet(input);
  await removeFromPanel(bankroll.id, created.betId);
  expect(await handleChannelReaction(event(1, "up", anonymous))).toEqual({ kind: "ignored", reason: "reacao_irrelevante" });
  expect((await get(created.betId)).takenAt).toBeNull();

  await restoreBetsInBatch({ bankrollId: bankroll.id, betIds: [created.betId], actor: "fabricio" });
  await handleChannelReaction(event(2, "neutral", anonymous));
  expect(await handleChannelReaction(event(3, "up", anonymous))).toEqual({ kind: "taken", betId: created.betId });
  await removeFromPanel(bankroll.id, created.betId);
  expect(await handleChannelReaction(event(4, "neutral", anonymous))).toEqual({ kind: "untaken", betId: created.betId });
  // O "Restaurar" do painel não traz de volta uma marca que o post já não tem.
  await restoreBetsInBatch({ bankrollId: bankroll.id, betIds: [created.betId], actor: "fabricio" });
  expect(await get(created.betId)).toMatchObject({ deletedAt: null, takenAt: null });
});

it("👍 com 👎 vale como 👎; tirar o 👎 com o 👍 no post restaura a aposta já pega", async () => {
  const { input } = await seed(); const created = await registerBet(input);
  expect(await handleChannelReaction(event(1, "down", { ...anonymous, emojis: ["👍", "👎"] }))).toEqual({ kind: "removed", betId: created.betId });
  expect(await get(created.betId)).toMatchObject({ deletedAt: expect.any(Date), takenAt: null });
  expect(await handleChannelReaction(event(2, "up", anonymous))).toEqual({ kind: "neutralized", betId: created.betId });
  expect(await get(created.betId)).toMatchObject({ status: "PENDING", deletedAt: null, notTakenAt: null, takenAt: expect.any(Date) });
  // Pôr o 👎 de novo remove; tirá-lo junto com o 👍 volta sem a marca.
  await handleChannelReaction(event(3, "down", { ...anonymous, emojis: ["👍", "👎"] }));
  await handleChannelReaction(event(4, "neutral", anonymous));
  expect(await get(created.betId)).toMatchObject({ deletedAt: null, takenAt: null });
});

it("trocar o 👍 pelo 👎 remove e tira a marca: o Restaurar do painel não a traz de volta", async () => {
  const { input, bankroll } = await seed(); const created = await registerBet(input);
  expect(await handleChannelReaction(event(1, "up", anonymous))).toEqual({ kind: "taken", betId: created.betId });
  expect((await get(created.betId)).takenAt).toEqual(new Date("2026-09-13T01:00:00.000Z"));
  // Sem Premium a reação é uma só: o 👎 substitui o 👍 e a contagem chega só com ele.
  expect(await handleChannelReaction(event(2, "down", { ...anonymous, occurredAt: "2026-09-13T01:03:00.000Z" })))
    .toEqual({ kind: "removed", betId: created.betId });
  expect(await get(created.betId)).toMatchObject({ deletedAt: expect.any(Date), notTakenAt: expect.any(Date), takenAt: null });
  const trilha = (await getTrilhaDaAposta(created.betId)).linhas.filter((linha) => linha.chave === "peguei_desfeito");
  expect(trilha.map((linha) => linha.frase.map((trecho) => trecho.texto).join("")))
    .toEqual(["Desfeita a marca de pega de 12/09 22:00 — 👎 no post do canal."]);

  await restoreBetsInBatch({ bankrollId: bankroll.id, betIds: [created.betId], actor: "fabricio" });
  expect(await get(created.betId)).toMatchObject({ status: "PENDING", deletedAt: null, notTakenAt: null, takenAt: null });
  // Voltar ao 👍 depois marca de novo, com a hora da nova reação.
  expect(await handleChannelReaction(event(3, "up", { ...anonymous, occurredAt: "2026-09-13T01:05:00.000Z" })))
    .toEqual({ kind: "taken", betId: created.betId });
  expect((await get(created.betId)).takenAt).toEqual(new Date("2026-09-13T01:05:00.000Z"));
});

it("rollback da captura não marca decisão como aplicada nem deixa exclusão parcial", async () => {
  const { input } = await seed(); await handleChannelReaction(event(1));
  await expect(runSerializableTransaction("test-rollback", async tx => {
    await registerBet(input, { client: reuseSerializableTransaction(tx) }); throw new Error("rollback sintético");
  })).rejects.toThrow("rollback sintético");
  expect(await db.prisma.bet.count()).toBe(0);
  expect(await db.prisma.telegramReactionState.findFirst()).toMatchObject({ handledAt: null });
  expect(effects.removed).not.toHaveBeenCalled();
  expect(await registerBet(input)).toMatchObject({ notTaken: true });
});

it("banco rejeita eventos parciais e exclusão da banca limpa memória", async () => {
  const { bankroll } = await seed();
  await expect(db.prisma.telegramReactionState.create({ data: { chatId, messageId: 42, targetMessageId: 42, bankrollId: bankroll.id, decision: "NOT_TAKEN" } })).rejects.toThrow();
  await handleChannelReaction(event(1));
  await db.prisma.bankroll.delete({ where: { id: bankroll.id } });
  expect(await db.prisma.telegramReactionState.count()).toBe(0);
});

it.each(["outra foto", "mesma foto"])("👍 antes da captura conserva seu instante após ❤️ na %s", async (where) => {
  const { input } = await seed(); await album();
  const takenAt = "2026-09-13T01:00:00.000Z";
  await handleChannelReaction(event(1, "up", { messageId: 43, occurredAt: takenAt }));
  await handleChannelReaction(event(2, where === "mesma foto" ? "up" : "neutral", {
    messageId: where === "mesma foto" ? 43 : 41,
    occurredAt: "2026-09-13T01:05:00.000Z", emojis: where === "mesma foto" ? ["👍", "❤️"] : ["❤️"],
  }));
  const created = await registerBet(input);
  expect((await get(created.betId)).takenAt).toEqual(new Date(takenAt));
});

it("👍 tirado e reposto antes da captura usa o instante novo", async () => {
  const { input } = await seed();
  await handleChannelReaction(event(1, "up"));
  await handleChannelReaction(event(2, "neutral", { occurredAt: "2026-09-13T01:01:00.000Z" }));
  await handleChannelReaction(event(3, "up", { occurredAt: "2026-09-13T01:02:00.000Z" }));
  await handleChannelReaction(event(4, "up", { occurredAt: "2026-09-13T01:03:00.000Z", emojis: ["👍", "❤️"] }));
  const created = await registerBet(input);
  expect((await get(created.betId)).takenAt).toEqual(new Date("2026-09-13T01:02:00.000Z"));
});

it("duas fotos com 👍 antes da captura usam o primeiro instante ainda ativo", async () => {
  const { input } = await seed(); await album();
  await handleChannelReaction(event(1, "up", { messageId: 43 }));
  await handleChannelReaction(event(2, "up", { messageId: 41, occurredAt: "2026-09-13T01:05:00.000Z" }));
  const created = await registerBet(input);
  expect((await get(created.betId)).takenAt).toEqual(new Date("2026-09-13T01:00:00.000Z"));
});
