import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import { createBoss } from "@/src/infra/boss";
import { QUEUES } from "@/src/infra/queue-contract";
import { ensureQueueWithDeadLetter } from "@/src/jobs/queues";
import { TELEGRAM_QUEUE_OPTIONS } from "@/src/telegram/bot";
import { enqueueTelegramJob } from "@/src/services/scheduling/enqueue-telegram-job";
import type { TelegramJob } from "@/src/domain/telegram-job";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * A fila `telegram.updates` contra o pg-boss real (`key_strict_fifo`): a
 * edição espera o post, posts diferentes andam juntos, a reentrega não
 * duplica e o job em retry segura só a chave do próprio post.
 */

let db: TestDb;
let boss: PgBoss;
const Q = QUEUES.telegramUpdates;

beforeAll(async () => {
  db = createTestDb();
  boss = createBoss();
  await boss.start();
  await ensureQueueWithDeadLetter(boss, Q, TELEGRAM_QUEUE_OPTIONS[Q]);
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.dispose();
});

beforeEach(async () => {
  await db.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name LIKE 'telegram.updates%'`);
});

const channelPost = (messageId: number, updateId: number, edit = false): TelegramJob => ({
  kind: "telegram_update",
  update: {
    update_id: updateId,
    [edit ? "edited_channel_post" : "channel_post"]: {
      message_id: messageId, date: 1_789_000_000, chat: { id: -1001234, type: "channel" }, text: edit ? "editado" : "tip",
      ...(edit ? { edit_date: 1_789_000_100 } : {}),
    },
  },
});

async function fetchAll(): Promise<Array<{ id: string; data: unknown }>> {
  return (await boss.fetch(Q, { batchSize: 10 })) ?? [];
}

describe("fila ordenada por post", () => {
  it("a edição só sai depois do post; outro post sai junto com o primeiro", async () => {
    const post = await enqueueTelegramJob(boss, channelPost(7, 100));
    const edit = await enqueueTelegramJob(boss, channelPost(7, 101, true));
    const other = await enqueueTelegramJob(boss, channelPost(8, 102));

    const first = await fetchAll();
    expect(first.map((job) => job.id).sort()).toEqual([post, other].sort());
    expect(await fetchAll()).toEqual([]);

    await boss.complete(Q, post!);
    const next = await fetchAll();
    expect(next.map((job) => job.id)).toEqual([edit]);
    expect(next[0]?.data).toMatchObject({ kind: "telegram_update", update: { update_id: 101 } });
  });

  it("a reentrega do mesmo update não vira segundo job, nem depois de concluído", async () => {
    const first = await enqueueTelegramJob(boss, channelPost(9, 200));
    expect(first).not.toBeNull();
    expect(await enqueueTelegramJob(boss, channelPost(9, 200))).toBeNull();
    const [job] = await fetchAll();
    await boss.complete(Q, job!.id);
    expect(await enqueueTelegramJob(boss, channelPost(9, 200))).toBeNull();
    // Pedido explícito roda de novo, na mesma chave.
    expect(await enqueueTelegramJob(boss, channelPost(9, 200), { id: "fresh" })).not.toBeNull();
  });

  it("job em retry segura a chave do post e só ela", async () => {
    const post = await enqueueTelegramJob(boss, channelPost(10, 300));
    await enqueueTelegramJob(boss, channelPost(10, 301, true));
    await fetchAll();
    await boss.fail(Q, post!, new Error("OCR fora"));

    const other = await enqueueTelegramJob(boss, channelPost(11, 302));
    // Vence a espera do retry sem esperar o relógio.
    await db.prisma.$executeRaw`UPDATE pgboss.job SET start_after = now() WHERE name = ${Q} AND id = ${post}::uuid`;
    // O retry do post volta primeiro; a edição continua esperando atrás dele.
    const fetched = await fetchAll();
    expect(fetched.map((job) => job.id).sort()).toEqual([post, other].sort());
  });

  it("guarda chave, grupo do chat e payload validado", async () => {
    const id = await enqueueTelegramJob(boss, {
      kind: "channel_post", chatId: "-1001234", messageId: 12, text: "tip", postDate: "2026-09-20T12:00:00.000Z",
    });
    const rows = await db.prisma.$queryRaw<Array<{ singletonKey: string; groupId: string; singletonOn: Date | null }>>`
      SELECT singleton_key AS "singletonKey", group_id AS "groupId", singleton_on AS "singletonOn"
      FROM pgboss.job WHERE name = ${Q} AND id = ${id}::uuid
    `;
    expect(rows[0]).toEqual({ singletonKey: "tg:-1001234:msg:12", groupId: "-1001234", singletonOn: null });
    await expect(enqueueTelegramJob(boss, { kind: "channel_post", chatId: "x" } as unknown as TelegramJob))
      .rejects.toThrow(/fora do contrato/);
  });
});
