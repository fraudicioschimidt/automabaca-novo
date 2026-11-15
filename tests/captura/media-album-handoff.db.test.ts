import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../helpers/db";
import { getSharedBoss } from "@/src/infra/boss";
import {
  readOpenAlbumWinner,
  scheduleMediaAlbumFlush,
  stageMediaAlbumPhoto,
} from "@/src/services/capture/channel/media-album";
import type { MediaAlbumFlushJob } from "@/src/domain/telegram-job";
import {
  MediaAlbumCaptionPendingError,
  processTelegramDeferredJob,
} from "@/src/telegram/deferred";

let boss: PgBoss;
let db: TestDb;

vi.mock(import("@/src/services/capture/channel/capture-new"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    handleChannelPhotoPost: vi.fn(async () => ({ kind: "registered" as const, betId: "bet-handoff", sportResolutionStatus: "CONFIRMED" as const })),
  };
});

vi.mock(import("@/src/telegram/photo-download"), () => ({
  downloadTelegramPhoto: vi.fn(async () => ({
    base64: "aGVsbG8=",
    mimeType: "image/jpeg",
  })),
}));

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condição do retry do álbum não foi atingida");
}

beforeAll(async () => {
  db = createTestDb();
  boss = await getSharedBoss();
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.dispose();
});

describe("handoff durável do álbum Telegram", () => {
  it("desliza o job pendente sem criar sucessor com outra identidade", async () => {
    const send = vi.fn().mockResolvedValue("scheduled");
    const update = vi.fn().mockResolvedValue({ jobs: ["scheduled"], updated: 1 });
    const fakeBoss = { send, update } as unknown as PgBoss;

    await scheduleMediaAlbumFlush(fakeBoss, { chatId: "-1", mediaGroupId: "album-slide" });
    expect(await scheduleMediaAlbumFlush(
      fakeBoss,
      { chatId: "-1", mediaGroupId: "album-slide" },
      { sliding: true },
    )).toBe("rescheduled");

    expect(send).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      "telegram.deferred",
      expect.objectContaining({ mediaGroupId: "album-slide" }),
      expect.objectContaining({ singletonKey: "album-flush:album-slide" }),
    );
  });

  it("usa retries do mesmo job até processar a foto sem legenda no teto", async () => {
    await db.reset();
    const mediaGroupId = `album-${randomUUID()}`;
    const queue = `test.album_handoff_${randomUUID().replaceAll("-", "")}`;
    const attempts: Array<{ id: string; retryCount: number }> = [];

    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId: "-1001",
      photo: { messageId: 1, fileId: "photo", caption: "" },
      postDate: new Date(),
    });
    const { handleChannelPhotoPost } = await import("@/src/services/capture/channel/capture-new");
    vi.mocked(handleChannelPhotoPost).mockRejectedValueOnce(new Error("vision down"));
    await boss.createQueue(queue, {
      policy: "exclusive",
      retryLimit: 6,
      retryDelay: 1,
      retryBackoff: false,
    });
    try {
      await boss.work(queue, {
        includeMetadata: true,
        pollingIntervalSeconds: 1,
      }, async (jobs) => {
        const job = jobs[0] as JobWithMetadata<MediaAlbumFlushJob>;
        attempts.push({ id: job.id, retryCount: job.retryCount });
        return processTelegramDeferredJob(job.data, {
          api: { getFile: vi.fn() } as never,
          token: "tok",
          retryCount: job.retryCount,
        });
      });
      await boss.send(queue, {
        kind: "media_album_flush",
        chatId: "-1001",
        mediaGroupId,
      }, { singletonKey: `album-flush:${mediaGroupId}` });

      await waitFor(async () => (await readOpenAlbumWinner(mediaGroupId)) === null);
      expect(attempts.map((attempt) => attempt.retryCount)).toEqual([0, 1, 2, 3, 4]);
      expect(new Set(attempts.map((attempt) => attempt.id))).toEqual(new Set([attempts[0]!.id]));
    } finally {
      await boss.offWork(queue, { wait: true });
      await boss.deleteQueue(queue);
    }
  });

  it("classifica legenda ausente como retry esperado, não sucesso", async () => {
    const error = new MediaAlbumCaptionPendingError("album", 1);
    expect(error).toMatchObject({ name: "MediaAlbumCaptionPendingError", attempt: 1 });
  });
});
