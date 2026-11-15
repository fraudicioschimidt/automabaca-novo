import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  recordUnmappedChannel,
  CHANNEL_POST_TEXT_LIMIT,
} from "@/src/services/capture/channel/channel-post-archive";
import { getCanaisMonitorados } from "@/src/services/painel/operacoes/channels";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
});

describe("auditoria de canal Telegram sem bankroll", () => {
  it("consolida o ruído por canal em janelas de seis horas", async () => {
    const start = new Date("2026-07-22T00:00:00Z");
    await expect(recordUnmappedChannel({
      chatId: -1001n,
      messageId: 1,
      kind: "text",
      text: "A vs B @2.00",
      now: start,
    })).resolves.toBe(true);
    await expect(recordUnmappedChannel({
      chatId: -1001n,
      messageId: 2,
      kind: "photo",
      text: "Legenda da foto",
      mediaFileId: "telegram-file-2",
      now: new Date(start.getTime() + 60 * 60_000),
    })).resolves.toBe(false);
    await expect(recordUnmappedChannel({
      chatId: -1001n,
      messageId: 3,
      kind: "text",
      now: new Date(start.getTime() + 7 * 60 * 60_000),
    })).resolves.toBe(true);
    await expect(db.prisma.auditEvent.count({
      where: { action: "canal_sem_bankroll", resourceId: "-1001" },
    })).resolves.toBe(2);
    await expect(db.prisma.auditEvent.count({
      where: { action: "canal_sem_bankroll_payload" },
    })).resolves.toBe(3);
    const photo = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "canal_sem_bankroll_payload", resourceId: "-1001:2" },
    });
    expect(photo.details).toMatchObject({
      chatId: "-1001",
      messageId: 2,
      kind: "photo",
      text: "Legenda da foto",
      textTruncated: false,
      mediaFileId: "telegram-file-2",
    });
  });

  it("deduplica o mesmo update e limita texto sem perder a sinalização", async () => {
    const text = "x".repeat(CHANNEL_POST_TEXT_LIMIT + 10);
    const params = { chatId: -2002n, messageId: 9, kind: "text" as const, text };
    await recordUnmappedChannel(params);
    await recordUnmappedChannel(params);
    const captures = await db.prisma.auditEvent.findMany({
      where: { action: "canal_sem_bankroll_payload", resourceId: "-2002:9" },
    });
    expect(captures).toHaveLength(1);
    expect(captures[0]?.details).toMatchObject({ textTruncated: true });
    expect((captures[0]?.details as { text: string }).text).toHaveLength(CHANNEL_POST_TEXT_LIMIT);
  });

  it("serializa reentregas concorrentes do mesmo update", async () => {
    const params = {
      chatId: -3003n,
      messageId: 11,
      kind: "photo" as const,
      text: "Foto concorrente",
      mediaFileId: "file-11",
    };
    await Promise.all([recordUnmappedChannel(params), recordUnmappedChannel(params)]);
    await expect(db.prisma.auditEvent.count({
      where: { action: "canal_sem_bankroll_payload", resourceId: "-3003:11" },
    })).resolves.toBe(1);
  });

  it("mostra no Monitoramento todos os posts preservados na janela de 30 dias", async () => {
    const now = new Date();
    const chatId = -4004n;
    await recordUnmappedChannel({
      chatId,
      messageId: 1,
      kind: "text",
      text: "Post antigo ainda retido",
      now: new Date(now.getTime() - 20 * 86_400_000),
    });
    for (let messageId = 2; messageId <= 6; messageId += 1) {
      await recordUnmappedChannel({
        chatId,
        messageId,
        kind: "text",
        text: `Post recente ${messageId}`,
        now,
      });
    }

    await expect(db.prisma.auditEvent.count({
      where: { action: "canal_sem_bankroll", resourceId: String(chatId) },
    })).resolves.toBe(2);
    await expect(db.prisma.auditEvent.count({
      where: { action: "canal_sem_bankroll_payload" },
    })).resolves.toBe(6);

    const data = await getCanaisMonitorados();
    expect(data.orfaos).toContainEqual({
      channelId: String(chatId),
      postsPreservados: 6,
      ultimaVez: expect.any(Date),
    });
  });

  it("preserva o total quando a lista visível de canais órfãos passa de 20", async () => {
    const now = new Date();
    for (let index = 0; index < 21; index += 1) {
      await recordUnmappedChannel({
        chatId: BigInt(-5000 - index),
        messageId: 1,
        kind: "text",
        text: `Canal órfão ${index}`,
        now: new Date(now.getTime() - index * 1_000),
      });
    }

    const data = await getCanaisMonitorados();
    expect(data.orfaosTotal).toBe(21);
    expect(data.orfaos).toHaveLength(20);
  });
});
