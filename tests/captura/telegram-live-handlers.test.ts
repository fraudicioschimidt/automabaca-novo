import type { Api, Bot } from "grammy";
import type { PgBoss } from "pg-boss";
import { beforeEach, expect, it, vi } from "vitest";
import type * as Env from "@/src/infra/env";
import { TelegramParseRetryError } from "@/src/services/capture/reading/retry-error";

const mocks = vi.hoisted(() => ({
  process: vi.fn(),
  enqueue: vi.fn(),
  allowed: new Set(["77"]),
}));

vi.mock(import("@/src/telegram/processing"), () => ({ processTelegramJob: mocks.process }));
vi.mock("@/src/services/scheduling/enqueue-telegram-job", () => ({ enqueueTelegramJob: mocks.enqueue }));
vi.mock("@/src/infra/env", async (importOriginal) => ({
  ...await importOriginal<typeof Env>(),
  telegramAllowedChats: () => ({ chats: mocks.allowed, users: new Set<string>() }),
}));

import { registerTelegramLiveHandlers } from "@/src/telegram/live-handlers";

const context = { api: {} as Api, boss: {} as PgBoss, token: "test-token" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.process.mockResolvedValue({ kind: "registered", betId: "bet-1" });
  mocks.enqueue.mockResolvedValue("job-1");
});

function handlers() {
  const map = new Map<string, (ctx: unknown, next?: () => Promise<void>) => Promise<void>>();
  const bot = { on: (event: string, handler: (ctx: unknown) => Promise<void>) => map.set(event, handler) };
  registerTelegramLiveHandlers(bot as unknown as Bot, context);
  return map;
}

it("foto do canal é capturada na hora, dentro do job da fila ordenada", async () => {
  await handlers().get("channel_post:photo")!({
    channelPost: {
      chat: { id: -1001 },
      message_id: 42,
      date: 1_700_000_000,
      caption: "Over 2.5 @1.90",
      photo: [{ file_id: "small" }, { file_id: "large-file" }],
    },
  });
  expect(mocks.process).toHaveBeenCalledWith(context, {
    kind: "channel_photo",
    chatId: "-1001",
    messageId: 42,
    caption: "Over 2.5 @1.90",
    postDate: new Date(1_700_000_000_000).toISOString(),
    fileId: "large-file",
  });
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("documento-imagem vira captura de foto", async () => {
  await handlers().get("channel_post:document")!({
    channelPost: {
      chat: { id: -1002 },
      message_id: 7,
      date: 1_700_000_100,
      caption: "tip",
      document: { file_id: "doc-img", mime_type: "image/jpeg" },
    },
  });
  expect(mocks.process).toHaveBeenCalledWith(context, expect.objectContaining({ kind: "channel_photo", fileId: "doc-img" }));
});

it("falha da captura sobe para o retry da fila em vez de ser engolida", async () => {
  mocks.process.mockRejectedValueOnce(new Error("OCR fora"));
  await expect(handlers().get("channel_post:text")!({
    channelPost: { chat: { id: -1003 }, message_id: 1, date: 1_700_000_000, text: "tip" },
  })).rejects.toThrow("OCR fora");
});

it("preserva o autor identificado da reação, com data e update_id", async () => {
  await handlers().get("message_reaction")!({ update: { update_id: 493 }, messageReaction: {
    date: 1789257600, chat: { id: -42 }, message_id: 7, user: { id: 123 }, new_reaction: [{ type: "emoji", emoji: "👎" }],
  } });
  expect(mocks.process).toHaveBeenCalledWith(context, expect.objectContaining({
    kind: "reaction", occurredAt: "2026-09-13T00:00:00.000Z", updateId: 493, actorUserId: "123", chatId: "-42", messageId: 7,
    thumbsDownPresent: true,
  }));
});

it("contagem agregada e autor como canal permanecem sem identidade pessoal", async () => {
  const registered = handlers();
  await registered.get("message_reaction")!({ messageReaction: {
    chat: { id: -42 }, message_id: 7, actor_chat: { id: 123 }, new_reaction: [{ type: "emoji", emoji: "👎" }],
  } });
  await registered.get("message_reaction_count")!({ update: { update_id: 777 }, messageReactionCount: {
    date: 1789257600, chat: { id: -42 }, message_id: 7, reactions: [{ type: { type: "emoji", emoji: "👎" }, total_count: 1 }],
  } });
  for (const [, job] of mocks.process.mock.calls) expect(job).not.toHaveProperty("actorUserId");
  expect(mocks.process).toHaveBeenLastCalledWith(context, expect.objectContaining({
    occurredAt: "2026-09-13T00:00:00.000Z", updateId: 777, thumbsDownPresent: true,
  }));
});

it("legenda editada de foto vai para a releitura da imagem; sem imagem, para a edição de texto", async () => {
  const registered = handlers();
  const base = { chat: { id: -1003 }, message_id: 9, date: 1_700_000_000, edit_date: 1_700_000_600, caption: "Stake: 1u" };
  await registered.get("edited_channel_post:caption")!({
    editedChannelPost: { ...base, photo: [{ file_id: "p-small" }, { file_id: "p-large" }], media_group_id: "g1" },
  });
  expect(mocks.process).toHaveBeenLastCalledWith(context, {
    kind: "edited_channel_photo", chatId: "-1003", messageId: 9, caption: "Stake: 1u",
    postDate: new Date(1_700_000_000_000).toISOString(), editDate: new Date(1_700_000_600_000).toISOString(),
    fileId: "p-large", mediaGroupId: "g1",
  });
  await registered.get("edited_channel_post:caption")!({ editedChannelPost: { ...base, video: { file_id: "v" } } });
  expect(mocks.process).toHaveBeenLastCalledWith(context, expect.objectContaining({ kind: "edited_channel_post", text: "Stake: 1u" }));
});

function dm(text: string) {
  return {
    chat: { id: 77, type: "private" },
    message: { message_id: 30, date: 1_700_000_000, text },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

it("DM passa pelo mesmo processamento; erro que não é de leitura sobe para o retry", async () => {
  const ctx = dm("tip");
  mocks.process.mockRejectedValueOnce(new Error("banco fora"));
  await expect(handlers().get("message")!(ctx, vi.fn())).rejects.toThrow("banco fora");
  expect(mocks.process).toHaveBeenCalledWith(context, {
    kind: "dm_message", chatId: "77", messageId: 30, postDate: new Date(1_700_000_000_000).toISOString(), text: "tip",
  });
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(ctx.reply).not.toHaveBeenCalled();
});

it("DM com a extração fora do ar avisa o dono uma vez e deixa a mensagem na fila", async () => {
  const ctx = dm("tip");
  mocks.process.mockRejectedValueOnce(new TelegramParseRetryError("texto", 30));
  await handlers().get("message")!(ctx, vi.fn());
  expect(mocks.enqueue).toHaveBeenCalledWith(context.boss, expect.objectContaining({ kind: "dm_message", messageId: 30 }));
  expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("⏳"), { reply_parameters: { message_id: 30 } });
});

it("mensagem de grupo segue adiante e DM de chat não autorizado é ignorada", async () => {
  const next = vi.fn();
  await handlers().get("message")!({ ...dm("tip"), chat: { id: -5, type: "group" } }, next);
  expect(next).toHaveBeenCalledOnce();
  await handlers().get("message")!({ ...dm("tip"), chat: { id: 99, type: "private" } }, vi.fn());
  expect(mocks.process).not.toHaveBeenCalled();
});

it("print mandado como arquivo na DM vai à leitura como a foto, com a legenda", async () => {
  const ctx = { ...dm(""), message: { message_id: 31, date: 1_700_000_000, caption: "Flamengo ML 1.90 1u", document: { file_id: "doc-png", mime_type: "image/png", file_size: 900_000 } } };
  await handlers().get("message")!(ctx, vi.fn());
  expect(mocks.process).toHaveBeenCalledWith(context, {
    kind: "dm_message", chatId: "77", messageId: 31, postDate: new Date(1_700_000_000_000).toISOString(),
    caption: "Flamengo ML 1.90 1u", fileId: "doc-png",
  });
  expect(ctx.reply).not.toHaveBeenCalled();
});

it.each([
  ["imagem grande demais para ler", { file_id: "doc-big", mime_type: "image/png", file_size: 9 * 1024 * 1024 }, /8 MB/],
  ["arquivo que não é imagem", { file_id: "doc-pdf", mime_type: "application/pdf" }, /como foto ou o texto da aposta/],
])("arquivo na DM que a leitura não abre (%s) responde ao dono, sem ir à fila", async (_caso, document, reply) => {
  const ctx = { ...dm(""), message: { message_id: 32, date: 1_700_000_000, document } };
  await handlers().get("message")!(ctx, vi.fn());
  expect(mocks.process).not.toHaveBeenCalled();
  expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(reply), { reply_parameters: { message_id: 32 } });

  // De chat não autorizado, nem resposta.
  const stranger = { ...ctx, chat: { id: 99, type: "private" }, reply: vi.fn() };
  await handlers().get("message")!(stranger, vi.fn());
  expect(stranger.reply).not.toHaveBeenCalled();
});

it("falha ao responder o arquivo que a leitura não abre não falha o update", async () => {
  const ctx = { ...dm(""), message: { message_id: 33, date: 1_700_000_000, document: { file_id: "doc-pdf", mime_type: "application/pdf" } } };
  ctx.reply.mockRejectedValueOnce(new Error("Call to 'sendMessage' failed! (429: Too Many Requests: retry after 5)"));
  await expect(handlers().get("message")!(ctx, vi.fn())).resolves.toBeUndefined();
  expect(mocks.process).not.toHaveBeenCalled();
});
