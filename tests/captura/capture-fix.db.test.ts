import { createBoss } from "@/src/infra/boss";
import { ensureQueueWithDeadLetter } from "@/src/jobs/queues";
import { WORKER_JOBS } from "@/src/jobs/worker-jobs";
import { QUEUES } from "@/src/infra/queue-contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { captureParsedSchema, type ParsedBetPost } from "@/src/domain/bet-capture";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { answerCaptureFix, applyFixAnswer, offerCaptureFix, type CaptureFixState, type SendOwnerMessage } from "@/src/services/capture/capture-fix";
import { CAPTURE_FOLLOWUP_ACTION, dispatchPendingCaptureFollowups } from "@/src/services/scheduling/enqueue-after-capture";
import { registerCapturedBet } from "@/src/services/capture/register-captured-bet";
import { completeMediaAlbum, stageMediaAlbumPhoto } from "@/src/services/capture/channel/media-album";
import type { Bot } from "grammy";
import { registerCaptureFixHandlers } from "@/src/telegram/capture-fix";
import { createTestDb, type TestDb } from "../helpers/db";
import { CHANNEL_ID, seedChannelBankroll } from "../helpers/telegram-channel";
import { handleChannelReaction } from "../helpers/telegram-reaction";
import { handleChannelPost } from "@/src/services/capture/channel/capture-new";

/**
 * Conserto pela DM de uma captura recusada, contra Postgres real: a pergunta
 * fica presa à mensagem do bot, e a resposta grava pelo guard e pelo registro
 * da captura. O envio ao Telegram é sintético.
 */

/** O registro real, que o teste pode fazer falhar uma vez (queda do banco no meio da gravação). */
vi.mock(import("@/src/services/capture/register-captured-bet"), async (original) => {
  const real = await original();
  return { ...real, registerCapturedBet: vi.fn(real.registerCapturedBet) };
});
/** O caso de uso real, que o teste da borda faz falhar antes de carregar a pergunta. */
vi.mock(import("@/src/services/capture/capture-fix"), async (original) => {
  const real = await original();
  return { ...real, answerCaptureFix: vi.fn(real.answerCaptureFix) };
});

/** O banco que não atende: falha passageira, que responder de novo resolve. */
const databaseDown = () => Object.assign(new Error("Can't reach database server at `db:5432`"), { name: "PrismaClientInitializationError" });

let db: TestDb;
let realBoss: PgBoss;
beforeAll(async () => {
  db = createTestDb();
  realBoss = createBoss();
  await realBoss.start();
  for (const queue of [QUEUES.sharpEnrich, QUEUES.sportResolve]) {
    await ensureQueueWithDeadLetter(realBoss, queue, WORKER_JOBS.find((job) => job.queue === queue)?.queueOptions);
  }
  vi.mocked(boss.send).mockImplementation(realBoss.send.bind(realBoss));
});
afterAll(async () => { await realBoss.stop({ graceful: false }); await db.dispose(); });

const OWNER = "123";
const HOUR = 3_600_000;
let sent: Array<{ chatId: string; text: string; markup: unknown }>;
const send: SendOwnerMessage = async (chatId, prompt) => {
  sent.push({ chatId, text: prompt.text, markup: prompt.reply_markup });
  return 1000 + sent.length;
};
const boss = { send: vi.fn<PgBoss["send"]>() } as unknown as PgBoss;

beforeEach(async () => {
  await db.reset();
  await db.prisma.$executeRaw`DELETE FROM pgboss.job WHERE name IN (${QUEUES.sharpEnrich}, ${QUEUES.sportResolve})`;
  sent = [];
  vi.stubEnv("TELEGRAM_ALLOWED_CHATS", OWNER);
  resetEnvCacheForTests();
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });

function handicapWithoutSide(kickoff: Date): ParsedBetPost {
  return {
    evento: "Flamengo vs Palmeiras", esporte: "Soccer", competicao: "Brasileirão", pais: "Brasil",
    mercado: "Asian Handicap", selecao: "-0.5", odds: 1.9, stake: 1, data: kickoff, casaDeAposta: "Betano",
  };
}

async function offer(bet: ParsedBetPost, reason: string, postDate: Date, messageId = 900, caption = "Flamengo -0.5 @1.90 1u") {
  const bankroll = await seedChannelBankroll(db);
  const result = await offerCaptureFix({
    bankroll, post: { chatId: CHANNEL_ID, messageId, postDate }, bet, reason, via: "gemini", caption, send,
  });
  return { bankroll, result };
}

describe("oferta do conserto", () => {
  it("pergunta uma vez por post, só em recusa que o dono sabe consertar", async () => {
    const postDate = new Date(Date.now() - HOUR);
    const { bankroll, result } = await offer(handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), "lado_handicap_ausente", postDate);
    expect(result).toBe("perguntado");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: OWNER, markup: { inline_keyboard: [[{ text: "Flamengo" }], [{ text: "Palmeiras" }], [{ callback_data: "fx:x" }]] } });
    const again = await offerCaptureFix({
      bankroll, post: { chatId: CHANNEL_ID, messageId: 900, postDate }, bet: handicapWithoutSide(new Date(Date.now() + 48 * HOUR)),
      reason: "lado_handicap_ausente", via: "gemini", caption: "", send,
    });
    expect(again).toBe("ja_perguntado");
    expect(await offerCaptureFix({
      bankroll, post: { chatId: CHANNEL_ID, messageId: 901, postDate }, bet: handicapWithoutSide(new Date(Date.now() + 48 * HOUR)),
      reason: "evento_ausente", via: "gemini", caption: "", send,
    })).toBe("nao_consertavel");
    expect(await offerCaptureFix({
      bankroll, post: { chatId: CHANNEL_ID, messageId: 902, postDate }, bet: handicapWithoutSide(new Date(Date.now() - HOUR)),
      reason: "lado_handicap_ausente", via: "gemini", caption: "", send,
    })).toBe("jogo_comecou");
    expect(sent).toHaveLength(1);
  });
});

describe("grade sem marca e placar da entrada ao vivo", () => {
  const kickoff = () => new Date(Date.now() + 48 * HOUR);
  const grid = () => ({
    evento: "CSD Municipal vs Suchitepequez", esporte: "Soccer", competicao: "", pais: "", mercado: "Asian Handicap",
    selecao: "CSD Municipal -1.5,-2.0", odds: 1.8, stake: 1, data: kickoff(), casaDeAposta: "Bet365",
  });
  const options = [{ selecao: "CSD Municipal -1.5,-2.0", odds: 1.8 }, { selecao: "Suchitepequez +1.5,+2.0", odds: 2 }];

  it("grade sem marca pergunta qual opção e grava a escolhida, com a odd dela e a entrada do post", async () => {
    const postDate = new Date(Date.now() - HOUR);
    const bankroll = await seedChannelBankroll(db);
    expect(await offerCaptureFix({
      bankroll, post: { chatId: CHANNEL_ID, messageId: 940, postDate }, bet: grid(), reason: "unmarked_selection", via: "ia",
      caption: "1u", options, send,
    })).toBe("perguntado");
    expect(sent[0]?.text).not.toContain("@1.8 ·");
    expect(sent[0]?.markup).toMatchObject({ inline_keyboard: [
      [{ text: "CSD Municipal -1.5,-2.0 @1.8", callback_data: "fx:o0" }],
      [{ text: "Suchitepequez +1.5,+2.0 @2", callback_data: "fx:o1" }],
      [{ callback_data: "fx:x" }],
    ] });
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "o7" }, { boss })).toMatchObject({ keep: true });
    const reply = await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "o1" }, { boss });
    expect(reply?.text).toMatch(/^✅/);
    const bet = await db.prisma.bet.findFirstOrThrow();
    expect(bet.selecao).toMatch(/^Suchitepequez \+1\.75$/);
    expect(Number(bet.odds)).toBe(2);
    expect(bet.sourcePostedAt).toEqual(postDate);
  });

  it("sem duas opções não há o que perguntar", async () => {
    const bankroll = await seedChannelBankroll(db);
    expect(await offerCaptureFix({
      bankroll, post: { chatId: CHANNEL_ID, messageId: 941, postDate: new Date() }, bet: grid(), reason: "unmarked_selection", via: "ia",
      caption: "1u", options: options.slice(0, 1), send,
    })).toBe("nao_consertavel");
    expect(sent).toHaveLength(0);
  });

  it("handicap ao vivo sem placar pergunta o placar da entrada e liquida pelo restante", async () => {
    const postDate = new Date(Date.now() - HOUR);
    const bet = { ...handicapWithoutSide(kickoff()), selecao: "Flamengo -0.5" };
    await offer(bet, "placar_ao_vivo_ausente", postDate, 942, "🔴 AO VIVO\nFlamengo -0.5 @1.90 1u");
    expect(sent[0]?.markup).toMatchObject({ force_reply: true });
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "um a zero" }, { boss })).toMatchObject({ keep: true });
    const reply = await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "1x0" }, { boss });
    expect(reply?.text).toMatch(/^✅/);
    const saved = await db.prisma.bet.findFirstOrThrow();
    expect(saved).toMatchObject({ liveScoreHome: 1, liveScoreAway: 0, sourcePostedAt: postDate });
  });

  it("entrada ao vivo com o horário do jogo no post: o placar da entrada vale até o fim da janela do jogo", async () => {
    const kickoffAt = new Date(Date.now() - 40 * 60_000);
    const postDate = new Date(Date.now() - 10 * 60_000);
    const bet = { ...handicapWithoutSide(kickoffAt), selecao: "Flamengo -0.5", kickoffDateOnly: false };
    const { result } = await offer(bet, "placar_ao_vivo_ausente", postDate, 943, "🔴 AO VIVO\nFlamengo -0.5 @1.90 1u");
    expect(result).toBe("perguntado");
    const draft = await db.prisma.telegramDmDraft.findFirstOrThrow();
    expect(draft.expiresAt).toEqual(new Date(kickoffAt.getTime() + 3 * HOUR));
    const reply = await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "1x0" }, { boss });
    expect(reply?.text).toMatch(/^✅/);
    expect(await db.prisma.bet.findFirstOrThrow()).toMatchObject({ liveScoreHome: 1, liveScoreAway: 0, sourcePostedAt: postDate });
  });

  it("entrada ao vivo: nada depois da janela do jogo, e odd que faltava não se completa com o jogo rolando", async () => {
    const bankroll = await seedChannelBankroll(db);
    const liveOffer = (messageId: number, kickoffAt: Date, postDate: Date, reason: string, bet: Partial<ParsedBetPost> = {}) => offerCaptureFix({
      bankroll, post: { chatId: CHANNEL_ID, messageId, postDate },
      bet: { ...handicapWithoutSide(kickoffAt), selecao: "Flamengo -0.5", kickoffDateOnly: false, ...bet },
      reason, via: "gemini", caption: "🔴 AO VIVO\nFlamengo -0.5 @1.90 1u", send,
    });
    const kickoffAt = new Date(Date.now() - 40 * 60_000);
    expect(await liveOffer(950, new Date(Date.now() - 4 * HOUR), new Date(Date.now() - 10 * 60_000), "placar_ao_vivo_ausente")).toBe("jogo_comecou");
    expect(await liveOffer(951, kickoffAt, new Date(Date.now() - 10 * 60_000), "odd_invalida", { odds: 0 })).toBe("jogo_comecou");
    expect(sent).toHaveLength(0);

    // Respondida depois da janela, com a pergunta ainda aberta, não grava.
    expect(await liveOffer(952, kickoffAt, new Date(Date.now() - 10 * 60_000), "placar_ao_vivo_ausente")).toBe("perguntado");
    await db.prisma.telegramDmDraft.updateMany({ data: { expiresAt: new Date(Date.now() + 48 * HOUR) } });
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "1x0" }, { boss, now: new Date(kickoffAt.getTime() + 3 * HOUR + 60_000) }))
      .toEqual({ text: "⏱️ O jogo já terminou: não registrei." });
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("entrada ao vivo: o placar respondido que deixa faltando a odd encerra o conserto em vez de perguntar", async () => {
    const kickoffAt = new Date(Date.now() - 40 * 60_000);
    const bet = { ...handicapWithoutSide(kickoffAt), selecao: "Flamengo -0.5", kickoffDateOnly: false, odds: 0 };
    await offer(bet, "placar_ao_vivo_ausente", new Date(Date.now() - 10 * 60_000), 944, "🔴 AO VIVO\nFlamengo -0.5 1u");
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "1x0" }, { boss, send }))
      .toEqual({ text: "⏱️ O jogo já começou: não registrei." });
    expect(sent).toHaveLength(1);
    expect(await db.prisma.telegramDmDraft.count()).toBe(0);
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("edição que chega depois do kickoff e placar lido em post pré-jogo não ganham a janela da entrada ao vivo", async () => {
    const bankroll = await seedChannelBankroll(db);
    const kickoffAt = new Date(Date.now() - 15 * 60_000);
    const bet = { ...handicapWithoutSide(kickoffAt), kickoffDateOnly: false };
    const preGamePost = new Date(kickoffAt.getTime() - 15 * 60_000);
    const offerSide = (messageId: number, post: { postDate: Date; editDate?: Date }, read: ParsedBetPost = bet) => offerCaptureFix({
      bankroll, post: { chatId: CHANNEL_ID, messageId, ...post }, bet: read,
      reason: "lado_handicap_ausente", via: "gemini", caption: "Flamengo -0.5 @1.90 1u", send,
    });
    // Post 15 min antes do kickoff, editado 5 min depois dele (dentro dos 30 min do rascunho).
    expect(await offerSide(960, { postDate: preGamePost, editDate: new Date(kickoffAt.getTime() + 5 * 60_000) })).toBe("jogo_comecou");
    expect(await offerSide(961, { postDate: preGamePost }, { ...bet, liveScoreHome: 0, liveScoreAway: 0 })).toBe("jogo_comecou");
    expect(sent).toHaveLength(0);
    expect(await db.prisma.telegramDmDraft.count()).toBe(0);
  });
});

describe("resposta do dono", () => {
  it("lado do handicap grava pelo registro da captura com a entrada do post", async () => {
    const postDate = new Date(Date.now() - 2 * HOUR);
    await offer(handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), "lado_handicap_ausente", postDate);
    const reply = await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "a" }, { boss });
    expect(reply?.text).toMatch(/^✅ Registrada em Carteira Tips/);
    const bet = await db.prisma.bet.findFirstOrThrow({ include: { captureEvidence: true } });
    expect(bet).toMatchObject({
      selecao: "Palmeiras -0.5", source: `telegram-channel:${CHANNEL_ID}`, sourceExternalId: "900",
      sourcePostedAt: postDate,
    });
    // O dono completou a leitura: a aposta não mede o acerto do leitor recusado.
    expect(bet.captureReader).toBeNull();
    // A evidência é a da captura do canal, marcada como pedida pelo dono: fica fora da latência do post.
    expect(bet.captureEvidence).toMatchObject({ parser: "gemini", caption: "Flamengo -0.5 @1.90 1u", mediaFileId: null, parsedJson: { forcedByOperator: true } });
    expect(Object.keys(bet.captureEvidence!.parsedJson as object).sort()).toEqual([
      "casaDeAposta", "competicao", "data", "esporte", "evento", "forcedByOperator", "kickoffDateOnly", "liveScoreAway", "liveScoreHome",
      "mercado", "odds", "pais", "selecao", "sportResolution", "stake",
    ]);
    expect(z.strictObject(captureParsedSchema.shape).safeParse(bet.captureEvidence!.parsedJson).success).toBe(true);
    expect(await db.prisma.auditEvent.count({ where: { resourceId: bet.id, actor: `telegram-user:${OWNER}` } })).toBeGreaterThan(0);
    // A pergunta respondida fecha: repetir o clique não grava de novo.
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "a" }, { boss })).toBeNull();
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("👎 dado antes da resposta vale na aposta do conserto, que não vai à fila de preço", async () => {
    await offer(handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), "lado_handicap_ausente", new Date(Date.now() - HOUR));
    expect(await handleChannelReaction({ chatId: CHANNEL_ID, actorUserId: OWNER, messageId: 900, emojis: ["👎"] })).toEqual({ kind: "remembered" });
    vi.mocked(boss.send).mockClear();
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "a" }, { boss }))
      .toMatchObject({ text: expect.stringMatching(/^✅ Registrada em Carteira Tips/) });
    expect(await db.prisma.bet.findFirstOrThrow({ select: { status: true, notTakenAt: true } }))
      .toEqual({ status: "CANCELED", notTakenAt: expect.any(Date) });
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("odd que faltava entra na hora da correção, mesmo depois dos 30 min do post", async () => {
    const postDate = new Date(Date.now() - 3 * HOUR);
    const bet = { ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), selecao: "Flamengo -0.5", odds: 0 };
    await offer(bet, "odd_invalida", postDate);
    expect(sent[0]?.markup).toMatchObject({ force_reply: true });
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "um e noventa" }, { boss }))
      .toMatchObject({ keep: true });
    const now = new Date();
    const reply = await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "1,90" }, { boss, now });
    expect(reply?.text).toMatch(/^✅/);
    const saved = await db.prisma.bet.findFirstOrThrow();
    expect(Number(saved.odds)).toBe(1.9);
    expect(saved.sourcePostedAt).toEqual(now);
  });

  it("falha passageira na gravação deixa a pergunta aberta, e a resposta seguinte grava", async () => {
    await offer(handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), "lado_handicap_ausente", new Date(Date.now() - HOUR));
    vi.mocked(registerCapturedBet).mockRejectedValueOnce(databaseDown());
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "a" }, { boss }))
      .toEqual({ text: "⚠️ Não consegui registrar agora. A pergunta continua aberta: responda de novo.", keep: true });
    expect(await db.prisma.telegramDmDraft.count()).toBe(1);
    expect(await db.prisma.bet.count()).toBe(0);

    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "a" }, { boss }))
      .toMatchObject({ text: expect.stringMatching(/^✅ Registrada em Carteira Tips/) });
    expect(await db.prisma.bet.findFirstOrThrow()).toMatchObject({ selecao: "Palmeiras -0.5" });
    expect(await db.prisma.telegramDmDraft.count()).toBe(0);
  });

  it("fila que não entra depois da gravação abre ação em Operações, e a resposta continua registrada", async () => {
    await offer(handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), "lado_handicap_ausente", new Date(Date.now() - HOUR));
    // A aposta e o próximo passo ficam duráveis mesmo quando o fast-path falha.
    vi.mocked(boss.send).mockRejectedValueOnce(databaseDown());
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "a" }, { boss }))
      .toMatchObject({ text: expect.stringMatching(/^✅ Registrada em Carteira Tips/) });
    const bet = await db.prisma.bet.findFirstOrThrow({ select: { id: true } });
    expect(await db.prisma.operationalAction.findFirst({
      where: { resourceId: bet.id }, select: { resource: true, status: true },
    })).toEqual({ resource: "bet", status: "OPEN" });
    expect(await db.prisma.auditEvent.count({ where: { action: CAPTURE_FOLLOWUP_ACTION, outcome: "pending" } })).toBe(1);
    await dispatchPendingCaptureFollowups(realBoss);
    expect(await db.prisma.operationalAction.findFirst({ where: { resourceId: bet.id }, select: { status: true } }))
      .toEqual({ status: "RESOLVED" });
    expect(await db.prisma.auditEvent.count({ where: { action: CAPTURE_FOLLOWUP_ACTION, outcome: "pending" } })).toBe(0);
    expect(await dispatchPendingCaptureFollowups(realBoss)).toBe(0);
  });

  it("erro que responder de novo não resolve encerra a pergunta com o motivo e abre alerta", async () => {
    await offer(handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), "lado_handicap_ausente", new Date(Date.now() - HOUR));
    vi.mocked(registerCapturedBet).mockRejectedValueOnce(new Error("A stake não corresponde à política financeira da origem."));
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "a" }, { boss }))
      .toEqual({ text: "⚠️ Não registrei: A stake não corresponde à política financeira da origem.\nRegistre à mão se ainda valer." });
    expect(await db.prisma.telegramDmDraft.count()).toBe(0);
    expect(await db.prisma.operationalAction.findFirst({
      where: { resourceId: `${CHANNEL_ID}:900` }, select: { actionType: true, title: true, status: true },
    })).toEqual({ actionType: "incident.review", title: "Conserto pela DM não registrado", status: "OPEN" });
  });

  it("stake implausível do post: a stake que o dono responde grava na primeira resposta", async () => {
    // "Stake: 50" lida do post, numa banca que usa a stake da mensagem.
    const bet: ParsedBetPost = {
      ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), selecao: "Flamengo -0.5", stake: 50,
      stakePolicySnapshot: { version: 1, stakePolicy: "MESSAGE", defaultStakeUnits: null, originalStake: 50, source: "message" },
    };
    await offer(bet, "stake_implausivel", new Date(Date.now() - HOUR), 900, "Flamengo -0.5 @1.90\nStake: 50");
    expect(sent[0]?.markup).toMatchObject({ force_reply: true });
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "2" }, { boss }))
      .toMatchObject({ text: expect.stringMatching(/^✅ Registrada em Carteira Tips/) });
    const saved = await db.prisma.bet.findFirstOrThrow({ include: { captureEvidence: true } });
    expect(Number(saved.stake)).toBe(2);
    expect(saved.captureEvidence?.parsedJson).toMatchObject({ stakePolicySnapshot: { stakePolicy: "MESSAGE", originalStake: 2 } });
  });

  it("prop de jogador sozinha recusada pela stake: o conserto grava a prop com o contrato dela, e a reentrega do post é duplicata", async () => {
    const postDate = new Date(Date.now() - HOUR);
    const prop: ParsedBetPost = {
      evento: "Time A vs Time B", esporte: "Soccer", competicao: "", pais: "", mercado: "Player Shots", selecao: "Pedro Over 1.5",
      odds: 1.8, stake: 50, data: new Date(Date.now() + 48 * HOUR), casaDeAposta: "", stakeSource: "caption",
      playerProp: { jogador: "pedro", mercadoOriginal: "Player Shots", selecaoOriginal: "Pedro Over 1.5", substituicao: "UNKNOWN" },
    };
    await offer(prop, "stake_implausivel", postDate, 900, "Pedro chutes @1.80 50u");
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "2" }, { boss }))
      .toMatchObject({ text: expect.stringMatching(/^✅ Registrada em Carteira Tips/) });
    const saved = await db.prisma.bet.findFirstOrThrow();
    expect(saved).toMatchObject({ sourceExternalId: "900", mercado: "Shots" });
    expect(Number(saved.stake)).toBe(2);
    expect(await db.prisma.betPlayerProp.findFirstOrThrow({ select: { terms: true } }))
      .toMatchObject({ terms: { jogador: "pedro", family: "shots_total", direction: "over", lineQuarters: 6 } });
    // O lote de um item grava com o id do post, como o conserto: a reentrega não vira segunda aposta.
    expect(await handleChannelPost({ chatId: CHANNEL_ID, messageId: 900, text: "Pedro chutes @1.80 50u", postDate }))
      .toEqual({ kind: "duplicate", betId: saved.id });
  });

  it("falha no envio da próxima pergunta não perde a resposta", async () => {
    const bet = { ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), odds: 0 };
    await offer(bet, "lado_handicap_ausente", new Date(Date.now() - HOUR), 900, "Flamengo x Palmeiras -0.5");
    const telegramDown: SendOwnerMessage = async () => { throw new Error("Network request for 'sendMessage' failed!"); };
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "a" }, { boss, send: telegramDown }))
      .toEqual({ text: "⚠️ Falta mais um dado, mas não consegui perguntar agora. A pergunta continua aberta: responda de novo.", keep: true });
    const openQuestions = () => db.prisma.telegramDmDraft.findMany({ select: { messageId: true } });
    expect(await openQuestions()).toEqual([{ messageId: 1001 }]);

    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "a" }, { boss, send }))
      .toEqual({ text: "👍 Anotado. Falta mais um dado, pergunto abaixo." });
    // A nova pergunta substitui a antiga, com o lado que o dono já respondeu.
    expect(await openQuestions()).toEqual([{ messageId: 1002 }]);
    expect(sent[1]?.text).toContain("Palmeiras -0.5");
  });

  it("com o jogo começado a pergunta expira e, mesmo aberta, a resposta não grava", async () => {
    const kickoff = new Date(Date.now() + HOUR);
    await offer(handicapWithoutSide(kickoff), "lado_handicap_ausente", new Date(Date.now() - HOUR));
    const afterKickoff = new Date(kickoff.getTime() + 60_000);
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "h" }, { boss, now: afterKickoff })).toBeNull();
    // Mesmo com o rascunho ainda válido, a checagem do jogo segura a gravação.
    await db.prisma.telegramDmDraft.updateMany({ data: { expiresAt: new Date(Date.now() + 48 * HOUR) } });
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "h" }, { boss, now: afterKickoff }))
      .toEqual({ text: "⏱️ O jogo já começou: não registrei." });
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("sem kickoff conhecido o conserto vale até a janela de um jogo desde o post", async () => {
    const bet = { ...handicapWithoutSide(new Date()), selecao: "Flamengo -0.5", odds: 0, data: null };
    // Relógio fixo no meio do dia em São Paulo: o prazo também acaba com o dia do post.
    const postDate = new Date("2026-06-10T15:00:00Z");
    const bankroll = await seedChannelBankroll(db);
    const offerAt = (messageId: number, posted: Date) => offerCaptureFix({
      bankroll, post: { chatId: CHANNEL_ID, messageId, postDate: posted }, bet, reason: "odd_invalida", via: "gemini", caption: "", send,
      now: new Date(postDate.getTime() + HOUR),
    });
    expect(await offerAt(900, postDate)).toBe("perguntado");
    const draft = await db.prisma.telegramDmDraft.findFirstOrThrow();
    expect(draft.expiresAt.getTime()).toBeLessThanOrEqual(postDate.getTime() + 3 * HOUR);
    await db.prisma.telegramDmDraft.updateMany({ data: { expiresAt: new Date(Date.now() + 48 * HOUR) } });
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "1.9" }, { boss, now: new Date(postDate.getTime() + 4 * HOUR) }))
      .toEqual({ text: "⏱️ O jogo já começou: não registrei." });
    expect(await offerAt(903, new Date(postDate.getTime() - 3 * HOUR))).toBe("jogo_comecou");
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("duas respostas simultâneas gravam uma aposta e deixam uma pergunta nova só", async () => {
    const bet = { ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), odds: 0 };
    await offer(bet, "lado_handicap_ausente", new Date(Date.now() - HOUR), 900, "Flamengo x Palmeiras -0.5");
    const replies = await Promise.all([1, 2].map(() => answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "a" }, { boss, send })));
    expect(replies.filter(Boolean)).toEqual([{ text: "👍 Anotado. Falta mais um dado, pergunto abaixo." }]);
    // Na produção, a fila da pergunta põe as duas respostas em ordem. Aqui, a
    // que perdeu a troca pode ter enviado uma pergunta, que não fica guardada.
    const [next, ...others] = await db.prisma.telegramDmDraft.findMany();
    expect(others).toEqual([]);
    const answers = await Promise.all([1, 2].map(() => answerCaptureFix({ ownerChatId: OWNER, promptMessageId: next!.messageId, answer: "1.9" }, { boss, send })));
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(await db.prisma.bet.findFirstOrThrow()).toMatchObject({ selecao: "Palmeiras -0.5" });
    expect(await db.prisma.bet.count()).toBe(1);
    // O funil passa a contar o post como capturado.
    expect(await db.prisma.auditEvent.count({ where: { action: "telegram.parse", outcome: "registered", resourceId: "900" } })).toBe(1);
  });

  it("álbum: grava com a configuração financeira presa ao álbum na chegada, não com a banca de agora", async () => {
    const bankroll = await seedChannelBankroll(db);
    const postDate = new Date(Date.now() - HOUR);
    const caption = "Flamengo -0.5 @1.90 1u";
    await stageMediaAlbumPhoto({ chatId: String(CHANNEL_ID), mediaGroupId: "alb-1", photo: { messageId: 900, fileId: "foto-1", caption }, postDate });
    await completeMediaAlbum("alb-1");
    const bet: ParsedBetPost = {
      ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)),
      stakePolicySnapshot: { version: 1, stakePolicy: "MESSAGE", defaultStakeUnits: null, originalStake: 1, source: "message" },
    };
    expect(await offerCaptureFix({
      bankroll, post: { chatId: CHANNEL_ID, messageId: 900, postDate }, bet, reason: "lado_handicap_ausente", via: "gemini", caption, send,
    })).toBe("perguntado");
    await db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { valorUnidade: 50, stakePolicy: "ALWAYS", defaultStakeUnits: 2 } });
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "a" }, { boss }))
      .toMatchObject({ text: expect.stringMatching(/^✅ Registrada/) });
    const saved = await db.prisma.bet.findFirstOrThrow({ include: { captureFinancialContext: true } });
    expect(Number(saved.valorUnidade)).toBe(100);
    expect(saved.captureFinancialContext?.sourceExternalId).toBe("album:alb-1");
    expect(await db.prisma.captureFinancialContext.count()).toBe(1);
  });

  it("handicap sem tipo: o dono escolhe asiático e a aposta grava", async () => {
    const bet = { ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), mercado: "Handicap", selecao: "Flamengo -1" };
    await offer(bet, "handicap_tipo_ambiguo", new Date(Date.now() - HOUR), 900, "⚽ Flamengo -1 @1.90 1u");
    expect(JSON.stringify(sent[0]?.markup)).toContain("Europeu");
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "ah" }, { boss }))
      .toMatchObject({ text: expect.stringMatching(/^✅/) });
    expect(await db.prisma.bet.findFirstOrThrow()).toMatchObject({ mercado: "Handicap – Match", selecao: "Flamengo -1" });
  });

  it("odd acima de 20 respondida pelo dono não volta como implausível", async () => {
    const bet = { ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), mercado: "Moneyline", selecao: "Flamengo", odds: 185 };
    await offer(bet, "odd_implausivel", new Date(Date.now() - HOUR), 900, "⚽ Flamengo @185 1u");
    expect(sent[0]?.text).toContain("A odd lida está fora do normal para este mercado.");
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "21" }, { boss }))
      .toMatchObject({ text: expect.stringMatching(/^✅/) });
    expect(Number((await db.prisma.bet.findFirstOrThrow()).odds)).toBe(21);
  });

  it("odd acima de 20 respondida pelo dono continua valendo na pergunta seguinte, a da stake", async () => {
    const bet: ParsedBetPost = {
      ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), mercado: "Moneyline", selecao: "Flamengo", odds: 0, stake: 0,
      stakePolicySnapshot: { version: 1, stakePolicy: "MESSAGE", defaultStakeUnits: null, originalStake: null, source: "message" },
    };
    await offer(bet, "odd_invalida", new Date(Date.now() - HOUR), 900, "⚽ Flamengo x Palmeiras\nFlamengo");
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "21" }, { boss, send }))
      .toEqual({ text: "👍 Anotado. Falta mais um dado, pergunto abaixo." });
    expect(sent[1]?.text).toContain("A stake não veio");
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1002, answer: "2" }, { boss, send }))
      .toMatchObject({ text: expect.stringMatching(/^✅/) });
    const saved = await db.prisma.bet.findFirstOrThrow();
    expect([Number(saved.odds), Number(saved.stake)]).toEqual([21, 2]);
    expect(sent).toHaveLength(2);
  });

  it("esclarecer o lado depois da odd que faltava preserva o instante da odd", async () => {
    const now = new Date();
    const firstAnswerAt = new Date(now.getTime() - 20 * 60_000);
    const finalAnswerAt = new Date(now.getTime() - 5 * 60_000);
    await offer({ ...handicapWithoutSide(new Date(now.getTime() + 48 * HOUR)), odds: 0 }, "odd_invalida", new Date(now.getTime() - HOUR), 900, "Flamengo x Palmeiras\n-0.5\n1u");
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "1.9" }, { boss, send, now: firstAnswerAt }))
      .toMatchObject({ text: expect.stringMatching(/Falta mais um dado/) });
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1002, answer: "a" }, { boss, send, now: finalAnswerAt }))
      .toMatchObject({ text: expect.stringMatching(/^✅/) });
    expect((await db.prisma.bet.findFirstOrThrow()).sourcePostedAt).toEqual(firstAnswerAt);
  });

  it("a entrada é a última resposta que completou odd e stake, não a primeira", async () => {
    const now = new Date();
    const firstAnswerAt = new Date(now.getTime() - 20 * 60_000);
    const finalAnswerAt = new Date(now.getTime() - 5 * 60_000);
    const bet: ParsedBetPost = {
      ...handicapWithoutSide(new Date(now.getTime() + 48 * HOUR)),
      mercado: "Moneyline", selecao: "Flamengo", odds: 0, stake: 0,
      stakePolicySnapshot: { version: 1, stakePolicy: "MESSAGE", defaultStakeUnits: null, originalStake: null, source: "message" },
    };
    await offer(bet, "odd_invalida", new Date(now.getTime() - HOUR), 900, "⚽ Flamengo x Palmeiras\nFlamengo");
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "1.9" }, { boss, send, now: firstAnswerAt }))
      .toMatchObject({ text: expect.stringMatching(/Falta mais um dado/) });
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1002, answer: "2" }, { boss, send, now: finalAnswerAt }))
      .toMatchObject({ text: expect.stringMatching(/^✅/) });
    expect((await db.prisma.bet.findFirstOrThrow()).sourcePostedAt).toEqual(finalAnswerAt);
  });

  it.each([
    ["\"vários/não sei\"", []],
    ["marcado só com futebol", ["Soccer"]],
  ])("\"Pontos\" confirma basquete pelo dono, com o canal %s", async (_label, channelSports) => {
    const bet: ParsedBetPost = {
      evento: "Mogi vs Franca", esporte: "Unknown", competicao: "", pais: "", mercado: "Total",
      selecao: "Over 15.5", odds: 1.85, stake: 1, data: new Date(Date.now() + 48 * HOUR), casaDeAposta: "",
    };
    const { bankroll } = await offer(bet, "mercado_total_ambiguo", new Date(Date.now() - HOUR), 900, "Mogi x Franca\nOver 15.5 @1.85 1u");
    await db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { channelSports } });
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "p" }, { boss }))
      .toMatchObject({ text: expect.stringMatching(/^✅/) });
    // O esporte do dono vale sem o resolvedor, que o poria em conflito com o canal.
    expect(await db.prisma.bet.findFirstOrThrow()).toMatchObject({
      esporte: "Basketball", sportResolutionStatus: "CONFIRMED", sportSource: "MANUAL",
    });
  });

  it("odd respondida pelo dono: o esporte sai da legenda do post, não dos números da resposta", async () => {
    const bet: ParsedBetPost = {
      evento: "Mogi vs Franca", esporte: "Unknown", competicao: "", pais: "", mercado: "Moneyline",
      selecao: "Mogi", odds: 0, stake: 1, data: new Date(Date.now() + 48 * HOUR), casaDeAposta: "",
    };
    await offer(bet, "odd_invalida", new Date(Date.now() - HOUR), 900, "🏀 Mogi x Franca\nMogi 1u");
    expect(await answerCaptureFix({ ownerChatId: OWNER, promptMessageId: 1001, answer: "1.85" }, { boss }))
      .toMatchObject({ text: expect.stringMatching(/^✅/) });
    expect(await db.prisma.bet.findFirstOrThrow()).toMatchObject({ esporte: "Basketball", sportSource: "EMOJI" });
  });
});

describe("applyFixAnswer", () => {
  const state = (field: CaptureFixState["field"], bet: Partial<CaptureFixState["bet"]> = {}): CaptureFixState => ({
    version: 1, sourceKey: "k", chatId: String(CHANNEL_ID), messageId: 1, bankrollId: "b", bankrollNome: "B", reason: "r", field,
    via: "gemini", caption: "", mediaFileId: null, postDate: new Date().toISOString(), editDate: null, completedAt: null, sport: null,
    bet: { evento: "A vs B", esporte: "Soccer", competicao: "", pais: "", mercado: "Total", selecao: "Over 9.5", odds: 1.9, stake: 1, data: null, casaDeAposta: "", ...bet },
  });
  it.each([
    ["g", "Total (Gols) – Match"],
    ["c", "Total (Corners) – Match"],
    ["k", "Total (Bookings) – Match"],
  ])("unidade %s vira o mercado %s", (answer, mercado) => {
    expect(applyFixAnswer(state("total_unit"), answer)).toMatchObject({ ok: true, bet: { mercado } });
  });
  it.each([["c"], ["k"]])("escanteio e cartão (%s) confirmam futebol pelo dono", (answer) => {
    expect(applyFixAnswer(state("total_unit", { esporte: "Unknown" }), answer))
      .toMatchObject({ ok: true, sport: "Soccer", bet: { esporte: "Soccer", sportResolution: { status: "CONFIRMED", source: "MANUAL" } } });
  });
  it.each([["ah", "Asian Handicap"], ["eh", "European Handicap"]])("tipo de handicap %s vira %s", (answer, mercado) => {
    expect(applyFixAnswer(state("handicap_type", { mercado: "Handicap", selecao: "Flamengo -1" }), answer))
      .toMatchObject({ ok: true, bet: { mercado } });
    expect(applyFixAnswer(state("handicap_type"), "zz")).toMatchObject({ ok: false });
  });
  it("stake fora do teto da captura é recusada", () => {
    expect(applyFixAnswer(state("stake"), "500")).toMatchObject({ ok: false });
    expect(applyFixAnswer(state("stake"), "2u")).toMatchObject({ ok: true, bet: { stake: 2 } });
  });
});

describe("handlers do grammY", () => {
  type Handler = (ctx: unknown, next: () => Promise<void>) => Promise<void>;
  function fakeBot() {
    const handlers: Record<string, Handler> = {};
    const bot = { on: (filter: string, handler: Handler) => { handlers[filter] = handler; } };
    registerCaptureFixHandlers(bot as unknown as Bot, boss);
    return handlers;
  }
  /** O clique no botão "a" da pergunta 1001, no chat dado; `calls` guarda o que o bot fez. */
  function click(chatId: number) {
    const calls: string[] = [];
    const ctx = {
      callbackQuery: { data: "fx:a", message: { chat: { id: chatId }, message_id: 1001, text: "🛠️ pergunta" } },
      answerCallbackQuery: async (opts?: { text?: string }) => { calls.push(`answer:${opts?.text ?? ""}`); },
      editMessageText: async (text: string) => { calls.push(`edit:${text}`); },
      reply: async (text: string) => { calls.push(`reply:${text}`); },
    };
    return { ctx, calls };
  }

  it("clique fora da DM do dono é recusado; o do dono grava", async () => {
    await offer(handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), "lado_handicap_ausente", new Date(Date.now() - HOUR));
    const handlers = fakeBot();
    const stranger = click(999);
    await handlers["callback_query:data"]!(stranger.ctx, async () => undefined);
    expect(stranger.calls).toEqual(["answer:Chat não autorizado."]);
    expect(await db.prisma.bet.count()).toBe(0);

    const owner = click(Number(OWNER));
    await handlers["callback_query:data"]!(owner.ctx, async () => undefined);
    expect(owner.calls[1]).toMatch(/^edit:🛠️ pergunta\n\n✅ Registrada/);
    expect(await db.prisma.bet.count()).toBe(1);

    // Callback de outro fluxo segue adiante.
    let passed = false;
    await handlers["callback_query:data"]!({ callbackQuery: { data: "dm:cancel", message: { chat: { id: Number(OWNER) }, message_id: 1 } } }, async () => { passed = true; });
    expect(passed).toBe(true);
  });

  it("falha passageira no meio da resposta avisa o dono e deixa a pergunta com os botões", async () => {
    await offer(handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), "lado_handicap_ausente", new Date(Date.now() - HOUR));
    const handlers = fakeBot();
    vi.mocked(registerCapturedBet).mockRejectedValueOnce(databaseDown());
    const failed = click(Number(OWNER));
    await handlers["callback_query:data"]!(failed.ctx, async () => undefined);
    expect(failed.calls).toEqual(["answer:", "reply:⚠️ Não consegui registrar agora. A pergunta continua aberta: responda de novo."]);
    expect(await db.prisma.bet.count()).toBe(0);

    const again = click(Number(OWNER));
    await handlers["callback_query:data"]!(again.ctx, async () => undefined);
    expect(again.calls[1]).toMatch(/^edit:🛠️ pergunta\n\n✅ Registrada/);
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("falha antes de saber se é resposta a uma pergunta sobe, e a fila repete a mensagem", async () => {
    const handlers = fakeBot();
    vi.mocked(answerCaptureFix).mockRejectedValueOnce(databaseDown());
    const replies: string[] = [];
    const ctx = {
      me: { id: 42 },
      chat: { id: Number(OWNER), type: "private" },
      // Uma tip nova, em resposta a outra mensagem do bot.
      message: { message_id: 78, text: "Flamengo x Palmeiras\nAmbas marcam @1.85 1u", reply_to_message: { message_id: 5000, from: { id: 42 } } },
      reply: async (text: string) => { replies.push(text); },
    };
    let passed = false;
    await expect(handlers.message!(ctx, async () => { passed = true; })).rejects.toThrow("Can't reach database server");
    expect({ passed, replies }).toEqual({ passed: false, replies: [] });
  });

  it("só a resposta do dono a uma pergunta do bot vira conserto", async () => {
    await offer({ ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), selecao: "Flamengo -0.5", odds: 0 }, "odd_invalida", new Date(Date.now() - HOUR));
    const handlers = fakeBot();
    const message = (chatId: number, replyFrom: number | null) => {
      const replies: string[] = [];
      const ctx = {
        me: { id: 42 },
        chat: { id: chatId, type: "private" },
        message: {
          message_id: 77, text: "1.9",
          ...(replyFrom === null ? {} : { reply_to_message: { message_id: 1001, from: { id: replyFrom } } }),
        },
        reply: async (text: string) => { replies.push(text); },
      };
      return { ctx, replies };
    };
    for (const [chatId, from] of [[999, 42], [Number(OWNER), null], [Number(OWNER), 55]] as const) {
      const { ctx, replies } = message(chatId, from);
      let passed = false;
      await handlers.message!(ctx, async () => { passed = true; });
      expect({ chatId, from, passed, replies }).toEqual({ chatId, from, passed: true, replies: [] });
    }
    const { ctx, replies } = message(Number(OWNER), 42);
    await handlers.message!(ctx, async () => undefined);
    expect(replies[0]).toMatch(/^✅ Registrada/);
  });

  /** Mensagem do dono em resposta à pergunta 1001, com o texto dela como o Telegram entrega. */
  function answerToPrompt(text: string, reply: (text: string) => Promise<unknown> = async () => undefined) {
    const replies: string[] = [];
    const ctx = {
      me: { id: 42 },
      chat: { id: Number(OWNER), type: "private" },
      message: { message_id: 79, text, reply_to_message: { message_id: 1001, from: { id: 42 }, text: sent[0]?.text } },
      reply: async (replyText: string) => { replies.push(replyText); return reply(replyText); },
    };
    return { ctx, replies };
  }

  it("resposta digitada a pergunta vencida ou já respondida diz isso, sem virar aposta nova da DM", async () => {
    await offer({ ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), selecao: "Flamengo -0.5", odds: 0 }, "odd_invalida", new Date(Date.now() - HOUR));
    const handlers = fakeBot();
    const first = answerToPrompt("1.9");
    await handlers.message!(first.ctx, async () => { throw new Error("não devia seguir"); });
    expect(first.replies[0]).toMatch(/^✅ Registrada/);

    for (const text of ["1.9", "@1,85", "2u"]) {
      const again = answerToPrompt(text);
      let passed = false;
      await handlers.message!(again.ctx, async () => { passed = true; });
      expect({ text, passed, replies: again.replies }).toEqual({ text, passed: false, replies: ["⚠️ Esta pergunta expirou ou já foi respondida."] });
    }
    // Uma tip nova presa à pergunta (o teclado do Telegram mantém a resposta) segue para a DM.
    const tip = answerToPrompt("Flamengo x Palmeiras\nAmbas marcam @1.85 1u");
    let passed = false;
    await handlers.message!(tip.ctx, async () => { passed = true; });
    expect({ passed, replies: tip.replies }).toEqual({ passed: true, replies: [] });
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("placar respondido à pergunta vencida diz que ela expirou", async () => {
    const bet = { ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), selecao: "Flamengo -0.5" };
    await offer(bet, "placar_ao_vivo_ausente", new Date(Date.now() - HOUR), 942, "🔴 AO VIVO\nFlamengo -0.5 @1.90 1u");
    await db.prisma.telegramDmDraft.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
    const late = answerToPrompt("1x0");
    let passed = false;
    await fakeBot().message!(late.ctx, async () => { passed = true; });
    expect({ passed, replies: late.replies }).toEqual({ passed: false, replies: ["⚠️ Esta pergunta expirou ou já foi respondida."] });
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("falha ao confirmar a aposta gravada não relança a mensagem", async () => {
    await offer({ ...handicapWithoutSide(new Date(Date.now() + 48 * HOUR)), selecao: "Flamengo -0.5", odds: 0 }, "odd_invalida", new Date(Date.now() - HOUR));
    const telegramDown = answerToPrompt("1.9", async () => { throw new Error("Call to 'sendMessage' failed! (429: Too Many Requests)"); });
    await expect(fakeBot().message!(telegramDown.ctx, async () => undefined)).resolves.toBeUndefined();
    expect(telegramDown.replies[0]).toMatch(/^✅ Registrada/);
    expect(await db.prisma.bet.count()).toBe(1);
  });
});
