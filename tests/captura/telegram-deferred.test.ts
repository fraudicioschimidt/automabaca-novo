import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readOpenAlbumWinner: vi.fn(),
  findClosedAlbumBetId: vi.fn(),
  albumMessageIds: vi.fn(),
  sendOperationalAlert: vi.fn(),
  completeMediaAlbum: vi.fn(),
  downloadTelegramPhoto: vi.fn(),
  handleChannelPhotoPost: vi.fn(),
  captureChannelFinancialContext: vi.fn(),
}));

vi.mock(import("@/src/services/capture/capture-financial-context"), () => ({
  captureChannelFinancialContext: mocks.captureChannelFinancialContext,
}));
vi.mock(import("@/src/services/capture/channel/media-album"), async (importOriginal) => ({
  ...await importOriginal(),
  readOpenAlbumWinner: mocks.readOpenAlbumWinner,
  findClosedAlbumBetId: mocks.findClosedAlbumBetId,
  albumMessageIds: mocks.albumMessageIds,
  completeMediaAlbum: mocks.completeMediaAlbum,
  MEDIA_ALBUM_FLUSH_MAX_DEFERRALS: 3 as const,
}));
vi.mock(import("@/src/services/ops/alerts"), async (importOriginal) => ({
  ...await importOriginal(),
  sendOperationalAlert: mocks.sendOperationalAlert,
}));
vi.mock(import("@/src/telegram/photo-download"), () => ({
  downloadTelegramPhoto: mocks.downloadTelegramPhoto,
}));
vi.mock(import("@/src/services/capture/channel/capture-new"), () => ({
  handleChannelPhotoPost: mocks.handleChannelPhotoPost,
}));

import { processTelegramDeferredJob } from "@/src/telegram/deferred";

const flush = (mediaGroupId: string) => processTelegramDeferredJob(
  { kind: "media_album_flush", chatId: "-100123456", mediaGroupId },
  { api: {} as never, token: "tok", retryCount: 1 },
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.captureChannelFinancialContext.mockResolvedValue({ imageStakeAsUnits: false });
  mocks.downloadTelegramPhoto.mockResolvedValue({ base64: "...", mimeType: "image/jpeg" });
});

describe("flush de álbum (processTelegramDeferredJob)", () => {
  it("relança erro se a versão concorrente invalidar o flush (CAS)", async () => {
    mocks.readOpenAlbumWinner.mockResolvedValue({
      messageId: 101,
      fileId: "file-101",
      caption: "Entrada Time A @2.0",
      postDate: new Date(),
      chatId: "-100123456",
      version: 1,
      photos: [{ messageId: 101, fileId: "file-101", caption: "Entrada Time A @2.0" }],
    });
    mocks.completeMediaAlbum.mockResolvedValue(false);
    mocks.handleChannelPhotoPost.mockResolvedValue({ kind: "unparseable", missing: ["stake"] });

    await expect(flush("album-999")).rejects.toThrow("versão concorrente");
  });

  it("com a aposta gravada, fecha o álbum mesmo se outra foto chegou durante a leitura", async () => {
    mocks.readOpenAlbumWinner.mockResolvedValue({
      messageId: 104, fileId: "file-104", caption: "Entrada Time D @2.0", postDate: new Date(), chatId: "-100123456", version: 3,
      photos: [{ messageId: 104, fileId: "file-104", caption: "Entrada Time D @2.0" }],
    });
    mocks.completeMediaAlbum.mockResolvedValue(true);
    for (const outcome of [{ kind: "registered", betId: "bet-4" }, { kind: "duplicate", betId: "bet-4" }]) {
      mocks.handleChannelPhotoPost.mockResolvedValueOnce(outcome);
      await expect(flush("album-gravado")).resolves.toEqual(outcome);
    }
    expect(mocks.completeMediaAlbum.mock.calls).toEqual([["album-gravado", {}], ["album-gravado", {}]]);
  });

  it("processa a foto antes de fechar o álbum e relança se completeMediaAlbum falhar (CAS)", async () => {
    mocks.readOpenAlbumWinner.mockResolvedValueOnce({
      messageId: 102,
      fileId: "file-102",
      caption: "Entrada Time B @1.90",
      postDate: new Date(),
      chatId: "-100123456",
      version: 2,
      photos: [
        { messageId: 102, fileId: "file-102", caption: "Entrada Time B @1.90" },
        { messageId: 104, fileId: "", caption: "" },
        { messageId: 105, fileId: "file-105", caption: "" },
      ],
    });
    mocks.handleChannelPhotoPost.mockResolvedValueOnce({ kind: "skipped", reason: "resultado_ou_balanco" });
    mocks.completeMediaAlbum.mockResolvedValueOnce(false);

    await expect(flush("album-cas-check")).rejects.toThrow("versão concorrente");
    // A captura decide se e quando baixar; o flush não baixa nem congela o contexto antes dela.
    expect(mocks.downloadTelegramPhoto).not.toHaveBeenCalled();
    expect(mocks.captureChannelFinancialContext).not.toHaveBeenCalled();
    expect(mocks.handleChannelPhotoPost).toHaveBeenCalledWith(
      expect.objectContaining({ mediaFileId: "file-102", albumFileIds: ["file-102", "file-105"], mediaGroupId: "album-cas-check" }),
      expect.objectContaining({ loadImage: expect.any(Function) }),
    );
    expect(mocks.completeMediaAlbum).toHaveBeenCalledWith("album-cas-check", { expectedVersion: 2 });
  });

  it("álbum que expirou e foi apagado antes da leitura abre alerta; o já concluído sem aposta não", async () => {
    mocks.readOpenAlbumWinner.mockResolvedValue(null);
    mocks.findClosedAlbumBetId.mockResolvedValue(null);
    mocks.albumMessageIds.mockResolvedValueOnce([101, 102]);
    await expect(flush("album-concluido")).resolves.toBeUndefined();
    expect(mocks.sendOperationalAlert).not.toHaveBeenCalled();

    mocks.albumMessageIds.mockResolvedValueOnce([]);
    await expect(flush("album-apagado")).resolves.toBeUndefined();
    expect(mocks.sendOperationalAlert).toHaveBeenCalledWith(
      expect.stringContaining("expiraram antes da leitura"),
      expect.objectContaining({ source: "telegram.album-expired", key: "album-apagado", resourceId: "-100123456" }),
    );
    expect(mocks.handleChannelPhotoPost).not.toHaveBeenCalled();
  });

  it("não marca done se handleChannelPhotoPost falhar (o álbum fica aberto para o retry nativo)", async () => {
    mocks.readOpenAlbumWinner.mockResolvedValueOnce({
      messageId: 103,
      fileId: "file-103",
      caption: "Entrada Time C @1.95",
      postDate: new Date(),
      chatId: "-100123456",
      version: 1,
      photos: [{ messageId: 103, fileId: "file-103", caption: "Entrada Time C @1.95" }],
    });
    mocks.handleChannelPhotoPost.mockRejectedValueOnce(new Error("OCR timeout"));

    await expect(flush("album-reopen-check")).rejects.toThrow("OCR timeout");
    expect(mocks.completeMediaAlbum).not.toHaveBeenCalled();
  });
});
