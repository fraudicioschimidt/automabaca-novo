import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import type { PgBoss } from "pg-boss";
import type * as AfterCapture from "@/src/services/scheduling/enqueue-after-capture";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  cancel: vi.fn(),
  enqueue: vi.fn(),
  enqueueSport: vi.fn(),
  handlePhoto: vi.fn(),
  handlePost: vi.fn(),
  handleReaction: vi.fn(),
  handleEdited: vi.fn(),
  handleEditedPhoto: vi.fn(),
  scheduleAlbum: vi.fn(),
  stageAlbum: vi.fn(),
  financialContext: vi.fn(),
  ensureFollowups: vi.fn(),
  dm: vi.fn(),
}));

vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({
  cancelPendingSharpEnrich: mocks.cancel,
  enqueueSharpEnrich: mocks.enqueue,
}));
vi.mock(import("@/src/services/capture/capture-financial-context"), () => ({ captureChannelFinancialContext: mocks.financialContext }));
vi.mock("@/src/services/scheduling/enqueue-sport-resolution", () => ({
  enqueueSportResolution: mocks.enqueueSport,
}));
vi.mock("@/src/services/scheduling/enqueue-after-capture", async (importOriginal) => ({
  ...await importOriginal<typeof AfterCapture>(),
  ensureCaptureFollowups: mocks.ensureFollowups,
}));
vi.mock(import("@/src/services/capture/dm"), () => ({ answerDmMessage: mocks.dm }));
vi.mock(import("@/src/services/capture/channel/capture-new"), () => ({
  handleChannelPhotoPost: mocks.handlePhoto,
  handleChannelPost: mocks.handlePost,
}));
vi.mock(import("@/src/services/capture/channel/capture-edit"), () => ({ handleEditedChannelPost: mocks.handleEdited, handleEditedChannelPhoto: mocks.handleEditedPhoto }));
vi.mock(import("@/src/services/capture/channel/media-album"), async (importOriginal) => ({
  ...await importOriginal(),
  scheduleMediaAlbumFlush: mocks.scheduleAlbum,
  stageMediaAlbumPhoto: mocks.stageAlbum,
}));
vi.mock(import("@/src/services/capture/channel/reactions"), () => ({
  handleChannelReaction: mocks.handleReaction,
}));
vi.mock(import("@/src/telegram/photo-download"), () => ({ downloadTelegramPhoto: mocks.download }));

import {
  logAndScheduleFollowups,
  processTelegramJob,
  stageAlbumPhoto,
  toChannelPost,
  type CaptureOutcome,
} from "@/src/telegram/processing";

const maybeEnqueueEnrich = (boss: PgBoss, outcome: CaptureOutcome) =>
  logAndScheduleFollowups(boss, { kind: "channel_post" }, outcome);

describe("processamento Telegram desacoplado do bootstrap", () => {
  const boss = {} as PgBoss;
  const api = { sendMessage: vi.fn() } as unknown as Api;
  const context = { api, boss, token: "token" };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.enqueueSport.mockResolvedValue(undefined);
    mocks.cancel.mockResolvedValue(1);
    mocks.stageAlbum.mockResolvedValue("created");
    mocks.scheduleAlbum.mockResolvedValue(undefined);
    mocks.download.mockResolvedValue({ base64: "aW1hZ2U=", mimeType: "image/jpeg" });
    mocks.handlePost.mockResolvedValue({
      kind: "registered",
      betId: "bet-1",
      sportResolutionStatus: "CONFIRMED",
    });
    mocks.handleReaction.mockResolvedValue({ kind: "removed", betId: "bet-1" });
  });

  it("normaliza post e só enfileira outcomes que precisam de enrich", async () => {
    const post = toChannelPost({
      kind: "channel_post",
      chatId: "-100123",
      messageId: 7,
      text: "Time A x Time B",
      postDate: "2026-07-13T12:00:00.000Z",
    });
    expect(post).toMatchObject({ chatId: -100123n, messageId: 7, text: "Time A x Time B" });
    await maybeEnqueueEnrich(boss, {
      kind: "registered",
      betId: "bet-1",
      sportResolutionStatus: "CONFIRMED",
    });
    await maybeEnqueueEnrich(boss, { kind: "duplicate", betId: "bet-2" });
    await maybeEnqueueEnrich(boss, { kind: "ignored", reason: "post_ja_capturado" });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenLastCalledWith(boss, "bet-1");
  });

  it("captura já não pega não agenda identificação ou enrich", async () => {
    await maybeEnqueueEnrich(boss, { kind: "registered", betId: "not-taken", sportResolutionStatus: "CONFIRMED", notTaken: true });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.enqueueSport).not.toHaveBeenCalled();
  });

  it.each(["CONFIRMED", "PENDING"] as const)("roteia lote por item quando o primeiro tem esporte %s", async (firstStatus) => {
    const registeredBets = [
      { betId: "confirmed", sportResolutionStatus: "CONFIRMED" as const },
      { betId: "pending", sportResolutionStatus: "PENDING" as const },
      { betId: "conflict", sportResolutionStatus: "CONFLICT" as const },
    ];
    if (firstStatus === "PENDING") {
      [registeredBets[0], registeredBets[1]] = [registeredBets[1]!, registeredBets[0]!];
    }
    await maybeEnqueueEnrich(boss, {
      kind: "registered",
      betId: registeredBets[0]!.betId,
      sportResolutionStatus: firstStatus,
      registeredBets,
    });

    expect(mocks.enqueue.mock.calls.map((call) => call[1])).toEqual(["confirmed"]);
    expect(mocks.enqueueSport.mock.calls.map((call) => call[1]).sort()).toEqual(["conflict", "pending"]);
  });

  it("preserva não pega por item e agenda cada ID apenas uma vez", async () => {
    await maybeEnqueueEnrich(boss, {
      kind: "registered", betId: "confirmed", sportResolutionStatus: "CONFIRMED",
      registeredBets: [
        { betId: "confirmed", sportResolutionStatus: "CONFIRMED" },
        { betId: "confirmed", sportResolutionStatus: "CONFIRMED" },
        { betId: "not-taken", sportResolutionStatus: "PENDING", notTaken: true },
        { betId: "pending", sportResolutionStatus: "PENDING" },
      ],
    });
    expect(mocks.enqueue.mock.calls.map((call) => call[1])).toEqual(["confirmed"]);
    expect(mocks.enqueueSport.mock.calls.map((call) => call[1])).toEqual(["pending"]);
  });

  it("encaminha modalidade pendente ao resolvedor, não ao sharp", async () => {
    await maybeEnqueueEnrich(boss, {
      kind: "registered",
      betId: "bet-pending",
      sportResolutionStatus: "PENDING",
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.enqueueSport).toHaveBeenCalledWith(boss, "bet-pending", {
      origem: "telegram-capture",
    });
  });

  it("agenda flush com idempotência mesmo quando o álbum já existe (redundant)", async () => {
    const data = {
      kind: "channel_photo_album" as const,
      chatId: "-10",
      messageId: 9,
      caption: "tip",
      postDate: "2026-07-13T12:00:00.000Z",
      fileId: "file-1",
      mediaGroupId: "album-1",
    };
    await expect(stageAlbumPhoto(boss, data)).resolves.toEqual({ kind: "media_album_staged" });
    expect(mocks.scheduleAlbum).toHaveBeenCalledWith(
      boss,
      { chatId: "-10", mediaGroupId: "album-1" },
      { sliding: false },
    );
    mocks.scheduleAlbum.mockClear();
    mocks.stageAlbum.mockResolvedValueOnce("redundant");
    await stageAlbumPhoto(boss, data);
    expect(mocks.scheduleAlbum).toHaveBeenCalledWith(
      boss,
      { chatId: "-10", mediaGroupId: "album-1" },
      { sliding: false },
    );
  });

  it("despacha retry de texto e reação ao handler correto", async () => {
    await expect(processTelegramJob(context, {
      kind: "channel_post",
      chatId: "-10",
      messageId: 1,
      text: "tip",
      postDate: "2026-07-13T12:00:00.000Z",
    })).resolves.toEqual({
      kind: "registered",
      betId: "bet-1",
      sportResolutionStatus: "CONFIRMED",
    });
    await processTelegramJob(context, {
      kind: "reaction",
      chatId: "-10",
      messageId: 1,
      emojis: ["👍"],
      actorUserId: "123",
      occurredAt: "2026-09-13T00:00:00.000Z", updateId: 493,
      thumbsDownPresent: false,
    });
    expect(mocks.handlePost).toHaveBeenCalledOnce();
    expect(mocks.handleReaction).toHaveBeenCalledOnce();
    expect(mocks.handleReaction).toHaveBeenCalledWith({
      chatId: -10n,
      messageId: 1,
      emojis: ["👍"],
      actorUserId: "123",
      occurredAt: "2026-09-13T00:00:00.000Z", updateId: 493,
      thumbsDownPresent: false,
    });
  });

  it("retry de edit leva o acesso à Bot API da captura (foto e perfil do canal)", async () => {
    mocks.handleEdited.mockImplementationOnce(async (
      _post: unknown,
      deps: { loadImage: (fileId: string) => Promise<unknown>; loadChannelProfile: unknown },
    ) => {
      expect(deps.loadChannelProfile).toEqual(expect.any(Function));
      await deps.loadImage("file-original");
      return { kind: "ignored", reason: "post_ja_capturado" };
    });

    await processTelegramJob({ ...context, token: "token-seguro" }, {
      kind: "edited_channel_post",
      chatId: "-10",
      messageId: 8,
      text: "GREEN",
      postDate: "2026-07-13T12:00:00.000Z",
      editDate: "2026-07-13T12:10:00.000Z",
    });

    expect(mocks.download).toHaveBeenCalledWith(api, "token-seguro", "file-original");
  });

  it("foto editada dentro da janela relê a imagem na hora, com a legenda nova e a data da edição", async () => {
    mocks.handleEditedPhoto.mockImplementationOnce(async (_post: unknown, capture: () => Promise<unknown>) => capture());
    mocks.handlePhoto.mockResolvedValueOnce({ kind: "registered", betId: "bet-foto", sportResolutionStatus: "CONFIRMED" });
    const outcome = await processTelegramJob(context, {
      kind: "edited_channel_photo", chatId: "-10", messageId: 9, caption: "Nova legenda @1.90 1u",
      postDate: "2026-07-13T12:00:00.000Z", editDate: "2026-07-13T12:10:00.000Z", fileId: "foto-9",
    });
    expect(outcome).toMatchObject({ kind: "registered", betId: "bet-foto" });
    expect(mocks.handlePhoto).toHaveBeenCalledWith({
      chatId: -10n, messageId: 9, caption: "Nova legenda @1.90 1u",
      postDate: new Date("2026-07-13T12:00:00.000Z"), editDate: new Date("2026-07-13T12:10:00.000Z"), mediaFileId: "foto-9",
    }, expect.objectContaining({ loadImage: expect.any(Function) }));
    expect(mocks.enqueue).toHaveBeenCalledWith(boss, "bet-foto");
  });

  it("foto nova vai à captura sem baixar a imagem nem congelar o contexto antes dela", async () => {
    mocks.handlePhoto.mockResolvedValueOnce({ kind: "duplicate", betId: "bet-antiga" });
    await processTelegramJob(context, {
      kind: "channel_photo", chatId: "-10", messageId: 11, caption: "", postDate: "2026-07-13T12:00:00.000Z", fileId: "foto-11",
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.financialContext).not.toHaveBeenCalled();
    expect(mocks.handlePhoto).toHaveBeenCalledWith(expect.objectContaining({ mediaFileId: "foto-11" }), expect.anything());
  });

  it("reentrega de post já capturado confere se a fila depois da captura se perdeu", async () => {
    mocks.handlePost.mockResolvedValueOnce({ kind: "duplicate", betId: "bet-velha" });
    mocks.ensureFollowups.mockResolvedValueOnce(1);
    await processTelegramJob(context, {
      kind: "channel_post", chatId: "-10", messageId: 1, text: "tip", postDate: "2026-07-13T12:00:00.000Z",
    });
    expect(mocks.ensureFollowups).toHaveBeenCalledWith(boss, "bet-velha", "telegram-capture");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("DM vai pelo mesmo caminho e a falha sobe para o retry da fila", async () => {
    mocks.dm.mockRejectedValueOnce(new Error("banco fora"));
    await expect(processTelegramJob(context, {
      kind: "dm_message", chatId: "77", messageId: 3, postDate: "2026-07-13T12:00:00.000Z", text: "tip",
    })).rejects.toThrow("banco fora");
    expect(mocks.dm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "dm_message", messageId: 3 }),
      expect.objectContaining({ loadImage: expect.any(Function), reply: expect.any(Function) }),
    );
  });

  it("falha da captura de canal sobe em vez de virar outra fila", async () => {
    mocks.handlePost.mockRejectedValueOnce(new Error("vision fora"));
    await expect(processTelegramJob(context, {
      kind: "channel_post", chatId: "-10", messageId: 2, text: "tip", postDate: "2026-07-13T12:00:00.000Z",
    })).rejects.toThrow("vision fora");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
