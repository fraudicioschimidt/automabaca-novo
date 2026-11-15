import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import type { SportResolutionDecision } from "@/src/domain/sports/detect";
import { captureChannelFinancialContext, captureFinancialContext } from "@/src/services/capture/capture-financial-context";
import { handleChannelPost, handleChannelPhotoPost } from "@/src/services/capture/channel/capture-new";
import { handleEditedChannelPost } from "@/src/services/capture/channel/capture-edit";
import { registerBet } from "@/src/services/bets/register";
import { applyBetEdit } from "@/src/services/bets/edit";
import { editManualBet } from "@/src/services/bets/manual";
import { excluirBankroll } from "@/src/services/bankrolls/manage";
import { purgeOldAuditEvents } from "@/src/services/ops/audit-purge";
import { stageMediaAlbumPhoto } from "@/src/services/capture/channel/media-album";
import { telegramDmSource } from "@/src/domain/telegram-source";

/** A Bot API da captura de foto: a imagem só é baixada quando a leitura precisa dela. */
const photoDeps = { loadImage: vi.fn(async () => ({ base64: "aW1hZ2U=", mimeType: "image/jpeg" })) };

const mocks = vi.hoisted(() => ({ text: vi.fn(), image: vi.fn() }));
vi.mock(import("@/src/services/capture/reading/extract-bet"), () => ({ extractBetFromText: mocks.text, extractBetFromImage: mocks.image, extractPlayerBetsFromImage: mocks.image, extractBetsFromImages: mocks.image }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperatorNotification: vi.fn(), sendOperationalAlert: vi.fn() }));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: vi.fn(async () => ({ send: vi.fn(), cancel: vi.fn() })) }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ cancelPendingSharpEnrich: vi.fn(), enqueueSharpEnrich: vi.fn() }));
vi.mock(import("@/src/services/bets/sport-resolution/capture"), async (original) => ({
  ...await original(),
  resolveSportForCaptureAsync: vi.fn(async () => ({ sport: "Soccer", status: "CONFIRMED", confidence: 100, source: "LEGACY", evidence: [], resolverVersion: 1 }) satisfies SportResolutionDecision),
}));
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); vi.clearAllMocks(); mocks.text.mockResolvedValue({ bet: null, provider: "gemini", notBet: true }); });

const chatId = -1009100400n;
const source = `telegram-channel:${chatId}`;
const postDate = new Date("2026-09-01T10:00:00Z");
const text = "⚽ Coquimbo Unido vs Colo Colo\nData: 02/09 16:00\nMercado: Resultado Final\nEntrada: Casa\nODD: 2.10\nStake: 3u";
const post = (messageId = 1, body = text) => ({ chatId, messageId, text: body, postDate });
async function bank(stakePolicy: "ALWAYS" | "WHEN_MISSING" | "MESSAGE" = "ALWAYS") {
  return db.prisma.bankroll.create({ data: { nome: "C04 sintético", slug: "c04", telegramChannelId: chatId, valorUnidade: 100, stakePolicy, defaultStakeUnits: stakePolicy === "MESSAGE" ? null : 1, defaultBookmaker: "Betano" } });
}
async function row(messageId = 1) { return db.prisma.bet.findFirstOrThrow({ where: { source, sourceExternalId: String(messageId) }, include: { captureEvidence: true } }); }
function fields(bet: Awaited<ReturnType<typeof row>>) { return { data: bet.data, evento: bet.evento, esporte: bet.esporte, competicao: bet.competicao, pais: bet.pais, mercado: bet.mercado, selecao: bet.selecao, casaDeAposta: bet.casaDeAposta, odds: Number(bet.odds), stake: Number(bet.stake) }; }

it("exclusão definitiva da banca remove o contexto e conserva o recibo da origem", async () => {
  const br = await bank();
  await handleChannelPost(post());
  expect(await db.prisma.captureFinancialContext.count()).toBe(1);
  await excluirBankroll(br.id, "operador-sintetico");
  expect(await db.prisma.captureFinancialContext.count()).toBe(0);
  expect(await db.prisma.bet.count()).toBe(0);
  expect(await db.prisma.retiredBetSource.count({ where: { source, sourceExternalId: "1" } })).toBe(1);
});

it.each(["ALWAYS", "WHEN_MISSING"] as const)("conserva %s após purga real de evidências e mudança de banca", async (policy) => {
  const br = await bank(policy);
  const body = policy === "WHEN_MISSING" ? text.replace("Stake: 3u", "") : text;
  expect((await handleChannelPost(post(1, body))).kind).toBe("registered");
  const original = await row();
  expect(Number(original.stake)).toBe(1);
  expect(original.captureStakeSnapshot).toMatchObject({ basis: "CAPTURE", stakePolicy: policy });
  await db.prisma.betCaptureEvidence.update({ where: { betId: original.id }, data: { expiresAt: new Date(0) } });
  await purgeOldAuditEvents();
  expect(await db.prisma.betCaptureEvidence.findUnique({ where: { betId: original.id } })).toBeNull();
  expect(await db.prisma.captureFinancialContext.count()).toBe(1);
  await db.prisma.bankroll.update({ where: { id: br.id }, data: { stakePolicy: "MESSAGE", defaultStakeUnits: null, valorUnidade: 250 } });
  // Edição de post já capturado não muda a aposta.
  expect(await handleEditedChannelPost(post(1, body.replace("2.10", "2.20")))).toEqual({ kind: "ignored", reason: "post_ja_capturado" });
  const after = await row();
  expect(Number(after.stake)).toBe(1); expect(Number(after.valorUnidade)).toBe(100); expect(Number(after.odds)).toBe(2.1);
  expect(after.captureStakeSnapshot).toEqual(original.captureStakeSnapshot);
});

it("retoma captura incompleta com configuração anterior e mensagens novas usam a nova", async () => {
  const br = await bank();
  expect((await handleChannelPost(post(1, text.replace("ODD: 2.10", "")))).kind).toBe("unparseable");
  await db.prisma.bankroll.update({ where: { id: br.id }, data: { stakePolicy: "ALWAYS", defaultStakeUnits: 2, valorUnidade: 200 } });
  await handleChannelPost(post());
  expect(Number((await row()).stake)).toBe(1); expect(Number((await row()).valorUnidade)).toBe(100);
  await handleChannelPost(post(2, text.replace("Entrada: Casa", "Entrada: Fora")));
  expect(Number((await row(2)).stake)).toBe(2); expect(Number((await row(2)).valorUnidade)).toBe(200);
});

it("mantém a unidade mesmo quando a banca muda durante a leitura de imagem", async () => {
  const br = await bank("MESSAGE");
  mocks.image.mockImplementationOnce(async (_image, _caption, _now, settings) => {
    expect(settings.stakePolicy).toBe("MESSAGE");
    await db.prisma.bankroll.update({ where: { id: br.id }, data: { valorUnidade: 300, stakePolicy: "ALWAYS", defaultStakeUnits: 2 } });
    return { provider: "gemini", bet: { evento: "Coquimbo Unido vs Colo Colo", esporte: "Soccer", competicao: "", pais: "", mercado: "Money Line – Match", selecao: "Coquimbo Unido", casaDeAposta: "Betano", data: new Date("2026-09-02T19:00:00Z"), odds: 2.1, stake: 3 } };
  });
  expect((await handleChannelPhotoPost({ ...post(), caption: text, mediaFileId: "foto-teste" }, photoDeps)).kind).toBe("registered");
  expect(Number((await row()).valorUnidade)).toBe(100); expect(Number((await row()).stake)).toBe(3);
});

it("conserva associação e regra sob concorrência e remapeamento do canal", async () => {
  const br = await bank();
  const contexts = await Promise.all(Array.from({ length: 6 }, () => captureChannelFinancialContext(post())));
  expect(new Set(contexts.map((x) => x?.financialContextId)).size).toBe(1);
  expect(await db.prisma.captureFinancialContext.count()).toBe(1);
  await db.prisma.bankroll.update({ where: { id: br.id }, data: { telegramChannelId: null } });
  await db.prisma.bankroll.create({ data: { nome: "Outra", slug: "outra", telegramChannelId: chatId, valorUnidade: 500 } });
  await handleChannelPost(post());
  expect((await row()).bankrollId).toBe(br.id); expect(Number((await row()).valorUnidade)).toBe(100);
});

it("álbum conserva regra da primeira foto mesmo quando muda a foto vencedora", async () => {
  const br = await bank();
  await stageMediaAlbumPhoto({ chatId: String(chatId), mediaGroupId: "c04-album", photo: { messageId: 10, fileId: "first", caption: "" }, postDate });
  await db.prisma.bankroll.update({ where: { id: br.id }, data: { valorUnidade: 500, defaultStakeUnits: 4 } });
  await stageMediaAlbumPhoto({ chatId: String(chatId), mediaGroupId: "c04-album", photo: { messageId: 11, fileId: "second", caption: text }, postDate });
  const context = await captureChannelFinancialContext({ ...post(11), mediaGroupId: "c04-album" });
  expect(context?.defaultStakeUnits).toBe(1);
  const saved = await db.prisma.captureFinancialContext.findUniqueOrThrow({ where: { id: context!.financialContextId } });
  expect(Number(saved.valorUnidade)).toBe(100); expect(saved.sourceExternalId).toBe("album:c04-album");
  const registered = await registerBet({ bankrollId: br.id, source, sourceExternalId: "11", data: postDate, evento: "A vs B", esporte: "Soccer", mercado: "Total", selecao: "Over 2.5", odds: 2, stake: 1 }, { financialContextId: saved.id });
  expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: registered.betId } })).captureFinancialContextId).toBe(saved.id);
});

it("foto vencedora de álbum pedida sem o álbum (conserto, captura forçada) usa a configuração presa ao álbum", async () => {
  const br = await bank();
  await stageMediaAlbumPhoto({ chatId: String(chatId), mediaGroupId: "c04-album", photo: { messageId: 10, fileId: "first", caption: "" }, postDate });
  await stageMediaAlbumPhoto({ chatId: String(chatId), mediaGroupId: "c04-album", photo: { messageId: 11, fileId: "second", caption: text }, postDate });
  await db.prisma.bankroll.update({ where: { id: br.id }, data: { valorUnidade: 500, stakePolicy: "MESSAGE", defaultStakeUnits: null } });
  const context = await captureChannelFinancialContext(post(11));
  expect(context).toMatchObject({ stakePolicy: "ALWAYS", defaultStakeUnits: 1 });
  const saved = await db.prisma.captureFinancialContext.findUniqueOrThrow({ where: { id: context!.financialContextId } });
  expect(saved.sourceExternalId).toBe("album:c04-album"); expect(Number(saved.valorUnidade)).toBe(100);
  expect(await db.prisma.captureFinancialContext.count()).toBe(1);

  // A captura forçada lê com a política do álbum, não com a da banca de agora.
  mocks.image.mockImplementationOnce(async (_image, _caption, _now, settings) => {
    expect(settings).toMatchObject({ stakePolicy: "ALWAYS", defaultStakeUnits: 1 });
    return { provider: "gemini", bet: { evento: "Coquimbo Unido vs Colo Colo", esporte: "Soccer", competicao: "", pais: "", mercado: "Money Line – Match", selecao: "Coquimbo Unido", casaDeAposta: "Betano", data: new Date("2026-09-02T19:00:00Z"), odds: 2.1, stake: 1 } };
  });
  const caption = text.replace("\nStake: 3u", "");
  expect((await handleChannelPhotoPost({ ...post(11), caption, mediaFileId: "second", forcedByOperator: true }, photoDeps)).kind).toBe("registered");
  expect((await row(11)).captureFinancialContextId).toBe(saved.id);
  expect(Number((await row(11)).valorUnidade)).toBe(100); expect(Number((await row(11)).stake)).toBe(1);
});

it("DM congela unidade ao escolher banca e mantém stake explícita por destino", async () => {
  const br = await bank();
  const dmSource = telegramDmSource("42", br.id);
  const context = await captureFinancialContext({ source: dmSource, sourceExternalId: "17" }, { bankrollId: br.id, explicitStake: true });
  await db.prisma.bankroll.update({ where: { id: br.id }, data: { valorUnidade: 400 } });
  const result = await registerBet({ bankrollId: br.id, source: dmSource, sourceExternalId: "17", data: postDate, evento: "A vs B", esporte: "Soccer", mercado: "Total", selecao: "Over 2.5", odds: 2, stake: 3 }, { financialContextId: context!.id });
  const saved = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
  expect(Number(saved.valorUnidade)).toBe(100); expect(Number(saved.stake)).toBe(3);
  expect(saved.captureStakeSnapshot).toMatchObject({ stakePolicy: "MESSAGE", originalStake: 3 });
});

it("recusa contexto de outra mensagem e configuração adulterada na leitura", async () => {
  const br = await bank(); const context = await captureChannelFinancialContext(post());
  const input = { bankrollId: br.id, source, sourceExternalId: "2", data: postDate, evento: "A vs B", esporte: "Soccer", mercado: "Total", selecao: "Over 2.5", odds: 2, stake: 1 };
  await expect(registerBet(input, { financialContextId: context!.financialContextId })).rejects.toThrow(/origem/);
  await expect(registerBet({ ...input, sourceExternalId: "1", stake: 3 }, { financialContextId: context!.financialContextId })).rejects.toThrow(/stake/);
  expect(await db.prisma.bet.count()).toBe(0);
});

it("contexto é imutável também por SQL direto", async () => {
  await bank(); const context = await captureChannelFinancialContext(post());
  await expect(db.prisma.$executeRaw`UPDATE capture_financial_contexts SET "valorUnidade" = 200 WHERE id = ${context!.financialContextId}`).rejects.toThrow(/immutable/);
});

it("correção pelo painel conserva stake e odd contra edição posterior do Telegram", async () => {
  await bank(); await handleChannelPost(post()); const original = await row();
  await editManualBet(original.id, { home: "Coquimbo Unido", away: "Colo Colo", date: "2026-09-02", time: "16:00", market: original.mercado, line: original.selecao, odds: 2.5, stake: 0.5, casa: "Betano" }, "operador-sintetico", original.manualSettlementVersion);
  expect(await row()).toMatchObject({ manualStakeOverride: true, manualOddsOverride: true });
  await db.prisma.auditEvent.deleteMany(); await db.prisma.betCaptureEvidence.delete({ where: { betId: original.id } });
  await handleEditedChannelPost(post(1, text.replace("2.10", "2.40").replace("Stake: 3u", "Stake: 9u")));
  expect(Number((await row()).stake)).toBe(0.5); expect(Number((await row()).odds)).toBe(2.5);
  // Um resolvedor atrasado também não pode repor a stake lida antes da correção.
  await applyBetEdit({ betId: original.id, actor: "sport-resolver", fields: fields(original) });
  expect(Number((await row()).stake)).toBe(0.5); expect(Number((await row()).odds)).toBe(2.5);
});


it.each(["texto", "foto"] as const)("post de %s com o canal pausado congela a unidade da chegada", async (via) => {
  const br = await bank();
  await db.prisma.bankroll.update({ where: { id: br.id }, data: { capturePausedAt: postDate } });
  const photo = { chatId, messageId: 7, caption: text, postDate, mediaFileId: "file-7" };
  const outcome = via === "texto" ? await handleChannelPost(post(7)) : await handleChannelPhotoPost(photo, photoDeps);
  expect(outcome).toEqual({ kind: "skipped", reason: "canal_pausado" });
  // O dono pegou a aposta quando o post chegou: é a unidade daquele instante.
  const frozen = await db.prisma.captureFinancialContext.findUniqueOrThrow({ where: { source_sourceExternalId: { source, sourceExternalId: "7" } } });
  expect(Number(frozen.valorUnidade)).toBe(100);

  await db.prisma.bankroll.update({ where: { id: br.id }, data: { valorUnidade: 300, capturePausedAt: null } });
  if (via === "texto") {
    expect((await handleChannelPost(post(7), { forcedByOperator: true })).kind).toBe("registered");
    expect(Number((await row(7)).valorUnidade)).toBe(100);
  }
  expect(await db.prisma.captureFinancialContext.count()).toBe(1);
});
