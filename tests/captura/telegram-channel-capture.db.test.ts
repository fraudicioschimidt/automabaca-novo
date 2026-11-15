import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTeamCard } from "../helpers/team-cards";
import { CHANNEL_ID, POST_DATE, POST_TEXT, editedPost, post, seedChannelBankroll } from "../helpers/telegram-channel";

/**
 * Captura de posts de canal (texto e foto) ponta a ponta contra Postgres real.
 * A cascata LLM fica mockada: posts incompletos caem em unparseable sem bater
 * na API.
 */
const geminiMocks = vi.hoisted(() => ({
  extractBetFromText: vi.fn(),
  extractBetFromImage: vi.fn(),
}));
vi.mock(import("@/src/services/capture/reading/extract-bet"), () => geminiMocks);
/** Releituras do guard: sem resposta por padrão, como a cascata sem chave. */
const rereadMock = vi.hoisted(() => ({ llmGenerateJson: vi.fn() }));
vi.mock("@/src/infra/llm/cascade", () => rereadMock);
const alertMocks = vi.hoisted(() => ({ sendOperationalAlert: vi.fn(), sendOperatorNotification: vi.fn() }));
/** A pergunta na DM tem teste próprio (`capture-fix.db.test`): aqui só se vê que a recusa a faz. */
const fixMocks = vi.hoisted(() => ({ offerCaptureFix: vi.fn(async () => "perguntado" as const) }));
vi.mock(import("@/src/services/capture/capture-fix"), async (original) => ({
  ...await original(),
  offerCaptureFix: fixMocks.offerCaptureFix,
}));
/** O job de foto baixa a imagem pela Bot API; aqui ela é sintética e leva o id do arquivo. */
vi.mock(import("@/src/telegram/photo-download"), async (original) => ({
  ...await original(),
  downloadTelegramPhoto: async (_api, _token, fileId) => ({ base64: `img-${fileId}`, mimeType: "image/jpeg" }),
}));
vi.mock("@/src/services/ops/alerts", async (original) => ({
  ...await original<typeof import("@/src/services/ops/alerts")>(),
  ...alertMocks,
}));
/**
 * Fila sintética com as regras que a captura usa do pg-boss: o id repetido não
 * entra de novo, e `findJobs` acha o pedido ainda na fila pela chave do post.
 */
const queue = vi.hoisted(() => ({ jobs: [] as Array<{ id: string; name: string; data: unknown; singletonKey?: string }> }));
const syntheticBoss = vi.hoisted(() => ({
  send: async (name: string, data: unknown, options?: { id?: string; singletonKey?: string }) => {
    const id = options?.id ?? `job-${queue.jobs.length + 1}`;
    if (queue.jobs.some((job) => job.name === name && job.id === id)) return null;
    queue.jobs.push({ id, name, data, singletonKey: options?.singletonKey });
    return id;
  },
  findJobs: async (name: string, options: { key?: string; data?: Record<string, unknown> }) =>
    queue.jobs.filter((job) => job.name === name && job.singletonKey === options.key
      && Object.entries(options.data ?? {}).every(([field, value]) => (job.data as Record<string, unknown>)[field] === value)),
}));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => syntheticBoss }));
vi.mock("@/src/services/scheduling/enqueue-after-capture", async (original) => ({
  ...await original<typeof import("@/src/services/scheduling/enqueue-after-capture")>(),
  ensureCaptureFollowups: async () => 0,
}));
import { handleChannelPost, handleChannelPhotoPost } from "@/src/services/capture/channel/capture-new";
import { handleChannelReaction } from "../helpers/telegram-reaction";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { handleEditedChannelPost } from "@/src/services/capture/channel/capture-edit";
import { TelegramParseRetryError } from "@/src/services/capture/reading/retry-error";
import { z } from "zod";
import { captureParsedSchema } from "@/src/domain/bet-capture";
import { toNumber } from "@/src/domain/money";
import { MATCH_WINNER_POST } from "../fixtures/match-winner-post";
import { listDiscardedChannelPosts, requestDiscardedPostCapture } from "@/src/services/capture/channel/channel-post-archive";
import { readCaptureLatency } from "@/src/services/capture/channel/channel-activity";
import { registerCaptureBatch } from "@/src/services/capture/channel/register-post";
import { parseTelegramJob, type TelegramJob } from "@/src/domain/telegram-job";
import { processTelegramJob, type NormalizedTelegramJob } from "@/src/telegram/processing";
import { processTelegramDeferredJob } from "@/src/telegram/deferred";
import { avisarConflitoDeEsporte } from "@/src/services/bets/sport-resolution/notify";
import { MEDIA_ALBUM_FLUSH_MAX_DEFERRALS, stageMediaAlbumPhoto } from "@/src/services/capture/channel/media-album";
import type { Api } from "grammy";
import type { PgBoss } from "pg-boss";

/** Roda o job como o consumidor de `telegram.updates` roda. */
function runQueuedJob(data: unknown) {
  const job: TelegramJob = parseTelegramJob("telegram.updates", data);
  return processTelegramJob({ api: {} as Api, boss: syntheticBoss as unknown as PgBoss, token: "token" }, job as NormalizedTelegramJob);
}

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
  queue.jobs = [];
  photoDeps.loadImage.mockClear();
  alertMocks.sendOperationalAlert.mockReset();
  alertMocks.sendOperatorNotification.mockReset();
  fixMocks.offerCaptureFix.mockClear();
  rereadMock.llmGenerateJson.mockReset().mockResolvedValue(null);
  geminiMocks.extractBetFromText.mockReset();
  geminiMocks.extractBetFromImage.mockReset();
  geminiMocks.extractBetFromText.mockResolvedValue({
    bet: null,
    provider: "gemini",
    notBet: true,
  });
  geminiMocks.extractBetFromImage.mockResolvedValue({
    bet: null,
    provider: "gemini",
    notBet: true,
  });
});

describe("handleChannelPost", () => {
  it.each([true, false])("registra Match Winner com cotação na seleção, cabeçalho do grupo: %s", async (withHeader) => {
    await seedChannelBankroll(db);
    const text = withHeader ? MATCH_WINNER_POST : MATCH_WINNER_POST.replace("TPC Tips - FREE\n\n", "");
    const input = { chatId: CHANNEL_ID, messageId: 5, text, postDate: new Date("2026-09-09T02:57:00Z") };
    const outcome = await handleChannelPost(input);
    expect(outcome.kind).toBe("registered");
    if (outcome.kind !== "registered") return;
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: outcome.betId } });
    expect(bet).toMatchObject({ evento: "Chen-Yu Lu vs Natsuki Yamamoto", mercado: "Match Winner", selecao: "Natsuki Yamamoto", esporte: "Tennis", legsJson: null });
    expect(Number(bet.odds)).toBe(2);
    expect(Number(bet.stake)).toBe(2);
    expect(bet.data.toISOString()).toBe("2026-09-09T05:00:00.000Z");
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();
    expect((await handleChannelPost(input)).kind).toBe("duplicate");
    expect(await db.prisma.bet.count()).toBe(1);
  });
  it("usa stake padrão sem alterar entradas antigas e congela a regra para edits", async () => {
    const bank = await seedChannelBankroll(db);
    await db.prisma.bankroll.update({ where: { id: bank.id }, data: { stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1 } });
    const withoutStake = POST_TEXT.replace("Stake: 1u", "");
    const outcome = await handleChannelPost(post(withoutStake, 701));
    expect(outcome.kind).toBe("registered");
    const captured = await db.prisma.bet.findFirstOrThrow({ where: { sourceExternalId: "701" }, include: { captureEvidence: true } });
    expect(Number(captured.stake)).toBe(1);
    expect(captured.captureEvidence?.parsedJson).toMatchObject({ stakePolicySnapshot: { stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1, source: "bankroll_default" } });
    await db.prisma.bankroll.update({ where: { id: bank.id }, data: { stakePolicy: "ALWAYS", defaultStakeUnits: 3 } });
    await handleEditedChannelPost(post(withoutStake.replace("2.10", "2.20"), 701));
    expect(Number((await db.prisma.bet.findUniqueOrThrow({ where: { id: captured.id } })).stake)).toBe(1);
    await handleChannelPost(post(POST_TEXT.replace("Entrada: Casa", "Entrada: Fora"), 702));
    expect(Number((await db.prisma.bet.findFirstOrThrow({ where: { sourceExternalId: "702" } })).stake)).toBe(3);
  });
  it("banca WHEN_MISSING: stake em 'units' só na legenda da foto vale a da legenda, sem o registro recusar a política", async () => {
    const bank = await seedChannelBankroll(db);
    await db.prisma.bankroll.update({ where: { id: bank.id }, data: { stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1 } });
    // O print não tinha stake: a leitura sai com a padrão da banca, e a legenda a corrige no guard.
    const stakePolicySnapshot = { version: 1, stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1, originalStake: 0, source: "bankroll_default" };
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: { ...bttsBet(1), stakePolicySnapshot }, provider: "gemini" });
    const outcome = await handleChannelPhotoPost({ chatId: CHANNEL_ID, messageId: 703, caption: "2 units", postDate: POST_DATE, mediaFileId: "foto-teste" }, photoDeps);
    expect(outcome.kind).toBe("registered");
    const captured = await db.prisma.bet.findFirstOrThrow({ where: { sourceExternalId: "703" }, include: { captureEvidence: true } });
    expect(Number(captured.stake)).toBe(2);
    expect(captured.captureEvidence?.parsedJson).toMatchObject({ stakePolicySnapshot: { stakePolicy: "WHEN_MISSING", originalStake: 2, source: "message" } });
  });
  it("captura post de canal: bankroll pelo channelId, normalização, casa default", async () => {
    await seedChannelBankroll(db);
    const outcome = await handleChannelPost(post(POST_TEXT));

    expect(outcome.kind).toBe("registered");
    if (outcome.kind !== "registered") return;

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: outcome.betId } });
    expect(bet.evento).toBe("Coquimbo Unido vs Colo Colo");
    expect(bet.mercado).toBe("Money Line – Match");
    expect(bet.selecao).toBe("Coquimbo Unido"); // Casa → time real
    expect(bet.casaDeAposta).toBe("Betano"); // default do bankroll
    expect(bet.tipster).toBe("Carteira Tips");
    expect(bet.source).toBe(`telegram-channel:${CHANNEL_ID}`);
    expect(bet.sourceExternalId).toBe("555");
    expect(bet.data.toISOString()).toBe("2026-06-15T19:00:00.000Z"); // SP→UTC
  });

  it("captura AH live com placar estruturado sem contaminar a linha", async () => {
    await seedChannelBankroll(db);
    const livePost = [
      "⚽ Flamengo vs Palmeiras",
      "Data: 15/06 16:00",
      "Mercado: Asian Handicap",
      "Entrada: (1-0) Fora +0.25",
      "ODD: 1.90",
      "Stake: 1u",
    ].join("\n");
    const outcome = await handleChannelPost(post(livePost, 557));
    expect(outcome.kind).toBe("registered");
    if (outcome.kind !== "registered") return;

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: outcome.betId } });
    expect(bet).toMatchObject({
      selecao: "Palmeiras +0.25",
      liveScoreHome: 1,
      liveScoreAway: 0,
    });
  });

  it("canal sem bankroll e ruído são pulados com motivo", async () => {
    expect((await handleChannelPost(post(POST_TEXT))).kind).toBe("skipped");
    await seedChannelBankroll(db);
    const noise = await handleChannelPost(post("Bom dia família! 🌞", 556));
    expect(noise).toEqual({ kind: "skipped", reason: "nao_parece_aposta" });
  });

  it("re-entrega do mesmo post é duplicata, não nova aposta", async () => {
    await seedChannelBankroll(db);
    const first = await handleChannelPost(post(POST_TEXT));
    const second = await handleChannelPost(post(POST_TEXT));
    expect(second.kind).toBe("duplicate");
    if (first.kind === "registered" && second.kind === "duplicate") {
      expect(second.betId).toBe(first.betId);
    }
  });
});

describe("telemetria de parse por canal (qualidade do parser)", () => {
  // Passa no noise-filter (emoji + confronto + rótulo) mas não tem odd/stake
  // e o Gemini está indisponível nos testes → unparseable determinístico.
  const POST_SEM_ODDS = "⚽ Coquimbo Unido vs Colo Colo\nEntrada: Casa";

  it("registered/duplicate/unparseable viram AuditEvent; ruído não", async () => {
    await seedChannelBankroll(db);
    await handleChannelPost(post(POST_TEXT, 555)); // registered
    await handleChannelPost(post(POST_TEXT, 555)); // duplicate
    await handleChannelPost(post(POST_SEM_ODDS, 600)); // unparseable
    await handleChannelPost(post("Bom dia família! 🌞", 601)); // ruído: fora

    const eventos = await db.prisma.auditEvent.findMany({
      where: { action: "telegram.parse" },
      orderBy: { createdAt: "asc" },
    });
    expect(eventos.map((e) => e.outcome)).toEqual(["registered", "duplicate", "unparseable"]);
    expect(eventos[0]?.resource).toBe(String(CHANNEL_ID));
    expect(eventos[0]?.resourceId).toBe("555");
    expect((eventos[0]?.details as { via?: string }).via).toBe("universal");
    const faltas = (eventos[2]?.details as { missing?: string[] }).missing ?? [];
    expect(faltas).toContain("odds");
  });

  it("getOperacoesData agrega a taxa de parse e os campos faltantes do canal", async () => {
    const bankroll = await seedChannelBankroll(db);
    await handleChannelPost(post(POST_TEXT, 555));
    await expect(handleChannelPost(post(POST_SEM_ODDS, 600)))
      .resolves.toEqual({ kind: "unparseable", missing: expect.arrayContaining(["odds", "stake"]) });
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();

    const captured = await db.prisma.bet.findFirstOrThrow({
      where: { source: `telegram-channel:${CHANNEL_ID}` },
    });
    await db.prisma.betSharp.create({
      data: {
        betId: captured.id,
        identityStatus: "MATCHED",
        confidence: 96,
        provider: "pinnacle17",
        identityResolvedAt: new Date(captured.registradoEm.getTime() + 5 * 60_000),
      },
    });
    const transient = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: new Date(Date.now() + 2 * 3_600_000),
        evento: "Time A vs Time B",
        esporte: "Soccer",
        mercado: "Total",
        selecao: "Over 2.5",
        odds: 1.95,
        stake: 1,
        source: `telegram-channel:${CHANNEL_ID}`,
        sourceExternalId: "transient-1",
        registradoEm: new Date(Date.now() - 10 * 60_000),
      },
    });
    await db.prisma.betSharp.create({
      data: {
        betId: transient.id,
        identityStatus: "MATCHED",
        confidence: 92,
        noOddsReason: "sem_linha_atual",
        identityResolvedAt: new Date(Date.now() - 3 * 60_000),
      },
    });

    // Resolver PELA Pinnacle17 consome cota dela — a chamada não acontece sem
    // isso. O painel usa esse consumo para saber quem ainda está na frota, e
    // sem a linha o provider (corretamente) não aparece na tela.
    const { consumeProviderBudget } = await import("@/src/providers/budget");
    await consumeProviderBudget("pinnacle17", 1);

    const { getCanaisMonitorados } = await import("@/src/services/painel/operacoes/channels");
    const { getProviderBudgets } = await import("@/src/services/painel/operacoes/budgets");
    const { canais } = await getCanaisMonitorados();
    const canal = canais.find((c) => c.channelId === String(CHANNEL_ID));
    expect(canal).toBeDefined();
    expect(canal?.parse.ok).toBe(1);
    expect(canal?.parse.falhas).toBe(1);
    expect(canal?.parse.taxaOk).toBeCloseTo(50);
    // O motivo é mais fino que "campo ausente" (o campo seria sempre `odds`)
    // e sai do MESMO vocabulário que o funil usa.
    expect(canal?.parse.perdas.map((perda) => perda.motivo)).toContain("rascunho_sem_stake");
    expect(canal?.identity).toMatchObject({ resolved: 2, pending: 0, failed: 0, taxaOk: 100 });
    // Não há preço de entrada a medir por canal; sobram só os motivos de
    // ausência.
    expect(canal?.odds.faltas).toContainEqual({ reason: "sem_linha_atual", n: 1 });
    expect(canal?.resolution.samples).toBe(2);
    expect(canal?.resolution.p50Min).toBeGreaterThan(0);
    // Identidade casada sem linha não é falha transitória: não há preço de
    // entrada a buscar (a conta vive em `ops-reprocess.db.test.ts`).
    expect(canal?.preKickoffFailures).toBe(0);
    expect(canal?.transientFailures).toBe(0);
    expect((await getProviderBudgets()).find((b) => b.name === "pinnacle17")?.rendimento).toEqual({ identidade: 1 });
  });

  it("rascunho só sem stake não chama LLM nem retry; o edit registra", async () => {
    await seedChannelBankroll(db);
    const rascunho = [
      "⚽ Coquimbo Unido vs Colo Colo",
      "Data: 15/06 16:00",
      "Mercado: Resultado Final",
      "Entrada: Casa",
      "ODD: 2.10",
      "Stake:",
    ].join("\n");

    const first = await handleChannelPost(post(rascunho, 610));
    expect(first).toEqual({ kind: "unparseable", missing: ["stake"] });
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();
    // Se a edição não vier, o post não some: fica com os descartados do painel.
    expect((await listDiscardedChannelPosts([String(CHANNEL_ID)], new Date(0), 5)).get(String(CHANNEL_ID))?.recent)
      .toMatchObject([{ messageId: 610, reason: "rascunho_incompleto" }]);

    const complete = await handleEditedChannelPost(editedPost(POST_TEXT, new Date(POST_DATE.getTime() + 60_000), 610));
    expect(complete.kind).toBe("registered");
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();

    const evento = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "telegram.parse", resourceId: "610", outcome: "unparseable" },
    });
    expect(evento.details).toMatchObject({
      reason: "rascunho_sem_stake",
      failureClass: "content_incomplete",
      retryable: false,
    });
  });

  it("foto com legenda Stake: não registra números inventados pelo Vision", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromImage.mockResolvedValue({
      bet: {
        evento: "Coquimbo Unido vs Colo Colo",
        esporte: "Soccer",
        competicao: "Liga",
        pais: "Chile",
        mercado: "Moneyline",
        selecao: "Coquimbo Unido",
        odds: 1.9,
        stake: 1,
        data: null,
        casaDeAposta: "Betano",
      },
      provider: "gemini",
    });
    const caption = [
      "⚽ Coquimbo Unido vs Colo Colo",
      "Data: 15/06 16:00",
      "Mercado: Resultado Final",
      "Entrada: Casa",
      "ODD: 2.10",
      "Stake:",
    ].join("\n");

    const outcome = await handleChannelPhotoPost({
      chatId: CHANNEL_ID,
      messageId: 612,
      caption,
      postDate: POST_DATE,
      mediaFileId: "foto-teste",
    }, photoDeps);
    expect(outcome).toEqual({ kind: "unparseable", missing: ["stake"] });
    expect(geminiMocks.extractBetFromImage).not.toHaveBeenCalled();
    // Rascunho espera a edição: a foto nem é baixada.
    expect(photoDeps.loadImage).not.toHaveBeenCalled();
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("foto com legenda informativa (odd/link sem rótulo vazio) chama o Vision e registra", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromImage.mockResolvedValue({
      bet: {
        evento: "Crowborough Athletic vs South Park",
        esporte: "Soccer",
        competicao: "Inglaterra",
        pais: "Inglaterra",
        mercado: "Asian Handicap",
        selecao: "South Park +0.5",
        odds: 1.85,
        stake: 1,
        data: null,
        casaDeAposta: "Bet365",
      },
      provider: "gemini",
    });
    const caption = [
      "Big Data Bet Métodos (asian away)",
      "",
      "25/08 - Inglaterra - odd 1,77",
      "https://www.bet365.bet.br/#/AC/B1/C1/D8/E200057053/F3/I3/",
    ].join("\n");

    const outcome = await handleChannelPhotoPost({
      chatId: CHANNEL_ID,
      messageId: 613,
      caption,
      postDate: POST_DATE,
      mediaFileId: "foto-teste",
    }, photoDeps);
    expect(outcome).toMatchObject({ kind: "registered" });
    expect(geminiMocks.extractBetFromImage).toHaveBeenCalled();
    expect(await db.prisma.bet.count()).toBe(1);
  });

  describe("álbum: vencedora conferida entre o OCR e a gravação", () => {
    const betDaFoto = {
      evento: "Crowborough Athletic vs South Park", esporte: "Soccer", competicao: "Inglaterra", pais: "Inglaterra",
      mercado: "Asian Handicap", selecao: "South Park +0.5", odds: 1.85, stake: 1, data: null, casaDeAposta: "Bet365",
    };
    const legenda = "Big Data Bet Métodos (asian away)\n\n25/08 - Inglaterra - odd 1,77";

    async function albumCom(mediaGroupId: string, messageId: number, caption: string) {
      const { stageMediaAlbumPhoto } = await import("@/src/services/capture/channel/media-album");
      await stageMediaAlbumPhoto({
        mediaGroupId, chatId: String(CHANNEL_ID),
        photo: { messageId, fileId: `f${messageId}`, caption }, postDate: POST_DATE,
      });
    }

    it("outra foto vira vencedora durante o OCR: não grava e relança", async () => {
      await seedChannelBankroll(db);
      const mediaGroupId = "album-troca-ocr";
      await albumCom(mediaGroupId, 700, "");
      geminiMocks.extractBetFromImage.mockImplementation(async () => {
        // A legenda chega numa foto irmã enquanto o Vision lê a primeira.
        await albumCom(mediaGroupId, 701, legenda);
        return { bet: betDaFoto, provider: "gemini" };
      });
      const { MediaAlbumWinnerChangedError } = await import("@/src/services/capture/channel/capture-new");
      await expect(handleChannelPhotoPost({
        mediaGroupId, chatId: CHANNEL_ID, messageId: 700, caption: "", postDate: POST_DATE,
        mediaFileId: "foto-teste",
      }, photoDeps)).rejects.toBeInstanceOf(MediaAlbumWinnerChangedError);
      expect(await db.prisma.bet.count()).toBe(0);
    });

    it("vencedora estável grava normalmente", async () => {
      await seedChannelBankroll(db);
      await albumCom("album-estavel", 710, legenda);
      geminiMocks.extractBetFromImage.mockResolvedValue({ bet: betDaFoto, provider: "gemini" });
      const outcome = await handleChannelPhotoPost({
        mediaGroupId: "album-estavel", chatId: CHANNEL_ID, messageId: 710, caption: legenda, postDate: POST_DATE,
        mediaFileId: "foto-teste",
      }, photoDeps);
      expect(outcome).toMatchObject({ kind: "registered" });
      expect(await db.prisma.bet.count()).toBe(1);
    });
  });

  it("foto de grade registra só a seleção da legenda e reentrega não volta à visão", async () => {
    await seedChannelBankroll(db);
    const base = { evento: "Corinthians vs Pinheiros", esporte: "Basketball", competicao: "", pais: "", mercado: "Team Total (Points)", odds: 1.8, stake: 1, stakeSource: "caption", data: null, casaDeAposta: "bet365" };
    const bets = [
      { ...base, selecao: "Corinthians Mais de 83.5", odds: 1.83 },
      { ...base, selecao: "Corinthians Menos de 83.5", odds: 1.83 },
      { ...base, selecao: "Pinheiros +70.5 Pontos" },
      { ...base, selecao: "Pinheiros Menos de 70.5", odds: 1.86 },
    ];
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
    const photo = { chatId: CHANNEL_ID, messageId: 56, postDate: POST_DATE, mediaFileId: "foto-teste", caption: "Araujo / SL\nPinheiros +70.5 Pontos @1.80\n1u / Até +71.5 Pontos" };
    const outcome = await handleChannelPhotoPost(photo, photoDeps);
    expect(outcome.kind).toBe("registered");
    const rows = await db.prisma.bet.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceExternalId: "56", mercado: "Team Total (Points)", selecao: "Pinheiros Over 70.5" });
    expect(toNumber(rows[0]!.odds)).toBe(1.8);
    expect(toNumber(rows[0]!.stake)).toBe(1);
    expect(await handleChannelPhotoPost(photo, photoDeps)).toMatchObject({ kind: "duplicate", betId: rows[0]!.id });
    expect(geminiMocks.extractBetFromImage).toHaveBeenCalledTimes(1);
    // A reentrega é reconhecida antes do download.
    expect(photoDeps.loadImage).toHaveBeenCalledTimes(1);
  });

  it("foto divergente da seleção da legenda não registra um subconjunto errado", async () => {
    await seedChannelBankroll(db);
    const wrong = { evento: "Corinthians vs Pinheiros", esporte: "Basketball", competicao: "", pais: "", mercado: "Team Total (Points)", selecao: "Pinheiros Under 70.5", odds: 1.86, stake: 1, stakeSource: "caption", data: null, casaDeAposta: "bet365" };
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: wrong, bets: [wrong], provider: "gemini" });
    // Reler daria a mesma leitura: a divergência é recusa com aviso e pendência, não retry.
    await expect(handleChannelPhotoPost({ chatId: CHANNEL_ID, messageId: 56, postDate: POST_DATE, mediaFileId: "foto-teste", caption: "Pinheiros +70.5 Pontos @1.80\n1u / Até +71.5 Pontos" }, photoDeps))
      .resolves.toEqual({ kind: "unparseable", missing: ["selecao"] });
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await db.prisma.operationalAction.findMany({ where: { actionType: "capture_review" }, select: { resourceId: true, evidence: true } }))
      .toEqual([expect.objectContaining({ resourceId: `${CHANNEL_ID}:56`, evidence: expect.objectContaining({ reason: "selecao_diverge_legenda" }) })]);
    expect(alertMocks.sendOperatorNotification).toHaveBeenCalledWith(expect.stringContaining("https://t.me/c/1234567890/56"));
  });

  it("lote de texto recusado grava a telemetria, abre a pendência e avisa", async () => {
    await seedChannelBankroll(db);
    const prop = (jogador: string) => ({ evento: "Time A vs Time B", esporte: "Soccer", competicao: "", pais: "", mercado: "Player Shots", selecao: `${jogador} Over 1.5`, odds: 1.8, stake: 1, data: null, casaDeAposta: "" });
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: prop("Jogador 1"), bets: [prop("Jogador 1"), prop("Jogador 2")], provider: "gemini" });

    const outcome = await handleChannelPost(post("Jogador 1 e Jogador 2 chutes\n1u 1u 1u", 612), { forcedByOperator: true });

    expect(outcome).toEqual({ kind: "unparseable", missing: ["quantidade_de_stakes_divergente"] });
    expect(await db.prisma.auditEvent.findFirst({ where: { action: "telegram.parse", resourceId: "612" }, select: { outcome: true, details: true } }))
      .toMatchObject({ outcome: "guard_rejected", details: { reason: "quantidade_de_stakes_divergente", via: "gemini" } });
    expect(await db.prisma.operationalAction.count({ where: { actionType: "capture_review", resourceId: `${CHANNEL_ID}:612` } })).toBe(1);
    expect(alertMocks.sendOperatorNotification).toHaveBeenCalledWith(expect.stringContaining("número de stakes diferente do de seleções"));
  });

  it("foto de álbum já capturado noutra foto do mesmo álbum não vira segunda aposta", async () => {
    const bank = await seedChannelBankroll(db);
    await db.prisma.telegramMediaAlbum.create({ data: {
      mediaGroupId: "album-trocado", chatId: String(CHANNEL_ID), status: "open", winnerMessageId: 71, winnerFileId: "file-71",
      winnerCaption: "Entrada nova", messageIds: [70, 71], postDate: POST_DATE, expiresAt: new Date(Date.now() + 3_600_000),
    } });
    const bet = await db.prisma.bet.create({ data: {
      bankrollId: bank.id, source: `telegram-channel:${CHANNEL_ID}`, sourceExternalId: "70", data: POST_DATE, esporte: "Soccer",
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: POST_DATE, evento: "Time A vs Time B", mercado: "Money Line – Match", selecao: "Time A", odds: 2, stake: 1,
    } });

    await expect(handleChannelPhotoPost({ mediaGroupId: "album-trocado", chatId: CHANNEL_ID, messageId: 71, postDate: POST_DATE, caption: "Entrada nova", mediaFileId: "file-71" }, photoDeps))
      .resolves.toEqual({ kind: "duplicate", betId: bet.id });
    expect(geminiMocks.extractBetFromImage).not.toHaveBeenCalled();
    expect(photoDeps.loadImage).not.toHaveBeenCalled();
  });

  it("releitura do guard num álbum baixa as outras fotos só quando precisa e olha todas", async () => {
    await seedChannelBankroll(db);
    await db.prisma.telegramMediaAlbum.create({ data: {
      mediaGroupId: "album-releitura", chatId: String(CHANNEL_ID), status: "open", winnerMessageId: 81, winnerFileId: "file-81",
      winnerCaption: "Time A x Time B\n1u", messageIds: [80, 81], postDate: POST_DATE, expiresAt: new Date(Date.now() + 3_600_000),
    } });
    const handicap = { evento: "Time A vs Time B", esporte: "Soccer", competicao: "", pais: "", mercado: "Asian Handicap", selecao: "0.0, -0.5", odds: 1.9, stake: 1, stakeSource: "caption", data: null, casaDeAposta: "Bet365" };
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: handicap, bets: [handicap], provider: "gemini" });
    rereadMock.llmGenerateJson.mockResolvedValue({ data: { selecao: "Time A 0.0, -0.5" }, provider: "gemini" });
    const loadImage = vi.fn(async (fileId: string) => ({ base64: `img-${fileId}`, mimeType: "image/jpeg" }));

    await handleChannelPhotoPost({
      mediaGroupId: "album-releitura", chatId: CHANNEL_ID, messageId: 81, postDate: POST_DATE, caption: "Time A x Time B\n1u",
      mediaFileId: "file-81", albumFileIds: ["file-80", "file-81"],
    }, { loadImage });

    // A foto lida baixa antes da leitura; a irmã, só na releitura.
    expect(loadImage.mock.calls).toEqual([["file-81"], ["file-80"]]);
    const parts = rereadMock.llmGenerateJson.mock.calls[0]?.[0].parts as Array<{ inlineData?: { data: string } }>;
    expect(parts.flatMap((part) => part.inlineData ? [part.inlineData.data] : [])).toEqual(["img-file-80", "img-file-81"]);
  });

  it("retry de texto velho depois do edit não volta à cascata", async () => {
    await seedChannelBankroll(db);
    const registered = await handleChannelPost(post(POST_TEXT, 611));
    expect(registered.kind).toBe("registered");
    geminiMocks.extractBetFromText.mockClear();

    const replay = await handleChannelPost(post(
      ["⚽ Coquimbo Unido vs Colo Colo", "Entrada: Casa", "ODD: 2.10", "Stake:"].join("\n"),
      611,
    ));
    expect(replay.kind).toBe("duplicate");
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();
  });

  it("falha transitória de texto é registrada e lançada para a fila confiável", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: null, provider: null });
    const semMercado = [
      "🎾 Sinner vs Fritz",
      "Entrada: +22.5",
      "@1.90",
      "1u",
    ].join("\n");

    await expect(handleChannelPost(post(semMercado, 602)))
      .rejects.toBeInstanceOf(TelegramParseRetryError);
    await expect(handleChannelPost(post(semMercado, 602)))
      .rejects.toBeInstanceOf(TelegramParseRetryError);

    const eventos = await db.prisma.auditEvent.findMany({
      where: { action: "telegram.parse", resourceId: "602" },
    });
    expect(eventos).toHaveLength(1);
    const evento = eventos[0]!;
    expect(evento.outcome).toBe("unparseable");
    expect(evento.details).toMatchObject({
      reason: "llm_exhausted",
      failureClass: "transient_provider",
      retryable: true,
    });
  });

  it("falha transitória de foto é registrada e lançada para a fila confiável", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromImage.mockResolvedValueOnce({ bet: null, provider: null });

    await expect(handleChannelPhotoPost({
      chatId: CHANNEL_ID,
      messageId: 603,
      caption: "Bilhete",
      postDate: POST_DATE,
      mediaFileId: "foto-teste",
    }, photoDeps)).rejects.toBeInstanceOf(TelegramParseRetryError);

    const evento = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "telegram.parse", resourceId: "603" },
    });
    expect(evento.details).toMatchObject({
      reason: "llm_exhausted",
      failureClass: "transient_provider",
      retryable: true,
    });
  });
});

describe("recusa da IA não relança o post", () => {
  const semMercado = ["🎾 Sinner vs Fritz", "Entrada: +22.5", "@1.90", "1u"].join("\n");

  it("texto que todos os provedores leram e recusaram vira recusa com aviso e pendência", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: null, provider: null, refused: { reason: "leitura_recusada_pela_ia", provider: null } });

    const outcome = await handleChannelPost(post(semMercado, 604));

    expect(outcome).toEqual({ kind: "unparseable", missing: ["leitura_recusada_pela_ia"] });
    const evento = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "telegram.parse", resourceId: "604" } });
    expect(evento).toMatchObject({ outcome: "guard_rejected", details: expect.objectContaining({ reason: "leitura_recusada_pela_ia", retryable: false }) });
    expect(await db.prisma.operationalAction.findFirst({ where: { actionType: "capture_review", resourceId: `${CHANNEL_ID}:604` } })).not.toBeNull();
    expect(alertMocks.sendOperatorNotification).toHaveBeenCalledWith(expect.stringContaining("Aposta não registrada"));
    const guardado = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "canal_post_descartado" } });
    expect(guardado.details).toMatchObject({ messageId: 604, reason: "captura_recusada", kind: "text" });
  });

  it("foto que todos os provedores recusaram fica guardada com o arquivo", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: null, provider: null, refused: { reason: "leitura_recusada_pela_ia", provider: null } });

    const outcome = await handleChannelPhotoPost({
      chatId: CHANNEL_ID, messageId: 605, caption: "Palmeiras +1.5", postDate: POST_DATE, mediaFileId: "foto-recusada",
    }, photoDeps);

    expect(outcome).toEqual({ kind: "unparseable", missing: ["leitura_recusada_pela_ia"] });
    const guardado = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "canal_post_descartado" } });
    expect(guardado.details).toMatchObject({ reason: "captura_recusada", kind: "photo", mediaFileId: "foto-recusada" });
    expect(await db.prisma.bet.count()).toBe(0);
  });

  /** O erro que a captura lança para a fila, com a recusa que vale no fim das tentativas. */
  async function retryError(capture: Promise<unknown>): Promise<TelegramParseRetryError> {
    const error = await capture.then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(TelegramParseRetryError);
    return error as TelegramParseRetryError;
  }

  it("texto que um provedor recusou com outro fora relança e, no fim das tentativas, vira recusa", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: null, provider: null, refusalWhenExhausted: { reason: "leitura_recusada_com_provedor_fora" } });

    const error = await retryError(handleChannelPost(post(semMercado, 606)));
    expect(await db.prisma.auditEvent.count({ where: { action: "canal_post_descartado" } })).toBe(0);

    await error.onExhausted?.();
    const evento = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "telegram.parse", outcome: "guard_rejected", resourceId: "606" } });
    expect(evento.details).toMatchObject({ reason: "leitura_recusada_com_provedor_fora", retryable: false });
    expect(await db.prisma.operationalAction.findFirst({ where: { actionType: "capture_review", resourceId: `${CHANNEL_ID}:606` } })).not.toBeNull();
    expect(alertMocks.sendOperatorNotification).toHaveBeenCalledWith(expect.stringContaining("Aposta não registrada"));
    const guardado = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "canal_post_descartado" } });
    expect(guardado.details).toMatchObject({ messageId: 606, reason: "captura_recusada", kind: "text" });
  });

  it("foto que um provedor recusou com outro fora guarda o arquivo no fim das tentativas", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: null, provider: null, refusalWhenExhausted: { reason: "leitura_recusada_com_provedor_fora" } });

    const error = await retryError(handleChannelPhotoPost({
      chatId: CHANNEL_ID, messageId: 607, caption: "Palmeiras +1.5", postDate: POST_DATE, mediaFileId: "foto-meio-lida",
    }, photoDeps));
    await error.onExhausted?.();

    const guardado = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "canal_post_descartado" } });
    expect(guardado.details).toMatchObject({ messageId: 607, reason: "captura_recusada", kind: "photo", mediaFileId: "foto-meio-lida" });
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("sem nenhum provedor que tenha lido, nada substitui a dead-letter", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: null, provider: null });
    expect((await retryError(handleChannelPost(post(semMercado, 608)))).onExhausted).toBeUndefined();
  });
});

/** O que a LLM devolveria para "Flamengo x Palmeiras / Ambas marcam 1.85". */
function bttsBet(stake = 1) {
  return {
    evento: "Flamengo vs Palmeiras", esporte: "Soccer", competicao: "Brasileirão", pais: "Brasil",
    mercado: "Ambas Marcam", selecao: "Sim", odds: 1.85, stake, data: new Date("2026-06-15T22:00:00Z"), casaDeAposta: "",
  };
}

async function seedFixedStakeBankroll() {
  const bankroll = await seedChannelBankroll(db);
  return db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { stakePolicy: "ALWAYS", defaultStakeUnits: 1 } });
}

describe("filtro anti-ruído: nenhum post de texto some em silêncio", () => {
  it("o leitor por regra roda antes do filtro: tip com rodapé de planilha é capturada", async () => {
    await seedChannelBankroll(db);
    const text = `${POST_TEXT}\n📊 Planilha atualizada no link da bio`;
    const outcome = await handleChannelPost(post(text, 801));
    expect(outcome.kind).toBe("registered");
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();
  });

  it("odd nua vai para a cascata em vez de morrer como ruído ou rascunho", async () => {
    await seedFixedStakeBankroll();
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: bttsBet(), provider: "gemini" });
    expect((await handleChannelPost(post("Flamengo x Palmeiras\nAmbas marcam 1.85", 802))).kind).toBe("registered");
    expect((await handleChannelPost(post("Sinner vs Alcaraz\nSinner vence 1.95\n1u", 803))).kind).not.toBe("skipped");
    expect(geminiMocks.extractBetFromText).toHaveBeenCalledTimes(2);
  });

  it("post barrado fica guardado com o texto, a edição atualiza e o painel o lista", async () => {
    const bankroll = await seedChannelBankroll(db);
    expect(await handleChannelPost(post("Flamengo x Palmeiras\nAmbas marcam", 804)))
      .toEqual({ kind: "skipped", reason: "nao_parece_aposta" });
    await handleChannelPost(post("Bom dia família! 🌞", 805));
    await handleEditedChannelPost(editedPost("Flamengo x Palmeiras\nAmbas marcam sim", new Date(POST_DATE.getTime() + 60_000), 804));
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();

    const records = await db.prisma.auditEvent.findMany({ where: { action: "canal_post_descartado" }, orderBy: { resourceId: "asc" } });
    expect(records.map((row) => row.resourceId)).toEqual([`${CHANNEL_ID}:804`, `${CHANNEL_ID}:805`]);
    expect(records[0]?.details).toMatchObject({ bankrollId: bankroll.id, messageId: 804, lines: ["Flamengo x Palmeiras", "Ambas marcam sim"], postDate: POST_DATE.toISOString() });

    const listed = await listDiscardedChannelPosts([String(CHANNEL_ID)], new Date(Date.now() - 86_400_000), 5);
    expect(listed.get(String(CHANNEL_ID))?.total).toBe(2);
    expect(listed.get(String(CHANNEL_ID))?.recent.map((item) => [item.messageId, item.text]).sort()).toEqual([
      [804, "Flamengo x Palmeiras\nAmbas marcam sim"], [805, "Bom dia família! 🌞"],
    ]);
    // Sem o card dizer nada, o descarte não entra na taxa de parse.
    expect(await db.prisma.auditEvent.count({ where: { action: "telegram.parse" } })).toBe(0);
  });

  it("post que virou aposta depois apagada não volta à lista de descartados", async () => {
    await seedChannelBankroll(db);
    await handleChannelPost(post("Bom dia família! 🌞", 807));
    await handleChannelPost(post("Boa noite, galera! 🌙", 808));
    await db.prisma.retiredBetSource.create({
      data: { source: `telegram-channel:${CHANNEL_ID}`, sourceExternalId: "807:2", retiredBetId: "00000000-0000-4000-8000-000000000807" },
    });
    const listed = await listDiscardedChannelPosts([String(CHANNEL_ID)], new Date(Date.now() - 86_400_000), 5);
    expect(listed.get(String(CHANNEL_ID))?.recent.map((item) => item.messageId)).toEqual([808]);
  });

  it("\"Capturar mesmo assim\" relê o post sem o filtro, uma aposta só mesmo com clique repetido", async () => {
    await seedFixedStakeBankroll();
    const text = "Flamengo x Palmeiras\nAmbas marcam, entrei na Betano";
    expect((await handleChannelPost(post(text, 806))).kind).toBe("skipped");
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: bttsBet(), provider: "gemini" });

    const request = { chatId: String(CHANNEL_ID), messageId: 806, actor: "operador-sintetico" };
    expect(await requestDiscardedPostCapture(request)).toBe("enfileirado");
    expect(await requestDiscardedPostCapture(request)).toBe("ja_na_fila");
    expect(queue.jobs).toHaveLength(1);
    const job = queue.jobs[0]!;
    expect(job).toMatchObject({
      name: "telegram.updates",
      singletonKey: `tg:${CHANNEL_ID}:msg:806`,
      data: { kind: "channel_post", messageId: 806, text, forcedByOperator: true },
    });

    const run = () => runQueuedJob(job.data);
    expect(await run()).toMatchObject({ kind: "registered" });
    expect(await run()).toMatchObject({ kind: "duplicate" });
    expect(await db.prisma.bet.count()).toBe(1);
    expect(geminiMocks.extractBetFromText).toHaveBeenCalledTimes(1);

    // Virou aposta: sai da lista do painel; o pedido ficou registrado com o operador.
    const listed = await listDiscardedChannelPosts([String(CHANNEL_ID)], new Date(Date.now() - 86_400_000), 5);
    expect(listed.get(String(CHANNEL_ID))).toBeUndefined();
    expect(await db.prisma.auditEvent.count({ where: { action: "channel.capture_discarded", actor: "operador-sintetico" } })).toBe(2);
  });

  it("balanço com a tip inteira e ✅ GREEN não vira aposta nova: fica guardado como resultado", async () => {
    await seedChannelBankroll(db);
    const recap = ["Resultado do dia", ...POST_TEXT.split("\n"), "✅ GREEN"].join("\n");
    expect(await handleChannelPost(post(recap, 810))).toEqual({ kind: "skipped", reason: "resultado_ou_balanco" });
    expect(await handleChannelPost(post(`${POST_TEXT}\n✅ GREEN`, 811))).toEqual({ kind: "skipped", reason: "resultado_ou_balanco" });
    expect(await db.prisma.bet.count()).toBe(0);
    const listed = await listDiscardedChannelPosts([String(CHANNEL_ID)], new Date(Date.now() - 86_400_000), 5);
    expect(listed.get(String(CHANNEL_ID))?.recent.map((item) => item.reason)).toEqual(["resultado_ou_balanco", "resultado_ou_balanco"]);
  });

  it("post novo de jogo que já terminou é recusado com motivo próprio; entrada ao vivo segue", async () => {
    await seedChannelBankroll(db);
    // POST_DATE é 10/06 09:00 em São Paulo.
    const finished = POST_TEXT.replace("Data: 15/06 16:00", "Data: 09/06 16:00");
    expect(await handleChannelPost(post(finished, 812))).toEqual({ kind: "skipped", reason: "jogo_ja_terminado" });
    expect((await listDiscardedChannelPosts([String(CHANNEL_ID)], new Date(Date.now() - 86_400_000), 5))
      .get(String(CHANNEL_ID))?.recent[0]).toMatchObject({ messageId: 812, reason: "jogo_ja_terminado" });
    const live = POST_TEXT.replace("Data: 15/06 16:00", "Data: 10/06 08:00");
    expect((await handleChannelPost(post(live, 813))).kind).toBe("registered");
  });

  it("a captura pedida pelo dono fica fora da latência do post, que o painel lê da evidência em SQL", async () => {
    await seedChannelBankroll(db);
    expect((await handleChannelPost(post(POST_TEXT, 870))).kind).toBe("registered");
    expect((await handleChannelPost(post(POST_TEXT.replace("Entrada: Casa", "Entrada: Fora"), 871), { forcedByOperator: true })).kind).toBe("registered");
    const source = `telegram-channel:${CHANNEL_ID}`;
    expect((await readCaptureLatency([source], new Date(0))).get(source)).toMatchObject({ samples: 1 });
  });

  it("\"Capturar mesmo assim\" de texto vindo de edição leva a data da edição como entrada", async () => {
    await seedFixedStakeBankroll();
    const editedAt = new Date(POST_DATE.getTime() + 10 * 60_000);
    const text = "Flamengo x Palmeiras\nAmbas marcam, entrei na Betano";
    expect((await handleEditedChannelPost(editedPost(text, editedAt, 814))).kind).toBe("skipped");
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: bttsBet(), provider: "gemini" });
    await requestDiscardedPostCapture({ chatId: String(CHANNEL_ID), messageId: 814, actor: "operador-sintetico" });
    const job = queue.jobs[0]!;
    expect(job.data).toMatchObject({ editDate: editedAt.toISOString(), forcedByOperator: true });
    expect(await runQueuedJob(job.data)).toMatchObject({ kind: "registered" });
    expect((await db.prisma.bet.findFirstOrThrow()).sourcePostedAt?.toISOString()).toBe(editedAt.toISOString());
  });

  it("pedido de captura sem o post guardado é recusado", async () => {
    await expect(requestDiscardedPostCapture({ chatId: String(CHANNEL_ID), messageId: 999, actor: "operador-sintetico" }))
      .rejects.toThrow(/não encontrado/);
    expect(queue.jobs).toHaveLength(0);
  });
});

describe("esportes do canal", () => {
  const basketTotal = (selecao: string) => ({
    evento: "Mogi vs Franca", esporte: "Unknown", competicao: "", pais: "", mercado: "Total",
    selecao, odds: 1.9, stake: 1, data: new Date("2026-06-15T22:00:00Z"), casaDeAposta: "",
  });
  const text = "Mogi x Franca\nOver 15.5 @1.90\n1u";

  it("canal de um esporte só grava a aposta com o esporte confirmado pelo canal", async () => {
    const bankroll = await seedChannelBankroll(db);
    await db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { channelSports: ["Basketball"] } });
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: basketTotal("Over 150.5"), provider: "gemini" });
    const outcome = await handleChannelPost(post(text.replace("15.5", "150.5"), 840));
    expect(outcome).toMatchObject({ kind: "registered", sportResolutionStatus: "CONFIRMED" });
    expect(await db.prisma.bet.findFirstOrThrow()).toMatchObject({ esporte: "Basketball", sportSource: "CHANNEL", sportResolutionStatus: "CONFIRMED" });
    // Total de basquete abaixo de 50 é outra unidade ou outro esporte: conflito, não confirmação.
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: basketTotal("Over 15.5"), provider: "gemini" });
    expect(await handleChannelPost(post(text, 843))).toMatchObject({ kind: "registered", sportResolutionStatus: "CONFLICT" });
  });

  it("a ficha dos times não decide o esporte do total sem unidade: o canal marcado decide", async () => {
    const bankroll = await seedChannelBankroll(db);
    for (const [name, flashscoreTeamId] of [["Frolunda", "901"], ["Farjestad", "902"]] as const) {
      await seedTeamCard(db.prisma, { sport: "Hockey", flashscoreTeamId, flashscoreName: name, pinnacleNames: [{ name }] });
    }
    const text = "Jogo: Frolunda x Farjestad\nData: 15/06 16:00\nEntrada: Over 5.5\nODD: 1.90\nStake: 1u";
    // Os nomes existem no hóquei, mas nome não prova o jogo: o total segue sem unidade.
    expect(await handleChannelPost(post(text, 845))).toEqual({ kind: "unparseable", missing: ["mercado"] });
    await db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { channelSports: ["Hockey"] } });
    expect(await handleChannelPost(post(text, 846))).toMatchObject({ kind: "registered", sportResolutionStatus: "CONFIRMED" });
    expect(await db.prisma.bet.findFirstOrThrow({ select: { esporte: true, sportSource: true } })).toEqual({ esporte: "Hockey", sportSource: "CHANNEL" });
  });

  it("\"vários/não sei\" recusa o total pequeno sem unidade e aceita o de 50 ou mais", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: basketTotal("Over 15.5"), provider: "gemini" });
    expect(await handleChannelPost(post(text, 841))).toEqual({ kind: "unparseable", missing: ["mercado"] });
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: basketTotal("Over 150.5"), provider: "gemini" });
    expect(await handleChannelPost(post(text.replace("15.5", "150.5"), 842))).toMatchObject({ kind: "registered", sportResolutionStatus: "PENDING" });
  });
});

describe("o esporte da captura, decidido uma vez na preparação", () => {
  const total = (selecao: string, extra: Record<string, unknown> = {}) => ({
    evento: "Time A vs Time B", esporte: "Unknown", competicao: "", pais: "", mercado: "Total – Match",
    selecao, odds: 1.85, stake: 1, data: new Date("2026-06-15T22:00:00Z"), casaDeAposta: "", ...extra,
  });

  it.each([
    ["escanteios", "corners", "Total (Corners) – Match"],
    ["cartões", "cards", "Total (Bookings) – Match"],
  ])("decisão antecipada pendente não vale depois que a releitura acha %s", async (_label, categoria, mercado) => {
    // Canal "vários/não sei" e times fora das identidades: antes da releitura, o esporte fica pendente.
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: total("Mais de 9.5"), provider: "gemini" });
    rereadMock.llmGenerateJson.mockResolvedValue({ data: { categoria, periodo: "match" }, provider: "gemini" });
    expect(await handleChannelPhotoPost({
      chatId: CHANNEL_ID, messageId: 850, caption: "Mais de 9.5 @1.85", postDate: POST_DATE, mediaFileId: "foto-850",
    }, photoDeps)).toMatchObject({ kind: "registered", sportResolutionStatus: "CONFIRMED" });
    expect(await db.prisma.bet.findFirstOrThrow({ select: { mercado: true, esporte: true, sportSource: true } }))
      .toEqual({ mercado, esporte: "Soccer", sportSource: "TEXT" });
  });

  it("canal de futebol: total sem unidade a partir da linha 8 grava escanteios, sem perguntar ao dono", async () => {
    const bankroll = await seedChannelBankroll(db);
    await db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { channelSports: ["Soccer"] } });
    geminiMocks.extractBetFromText.mockResolvedValue({
      bet: total("Over 8.5", { evento: "Brackley Town vs Scarborough Athletic" }), provider: "gemini",
    });
    expect(await runQueuedJob(textJob(854, "Brackley Town x Scarborough Athletic\nOver 8.5 @1.85\n1u")))
      .toMatchObject({ kind: "registered", sportResolutionStatus: "CONFIRMED" });
    const bet = await db.prisma.bet.findFirstOrThrow({
      select: { mercado: true, selecao: true, esporte: true, captureEvidence: { select: { parsedJson: true } } },
    });
    expect(bet).toMatchObject({ mercado: "Total (Corners) – Match", selecao: "Over 8.5", esporte: "Soccer" });
    expect(bet.captureEvidence?.parsedJson).toMatchObject({ totalUnitFromLine: true });
    expect(fixMocks.offerCaptureFix).not.toHaveBeenCalled();
    expect(await db.prisma.operationalAction.count({ where: { actionType: "capture_review" } })).toBe(0);
  });

  it("canal \"vários/não sei\": sem futebol confirmado, o Over 8.5 continua indo ao dono", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: total("Over 8.5"), provider: "gemini" });
    expect(await runQueuedJob(textJob(855, "Time A x Time B\nOver 8.5 @1.85\n1u")))
      .toEqual({ kind: "unparseable", missing: ["mercado"] });
    expect(fixMocks.offerCaptureFix).toHaveBeenCalledWith(expect.objectContaining({ reason: "mercado_total_ambiguo" }));
  });

  it("lote: a decisão lê a legenda do post, não só a stake de cada item", async () => {
    await seedChannelBankroll(db);
    const moneyline = (evento: string, selecao: string) => ({
      evento, esporte: "Unknown", competicao: "", pais: "", mercado: "Moneyline", selecao, odds: 1.9, stake: 1,
      stakeSource: "caption", data: new Date("2026-06-15T22:00:00Z"), casaDeAposta: "",
    });
    const bets = [moneyline("Time A vs Time B", "Time A"), moneyline("Time C vs Time D", "Time C")];
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
    expect(await runQueuedJob(textJob(851, "⚽ Time A e Time C vencem @1.90 1u cada"))).toMatchObject({ kind: "registered" });
    expect(await db.prisma.bet.findMany({ select: { esporte: true, sportSource: true } }))
      .toEqual([{ esporte: "Soccer", sportSource: "EMOJI" }, { esporte: "Soccer", sportSource: "EMOJI" }]);
  });

  it("lote com 🏀 na legenda: \"Over 9.5\" não é total de jogo de basquete, e fica sem unidade", async () => {
    await seedChannelBankroll(db);
    const items = [total("Over 9.5", { stakeSource: "caption" }), total("Over 9.5", { evento: "Time C vs Time D", stakeSource: "caption" })];
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: items[0], bets: items, provider: "gemini" });
    expect(await runQueuedJob(textJob(852, "🏀 Time A x Time B e Time C x Time D\nOver 9.5 @1.85\n1u cada")))
      .toEqual({ kind: "unparseable", missing: ["mercado"] });
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("print avulso da NBA: o total pequeno vai ao conserto pela DM em vez de gravar basquete", async () => {
    await seedChannelBankroll(db);
    // A competição lida do print confirma basquete; a legenda não diz o esporte.
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: total("Over 9.5", { competicao: "NBA" }), provider: "gemini" });
    expect(await handleChannelPhotoPost({
      chatId: CHANNEL_ID, messageId: 853, caption: "Over 9.5 @1.85", postDate: POST_DATE, mediaFileId: "foto-853",
    }, photoDeps)).toEqual({ kind: "unparseable", missing: ["mercado"] });
    expect(fixMocks.offerCaptureFix).toHaveBeenCalledWith(expect.objectContaining({ reason: "mercado_total_ambiguo" }));
    expect(await db.prisma.bet.count()).toBe(0);
  });
});

describe("canal pausado pelo dono", () => {
  async function seedPausedBankroll() {
    const bankroll = await seedChannelBankroll(db);
    return db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { capturePausedAt: POST_DATE } });
  }

  it("post de texto vai para os descartados sem leitura e volta pelo \"Capturar mesmo assim\"", async () => {
    await seedPausedBankroll();
    expect(await handleChannelPost(post(POST_TEXT, 830))).toEqual({ kind: "skipped", reason: "canal_pausado" });
    expect(await db.prisma.bet.count()).toBe(0);
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();
    expect((await listDiscardedChannelPosts([String(CHANNEL_ID)], new Date(Date.now() - 86_400_000), 5))
      .get(String(CHANNEL_ID))?.recent[0]).toMatchObject({ messageId: 830, kind: "text", reason: "canal_pausado" });

    await requestDiscardedPostCapture({ chatId: String(CHANNEL_ID), messageId: 830, actor: "operador-sintetico" });
    const job = queue.jobs[0]!;
    expect(await runQueuedJob(job.data)).toMatchObject({ kind: "registered" });
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("foto vai para os descartados com o file_id e a captura forçada a lê", async () => {
    await seedPausedBankroll();
    const photo = { chatId: CHANNEL_ID, messageId: 831, caption: "Over 2.5 gols @1.90 1u", postDate: POST_DATE, mediaFileId: "file-831" };
    expect(await handleChannelPhotoPost(photo, photoDeps)).toEqual({ kind: "skipped", reason: "canal_pausado" });
    // Pausado: nem baixa a imagem.
    expect(photoDeps.loadImage).not.toHaveBeenCalled();
    expect(geminiMocks.extractBetFromImage).not.toHaveBeenCalled();
    expect((await listDiscardedChannelPosts([String(CHANNEL_ID)], new Date(Date.now() - 86_400_000), 5))
      .get(String(CHANNEL_ID))?.recent[0]).toMatchObject({ messageId: 831, kind: "photo", text: "Over 2.5 gols @1.90 1u" });

    await requestDiscardedPostCapture({ chatId: String(CHANNEL_ID), messageId: 831, actor: "operador-sintetico" });
    expect(queue.jobs[0]).toMatchObject({ name: "telegram.updates", data: {
      kind: "channel_photo", messageId: 831, caption: "Over 2.5 gols @1.90 1u", fileId: "file-831", forcedByOperator: true,
    } });
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: { ...bttsBet(), mercado: "Total (Gols) – Match", selecao: "Over 2.5", odds: 1.9 }, provider: "gemini" });
    expect(await handleChannelPhotoPost({ ...photo, forcedByOperator: true }, photoDeps)).toMatchObject({ kind: "registered" });
  });

  it("a captura pedida pelo 👍 ainda recusa recapitulação e jogo encerrado", async () => {
    await seedPausedBankroll();
    const finished = POST_TEXT.replace("Data: 15/06 16:00", "Data: 09/06 16:00");
    const recap = ["Resultado do dia", ...POST_TEXT.split("\n"), "✅ GREEN"].join("\n");
    await handleChannelPost(post(finished, 833));
    await handleChannelPost(post(recap, 834));
    for (const messageId of [833, 834]) {
      await requestDiscardedPostCapture({ chatId: String(CHANNEL_ID), messageId, actor: "telegram-user:123", byReaction: true });
    }
    expect(queue.jobs.map((job) => job.data)).toEqual([
      expect.objectContaining({ messageId: 833, forcedByOperator: true, forcedByReaction: true }),
      expect.objectContaining({ messageId: 834, forcedByOperator: true, forcedByReaction: true }),
    ]);
    const outcomes = [];
    for (const job of queue.jobs) outcomes.push(await runQueuedJob(job.data));
    expect(outcomes).toEqual([
      { kind: "skipped", reason: "jogo_ja_terminado" },
      { kind: "skipped", reason: "resultado_ou_balanco" },
    ]);
    expect(await db.prisma.bet.count()).toBe(0);
    // O painel ainda pula tudo: ele mostra a idade do post.
    queue.jobs = [];
    await requestDiscardedPostCapture({ chatId: String(CHANNEL_ID), messageId: 833, actor: "operador-sintetico" });
    expect(await runQueuedJob(queue.jobs[0]!.data)).toMatchObject({ kind: "registered" });
  });

  it("post que a IA leu sem ver aposta fica guardado para o 👍 e o painel", async () => {
    await seedChannelBankroll(db);
    const text = "Sinner vs Alcaraz\nSinner vence 1.95\n1u";
    expect(await handleChannelPost(post(text, 832))).toEqual({ kind: "unparseable", missing: ["odds"] });
    expect(geminiMocks.extractBetFromText).toHaveBeenCalledTimes(1);
    expect((await listDiscardedChannelPosts([String(CHANNEL_ID)], new Date(Date.now() - 86_400_000), 5))
      .get(String(CHANNEL_ID))?.recent[0]).toMatchObject({ messageId: 832, reason: "ia_nao_viu_aposta", text });
    expect(alertMocks.sendOperatorNotification.mock.calls).toEqual([[[
      "❔ Post não virou aposta · Carteira Tips",
      "A leitura automática não achou odds no post 832, e a IA entendeu que ele não é uma aposta.",
      "👉 Se era aposta, use \"Capturar mesmo assim\" em Monitoramento › Canais ou registre à mão.",
      "https://t.me/c/1234567890/832",
    ].join("\n")]]);
    expect(await db.prisma.auditEvent.findFirst({ where: { action: "telegram.parse", resourceId: "832" }, select: { outcome: true, details: true } }))
      .toMatchObject({ outcome: "unparseable", details: { via: "texto", reason: "not_bet", missing: ["odds"] } });
  });
});

describe("recusa que pergunta ao dono", () => {
  /** O motivo da recusa guardada com o post e o dado que a DM pergunta. */
  async function refusalOf(messageId: number) {
    const { captureFixFieldFor } = await import("@/src/services/capture/capture-fix");
    const row = await db.prisma.auditEvent.findFirst({ where: { action: "canal_post_descartado", resourceId: `${CHANNEL_ID}:${messageId}` } });
    const reason = (row?.details as { refusal?: { reason: string } } | null)?.refusal?.reason ?? null;
    return { reason, asks: reason ? captureFixFieldFor(reason) : null };
  }
  const readWithoutOdds = {
    evento: "Coquimbo Unido vs Colo Colo", esporte: "Soccer", competicao: "", pais: "", mercado: "Money Line – Match",
    selecao: "Coquimbo Unido", odds: 0, stake: 1, data: new Date("2026-06-15T19:00:00Z"), casaDeAposta: "",
  };

  it.each([
    ["Min @1.70", 850],
    ["Odd mín: 1.70", 851],
  ])("odd mínima como único preço (%s): a leitura segue sem a odd e a recusa pergunta a odd", async (floor, messageId) => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromText.mockResolvedValue({
      bet: null, provider: "gemini", incompleteDraft: true, missing: ["odds"], withoutOdds: [readWithoutOdds],
    });
    const outcome = await handleChannelPost(post(POST_TEXT.replace("ODD: 2.10", floor), messageId));
    expect(outcome).toEqual({ kind: "unparseable", missing: ["odds"] });
    expect(geminiMocks.extractBetFromText).toHaveBeenCalledTimes(1);
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await refusalOf(messageId)).toEqual({ reason: "odd_invalida", asks: "odds" });
  });

  it("grade sem a opção marcada: recusa com a dúvida no aviso, post guardado com as opções e pergunta na DM", async () => {
    await seedChannelBankroll(db);
    const options = [{ selecao: "Coquimbo Unido -1", odds: 2.1 }, { selecao: "Colo Colo +1", odds: 1.7 }];
    const description = "Coquimbo Unido -1 @2.10 | Colo Colo +1 @1.70";
    geminiMocks.extractBetFromImage.mockResolvedValue({
      bet: null, provider: null, incompleteDraft: true, missing: ["unmarked_selection"],
      review: { reason: "unmarked_selection", description, evidence: {} },
      gridChoice: { bet: { ...readWithoutOdds, selecao: "Coquimbo Unido -1", odds: 2.1, mercado: "Asian Handicap" }, options },
    });
    expect(await handleChannelPhotoPost({
      chatId: CHANNEL_ID, messageId: 854, caption: "Stake: 1u", postDate: POST_DATE, mediaFileId: "foto-grade",
    }, photoDeps)).toEqual({ kind: "unparseable", missing: ["unmarked_selection"] });
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await refusalOf(854)).toEqual({ reason: "unmarked_selection", asks: "grid_option" });
    expect(String(alertMocks.sendOperatorNotification.mock.calls[0]?.[0])).toContain(`Dúvida da leitura: ${description}`);
    expect(fixMocks.offerCaptureFix).toHaveBeenCalledWith(expect.objectContaining({ reason: "unmarked_selection", options }));
  });

  it("dúvida da leitura sem o que perguntar: recusa com a dúvida no aviso e o post guardado", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromText.mockResolvedValue({
      bet: null, provider: null, incompleteDraft: true, missing: ["ambiguous_bet"],
      review: { reason: "ambiguous_bet", description: "\"Contra o Colo Colo\" não diz o mercado.", evidence: {} },
    });
    expect(await handleChannelPost(post("⚽ Coquimbo Unido vs Colo Colo\nHoje é contra o Colo Colo\n@2.10\n1u", 855)))
      .toEqual({ kind: "unparseable", missing: ["ambiguous_bet"] });
    expect(await refusalOf(855)).toEqual({ reason: null, asks: null });
    const listed = await listDiscardedChannelPosts([String(CHANNEL_ID)], new Date(Date.now() - 86_400_000), 5);
    expect(listed.get(String(CHANNEL_ID))?.recent[0]).toMatchObject({ messageId: 855, reason: "captura_recusada" });
    expect(String(alertMocks.sendOperatorNotification.mock.calls[0]?.[0])).toContain("não diz o mercado");
    expect(fixMocks.offerCaptureFix).not.toHaveBeenCalled();
  });

  it.each([
    ["odd sem o ponto", POST_TEXT.replace("ODD: 2.10", "ODD: @185"), 856, "odd_implausivel", "odds"],
    ["handicap ao vivo sem placar", "🔴 AO VIVO\n⚽ Coquimbo Unido vs Colo Colo\nData: 15/06 16:00\nEntrada: Coquimbo Unido -0.5\nODD: 1.90\nStake: 1u", 857, "placar_ao_vivo_ausente", "live_score"],
  ])("%s: recusa com aviso, post guardado e pergunta na DM", async (_caso, text, messageId, reason, asks) => {
    await seedChannelBankroll(db);
    expect((await handleChannelPost(post(text, messageId))).kind).toBe("unparseable");
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await refusalOf(messageId)).toEqual({ reason, asks });
    expect(alertMocks.sendOperatorNotification).toHaveBeenCalled();
    expect(fixMocks.offerCaptureFix).toHaveBeenCalledWith(expect.objectContaining({ reason }));
  });

  it("odd com a mínima ao lado grava a odd, não a mínima", async () => {
    await seedChannelBankroll(db);
    const outcome = await handleChannelPost(post(POST_TEXT.replace("ODD: 2.10", "ODD: 1.85 (mín 1.70)"), 852));
    expect(outcome.kind).toBe("registered");
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();
    expect(toNumber((await db.prisma.bet.findFirstOrThrow()).odds)).toBe(1.85);
  });

  it("banca CAPTION_ODD: legenda @18.5 com print 1,85 é recusa que pergunta a odd, sem gravar 18,5", async () => {
    const bankroll = await seedChannelBankroll(db);
    await db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { capturePolicy: "CAPTION_ODD" } });
    geminiMocks.extractBetFromImage.mockResolvedValue({
      bet: {
        evento: "Crowborough Athletic vs South Park", esporte: "Soccer", competicao: "", pais: "", mercado: "Asian Handicap",
        selecao: "South Park +0.5", odds: 1.85, stake: 1, data: null, casaDeAposta: "Bet365",
      },
      provider: "gemini",
    });
    const outcome = await handleChannelPhotoPost({
      chatId: CHANNEL_ID, messageId: 853, caption: "Big Data Bet\n@18.5 1u", postDate: POST_DATE, mediaFileId: "foto-teste",
    }, photoDeps);
    expect(outcome).toMatchObject({ kind: "unparseable" });
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await refusalOf(853)).toEqual({ reason: "odd_diverge_legenda", asks: "odds" });
  });
});

describe("reentrega reconhecida antes da leitura", () => {
  const source = `telegram-channel:${CHANNEL_ID}`;
  async function seedItem(bankrollId: string, sourceExternalId: string, deletedAt: Date | null = null) {
    return db.prisma.bet.create({ data: {
      bankrollId, source, sourceExternalId, data: POST_DATE, evento: `Item ${sourceExternalId}`, mercado: "Money Line – Match", sportResolvedAt: POST_DATE,
      selecao: "Casa", esporte: "Soccer", odds: 2, stake: 1, casaDeAposta: "Betano", deletedAt,
      captureEvidence: { create: { parser: "gemini", caption: "Lote sintético @2.00 1u cada", parsedJson: {}, expiresAt: new Date(Date.now() + 86_400_000) } },
    } });
  }

  it("item de lote já gravado é duplicata sem chamar a LLM", async () => {
    const bankroll = await seedChannelBankroll(db);
    const first = await seedItem(bankroll.id, "900:1");
    await seedItem(bankroll.id, "900:2");
    const outcome = await handleChannelPost(post("⚽ Lote sintético\nA x B @2.00\nC x D @2.00\n1u cada", 900));
    expect(outcome).toEqual({ kind: "duplicate", betId: first.id });
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();
    // O post 90 não é confundido com o 900.
    await handleChannelPost(post("⚽ Outro lote\nA x B @2.00\nC x D @2.00\n1u cada", 90));
    expect(geminiMocks.extractBetFromText).toHaveBeenCalledTimes(1);
  });

  it("lote todo removido é pulado como aposta removida", async () => {
    const bankroll = await seedChannelBankroll(db);
    await seedItem(bankroll.id, "901:1", new Date());
    await seedItem(bankroll.id, "901:2", new Date());
    expect(await handleChannelPost(post("⚽ Lote sintético\nA x B @2.00\n1u", 901)))
      .toEqual({ kind: "skipped", reason: "aposta_removida" });
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();
  });

  it.each(["902", "902:1"])("origem aposentada com a banca (%s) não relê nem acusa lote incompleto", async (retiredKey) => {
    const bankroll = await seedChannelBankroll(db);
    await db.prisma.retiredBetSource.create({ data: { source, sourceExternalId: retiredKey, retiredBetId: "aposta-excluida" } });
    expect(await handleChannelPost(post("⚽ Lote sintético\nA x B @2.00\nC x D @2.00\n1u cada", 902)))
      .toEqual({ kind: "skipped", reason: "fonte_retirada" });
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();

    // Mesmo se a transação do lote for alcançada, a origem aposentada não vira alerta.
    const channelBankroll = { id: bankroll.id, nome: bankroll.nome, slug: bankroll.slug, capturePolicy: bankroll.capturePolicy, defaultBookmaker: bankroll.defaultBookmaker };
    const bets = [bttsBet(), { ...bttsBet(), evento: "Santos vs Corinthians" }];
    expect(await registerCaptureBatch({ bankroll: channelBankroll, post: { chatId: CHANNEL_ID, messageId: 902, postDate: POST_DATE }, bets, via: "gemini", caption: "1u cada" }))
      .toEqual({ kind: "skipped", reason: "fonte_retirada" });
    expect(alertMocks.sendOperationalAlert).not.toHaveBeenCalled();
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("edição de post de lote já capturado é ignorada sem chamar a LLM", async () => {
    const bankroll = await seedChannelBankroll(db);
    await seedItem(bankroll.id, "903:1");
    await seedItem(bankroll.id, "903:2");
    for (const text of ["Lote sintético @2.00 1u cada\n✅❌", "Lote sintético @2.20 1u cada"]) {
      expect(await handleEditedChannelPost({ ...post(text, 903), editDate: new Date(POST_DATE.getTime() + 60_000) }))
        .toEqual({ kind: "ignored", reason: "post_ja_capturado" });
    }
    expect(geminiMocks.extractBetFromText).not.toHaveBeenCalled();
    expect(alertMocks.sendOperationalAlert).not.toHaveBeenCalled();
  });
});

/*
 * O que cada caminho da captura deixa para o dono e para o painel: o aviso, o
 * leitor e a evidência da aposta gravada, e o que fica guardado (post, motivo,
 * pendência, pergunta na DM) quando o post não vira aposta. A reorganização da
 * captura não pode mudar nenhum destes desfechos sem o teste dizer.
 */

/** A leitura de um modelo, como a cascata a registra em cada aposta lida. */
function modelReading(itemIndex = 0) {
  return {
    version: 1 as const, state: "complete" as const, accuracy: "unreviewed" as const,
    readers: [{
      provider: "gemini" as const, model: "gemini-sintetico", endpoint: "generate" as const, contractVersion: "contrato-sintetico",
      contractHash: "c", sourceHash: "s", responseHash: "r", receivedAt: "2026-06-10T12:00:00.000Z",
    }],
    sourceFields: {}, transformations: [], itemIndex,
  };
}
const MODEL_READER = { kind: "llm", provider: "gemini", model: "gemini-sintetico", endpoint: "generate", contractVersion: "contrato-sintetico" };

/** Campos que toda aposta capturada do canal grava na evidência; cada caminho acrescenta os seus. */
const CHANNEL_PARSED_KEYS = [
  "casaDeAposta", "competicao", "data", "esporte", "evento", "kickoffDateOnly", "liveScoreAway", "liveScoreHome",
  "mercado", "odds", "pais", "selecao", "sportResolution", "stake",
];
const parsedKeys = (...extra: string[]) => [...CHANNEL_PARSED_KEYS, ...extra].sort();

function textJob(messageId: number, text: string) {
  return { kind: "channel_post", chatId: String(CHANNEL_ID), messageId, text, postDate: POST_DATE.toISOString() };
}
function photoJob(messageId: number, caption: string) {
  return { kind: "channel_photo", chatId: String(CHANNEL_ID), messageId, caption, fileId: `foto-${messageId}`, postDate: POST_DATE.toISOString() };
}
const postLink = (messageId: number) => `https://t.me/c/1234567890/${messageId}`;
const notices = () => alertMocks.sendOperatorNotification.mock.calls.map((call) => call[0]);

async function capturedBets() {
  const rows = await db.prisma.bet.findMany({ orderBy: { sourceExternalId: "asc" }, include: { captureEvidence: true } });
  return rows.map((row) => ({
    ...row,
    parsedKeys: Object.keys(row.captureEvidence?.parsedJson ?? {}).sort(),
    onContract: z.strictObject(captureParsedSchema.shape).safeParse(row.captureEvidence?.parsedJson).success,
  }));
}

function parseTelemetry(messageId: number) {
  return db.prisma.auditEvent.findMany({
    where: { action: "telegram.parse", resourceId: String(messageId) }, select: { outcome: true, details: true }, orderBy: { createdAt: "asc" },
  });
}

function archivedPosts() {
  return db.prisma.auditEvent.findMany({ where: { action: "canal_post_descartado" }, select: { resourceId: true, details: true } });
}

describe("o que cada caminho deixa quando o post vira aposta", () => {
  it("texto lido pela regra: 📥 sem dizer quem leu, leitor 'regra' e a evidência do post", async () => {
    await seedChannelBankroll(db);
    expect(await runQueuedJob(textJob(950, POST_TEXT))).toMatchObject({ kind: "registered", sportResolutionStatus: "CONFIRMED" });
    const [bet] = await capturedBets();
    expect(bet).toMatchObject({
      sourceExternalId: "950", selecao: "Coquimbo Unido", casaDeAposta: "Betano", captureReader: { kind: "rule" },
      captureEvidence: { parser: "universal", caption: POST_TEXT, mediaFileId: null },
      parsedKeys: parsedKeys("stakePolicySnapshot"), onContract: true,
    });
    // O aviso mostra a aposta preparada, antes da normalização do registro ("Casa").
    expect(notices()).toEqual([["📥 Nova aposta · Carteira Tips", "Coquimbo Unido vs Colo Colo", "Casa @2.1 · 1u", postLink(950)].join("\n")]);
    expect(await parseTelemetry(950)).toEqual([{ outcome: "registered", details: { via: "universal" } }]);
    expect(queue.jobs.map((job) => job.name)).toEqual(["sharp.enrich"]);
  });

  it("texto lido pela IA: 📥 diz que a IA leu o texto, e o leitor gravado é o modelo", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: { ...bttsBet(), ocrEvidence: modelReading() }, provider: "gemini" });
    expect(await runQueuedJob(textJob(951, "Flamengo x Palmeiras\nAmbas marcam 1.85\n1u"))).toMatchObject({ kind: "registered" });
    const [bet] = await capturedBets();
    expect(bet).toMatchObject({
      mercado: "Both Teams to Score", selecao: "Yes", captureReader: MODEL_READER,
      captureEvidence: { parser: "gemini", mediaFileId: null, parsedJson: { ocrEvidence: {
        registration: { mercado: "Both Teams to Score", selecao: "Yes" },
        transformations: ["registration_mercado_normalization", "registration_selecao_normalization"],
      } } },
      parsedKeys: parsedKeys("ocrEvidence"), onContract: true,
    });
    expect(notices()).toEqual([["📥 Nova aposta · Carteira Tips", "Flamengo vs Palmeiras", "Sim @1.85 · 1u", "🤖 Lida do texto por IA", postLink(951)].join("\n")]);
    expect(await parseTelemetry(951)).toEqual([{ outcome: "registered", details: { via: "gemini" } }]);
  });

  it("foto: 📥 diz que a IA leu a imagem, e a evidência guarda o arquivo lido", async () => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: { ...bttsBet(), ocrEvidence: modelReading() }, provider: "gemini" });
    expect(await runQueuedJob(photoJob(952, "Flamengo x Palmeiras 1u"))).toMatchObject({ kind: "registered" });
    const [bet] = await capturedBets();
    expect(bet).toMatchObject({
      captureReader: MODEL_READER,
      captureEvidence: { parser: "gemini-vision", caption: "Flamengo x Palmeiras 1u", mediaFileId: "foto-952" },
      parsedKeys: parsedKeys("ocrEvidence"), onContract: true,
    });
    expect(notices()).toEqual([["📥 Nova aposta · Carteira Tips", "Flamengo vs Palmeiras", "Sim @1.85 · 1u", "🤖 Lida da imagem por IA", postLink(952)].join("\n")]);
    expect(await parseTelemetry(952)).toEqual([{ outcome: "registered", details: { via: "gemini-vision" } }]);
  });

  it("artilheiro com qualificador ('ou dar assistência') chega com o aviso de mercado não reconhecido", async () => {
    await seedChannelBankroll(db);
    const artilheiro = { ...bttsBet(), mercado: "Marcar a Qualquer Momento ou Dar Assistência", selecao: "Franco Cristaldo" };
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: { ...artilheiro, ocrEvidence: modelReading() }, provider: "gemini" });
    expect(await runQueuedJob(textJob(955, "Flamengo x Palmeiras\nCristaldo marcar ou dar assistência 1.85\n1u")))
      .toMatchObject({ kind: "registered" });
    expect(notices()).toEqual([[
      "📥 Nova aposta · Carteira Tips", "Flamengo vs Palmeiras", "Franco Cristaldo @1.85 · 1u", "🤖 Lida do texto por IA",
      "⚠️ Mercado não reconhecido", postLink(955),
    ].join("\n")]);
  });

  it("lote: um 📥 com a contagem e uma linha por aposta, e cada item com a própria leitura e o próprio id", async () => {
    await seedChannelBankroll(db);
    const bets = [
      { ...bttsBet(), stakeSource: "caption", ocrEvidence: modelReading(0) },
      { ...bttsBet(), evento: "Santos vs Corinthians", stakeSource: "caption", ocrEvidence: modelReading(1) },
    ];
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
    expect(await runQueuedJob(textJob(953, "Ambas marcam nos dois jogos @1.85 1u cada")))
      .toMatchObject({ kind: "registered", betIds: [expect.any(String), expect.any(String)] });
    const rows = await capturedBets();
    expect(rows.map((row) => [row.sourceExternalId, row.evento, row.captureReader, row.captureEvidence?.parser, row.parsedKeys, row.onContract])).toEqual([
      ["953:1", "Flamengo vs Palmeiras", MODEL_READER, "gemini", parsedKeys("ocrEvidence", "stakeSource"), true],
      ["953:2", "Santos vs Corinthians", MODEL_READER, "gemini", parsedKeys("ocrEvidence", "stakeSource"), true],
    ]);
    expect(notices()).toEqual([[
      "📥 2 apostas novas · Carteira Tips", "Capturadas do post 953.",
      "• Flamengo vs Palmeiras — Sim @1.85 · 1u",
      "• Santos vs Corinthians — Sim @1.85 · 1u",
      postLink(953),
    ].join("\n")]);
    expect(await parseTelemetry(953)).toEqual([{ outcome: "registered", details: { via: "gemini" } }]);
    expect(queue.jobs.map((job) => job.name)).toEqual(["sharp.enrich", "sharp.enrich"]);
  });

  it("post avulso com o esporte em conflito: o 📥 avisa e fica marcado, e o resolvedor não repete", async () => {
    await seedChannelBankroll(db);
    alertMocks.sendOperatorNotification.mockResolvedValue(true);
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: bttsBet(), provider: "gemini" });
    const outcome = await runQueuedJob(textJob(956, "🏀 Flamengo x Palmeiras\nAmbas marcam 1.85\n1u"));
    expect(outcome).toMatchObject({ kind: "registered", sportResolutionStatus: "CONFLICT" });
    expect(notices()).toEqual([expect.stringContaining("⚠️ Fontes discordam sobre o esporte")]);
    const [bet] = await capturedBets();
    expect(await avisarConflitoDeEsporte({ betId: bet!.id, status: "conflict", candidate: null, candidates: [], reason: "capture_conflict" }))
      .toBe(false);
    expect(notices()).toHaveLength(1);
  });

  it("lote com o esporte em conflito: o 📥 do lote não fala do esporte, e o resolvedor avisa cada aposta uma vez", async () => {
    await seedChannelBankroll(db);
    alertMocks.sendOperatorNotification.mockResolvedValue(true);
    const bets = [
      { ...bttsBet(), stakeSource: "caption" },
      { ...bttsBet(), evento: "Santos vs Corinthians", stakeSource: "caption" },
    ];
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
    expect(await runQueuedJob(textJob(957, "🏀 Ambas marcam nos dois jogos @1.85 1u cada"))).toMatchObject({ kind: "registered" });
    const rows = await capturedBets();
    expect(rows.map((row) => row.sportResolutionStatus)).toEqual(["CONFLICT", "CONFLICT"]);
    for (const row of rows) {
      const run = { betId: row.id, status: "conflict" as const, candidate: null, candidates: [], reason: "capture_conflict" };
      expect(await avisarConflitoDeEsporte(run)).toBe(true);
      expect(await avisarConflitoDeEsporte(run)).toBe(false);
    }
    expect(notices().slice(1)).toEqual([
      expect.stringContaining("⚠️ Esporte em conflito · Flamengo vs Palmeiras"),
      expect.stringContaining("⚠️ Esporte em conflito · Santos vs Corinthians"),
    ]);
  });

  describe("lote com entrada ao vivo: cada item tem o próprio placar", () => {
    const handicap = (evento: string, selecao: string, odds: number, score?: [number, number], evidence?: string) => ({
      ...bttsBet(), evento, mercado: "Handicap Asiático", selecao, odds, stakeSource: "caption",
      ...(score ? { liveScoreHome: score[0], liveScoreAway: score[1], liveScoreEvidence: evidence } : {}),
    });
    const liveScores = async () => (await capturedBets())
      .map((row) => [row.evento, row.liveScoreHome, row.liveScoreAway]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    it("o placar da legenda não passa para o item pré-jogo", async () => {
      await seedChannelBankroll(db);
      const flamengo = "(1-0) Flamengo vs Palmeiras - Flamengo -0.5 @1.95";
      const bets = [
        handicap("Flamengo vs Palmeiras", "Flamengo -0.5", 1.95, [1, 0], flamengo),
        handicap("Corinthians vs Santos", "Corinthians -0.5", 1.8),
      ];
      geminiMocks.extractBetFromText.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
      const text = ["Entradas de hoje", flamengo, "Corinthians vs Santos - Corinthians -0.5 @1.80", "1u cada"].join("\n");
      expect(await runQueuedJob(textJob(960, text))).toMatchObject({ kind: "registered", betIds: [expect.any(String), expect.any(String)] });
      expect(await liveScores()).toEqual([["Corinthians vs Santos", null, null], ["Flamengo vs Palmeiras", 1, 0]]);
    });

    it("dois placares diferentes no mesmo post gravam cada um no seu item", async () => {
      await seedChannelBankroll(db);
      const flamengo = "(1-0) Flamengo vs Palmeiras - Flamengo -0.5 @1.95";
      const corinthians = "(0-2) Corinthians vs Santos - Corinthians +1.5 @1.80";
      const bets = [
        handicap("Flamengo vs Palmeiras", "Flamengo -0.5", 1.95, [1, 0], flamengo),
        handicap("Corinthians vs Santos", "Corinthians +1.5", 1.8, [0, 2], corinthians),
      ];
      geminiMocks.extractBetFromText.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
      expect(await runQueuedJob(textJob(961, [flamengo, corinthians, "1u cada"].join("\n"))))
        .toMatchObject({ kind: "registered", betIds: [expect.any(String), expect.any(String)] });
      expect(await liveScores()).toEqual([["Corinthians vs Santos", 0, 2], ["Flamengo vs Palmeiras", 1, 0]]);
    });

    it("print com stake no bilhete: o guard de cada item também não lê o placar do outro jogo", async () => {
      await seedChannelBankroll(db);
      const flamengo = "(1-0) Flamengo vs Palmeiras - Flamengo -0.5";
      const bets = [
        { ...handicap("Flamengo vs Palmeiras", "Flamengo -0.5", 1.95, [1, 0], flamengo), stakeSource: "image_units" },
        { ...handicap("Corinthians vs Santos", "Corinthians -0.5", 1.8), stakeSource: "image_units" },
      ];
      geminiMocks.extractBetFromImage.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
      const caption = [flamengo, "Corinthians vs Santos - Corinthians -0.5"].join("\n");
      expect(await handleChannelPhotoPost({ chatId: CHANNEL_ID, messageId: 962, postDate: POST_DATE, mediaFileId: "foto-962", caption }, photoDeps))
        .toMatchObject({ kind: "registered", betIds: [expect.any(String), expect.any(String)] });
      expect(await liveScores()).toEqual([["Corinthians vs Santos", null, null], ["Flamengo vs Palmeiras", 1, 0]]);
    });

    it("placar só na linha do jogo, sem item que o carregue: recusa em vez de gravar o handicap como pré-jogo", async () => {
      await seedChannelBankroll(db);
      const bets = [
        handicap("Flamengo vs Palmeiras", "Flamengo -0.5", 1.95),
        { ...handicap("Flamengo vs Palmeiras", "Over 2.5", 1.8), mercado: "Total – Match" },
      ];
      geminiMocks.extractBetFromText.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
      const text = ["(1-0) Flamengo vs Palmeiras", "Flamengo -0.5 @1.95", "Over 2.5 @1.80", "1u cada"].join("\n");
      expect(await runQueuedJob(textJob(963, text))).toEqual({ kind: "unparseable", missing: ["placarLive"] });
      expect(await capturedBets()).toEqual([]);
    });

    it("0-0 da legenda que o guard descarta no item não recusa o lote: o restante a partir de 0-0 é o jogo inteiro", async () => {
      await seedChannelBankroll(db);
      const bets = [
        handicap("Flamengo vs Palmeiras", "Flamengo -0.5", 1.95, [0, 0]),
        handicap("Corinthians vs Santos", "Corinthians -0.5", 1.8),
      ];
      geminiMocks.extractBetFromText.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
      const text = ["(0-0) Flamengo vs Palmeiras - Flamengo -0.5 @1.95", "Corinthians vs Santos - Corinthians -0.5 @1.80", "1u cada"].join("\n");
      expect(await runQueuedJob(textJob(964, text))).toMatchObject({ kind: "registered", betIds: [expect.any(String), expect.any(String)] });
    });
  });

  it("prop de jogador vai pelo lote mesmo sozinha: 📥 do lote e o contrato da prop", async () => {
    await seedChannelBankroll(db);
    const prop = {
      evento: "Time A vs Time B", esporte: "Soccer", competicao: "", pais: "", mercado: "Player Shots", selecao: "Pedro Over 1.5",
      odds: 1.8, stake: 1, data: new Date("2026-06-15T22:00:00Z"), casaDeAposta: "", stakeSource: "caption",
    };
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: prop, provider: "gemini" });
    expect(await runQueuedJob(textJob(954, "Pedro chutes @1.80 1u"))).toMatchObject({ kind: "registered", betIds: [expect.any(String)] });
    const [bet] = await capturedBets();
    expect(bet).toMatchObject({ sourceExternalId: "954", mercado: "Shots", parsedKeys: parsedKeys("playerProp", "stakeSource"), onContract: true });
    expect(await db.prisma.betPlayerProp.findFirstOrThrow({ select: { terms: true } }))
      .toMatchObject({ terms: { jogador: "pedro", family: "shots_total", direction: "over", lineQuarters: 6 } });
    expect(notices()).toEqual([[
      "📥 1 aposta nova · Carteira Tips", "Capturada do post 954.",
      "• Time A vs Time B — Pedro Over 1.5 @1.8 · 1u",
      postLink(954),
    ].join("\n")]);
  });

  it("prop de jogador sem stake na legenda, banca WHEN_MISSING: a stake e a origem são da banca", async () => {
    const bank = await seedChannelBankroll(db);
    await db.prisma.bankroll.update({ where: { id: bank.id }, data: { stakePolicy: "WHEN_MISSING", defaultStakeUnits: 25 } });
    const bankrollDefault = { version: 1, stakePolicy: "WHEN_MISSING", defaultStakeUnits: 25, originalStake: 0, source: "bankroll_default" };
    const prop = {
      evento: "Time A vs Time B", esporte: "Soccer", competicao: "", pais: "", mercado: "Player Shots", selecao: "Pedro Over 1.5",
      odds: 1.8, stake: 25, data: new Date("2026-06-15T22:00:00Z"), casaDeAposta: "", stakeSource: "unknown", stakePolicySnapshot: bankrollDefault,
    };
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: prop, provider: "gemini" });
    expect(await runQueuedJob(textJob(955, "Time A x Time B\nPedro mais de 1.5 chutes @1.80"))).toMatchObject({ kind: "registered", betIds: [expect.any(String)] });
    const [bet] = await capturedBets();
    expect(Number(bet?.stake)).toBe(25);
    expect(bet?.captureStakeSnapshot).toMatchObject(bankrollDefault);
    expect(bet?.captureEvidence?.parsedJson).toMatchObject({ stakePolicySnapshot: bankrollDefault });
  });

  it("print com duas simples de stakes diferentes e uma stake só na legenda: recusa em vez de gravar as duas com a da legenda", async () => {
    await seedChannelBankroll(db);
    const bets = [
      { ...bttsBet(1), stakeSource: "image_units" },
      { ...bttsBet(2), evento: "Santos vs Corinthians", stakeSource: "image_units" },
    ];
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
    const caption = "Entradas de hoje\nStake: 1u";
    expect(await handleChannelPhotoPost({ chatId: CHANNEL_ID, messageId: 958, postDate: POST_DATE, mediaFileId: "foto-958", caption }, photoDeps))
      .toEqual({ kind: "unparseable", missing: ["stake"] });
    expect(await capturedBets()).toEqual([]);
    expect(await parseTelemetry(958)).toEqual([expect.objectContaining({ outcome: "guard_rejected", details: expect.objectContaining({ reason: "stake_diverge_legenda", items: 2 }) })]);
  });
});

describe("aviso 📥", () => {
  it("aposta não pega (👎 antes da captura): o 📥 diz a marca", async () => {
    vi.stubEnv("TELEGRAM_ALLOWED_CHATS", "123");
    vi.stubEnv("TELEGRAM_TOKEN", "token-sintetico");
    vi.stubEnv("TELEGRAM_WEBHOOK_URL", "https://exemplo.invalid/api/telegram");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "s".repeat(32));
    resetEnvCacheForTests();
    try {
      await seedChannelBankroll(db);
      expect(await handleChannelReaction({ chatId: CHANNEL_ID, actorUserId: "123", messageId: 964, emojis: ["👎"] })).toEqual({ kind: "remembered" });
      expect(await runQueuedJob(textJob(964, POST_TEXT))).toMatchObject({ kind: "registered", notTaken: true });
      expect(notices()).toEqual([[
        "📥 Nova aposta · Carteira Tips", "Coquimbo Unido vs Colo Colo", "Casa @2.1 · 1u",
        "👎 Marcada como não pega, conforme sua reação", postLink(964),
      ].join("\n")]);
    } finally {
      vi.unstubAllEnvs();
      resetEnvCacheForTests();
    }
  });
});

describe("o que fica de um post que não virou aposta, por caminho", () => {
  it.each([
    { caminho: "texto", job: textJob(960, POST_TEXT.replace("ODD: 2.10", "ODD: @185")), via: "universal", evento: "Coquimbo Unido vs Colo Colo" },
    { caminho: "foto", job: photoJob(961, "Flamengo x Palmeiras @185 1u"), via: "gemini-vision", evento: "Flamengo vs Palmeiras" },
  ])("$caminho recusado pelo guard: post guardado com a leitura, pendência, ⛔ e pergunta na DM", async ({ job, via, evento }) => {
    await seedChannelBankroll(db);
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: { ...bttsBet(), odds: 185 }, provider: "gemini" });
    const { messageId } = job;
    const mediaFileId = job.kind === "channel_photo" ? `foto-${messageId}` : null;
    expect(await runQueuedJob(job)).toEqual({ kind: "unparseable", missing: ["odds"] });
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await archivedPosts()).toEqual([{ resourceId: `${CHANNEL_ID}:${messageId}`, details: expect.objectContaining({
      messageId, reason: "captura_recusada", kind: mediaFileId ? "photo" : "text", ...(mediaFileId ? { mediaFileId } : {}),
      refusal: expect.objectContaining({ reason: "odd_implausivel", via, bet: expect.objectContaining({ evento, odds: 185 }) }),
    }) }]);
    expect(await parseTelemetry(messageId)).toEqual([{ outcome: "guard_rejected", details: {
      via, reason: "odd_implausivel", missing: ["odds"], failureClass: "guard_rejected", retryable: false,
    } }]);
    expect(await db.prisma.operationalAction.findMany({ where: { actionType: "capture_review" }, select: { resourceId: true, evidence: true } }))
      .toEqual([{ resourceId: `${CHANNEL_ID}:${messageId}`, evidence: expect.objectContaining({ reason: "odd_implausivel", mediaFileId, extraction: expect.objectContaining({ via, evento }) }) }]);
    expect(notices()).toEqual([[
      "⛔ Aposta não registrada · Carteira Tips", evento, "Motivo: odd alta demais para o mercado.",
      `👉 Confira o post ${messageId} no canal e registre à mão se for o caso.`, postLink(messageId),
    ].join("\n")]);
    expect(fixMocks.offerCaptureFix.mock.calls).toEqual([[expect.objectContaining({
      reason: "odd_implausivel", via, post: expect.objectContaining({ messageId }), ...(mediaFileId ? { mediaFileId } : {}),
    })]]);
  });

  it("lote recusado no guard de um item: nenhuma entra, o ⛔ diz quantas eram e o post fica guardado sem conserto", async () => {
    await seedChannelBankroll(db);
    const bets = [{ ...bttsBet(), stakeSource: "caption" }, { ...bttsBet(), evento: "Santos vs Corinthians", odds: 185, stakeSource: "caption" }];
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: bets[0], bets, provider: "gemini" });
    expect(await runQueuedJob(textJob(962, "Ambas marcam nos dois jogos @1.85 1u cada"))).toEqual({ kind: "unparseable", missing: ["odds"] });
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await parseTelemetry(962)).toEqual([{ outcome: "guard_rejected", details: {
      via: "gemini", reason: "odd_implausivel", missing: ["odds"], items: 2, failureClass: "guard_rejected", retryable: false,
    } }]);
    expect(await db.prisma.operationalAction.findMany({ where: { actionType: "capture_review" }, select: { resourceId: true, description: true, evidence: true } }))
      .toEqual([{
        resourceId: `${CHANNEL_ID}:962`, description: expect.stringMatching(/^Post com 2 apostas, nenhuma registrada: odd alta demais/),
        evidence: expect.objectContaining({ reason: "odd_implausivel", extraction: expect.objectContaining({ via: "gemini", evento: "Santos vs Corinthians" }) }),
      }]);
    expect(notices()).toEqual([[
      "⛔ Apostas não registradas · Carteira Tips", "Post com 2 apostas: nenhuma foi registrada.",
      "Santos vs Corinthians", "Motivo: odd alta demais para o mercado.",
      "• Flamengo vs Palmeiras — Sim @1.85 · 1u", "• Santos vs Corinthians — Sim @185 · 1u",
      "👉 Confira o post 962 no canal e registre à mão as 2 apostas se for o caso.", postLink(962),
    ].join("\n")]);
    // Sem a leitura: o conserto pela DM grava uma aposta só, e as outras do lote se perderiam.
    const archived = await archivedPosts();
    expect(archived).toEqual([{ resourceId: `${CHANNEL_ID}:962`, details: expect.objectContaining({ reason: "captura_recusada", kind: "text" }) }]);
    expect(archived[0]?.details).not.toHaveProperty("refusal");
    expect(fixMocks.offerCaptureFix).not.toHaveBeenCalled();
  });

  it("prop de jogador sozinha recusada pela stake: post guardado com a leitura e pergunta na DM, como a aposta avulsa", async () => {
    await seedChannelBankroll(db);
    const prop = {
      evento: "Time A vs Time B", esporte: "Soccer", competicao: "", pais: "", mercado: "Player Shots", selecao: "Pedro Over 1.5",
      odds: 1.8, stake: 50, data: new Date("2026-06-15T22:00:00Z"), casaDeAposta: "", stakeSource: "caption",
    };
    geminiMocks.extractBetFromText.mockResolvedValue({ bet: prop, provider: "gemini" });
    expect(await runQueuedJob(textJob(968, "Pedro chutes @1.80 50u"))).toEqual({ kind: "unparseable", missing: ["stake"] });
    expect(await db.prisma.bet.count()).toBe(0);
    const propRead = expect.objectContaining({ evento: "Time A vs Time B", stake: 50, playerProp: expect.objectContaining({ jogador: "pedro" }) });
    expect(await archivedPosts()).toEqual([{ resourceId: `${CHANNEL_ID}:968`, details: expect.objectContaining({
      reason: "captura_recusada", kind: "text", refusal: expect.objectContaining({ reason: "stake_implausivel", via: "gemini", bet: propRead }),
    }) }]);
    expect(notices()).toEqual([[
      "⛔ Aposta não registrada · Carteira Tips", "Time A vs Time B", "Motivo: stake lida do post acima de 20u.",
      "👉 Confira o post 968 no canal e registre à mão se for o caso.", postLink(968),
    ].join("\n")]);
    expect(fixMocks.offerCaptureFix.mock.calls).toEqual([[expect.objectContaining({
      reason: "stake_implausivel", via: "gemini", post: expect.objectContaining({ messageId: 968 }), bet: propRead,
    })]]);
  });

  it("foto de recapitulação: telemetria e post guardado para o \"Capturar mesmo assim\"", async () => {
    await seedChannelBankroll(db);
    expect(await runQueuedJob(photoJob(963, `${POST_TEXT}\n✅ GREEN`))).toEqual({ kind: "skipped", reason: "resultado_ou_balanco" });
    expect(geminiMocks.extractBetFromImage).not.toHaveBeenCalled();
    expect(await parseTelemetry(963)).toEqual([{ outcome: "unparseable", details: {
      via: "foto", reason: "not_bet", missing: ["resultado_ou_balanco"], failureClass: "not_a_bet", retryable: false,
    } }]);
    expect(await archivedPosts()).toMatchObject([{ details: { messageId: 963, kind: "photo", reason: "resultado_ou_balanco" } }]);
    expect(notices()).toEqual([]);
  });

  it("jogo já encerrado: o texto fica guardado; a foto não, e nenhum dos dois vai à telemetria", async () => {
    await seedChannelBankroll(db);
    // POST_DATE é 10/06 09:00 em São Paulo; o jogo foi no dia 9.
    expect(await runQueuedJob(textJob(964, POST_TEXT.replace("Data: 15/06 16:00", "Data: 09/06 16:00"))))
      .toEqual({ kind: "skipped", reason: "jogo_ja_terminado" });
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: { ...bttsBet(), data: new Date("2026-06-09T19:00:00Z") }, provider: "gemini" });
    expect(await runQueuedJob(photoJob(965, "Flamengo x Palmeiras 1u"))).toEqual({ kind: "skipped", reason: "jogo_ja_terminado" });
    expect(await archivedPosts()).toEqual([
      { resourceId: `${CHANNEL_ID}:964`, details: expect.objectContaining({ reason: "jogo_ja_terminado", kind: "text" }) },
    ]);
    expect(await db.prisma.auditEvent.count({ where: { action: "telegram.parse" } })).toBe(0);
    expect(notices()).toEqual([]);
  });

  it("foto que a IA não viu como aposta: guardada com o arquivo, e ❔ ao operador", async () => {
    await seedChannelBankroll(db);
    expect(await runQueuedJob(photoJob(966, "olha isso"))).toEqual({ kind: "unparseable", missing: ["imagem"] });
    expect(await archivedPosts()).toEqual([{ resourceId: `${CHANNEL_ID}:966`, details: expect.objectContaining({
      reason: "ia_nao_viu_aposta", kind: "photo", mediaFileId: "foto-966", lines: ["olha isso"],
    }) }]);
    expect(await parseTelemetry(966)).toEqual([{ outcome: "unparseable", details: {
      via: "foto", reason: "not_bet", missing: ["imagem"], failureClass: "not_a_bet", retryable: false,
    } }]);
    expect(notices()).toEqual([[
      "❔ Foto não virou aposta · Carteira Tips", "Post 966: a IA entendeu que a imagem não é uma aposta.",
      "👉 Se era aposta, use \"Capturar mesmo assim\" em Monitoramento › Canais ou registre à mão.", postLink(966),
    ].join("\n")]);
    expect(fixMocks.offerCaptureFix).not.toHaveBeenCalled();
  });
});

describe("álbum: a aposta e o que fica guardado são da foto vencedora", () => {
  async function stage(mediaGroupId: string, messageId: number, fileId: string, caption: string) {
    await stageMediaAlbumPhoto({ mediaGroupId, chatId: String(CHANNEL_ID), photo: { messageId, fileId, caption }, postDate: POST_DATE });
  }
  /** O flush depois das esperas pela legenda, como o consumidor de `telegram.deferred` o roda. */
  function flush(mediaGroupId: string) {
    return processTelegramDeferredJob(
      { kind: "media_album_flush", chatId: String(CHANNEL_ID), mediaGroupId },
      { api: {} as Api, token: "token", retryCount: MEDIA_ALBUM_FLUSH_MAX_DEFERRALS },
    );
  }
  const financialSources = () => db.prisma.captureFinancialContext.findMany({ select: { sourceExternalId: true } });

  it("lida pela foto da legenda, com a configuração financeira presa ao álbum", async () => {
    await seedChannelBankroll(db);
    await stage("album-lido", 970, "f970", "");
    await stage("album-lido", 971, "f971", "Flamengo x Palmeiras\nAmbas marcam 1u");
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: { ...bttsBet(), ocrEvidence: modelReading() }, provider: "gemini" });
    expect(await flush("album-lido")).toMatchObject({ kind: "registered" });
    const [bet] = await capturedBets();
    expect(bet).toMatchObject({
      sourceExternalId: "971", captureReader: MODEL_READER,
      captureEvidence: { parser: "gemini-vision", mediaFileId: "f971" }, parsedKeys: parsedKeys("ocrEvidence"), onContract: true,
    });
    expect(await financialSources()).toEqual([{ sourceExternalId: "album:album-lido" }]);
    expect(notices()).toEqual([["📥 Nova aposta · Carteira Tips", "Flamengo vs Palmeiras", "Sim @1.85 · 1u", "🤖 Lida da imagem por IA", postLink(971)].join("\n")]);
  });

  it("o retry do álbum já gravado devolve a aposta como reentrega, para a fila que faltou ser refeita", async () => {
    await seedChannelBankroll(db);
    await stage("album-retry", 976, "f976", "");
    await stage("album-retry", 977, "f977", "Flamengo x Palmeiras\nAmbas marcam 1u");
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: bttsBet(), provider: "gemini" });
    const first = await flush("album-retry");
    expect(first).toMatchObject({ kind: "registered" });
    // O enfileiramento depois do flush falhou: o retry nativo encontra o álbum já fechado.
    expect(await flush("album-retry")).toEqual({ kind: "duplicate", betId: first && "betId" in first ? first.betId : "" });
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("o retry de um álbum que não virou aposta continua sem efeito", async () => {
    await seedChannelBankroll(db);
    await stage("album-sem-aposta", 978, "f978", "Flamengo x Palmeiras @185 1u");
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: { ...bttsBet(), odds: 185 }, provider: "gemini" });
    expect(await flush("album-sem-aposta")).toMatchObject({ kind: "unparseable" });
    expect(await flush("album-sem-aposta")).toBeUndefined();
  });

  it("recusado: o post guardado e a pergunta na DM levam a foto vencedora", async () => {
    await seedChannelBankroll(db);
    await stage("album-recusado", 972, "f972", "");
    await stage("album-recusado", 973, "f973", "Flamengo x Palmeiras @185 1u");
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: { ...bttsBet(), odds: 185 }, provider: "gemini" });
    expect(await flush("album-recusado")).toEqual({ kind: "unparseable", missing: ["odds"] });
    expect(await archivedPosts()).toEqual([{ resourceId: `${CHANNEL_ID}:973`, details: expect.objectContaining({
      reason: "captura_recusada", kind: "photo", mediaFileId: "f973",
      refusal: expect.objectContaining({ reason: "odd_implausivel", via: "gemini-vision" }),
    }) }]);
    expect(fixMocks.offerCaptureFix.mock.calls).toEqual([[expect.objectContaining({ reason: "odd_implausivel", mediaFileId: "f973" })]]);
  });

  it("sem imagem legível, a legenda do álbum é lida como post de texto", async () => {
    await seedChannelBankroll(db);
    await stage("album-video", 974, "", POST_TEXT);
    expect(await flush("album-video")).toMatchObject({ kind: "registered" });
    const [bet] = await capturedBets();
    expect(bet).toMatchObject({ sourceExternalId: "974", captureReader: { kind: "rule" }, captureEvidence: { parser: "universal", mediaFileId: null } });
    expect(await financialSources()).toEqual([{ sourceExternalId: "album:album-video" }]);
    expect(geminiMocks.extractBetFromImage).not.toHaveBeenCalled();
  });

  it("provedor fora durante a leitura: relança, e o álbum continua aberto para o retry", async () => {
    await seedChannelBankroll(db);
    await stage("album-fora", 975, "f975", "Flamengo x Palmeiras 1u");
    geminiMocks.extractBetFromImage.mockResolvedValue({ bet: null, provider: null });
    await expect(flush("album-fora")).rejects.toBeInstanceOf(TelegramParseRetryError);
    expect(await db.prisma.telegramMediaAlbum.findUniqueOrThrow({ where: { mediaGroupId: "album-fora" }, select: { status: true } }))
      .toEqual({ status: "open" });
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await archivedPosts()).toEqual([]);
  });
});


describe("bilhetes promocionais sem regras financeiras", () => {
  it.each(["Aposta grátis", "Reembolsada se perder"])("recusa e mantém o histórico da fonte: %s", async (terms) => {
    await seedChannelBankroll(db);
    const outcome = await handleChannelPost(post(`${POST_TEXT}\n${terms}`, 901));
    expect(outcome.kind).toBe("unparseable");
    expect(await db.prisma.bet.count()).toBe(0);
    expect(await db.prisma.movimentacao.count()).toBe(0);
    const event = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "telegram.parse", resourceId: "901" } });
    expect(event).toMatchObject({ outcome: "guard_rejected", details: expect.objectContaining({ reason: "unsupported_promotion_terms" }) });
    expect(await db.prisma.operationalAction.findFirst({ where: { actionType: "capture_review", resourceId: `${CHANNEL_ID}:901` } })).not.toBeNull();
  });
});


it("recusa freebet lida na imagem e explica a limitação na pendência", async () => {
  await seedChannelBankroll(db);
  geminiMocks.extractBetFromImage.mockResolvedValue({ bet: null, provider: null, incompleteDraft: true,
    missing: ["unsupported_promotion_terms"], review: { reason: "unsupported_promotion_terms", description: "Freebet utilizada: 1u", evidence: {} } });
  const outcome = await handleChannelPhotoPost({ chatId: CHANNEL_ID, messageId: 902, caption: "1u", postDate: POST_DATE, mediaFileId: "freebet-slip" }, photoDeps);
  expect(outcome).toEqual({ kind: "unparseable", missing: ["unsupported_promotion_terms"] });
  const action = await db.prisma.operationalAction.findFirstOrThrow({ where: { actionType: "capture_review", resourceId: `${CHANNEL_ID}:902` } });
  expect(action.description).toContain("Freebet utilizada: 1u");
  expect(action.description).toContain("não podem ser registrados");
  expect(await db.prisma.bet.count()).toBe(0);
  expect((await listDiscardedChannelPosts([String(CHANNEL_ID)], new Date(0), 5)).get(String(CHANNEL_ID))?.recent)
    .toContainEqual(expect.objectContaining({ messageId: 902 }));
});

it("lay no post não cria aposta a favor e deixa recusa rastreável", async () => {
  await seedChannelBankroll(db);
  const outcome = await handleChannelPost(post(`${POST_TEXT}\nLay Flamengo`, 903));
  expect(outcome.kind).toBe("unparseable");
  expect(await db.prisma.bet.count()).toBe(0);
  expect(await db.prisma.movimentacao.count()).toBe(0);
  const event = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "telegram.parse", resourceId: "903" } });
  expect(event).toMatchObject({ outcome: "guard_rejected", details: expect.objectContaining({ reason: "unsupported_trading_terms" }) });
  expect(await db.prisma.operationalAction.findFirst({ where: { actionType: "capture_review", resourceId: `${CHANNEL_ID}:903` } })).not.toBeNull();
});
it("lay lido na imagem mantém evidência e explica a limitação", async () => {
  await seedChannelBankroll(db);
  geminiMocks.extractBetFromImage.mockResolvedValue({ bet: null, provider: null, incompleteDraft: true,
    missing: ["unsupported_trading_terms"], review: { reason: "unsupported_trading_terms", description: "Lay Alpha: responsabilidade 3u", evidence: {} } });
  expect(await handleChannelPhotoPost({ chatId: CHANNEL_ID, messageId: 904, caption: "1u", postDate: POST_DATE, mediaFileId: "lay-slip" }, photoDeps))
    .toEqual({ kind: "unparseable", missing: ["unsupported_trading_terms"] });
  const action = await db.prisma.operationalAction.findFirstOrThrow({ where: { actionType: "capture_review", resourceId: `${CHANNEL_ID}:904` } });
  expect(action.description).toContain("Lay Alpha: responsabilidade 3u");
  expect(action.description).toContain("não registre esta operação");
  expect(await db.prisma.bet.count()).toBe(0);
});
