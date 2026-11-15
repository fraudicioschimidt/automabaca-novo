import { createBoss } from "@/src/infra/boss";
import { ensureQueueWithDeadLetter } from "@/src/jobs/queues";
import { WORKER_JOBS } from "@/src/jobs/worker-jobs";
import { QUEUES } from "@/src/infra/queue-contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Bot } from "grammy";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { captureParsedSchema } from "@/src/domain/bet-capture";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTeamCard } from "../helpers/team-cards";
import { CHANNEL_ID, POST_DATE, POST_TEXT, seedChannelBankroll } from "../helpers/telegram-channel";

/**
 * A aposta avulsa pela DM do bot, da mensagem ao registro na banca escolhida,
 * contra Postgres real. A leitura por regra é real; a IA fica mockada. A DM é
 * o outro caminho de entrada da aposta, e o que ela grava (e o que não grava)
 * precisa continuar igual quando o registro da captura for unificado.
 */
const geminiMocks = vi.hoisted(() => ({ extractBetFromText: vi.fn(), extractBetFromImage: vi.fn() }));
vi.mock(import("@/src/services/capture/reading/extract-bet"), () => geminiMocks);
/** Releituras do guard: sem resposta, como a cascata sem chave. */
vi.mock("@/src/infra/llm/cascade", () => ({ llmGenerateJson: async () => null }));
/** O print da DM baixado pela Bot API: sintético. */
vi.mock(import("@/src/telegram/photo-download"), async (original) => ({
  ...await original(),
  downloadTelegramPhoto: async (_api, _token, fileId) => ({ base64: `img-${fileId}`, mimeType: "image/jpeg" }),
}));
const alertMocks = vi.hoisted(() => ({ sendOperationalAlert: vi.fn(), sendOperatorNotification: vi.fn() }));
vi.mock("@/src/services/ops/alerts", async (original) => ({
  ...await original<typeof import("@/src/services/ops/alerts")>(),
  ...alertMocks,
}));

import { resetEnvCacheForTests } from "@/src/infra/env";
import { CAPTURE_FOLLOWUP_ACTION, dispatchPendingCaptureFollowups } from "@/src/services/scheduling/enqueue-after-capture";
import { persistOperationalAlert } from "@/src/services/ops/alerts";
import { confirmBetSport } from "@/src/services/bets/sport-resolution/resolve";
import { registerDmCallbackHandler } from "@/src/telegram/dm";
import { processTelegramJob } from "@/src/telegram/processing";

const OWNER_CHAT = "123";
const BET365_LINK = "https://www.bet365.bet.br/#/AC/B1/C1/D8/E200057053/F3/I3/";
const boss = { send: vi.fn<PgBoss["send"]>() };

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
beforeEach(async () => {
  await db.reset();
  await db.prisma.$executeRaw`DELETE FROM pgboss.job WHERE name IN (${QUEUES.sharpEnrich}, ${QUEUES.sportResolve})`;
  vi.clearAllMocks();
  vi.stubEnv("TELEGRAM_ALLOWED_CHATS", OWNER_CHAT);
  resetEnvCacheForTests();
  // Relógio uma hora depois do post: os jogos de junho/2026 dos posts ficam
  // dentro da janela de sanidade do kickoff em qualquer ano em que o teste rode.
  vi.setSystemTime(new Date(POST_DATE.getTime() + 3_600_000));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetEnvCacheForTests(); });

/** A mensagem do dono (texto ou print) vira a prévia (job `dm_message`); devolve o que o bot respondeu. */
async function sendDm(messageId: number, text: string, photo?: { fileId: string }): Promise<string[]> {
  const replies: string[] = [];
  const api = {
    sendMessage: async (_chatId: unknown, reply: string) => {
      replies.push(reply);
      return { message_id: 5_000 + messageId };
    },
  } as unknown as Api;
  await processTelegramJob({ api, boss: boss as unknown as PgBoss, token: "token" }, {
    kind: "dm_message", chatId: OWNER_CHAT, messageId, postDate: POST_DATE.toISOString(),
    ...(photo ? { fileId: photo.fileId, caption: text } : { text }),
  });
  return replies;
}

/** O clique na banca, no teclado da prévia; devolve os textos que a prévia passou a mostrar. */
async function chooseBankroll(messageId: number, bankrollId: string): Promise<string[]> {
  let callback: ((ctx: unknown) => Promise<void>) | undefined;
  const bot = { on: (_filter: string, handler: (ctx: unknown) => Promise<void>) => { callback = handler; }, api: {} };
  registerDmCallbackHandler(bot as unknown as Bot, boss as unknown as PgBoss, "token");
  const edits: string[] = [];
  await callback!({
    chat: { id: Number(OWNER_CHAT) },
    callbackQuery: {
      data: `dm:${bankrollId}`,
      message: { chat: { id: Number(OWNER_CHAT) }, reply_to_message: { chat: { id: Number(OWNER_CHAT) }, message_id: messageId } },
    },
    answerCallbackQuery: async () => undefined,
    editMessageText: async (text: string) => { edits.push(text); },
    editMessageReplyMarkup: async () => undefined,
  });
  return edits;
}

/** O que a DM grava na evidência: menos que o canal, sem a política de stake nem a leitura. */
const DM_PARSED_KEYS = [
  "casaDeAposta", "competicao", "data", "esporte", "evento", "kickoffDateOnly", "liveScoreAway", "liveScoreHome",
  "mercado", "odds", "pais", "selecao", "sportResolution", "stake",
];

const channelTraces = () => db.prisma.auditEvent.count({ where: { action: { in: ["telegram.parse", "canal_post_descartado"] } } });

describe("aposta avulsa pela DM", () => {
  it("identifica o homônimo escolhido na confirmação e no reenvio, mantendo a aposta no destino", async () => {
    const first = await seedChannelBankroll(db);
    const second = await db.prisma.bankroll.create({ data: { nome: first.nome, slug: `${first.slug}-2`, valorUnidade: 100 } });
    await sendDm(68, POST_TEXT);
    expect(await chooseBankroll(68, second.id)).toEqual([expect.stringContaining(`Registrada em ${second.nome} (${second.slug})!`)]);
    expect(await chooseBankroll(68, second.id)).toEqual([expect.stringContaining(`Já registrada em ${second.nome} (${second.slug}).`)]);
    expect(await db.prisma.bet.findMany({ select: { bankrollId: true } })).toEqual([{ bankrollId: second.id }]);
  });

  it("recupera a fila ausente e fecha o aviso sem pedir nova captura", async () => {
    const bankroll = await seedChannelBankroll(db);
    await sendDm(69, POST_TEXT);
    vi.mocked(boss.send).mockRejectedValueOnce(new Error("fila indisponível"));
    alertMocks.sendOperationalAlert.mockImplementationOnce(persistOperationalAlert);
    expect(await chooseBankroll(69, bankroll.id)).toEqual([expect.stringContaining("aguardando recuperação automática")]);
    const bet = await db.prisma.bet.findFirstOrThrow();
    expect(await db.prisma.auditEvent.count({ where: { action: CAPTURE_FOLLOWUP_ACTION, outcome: "pending" } })).toBe(1);
    expect(await db.prisma.operationalAction.findFirst({ where: { resourceId: bet.id } })).toMatchObject({ status: "OPEN" });
    await dispatchPendingCaptureFollowups(realBoss);
    expect(await db.prisma.operationalAction.findFirst({ where: { resourceId: bet.id } })).toMatchObject({ status: "RESOLVED" });
    expect(await db.prisma.auditEvent.count({ where: { action: CAPTURE_FOLLOWUP_ACTION, outcome: "pending" } })).toBe(0);
    expect(await dispatchPendingCaptureFollowups(realBoss)).toBe(0);
  });

  it("registra na banca escolhida: origem da DM, sem leitor, evidência enxuta, casa e conta da banca", async () => {
    const bankroll = await seedChannelBankroll(db);
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Betano", titular: "F", saldoInicial: 1000, saldoAtual: 1000, bankrollLinks: { create: { bankrollId: bankroll.id } } },
    });
    const preview = "Coquimbo Unido vs Colo Colo\nResultado Final\nCasa @2.1 (1u)\n📅 15/06 16:00";
    expect(await sendDm(70, POST_TEXT)).toEqual([`📝 ${preview}\n\nEm qual tipster?`]);
    expect(await chooseBankroll(70, bankroll.id)).toEqual([
      `✅ Registrada em Carteira Tips!\n${preview}\n\nEnriquecimento sharp em andamento. Você pode registrar a mesma tip em outro tipster:`,
    ]);

    const bet = await db.prisma.bet.findFirstOrThrow({ include: { captureEvidence: true } });
    expect(bet).toMatchObject({
      source: `telegram-dm:${OWNER_CHAT}:${bankroll.id}`, sourceExternalId: "70", sourcePostedAt: POST_DATE,
      selecao: "Coquimbo Unido", casaDeAposta: "Betano", contaId: conta.id, captureReader: null,
      captureEvidence: { parser: "telegram-dm", caption: POST_TEXT, mediaFileId: null },
    });
    expect(Object.keys(bet.captureEvidence!.parsedJson as object).sort()).toEqual(DM_PARSED_KEYS);
    // A evidência grava a casa que valeu (a padrão da banca, sem casa no post), como a do canal.
    expect(bet.captureEvidence!.parsedJson).toMatchObject({ casaDeAposta: "Betano", selecao: "Casa" });
    expect(z.strictObject(captureParsedSchema.shape).safeParse(bet.captureEvidence!.parsedJson).success).toBe(true);
    expect(await db.prisma.auditEvent.findMany({ where: { action: "bet.create" }, select: { actor: true } })).toEqual([{ actor: "telegram-dm" }]);
    // A conversa é o aviso: a DM não passa pelo funil do canal nem avisa o operador.
    expect(await channelTraces()).toBe(0);
    expect(alertMocks.sendOperatorNotification).not.toHaveBeenCalled();
    expect(boss.send).toHaveBeenCalledWith("sharp.enrich", expect.objectContaining({ betId: bet.id }), expect.anything());
  });

  it("a casa vem do link da aposta na mensagem, e a conta só se for da mesma casa", async () => {
    const bankroll = await seedChannelBankroll(db);
    await db.prisma.conta.create({
      data: { casaDeAposta: "Betano", titular: "F", saldoInicial: 1000, saldoAtual: 1000, bankrollLinks: { create: { bankrollId: bankroll.id } } },
    });
    await sendDm(71, `${POST_TEXT}\n${BET365_LINK}`);
    await chooseBankroll(71, bankroll.id);
    expect(await db.prisma.bet.findFirstOrThrow({ select: { casaDeAposta: true, contaId: true, captureEvidence: { select: { parsedJson: true } } } }))
      .toEqual({ casaDeAposta: "Bet365", contaId: null, captureEvidence: { parsedJson: expect.objectContaining({ casaDeAposta: "Bet365" }) } });
  });

  it("a mesma tip pelo canal e pela DM, na mesma banca, é uma aposta só", async () => {
    const bankroll = await seedChannelBankroll(db);
    const text = `${POST_TEXT}\n${BET365_LINK}`;
    expect(await processTelegramJob({ api: {} as Api, boss: boss as unknown as PgBoss, token: "token" }, {
      kind: "channel_post", chatId: String(CHANNEL_ID), messageId: 555, text, postDate: POST_DATE.toISOString(),
    })).toMatchObject({ kind: "registered" });
    await sendDm(72, text);
    expect(await chooseBankroll(72, bankroll.id)).toEqual([expect.stringMatching(/^♻️ Já registrada em Carteira Tips\.\n/)]);
    expect(await db.prisma.bet.findMany({ select: { source: true, casaDeAposta: true } }))
      .toEqual([{ source: `telegram-channel:${CHANNEL_ID}`, casaDeAposta: "Bet365" }]);
  });

  it("registra jogo que já passou: o dono manda o que já pegou", async () => {
    const bankroll = await seedChannelBankroll(db);
    // POST_DATE é 10/06 09:00 em São Paulo e o jogo foi no dia 9: no canal, o post seria jogo encerrado.
    await sendDm(76, POST_TEXT.replace("Data: 15/06 16:00", "Data: 09/06 16:00"));
    expect(await chooseBankroll(76, bankroll.id)).toEqual([expect.stringMatching(/^✅ Registrada em Carteira Tips!/)]);
    expect(await db.prisma.bet.findFirstOrThrow({ select: { data: true, sourcePostedAt: true } }))
      .toEqual({ data: new Date("2026-06-09T19:00:00.000Z"), sourcePostedAt: POST_DATE });
  });

  it("a tip que chegou antes pela DM faz a do canal ser a repetida", async () => {
    const bankroll = await seedChannelBankroll(db);
    const text = `${POST_TEXT}\n${BET365_LINK}`;
    await sendDm(74, text);
    await chooseBankroll(74, bankroll.id);
    const [dm] = await db.prisma.bet.findMany({ select: { id: true } });
    expect(await processTelegramJob({ api: {} as Api, boss: boss as unknown as PgBoss, token: "token" }, {
      kind: "channel_post", chatId: String(CHANNEL_ID), messageId: 556, text, postDate: POST_DATE.toISOString(),
    })).toEqual({ kind: "duplicate", betId: dm!.id });
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("entrada ao vivo lida do print grava o placar que a prévia mostrou", async () => {
    const bankroll = await seedChannelBankroll(db);
    geminiMocks.extractBetFromImage.mockResolvedValue({
      bet: {
        evento: "Flamengo vs Palmeiras", esporte: "Soccer", competicao: "", pais: "", mercado: "Asian Handicap", selecao: "Flamengo -0.5",
        odds: 1.85, stake: 1, data: new Date("2026-06-15T22:00:00Z"), casaDeAposta: "",
        liveScoreHome: 1, liveScoreAway: 0, liveScoreEvidence: "AO VIVO 1-0",
      },
      provider: "gemini",
    });
    const [preview] = await sendDm(75, "1u", { fileId: "print-75" });
    expect(preview).toContain("🔴 Ao vivo, entrada com 1-0");
    expect(await chooseBankroll(75, bankroll.id)).toEqual([expect.stringContaining("🔴 Ao vivo, entrada com 1-0")]);
    expect(await db.prisma.bet.findFirstOrThrow({ select: { selecao: true, liveScoreHome: true, liveScoreAway: true, captureEvidence: { select: { mediaFileId: true } } } }))
      .toEqual({ selecao: "Flamengo -0.5", liveScoreHome: 1, liveScoreAway: 0, captureEvidence: { mediaFileId: "print-75" } });
  });

  it("a prévia mostra as pernas da múltipla e o jogador da prop que a aposta grava", async () => {
    await seedChannelBankroll(db);
    const kickoff = new Date("2026-06-15T22:00:00Z");
    const legs = {
      kind: "parlay" as const,
      legs: [
        { evento: "Time A vs Time B", mercado: "Moneyline", selecao: "Time A" },
        { evento: "Time C vs Time D", mercado: "Moneyline", selecao: "Time D" },
      ],
    };
    geminiMocks.extractBetFromImage.mockResolvedValueOnce({
      bet: {
        evento: "Time A vs Time B | Time C vs Time D", esporte: "Soccer", competicao: "", pais: "", mercado: "Moneyline",
        selecao: "Time A / Time D", odds: 3.4, stake: 1, data: kickoff, casaDeAposta: "", legs,
      },
      provider: "gemini",
    });
    const [multiple] = await sendDm(77, "1u", { fileId: "print-77" });
    expect(multiple).toContain("🧩 2 pernas:\n• Time A vs Time B: Moneyline · Time A\n• Time C vs Time D: Moneyline · Time D");

    geminiMocks.extractBetFromImage.mockResolvedValueOnce({
      bet: {
        evento: "Flamengo vs Palmeiras", esporte: "Soccer", competicao: "", pais: "", mercado: "Player Shots", selecao: "Pedro Over 1.5",
        odds: 1.8, stake: 1, data: kickoff, casaDeAposta: "",
        playerProp: { jogador: "Pedro", time: "Flamengo", mercadoOriginal: "Chutes", selecaoOriginal: "Pedro 2+", substituicao: "UNKNOWN" as const, evidencia: "" },
      },
      provider: "gemini",
    });
    const [prop] = await sendDm(78, "1u", { fileId: "print-78" });
    expect(prop).toContain("👤 Pedro (Flamengo): Chutes · Pedro 2+");
  });

  it("recusa do guard só responde na conversa: sem telemetria, pendência nem post guardado", async () => {
    const bankroll = await seedChannelBankroll(db);
    await sendDm(73, POST_TEXT.replace("ODD: 2.10", "ODD: @185"));
    expect(await chooseBankroll(73, bankroll.id)).toEqual(["⚠️ Rejeitada: odd alta demais para o mercado\n\nEscolha outro tipster ou cancele:"]);
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await channelTraces()).toBe(0);
    expect(await db.prisma.operationalAction.count()).toBe(0);
    expect(alertMocks.sendOperatorNotification).not.toHaveBeenCalled();
    // A prévia continua de pé: o dono pode escolher outra banca.
    expect(await db.prisma.telegramDmDraft.count()).toBe(1);
  });
});

describe("canal e DM gravam a mesma aposta canônica", () => {
  const posts = [
    ["⚽ Verdao vs Santos", "Data: 15/06 16:00", "Liga: Brasileiro Serie A", "Mercado: Empate Anula a Aposta", "Entrada: Verdao DNB", "ODD: 1.90", "Stake: 1u"],
    ["⚽ Flamengo vs Palmeiras", "Data: 15/06 16:00", "Entrada: Palmeiras dc", "ODD: 1.40", "Stake: 1u"],
    ["Jogo: Mogi x Franca", "Data: 15/06 16:00", "Entrada: Mogi", "ODD: 1.80", "Stake: 1u"],
  ].map((lines) => lines.join("\n"));
  const canonical = [
    {
      evento: "Verdao vs Santos", pais: "Brazil", competicao: "Brasileiro Serie A", mercado: "Handicap – Match",
      selecao: "Verdao 0", esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportSource: "EMOJI",
    },
    {
      evento: "Flamengo vs Palmeiras", pais: "", competicao: "", mercado: "Double Chance",
      selecao: "Draw or Palmeiras", esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportSource: "EMOJI",
    },
    {
      evento: "Mogi vs Franca", pais: "", competicao: "", mercado: "Moneyline",
      selecao: "Mogi", esporte: "Unknown", sportResolutionStatus: "PENDING", sportSource: "UNRESOLVED",
    },
  ];

  /** "Verdao" é o "Palmeiras SP" da Pinnacle: nome de tipster confirmado na ficha do time. */
  async function seedPalmeirasCard() {
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-palmeiras", flashscoreName: "Palmeiras", country: "Brazil",
      pinnacleNames: [{ name: "Palmeiras SP" }], tipsterNames: [{ name: "Verdao" }],
    });
  }
  const storedTerms = (source: string) => db.prisma.bet.findMany({
    where: { source }, orderBy: { sourceExternalId: "asc" },
    select: { evento: true, pais: true, competicao: true, mercado: true, selecao: true, esporte: true, sportResolutionStatus: true, sportSource: true },
  });
  const channelPost = (messageId: number, text: string) => processTelegramJob({ api: {} as Api, boss: boss as unknown as PgBoss, token: "token" }, {
    kind: "channel_post", chatId: String(CHANNEL_ID), messageId, text, postDate: POST_DATE.toISOString(),
  });

  it("DNB com apelido do time, dupla chance e esporte sem sinal saem iguais pelos dois caminhos, com o nome do tipster", async () => {
    await seedChannelBankroll(db);
    const dmBankroll = await db.prisma.bankroll.create({ data: { nome: "Banca DM", slug: "banca-dm", valorUnidade: 100 } });
    // A ficha que traduz "Verdao" não troca o nome na captura.
    await seedPalmeirasCard();

    for (const [index, text] of posts.entries()) await channelPost(980 + index, text);
    expect(await storedTerms(`telegram-channel:${CHANNEL_ID}`)).toEqual(canonical);

    for (const [index, text] of posts.entries()) {
      await sendDm(990 + index, text);
      await chooseBankroll(990 + index, dmBankroll.id);
    }
    expect(await storedTerms(`telegram-dm:${OWNER_CHAT}:${dmBankroll.id}`)).toEqual(canonical);
  });

  it.each([["o canal", true], ["a DM", false]])(
    "o pick que o canal grava com o apelido e a DM sem esporte é uma aposta só, com %s antes",
    async (_first, channelFirst) => {
      const bankroll = await seedChannelBankroll(db);
      await seedPalmeirasCard();
      // O canal diz o esporte e a liga; a DM manda o mesmo pick sem eles.
      const channelText = ["⚽ Verdao vs Santos", "Data: 15/06 16:00", "Liga: Brasileiro Serie A", "Entrada: Verdao", "ODD: 1.90", "Stake: 1u"].join("\n");
      const dmText = ["Verdao vs Santos", "Data: 15/06 16:00", "Entrada: Verdao", "ODD: 1.90", "Stake: 1u"].join("\n");
      if (channelFirst) {
        expect(await channelPost(995, channelText)).toMatchObject({ kind: "registered" });
        await sendDm(996, dmText);
        expect(await chooseBankroll(996, bankroll.id)).toEqual([expect.stringMatching(/^♻️ Já registrada em Carteira Tips\./)]);
      } else {
        await sendDm(996, dmText);
        expect(await chooseBankroll(996, bankroll.id)).toEqual([expect.stringMatching(/^✅ Registrada em Carteira Tips!/)]);
        expect(await channelPost(995, channelText)).toMatchObject({ kind: "duplicate" });
      }
      expect(await db.prisma.bet.findMany({ select: { evento: true, esporte: true } }))
        .toEqual([channelFirst ? { evento: "Verdao vs Santos", esporte: "Soccer" } : { evento: "Verdao vs Santos", esporte: "Unknown" }]);
    },
  );

  it.each([["o canal", true], ["a DM", false]])(
    "a aposta que o fornecedor renomeou continua sendo o pick com o nome do tipster, com %s antes",
    async (_first, channelFirst) => {
      const bankroll = await seedChannelBankroll(db);
      // O enrich casou o jogo e a ficha conhece o apelido, mas a ficha não entra na comparação.
      await seedPalmeirasCard();
      const withSport = ["⚽ Verdao vs Santos", "Data: 15/06 16:00", "Liga: Brasileiro Serie A", "Entrada: Verdao", "ODD: 1.90", "Stake: 1u"].join("\n");
      const withoutSport = ["Verdao vs Santos", "Data: 15/06 16:00", "Entrada: Verdao", "ODD: 1.90", "Stake: 1u"].join("\n");
      if (channelFirst) {
        expect(await channelPost(995, withSport)).toMatchObject({ kind: "registered" });
      } else {
        await sendDm(996, withSport);
        expect(await chooseBankroll(996, bankroll.id)).toEqual([expect.stringMatching(/^✅ Registrada em Carteira Tips!/)]);
      }
      const [first] = await db.prisma.bet.findMany({ select: { id: true, evento: true, selecao: true, esporte: true } });
      expect(first).toMatchObject({ evento: "Verdao vs Santos", selecao: "Verdao", esporte: "Soccer" });
      // O casamento com a Pinnacle renomeia o evento e a seleção juntos, com o país e a liga dela.
      await db.prisma.bet.update({
        where: { id: first!.id },
        data: { evento: "Palmeiras SP vs Santos FC", selecao: "Palmeiras SP", pais: "Brazil", competicao: "Brazil - Serie A" },
      });

      if (channelFirst) {
        await sendDm(996, withoutSport);
        expect(await chooseBankroll(996, bankroll.id)).toEqual([expect.stringMatching(/^♻️ Já registrada em Carteira Tips\./)]);
      } else {
        expect(await channelPost(995, withoutSport)).toEqual({ kind: "duplicate", betId: first!.id });
      }
      expect(await db.prisma.bet.findMany({ select: { id: true, evento: true } }))
        .toEqual([{ id: first!.id, evento: "Palmeiras SP vs Santos FC" }]);
    },
  );

  it("a DM sem esporte que o resolvedor confirmou e a Pinnacle renomeou absorve o post do canal que chega depois", async () => {
    const bankroll = await seedChannelBankroll(db);
    await seedPalmeirasCard();
    const channelText = ["⚽ Verdao vs Santos", "Data: 15/06 16:00", "Liga: Brasileiro Serie A", "Entrada: Verdao", "ODD: 1.90", "Stake: 1u"].join("\n");
    const dmText = ["Verdao vs Santos", "Data: 15/06 16:00", "Entrada: Verdao", "ODD: 1.90", "Stake: 1u"].join("\n");
    await sendDm(996, dmText);
    expect(await chooseBankroll(996, bankroll.id)).toEqual([expect.stringMatching(/^✅ Registrada em Carteira Tips!/)]);
    const dm = await db.prisma.bet.findFirstOrThrow();
    expect(dm).toMatchObject({ evento: "Verdao vs Santos", esporte: "Unknown", sportResolutionStatus: "PENDING" });

    // O resolvedor acha o jogo no futebol e confirma pela porta de edição dele.
    await confirmBetSport({
      bet: dm, candidate: { sport: "Soccer", confidence: 95, source: "PROVIDER", provider: "flashscore" }, candidates: [], now: new Date(),
      identity: { data: dm.data, kickoffInferido: dm.kickoffInferido, competicao: dm.competicao, pais: dm.pais },
    });
    // O casamento com a Pinnacle renomeia o evento e a seleção, com o país e a liga dela.
    await db.prisma.bet.update({
      where: { id: dm.id },
      data: { evento: "Palmeiras SP vs Santos FC", selecao: "Palmeiras SP", pais: "Brazil", competicao: "Brazil - Serie A" },
    });

    expect(await channelPost(995, channelText)).toEqual({ kind: "duplicate", betId: dm.id });
    expect(await db.prisma.bet.findMany({ select: { id: true, evento: true, esporte: true } }))
      .toEqual([{ id: dm.id, evento: "Palmeiras SP vs Santos FC", esporte: "Soccer" }]);
  });

  it("o nome de tipster errado na ficha não junta dois jogos na dedupe", async () => {
    const bankroll = await seedChannelBankroll(db);
    // Nome errado: a ficha do Brentford tem "Chelsea" como nome de tipster confirmado.
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-brentford", flashscoreName: "Brentford", country: "England",
      pinnacleNames: [{ name: "Brentford" }], tipsterNames: [{ name: "Chelsea" }],
    });
    const tip = (evento: string) => [`⚽ ${evento}`, "Data: 15/06 16:00", "Entrada: Over 2.5", "ODD: 1.90", "Stake: 1u"].join("\n");

    expect(await channelPost(995, tip("Brentford vs Arsenal"))).toMatchObject({ kind: "registered" });
    await sendDm(996, tip("Chelsea vs Arsenal"));
    expect(await chooseBankroll(996, bankroll.id)).toEqual([expect.stringMatching(/^✅ Registrada em Carteira Tips!/)]);
    expect(await db.prisma.bet.findMany({ orderBy: { sourceExternalId: "asc" }, select: { evento: true, selecao: true } }))
      .toEqual([{ evento: "Brentford vs Arsenal", selecao: "Over 2.5" }, { evento: "Chelsea vs Arsenal", selecao: "Over 2.5" }]);
  });

  it.each([["o canal", true], ["a DM", false]])(
    "o nome ambíguo da DM sem liga é lido no país e na competição do canal, com %s antes",
    async (_first, channelFirst) => {
      const bankroll = await seedChannelBankroll(db);
      for (const [name, country] of [["Atletico Mineiro", "Brazil"], ["Atletico Madrid", "Spain"]] as const) {
        await seedTeamCard(db.prisma, {
          flashscoreTeamId: `fs-${name}`, flashscoreName: name, country,
          pinnacleNames: [{ name }], tipsterNames: country === "Brazil" ? [{ name: "Atletico" }] : [],
        });
      }
      const channelText = ["⚽ Atletico vs Santos", "Data: 15/06 16:00", "Liga: Brasileiro Serie A", "Entrada: Atletico", "ODD: 1.90", "Stake: 1u"].join("\n");
      const dmText = ["Atletico vs Santos", "Data: 15/06 16:00", "Entrada: Atletico", "ODD: 1.90", "Stake: 1u"].join("\n");
      if (channelFirst) {
        expect(await channelPost(997, channelText)).toMatchObject({ kind: "registered" });
        await sendDm(998, dmText);
        expect(await chooseBankroll(998, bankroll.id)).toEqual([expect.stringMatching(/^♻️ Já registrada em Carteira Tips\./)]);
      } else {
        await sendDm(998, dmText);
        expect(await chooseBankroll(998, bankroll.id)).toEqual([expect.stringMatching(/^✅ Registrada em Carteira Tips!/)]);
        expect(await channelPost(997, channelText)).toMatchObject({ kind: "duplicate" });
      }
      expect(await db.prisma.bet.findMany({ select: { evento: true, esporte: true } }))
        .toEqual([channelFirst ? { evento: "Atletico vs Santos", esporte: "Soccer" } : { evento: "Atletico vs Santos", esporte: "Unknown" }]);
    },
  );
});
