import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { resetEnvCacheForTests } from "@/src/infra/env";
import {
  reconcileCaptureRefusalClusters,
  recordCaptureReview,
  reportCaptureRefusal,
  type CaptureRefusal,
} from "@/src/services/capture/capture-review";
import { apagarLegendaDeRevisoesEncerradas, resolverRevisoesDeCapturaGravadas } from "@/src/services/ops/action-resource-gc";

/** O que chegou ao Telegram do dono: o corpo de cada sendMessage. */
const sent: string[] = [];
const originalEnv = { token: process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN, chat: process.env.TELEGRAM_NOTIFICATION_CHAT_ID };
const sentWith = (emoji: string) => sent.filter((text) => text.startsWith(emoji));

let db: TestDb;
const CHAT = -1001234567890n;
const NOW = new Date("2026-09-23T12:00:00Z");

beforeAll(() => {
  process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_NOTIFICATION_CHAT_ID = "123";
  resetEnvCacheForTests();
  db = createTestDb();
});
afterAll(async () => {
  for (const [key, value] of [["TELEGRAM_NOTIFICATION_BOT_TOKEN", originalEnv.token], ["TELEGRAM_NOTIFICATION_CHAT_ID", originalEnv.chat]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCacheForTests();
  vi.unstubAllGlobals();
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  sent.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    sent.push((JSON.parse(init.body) as { text: string }).text);
    return new Response("{}", { status: 200 });
  }));
});

function refusal(messageId: number, reason = "mercado_total_ambiguo"): CaptureRefusal {
  return {
    post: { chatId: CHAT, messageId, postDate: NOW },
    bankroll: { id: "00000000-0000-4000-8000-000000000001", nome: "Carteira Tips" },
    via: "universal",
    reason,
    missing: ["mercado"],
    evento: "Flamengo vs Palmeiras",
    caption: "Flamengo x Palmeiras over 9.5 @1.9 1u",
  };
}

const openReviews = () => db.prisma.operationalAction.findMany({
  where: { actionType: "capture_review", status: "OPEN" }, orderBy: { resourceId: "asc" },
});

describe("reportCaptureRefusal", () => {
  it("grava a telemetria, abre a pendência do post e avisa com o link", async () => {
    await reportCaptureRefusal(refusal(42));

    expect(await db.prisma.auditEvent.findMany({ where: { action: "telegram.parse" }, select: { outcome: true, resourceId: true, details: true } }))
      .toEqual([{ outcome: "guard_rejected", resourceId: "42", details: expect.objectContaining({ reason: "mercado_total_ambiguo", via: "universal" }) }]);
    const [review] = await openReviews();
    expect(review).toMatchObject({
      resource: "telegram-channel",
      resourceId: `${CHAT}:42`,
      title: "Carteira Tips: conferir bilhete da mensagem 42",
      evidence: expect.objectContaining({
        reason: "mercado_total_ambiguo", autoResolve: false, link: "https://t.me/c/1234567890/42",
        postDate: NOW.toISOString(), editDate: null,
      }),
    });
    expect(review?.description).toContain("Total sem dizer a unidade (gols, escanteios ou cartões)");
    const [message] = sentWith("⛔");
    expect(message).toContain("⛔ Aposta não registrada · Carteira Tips");
    expect(message).toContain("Motivo: Total sem dizer a unidade (gols, escanteios ou cartões).");
    expect(message).toContain("https://t.me/c/1234567890/42");
  });

  it("da terceira recusa igual no canal em 24 h, troca o ⛔ por um aviso agrupado com o conserto", async () => {
    await reportCaptureRefusal(refusal(1));
    await reportCaptureRefusal(refusal(2));
    // Retry do mesmo post não conta como recusa nova (nem repete o ⛔).
    await reportCaptureRefusal(refusal(2));
    expect(sentWith("⛔")).toHaveLength(2);

    await reportCaptureRefusal(refusal(3));
    await reportCaptureRefusal(refusal(4));
    expect(sentWith("⛔")).toHaveLength(2);
    expect(sentWith("🔁")).toHaveLength(1);
    const [message] = sentWith("🔁");
    expect(message).toContain("3 posts recusados em 24 h");
    expect(message).toContain("defina os esportes dele em Config › Tipsters");
    expect(message).toContain("Último post: https://t.me/c/1234567890/3");

    const cluster = await db.prisma.operationalAction.findFirstOrThrow({ where: { resource: "bankroll" } });
    expect(cluster).toMatchObject({ status: "OPEN", evidence: expect.objectContaining({ posts: 4, reason: "mercado_total_ambiguo" }) });
    expect(await openReviews()).toHaveLength(4);

    // Outro motivo no mesmo canal segue com o aviso individual.
    await reportCaptureRefusal(refusal(5, "odd_invalida"));
    expect(sentWith("⛔")).toHaveLength(3);
  });

  it("não agrupa o problema de um post só nem a captura que o dono pediu", async () => {
    for (const id of [1, 2, 3, 4]) await reportCaptureRefusal(refusal(id, "lote_incompleto_precisa_revisao"));
    expect(sentWith("⛔")).toHaveLength(4);
    for (const id of [11, 12]) await reportCaptureRefusal(refusal(id));
    const forced = refusal(13);
    await reportCaptureRefusal({ ...forced, post: { ...forced.post, forcedByOperator: true } });
    expect(sentWith("⛔")).toHaveLength(7);
    expect(sentWith("🔁")).toHaveLength(0);
  });

  it("fecha o aviso agrupado quando o motivo sai da janela de 24 h", async () => {
    for (const id of [1, 2, 3]) await reportCaptureRefusal(refusal(id));
    expect(await reconcileCaptureRefusalClusters(new Date())).toBe(0);
    await db.prisma.auditEvent.updateMany({ where: { action: "telegram.parse" }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect(await reconcileCaptureRefusalClusters(new Date())).toBe(1);
    expect(await db.prisma.operationalAction.findFirstOrThrow({ where: { resource: "bankroll" } })).toMatchObject({ status: "RESOLVED" });
    // A pendência de cada post espera o dono.
    expect(await openReviews()).toHaveLength(3);
  });
});

describe("pendência de captura", () => {
  it("fecha sozinha quando o post vira aposta, inclusive como item de lote", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Carteira Tips", slug: "carteira", telegramChannelId: CHAT, valorUnidade: 100 } });
    for (const id of [42, 43, 420]) await reportCaptureRefusal(refusal(id));
    await db.prisma.bet.create({ data: {
      bankrollId: bank.id, source: `telegram-channel:${CHAT}`, sourceExternalId: "42:2", data: NOW, esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: NOW,
      evento: "Flamengo vs Palmeiras", mercado: "Total (Corners) – Match", selecao: "Over 9.5", odds: 1.9, stake: 1,
    } });

    expect(await resolverRevisoesDeCapturaGravadas()).toBe(1);
    expect((await openReviews()).map((action) => action.resourceId)).toEqual([`${CHAT}:420`, `${CHAT}:43`]);
  });

  it("fecha mais de uma página de pendências, deixa o lote alterado e apaga a legenda das encerradas", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Carteira Tips", slug: "carteira", telegramChannelId: CHAT } });
    const ids = Array.from({ length: 205 }, (_, index) => index + 1);
    await db.prisma.bet.createMany({ data: ids.map((id) => ({
      bankrollId: bank.id, source: `telegram-channel:${CHAT}`, sourceExternalId: String(id), data: NOW, esporte: "Soccer",
      sportResolutionStatus: "CONFIRMED" as const, sportResolvedAt: NOW, evento: "Time A vs Time B", mercado: "Money Line – Match", selecao: `Time ${id}`, odds: 2, stake: 1,
    })) });
    await db.prisma.operationalAction.createMany({ data: ids.map((id) => ({
      fingerprint: `telegram.capture-review:teste-${id}`, area: "captura", actionType: "capture_review", title: `post ${id}`, description: "conferir",
      resource: "telegram-channel", resourceId: `${CHAT}:${id}`,
      evidence: { reason: id === 7 ? "lote_alterado_precisa_revisao" : "odd_invalida", caption: "texto do tipster", autoResolve: false },
    })) });

    expect(await resolverRevisoesDeCapturaGravadas()).toBe(204);
    expect((await openReviews()).map((action) => action.resourceId)).toEqual([`${CHAT}:7`]);

    expect(await apagarLegendaDeRevisoesEncerradas()).toBe(204);
    const closed = await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: `${CHAT}:8` } });
    expect(closed.evidence).toEqual({ reason: "odd_invalida", autoResolve: false });
    expect((await openReviews())[0]?.evidence).toMatchObject({ caption: "texto do tipster" });
  });

  it("retém um único bilhete em revisão após reentrega, sem criar apostas", async () => {
    const input = { chatId: -1003916092732n, messageId: 43, caption: "Igux Props VIP", mediaFileId: "telegram-photo", bankroll: "Igux", review: { reason: "combined_player_ticket", description: "Dupla com cotação única", evidence: { odds: 16, stake: .5, selecao: "Thaciano chutes no alvo + marcar" } } };
    const first = await recordCaptureReview(input);
    const repeated = await recordCaptureReview(input);
    expect(repeated.id).toBe(first.id);
    expect(await db.prisma.operationalAction.count()).toBe(1);
    expect(repeated.evidence).toMatchObject({ autoResolve: false, reason: "combined_player_ticket", mediaFileId: "telegram-photo", link: "https://t.me/c/3916092732/43", extraction: { odds: 16, stake: .5 } });
    expect(await db.prisma.bet.count()).toBe(0);
  });
});
