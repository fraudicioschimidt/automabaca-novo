import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CASAMENTO_ALVO_PCT,
  coletarHealthDigest,
  formatarHealthDigest,
  sendHealthDigest,
} from "@/src/services/ops/digests/health-digest";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { createTestDb, type TestDb } from "../helpers/db";
import { recordChannelActivity } from "@/src/services/capture/channel/channel-activity";

/**
 * Digest diário de saúde da captura. Existe porque há falhas silenciosas — o
 * sistema degrada sem cair, e só aparecem para quem vai ler o log. Este teste
 * guarda a aritmética que decide "dia bom ou ruim".
 */

let db: TestDb;

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => {
  await db.reset();
  // `db.reset()` limpa as tabelas de negócio, não o schema pgboss. O digest lê
  // a dead-letter para decidir "dia bom ou ruim", então job deixado por outro
  // arquivo de teste no mesmo banco viraria falha aqui — e o alvo deste teste é
  // a aritmética da captura, não o estado das filas.
  await db.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name LIKE '%.dlq'`);
  // O Telegram entregou: sem isto todo dia seria "nenhum post chegou".
  await recordChannelActivity(CANAL_POST, new Date(Date.now() - 3_600_000));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetEnvCacheForTests(); });

const CANAL_POST = { update_id: 1, channel_post: { message_id: 1, chat: { id: -1001234567890, type: "channel" } } };

async function apostaCom(identityStatus: "MATCHED" | "MANUAL" | "UNMATCHED" | "PENDING", ordem: number) {
  const banca = await db.prisma.bankroll.upsert({
    where: { slug: "digest" },
    create: { nome: "Digest", slug: "digest" },
    update: {},
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      bankrollId: banca.id,
      data: new Date(Date.now() + 3_600_000),
      evento: `Time ${ordem} vs Rival`,
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Casa",
      odds: 2,
      stake: 1,
    },
  });
  await db.prisma.betSharp.create({ data: { betId: bet.id, identityStatus } });
  return bet;
}

describe("digest diário de saúde", () => {
  it("a retentativa no mesmo dia não duplica o resumo com números novos; o dia seguinte entrega", async () => {
    vi.stubEnv("TELEGRAM_NOTIFICATION_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_NOTIFICATION_CHAT_ID", "123");
    resetEnvCacheForTests();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date("2026-09-24T15:00:00Z");
    await sendHealthDigest(now);
    const bet = await apostaCom("MATCHED", 1);
    await db.prisma.bet.update({ where: { id: bet.id }, data: { registradoEm: now } });
    await sendHealthDigest(new Date(now.getTime() + 300_000));
    expect(fetchMock).toHaveBeenCalledOnce();
    await sendHealthDigest(new Date(now.getTime() + 86_400_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("o resumo de muitos canais calados cabe em uma mensagem", async () => {
    const digest = await coletarHealthDigest();
    const text = formatarHealthDigest({ ...digest, canaisMudos: Array.from({ length: 40 }, (_, index) => `Canal ${index} ${"x".repeat(110)}`) });
    expect(Array.from(text).length).toBeLessThanOrEqual(3900);
    expect(text).toContain("resumo truncado; veja Monitoramento.");
  });

  it("conta cada aposta liquidada uma vez, sem reabertura nem correção", async () => {
    const [a, b] = [(await apostaCom("MATCHED", 1)).id, (await apostaCom("MATCHED", 2)).id];
    const evento = (betId: string, from: string, to: string, n: number) => db.prisma.settlementEvent.create({
      data: { betId, type: "STATUS_CHANGED", payload: { from, to, source: "flashscore" }, payloadHash: `${betId}-${n}` },
    });
    await evento(a, "PENDING", "WON", 1);
    await evento(a, "WON", "PENDING", 2);
    await evento(a, "PENDING", "LOST", 3);
    await evento(a, "LOST", "WON", 4);
    await evento(b, "PENDING", "VOID", 5);

    expect((await coletarHealthDigest()).liquidadas).toBe(2);
  });

  it("aposta em processamento fica FORA do denominador", async () => {
    // Ela ainda pode casar. Contá-la como falha faria a taxa piscar sem motivo
    // e geraria alarme falso todo dia de pico de captura.
    await apostaCom("MATCHED", 1);
    await apostaCom("MATCHED", 2);
    await apostaCom("PENDING", 3);

    const d = await coletarHealthDigest();
    expect(d.pctCasamento).toBe(100);
    expect(d.emProcessamento).toBe(1);
    expect(d.saudavel).toBe(true);
  });

  it("identidade manual conta como casamento resolvido nas janelas", async () => {
    await apostaCom("MANUAL", 1);
    await apostaCom("UNMATCHED", 2);

    const d = await coletarHealthDigest();
    expect(d.casadas).toBe(1);
    expect(d.pctCasamento).toBe(50);
    expect(d.pctCasamento7d).toBe(50);
  });

  it("marca o dia como ruim quando o casamento cai abaixo do alvo", async () => {
    // 2 de 3 = 67%, abaixo dos 80%: o sintoma de captura degradada que ninguém
    // vê sem ler log.
    await apostaCom("MATCHED", 1);
    await apostaCom("MATCHED", 2);
    await apostaCom("UNMATCHED", 3);

    const d = await coletarHealthDigest();
    expect(d.pctCasamento).toBeCloseTo(66.7, 0);
    expect(d.saudavel).toBe(false);
    expect(formatarHealthDigest(d)).toContain("precisa de atenção");
  });

  it("dia sem captura nova não vira alarme", async () => {
    const d = await coletarHealthDigest();
    expect(d.capturadas).toBe(0);
    expect(d.saudavel).toBe(true);
    expect(formatarHealthDigest(d)).toContain("sem apostas novas");
  });

  it("janela diária vazia não esconde deriva medida na semana", async () => {
    const now = new Date();
    const antiga = await apostaCom("UNMATCHED", 1);
    await db.prisma.bet.update({
      where: { id: antiga.id },
      data: { registradoEm: new Date(now.getTime() - 48 * 3_600_000) },
    });

    const d = await coletarHealthDigest(now);
    expect(d.capturadas).toBe(0);
    expect(d.pctCasamento).toBe(100);
    expect(d.pctCasamento7d).toBe(0);
    expect(d.saudavel).toBe(false);
    expect(formatarHealthDigest(d, now)).toContain("Captura precisa de atenção");
  });

  it("não declara captura saudável com ação operacional acionável", async () => {
    await db.prisma.operationalAction.create({
      data: {
        fingerprint: "health-digest:acao-aberta",
        area: "matching",
        actionType: "training.resolve",
        title: "Resolver identidade",
        description: "Há uma captura aguardando decisão humana.",
        status: "OPEN",
      },
    });

    const d = await coletarHealthDigest();
    expect(d.acoesAbertas).toBe(1);
    expect(d.saudavel).toBe(false);
    const texto = formatarHealthDigest(d);
    expect(texto).toContain("Captura precisa de atenção");
    expect(texto).not.toContain("Captura saudável");
    expect(texto).toContain("esperando você em Monitoramento");
    expect(texto).not.toContain("esperando você em Operações");
  });

  it("não declara saúde enquanto uma ação está em execução", async () => {
    await db.prisma.operationalAction.create({
      data: {
        fingerprint: "telegram.webhook:acao-running",
        area: "incidentes",
        actionType: "incident.review",
        title: "Recuperação em andamento",
        description: "A condição continua ativa até o executor encerrá-la.",
        status: "RUNNING",
      },
    });

    const d = await coletarHealthDigest();
    expect(d.acoesAbertas).toBe(1);
    expect(d.saudavel).toBe(false);
  });

  it("ação de fora da captura não tira o ✅ da captura", async () => {
    // SLO, liquidação e dead-letter de cron têm os próprios avisos.
    await db.prisma.operationalAction.createMany({ data: [
      { fingerprint: "slo:x", area: "incidentes", actionType: "incident.review", title: "SLO", description: "x", status: "OPEN" },
      { fingerprint: "settlement.parado:x", area: "settlement", actionType: "bet.settle", title: "Liquidar", description: "x", status: "OPEN" },
      { fingerprint: "dlq:x", area: "filas", actionType: "dlq.replay", title: "Revisar falha em closing.sync", description: "x",
        status: "OPEN", evidence: { fila: "closing.sync" } },
    ] });
    expect((await coletarHealthDigest()).acoesAbertas).toBe(0);

    await db.prisma.operationalAction.create({ data: {
      fingerprint: "dlq:y", area: "filas", actionType: "dlq.replay", title: "Post não processado", description: "x",
      status: "OPEN", evidence: { fila: "telegram.updates" },
    } });
    expect((await coletarHealthDigest()).acoesAbertas).toBe(1);
  });

  it("tabela nova (menos de 24 h) não acusa dia sem post", async () => {
    await db.prisma.telegramChannelActivity.deleteMany();
    const d = await coletarHealthDigest();
    expect(d).toMatchObject({ updates24h: 0, updatesCobrados: false, saudavel: true });
    expect(formatarHealthDigest(d)).not.toContain("Nenhum post chegou");
  });

  it("não diz que a captura está saudável quando nenhum update chegou do Telegram", async () => {
    await db.prisma.telegramChannelActivity.deleteMany();
    const antes = new Date(Date.now() - 3 * 24 * 3_600_000);
    for (let i = 0; i < 6; i += 1) await recordChannelActivity(CANAL_POST, antes);
    const d = await coletarHealthDigest();
    expect(d.updatesCobrados).toBe(true);
    expect(d.updates24h).toBe(0);
    expect(d.saudavel).toBe(false);
    const texto = formatarHealthDigest(d);
    expect(texto.split("\n")[0]).toContain("⚠️ Nenhum post chegou do Telegram em 24 h");
    expect(texto).not.toContain("✅");
  });

  it("conta os updates, mede o post → captura e cobra o alvo de 10 min", async () => {
    await recordChannelActivity(CANAL_POST, new Date(Date.now() - 2 * 3_600_000));
    const rapida = await apostaCom("MATCHED", 1);
    const lenta = await apostaCom("MATCHED", 2);
    await db.prisma.bet.update({ where: { id: rapida.id }, data: { source: "telegram-channel:-1001234567890", sourceExternalId: "1", sourcePostedAt: new Date(Date.now() - 2 * 60_000) } });
    await db.prisma.bet.update({ where: { id: lenta.id }, data: { source: "telegram-channel:-1001234567890", sourceExternalId: "2", sourcePostedAt: new Date(Date.now() - 40 * 60_000) } });

    const d = await coletarHealthDigest();
    expect(d.updates24h).toBe(2);
    expect(d.latenciaP95Min).toBeGreaterThan(10);
    expect(d.saudavel).toBe(false);
    const texto = formatarHealthDigest(d);
    expect(texto).toContain("📡 2 update(s) dos canais em 24 h");
    expect(texto).toContain("⏱️ Do post à captura:");
    expect(texto).toContain("(alvo 10 min)");
  });

  it("canal calado além do ritmo aparece e tira o ✅", async () => {
    await db.prisma.bankroll.create({ data: { nome: "Canal calado", slug: "calado", telegramChannelId: -1009n } });
    const rows = [];
    for (let ago = 9; ago < 14 * 24; ago += 2) {
      const at = new Date(Date.now() - ago * 3_600_000);
      rows.push({ chatId: -1009n, hour: new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000), posts: 1, lastUpdateAt: at, lastPostAt: at });
    }
    await db.prisma.telegramChannelActivity.createMany({ data: rows });

    const d = await coletarHealthDigest();
    expect(d.canaisMudos).toEqual(["Canal calado"]);
    expect(d.saudavel).toBe(false);
    expect(formatarHealthDigest(d)).toContain("🔇 Canal(is) calado(s) além do ritmo: Canal calado");
  });

  it("o alvo é o combinado e aparece na mensagem", async () => {
    await apostaCom("MATCHED", 1);
    const texto = formatarHealthDigest(await coletarHealthDigest());
    expect(CASAMENTO_ALVO_PCT).toBe(80);
    expect(texto).toContain("alvo 80%");
  });
});
