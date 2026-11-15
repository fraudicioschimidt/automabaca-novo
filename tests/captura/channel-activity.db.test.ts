import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { resetEnvCacheForTests } from "@/src/infra/env";
import {
  channelActivityOf,
  purgeOldChannelActivity,
  readCaptureLatency,
  readChannelActivity,
  readChannelUpdateVolume,
  recordChannelActivity,
  runSilenceWatch,
} from "@/src/services/capture/channel/channel-activity";

let db: TestDb;
const HOUR = 3_600_000;
const CHAT = -1001234567890n;
const sent: string[] = [];
const originalEnv = { token: process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN, chat: process.env.TELEGRAM_NOTIFICATION_CHAT_ID };

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

const channelPost = (chatId: number | string, type = "channel") => ({ update_id: 1, channel_post: { message_id: 5, chat: { id: chatId, type } } });

/** Um post a cada 2 h nos últimos 14 dias, o último `lastAgoHours` atrás. */
async function seedRhythm(chatId: bigint, now: Date, lastAgoHours: number) {
  const rows = [];
  for (let ago = lastAgoHours; ago < 14 * 24; ago += 2) {
    const at = new Date(now.getTime() - ago * HOUR);
    rows.push({ chatId, hour: new Date(Math.floor(at.getTime() / HOUR) * HOUR), posts: 1, lastUpdateAt: at, lastPostAt: at });
  }
  await db.prisma.telegramChannelActivity.createMany({ data: rows });
}

describe("contagem na entrada", () => {
  it("conta só updates de canal, por tipo, somando na hora", async () => {
    expect(channelActivityOf(channelPost(-1001, "supergroup"))).toBeNull();
    expect(channelActivityOf({ update_id: 1, message: { chat: { id: 5, type: "private" } } })).toBeNull();
    expect(channelActivityOf({ update_id: 1, message_reaction_count: { chat: { id: "-1001", type: "channel" } } }))
      .toEqual({ chatId: -1001n, kind: "reaction" });

    const at = new Date("2026-09-23T14:10:00Z");
    await recordChannelActivity(channelPost(Number(CHAT)), at);
    await recordChannelActivity(channelPost(Number(CHAT)), new Date(at.getTime() + 60_000));
    await recordChannelActivity({ update_id: 2, edited_channel_post: { chat: { id: Number(CHAT), type: "channel" } } }, new Date(at.getTime() + 120_000));
    await recordChannelActivity({ update_id: 3, message: { chat: { id: 5, type: "private" } } }, at);

    expect(await db.prisma.telegramChannelActivity.findMany()).toEqual([{
      chatId: CHAT, hour: new Date("2026-09-23T14:00:00Z"), posts: 2, edits: 1, reactions: 0,
      lastUpdateAt: new Date(at.getTime() + 120_000), lastPostAt: new Date(at.getTime() + 60_000),
    }]);
  });

  it("apaga a atividade com mais de 90 dias", async () => {
    const now = new Date();
    await recordChannelActivity(channelPost(Number(CHAT)), new Date(now.getTime() - 91 * 24 * HOUR));
    await recordChannelActivity(channelPost(Number(CHAT)), new Date(now.getTime() - 89 * 24 * HOUR));
    expect(await purgeOldChannelActivity(now)).toBe(1);
    expect(await db.prisma.telegramChannelActivity.count()).toBe(1);
  });
});

describe("vigia de silêncio", () => {
  it("alerta o canal calado além do ritmo uma vez e fecha quando o post volta", async () => {
    const now = new Date();
    const bank = await db.prisma.bankroll.create({ data: { nome: "Carteira Tips", slug: "carteira", telegramChannelId: CHAT } });
    const quiet = -1009999n;
    await db.prisma.bankroll.create({ data: { nome: "Calmo", slug: "calmo", telegramChannelId: quiet } });
    await seedRhythm(CHAT, now, 9);
    await seedRhythm(quiet, now, 1);

    expect(await runSilenceWatch(now)).toEqual({ botSilent: false, mutedChannels: 1 });
    expect(await runSilenceWatch(new Date(now.getTime() + 60_000))).toEqual({ botSilent: false, mutedChannels: 1 });
    expect(sent.filter((text) => text.startsWith("🔇 Canal calado · Carteira Tips"))).toHaveLength(1);
    const alert = await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: bank.id } });
    expect(alert).toMatchObject({ status: "OPEN", resource: "bankroll" });

    const state = await readChannelActivity([CHAT], now);
    expect(state.get(String(CHAT))?.silence).toMatchObject({ state: "mudo", limitHours: 6 });

    // O histórico some (retenção) e o canal volta a "aprendendo", mas só o post fecha o alerta.
    await db.prisma.telegramChannelActivity.deleteMany({ where: { chatId: CHAT } });
    expect(await runSilenceWatch(now)).toEqual({ botSilent: false, mutedChannels: 0 });
    expect(await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ status: "OPEN" });

    const posted = new Date(Date.now() + 1_000);
    await recordChannelActivity(channelPost(Number(CHAT)), posted);
    expect(await runSilenceWatch(posted)).toEqual({ botSilent: false, mutedChannels: 0 });
    expect(await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ status: "RESOLVED" });
  });

  it("canal pausado pelo dono não é vigiado", async () => {
    const now = new Date();
    await db.prisma.bankroll.create({ data: { nome: "Pausado", slug: "pausado", telegramChannelId: CHAT, capturePausedAt: now } });
    await seedRhythm(CHAT, now, 9);
    expect(await runSilenceWatch(now)).toEqual({ botSilent: false, mutedChannels: 0 });
    expect(sent.filter((text) => text.startsWith("🔇"))).toHaveLength(0);
  });

  it("bot inteiro sem receber: um alerta só, sem os de canal", async () => {
    const now = new Date();
    await db.prisma.bankroll.create({ data: { nome: "Carteira Tips", slug: "carteira", telegramChannelId: CHAT } });
    const rows = [];
    for (let day = 1; day <= 14; day += 1) {
      const at = new Date(now.getTime() - day * 24 * HOUR - HOUR);
      rows.push({ chatId: CHAT, hour: new Date(Math.floor(at.getTime() / HOUR) * HOUR), posts: 6, lastUpdateAt: at, lastPostAt: at });
    }
    await db.prisma.telegramChannelActivity.createMany({ data: rows });

    expect(await runSilenceWatch(now)).toEqual({ botSilent: true, mutedChannels: 0 });
    expect(sent).toEqual([expect.stringContaining("🔇 Nenhum post do Telegram chegando")]);

    await recordChannelActivity(channelPost(Number(CHAT)), now);
    await runSilenceWatch(now);
    expect(await db.prisma.operationalAction.findFirstOrThrow({ where: { title: "Telegram sem entregar posts" } })).toMatchObject({ status: "RESOLVED" });
  });

  it("mede o volume de updates e a latência post → 📥 sem as capturas forçadas", async () => {
    const now = new Date();
    await recordChannelActivity(channelPost(Number(CHAT)), new Date(now.getTime() - HOUR));
    // Tabela com menos de 24 h: ainda não há média para cobrar.
    expect(await readChannelUpdateVolume(now)).toEqual({ last24h: 1, dailyAverage: null });
    await recordChannelActivity(channelPost(Number(CHAT)), new Date(now.getTime() - 4 * 24 * HOUR));
    const volume = await readChannelUpdateVolume(now);
    expect(volume.last24h).toBe(1);
    // Média sobre os ~4 dias que a tabela existe, não sobre 7.
    expect(volume.dailyAverage).toBeCloseTo(0.5, 1);

    const bank = await db.prisma.bankroll.create({ data: { nome: "Carteira Tips", slug: "carteira", telegramChannelId: CHAT } });
    const source = `telegram-channel:${CHAT}`;
    const bet = (id: string, postedMinAgo: number, forced = false) => db.prisma.bet.create({ data: {
      bankrollId: bank.id, source, sourceExternalId: id, sourcePostedAt: new Date(Date.now() - postedMinAgo * 60_000),
      data: now, esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: now,
      evento: "Time A vs Time B", mercado: "Money Line – Match", selecao: `Time ${id}`, odds: 2, stake: 1,
      captureEvidence: { create: { parser: "universal", parsedJson: forced ? { forcedByOperator: true } : {}, expiresAt: new Date(Date.now() + 86_400_000) } },
    } });
    await bet("10:1", 2);
    await bet("10:2", 2);
    await bet("11", 4);
    await bet("12", 600, true);

    const latency = await readCaptureLatency([source], new Date(now.getTime() - 24 * HOUR));
    expect(latency.get(source)).toMatchObject({ samples: 2 });
    expect(latency.get(source)?.p50Min).toBeCloseTo(3, 0);
    expect((await readCaptureLatency(null, new Date(now.getTime() - 24 * HOUR))).get("*")).toMatchObject({ samples: 2 });
  });
});
