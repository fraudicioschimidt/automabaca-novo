import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError, type Api, type Bot } from "grammy";
import type { PgBoss } from "pg-boss";

const mocks = vi.hoisted(() => ({
  allowedChats: "123",
  deleteDraft: vi.fn(),
  loadDraft: vi.fn(),
  saveDraft: vi.fn(),
  findCapture: vi.fn(),
  listBankrolls: vi.fn(),
  prepare: vi.fn(),
  register: vi.fn(),
  enqueue: vi.fn(),
  enqueueSport: vi.fn(),
  alert: vi.fn(),
  logError: vi.fn(),
  extractText: vi.fn(),
  extractImage: vi.fn(),
  financialContext: vi.fn(),
  download: vi.fn(),
}));

vi.mock("@/src/infra/env", () => ({
  getEnv: () => ({ TELEGRAM_ALLOWED_CHATS: mocks.allowedChats }),
  telegramAllowedChats: () => ({ chats: new Set(String(mocks.allowedChats ?? "").split(",").map((id) => id.trim()).filter(Boolean)), users: [] }),
}));
vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
  }),
}));
vi.mock(import("@/src/services/capture/dm-draft"), async (original) => ({
  ...await original(),
  deleteTelegramDmDraft: mocks.deleteDraft,
  loadTelegramDmDraft: mocks.loadDraft,
  saveTelegramDmDraft: mocks.saveDraft,
}));
vi.mock("@/src/services/bankrolls/lookup", () => ({
  findBankrollCaptureById: mocks.findCapture,
  listBankrollsParaSelecao: mocks.listBankrolls,
}));
vi.mock(import("@/src/services/capture/preparation/prepare-capture"), () => ({
  prepareBetForCapture: mocks.prepare,
  captureItemRef: (chatId: bigint | string, messageId: number) => ({ chatIdHash: `hash:${chatId}`, messageId }),
}));
vi.mock(import("@/src/telegram/photo-download"), async (importOriginal) => {
  const real = await importOriginal();
  mocks.download.mockImplementation(real.downloadTelegramPhoto);
  return { ...real, downloadTelegramPhoto: mocks.download };
});
vi.mock(import("@/src/services/bets/register"), () => ({ registerBet: mocks.register }));
vi.mock(import("@/src/services/capture/capture-financial-context"), () => ({ captureFinancialContext: mocks.financialContext }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ enqueueSharpEnrich: mocks.enqueue }));
vi.mock("@/src/services/scheduling/enqueue-sport-resolution", () => ({
  enqueueSportResolution: mocks.enqueueSport,
}));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperationalAlert: mocks.alert }));
vi.mock(import("@/src/services/capture/reading/extract-bet"), () => ({
  extractBetFromText: mocks.extractText,
  extractBetFromImage: mocks.extractImage,
}));

import { telegramDmSource } from "@/src/domain/telegram-source";
import { confirmedSportDecision } from "@/src/domain/sports/detect";
import { answerDmMessage, buildDmKeyboard } from "@/src/services/capture/dm";
import { dmMessageJob, dmPhotoLoader, registerDmCallbackHandler } from "@/src/telegram/dm";
import { TelegramParseRetryError } from "@/src/services/capture/reading/retry-error";

const DRAFT = {
  bet: {
    evento: "Time A vs Time B",
    esporte: "Soccer",
    competicao: "Liga",
    pais: "Brasil",
    mercado: "Total - Match",
    selecao: "Under 2.5",
    odds: 1.9,
    stake: 1,
    data: new Date("2026-07-23T18:00:00Z"),
    casaDeAposta: "Bet365",
  },
  caption: "tip",
  imageFileId: null,
  postDate: new Date("2026-07-22T12:00:00Z"),
};

/** A prévia depois do guard da banca, com o esporte decidido na preparação. */
const PREPARED = { ...DRAFT.bet, sportResolution: confirmedSportDecision("Soccer", "TEXT", 95, []) };

function callbackHandler() {
  const handlers = new Map<string, (ctx: never) => Promise<void>>();
  const bot = {
    on: vi.fn((filter: string, handler: (ctx: never) => Promise<void>) => {
      handlers.set(filter, handler);
    }),
  } as unknown as Bot;
  registerDmCallbackHandler(bot, {} as PgBoss, "token");
  const handler = handlers.get("callback_query:data");
  if (!handler) throw new Error("handler callback_query:data não registrado");
  return handler;
}

function callbackContext(data = "dm:bank-1") {
  return {
    chat: { id: 123 },
    callbackQuery: {
      data,
      message: {
        chat: { id: 123 },
        reply_to_message: { chat: { id: 123 }, message_id: 77 },
      },
    },
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageText: vi.fn(async (..._args: unknown[]) => {}),
    editMessageReplyMarkup: vi.fn(async (..._args: unknown[]) => {}),
  };
}

/** A resposta da Bot API a uma edição que deixaria a mensagem igual. */
function notModified(method: string) {
  const description = "Bad Request: message is not modified: specified new message content and reply markup are exactly the same";
  return new GrammyError(`Call to '${method}' failed! (400: ${description})`, { ok: false, error_code: 400, description }, method, {});
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowedChats = "123";
  mocks.deleteDraft.mockResolvedValue(true);
  mocks.loadDraft.mockResolvedValue(DRAFT);
  mocks.financialContext.mockResolvedValue({ id: "financial-context-1" });
  mocks.findCapture.mockResolvedValue({ slug: "treino", capturePolicy: "AUTO" });
  mocks.listBankrolls.mockResolvedValue([{ id: "bank-1", nome: "Treino", slug: "treino" }]);
  mocks.prepare.mockResolvedValue({ ok: true, bet: PREPARED });
  mocks.register.mockResolvedValue({
    created: true,
    betId: "bet-1",
    sportResolutionStatus: "CONFIRMED",
  });
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.enqueueSport.mockResolvedValue("job-1");
  mocks.alert.mockResolvedValue(undefined);
  mocks.extractText.mockReset();
  mocks.extractImage.mockReset();
  mocks.extractText.mockResolvedValue({ bet: null, provider: "gemini", notBet: true });
  mocks.extractImage.mockResolvedValue({ bet: null, provider: "gemini", notBet: true });
});

describe("seletor de banca da DM", () => {
  it("distingue homônimos mesmo em páginas diferentes, sem colidir com um nome literal", () => {
    const banks = Array.from({ length: 10 }, (_, index) => ({ id: `b${index}`, nome: `Canal ${index}`, slug: `canal-${index}` }));
    banks[0] = { id: "b0", nome: "Tips", slug: "tips" };
    banks[1] = { id: "b1", nome: "Tips (tips)", slug: "literal" };
    banks[9] = { id: "b9", nome: "Tips", slug: "tips-2" };
    const buttons = [0, 1].flatMap((page) => buildDmKeyboard(banks, page).inline_keyboard.flat())
      .filter((button) => /^dm:b/.test(button.callback_data));
    expect(buttons).toHaveLength(10);
    expect(new Set(buttons.map((button) => button.text)).size).toBe(10);
    expect(buttons.find((button) => button.callback_data === "dm:b0")?.text).toContain("tips");
    expect(buttons.find((button) => button.callback_data === "dm:b9")?.text).toContain("tips-2");
    expect(buttons.find((button) => button.callback_data === "dm:b2")?.text).toBe("Canal 2");
  });

  it("pagina todas as bancas sem esconder as que passam da primeira tela", () => {
    const bancas = Array.from({ length: 18 }, (_, index) => ({
      id: `bank-${index + 1}`,
      nome: `Banca ${index + 1}`,
      slug: `banca-${index + 1}`,
    }));
    const first = buildDmKeyboard(bancas, 0).inline_keyboard.flat();
    const last = buildDmKeyboard(bancas, 2).inline_keyboard.flat();

    expect(first.some((button) => button.callback_data === "dm:bank-1")).toBe(true);
    expect(last.some((button) => button.callback_data === "dm:bank-18")).toBe(true);
    expect(last.some((button) => button.callback_data === "dm:page:1")).toBe(true);
  });

  it("toque na página que já está na tela encerra o spinner sem falhar o job", async () => {
    mocks.listBankrolls.mockResolvedValue(Array.from({ length: 18 }, (_, index) => ({ id: `bank-${index + 1}`, nome: `Banca ${index + 1}`, slug: `banca-${index + 1}` })));
    const ctx = callbackContext("dm:page:0");
    ctx.editMessageReplyMarkup.mockRejectedValue(notModified("editMessageReplyMarkup"));

    await expect(callbackHandler()(ctx as never)).resolves.toBeUndefined();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
  });

  it("toque de página antigo demais para confirmar ainda troca a página, sem falhar o job", async () => {
    mocks.listBankrolls.mockResolvedValue(Array.from({ length: 18 }, (_, index) => ({ id: `bank-${index + 1}`, nome: `Banca ${index + 1}`, slug: `banca-${index + 1}` })));
    const ctx = callbackContext("dm:page:1");
    const description = "Bad Request: query is too old and response timeout expired or query ID is invalid";
    ctx.answerCallbackQuery.mockRejectedValue(new GrammyError(
      `Call to 'answerCallbackQuery' failed! (400: ${description})`, { ok: false, error_code: 400, description }, "answerCallbackQuery", {},
    ));

    await expect(callbackHandler()(ctx as never)).resolves.toBeUndefined();
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledOnce();
  });

  it("a mesma recusa mostrada de novo não vira alerta nem apaga o seletor", async () => {
    mocks.prepare.mockResolvedValue({ ok: false, reason: "mercado_total_ambiguo", missing: ["mercado"] });
    const ctx = callbackContext();
    ctx.editMessageText.mockRejectedValue(notModified("editMessageText"));

    await callbackHandler()(ctx as never);

    expect(mocks.alert).not.toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenCalledOnce();
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining("Rejeitada"), expect.objectContaining({ reply_markup: expect.any(Object) }));
  });

  it("inclui a banca na origem para deduplicar cada destino separadamente", () => {
    expect(telegramDmSource("123", "bank-a")).toBe("telegram-dm:123:bank-a");
    expect(telegramDmSource("123", "bank-b")).not.toBe(telegramDmSource("123", "bank-a"));
  });

  it("responde ao callback antes de banco, guard e registro", async () => {
    const order: string[] = [];
    const ctx = callbackContext();
    ctx.answerCallbackQuery.mockImplementation(async () => { order.push("answer"); });
    mocks.loadDraft.mockImplementation(async () => { order.push("load"); return DRAFT; });
    mocks.prepare.mockImplementation(async () => { order.push("prepare"); return { ok: true, bet: PREPARED }; });
    mocks.register.mockImplementation(async () => {
      order.push("register");
      return { created: true, betId: "bet-1", sportResolutionStatus: "CONFIRMED" };
    });

    await callbackHandler()(ctx as never);

    expect(order[0]).toBe("answer");
    expect(order).toEqual(["answer", "load", "prepare", "register"]);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it("recusa do guard diz o motivo em português, do mesmo vocabulário do canal", async () => {
    mocks.prepare.mockResolvedValue({ ok: false, reason: "mercado_total_ambiguo", missing: ["mercado"] });
    const ctx = callbackContext();

    await callbackHandler()(ctx as never);

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining("Rejeitada: Total sem dizer a unidade (gols, escanteios ou cartões)"),
      expect.any(Object),
    );
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("recusa banca removida antes do capture guard", async () => {
    mocks.findCapture.mockResolvedValue(null);
    const ctx = callbackContext();

    await callbackHandler()(ctx as never);

    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringMatching(/não está mais disponível/i));
  });

  it("registra a DM com a origem e o schema do contrato de aposta", async () => {
    const ctx = callbackContext();

    await callbackHandler()(ctx as never);

    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({
      bankrollId: "bank-1",
      evento: DRAFT.bet.evento,
      mercado: DRAFT.bet.mercado,
      selecao: DRAFT.bet.selecao,
      odds: DRAFT.bet.odds,
      stake: DRAFT.bet.stake,
      source: "telegram-dm:123:bank-1",
      sourceExternalId: "77",
      actor: "telegram-dm",
      captureEvidence: expect.objectContaining({ parser: "telegram-dm" }),
    }), { financialContextId: "financial-context-1", captureFollowupOrigin: "telegram-dm" });
  });

  it("enfileira o enrich sharp e não alerta quando o esporte já está confirmado", async () => {
    const ctx = callbackContext();

    await callbackHandler()(ctx as never);

    expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), "bet-1");
    expect(mocks.enqueueSport).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringMatching(/Enriquecimento sharp em andamento/i),
      expect.any(Object),
    );
  });

  it("roteia para a fila de esporte quando o registro não confirmou o esporte", async () => {
    mocks.register.mockResolvedValue({
      created: true,
      betId: "bet-1",
      sportResolutionStatus: "PENDING",
    });
    const ctx = callbackContext();

    await callbackHandler()(ctx as never);

    expect(mocks.enqueueSport).toHaveBeenCalledWith(expect.anything(), "bet-1", {
      origem: "telegram-dm",
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("alerta quando a APOSTA não é registrada, não só quando o enrich falha", async () => {
    mocks.register.mockRejectedValue(new Error("deadlock na transação de captura"));
    const ctx = callbackContext();

    await callbackHandler()(ctx as never);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.stringContaining("deadlock"),
      expect.objectContaining({ source: "telegram.dm-register", autoResolve: false }),
    );
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringMatching(/deadlock/i),
    );
  });

  it("alerta sem desfazer o registro quando o enrich não enfileira", async () => {
    mocks.enqueue.mockRejectedValue(new Error("fila indisponível"));
    const ctx = callbackContext();

    await callbackHandler()(ctx as never);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.stringContaining("Time A vs Time B (tipster Treino)"),
      expect.objectContaining({ source: "bets.dm-enrich-enqueue", resourceId: "bet-1" }),
    );
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringMatching(/aguardando recuperação automática/i),
      expect.any(Object),
    );
  });

  it("só baixa a foto da prévia quando o guard precisa reler o print", async () => {
    mocks.loadDraft.mockResolvedValue({ ...DRAFT, imageFileId: "file-1" });
    mocks.download.mockResolvedValueOnce({ base64: "imagem", mimeType: "image/jpeg" });

    await callbackHandler()(callbackContext() as never);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      images: expect.any(Function),
      itemRef: { chatIdHash: "hash:123", messageId: 77 },
    }));

    mocks.prepare.mockImplementationOnce(async (params: { images: () => Promise<unknown[]> }) => {
      expect(await params.images()).toEqual([{ base64: "imagem", mimeType: "image/jpeg" }]);
      return { ok: true, bet: PREPARED };
    });
    await callbackHandler()(callbackContext() as never);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledWith(undefined, "token", "file-1");
  });

  it("remove o rascunho persistido ao cancelar", async () => {
    const ctx = callbackContext("dm:cancel");

    await callbackHandler()(ctx as never);

    expect(mocks.deleteDraft).toHaveBeenCalledWith({ chatId: "123", messageId: 77 });
    expect(ctx.answerCallbackQuery.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.editMessageText.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});

/** Texto com sinal de aposta que o leitor por regra não lê: vai à leitura por IA. */
const TIP = "🎾 Sinner vs Fritz\nEntrada: +22.5\n@1.90\n1u";

function messageContext(message: Record<string, unknown>) {
  return {
    chat: { id: 123, type: "private" },
    message: { message_id: 91, date: 1_786_000_000, ...message },
    reply: vi.fn(async () => ({})),
  };
}

/** A mensagem vira o job `dm_message` e roda como a fila roda. */
function processMessage(ctx: ReturnType<typeof messageContext>, api = {} as Api) {
  const job = dmMessageJob(ctx as never);
  if (!job || "reply" in job) throw new Error("mensagem sintética não virou job de DM");
  return answerDmMessage(job, { loadImage: dmPhotoLoader(api, "token"), reply: ctx.reply });
}

describe("rascunho numérico na DM", () => {
  const rascunho = [
    "⚽ Coquimbo Unido vs Colo Colo",
    "Entrada: Casa",
    "ODD: 2.10",
    "Stake:",
  ].join("\n");

  it("não chama o LLM nem registra quando o universal só perdeu o número", async () => {
    mocks.extractText.mockImplementation(async () => ({
      bet: { ...DRAFT.bet, odds: 1.9, stake: 1 },
      provider: "gemini",
    }));
    const ctx = messageContext({ text: rascunho });
    await processMessage(ctx);
    // Na DM o rascunho não espera edição: a resposta é a de quem não achou aposta.
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/^Não consegui identificar uma aposta/), expect.any(Object));
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.extractText).not.toHaveBeenCalled();
  });

  it("não baixa nem lê a foto quando a legenda é o mesmo rascunho", async () => {
    mocks.extractImage.mockResolvedValueOnce({
      bet: { ...DRAFT.bet, odds: 1.9, stake: 1 },
      provider: "gemini",
    });
    const ctx = messageContext({ photo: [{ file_id: "photo-1" }], caption: rascunho });
    await processMessage(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/^Não consegui identificar uma aposta/), expect.any(Object));
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.extractImage).not.toHaveBeenCalled();
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });
});

describe("extração inicial da DM", () => {
  it("encerra somente quando o LLM respondeu notBet explicitamente", async () => {
    const ctx = messageContext({ text: TIP });
    await processMessage(ctx);
    expect(mocks.extractText).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringMatching(/não consegui identificar uma aposta/i),
      expect.any(Object),
    );
  });

  it("quota/timeout falha o job para o retry da fila, sem resposta terminal", async () => {
    mocks.extractText.mockResolvedValueOnce({ bet: null, provider: null });
    const ctx = messageContext({ text: "🎾 Sinner vs Fritz\nEntrada: +22.5\n@1.90\n1u" });
    await expect(processMessage(ctx)).rejects.toBeInstanceOf(TelegramParseRetryError);
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("erro de download também volta pelo retry", async () => {
    const getFile = vi.fn(async () => { throw new Error("timeout Telegram"); });
    const ctx = messageContext({ photo: [{ file_id: "photo-1" }] });
    await expect(processMessage(ctx, { getFile } as unknown as Api)).rejects.toBeInstanceOf(TelegramParseRetryError);
    expect(mocks.extractImage).not.toHaveBeenCalled();
  });

  it("erro fora da leitura (banco fora) sobe como está, sem virar resposta ao dono", async () => {
    mocks.extractText.mockResolvedValueOnce({ bet: DRAFT.bet, provider: "gemini" });
    mocks.listBankrolls.mockRejectedValueOnce(new Error("connection refused"));
    const ctx = messageContext({ text: TIP });
    await expect(processMessage(ctx)).rejects.toThrow("connection refused");
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("retry posterior cria a prévia uma vez e apresenta as bancas", async () => {
    mocks.extractText.mockResolvedValueOnce({ bet: DRAFT.bet, provider: "gemini" });
    const sendMessage = vi.fn(async (..._args: unknown[]) => ({}));
    await answerDmMessage({
      kind: "dm_message",
      chatId: "123",
      messageId: 91,
      text: TIP,
      postDate: "2026-08-13T12:00:00.000Z",
    }, { loadImage: dmPhotoLoader({} as Api, "token"), reply: (text, other) => sendMessage("123", text, other) });

    expect(mocks.saveDraft).toHaveBeenCalledOnce();
    expect(mocks.saveDraft).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "123",
      messageId: 91,
      bet: DRAFT.bet,
    }));
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.stringMatching(/Em qual tipster/i),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
  });

  it("encerra job já enfileirado quando o chat perde autorização antes do retry", async () => {
    const reply = vi.fn();
    mocks.allowedChats = "999";
    mocks.extractText.mockResolvedValueOnce({ bet: DRAFT.bet, provider: "gemini" });
    await expect(answerDmMessage({
      kind: "dm_message", chatId: "123", messageId: 91, text: "tip", postDate: "2026-08-13T12:00:00.000Z",
    }, { loadImage: dmPhotoLoader({} as Api, "token"), reply })).resolves.toBeUndefined();

    expect(mocks.extractText).not.toHaveBeenCalled();
    expect(mocks.listBankrolls).not.toHaveBeenCalled();
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("allowlist vazia encerra retry de foto antes de baixar ou extrair a imagem", async () => {
    mocks.allowedChats = "";
    const getFile = vi.fn();
    const reply = vi.fn();
    await expect(answerDmMessage({
      kind: "dm_message",
      chatId: "123",
      messageId: 91,
      fileId: "photo-revoked",
      postDate: "2026-09-13T00:00:00.000Z",
    }, { loadImage: dmPhotoLoader({ getFile } as unknown as Api, "token"), reply })).resolves.toBeUndefined();

    expect(getFile).not.toHaveBeenCalled();
    expect(mocks.extractImage).not.toHaveBeenCalled();
    expect(mocks.listBankrolls).not.toHaveBeenCalled();
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("prévia da DM: o dono confere o que vai ser gravado", () => {
  const job = { kind: "dm_message" as const, chatId: "123", messageId: 91, text: TIP, postDate: "2026-08-13T12:00:00.000Z" };

  it("mostra mercado, período, data e placar ao vivo", async () => {
    mocks.extractText.mockResolvedValueOnce({
      bet: { ...DRAFT.bet, mercado: "Handicap – 1st Half", selecao: "Time A -0.5", liveScoreHome: 1, liveScoreAway: 0 },
      provider: "gemini",
    });
    const reply = vi.fn(async (..._args: unknown[]) => ({}));
    await answerDmMessage(job, { loadImage: dmPhotoLoader({} as Api, "token"), reply });
    const preview = String(reply.mock.calls[0]?.[0]);
    expect(preview).toContain("Handicap – 1st Half · 1º tempo");
    expect(preview).toContain("📅 23/07 15:00");
    expect(preview).toContain("🔴 Ao vivo, entrada com 1-0");
  });

  it("post sem data avisa que vale a data do envio", async () => {
    mocks.extractText.mockResolvedValueOnce({ bet: { ...DRAFT.bet, data: null }, provider: "gemini" });
    const reply = vi.fn(async (..._args: unknown[]) => ({}));
    await answerDmMessage(job, { loadImage: dmPhotoLoader({} as Api, "token"), reply });
    expect(String(reply.mock.calls[0]?.[0])).toContain("sem data no post");
  });

  it("a stake da legenda é a que a prévia mostra, como o clique grava", async () => {
    mocks.extractImage.mockResolvedValueOnce({ bet: { ...DRAFT.bet, stake: 2 }, provider: "gemini" });
    mocks.download.mockResolvedValueOnce({ base64: "img", mimeType: "image/jpeg" });
    const reply = vi.fn(async (..._args: unknown[]) => ({}));
    await answerDmMessage({ ...job, text: undefined, fileId: "photo-1", caption: "Time A x Time B\nUnder 2.5\n1u" }, { loadImage: dmPhotoLoader({} as Api, "token"), reply });
    const preview = String(reply.mock.calls[0]?.[0]);
    expect(preview).toContain("Under 2.5 @1.9 (1u)");
    expect(preview).not.toContain("⚠️");
    // O rascunho guarda a leitura: o clique refaz a preparação com a banca escolhida.
    expect(mocks.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ bet: expect.objectContaining({ stake: 2 }) }));
  });

  it("print com @ na legenda diferente da odd dele: a prévia avisa o que vale nas bancas de odd da legenda", async () => {
    mocks.listBankrolls.mockResolvedValue([
      { id: "bank-1", nome: "Treino", slug: "treino", capturePolicy: "AUTO" },
      { id: "bank-2", nome: "Canal", slug: "canal", capturePolicy: "CAPTION_ODD" },
    ]);
    mocks.extractImage.mockResolvedValueOnce({ bet: DRAFT.bet, provider: "gemini" });
    mocks.download.mockResolvedValueOnce({ base64: "img", mimeType: "image/jpeg" });
    const reply = vi.fn(async (..._args: unknown[]) => ({}));
    await answerDmMessage({ ...job, text: undefined, fileId: "photo-1", caption: "Under 2.5 @1.85\n1u" }, { loadImage: dmPhotoLoader({} as Api, "token"), reply });
    const preview = String(reply.mock.calls[0]?.[0]);
    expect(preview).toContain("Under 2.5 @1.9 (1u)");
    expect(preview).toContain("⚠️ Nos tipsters com \"Odd da legenda (@) manda\" vale @1.85 (legenda), não @1.9 (print).");
  });

  it("print com várias simples não grava só a primeira: avisa e não salva prévia", async () => {
    const second = { ...DRAFT.bet, evento: "Time C vs Time D" };
    mocks.extractImage.mockResolvedValueOnce({ bet: DRAFT.bet, bets: [DRAFT.bet, second], provider: "gemini" });
    mocks.download.mockResolvedValueOnce({ base64: "img", mimeType: "image/jpeg" });
    const reply = vi.fn(async (..._args: unknown[]) => ({}));
    await answerDmMessage({ ...job, text: undefined, fileId: "photo-1", caption: "0.5u cada" }, { loadImage: dmPhotoLoader({} as Api, "token"), reply });
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(String(reply.mock.calls[0]?.[0])).toMatch(/Achei 2 apostas/);
  });
});

describe("DM: leitura que parou numa dúvida ou num número", () => {
  const job = { kind: "dm_message" as const, chatId: "123", messageId: 91, text: TIP, postDate: "2026-08-13T12:00:00.000Z" };

  it("diz a dúvida que a leitura escreveu, não 'não consegui identificar'", async () => {
    mocks.extractText.mockResolvedValueOnce({
      bet: null, provider: null, incompleteDraft: true, missing: ["ambiguous_bet"],
      review: { reason: "ambiguous_bet", description: "\"Contra o Flamengo\" não diz se é vitória do Palmeiras ou dupla chance.", evidence: {} },
    });
    const reply = vi.fn(async (..._args: unknown[]) => ({}));
    await answerDmMessage(job, { loadImage: dmPhotoLoader({} as Api, "token"), reply });
    expect(String(reply.mock.calls[0]?.[0])).toMatch(/^Li a aposta, mas fiquei em dúvida: "Contra o Flamengo" não diz/);
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });

  it("diz o número que faltou", async () => {
    mocks.extractText.mockResolvedValueOnce({ bet: null, provider: "gemini", incompleteDraft: true, missing: ["odds"] });
    const reply = vi.fn(async (..._args: unknown[]) => ({}));
    await answerDmMessage(job, { loadImage: dmPhotoLoader({} as Api, "token"), reply });
    expect(String(reply.mock.calls[0]?.[0])).toMatch(/^Li a aposta, mas faltou a odd\./);
  });
});

describe("DM sem gastar IA à toa", () => {
  it.each(["/start", "/ajuda", "/start@AutomaBacaBot"])("%s explica o que a conversa faz, sem leitura", async (text) => {
    const ctx = messageContext({ text });
    await processMessage(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/print do bilhete.*texto da aposta[\s\S]*escolhe o tipster/i), expect.any(Object));
    expect(mocks.extractText).not.toHaveBeenCalled();
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });

  it.each(["bom dia", "tudo certo por aí?", "valeu"])("texto sem sinal de aposta (%s) responde sem chamar a IA", async (text) => {
    const ctx = messageContext({ text });
    await processMessage(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/não consegui identificar uma aposta/i), expect.any(Object));
    expect(mocks.extractText).not.toHaveBeenCalled();
  });

  it.each(["Palmeiras 1.85 ML", "Lakers -4.5", "Sinner 1.5", "Flamengo ML", "Palmeiras vence"])("tip curta '%s' vai à leitura", async (text) => {
    const ctx = messageContext({ text });
    await processMessage(ctx);
    expect(mocks.extractText).toHaveBeenCalledOnce();
  });

  it("texto que o leitor por regra lê segue para a prévia", async () => {
    const ctx = messageContext({ text: "⚽ Coquimbo Unido vs Colo Colo\nEntrada: Casa\nODD: 2.10\nStake: 1u" });
    await processMessage(ctx);
    expect(mocks.saveDraft).toHaveBeenCalledOnce();
    expect(mocks.extractText).not.toHaveBeenCalled();
  });

  it("foto sempre vai à leitura, mesmo com legenda sem sinal", async () => {
    mocks.download.mockResolvedValueOnce({ base64: "img", mimeType: "image/jpeg" });
    const ctx = messageContext({ photo: [{ file_id: "photo-1" }], caption: "olha essa" });
    await processMessage(ctx);
    expect(mocks.extractImage).toHaveBeenCalledOnce();
  });

  it("leitura recusada com um provedor fora: relança sem recusa para o fim das tentativas", async () => {
    mocks.extractText.mockResolvedValueOnce({ bet: null, provider: null, refusalWhenExhausted: { reason: "leitura_recusada_com_provedor_fora" } });
    const ctx = messageContext({ text: TIP });
    const error = await processMessage(ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TelegramParseRetryError);
    expect((error as TelegramParseRetryError).onExhausted).toBeUndefined();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("todos os provedores recusaram: responde ao dono em vez de relançar", async () => {
    mocks.extractText.mockResolvedValueOnce({ bet: null, provider: null, refused: { reason: "leitura_recusada_pela_ia", provider: null } });
    const ctx = messageContext({ text: TIP });
    await processMessage(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/não consegui identificar uma aposta/i), expect.any(Object));
  });
});
