import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { CHANNEL_ID, POST_DATE, POST_TEXT, editedPost, post, seedChannelBankroll } from "../helpers/telegram-channel";

/**
 * Edição de post de canal ponta a ponta contra Postgres real. O que foi
 * capturado vale: a edição nunca muda a aposta. Só o rascunho que ainda não
 * virou aposta se completa, até 30 min depois do post e antes do jogo.
 */
const geminiMocks = vi.hoisted(() => ({
  extractBetFromText: vi.fn(),
  extractBetFromImage: vi.fn(),
}));
vi.mock(import("@/src/services/capture/reading/extract-bet"), () => geminiMocks);

import { handleChannelPhotoPost, handleChannelPost } from "@/src/services/capture/channel/capture-new";
import { handleEditedChannelPhoto, handleEditedChannelPost } from "@/src/services/capture/channel/capture-edit";
import type { Api } from "grammy";
import { processTelegramDeferredJob } from "@/src/telegram/deferred";
import { toNumber } from "@/src/domain/money";
import { softDeleteBet } from "@/src/services/bets/remove";
import { applyAlbumCaptionEdit, stageMediaAlbumPhoto } from "@/src/services/capture/channel/media-album";
import type { ChannelCaptureOutcome } from "@/src/services/capture/channel/register-post";

/** A Bot API da captura de foto: a imagem só é baixada quando a leitura precisa dela. */
const photoDeps = { loadImage: vi.fn(async () => ({ base64: "aW1hZ2U=", mimeType: "image/jpeg" })) };

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  geminiMocks.extractBetFromText.mockReset();
  geminiMocks.extractBetFromImage.mockReset();
  geminiMocks.extractBetFromText.mockResolvedValue({ bet: null, provider: "gemini", notBet: true });
  geminiMocks.extractBetFromImage.mockResolvedValue({ bet: null, provider: "gemini", notBet: true });
});

const minutes = (n: number) => new Date(POST_DATE.getTime() + n * 60_000);
// POST_TEXT: jogo em 15/06 16:00 de São Paulo.
const KICKOFF = new Date("2026-06-15T19:00:00Z");
const DRAFT = POST_TEXT.replace("ODD: 2.10", "ODD:");

describe("edição de post que já virou aposta", () => {
  it.each([
    ["odd", POST_TEXT.replace("2.10", "2.40")],
    ["stake", POST_TEXT.replace("Stake: 1u", "Stake: 3u")],
    ["seleção", POST_TEXT.replace("Entrada: Casa", "Entrada: Fora")],
    ["resultado GREEN", `${POST_TEXT}\n✅ GREEN`],
    ["resultado VOID", `${POST_TEXT}\nAnulada — void`],
    ["cashout", `${POST_TEXT}\nCashout`],
  ])("mudança de %s é ignorada e a aposta fica como foi capturada", async (_caso, text) => {
    await seedChannelBankroll(db);
    const created = await handleChannelPost(post(POST_TEXT));
    if (created.kind !== "registered") throw new Error("setup falhou");
    const before = await db.prisma.bet.findUniqueOrThrow({ where: { id: created.betId } });

    for (const editDate of [minutes(5), minutes(24 * 60)]) {
      expect(await handleEditedChannelPost(editedPost(text, editDate))).toEqual({ kind: "ignored", reason: "post_ja_capturado" });
    }
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: created.betId } });
    expect(after).toMatchObject({ status: "PENDING", selecao: before.selecao, lucro: before.lucro });
    expect(toNumber(after.odds)).toBe(toNumber(before.odds));
    expect(toNumber(after.stake)).toBe(toNumber(before.stake));
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();
    expect(await db.prisma.operationalAction.count()).toBe(0);
  });

  it("aposta removida pelo 👎 não volta pela edição", async () => {
    await seedChannelBankroll(db);
    const created = await handleChannelPost(post(POST_TEXT));
    if (created.kind !== "registered") throw new Error("setup falhou");
    await softDeleteBet({ betId: created.betId, actor: "manual:teste", motivo: "conferência de teste", origin: "reacao" });
    expect(await handleEditedChannelPost(editedPost(POST_TEXT.replace("2.10", "2.20"), minutes(5))))
      .toEqual({ kind: "ignored", reason: "post_ja_capturado" });
    expect(await db.prisma.bet.count()).toBe(1);
  });
});

describe("rascunho completado na edição", () => {
  it("até 30 min depois do post e antes do jogo, registra com a entrada no horário da edição", async () => {
    await seedChannelBankroll(db);
    expect((await handleChannelPost(post(DRAFT, 700))).kind).toBe("unparseable");
    const editedAt = minutes(20);
    expect((await handleEditedChannelPost(editedPost(POST_TEXT, editedAt, 700))).kind).toBe("registered");
    const bet = await db.prisma.bet.findFirstOrThrow({ where: { sourceExternalId: "700" } });
    expect(bet.sourcePostedAt?.toISOString()).toBe(editedAt.toISOString());
    expect(bet.data.toISOString()).toBe(KICKOFF.toISOString());
  });

  it("exatamente 30 minutos ainda registra; um milissegundo depois não", async () => {
    await seedChannelBankroll(db);
    expect((await handleEditedChannelPost(editedPost(POST_TEXT, minutes(30), 706))).kind).toBe("registered");
    expect(await handleEditedChannelPost(editedPost(POST_TEXT, new Date(minutes(30).getTime() + 1), 707)))
      .toEqual({ kind: "ignored", reason: "edicao_fora_da_janela" });
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("edição sem a data da edição é ignorada (falha fechado)", async () => {
    await seedChannelBankroll(db);
    await handleChannelPost(post(DRAFT, 705));
    expect(await handleEditedChannelPost(post(POST_TEXT, 705))).toEqual({ kind: "ignored", reason: "edicao_sem_data" });
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("depois de 30 min é ignorado, sem aviso", async () => {
    await seedChannelBankroll(db);
    await handleChannelPost(post(DRAFT, 701));
    expect(await handleEditedChannelPost(editedPost(POST_TEXT, minutes(31), 701)))
      .toEqual({ kind: "ignored", reason: "edicao_fora_da_janela" });
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await db.prisma.operationalAction.count()).toBe(0);
  });

  it("dentro da janela mas depois do kickoff lido é ignorado, sem aviso", async () => {
    await seedChannelBankroll(db);
    const lateText = DRAFT.replace("Data: 15/06 16:00", "Data: 10/06 09:10");
    await handleChannelPost(post(lateText, 702));
    expect(await handleEditedChannelPost(editedPost(lateText.replace("ODD:", "ODD: 2.10"), minutes(15), 702)))
      .toEqual({ kind: "ignored", reason: "edicao_depois_do_jogo" });
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await db.prisma.operationalAction.count()).toBe(0);
  });

  it("sem data no texto, o kickoff provisório é o horário da edição", async () => {
    await seedChannelBankroll(db);
    const undated = DRAFT.replace("Data: 15/06 16:00\n", "");
    await handleChannelPost(post(undated, 703));
    const editedAt = minutes(10);
    expect((await handleEditedChannelPost(editedPost(undated.replace("ODD:", "ODD: 2.10"), editedAt, 703))).kind).toBe("registered");
    const bet = await db.prisma.bet.findFirstOrThrow({ where: { sourceExternalId: "703" } });
    expect(bet).toMatchObject({ kickoffInferido: true });
    expect(bet.data.toISOString()).toBe(editedAt.toISOString());
    expect(bet.sourcePostedAt?.toISOString()).toBe(editedAt.toISOString());
  });

  it("post barrado pelo filtro que o tipster completa na janela vira aposta", async () => {
    await seedChannelBankroll(db);
    expect((await handleChannelPost(post("Flamengo x Palmeiras hoje", 704))).kind).toBe("skipped");
    expect((await handleEditedChannelPost(editedPost(POST_TEXT, minutes(5), 704))).kind).toBe("registered");
  });
});

describe("foto com a legenda editada", () => {
  const photo = (patch: Partial<Parameters<typeof handleEditedChannelPhoto>[0]> = {}) => ({
    chatId: CHANNEL_ID, messageId: 800, caption: "Legenda completa\nStake: 1u", postDate: POST_DATE, editDate: minutes(10), fileId: "foto-800", ...patch,
  });

  it("rascunho na janela relê a foto na hora; fora dela ou já capturado, não", async () => {
    await seedChannelBankroll(db);
    const enqueue = vi.fn(async (): Promise<ChannelCaptureOutcome> => ({ kind: "registered", betId: "b", sportResolutionStatus: "CONFIRMED" }));
    expect(await handleEditedChannelPhoto(photo(), enqueue)).toEqual({ kind: "registered", betId: "b", sportResolutionStatus: "CONFIRMED" });

    expect(await handleEditedChannelPhoto(photo({ editDate: minutes(45) }), enqueue))
      .toEqual({ kind: "ignored", reason: "edicao_fora_da_janela" });
    await handleChannelPost(post(POST_TEXT, 801));
    expect(await handleEditedChannelPhoto(photo({ messageId: 801 }), enqueue))
      .toEqual({ kind: "ignored", reason: "post_ja_capturado" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("álbum ainda aberto recebe a legenda nova e não relê nada fora do flush", async () => {
    await seedChannelBankroll(db);
    await stageMediaAlbumPhoto({ mediaGroupId: "album-edit", chatId: String(CHANNEL_ID), photo: { messageId: 810, fileId: "a", caption: "" }, postDate: POST_DATE });
    const enqueue = vi.fn(async (): Promise<ChannelCaptureOutcome> => ({ kind: "skipped", reason: "nao_deveria_ler" }));
    expect(await handleEditedChannelPhoto(photo({ messageId: 810, mediaGroupId: "album-edit" }), enqueue))
      .toEqual({ kind: "skipped", reason: "album_em_captura" });
    expect(enqueue).not.toHaveBeenCalled();
    expect((await db.prisma.telegramMediaAlbum.findUniqueOrThrow({ where: { mediaGroupId: "album-edit" } })).winnerCaption)
      .toBe("Legenda completa\nStake: 1u");
  });

  it.each([
    ["fora dos 30 min", minutes(31), "edicao_fora_da_janela"],
    ["sem data", undefined, "edicao_sem_data"],
    ["antes do post", minutes(-1), "edicao_fora_da_janela"],
  ])("álbum aberto ignora edição %s sem alterar a legenda", async (_label, editDate, reason) => {
    await seedChannelBankroll(db);
    await stageMediaAlbumPhoto({ mediaGroupId: "album-late", chatId: String(CHANNEL_ID), photo: { messageId: 810, fileId: "a", caption: "original" }, postDate: POST_DATE });
    const capture = vi.fn(async (): Promise<ChannelCaptureOutcome> => ({ kind: "skipped", reason: "nao_deveria_ler" }));
    expect(await handleEditedChannelPhoto(photo({ messageId: 810, editDate, mediaGroupId: "album-late" }), capture))
      .toEqual({ kind: "ignored", reason });
    expect((await db.prisma.telegramMediaAlbum.findUniqueOrThrow({ where: { mediaGroupId: "album-late" } })).winnerCaption).toBe("original");
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([false, true])("flush de álbum editado respeita o instante da edição (jogo começou: %s)", async (started) => {
    await seedChannelBankroll(db);
    const text = started ? POST_TEXT.replace("Data: 15/06 16:00", "Data: 10/06 09:10") : POST_TEXT;
    await stageMediaAlbumPhoto({ mediaGroupId: "album-clock", chatId: String(CHANNEL_ID), photo: { messageId: 810, fileId: "", caption: "" }, postDate: POST_DATE });
    const editedAt = minutes(15);
    expect(await handleEditedChannelPost({ ...editedPost(text, editedAt, 810), mediaGroupId: "album-clock" }))
      .toEqual({ kind: "skipped", reason: "album_em_captura" });
    const outcome = await processTelegramDeferredJob({ kind: "media_album_flush", chatId: String(CHANNEL_ID), mediaGroupId: "album-clock" }, {
      api: {} as Api, token: "synthetic", retryCount: 0,
    });
    if (started) {
      expect(outcome).toEqual({ kind: "ignored", reason: "edicao_depois_do_jogo" });
      expect(await db.prisma.bet.count()).toBe(0);
    } else {
      expect(outcome?.kind).toBe("registered");
      expect((await db.prisma.bet.findFirstOrThrow()).sourcePostedAt).toEqual(editedAt);
    }
  });

  it.each(["legenda", "instante"])("leitura de álbum só com texto é descartada se mudou a %s", async (change) => {
    await seedChannelBankroll(db);
    await stageMediaAlbumPhoto({ mediaGroupId: "album-stale", chatId: String(CHANNEL_ID), photo: { messageId: 810, fileId: "", caption: POST_TEXT }, postDate: POST_DATE });
    // O flush já leu o estado original; a edição foi aplicada antes de registrar.
    await applyAlbumCaptionEdit({ chatId: String(CHANNEL_ID), messageId: 810, caption: change === "legenda" ? POST_TEXT.replace("2.10", "2.40") : POST_TEXT, editDate: minutes(10) });
    await expect(handleChannelPost({ ...post(POST_TEXT, 810), mediaGroupId: "album-stale" }))
      .rejects.toMatchObject({ name: "MediaAlbumWinnerChangedError" });
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("a releitura da foto registra com a entrada no horário da edição", async () => {
    await seedChannelBankroll(db);
    const editedAt = minutes(10);
    geminiMocks.extractBetFromImage.mockResolvedValue({
      provider: "gemini",
      bet: { evento: "Coquimbo Unido vs Colo Colo", esporte: "Soccer", competicao: "", pais: "", mercado: "Resultado Final", selecao: "Casa", odds: 2.1, stake: 1, data: KICKOFF, casaDeAposta: "" },
    });
    const outcome = await handleChannelPhotoPost({
      chatId: CHANNEL_ID, messageId: 820, caption: "Coquimbo x Colo Colo\n1u", postDate: POST_DATE, editDate: editedAt,
      mediaFileId: "foto-820",
    }, photoDeps);
    expect(outcome.kind).toBe("registered");
    const bet = await db.prisma.bet.findFirstOrThrow({ where: { sourceExternalId: "820" } });
    expect(bet.sourcePostedAt?.toISOString()).toBe(editedAt.toISOString());
  });
});
