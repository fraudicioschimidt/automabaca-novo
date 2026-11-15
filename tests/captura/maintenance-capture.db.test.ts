import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/tests/helpers/db";
const mocks = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock(import("@/src/services/capture/reading/extract-bet"), () => ({ extractBetFromText: mocks.extract, extractBetFromImage: mocks.extract, extractPlayerBetsFromImage: mocks.extract, extractBetsFromImages: mocks.extract }));
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { playerPropRule } from "@/src/domain/settlement/player-prop-rules";
import { handleEditedChannelPost } from "@/src/services/capture/channel/capture-edit";
import { handleChannelPost } from "@/src/services/capture/channel/capture-new";
let db: TestDb;
const chatId = -999902n;
const postDate = new Date("2026-09-12T12:00:00Z");
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); vi.clearAllMocks(); });

it("edição de post já capturado (resultado ou termos) preserva integralmente apostas, props e evidência", async () => {
  const bank = await db.prisma.bankroll.create({ data: { nome: "Maintenance test", slug: "maintenance", telegramChannelId: chatId, valorUnidade: 100 } });
  const caption = "1u cada\nhttps://example.com/ticket/test";
  for (let index = 1; index <= 3; index++) await db.prisma.bet.create({ data: {
    bankrollId: bank.id, source: `telegram-channel:${chatId}`, sourceExternalId: `42:${index}`,
    data: postDate, esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: postDate, evento: "Time A vs Time B", mercado: "Player Shots", selecao: `Jogador ${index} Over 1.5`, odds: 2, stake: 1,
    playerProp: { create: { terms: buildPlayerPropTerms({ mercado: "Player Shots", selecao: `Jogador ${index} Over 1.5`, esporte: "Soccer" })!, rule: playerPropRule("Bet365", "shots_total") } },
    captureEvidence: { create: { caption, parser: "gemini-vision", mediaFileId: "test-photo", parsedJson: {}, expiresAt: new Date("2026-10-12T12:00:00Z") } },
  } });
  const snapshot = () => db.prisma.bet.findMany({ orderBy: { sourceExternalId: "asc" }, include: { playerProp: true, captureEvidence: true } });
  const before = await snapshot();
  const loadImage = vi.fn();
  for (const text of [`${caption}\n✅❌❌`, `${caption}\n✅⛔️⛔️`, caption.replace("1u", "2u")]) {
    expect(await handleEditedChannelPost({ chatId, messageId: 42, postDate, editDate: new Date(postDate.getTime() + 60_000), text }, { loadImage }))
      .toEqual({ kind: "ignored", reason: "post_ja_capturado" });
  }
  expect(await snapshot()).toEqual(before);
  expect(loadImage).not.toHaveBeenCalled();
  expect(mocks.extract).not.toHaveBeenCalled();
});

it("resposta incompleta gera revisão durável e idempotente sem criar aposta", async () => {
  await db.prisma.bankroll.create({ data: { nome: "Maintenance test", slug: "maintenance", telegramChannelId: chatId, valorUnidade: 100 } });
  mocks.extract.mockResolvedValue({ bet: null, provider: null, incompleteDraft: true, missing: ["incomplete_extraction"],
    review: { reason: "incomplete_extraction", description: "Confira os termos na mensagem original", evidence: {} } });
  const post = { chatId, messageId: 570, postDate, text: "Canal de teste\nFaz com 0.50u @1.80" };
  await handleChannelPost(post);
  await handleChannelPost(post);
  expect(await db.prisma.bet.count()).toBe(0);
  const reviews = await db.prisma.operationalAction.findMany({ where: { actionType: "capture_review" } });
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toMatchObject({ status: "OPEN", evidence: { reason: "incomplete_extraction", autoResolve: false } });
});
