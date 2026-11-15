import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { sendWeeklyChannelDigest } from "@/src/services/ops/digests/weekly-channel-digest";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * O boletim de segunda lido do banco: a semana sai da régua de Bancas de agora
 * menos a de 7 dias atrás, e a troca de veredito é a do mesmo agregado.
 */

let db: TestDb;
const originalToken = process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
const originalChatId = process.env.TELEGRAM_NOTIFICATION_CHAT_ID;

beforeAll(() => {
  process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_NOTIFICATION_CHAT_ID = "123";
  resetEnvCacheForTests();
  db = createTestDb();
});

afterAll(async () => {
  if (originalToken === undefined) delete process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
  else process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = originalToken;
  if (originalChatId === undefined) delete process.env.TELEGRAM_NOTIFICATION_CHAT_ID;
  else process.env.TELEGRAM_NOTIFICATION_CHAT_ID = originalChatId;
  resetEnvCacheForTests();
  await db.dispose();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.reset();
  vi.unstubAllGlobals();
});

/** Segunda, 21/09/2026, 09:00 em São Paulo. */
const NOW = new Date("2026-09-21T12:00:00Z");
const MIN = 60_000;
const daysAgo = (days: number, minutes = 0) => new Date(NOW.getTime() - (days * 1440 + minutes) * MIN);

function seedBankroll(nome: string, telegramChannelId: bigint | null) {
  return db.prisma.bankroll.create({
    data: { nome, slug: nome.toLowerCase().replaceAll(" ", "-"), valorUnidade: 50, capitalInicial: 100, telegramChannelId },
  });
}

/** Aposta liquidada no dia do jogo, com o fechamento escrito no kickoff; sem `clv`, sem fechamento. */
function seedBet(bankrollId: string, over: { registradoEm: Date; data: Date; clv?: number; won?: boolean }) {
  const settled = over.clv !== undefined;
  return db.prisma.bet.create({
    data: {
      bankrollId,
      data: over.data,
      registradoEm: over.registradoEm,
      evento: "Casa vs Fora",
      esporte: "Soccer",
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: over.registradoEm,
      mercado: "Total de gols",
      selecao: "Mais de 2.5",
      odds: 1.9,
      stake: 1,
      status: settled ? (over.won ? "WON" : "LOST") : "PENDING",
      lucro: settled ? (over.won ? 0.9 : -1) : 0,
      settledAt: settled ? over.data : null,
      ...(settled ? { closing: { create: { clv: over.clv, clvReliable: true, fetchedAt: over.data, updatedAt: over.data } } } : {}),
    },
  });
}

/** O Telegram de mentira: devolve os textos enviados até agora. */
function stubTelegram(): () => string[] {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return () => fetchMock.mock.calls.map((call) => {
    const [, init] = call as unknown as [string, RequestInit];
    return (JSON.parse(String(init.body)) as { text: string }).text;
  });
}

async function sendDigest(): Promise<{ result: Awaited<ReturnType<typeof sendWeeklyChannelDigest>>; texts: string[] }> {
  const sentTexts = stubTelegram();
  const result = await sendWeeklyChannelDigest(NOW);
  return { result, texts: sentTexts() };
}

describe("boletim semanal dos canais (Postgres real)", () => {
  it("a semana é a régua de agora menos a de 7 dias atrás, e o canal que perdeu o edge aparece em destaque", async () => {
    const decaindo = await seedBankroll("Canal Decaindo", -1001n);
    // 40 fechamentos há 40 dias, CLV médio +5: Manter há uma semana.
    for (let i = 0; i < 40; i++) {
      await seedBet(decaindo.id, { registradoEm: daysAgo(41, i), data: daysAgo(40, i), clv: i % 2 ? 4 : 6, won: i % 2 === 0 });
    }
    // Na semana, 25 fechamentos a −10 e uma aposta ainda sem jogo.
    for (let i = 0; i < 25; i++) {
      await seedBet(decaindo.id, { registradoEm: daysAgo(4, i), data: daysAgo(3, i), clv: -10 });
    }
    await seedBet(decaindo.id, { registradoEm: daysAgo(1), data: daysAgo(-1) });
    // Canal sem movimento na semana e banca sem canal apostando: fora do boletim.
    const parado = await seedBankroll("Canal Parado", -1002n);
    await seedBet(parado.id, { registradoEm: daysAgo(21), data: daysAgo(20), clv: 3, won: true });
    const manual = await seedBankroll("Banca Manual", null);
    await seedBet(manual.id, { registradoEm: daysAgo(2), data: daysAgo(-2) });

    const { result, texts } = await sendDigest();

    expect(result).toEqual({ sent: true, channels: 1, verdictChanges: 1 });
    expect(texts).toHaveLength(1);
    const [text] = texts;
    expect(text).toContain("📊 Boletim semanal dos canais · 7 dias até 21/09 09:00");
    // Δ 30d: −10 nos últimos 30 dias contra +5 nos 30 anteriores.
    expect(text).toContain("⬇️ Canal Decaindo: Manter → Monitorar · Δ 30d -15.0 p.p. (n 25/40)");
    // (40 × 5 − 25 × 10) / 65 = −0.77; 40 dos 65 bateram o fechamento.
    expect(text).toContain("1. Canal Decaindo · Monitorar\n• CLV -0.8% (n 65) · beat-close 62% ·");
    expect(text).toContain("• Na semana: 26 apostas · CLV -10.0% (n 25)");
    expect(text).not.toContain("Canal Parado");
    expect(text).not.toContain("Banca Manual");
  });

  it("semana sem aposta de canal não manda nada", async () => {
    const parado = await seedBankroll("Canal Parado", -1002n);
    await seedBet(parado.id, { registradoEm: daysAgo(21), data: daysAgo(20), clv: 3, won: true });

    const { result, texts } = await sendDigest();

    expect(result).toEqual({ sent: false, channels: 0, verdictChanges: 0 });
    expect(texts).toEqual([]);
  });

  it("a retentativa do mesmo disparo não manda um segundo boletim, mesmo com número novo; o disparo seguinte manda o dele", async () => {
    const canal = await seedBankroll("Canal Ativo", -1001n);
    await seedBet(canal.id, { registradoEm: daysAgo(3), data: daysAgo(2), clv: 3, won: true });
    const sentTexts = stubTelegram();

    // O job atrasado 5 min fala do disparo das 09:00, não da hora em que rodou.
    expect(await sendWeeklyChannelDigest(new Date(NOW.getTime() + 5 * MIN))).toEqual({ sent: true, channels: 1, verdictChanges: 0 });
    // Aposta nova entre as execuções: a retentativa (5 min) e a da dead-letter
    // (2 h) já teriam outro texto.
    await seedBet(canal.id, { registradoEm: new Date(NOW.getTime() + 20 * MIN), data: new Date(NOW.getTime() + 60 * MIN) });
    await sendWeeklyChannelDigest(new Date(NOW.getTime() + 10 * MIN));
    await sendWeeklyChannelDigest(new Date(NOW.getTime() + 2 * 60 * MIN));

    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain("📊 Boletim semanal dos canais · 7 dias até 21/09 09:00");

    await sendWeeklyChannelDigest(new Date(NOW.getTime() + 7 * 1440 * MIN));
    expect(sentTexts()).toHaveLength(2);
    expect(sentTexts()[1]).toContain("📊 Boletim semanal dos canais · 7 dias até 28/09 09:00");
  });

  it("worker com o relógio um pouco atrás do banco ainda fala do disparo de hoje", async () => {
    const canal = await seedBankroll("Canal Ativo", -1001n);
    await seedBet(canal.id, { registradoEm: daysAgo(3), data: daysAgo(2), clv: 3, won: true });
    const sentTexts = stubTelegram();

    await sendWeeklyChannelDigest(new Date(NOW.getTime() - 30_000));

    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain("7 dias até 21/09 09:00");
  });
});

describe("corte do disparo", () => {
  it("execução atrasada não inclui aposta ou fechamento posteriores ao horário anunciado", async () => {
    const canal = await seedBankroll("Canal Atrasado", -1001n);
    await seedBet(canal.id, { registradoEm: daysAgo(3), data: daysAgo(2), clv: 3, won: true });
    await seedBet(canal.id, { registradoEm: new Date(NOW.getTime() + MIN), data: new Date(NOW.getTime() + 2 * MIN), clv: 90 });
    const sent = stubTelegram();
    await sendWeeklyChannelDigest(new Date(NOW.getTime() + 60 * MIN));
    expect(sent()[0]).toContain("• Na semana: 1 aposta · CLV +3.0% (n 1)");
    expect(sent()[0]).not.toContain("n 2");
  });
});
