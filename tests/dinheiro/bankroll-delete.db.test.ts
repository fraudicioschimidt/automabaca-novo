import { randomUUID } from "node:crypto";
import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toNumber } from "@/src/domain/money";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteLogoFiles, logoOwnerKey, prepareLogoImage, writeLogoFile } from "@/src/services/logos/storage";
import { criarBankroll, CHANNEL_BANKROLL_DEFAULTS, excluirBankroll } from "@/src/services/bankrolls/manage";
import { tryDispatchBankrollLogoCleanupAudit } from "@/src/services/bankrolls/logo-cleanup";
import { registerBet } from "@/src/services/bets/register";
import { applyManualBetStatusChange as applyBetStatusChange } from "../helpers/settle";
import { criarConta, registrarMovimentacaoManual } from "@/src/services/contas/manage";
import { recordCaptureReview } from "@/src/services/capture/capture-review";
import { recordDiscardedChannelPost } from "@/src/services/capture/channel/channel-post-archive";
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

describe("excluirBankroll — exclusão definitiva com ledger real", () => {
  it("remove dependências sem FK e preserva as de outro tipster e a prévia comum da DM", async () => {
    const banks = await Promise.all(["apagado", "mantido"].map((slug, index) => db.prisma.bankroll.create({
      data: { nome: slug, slug, telegramChannelId: BigInt(-1001234567800 - index) },
    })));
    const betIds: string[] = [];
    for (const [index, bank] of banks.entries()) {
      const bet = await db.prisma.bet.create({ data: { bankrollId: bank.id, data: new Date("2026-10-10T18:00:00Z"),
        evento: "Casa vs Fora", esporte: "Soccer", sportResolvedAt: new Date(), mercado: "Total", selecao: "Over 2.5", odds: 2, stake: 1 } });
      betIds.push(bet.id);
      await db.prisma.teamTipsterNameWait.create({ data: { betId: bet.id, pinnacleEventId: `evento-${index}`,
        tipsterHome: "Casa", tipsterAway: "Fora", pinnacleHome: "Home", pinnacleAway: "Away", kickoff: bet.data } });
      await db.prisma.telegramDmDraft.create({ data: { chatId: "123", messageId: index + 1, parsedBet: {}, caption: "Post recusado",
        postDate: new Date(), expiresAt: bet.data, captureFix: { bankrollId: bank.id, sourceKey: `${bank.telegramChannelId}:42` } } });
      await db.prisma.telegramMediaAlbum.create({ data: { mediaGroupId: `album-${index}`, chatId: String(bank.telegramChannelId),
        winnerMessageId: 42, winnerFileId: "foto", winnerCaption: "Casa vs Fora", messageIds: [42], postDate: new Date(), expiresAt: bet.data } });
    }
    await db.prisma.telegramDmDraft.create({ data: { chatId: "123", messageId: 3, parsedBet: {}, caption: "Prévia sem tipster escolhido",
      postDate: new Date(), expiresAt: new Date("2026-10-10T18:00:00Z") } });
    await excluirBankroll(banks[0]!.id, "test");
    expect.soft((await db.prisma.teamTipsterNameWait.findMany()).map((row) => row.betId)).toEqual([betIds[1]]);
    expect.soft((await db.prisma.telegramDmDraft.findMany({ orderBy: { messageId: "asc" } })).map((row) => row.messageId)).toEqual([2, 3]);
    expect.soft((await db.prisma.telegramMediaAlbum.findMany()).map((row) => row.mediaGroupId)).toEqual(["album-1"]);
  });

  it.each(["recibo", "auditoria"])("aposenta também a origem absorvida com %s ao excluir o tipster", async (proof) => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Excluído", slug: "excluido" } });
    const input = { bankrollId: bank.id, data: new Date("2026-10-10T18:00:00Z"), evento: "Flamengo vs Palmeiras",
      esporte: "Soccer", mercado: "Moneyline", selecao: "Flamengo", odds: 2, stake: 1,
      source: "telegram-channel:-100123", sourceExternalId: "42", actor: "test" };
    const original = await registerBet(input, { client: db.prisma });
    const repeated = { ...input, source: "telegram-dm:123", sourceExternalId: "43" };
    expect(await registerBet(repeated, { client: db.prisma })).toMatchObject({ created: false, betId: original.betId });
    if (proof === "auditoria") await db.prisma.absorbedBetSource.deleteMany();
    await excluirBankroll(bank.id, "test");
    expect(await db.prisma.absorbedBetSource.count()).toBe(0);
    expect(await db.prisma.retiredBetSource.findUnique({ where: { source_sourceExternalId: {
      source: repeated.source, sourceExternalId: repeated.sourceExternalId,
    } } })).toMatchObject({ retiredBetId: original.betId });
    const replacement = await db.prisma.bankroll.create({ data: { nome: "Novo", slug: "novo" } });
    expect(await registerBet({ ...repeated, bankrollId: replacement.id }, { client: db.prisma }))
      .toMatchObject({ created: false, duplicateWasDeleted: true, betId: original.betId });
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("reenvio da criação de tipster sem canal retorna o mesmo tipster", async () => {
    const input = { ...CHANNEL_BANKROLL_DEFAULTS, nome: "Reenvio" };
    const request = { requestId: randomUUID() };
    const results = await Promise.all(Array.from({ length: 4 }, () => criarBankroll(input, "test", request)));
    const first = results[0]!;
    expect(results.every((result) => result.id === first.id)).toBe(true);
    expect(await criarBankroll(input, "test", request)).toEqual(first);
    await expect(criarBankroll({ ...input, nome: "Outro nome" }, "test", request)).rejects.toThrow(/outros dados/);
    expect(await db.prisma.bankroll.count()).toBe(1);
    const next = await criarBankroll(input, "test", { requestId: randomUUID() });
    expect(next.id).not.toBe(first.id);
    await excluirBankroll(first.id, "test");
    await expect(criarBankroll(input, "test", request)).rejects.toThrow(/tipster foi excluído/);
    expect(await db.prisma.bankroll.count()).toBe(1);
    expect(await db.prisma.creationReceipt.count()).toBe(2);
  });

  it("limpeza antiga preserva a logo de outro tipster que reutilizou o slug", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "automabaca-logo-reuse-"));
    vi.stubEnv("LOGOS_DIR", folder);
    try {
      const old = await criarBankroll({ ...CHANNEL_BANKROLL_DEFAULTS, nome: "Reused logo" }, "test");
      const removed = await excluirBankroll(old.id, "test");
      expect(await tryDispatchBankrollLogoCleanupAudit(removed!.auditId, { deleteLogo: async () => { throw new Error("filesystem indisponível"); } })).toBe(false);
      const next = await criarBankroll({ ...CHANNEL_BANKROLL_DEFAULTS, nome: "Reused logo" }, "test");
      expect(next.slug).toBe(old.slug);
      expect(next.id).not.toBe(old.id);
      const image = await prepareLogoImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
      await writeLogoFile(next.slug, image.ext, image.image, next.id);
      const file = path.join(folder, `${logoOwnerKey(next.slug, next.id)}.${image.ext}`);
      expect(await readFile(file)).toEqual(image.image);
      expect(await tryDispatchBankrollLogoCleanupAudit(removed!.auditId)).toBe(true);
      expect(await readFile(file)).toEqual(image.image);
      await expect(writeLogoFile(next.slug, image.ext, image.image, old.id)).rejects.toThrow("tipster mudou");
      expect(await readFile(file)).toEqual(image.image);
      expect(await db.prisma.bankroll.findUnique({ where: { id: next.id } })).not.toBeNull();
    } finally { vi.unstubAllEnvs(); safeRemoveTreeSync(tmpdir(), folder); }
  });


  it("upload de um novo dono espera a limpeza que já começou no mesmo slug", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "automabaca-logo-race-"));
    vi.stubEnv("LOGOS_DIR", folder);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let cleanup: Promise<boolean> | undefined;
    let upload: Promise<void> | undefined;
    try {
      const old = await criarBankroll({ ...CHANNEL_BANKROLL_DEFAULTS, nome: "Concurrent logo" }, "test");
      const removed = await excluirBankroll(old.id, "test");
      cleanup = tryDispatchBankrollLogoCleanupAudit(removed!.auditId, { deleteLogo: async (slug) => {
        if (slug === old.slug) { entered(); await gate; }
        await deleteLogoFiles(slug);
      } });
      await started;
      const next = await criarBankroll({ ...CHANNEL_BANKROLL_DEFAULTS, nome: "Concurrent logo" }, "test");
      expect(next.slug).toBe(old.slug);
      const image = await prepareLogoImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
      upload = writeLogoFile(next.slug, image.ext, image.image, next.id);
      const [lock] = await db.prisma.$queryRaw<Array<{ free: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`logo:${next.slug}`}, 0)) AS free`;
      expect(lock!.free).toBe(false);
      release();
      expect(await cleanup).toBe(true);
      await upload;
      expect(await readFile(path.join(folder, `${logoOwnerKey(next.slug, next.id)}.${image.ext}`))).toEqual(image.image);
    } finally {
      release(); await cleanup; await upload;
      vi.unstubAllEnvs(); safeRemoveTreeSync(tmpdir(), folder);
    }
  });

  it("apaga banca e apostas, remove seus lançamentos e recompõe a conta compartilhada", async () => {
    const [alvo, sobrevivente] = await Promise.all([
      db.prisma.bankroll.create({
        data: { nome: "Excluir", slug: "excluir", valorUnidade: 100, sharpMode: "OFF" },
      }),
      db.prisma.bankroll.create({
        data: { nome: "Manter", slug: "manter", valorUnidade: 100, sharpMode: "OFF" },
      }),
    ]);
    const { contaId } = await criarConta({
      casaDeAposta: "Bet365",
      titular: "Fabricio",
      saldoInicial: 1_000,
      bankrollIds: [alvo.id, sobrevivente.id],
      actor: "test",
    }, { client: db.prisma });
    const criarAposta = (bankrollId: string, externalId: string) => db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId,
        contaId,
        data: new Date("2026-08-20T18:00:00Z"),
        evento: `${externalId} A vs B`,
        esporte: "Soccer",
        casaDeAposta: "Bet365",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        valorUnidade: 100,
        source: "test-bankroll-delete",
        sourceExternalId: externalId,
      },
    });
    const [apostaAlvo, apostaMantida] = await Promise.all([
      criarAposta(alvo.id, "alvo"),
      criarAposta(sobrevivente.id, "sobrevivente"),
    ]);

    await applyBetStatusChange(
      { betId: apostaAlvo.id, newStatus: "WON", source: "manual" },
      { client: db.prisma },
    );
    await applyBetStatusChange(
      { betId: apostaMantida.id, newStatus: "LOST", source: "manual" },
      { client: db.prisma },
    );
    await registrarMovimentacaoManual({
      contaId,
      tipo: "BONUS",
      valor: 25,
      clientMutationId: "bankroll-delete-bonus",
      actor: "test",
    }, { client: db.prisma });

    const instantes = [
      [new Date("2026-08-20T18:01:00Z"), { contaId, tipo: "DEPOSITO" as const }],
      [new Date("2026-08-20T18:02:00Z"), { betId: apostaAlvo.id }],
      [new Date("2026-08-20T18:03:00Z"), { betId: apostaMantida.id }],
      [new Date("2026-08-20T18:04:00Z"), { clientMutationId: "bankroll-delete-bonus" }],
    ] as const;
    for (const [createdAt, where] of instantes) {
      await db.prisma.movimentacao.updateMany({ where, data: { createdAt, data: createdAt } });
    }

    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual))
      .toBe(1_025);
    await expect(excluirBankroll(alvo.id, "test")).resolves.toMatchObject({
      slug: "excluir",
    });

    expect(await db.prisma.bankroll.findUnique({ where: { id: alvo.id } })).toBeNull();
    expect(await db.prisma.bet.findUnique({ where: { id: apostaAlvo.id } })).toBeNull();
    expect(await db.prisma.bet.findUnique({ where: { id: apostaMantida.id } })).not.toBeNull();
    expect(await db.prisma.contaBankroll.findMany({ where: { contaId } })).toEqual([
      expect.objectContaining({ bankrollId: sobrevivente.id }),
    ]);

    const conta = await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } });
    expect(toNumber(conta.saldoAtual)).toBe(925);
    const ledger = await db.prisma.movimentacao.findMany({
      where: { contaId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { betId: true, valor: true, saldoApos: true },
    });
    expect(ledger.map((m) => toNumber(m.valor))).toEqual([1_000, -100, 25]);
    expect(ledger.map((m) => toNumber(m.saldoApos))).toEqual([1_000, 900, 925]);
    expect(ledger.some((m) => m.betId === apostaAlvo.id)).toBe(false);

    expect(await db.prisma.auditEvent.findFirst({
      where: { action: "bankroll.delete", resourceId: alvo.id },
      orderBy: { createdAt: "desc" },
      select: { details: true },
    })).toMatchObject({
      details: {
        permanente: true,
        apostasExcluidas: 1,
        contasRecalculadas: 1,
      },
    });
  });

  it("aposenta a origem e remove treino, ações e auditoria detalhada", async () => {
    const alvo = await db.prisma.bankroll.create({
      data: { nome: "Apagar tudo", slug: "apagar-tudo", valorUnidade: 100, sharpMode: "OFF" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: alvo.id,
        data: new Date("2026-08-21T18:00:00Z"),
        evento: "Origem A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        source: "telegram-channel:-1001234567890",
        sourceExternalId: "42",
      },
    });
    const training = await db.prisma.trainingCase.create({
      data: {
        betId: bet.id,
        evento: bet.evento,
        esporte: bet.esporte,
        status: "OPEN",
      },
    });
    const action = await db.prisma.operationalAction.create({
      data: {
        fingerprint: `bankroll-delete-test:${bet.id}`,
        area: "matching",
        actionType: "training.resolve",
        title: "Resolver aposta excluída",
        description: bet.evento,
        resource: "training-case",
        resourceId: training.id,
      },
    });
    await db.prisma.auditEvent.createMany({
      data: [
        { action: "bet.create", resource: "bet", resourceId: bet.id, details: { evento: bet.evento } },
        { action: "training.open", resource: "training_case", resourceId: training.id },
        { action: "operational_action.acknowledged", resource: "operational_action", resourceId: action.id },
        { action: "bankroll.update", resource: "bankroll", resourceId: alvo.id },
      ],
    });
    await db.prisma.iaJudgeCooldown.create({
      data: { key: `bet:${bet.id}`, reason: "test", expiresAt: new Date("2026-08-22T00:00:00Z") },
    });

    const deleted = await excluirBankroll(alvo.id, "test");
    expect(deleted).toMatchObject({ slug: "apagar-tudo" });
    expect(await db.prisma.trainingCase.count({ where: { id: training.id } })).toBe(0);
    expect(await db.prisma.operationalAction.count({ where: { id: action.id } })).toBe(0);
    expect(await db.prisma.iaJudgeCooldown.count({ where: { key: `bet:${bet.id}` } })).toBe(0);
    expect(await db.prisma.auditEvent.findMany({
      where: { OR: [
        { resource: "bet", resourceId: bet.id },
        { resource: "training_case", resourceId: training.id },
        { resource: "operational_action", resourceId: action.id },
      ] },
    })).toEqual([]);
    expect(await db.prisma.auditEvent.count({
      where: { resource: "bankroll", resourceId: alvo.id },
    })).toBe(1);
    await expect(db.prisma.retiredBetSource.findUniqueOrThrow({
      where: {
        source_sourceExternalId: {
          source: bet.source,
          sourceExternalId: bet.sourceExternalId!,
        },
      },
    })).resolves.toMatchObject({ retiredBetId: bet.id });

    const replacement = await db.prisma.bankroll.create({
      data: { nome: "Substituta", slug: "substituta", valorUnidade: 100, sharpMode: "OFF" },
    });
    const recaptured = await registerBet({
      bankrollId: replacement.id,
      data: new Date("2026-08-21T18:00:00Z"),
      evento: "Origem A vs B",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "A",
      odds: 2,
      stake: 1,
      source: bet.source,
      sourceExternalId: bet.sourceExternalId!,
      actor: "test",
    }, { client: db.prisma });
    expect(recaptured).toMatchObject({
      created: false,
      betId: bet.id,
      duplicateOfId: bet.id,
      duplicateWasDeleted: true,
    });
    expect(await db.prisma.bet.count({ where: { source: bet.source, sourceExternalId: "42" } }))
      .toBe(0);
  });

  it("remove a evidência diária do ledger só das apostas do tipster excluído", async () => {
    const banks = await db.prisma.bankroll.createManyAndReturn({ data: [
      { nome: "Excluir ledger", slug: "excluir-ledger" }, { nome: "Manter ledger", slug: "manter-ledger" },
    ] });
    const bets = [];
    for (const bank of banks) bets.push(await db.prisma.bet.create({ data: {
      bankrollId: bank.id, data: new Date(), evento: "Casa vs Fora", esporte: "Soccer",
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(),
      mercado: "Moneyline", selecao: "Casa", odds: 2, stake: 1,
    } }));
    await db.prisma.auditEvent.createMany({ data: bets.map((bet) => ({
      action: "bet_ledger_drift", resource: `${bet.id}:conta-sintetica`, resourceId: "2026-10-10", details: { betId: bet.id },
    })) });
    await excluirBankroll(banks[0]!.id, "test");
    expect((await db.prisma.auditEvent.findMany({ where: { action: "bet_ledger_drift" } })).map((row) => row.resource))
      .toEqual([`${bets[1]!.id}:conta-sintetica`]);
  });

  it("apaga as pendências e os posts descartados do canal, e deixa os do canal que foi para outra banca", async () => {
    const canal = -1001234567890n;
    const canalMovido = -1009876543210n;
    const alvo = await db.prisma.bankroll.create({
      data: { nome: "Tipster X", slug: "tipster-x", valorUnidade: 100, sharpMode: "OFF", telegramChannelId: canal },
    });
    // O canal movido já foi da banca apagada e hoje é da outra.
    const viva = await db.prisma.bankroll.create({
      data: { nome: "Viva", slug: "viva", valorUnidade: 100, sharpMode: "OFF", telegramChannelId: canalMovido },
    });
    await db.prisma.auditEvent.create({
      data: {
        action: "bankroll.update", resource: "bankroll", resourceId: alvo.id,
        details: { previousTelegramChannelId: String(canalMovido) },
      },
    });
    await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), bankrollId: alvo.id,
        data: new Date("2026-08-21T18:00:00Z"), evento: "Flamengo vs Palmeiras", esporte: "Soccer",
        mercado: "Moneyline", selecao: "Flamengo", odds: 2, stake: 1,
        source: `telegram-channel:${canal}`, sourceExternalId: "42",
      },
    });
    const review = (reason: string) => ({
      reason, description: "Conferir o bilhete", evidence: { evento: "Flamengo vs Palmeiras", missing: ["odds"] },
    });
    await recordCaptureReview({
      chatId: canal, messageId: 41, caption: "Flamengo over 2.5", bankroll: alvo.nome, review: review("odd_ausente"),
    });
    await recordCaptureReview({
      chatId: canal, messageId: 42, caption: "Flamengo ML", bankroll: alvo.nome, review: review("lote_alterado_precisa_revisao"),
    });
    await recordCaptureReview({
      chatId: canalMovido, messageId: 7, caption: "Grêmio ML", bankroll: viva.nome, review: review("odd_ausente"),
    });
    const discarded = (chatId: bigint, bankrollId: string, messageId: number) => recordDiscardedChannelPost({
      chatId, messageId, bankrollId, text: "Flamengo x Palmeiras amanhã", postDate: new Date("2026-08-21T12:00:00Z"),
      reason: "ia_nao_viu_aposta",
    });
    await discarded(canal, alvo.id, 40);
    await discarded(canalMovido, viva.id, 6);
    await db.prisma.telegramMediaAlbum.createMany({ data: [canal, canalMovido].map((chatId) => ({
      mediaGroupId: String(chatId), chatId: String(chatId), winnerMessageId: 42, winnerFileId: "foto",
      winnerCaption: "Post em álbum", messageIds: [42], postDate: new Date(), expiresAt: new Date("2026-10-10T18:00:00Z"),
    })) });

    await excluirBankroll(alvo.id, "test");

    const actions = await db.prisma.operationalAction.findMany({
      where: { resource: "telegram-channel" },
      select: { resourceId: true, status: true },
    });
    expect(actions).toEqual([{ resourceId: `${canalMovido}:7`, status: "OPEN" }]);
    const archived = await db.prisma.auditEvent.findMany({
      where: { action: "canal_post_descartado" },
      select: { resourceId: true },
    });
    expect(archived).toEqual([{ resourceId: `${canalMovido}:6` }]);
    expect((await db.prisma.telegramMediaAlbum.findMany()).map((album) => album.chatId)).toEqual([String(canalMovido)]);
  });

  it("falha pós-commit da logo mantém outbox pendente sem desfazer nem mentir sobre a exclusão", async () => {
    const alvo = await db.prisma.bankroll.create({
      data: { nome: "Logo falha", slug: "logo-falha", valorUnidade: 100, sharpMode: "OFF" },
    });
    const deleted = await excluirBankroll(alvo.id, "test");
    expect(deleted).not.toBeNull();

    await expect(tryDispatchBankrollLogoCleanupAudit(deleted!.auditId, {
      deleteLogo: async () => {
        throw new Error("filesystem indisponível");
      },
    })).resolves.toBe(false);

    expect(await db.prisma.bankroll.findUnique({ where: { id: alvo.id } })).toBeNull();
    expect(await db.prisma.auditEvent.findUniqueOrThrow({ where: { id: deleted!.auditId } }))
      .toMatchObject({ action: "bankroll.delete", outcome: "pending" });
  });
});
