import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../helpers/db";
import { getSharedBoss } from "@/src/infra/boss";
import { QUEUES } from "@/src/infra/queue-contract";
import { telegramChannelSource } from "@/src/domain/telegram-source";
import {
  MEDIA_ALBUM_FLUSH_MAX_DEFERRALS,
  applyAlbumCaptionEdit,
  completeMediaAlbum,
  findAlbumWinnerMessageId,
  isOpenAlbumWinner,
  readOpenAlbumWinner,
  stageMediaAlbumPhoto,
} from "@/src/services/capture/channel/media-album";
import { purgeOldAuditEvents } from "@/src/services/ops/audit-purge";
import { processTelegramDeferredJob } from "@/src/telegram/deferred";

let db: TestDb;
let boss: PgBoss;

vi.mock(import("@/src/services/capture/channel/capture-new"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    handleChannelPhotoPost: vi.fn(async () => ({ kind: "registered" as const, betId: "bet-album", sportResolutionStatus: "CONFIRMED" as const })),
    handleChannelPost: vi.fn(async () => ({ kind: "registered" as const, betId: "bet-album-texto", sportResolutionStatus: "CONFIRMED" as const })),
  };
});

vi.mock(import("@/src/telegram/photo-download"), () => ({
  downloadTelegramPhoto: vi.fn(async () => ({
    base64: "aGVsbG8=",
    mimeType: "image/jpeg",
  })),
}));

beforeAll(async () => {
  db = createTestDb();
  boss = await getSharedBoss();
  await boss.createQueue(QUEUES.telegramDeferred);
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  vi.clearAllMocks();
  await db.prisma.$executeRawUnsafe(
    `DELETE FROM pgboss.job WHERE name = '${QUEUES.telegramDeferred}'`,
  );
});

describe("horário da legenda do álbum", () => {
  it.each(["photo", ""])("flush preserva a edição com imagem %j", async (fileId) => {
    const postDate = new Date();
    const editDate = new Date(postDate.getTime() + 60_000);
    await stageMediaAlbumPhoto({ mediaGroupId: "clock", chatId: "-100111", photo: { messageId: 1, fileId, caption: "" }, postDate });
    await applyAlbumCaptionEdit({ chatId: "-100111", messageId: 1, caption: "Flamengo ML @2.10 1u", editDate });
    expect(await readOpenAlbumWinner("clock")).toMatchObject({ postDate, editDate });
    await processTelegramDeferredJob({ kind: "media_album_flush", chatId: "-100111", mediaGroupId: "clock" }, { api: {} as never, token: "synthetic", retryCount: 0 });
    const capture = await import("@/src/services/capture/channel/capture-new");
    expect(fileId ? capture.handleChannelPhotoPost : capture.handleChannelPost)
      .toHaveBeenCalledWith(expect.objectContaining({ postDate, editDate }), expect.anything());
  });

  it("mudança só do instante da edição invalida a leitura antiga do OCR", async () => {
    const postDate = new Date();
    const caption = "Flamengo ML @2.10 1u";
    const editDate = new Date(postDate.getTime() + 60_000);
    await stageMediaAlbumPhoto({ mediaGroupId: "clock", chatId: "-100111", photo: { messageId: 1, fileId: "photo", caption }, postDate });
    const original = (await readOpenAlbumWinner("clock"))!;
    expect(await isOpenAlbumWinner({ mediaGroupId: "clock", ...original })).toBe(true);
    await applyAlbumCaptionEdit({ chatId: "-100111", messageId: 1, caption, editDate });
    expect(await isOpenAlbumWinner({ mediaGroupId: "clock", ...original })).toBe(false);
    expect(await isOpenAlbumWinner({ mediaGroupId: "clock", ...(await readOpenAlbumWinner("clock"))! })).toBe(true);
  });

  it("legenda de outra foto que não vence não troca a hora; nova legenda original limpa a edição", async () => {
    const postDate = new Date();
    const editDate = new Date(postDate.getTime() + 60_000);
    await stageMediaAlbumPhoto({ mediaGroupId: "clock", chatId: "-100111", photo: { messageId: 1, fileId: "photo", caption: "" }, postDate });
    await stageMediaAlbumPhoto({ mediaGroupId: "clock", chatId: "-100111", photo: { messageId: 2, fileId: "other", caption: "" }, postDate });
    await applyAlbumCaptionEdit({ chatId: "-100111", messageId: 1, caption: "Flamengo ML @2.10 1u", editDate });
    await applyAlbumCaptionEdit({ chatId: "-100111", messageId: 2, caption: "promo", editDate: new Date(editDate.getTime() + 60_000) });
    expect(await readOpenAlbumWinner("clock")).toMatchObject({ editDate });
    await stageMediaAlbumPhoto({ mediaGroupId: "clock", chatId: "-100111", photo: {
      messageId: 3, fileId: "best", caption: "Jogo: Flamengo vs Palmeiras\nMercado: Total\nEntrada: Over 2.5\nOdd: 1.90\nStake: 1u",
    }, postDate });
    expect((await readOpenAlbumWinner("clock"))?.editDate).toBeUndefined();
  });
});

describe("reentrega de álbum absorvido", () => {
  it.each(["recibo", "auditoria"])("retoma a aposta existente pelo %s sem reler as imagens", async (proof) => {
    const { registerBet } = await import("@/src/services/bets/register");
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Teste", slug: "teste" } });
    const input = { bankrollId: bankroll.id, data: new Date(Date.now() + 3_600_000), evento: "Flamengo vs Palmeiras",
      esporte: "Soccer", mercado: "Moneyline", selecao: "Flamengo", odds: 2, stake: 1,
      source: "telegram-dm:123", sourceExternalId: "42" };
    const original = await registerBet(input, { client: db.prisma });
    await stageMediaAlbumPhoto({ mediaGroupId: "absorvido", chatId: "-100111", postDate: new Date(),
      photo: { messageId: 43, fileId: "foto", caption: "Flamengo ML @2 1u" } });
    expect(await registerBet({ ...input, source: telegramChannelSource("-100111"), sourceExternalId: "43" }, { client: db.prisma }))
      .toMatchObject({ created: false, betId: original.betId });
    if (proof === "auditoria") await db.prisma.absorbedBetSource.deleteMany();
    await completeMediaAlbum("absorvido");
    expect(await processTelegramDeferredJob({ kind: "media_album_flush", chatId: "-100111", mediaGroupId: "absorvido" },
      { api: {} as never, token: "synthetic", retryCount: 0 })).toEqual({ kind: "duplicate", betId: original.betId });
    const capture = await import("@/src/services/capture/channel/capture-new");
    expect(capture.handleChannelPhotoPost).not.toHaveBeenCalled();
    expect(await db.prisma.bet.count()).toBe(1);
  });
});

describe("media album debounce", () => {
  it("primeira foto agenda; segunda sem legenda só acumula ids", async () => {
    const mediaGroupId = "album-a";
    const chatId = "-100111";

    expect(
      await stageMediaAlbumPhoto({
        mediaGroupId,
        chatId,
        photo: { messageId: 1, fileId: "f1", caption: "" },
        postDate: new Date(),
      }),
    ).toBe("scheduled");

    expect(
      await stageMediaAlbumPhoto({
        mediaGroupId,
        chatId,
        photo: { messageId: 2, fileId: "f2", caption: "" },
        postDate: new Date(),
      }),
    ).toBe("redundant");

    const winner = await readOpenAlbumWinner(mediaGroupId);
    expect(winner?.messageId).toBe(1);
    expect(winner?.fileId).toBe("f1");

    const row = await db.prisma.telegramMediaAlbum.findUniqueOrThrow({
      where: { mediaGroupId },
    });
    expect(row.messageIds).toEqual([1, 2]);
  });

  it("promove candidata quando legenda chega depois", async () => {
    const mediaGroupId = "album-b";
    const chatId = "-100222";

    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 10, fileId: "first", caption: "" },
      postDate: new Date(),
    });

    expect(
      await stageMediaAlbumPhoto({
        mediaGroupId,
        chatId,
        photo: {
          messageId: 11,
          fileId: "with-caption",
          caption: "Flamengo ML @2.10 1u",
        },
        postDate: new Date(),
      }),
    ).toBe("updated");

    const winner = await readOpenAlbumWinner(mediaGroupId);
    expect(winner?.messageId).toBe(11);
    expect(winner?.caption).toContain("Flamengo");
    expect(winner?.fileId).toBe("with-caption");
  });

  it("mantém legenda estruturada diante de texto promocional mais longo", async () => {
    const mediaGroupId = "album-structured";
    const chatId = "-100223";
    const structured = [
      "Jogo: Flamengo vs Palmeiras",
      "Mercado: Total",
      "Entrada: Over 2.5",
      "Odd: 1.90",
      "Stake: 1u",
    ].join("\n");

    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 12, fileId: "structured", caption: structured },
      postDate: new Date(),
    });
    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: {
        messageId: 13,
        fileId: "promo",
        caption: "Entre agora no melhor grupo premium com análises exclusivas e novidades todos os dias!".repeat(3),
      },
      postDate: new Date(),
    });

    expect(await readOpenAlbumWinner(mediaGroupId)).toMatchObject({
      messageId: 12,
      fileId: "structured",
    });
  });

  it("flush sem legenda adia até o teto de deferrals", async () => {
    const mediaGroupId = "album-c";
    const chatId = "-100333";

    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 1, fileId: "f", caption: "" },
      postDate: new Date(),
    });

    await expect(processTelegramDeferredJob(
      {
        kind: "media_album_flush",
        chatId,
        mediaGroupId,
      },
      {
        api: { getFile: vi.fn() } as never,
        token: "tok",
        retryCount: 0,
      },
    )).rejects.toMatchObject({ name: "MediaAlbumCaptionPendingError", attempt: 0 });
    expect(await readOpenAlbumWinner(mediaGroupId)).toMatchObject({ messageId: 1 });
  });

  it("após esgotar adiamentos processa mesmo sem legenda", async () => {
    const mediaGroupId = "album-d";
    const chatId = "-100444";

    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 5, fileId: "only", caption: "" },
      postDate: new Date(),
    });

    const { handleChannelPhotoPost } = await import("@/src/services/capture/channel/capture-new");

    const result = await processTelegramDeferredJob(
      {
        kind: "media_album_flush",
        chatId,
        mediaGroupId,
      },
      {
        api: { getFile: vi.fn() } as never,
        token: "tok",
        retryCount: MEDIA_ALBUM_FLUSH_MAX_DEFERRALS,
      },
    );

    expect(handleChannelPhotoPost).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 5, caption: "" }),
      expect.objectContaining({ loadImage: expect.any(Function), loadChannelProfile: expect.any(Function) }),
    );
    expect(result).toMatchObject({ kind: "registered", betId: "bet-album" });
    expect(await readOpenAlbumWinner(mediaGroupId)).toBeNull();
  });

  it("erro na captura preserva álbum aberto para retentativa", async () => {
    const mediaGroupId = "album-err";
    const chatId = "-100555";

    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 9, fileId: "err", caption: "Over 2.5 @1.90" },
      postDate: new Date(),
    });

    const { handleChannelPhotoPost } = await import("@/src/services/capture/channel/capture-new");
    vi.mocked(handleChannelPhotoPost).mockRejectedValueOnce(new Error("vision down"));

    await expect(
      processTelegramDeferredJob(
        {
          kind: "media_album_flush",
          chatId,
          mediaGroupId,
        },
        {
          api: { getFile: vi.fn() } as never,
          token: "tok",
          retryCount: MEDIA_ALBUM_FLUSH_MAX_DEFERRALS,
        },
      ),
    ).rejects.toThrow(/vision down/);

    expect(await readOpenAlbumWinner(mediaGroupId)).toMatchObject({
      messageId: 9,
      caption: "Over 2.5 @1.90",
    });
  });

  it("resultado não parseável encerra o álbum sem manter reações em espera", async () => {
    const mediaGroupId = "album-unparseable";
    const chatId = "-100556";
    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 10, fileId: "bad", caption: "imagem sem aposta" },
      postDate: new Date(),
    });
    const { handleChannelPhotoPost } = await import("@/src/services/capture/channel/capture-new");
    vi.mocked(handleChannelPhotoPost).mockResolvedValueOnce({
      kind: "unparseable",
      missing: ["imagem"],
    });

    await processTelegramDeferredJob(
      { kind: "media_album_flush", chatId, mediaGroupId },
      { api: { getFile: vi.fn() } as never, token: "tok", retryCount: 3 },
    );

    expect(await readOpenAlbumWinner(mediaGroupId)).toBeNull();
  });

  it("reação em foto irmã resolve para o winner; pending enquanto open", async () => {
    const mediaGroupId = "album-react";
    const chatId = "-100666";

    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 20, fileId: "a", caption: "" },
      postDate: new Date(),
    });
    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 21, fileId: "b", caption: "Casa @2.0" },
      postDate: new Date(),
    });

    // A foto com legenda assume a candidatura; a irmã aponta para ela.
    expect(await findAlbumWinnerMessageId(BigInt(chatId), 20)).toBe(21);
    expect(await readOpenAlbumWinner(mediaGroupId)).toMatchObject({ messageId: 21 });

    await completeMediaAlbum(mediaGroupId);
    expect(await readOpenAlbumWinner(mediaGroupId)).toBeNull();
    expect(await findAlbumWinnerMessageId(BigInt(chatId), 20)).toBe(21);
  });


  describe("membro sem imagem (vídeo) e edição de legenda", () => {
    const chatId = "-100999";

    it("vídeo com legenda doa a legenda; a foto do álbum fica com a imagem", async () => {
      const mediaGroupId = "album-video";
      await stageMediaAlbumPhoto({ mediaGroupId, chatId, photo: { messageId: 20, fileId: "", caption: "Flamengo ML @2.10 1u" }, postDate: new Date() });
      await stageMediaAlbumPhoto({ mediaGroupId, chatId, photo: { messageId: 21, fileId: "foto", caption: "" }, postDate: new Date() });
      expect(await readOpenAlbumWinner(mediaGroupId)).toMatchObject({
        messageId: 21, fileId: "foto", caption: "Flamengo ML @2.10 1u",
      });
    });

    it("legenda do vídeo que chega depois fica com a imagem da foto", async () => {
      const mediaGroupId = "album-video-2";
      await stageMediaAlbumPhoto({ mediaGroupId, chatId, photo: { messageId: 30, fileId: "foto", caption: "" }, postDate: new Date() });
      await stageMediaAlbumPhoto({ mediaGroupId, chatId, photo: { messageId: 31, fileId: "", caption: "Flamengo ML @2.10 1u" }, postDate: new Date() });
      expect(await readOpenAlbumWinner(mediaGroupId)).toMatchObject({ messageId: 30, fileId: "foto", caption: "Flamengo ML @2.10 1u" });
    });

    it("álbum só de vídeo vira post de texto, uma vez", async () => {
      const mediaGroupId = "album-so-video";
      await stageMediaAlbumPhoto({ mediaGroupId, chatId, photo: { messageId: 40, fileId: "", caption: "Flamengo ML @2.10 1u" }, postDate: new Date() });
      const capture = await import("@/src/services/capture/channel/capture-new");
      await processTelegramDeferredJob({ kind: "media_album_flush", chatId, mediaGroupId }, { api: {} as never, token: "t", retryCount: 0 });
      expect(capture.handleChannelPost).toHaveBeenCalledOnce();
      expect(capture.handleChannelPhotoPost).not.toHaveBeenCalled();
      expect(await readOpenAlbumWinner(mediaGroupId)).toBeNull();
    });

    it("legenda editada entra no álbum aberto e é recusada como post novo depois de concluído", async () => {
      const mediaGroupId = "album-edit";
      await stageMediaAlbumPhoto({ mediaGroupId, chatId, photo: { messageId: 50, fileId: "foto", caption: "" }, postDate: new Date() });
      expect(await applyAlbumCaptionEdit({ chatId, messageId: 50, caption: "Flamengo ML @2.10 1u", editDate: new Date() })).toBe("open");
      expect(await readOpenAlbumWinner(mediaGroupId)).toMatchObject({ caption: "Flamengo ML @2.10 1u" });
      await db.prisma.telegramMediaAlbum.update({ where: { mediaGroupId }, data: { status: "done" } });
      expect(await applyAlbumCaptionEdit({ chatId, messageId: 50, caption: "outra", editDate: new Date() })).toBe("done");
      expect(await applyAlbumCaptionEdit({ chatId, messageId: 999, caption: "x", editDate: new Date() })).toBeNull();
    });
  });
});

async function persistAlbumBet(params: {
  chatId: bigint;
  mediaGroupId: string;
  siblingMessageId: number;
  winnerMessageId: number;
}): Promise<string> {
  await stageMediaAlbumPhoto({
    mediaGroupId: params.mediaGroupId,
    chatId: String(params.chatId),
    photo: { messageId: params.siblingMessageId, fileId: "sibling", caption: "" },
    postDate: new Date(),
  });
  await stageMediaAlbumPhoto({
    mediaGroupId: params.mediaGroupId,
    chatId: String(params.chatId),
    photo: { messageId: params.winnerMessageId, fileId: "winner", caption: "Casa @2.0 1u" },
    postDate: new Date(),
  });
  await completeMediaAlbum(params.mediaGroupId);

  const bankroll = await db.prisma.bankroll.create({
    data: { nome: params.mediaGroupId, slug: params.mediaGroupId },
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      bankrollId: bankroll.id,
      data: new Date("2026-07-20T12:00:00Z"),
      evento: "Casa vs Fora",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Casa",
      odds: 2,
      stake: 1,
      source: telegramChannelSource(params.chatId),
      sourceExternalId: String(params.winnerMessageId),
    },
  });
  return bet.id;
}

describe("mapa durável de reações do álbum", () => {
  it("resolve álbum antigo mesmo com mais de 40 álbuns recentes", async () => {
    const chatId = -100667n;
    const betId = await persistAlbumBet({
      chatId,
      mediaGroupId: "album-old",
      siblingMessageId: 100,
      winnerMessageId: 101,
    });
    for (let index = 0; index < 45; index++) {
      await stageMediaAlbumPhoto({
        mediaGroupId: `album-new-${index}`,
        chatId: String(chatId),
        photo: { messageId: 200 + index, fileId: `new-${index}`, caption: "" },
        postDate: new Date(),
      });
    }

    expect(await findAlbumWinnerMessageId(chatId, 100)).toBe(101);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).toMatchObject({ sourceExternalId: "101" });
  });

  it("mantém a reação tardia durante a retenção e depois purga o mapa", async () => {
    const chatId = -100999n;
    const betId = await persistAlbumBet({
      chatId,
      mediaGroupId: "album-tardio",
      siblingMessageId: 300,
      winnerMessageId: 301,
    });

    await purgeOldAuditEvents(new Date(Date.now() + 6 * 3_600_000));
    expect(await findAlbumWinnerMessageId(chatId, 300)).toBe(301);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).toMatchObject({ sourceExternalId: "301" });

    await purgeOldAuditEvents(new Date(Date.now() + 31 * 24 * 3_600_000));
    expect(await findAlbumWinnerMessageId(chatId, 300)).toBeNull();
  });
});

describe("contrato físico de messageIds do álbum", () => {
  beforeEach(async () => {
    await stageMediaAlbumPhoto({
      mediaGroupId: "album-schema",
      chatId: "-1001",
      photo: { messageId: 42, fileId: "photo", caption: "" },
      postDate: new Date(),
    });
  });

  it("tem constraints validadas para não nulo e não vazio", async () => {
    const constraints = await db.prisma.$queryRaw<Array<{ name: string; validated: boolean }>>`
      SELECT conname AS name, convalidated AS validated
      FROM pg_constraint
      WHERE conrelid = 'telegram_media_albums'::regclass
        AND conname IN (
          'telegram_media_albums_message_ids_not_null',
          'telegram_media_albums_message_ids_nonempty'
        )
      ORDER BY conname
    `;
    expect(constraints).toEqual([
      { name: "telegram_media_albums_message_ids_nonempty", validated: true },
      { name: "telegram_media_albums_message_ids_not_null", validated: true },
    ]);
  });

  it("recusa tanto NULL quanto array vazio", async () => {
    await expect(db.prisma.$executeRawUnsafe(
      `UPDATE telegram_media_albums SET "messageIds" = NULL WHERE "mediaGroupId" = 'album-schema'`,
    )).rejects.toThrow(/telegram_media_albums_message_ids_not_null/);
    await expect(db.prisma.$executeRawUnsafe(
      `UPDATE telegram_media_albums SET "messageIds" = ARRAY[]::INTEGER[] WHERE "mediaGroupId" = 'album-schema'`,
    )).rejects.toThrow(/telegram_media_albums_message_ids_nonempty/);
  });
});

describe("estado do álbum no PostgreSQL", () => {
  it("completeMediaAlbum só fecha com a versão atual (CAS)", async () => {
    const mediaGroupId = "album-cas-db-test";
    const chatId = "-100777";
    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 1, fileId: "f1", caption: "Primeira foto" },
      postDate: new Date(),
    });

    const rowV1 = await db.prisma.telegramMediaAlbum.findUniqueOrThrow({
      where: { mediaGroupId },
    });
    expect(rowV1.version).toBe(0);

    // Concorrência: outra foto chega e incrementa a versão para 1
    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 2, fileId: "f2", caption: "Segunda foto com odd @2.0" },
      postDate: new Date(),
    });

    const rowV2 = await db.prisma.telegramMediaAlbum.findUniqueOrThrow({
      where: { mediaGroupId },
    });
    expect(rowV2.version).toBe(1);

    // Tentativa de completar com expectedVersion 0 (obsoleta) deve retornar false
    const completedObsolete = await completeMediaAlbum(mediaGroupId, { expectedVersion: 0 });
    expect(completedObsolete).toBe(false);

    // Tentativa com expectedVersion 1 (atual) deve ter sucesso
    const completedCurrent = await completeMediaAlbum(mediaGroupId, { expectedVersion: 1 });
    expect(completedCurrent).toBe(true);
  });

  it("completeMediaAlbum fecha o álbum aberto", async () => {
    const mediaGroupId = "album-reopen-test";
    const chatId = "-100888";
    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 50, fileId: "file-50", caption: "Caption test" },
      postDate: new Date(),
    });

    const completed = await completeMediaAlbum(mediaGroupId, { expectedVersion: 0 });
    expect(completed).toBe(true);

    const closedRow = await db.prisma.telegramMediaAlbum.findUniqueOrThrow({
      where: { mediaGroupId },
    });
    expect(closedRow.status).toBe("done");
  });

  it("foto irmã tardia em álbum concluído entra no mapa sem reabrir o álbum", async () => {
    const mediaGroupId = "album-done-sister-test";
    const chatId = "-100777";
    await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 60, fileId: "file-60", caption: "Photo 1" },
      postDate: new Date(),
    });

    await completeMediaAlbum(mediaGroupId, { expectedVersion: 0 });

    const stagedSister = await stageMediaAlbumPhoto({
      mediaGroupId,
      chatId,
      photo: { messageId: 61, fileId: "file-61", caption: "" },
      postDate: new Date(),
    });
    expect(stagedSister).toBe("redundant");

    const row = await db.prisma.telegramMediaAlbum.findUniqueOrThrow({
      where: { mediaGroupId },
    });
    expect(row.status).toBe("done");
    expect(row.messageIds).toContain(60);
    expect(row.messageIds).toContain(61);
  });
});
