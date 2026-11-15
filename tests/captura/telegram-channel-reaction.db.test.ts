import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { CHANNEL_ID, POST_DATE, POST_TEXT, editedPost, post, seedChannelBankroll } from "../helpers/telegram-channel";

/**
 * Reações no post de canal ponta a ponta contra Postgres real.
 * A cascata LLM fica mockada: posts incompletos caem em unparseable sem bater
 * na API.
 */
const geminiMocks = vi.hoisted(() => ({
  extractBetFromText: vi.fn(),
  extractBetFromImage: vi.fn(),
}));
vi.mock(import("@/src/services/capture/reading/extract-bet"), () => geminiMocks);
const telegramApi = vi.hoisted(() => ({ sent: [] as Array<{ chatId: unknown; text: string }> }));
vi.mock("grammy", async (original) => ({
  ...await original<typeof import("grammy")>(),
  Api: class {
    async sendMessage(chatId: unknown, text: string) {
      telegramApi.sent.push({ chatId, text });
      return { message_id: 5000 + telegramApi.sent.length };
    }
  },
}));
/** Fila sintética: o id repetido não entra de novo, e `findJobs` acha o pedido ainda na fila pela chave do post. */
const queue = vi.hoisted(() => ({ jobs: [] as Array<{ id: string; name: string; data: unknown; singletonKey?: string }> }));
vi.mock("@/src/infra/boss", () => ({
  getSharedBoss: async () => ({
    send: async (name: string, data: unknown, options?: { id?: string; singletonKey?: string }) => {
      const id = options?.id ?? `job-${queue.jobs.length + 1}`;
      if (queue.jobs.some((job) => job.name === name && job.id === id)) return null;
      queue.jobs.push({ id, name, data, singletonKey: options?.singletonKey });
      return id;
    },
    findJobs: async (name: string, options: { key?: string; data?: Record<string, unknown> }) =>
      queue.jobs.filter((job) => job.name === name && job.singletonKey === options.key
        && Object.entries(options.data ?? {}).every(([field, value]) => (job.data as Record<string, unknown>)[field] === value)),
  }),
}));

import { handleChannelReaction } from "../helpers/telegram-reaction";
import { handleChannelPhotoPost, handleChannelPost } from "@/src/services/capture/channel/capture-new";
import { handleEditedChannelPost } from "@/src/services/capture/channel/capture-edit";
import { emojisFromReactionCounts, thumbsDownPresentInReactionCounts } from "@/src/services/capture/channel/reactions";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { toNumber } from "@/src/domain/money";
import { applyManualBetStatusChange } from "../helpers/settle";
import { findBankrollByChannel } from "@/src/services/bankrolls/lookup";
import { recordDiscardedChannelPost } from "@/src/services/capture/channel/channel-post-archive";
import { registerParsedPost } from "@/src/services/capture/channel/register-post";

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  queue.jobs = [];
  telegramApi.sent = [];
  geminiMocks.extractBetFromText.mockReset();
  geminiMocks.extractBetFromImage.mockReset();
  geminiMocks.extractBetFromText.mockResolvedValue({
    bet: null,
    provider: "gemini",
    notBet: true,
  });
  geminiMocks.extractBetFromImage.mockResolvedValue({
    bet: null,
    provider: "gemini",
    notBet: true,
  });
});

describe("handleChannelReaction", () => {
  beforeEach(() => { vi.stubEnv("TELEGRAM_ALLOWED_CHATS", "123"); vi.stubEnv("TELEGRAM_TOKEN", "token-sintetico"); vi.stubEnv("TELEGRAM_WEBHOOK_URL", "https://exemplo.invalid/api/telegram"); vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "s".repeat(32)); resetEnvCacheForTests(); });
  afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });
  it("captura de texto respeita 👎 recebido enquanto o post ainda não estava registrado", async () => {
    await seedChannelBankroll(db);
    expect(await handleChannelReaction({ chatId: CHANNEL_ID, actorUserId: "123", messageId: 555, emojis: ["👎"] })).toEqual({ kind: "remembered" });
    const result = await handleChannelPost(post(POST_TEXT));
    expect(result).toMatchObject({ kind: "registered", notTaken: true });
    if (result.kind !== "registered") throw new Error("captura falhou");
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    expect(bet).toMatchObject({ status: "CANCELED", notTakenAt: expect.any(Date) });
  });
  it.each(["foto", "lote"] as const)("👎 recebido antes da aposta vale também na captura de %s", async (caminho) => {
    await seedChannelBankroll(db);
    expect(await handleChannelReaction({ chatId: CHANNEL_ID, actorUserId: "123", messageId: 556, emojis: ["👎"] })).toEqual({ kind: "remembered" });
    const read = (evento: string) => ({
      evento, esporte: "Soccer", competicao: "", pais: "", mercado: "Ambas Marcam", selecao: "Sim",
      odds: 1.85, stake: 1, data: new Date("2026-06-15T22:00:00Z"), casaDeAposta: "", stakeSource: "caption" as const,
    });
    const bets = caminho === "foto" ? [read("Flamengo vs Palmeiras")] : [read("Flamengo vs Palmeiras"), read("Santos vs Corinthians")];
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
    const outcome = caminho === "foto"
      ? await handleChannelPhotoPost(
        { chatId: CHANNEL_ID, messageId: 556, caption: "Flamengo x Palmeiras 1u", postDate: POST_DATE, mediaFileId: "foto-556" },
        { loadImage: async () => ({ base64: "aW1hZ2U=", mimeType: "image/jpeg" }) },
      )
      : await handleChannelPost(post("Ambas marcam nos dois jogos @1.85 1u cada", 556));
    expect(outcome).toMatchObject({ kind: "registered", notTaken: true });
    expect(await db.prisma.bet.findMany({ select: { status: true, notTakenAt: true } }))
      .toEqual(bets.map(() => ({ status: "CANCELED", notTakenAt: expect.any(Date) })));
  });
  it("👎 remove com reversão de ledger e edit posterior não ressuscita", async () => {
    const bankroll = await seedChannelBankroll(db);
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Betano",
        titular: "F",
        saldoInicial: 1000,
        saldoAtual: 1000,
        bankrollLinks: { create: { bankrollId: bankroll.id } },
      },
    });
    const created = await handleChannelPost(post(POST_TEXT));
    if (created.kind !== "registered") throw new Error("setup falhou");

    // Dá um green primeiro para haver ledger a reverter.
    await applyManualBetStatusChange({ betId: created.betId, newStatus: "WON", source: "manual:teste" });

    const reaction = await handleChannelReaction({
      chatId: CHANNEL_ID, actorUserId: "123",
      messageId: 555,
      emojis: ["👎"],
    });
    expect(reaction.kind).toBe("removed");

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: created.betId } });
    expect(bet.deletedAt).not.toBeNull();
    expect(bet.notTakenAt).not.toBeNull();

    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(contaDb.saldoAtual)).toBe(1000); // ledger zerado

    const afterEdit = await handleEditedChannelPost(editedPost(`${POST_TEXT}\n✅`));
    expect(afterEdit).toEqual({ kind: "ignored", reason: "post_ja_capturado" });
  });

  it("👎 anônimo do canal (contagem agregada) é do dono: remove com reversão de ledger", async () => {
    const bankroll = await seedChannelBankroll(db);
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Betano",
        titular: "F",
        saldoInicial: 1000,
        saldoAtual: 1000,
        bankrollLinks: { create: { bankrollId: bankroll.id } },
      },
    });
    const created = await handleChannelPost(post(POST_TEXT));
    if (created.kind !== "registered") throw new Error("setup falhou");
    await applyManualBetStatusChange({ betId: created.betId, newStatus: "WON", source: "manual:teste" });

    // Canal manda CONTAGEM (sem usuário), não message_reaction: 👎 com total 1.
    const counts = [{ type: { type: "emoji", emoji: "👎" }, total_count: 1 }];
    const r = await handleChannelReaction({
      chatId: CHANNEL_ID, messageId: 555, emojis: emojisFromReactionCounts(counts), thumbsDownPresent: thumbsDownPresentInReactionCounts(counts),
    });
    expect(r).toEqual({ kind: "removed", betId: created.betId });

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: created.betId } });
    expect(bet.notTakenAt).not.toBeNull();
    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(contaDb.saldoAtual)).toBe(1000);
    expect(await db.prisma.operationalAction.count({ where: { title: "Reação requer confirmação no painel" } })).toBe(0);
  });

  it("👎 em aposta liquidada há mais de 7 dias NÃO remove", async () => {
    await seedChannelBankroll(db);
    const created = await handleChannelPost(post(POST_TEXT));
    if (created.kind !== "registered") throw new Error("setup falhou");
    await applyManualBetStatusChange({ betId: created.betId, newStatus: "WON", source: "manual:teste" });
    // Liquidação consolidada há 10 dias: reação anônima não pode reverter.
    const takenAt = new Date(Date.now() - 11 * 86_400_000);
    await db.prisma.bet.update({
      where: { id: created.betId },
      data: { settledAt: new Date(Date.now() - 10 * 86_400_000), takenAt },
    });

    const r = await handleChannelReaction({ chatId: CHANNEL_ID, actorUserId: "123", messageId: 555, emojis: ["👎"] });
    expect(r).toEqual({ kind: "ignored", reason: "aposta_liquidada_requer_painel" });

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: created.betId } });
    expect(bet.deletedAt).toBeNull();
    expect(bet.status).toBe("WON");
    // A aposta ficou na banca: a marca de pega fica com ela.
    expect(bet.takenAt).toEqual(takenAt);
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.taken_undone", resourceId: created.betId } })).toBe(0);
  });

  it("emojisFromReactionCounts: todo emoji presente na contagem, como o 👎; ignora zerado e custom", () => {
    expect(
      emojisFromReactionCounts([
        { type: { type: "emoji", emoji: "👍" }, total_count: 0 },
        { type: { type: "emoji", emoji: "👎" }, total_count: 1 },
        { type: { type: "emoji", emoji: "🔥" }, total_count: 2 },
        { type: { type: "custom_emoji" }, total_count: 5 },
      ]),
    ).toEqual(["👎", "🔥"]);
    expect(
      thumbsDownPresentInReactionCounts([
        { type: { type: "emoji", emoji: "👎" }, total_count: 2 },
        { type: { type: "emoji", emoji: "🔥" }, total_count: 1 },
      ]),
    ).toBe(true);
  });

  it("remover 👎 restaura a aposta e volta a contá-la como pega", async () => {
    await seedChannelBankroll(db);
    const created = await handleChannelPost(post(POST_TEXT));
    if (created.kind !== "registered") throw new Error("setup falhou");

    await handleChannelReaction({
      chatId: CHANNEL_ID, actorUserId: "123",
      messageId: 555,
      emojis: ["👎"],
      thumbsDownPresent: true,
    });
    const neutralized = await handleChannelReaction({
      chatId: CHANNEL_ID, actorUserId: "123",
      messageId: 555,
      emojis: [],
      thumbsDownPresent: false,
    });
    expect(neutralized).toEqual({ kind: "neutralized", betId: created.betId });

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: created.betId } });
    expect(bet.deletedAt).toBeNull();
    expect(bet.notTakenAt).toBeNull();
    expect(bet.status).toBe("PENDING");
    expect(
      await db.prisma.auditEvent.count({
        where: { resourceId: created.betId, action: "bet.not_taken_undone" },
      }),
    ).toBe(1);
  });

  it("👍 em post com aposta marca a entrada como pega, sem pedir captura, avisar ou abrir ação", async () => {
    await seedChannelBankroll(db);
    const created = await handleChannelPost(post(POST_TEXT));
    if (created.kind !== "registered") throw new Error("setup falhou");
    telegramApi.sent = [];

    // Contagem anônima do canal, como chega de verdade: o 👍 do dono.
    const counts = [{ type: { type: "emoji", emoji: "👍" }, total_count: 1 }];
    const up = { chatId: CHANNEL_ID, messageId: 555, emojis: emojisFromReactionCounts(counts), thumbsDownPresent: thumbsDownPresentInReactionCounts(counts) };
    expect(await handleChannelReaction(up)).toEqual({ kind: "taken", betId: created.betId });
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: created.betId } });
    expect(bet).toMatchObject({ status: "PENDING", deletedAt: null, notTakenAt: null, takenAt: expect.any(Date) });
    expect(toNumber(bet.stake)).toBe(1);
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.taken", resourceId: created.betId } })).toBe(1);
    expect(queue.jobs).toHaveLength(0);
    expect(telegramApi.sent).toHaveLength(0);
    expect(await db.prisma.operationalAction.count()).toBe(0);

    // A contagem do 👍 subir para 2 não tira a marca.
    const twice = [{ type: { type: "emoji", emoji: "👍" }, total_count: 2 }];
    expect(await handleChannelReaction({ ...up, emojis: emojisFromReactionCounts(twice), thumbsDownPresent: thumbsDownPresentInReactionCounts(twice) }))
      .toEqual({ kind: "ignored", reason: "reacao_irrelevante" });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: created.betId } })).takenAt).toEqual(bet.takenAt);

    // Tirar o 👍 desmarca.
    expect(await handleChannelReaction({ ...up, emojis: [] })).toEqual({ kind: "untaken", betId: created.betId });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: created.betId } })).takenAt).toBeNull();
  });

  it("👍 em post guardado sem aposta pede a captura forçada uma vez só", async () => {
    await seedChannelBankroll(db);
    expect(await handleChannelPost(post("Flamengo x Palmeiras\nAmbas marcam", 820))).toEqual({ kind: "skipped", reason: "nao_parece_aposta" });

    const up = { chatId: CHANNEL_ID, messageId: 820, emojis: ["👍"], thumbsDownPresent: false };
    expect(await handleChannelReaction(up)).toEqual({ kind: "capture_requested", messageId: 820, result: "enfileirado" });
    expect(queue.jobs).toEqual([expect.objectContaining({
      name: "telegram.updates",
      data: expect.objectContaining({ kind: "channel_post", messageId: 820, text: "Flamengo x Palmeiras\nAmbas marcam", forcedByOperator: true }),
    })]);
    // Cada mudança na contagem de reações repete o 👍: não pede de novo.
    expect(await handleChannelReaction({ ...up, emojis: ["👍", "🔥"] })).toEqual({ kind: "ignored", reason: "ja_respondido" });
    // Tirar o 👍 e pôr de novo é outro pedido, e a captura já pedida não entra duas vezes.
    await handleChannelReaction({ ...up, emojis: ["🔥"] });
    expect(await handleChannelReaction(up)).toEqual({ kind: "capture_requested", messageId: 820, result: "ja_pedido" });
    expect(queue.jobs).toHaveLength(1);
    expect(await db.prisma.auditEvent.count({ where: { action: "channel.capture_discarded", actor: "telegram-user:123" } })).toBe(1);
  });

  it("👍 em post recusado pelo guard reabre o conserto pela DM em vez de reler", async () => {
    await seedChannelBankroll(db);
    const bankroll = await findBankrollByChannel(CHANNEL_ID);
    if (!bankroll) throw new Error("setup falhou");
    const bet = {
      evento: "Flamengo vs Palmeiras", esporte: "Soccer", competicao: "", pais: "", mercado: "Asian Handicap",
      selecao: "-0.5", odds: 1.9, stake: 1, data: new Date(Date.now() + 48 * 3_600_000), casaDeAposta: "",
    };
    const refusedPost = { chatId: CHANNEL_ID, messageId: 821, postDate: new Date() };
    expect(await registerParsedPost(bankroll, refusedPost, bet, "gemini", "Flamengo -0.5 @1.90 1u")).toMatchObject({ kind: "unparseable" });
    expect(telegramApi.sent).toHaveLength(1);
    // Pergunta ainda aberta: o 👍 não manda outra nem relê o post.
    const up = { chatId: CHANNEL_ID, messageId: 821, emojis: ["👍"], thumbsDownPresent: false };
    expect(await handleChannelReaction(up)).toEqual({ kind: "fix_offered", messageId: 821, offer: "ja_perguntado" });
    // "Deixar para lá": com o 👍 ainda no post, a mudança da contagem não traz a pergunta de volta.
    await db.prisma.telegramDmDraft.deleteMany();
    expect(await handleChannelReaction({ ...up, emojis: ["👍", "🔥"] })).toEqual({ kind: "ignored", reason: "ja_respondido" });
    expect(telegramApi.sent).toHaveLength(1);
    // O 👍 tirado e posto de novo é um pedido novo.
    await handleChannelReaction({ ...up, emojis: ["🔥"] });
    expect(await handleChannelReaction(up)).toEqual({ kind: "fix_offered", messageId: 821, offer: "perguntado" });
    expect(telegramApi.sent).toHaveLength(2);
    expect(queue.jobs).toHaveLength(0);
  });

  it("👍 em rascunho sem stake pede a captura, e ela pergunta a stake na DM", async () => {
    await seedChannelBankroll(db);
    const draft = POST_TEXT.replace("Data: 15/06 16:00\n", "").replace("\nStake: 1u", "");
    const recent = { ...post(draft, 840), postDate: new Date() };
    expect(await handleChannelPost(recent)).toEqual({ kind: "unparseable", missing: ["stake"] });
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();

    expect(await handleChannelReaction({ chatId: CHANNEL_ID, messageId: 840, emojis: ["👍"], thumbsDownPresent: false }))
      .toEqual({ kind: "capture_requested", messageId: 840, result: "enfileirado" });
    expect(queue.jobs).toEqual([expect.objectContaining({ data: expect.objectContaining({ kind: "channel_post", messageId: 840, forcedByReaction: true }) })]);

    expect(await handleChannelPost(recent, { forcedByOperator: true, forcedByReaction: true })).toEqual({ kind: "unparseable", missing: ["stake"] });
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();
    expect(telegramApi.sent).toEqual([{ chatId: "123", text: expect.stringMatching(/Coquimbo Unido vs Colo Colo[\s\S]*stake em unidades/) }]);
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("captura pedida pelo 👍 fica fora da latência do post, como a do painel", async () => {
    await seedChannelBankroll(db);
    await db.prisma.bankroll.updateMany({ data: { capturePausedAt: new Date() } });
    expect(await handleChannelPost(post(POST_TEXT, 841))).toEqual({ kind: "skipped", reason: "canal_pausado" });
    const captured = await handleChannelPost(post(POST_TEXT, 841), { forcedByOperator: true, forcedByReaction: true });
    if (captured.kind !== "registered") throw new Error("captura falhou");
    const evidence = await db.prisma.betCaptureEvidence.findUniqueOrThrow({ where: { betId: captured.betId } });
    expect(evidence.parsedJson).toMatchObject({ forcedByOperator: true });
  });

  it("👍 em post recusado cujo jogo já começou avisa que o prazo do conserto passou", async () => {
    vi.stubEnv("TELEGRAM_NOTIFICATION_BOT_TOKEN", "token-notificacao");
    vi.stubEnv("TELEGRAM_NOTIFICATION_CHAT_ID", "123");
    resetEnvCacheForTests();
    const notices: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      notices.push((JSON.parse(init.body) as { text: string }).text);
      return new Response("{}", { status: 200 });
    }));
    try {
      await seedChannelBankroll(db);
      const bankroll = await findBankrollByChannel(CHANNEL_ID);
      if (!bankroll) throw new Error("setup falhou");
      const bet = {
        evento: "Flamengo vs Palmeiras", esporte: "Soccer", competicao: "", pais: "", mercado: "Asian Handicap",
        selecao: "-0.5", odds: 1.9, stake: 1, data: new Date(Date.now() - 3_600_000), kickoffDateOnly: false, casaDeAposta: "",
      };
      const refusedPost = { chatId: CHANNEL_ID, messageId: 828, postDate: new Date(Date.now() - 2 * 3_600_000) };
      expect(await registerParsedPost(bankroll, refusedPost, bet, "gemini", "Flamengo -0.5 @1.90 1u")).toMatchObject({ kind: "unparseable" });
      notices.length = 0;

      expect(await handleChannelReaction({ chatId: CHANNEL_ID, messageId: 828, emojis: ["👍"], thumbsDownPresent: false }))
        .toEqual({ kind: "fix_offered", messageId: 828, offer: "jogo_comecou" });
      expect(notices).toEqual([expect.stringMatching(/👍 ao post 828.*o prazo do conserto pela DM já passou/s)]);
      expect(telegramApi.sent).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["todos os provedores recusaram", { bet: null, provider: null, refused: { reason: "leitura_recusada_pela_ia", provider: null } }, "leitura_recusada_pela_ia"],
    ["a leitura ficou em dúvida sem opções", {
      bet: null, provider: "gemini", incompleteDraft: true, missing: ["ambiguous_bet"],
      review: { reason: "ambiguous_bet", description: "Não diz o mercado.", evidence: {} },
    }, "ambiguous_bet"],
  ])("👍 em post que a IA recusou (%s) não relê nem pergunta: não há o que consertar", async (_caso, extracted, reason) => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromText.mockResolvedValue(extracted);
    expect(await handleChannelPost(post("🎾 Sinner vs Fritz\nEntrada: +22.5\n@1.90\n1u", 827))).toEqual({ kind: "unparseable", missing: [reason] });
    expect(telegramApi.sent).toHaveLength(0);

    expect(await handleChannelReaction({ chatId: CHANNEL_ID, messageId: 827, emojis: ["👍"], thumbsDownPresent: false }))
      .toEqual({ kind: "ignored", reason: "recusa_sem_conserto" });
    expect(geminiMocks.extractBetFromText).toHaveBeenCalledTimes(1);
    expect(queue.jobs).toHaveLength(0);
    expect(telegramApi.sent).toHaveLength(0);
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("👍 em lote recusado avisa que o conserto pela DM não cobre o post, sem perguntar nem reler", async () => {
    vi.stubEnv("TELEGRAM_NOTIFICATION_BOT_TOKEN", "token-notificacao");
    vi.stubEnv("TELEGRAM_NOTIFICATION_CHAT_ID", "123");
    resetEnvCacheForTests();
    const notices: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      notices.push((JSON.parse(init.body) as { text: string }).text);
      return new Response("{}", { status: 200 });
    }));
    try {
      await seedChannelBankroll(db);
      const read = (evento: string, odds: number) => ({
        evento, esporte: "Soccer", competicao: "", pais: "", mercado: "Ambas Marcam", selecao: "Sim",
        odds, stake: 1, data: new Date("2026-06-15T22:00:00Z"), casaDeAposta: "", stakeSource: "caption" as const,
      });
      const bets = [read("Flamengo vs Palmeiras", 1.85), read("Santos vs Corinthians", 185)];
      geminiMocks.extractBetFromText.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
      expect(await handleChannelPost(post("Ambas marcam nos dois jogos @1.85 1u cada", 829))).toEqual({ kind: "unparseable", missing: ["odds"] });
      notices.length = 0;

      expect(await handleChannelReaction({ chatId: CHANNEL_ID, messageId: 829, emojis: ["👍"], thumbsDownPresent: false }))
        .toEqual({ kind: "ignored", reason: "recusa_sem_conserto" });
      expect(notices).toEqual([expect.stringMatching(/👍 ao post 829.*registre à mão/s)]);
      expect(geminiMocks.extractBetFromText).toHaveBeenCalledTimes(1);
      expect(telegramApi.sent).toHaveLength(0);
      expect(queue.jobs).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("post guardado de novo sem a leitura não oferece mais o conserto da leitura anterior", async () => {
    const bankroll = await seedChannelBankroll(db);
    const bet = {
      evento: "Flamengo vs Palmeiras", esporte: "Soccer", competicao: "", pais: "", mercado: "Asian Handicap",
      selecao: "-0.5", odds: 1.9, stake: 1, data: new Date(Date.now() + 48 * 3_600_000), casaDeAposta: "",
    };
    const archive = (refusal?: { reason: string; via: string; bet: typeof bet }) => recordDiscardedChannelPost({
      chatId: CHANNEL_ID, messageId: 831, bankrollId: bankroll.id, text: "Flamengo -0.5 @1.90 1u", postDate: new Date(),
      reason: "captura_recusada", ...(refusal ? { refusal } : {}),
    });
    await archive({ reason: "lado_handicap_ausente", via: "gemini", bet });
    await archive();
    expect(await handleChannelReaction({ chatId: CHANNEL_ID, messageId: 831, emojis: ["👍"], thumbsDownPresent: false }))
      .toEqual({ kind: "ignored", reason: "recusa_sem_conserto" });
    expect(telegramApi.sent).toHaveLength(0);
  });

  it("👍 nunca força recapitulação, jogo encerrado nem o que a IA já leu", async () => {
    await seedChannelBankroll(db);
    const finished = POST_TEXT.replace("Data: 15/06 16:00", "Data: 09/06 16:00");
    expect(await handleChannelPost(post(finished, 823))).toEqual({ kind: "skipped", reason: "jogo_ja_terminado" });
    expect(await handleChannelPost(post(["Resultado do dia", ...POST_TEXT.split("\n"), "✅ GREEN"].join("\n"), 824)))
      .toEqual({ kind: "skipped", reason: "resultado_ou_balanco" });
    expect((await handleChannelPost(post("Sinner vs Alcaraz\nSinner vence 1.95\n1u", 825))).kind).toBe("unparseable");
    const up = (messageId: number) => handleChannelReaction({ chatId: CHANNEL_ID, messageId, emojis: ["👍"], thumbsDownPresent: false });
    expect(await up(823)).toEqual({ kind: "ignored", reason: "jogo_encerrado" });
    expect(await up(824)).toEqual({ kind: "ignored", reason: "jogo_encerrado" });
    expect(await up(825)).toEqual({ kind: "ignored", reason: "ia_ja_leu" });
    expect(queue.jobs).toHaveLength(0);
  });

  it("👍 em foto guardada sem file_id não quebra o job da reação", async () => {
    const bankroll = await seedChannelBankroll(db);
    await recordDiscardedChannelPost({
      chatId: CHANNEL_ID, messageId: 826, bankrollId: bankroll.id, text: "Over 2.5 1u", postDate: new Date(),
      reason: "canal_pausado", photo: { mediaFileId: null },
    });
    expect(await handleChannelReaction({ chatId: CHANNEL_ID, messageId: 826, emojis: ["👍"], thumbsDownPresent: false }))
      .toEqual({ kind: "ignored", reason: "foto_sem_arquivo" });
    expect(queue.jobs).toHaveLength(0);
  });

  it("👍 em post que nunca foi guardado não pede nada", async () => {
    await seedChannelBankroll(db);
    expect(await handleChannelReaction({ chatId: CHANNEL_ID, messageId: 822, emojis: ["👍"], thumbsDownPresent: false }))
      .toEqual({ kind: "remembered" });
    expect(queue.jobs).toHaveLength(0);
  });

  it("👍 junto com 👎 vale como 👎", async () => {
    await seedChannelBankroll(db);
    const created = await handleChannelPost(post(POST_TEXT));
    if (created.kind !== "registered") throw new Error("setup falhou");

    const both = await handleChannelReaction({
      chatId: CHANNEL_ID, actorUserId: "123",
      messageId: 555,
      emojis: ["👍", "👎"],
      thumbsDownPresent: true,
    });
    expect(both).toEqual({ kind: "removed", betId: created.betId });
  });
});
