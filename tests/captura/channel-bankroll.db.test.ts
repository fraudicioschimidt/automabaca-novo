import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, type TestDb } from "../helpers/db";
import { CHANNEL_ID, POST_TEXT, post } from "../helpers/telegram-channel";
import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";

/**
 * Canal sem banca: a banca nasce no primeiro post, com o nome e a foto do
 * canal, e o post é capturado por ela. Postgres real; Telegram falso.
 */
const alertMocks = vi.hoisted(() => ({ sendOperationalAlert: vi.fn(), sendOperatorNotification: vi.fn() }));
vi.mock("@/src/services/ops/alerts", async (original) => ({
  ...await original<typeof import("@/src/services/ops/alerts")>(),
  ...alertMocks,
}));
vi.mock(import("@/src/services/capture/reading/extract-bet"), () => ({
  extractBetFromText: vi.fn(async () => ({ bet: null, provider: "gemini" as const, notBet: true as const })),
  extractBetFromImage: vi.fn(), extractBetsFromImages: vi.fn(), extractPlayerBetsFromImage: vi.fn(),
}));

import { handleChannelPost } from "@/src/services/capture/channel/capture-new";
import type { ChannelCaptureDeps, ChannelProfile } from "@/src/services/capture/channel/channel-bankroll";
import { purgeOldAuditEvents, AUDIT_FINANCIAL_RETENTION_DAYS } from "@/src/services/ops/audit-purge";
import { prisma } from "@/src/infra/prisma";
import { createChannelBankroll, editarBankroll, excluirBankroll } from "@/src/services/bankrolls/manage";
import { classifyAuditActor } from "@/src/domain/production-write-actors";
import { resetEnvCacheForTests } from "@/src/infra/env";

// PNG 1×1 válido: passa pela mesma validação do upload do painel.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PROFILE: ChannelProfile = { title: "Tips do Zé 🔥", photoFileId: "foto-do-canal", operatorIsAdmin: true };

let db: TestDb;
let logosDir: string;

function deps(profile: Partial<ChannelProfile> = {}, loadImage: ChannelCaptureDeps["loadImage"] = async () => ({ base64: PNG, mimeType: "image/png" })) {
  return {
    loadChannelProfile: vi.fn(async () => ({ ...PROFILE, ...profile })),
    loadImage: vi.fn(loadImage),
  };
}

function notifications(): string[] {
  return alertMocks.sendOperatorNotification.mock.calls.map((call) => String(call[0]));
}

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => {
  await db.reset();
  alertMocks.sendOperationalAlert.mockReset();
  alertMocks.sendOperatorNotification.mockReset();
  logosDir = mkdtempSync(path.join(os.tmpdir(), "automabaca-logos-canal-"));
  vi.stubEnv("LOGOS_DIR", logosDir);
  resetEnvCacheForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
  safeRemoveTreeSync(os.tmpdir(), logosDir);
});

describe("banca criada pelo primeiro post do canal", () => {
  it.each(["unlink", "delete"] as const)("retirada %s entre a leitura e a transação vence a criação automática", async (action) => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Original", slug: "original", telegramChannelId: CHANNEL_ID } });
    const transaction = prisma.$transaction.bind(prisma);
    // Agenda a decisão do dono antes do BEGIN da criação; todas as operações de banco são reais.
    const gate = vi.spyOn(prisma, "$transaction").mockImplementationOnce((...args) => (async () => {
      if (action === "unlink") await editarBankroll(bank.id, { telegramChannelId: null }, "operador");
      else await excluirBankroll(bank.id, "operador");
      return Reflect.apply(transaction, prisma, args);
    })() as never);
    try {
      expect(await createChannelBankroll({ chatId: CHANNEL_ID, title: "Recriação indevida" })).toEqual({ kind: "retired" });
      expect(await db.prisma.bankroll.count({ where: { telegramChannelId: CHANNEL_ID } })).toBe(0);
    } finally { gate.mockRestore(); }
  });

  it("cria a banca com o nome, a foto e a configuração padrão, e captura o próprio post", async () => {
    const telegram = deps();
    const outcome = await handleChannelPost(post(POST_TEXT, 10), { deps: telegram });
    expect(outcome.kind).toBe("registered");

    const bankroll = await db.prisma.bankroll.findFirstOrThrow({ where: { telegramChannelId: CHANNEL_ID } });
    expect(bankroll).toMatchObject({
      nome: "Tips do Zé 🔥", slug: "tips-do-ze", sharpMode: "CLV_ONLY", capturePolicy: "AUTO", stakePolicy: "MESSAGE",
      defaultStakeUnits: null, vincularContas: true, imageStakeAsUnits: false, playerPropsAutoSettlement: false, defaultBookmaker: null,
    });
    expect(Number(bankroll.capitalInicial)).toBe(100);
    expect(Number(bankroll.valorUnidade)).toBe(100);
    expect(await db.prisma.bet.count({ where: { bankrollId: bankroll.id } })).toBe(1);
    expect(existsSync(path.join(logosDir, `tips-do-ze-${bankroll.id}.png`))).toBe(true);
    expect(telegram.loadImage).toHaveBeenCalledWith("foto-do-canal");

    expect(notifications()).toHaveLength(2);
    expect(notifications()[0]).toMatch(/^🆕 Tipster criado: Tips do Zé 🔥\n/);
    expect(notifications()[0]).toContain("stake só a do post");
    expect(notifications()[0]).toContain("com a foto do canal como logo");
    expect(notifications()[0]).toContain("Config › Tipsters");
    expect(alertMocks.sendOperationalAlert).not.toHaveBeenCalled();

    // A criação é escrita do fluxo automático, não "escrita fora do fluxo".
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bankroll.create", resourceId: bankroll.id } });
    expect(classifyAuditActor(audit.actor, new Set(["operador"]))).toBe("automatic");
    expect(audit.details).toMatchObject({ telegramChannelId: String(CHANNEL_ID), stakePolicy: "MESSAGE" });

    // O segundo post já encontra a banca.
    await handleChannelPost(post(POST_TEXT.replace("Entrada: Casa", "Entrada: Fora"), 11), { deps: telegram });
    expect(telegram.loadChannelProfile).toHaveBeenCalledTimes(1);
    expect(await db.prisma.bankroll.count()).toBe(1);
  });

  it("dois posts ao mesmo tempo criam uma banca só e os dois são capturados", async () => {
    const telegram = deps();
    const outcomes = await Promise.all([
      handleChannelPost(post(POST_TEXT, 20), { deps: telegram }),
      handleChannelPost(post(POST_TEXT.replace("Entrada: Casa", "Entrada: Fora"), 21), { deps: telegram }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["registered", "registered"]);
    expect(await db.prisma.bankroll.count()).toBe(1);
    expect(await db.prisma.bet.count()).toBe(2);
    expect(notifications().filter((text) => text.startsWith("🆕 Tipster criado"))).toHaveLength(1);
  });

  it("falha na foto não trava: a banca nasce sem logo e o post é capturado", async () => {
    const telegram = deps({}, async () => { throw new Error("getFile falhou"); });
    expect((await handleChannelPost(post(POST_TEXT, 30), { deps: telegram })).kind).toBe("registered");
    expect(await db.prisma.bankroll.count()).toBe(1);
    expect(existsSync(path.join(logosDir, "tips-do-ze.png"))).toBe(false);
    expect(notifications()[0]).toContain("sem logo");

    await db.reset();
    alertMocks.sendOperatorNotification.mockReset();
    const notAnImage = deps({}, async () => ({ base64: Buffer.from("GIF89a").toString("base64"), mimeType: "image/png" }));
    expect((await handleChannelPost(post(POST_TEXT, 31), { deps: notAnImage })).kind).toBe("registered");
    expect(notifications()[0]).toContain("sem logo");
  });

  it("canal sem foto nasce sem logo", async () => {
    const telegram = deps({ photoFileId: null });
    expect((await handleChannelPost(post(POST_TEXT, 32), { deps: telegram })).kind).toBe("registered");
    expect(telegram.loadImage).not.toHaveBeenCalled();
  });

  it("canal tirado de uma banca pelo dono não ganha banca nova", async () => {
    const first = await db.prisma.bankroll.create({ data: { nome: "Antiga", slug: "antiga", telegramChannelId: CHANNEL_ID } });
    await excluirBankroll(first.id, "operador");
    const telegram = deps();
    expect(await handleChannelPost(post(POST_TEXT, 40), { deps: telegram }))
      .toEqual({ kind: "skipped", reason: "canal_de_banca_excluida" });
    // Nem pergunta ao Telegram: a decisão do dono já responde.
    expect(telegram.loadChannelProfile).not.toHaveBeenCalled();
    expect(await db.prisma.bankroll.count()).toBe(0);
    expect(notifications()).toEqual([]);
    expect(String(alertMocks.sendOperationalAlert.mock.calls[0]?.[0])).toContain("tipster excluído");
    expect(await db.prisma.auditEvent.count({ where: { action: "canal_sem_bankroll_payload" } })).toBe(1);

    // Apagar o canal da banca (sem excluí-la) também é decisão do dono.
    const otherChannel = CHANNEL_ID - 1n;
    const kept = await db.prisma.bankroll.create({ data: { nome: "Mantida", slug: "mantida", telegramChannelId: otherChannel } });
    await editarBankroll(kept.id, { telegramChannelId: null }, "operador");
    expect(await handleChannelPost({ ...post(POST_TEXT, 41), chatId: otherChannel }, { deps: telegram }))
      .toEqual({ kind: "skipped", reason: "canal_de_banca_excluida" });
    expect(await db.prisma.bankroll.count()).toBe(1);
  });

  it("canal com origem aposentada (apostas de banca excluída) não ganha banca nova", async () => {
    await db.prisma.retiredBetSource.create({ data: { source: `telegram-channel:${CHANNEL_ID}`, sourceExternalId: "1", retiredBetId: "aposta-excluida" } });
    expect(await handleChannelPost(post(POST_TEXT, 42), { deps: deps() }))
      .toEqual({ kind: "skipped", reason: "canal_de_banca_excluida" });
    expect(await db.prisma.bankroll.count()).toBe(0);
  });

  it("canal que o dono não administra não ganha banca", async () => {
    expect(await handleChannelPost(post(POST_TEXT, 50), { deps: deps({ operatorIsAdmin: false }) }))
      .toEqual({ kind: "skipped", reason: "canal_sem_bankroll" });
    expect(await db.prisma.bankroll.count()).toBe(0);
    expect(String(alertMocks.sendOperationalAlert.mock.calls[0]?.[0])).toContain("não é dono nem administrador");
    expect(await db.prisma.auditEvent.count({ where: { action: "canal_sem_bankroll_payload" } })).toBe(1);
  });

  it("canal alheio: o texto do post não é guardado, e os posts seguintes não consultam o Telegram nem gravam", async () => {
    const telegram = deps({ operatorIsAdmin: false });
    for (const messageId of [51, 52, 53]) {
      expect(await handleChannelPost(post(POST_TEXT, messageId), { deps: telegram })).toEqual({ kind: "skipped", reason: "canal_sem_bankroll" });
    }
    expect(telegram.loadChannelProfile).toHaveBeenCalledTimes(1);
    expect(alertMocks.sendOperationalAlert).toHaveBeenCalledTimes(1);
    const stored = await db.prisma.auditEvent.findMany({ where: { action: { startsWith: "canal_sem_bankroll" } }, select: { action: true, details: true } });
    expect(stored).toHaveLength(2);
    expect(stored.find((row) => row.action === "canal_sem_bankroll_payload")?.details).toMatchObject({ messageId: 51, text: null, mediaFileId: null });
    // O intervalo passa: o próximo post confere de novo se o dono virou administrador.
    await db.prisma.auditEvent.updateMany({ where: { action: "canal_sem_bankroll" }, data: { createdAt: new Date(Date.now() - 7 * 3_600_000) } });
    expect(await handleChannelPost(post(POST_TEXT, 54), { deps: deps() })).toMatchObject({ kind: "registered" });
  });
});


it.each(["unlink", "delete"] as const)("canal retirado (%s) continua bloqueado após a retenção anual", async (action) => {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Retirada", slug: "retirada", telegramChannelId: CHANNEL_ID } });
  if (action === "unlink") await editarBankroll(bankroll.id, { telegramChannelId: null }, "operador");
  else await excluirBankroll(bankroll.id, "operador");
  const old = new Date(Date.now() - (AUDIT_FINANCIAL_RETENTION_DAYS + 5) * 86_400_000);
  await db.prisma.auditEvent.updateMany({ where: { action: { in: ["bankroll.update", "bankroll.delete"] } }, data: { createdAt: old } });
  expect(await db.prisma.retiredBetSource.count()).toBe(0);
  await purgeOldAuditEvents();
  const telegram = deps();
  expect(await handleChannelPost(post(POST_TEXT, 70), { deps: telegram })).toEqual({ kind: "skipped", reason: "canal_de_banca_excluida" });
  expect(telegram.loadChannelProfile).not.toHaveBeenCalled();
  expect(await db.prisma.bankroll.count({ where: { telegramChannelId: CHANNEL_ID } })).toBe(0);
});
