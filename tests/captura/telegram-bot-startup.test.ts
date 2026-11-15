import type { Bot as GrammyBot } from "grammy";
import type * as Grammy from "grammy";
import type { PgBoss } from "pg-boss";
import type { Update } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type JobHandler = (jobs: Array<{ id?: string; data: unknown; retryCount?: number; retryLimit?: number }>) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  queues: new Set<string>(), capture: vi.fn(), register: vi.fn(), work: vi.fn(),
  process: vi.fn(async () => {}), lastAttempt: vi.fn(async () => false),
  deferred: vi.fn(async () => undefined), completeAlbum: vi.fn(async () => true),
  handlers: new Map<string, (jobs: Array<{ id?: string; data: unknown; retryCount?: number }>) => Promise<unknown>>(),
  setWebhook: vi.fn(),
  /** Ligado, o bot nasce sem `botInfo` e o `init` chama o getMe. */
  getMe: null as null | (() => Promise<unknown>),
  env: {} as Record<string, string | undefined>,
  update: { update_id: 1, channel_post: { message_id: 64, date: 1789270837,
    chat: { id: -100123, type: "channel", title: "Synthetic" },
    photo: [{ file_id: "synthetic", file_unique_id: "synthetic", width: 450, height: 87 }],
  } } as Update,
}));
vi.mock("grammy", async original => {
  const actual = await original<typeof Grammy>();
  return { ...actual, Bot: class extends actual.Bot {
    constructor(token: string) {
      super(token, mocks.getMe ? {} : { botInfo: { id: 123, is_bot: true, first_name: "Test", username: "test_bot",
        can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
        can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
        allows_users_to_create_topics: false, can_manage_bots: false, supports_guest_queries: false,
        supports_join_request_queries: false,
      } });
      this.api.setWebhook = mocks.setWebhook;
      if (mocks.getMe) this.api.getMe = mocks.getMe as never;
    }
  } };
});
vi.mock("@/src/infra/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/src/infra/privacy", () => ({ privacyHash: (x: string) => x }));
vi.mock("@/src/jobs/queues", () => ({ registerQueue: mocks.register }));
vi.mock("@/src/services/ops/telemetry", () => ({ workObserved: mocks.work }));
vi.mock(import("@/src/telegram/dm"), () => ({ registerDmCallbackHandler: () => {} }));
vi.mock(import("@/src/telegram/live-handlers"), () => ({
  registerTelegramLiveHandlers: (bot: GrammyBot) => bot.on("channel_post:photo", async () => {
    expect([...mocks.queues].sort()).toEqual(["telegram.deferred", "telegram.updates"]);
    await mocks.capture();
  }),
}));
vi.mock(import("@/src/telegram/webhook-health"), () => ({ startWebhookHealthCheck: () => {} }));
vi.mock(import("@/src/telegram/deferred"), () => ({
  MediaAlbumCaptionPendingError: class extends Error { constructor(readonly mediaGroupId: string, readonly attempt: number) { super(); } },
  processTelegramDeferredJob: mocks.deferred,
}));
vi.mock(import("@/src/services/capture/channel/media-album"), async (original) => ({ ...await original(), completeMediaAlbum: mocks.completeAlbum }));
vi.mock(import("@/src/telegram/processing"), () => ({ logAndScheduleFollowups: async () => {}, processTelegramJob: mocks.process, telegramLogContext: () => ({ kind: "telegram_update" }) }));
vi.mock("@/src/services/ops/dlq/handler", () => ({ isLastTelegramAttempt: mocks.lastAttempt }));
import { GrammyError, HttpError } from "grammy";
import { startTelegramBot } from "@/src/telegram/bot";
import { TelegramParseRetryError } from "@/src/services/capture/reading/retry-error";

const WEBHOOK_ENV = { TELEGRAM_TOKEN: "123:test", TELEGRAM_WEBHOOK_URL: "https://example.invalid/hook", TELEGRAM_WEBHOOK_SECRET: "test" };

beforeEach(() => {
  vi.clearAllMocks(); mocks.queues.clear(); mocks.handlers.clear();
  mocks.env = { ...WEBHOOK_ENV };
  mocks.getMe = null;
  mocks.process.mockReset().mockResolvedValue(undefined);
  mocks.lastAttempt.mockReset().mockResolvedValue(false);
  mocks.deferred.mockReset().mockResolvedValue(undefined);
  mocks.setWebhook.mockResolvedValue(true);
  mocks.register.mockImplementation(async (_boss, name: string) => { mocks.queues.add(name); });
  mocks.work.mockImplementation(async (_boss, name: string, handler: JobHandler) => {
    mocks.handlers.set(name, handler);
    if (name === "telegram.updates") await handler([{ data: { kind: "telegram_update", update: mocks.update } }]);
  });
});

it("processa o update pendente entregue assim que o consumidor ordenado abre durante o boot", async () => {
  await startTelegramBot({} as PgBoss);
  expect(mocks.capture).toHaveBeenCalledTimes(1);
  expect(mocks.setWebhook).toHaveBeenCalledWith("https://example.invalid/hook", expect.objectContaining({ secret_token: "test" }));
});

it("erro do handler sobe sem o envelope do grammY, para o retry e a dead-letter", async () => {
  await startTelegramBot({} as PgBoss);
  mocks.capture.mockRejectedValueOnce(new TypeError("falha sintética"));
  const run = mocks.handlers.get("telegram.updates")!;
  await expect(run([{ data: { kind: "telegram_update", update: { ...mocks.update, update_id: 2 } }, retryCount: 0 }]))
    .rejects.toThrow(TypeError);
});

it("payload fora do contrato vai direto para a dead-letter com o motivo, sem retry", async () => {
  await startTelegramBot({} as PgBoss);
  await expect(mocks.handlers.get("telegram.updates")!([{ id: "job-ruim", data: { kind: "channel_photo", chatId: "-1" } }]))
    .resolves.toEqual([{ id: "job-ruim", status: "deadletter", output: {
      name: "InvalidTelegramJobError", message: expect.stringMatching(/telegram\.updates fora do contrato/),
    } }]);
  expect(mocks.work).toHaveBeenCalledWith({}, "telegram.updates", expect.any(Function), expect.objectContaining({ perJobResults: true }));
});

describe("última tentativa de um post que a IA recusou com provedor fora", () => {
  const job = { id: "job-post", data: { kind: "channel_post", chatId: "-100123", messageId: 70, text: "tip", postDate: "2026-09-23T12:00:00.000Z" }, retryCount: 4, retryLimit: 4 };

  it("vira a recusa guardada no erro, sem ir para a dead-letter", async () => {
    await startTelegramBot({} as PgBoss);
    const onExhausted = vi.fn(async () => {});
    mocks.process.mockRejectedValueOnce(new TelegramParseRetryError("texto", 70, { onExhausted }));
    mocks.lastAttempt.mockResolvedValueOnce(true);
    await expect(mocks.handlers.get("telegram.updates")!([job])).resolves.toEqual([{ id: "job-post", status: "completed" }]);
    expect(onExhausted).toHaveBeenCalledOnce();
    expect(mocks.lastAttempt).toHaveBeenCalledWith("telegram.updates", expect.objectContaining({ retryCount: 4, retryLimit: 4 }));
  });

  it("antes da última tentativa, ou sem recusa guardada, a fila repete", async () => {
    await startTelegramBot({} as PgBoss);
    const onExhausted = vi.fn(async () => {});
    mocks.process.mockRejectedValueOnce(new TelegramParseRetryError("texto", 70, { onExhausted }));
    await expect(mocks.handlers.get("telegram.updates")!([job])).rejects.toBeInstanceOf(TelegramParseRetryError);
    mocks.process.mockRejectedValueOnce(new TelegramParseRetryError("texto", 70));
    mocks.lastAttempt.mockResolvedValue(true);
    await expect(mocks.handlers.get("telegram.updates")!([job])).rejects.toBeInstanceOf(TelegramParseRetryError);
    expect(onExhausted).not.toHaveBeenCalled();
  });
});

describe("última tentativa de um álbum que a IA recusou com provedor fora", () => {
  const job = { id: "job-album", data: { kind: "media_album_flush", chatId: "-100123", mediaGroupId: "alb-1" }, retryCount: 6, retryLimit: 6 };

  it("vira a recusa guardada no erro e fecha o álbum, sem ir para a dead-letter", async () => {
    await startTelegramBot({} as PgBoss);
    const onExhausted = vi.fn(async () => {});
    mocks.deferred.mockRejectedValueOnce(new TelegramParseRetryError("foto", 70, { onExhausted }));
    mocks.lastAttempt.mockResolvedValueOnce(true);
    await expect(mocks.handlers.get("telegram.deferred")!([job])).resolves.toBeUndefined();
    expect(onExhausted).toHaveBeenCalledOnce();
    expect(mocks.completeAlbum).toHaveBeenCalledWith("alb-1");
    expect(mocks.lastAttempt).toHaveBeenCalledWith("telegram.deferred", expect.objectContaining({ retryCount: 6, retryLimit: 6 }));
  });

  it("antes da última tentativa a fila repete, com o álbum aberto", async () => {
    await startTelegramBot({} as PgBoss);
    const onExhausted = vi.fn(async () => {});
    mocks.deferred.mockRejectedValueOnce(new TelegramParseRetryError("foto", 70, { onExhausted }));
    await expect(mocks.handlers.get("telegram.deferred")!([job])).rejects.toBeInstanceOf(TelegramParseRetryError);
    expect(onExhausted).not.toHaveBeenCalled();
    expect(mocks.completeAlbum).not.toHaveBeenCalled();
  });
});

it("o boot registra e consome só a fila ordenada e a do álbum", async () => {
  await startTelegramBot({} as PgBoss);
  expect([...mocks.queues].sort()).toEqual(["telegram.deferred", "telegram.updates"]);
  expect([...mocks.handlers.keys()].sort()).toEqual(["telegram.deferred", "telegram.updates"]);
});

it("sem URL do webhook o bot não sobe", async () => {
  mocks.env = { TELEGRAM_TOKEN: "123:test" };
  await expect(startTelegramBot({} as PgBoss)).rejects.toThrow(/TELEGRAM_WEBHOOK_URL/);
  expect(mocks.work).not.toHaveBeenCalled();
});

it("não abre consumidores quando a preparação de uma fila falha", async () => {
  mocks.register.mockImplementation(async (_boss, name: string) => {
    if (name === "telegram.deferred") throw new Error("synthetic queue failure");
    mocks.queues.add(name);
  });
  await expect(startTelegramBot({} as PgBoss)).rejects.toThrow("synthetic queue failure");
  expect(mocks.work).not.toHaveBeenCalled(); expect(mocks.capture).not.toHaveBeenCalled();
});

describe("Telegram instável no boot", () => {
  const telegramDown = () => new HttpError("Network request for 'getMe' failed!", new Error("fetch failed"));
  const telegramError = (code: number) => new GrammyError("recusado", { ok: false, error_code: code, description: "x" }, "setWebhook", {});
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("erro pontual no setWebhook é repetido e o bot sobe", async () => {
    mocks.setWebhook.mockRejectedValueOnce(telegramDown()).mockRejectedValueOnce(telegramError(502)).mockResolvedValue(true);
    const started = startTelegramBot({} as PgBoss);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(started).resolves.toBeUndefined();
    expect(mocks.setWebhook).toHaveBeenCalledTimes(3);
  });

  it("setWebhook que o Telegram recusa não é repetido, e o que não volta desiste na terceira", async () => {
    mocks.setWebhook.mockRejectedValue(telegramError(401));
    await expect(startTelegramBot({} as PgBoss)).rejects.toThrow(GrammyError);
    expect(mocks.setWebhook).toHaveBeenCalledOnce();

    mocks.setWebhook.mockReset().mockRejectedValue(telegramDown());
    const started = expect(startTelegramBot({} as PgBoss)).rejects.toThrow(HttpError);
    await vi.advanceTimersByTimeAsync(10_000);
    await started;
    expect(mocks.setWebhook).toHaveBeenCalledTimes(3);
  });

  it("getMe sem resposta falha o boot no prazo, em vez de segurar o worker para sempre", async () => {
    mocks.getMe = vi.fn(async () => { throw telegramDown(); });
    const started = expect(startTelegramBot({} as PgBoss)).rejects.toThrow(/não respondeu ao getMe/);
    await vi.advanceTimersByTimeAsync(61_000);
    await started;
    expect(mocks.register).not.toHaveBeenCalled();
  });
});
