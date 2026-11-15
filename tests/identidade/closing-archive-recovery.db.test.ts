import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@/src/infra/env";
import { createTestDb, type TestDb } from "../helpers/db";
import { priceEnvelope, ARCHIVE_ENTRY, ARCHIVE_KICKOFF, ARCHIVE_NOW } from "../helpers/price-archive-fixtures";

const config = vi.hoisted(() => ({ enabled: true, mb: 256, days: 30 }));
vi.mock("@/src/infra/env", async (original) => {
  const env = await original<typeof EnvModule>();
  return { ...env, getEnv: () => ({ ...env.getEnv(), PRICE_ARCHIVE_ENABLED: config.enabled,
    PRICE_ARCHIVE_MAX_COMPRESSED_MB: config.mb, PRICE_ARCHIVE_RETENTION_DAYS: config.days }) };
});
vi.mock("@/src/services/ops/alerts", () => ({ sendOperatorNotification: vi.fn(async () => true), sendOperationalAlert: vi.fn(async () => true) }));
import { archivePriceResponse } from "@/src/providers/price-archive/store";
import { closingContextHash, maintainClosingArchive, readClosingBet, recoverArchivedClosing } from "@/src/services/sharp/closing/series";
import { snapshotClosingForBet } from "@/src/services/sharp/closing/pinnacle17-snapshot";
import { invalidateSegmentPolicyCache } from "@/src/services/sharp/segment-policy";
import { editarBankroll, type BankrollEditInput } from "@/src/services/bankrolls/manage";

/**
 * Recuperação do fechamento pelo arquivo de preços, sem HTTP: depois do
 * congelamento (a leitura do mercado mudou), e quando a identidade ou a
 * correção chegam depois do kickoff. Postgres real; só o alerta é simulado.
 */
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { vi.useRealTimers(); await db.dispose(); });
beforeEach(async () => {
  vi.useRealTimers(); await db.reset(); invalidateSegmentPolicyCache();
  config.enabled = true; config.mb = 256; config.days = 30;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(ARCHIVE_ENTRY);
});
async function seed(opts: { registeredAt?: Date; sharp?: boolean; mercado?: string } = {}) {
  const registeredAt = opts.registeredAt ?? ARCHIVE_ENTRY;
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Recuperação", slug: crypto.randomUUID(), valorUnidade: 100,
    sharpMode: "CLV_ONLY", createdAt: ARCHIVE_ENTRY, updatedAt: ARCHIVE_ENTRY } });
  const bet = await db.prisma.bet.create({ data: { bankrollId: bankroll.id, evento: "Alpha vs Beta", esporte: "Soccer",
    competicao: "Synthetic", pais: "World", mercado: opts.mercado ?? "Money Line – Match", selecao: "Alpha", odds: 2.5, stake: 1,
    valorUnidade: 100, data: ARCHIVE_KICKOFF, registradoEm: registeredAt, sourcePostedAt: registeredAt,
    sportResolutionStatus: "CONFIRMED", sportResolvedAt: registeredAt } });
  if (opts.sharp !== false) await matchIdentity(bet.id);
  await db.prisma.betCaptureEvidence.create({ data: { betId: bet.id, parser: "synthetic", caption: "Alpha vs Beta, aposta sintética",
    parsedJson: {}, expiresAt: new Date(ARCHIVE_ENTRY.getTime() + 30 * 86_400_000) } });
  return { bet, bankroll };
}
async function matchIdentity(betId: string, providerMatchId = "123") {
  await db.prisma.betSharp.create({ data: { betId, identityStatus: "MATCHED", provider: "pinnacle17", providerMatchId } });
}
/** Congelado no kickoff sem cotação, com placar já ingerido. */
async function frozenWithoutPrice(betId: string) {
  await db.prisma.betResult.create({ data: { betId, scoreHome: 3, scoreAway: 1, resultProvider: "flashscore",
    resultFinal: true, resultSnapshot: { retained: true } } });
  return db.prisma.betClosing.create({ data: { betId, source: "CRON", fetchedAt: ARCHIVE_KICKOFF, clvReliable: false,
    noOddsReason: "kickoff_sem_captura" } });
}
async function capture(at: Date) {
  const e = priceEnvelope("pinnacle17", at); vi.setSystemTime(new Date(e.observedAt));
  const id = await archivePriceResponse(e); expect(id).not.toBeNull(); return id!;
}
const beforeKickoff = new Date(ARCHIVE_KICKOFF.getTime() - 60_000);

describe("fechamento recuperado do arquivo de preços", () => {
  it("preenche o preço depois do congelamento sem tocar no placar/resultado", async () => {
    const { bet } = await seed(); await frozenWithoutPrice(bet.id);
    await capture(beforeKickoff); vi.setSystemTime(ARCHIVE_NOW);
    expect(await recoverArchivedClosing(bet.id)).toBe(true);
    const row = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(row).toMatchObject({ clvReliable: true, noOddsReason: null, source: "REPROCESS",
      fetchedAt: ARCHIVE_KICKOFF, closingPriceObservedAt: beforeKickoff });
    expect(await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } })).toMatchObject({
      scoreHome: 3, scoreAway: 1, resultProvider: "flashscore", resultFinal: true, resultSnapshot: { retained: true } });
  });
  it("recupera a resposta mais recente arquivada após o congelamento de um CLV já confiável", async () => {
    const { bet } = await seed();
    const previousAt = new Date(ARCHIVE_KICKOFF.getTime() - 300_000);
    await capture(previousAt); vi.setSystemTime(ARCHIVE_KICKOFF);
    await snapshotClosingForBet((await readClosingBet(bet.id))!, ARCHIVE_KICKOFF);
    const before = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(before).toMatchObject({ clvReliable: true, closingPriceObservedAt: previousAt });
    // A resposta chegou antes do apito; o arquivo só terminou de gravá-la após o freeze.
    vi.setSystemTime(ARCHIVE_NOW);
    const latest = priceEnvelope("pinnacle17", beforeKickoff);
    (latest.body as { markets: Array<{ outcomes: Array<{ oddsDecimal: number }> }> }).markets[0]!.outcomes[0]!.oddsDecimal = 1.8;
    await archivePriceResponse(latest);
    expect(await maintainClosingArchive()).toMatchObject({ checked: 1, recovered: 1 });
    const after = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(after).toMatchObject({ clvReliable: true, closingPriceObservedAt: beforeKickoff, fetchedAt: before.fetchedAt });
    expect(Number(after.closingRawOdd)).toBe(1.8);
    expect(Number(after.clv)).not.toBe(Number(before.clv));
    expect(await maintainClosingArchive()).toMatchObject({ checked: 0, recovered: 0 });
  });
  it("troca uma cotação cedo demais por uma do arquivo nos 10 min finais", async () => {
    const { bet } = await seed();
    await capture(new Date(ARCHIVE_KICKOFF.getTime() - 40 * 60_000));
    vi.setSystemTime(ARCHIVE_KICKOFF); await snapshotClosingForBet((await readClosingBet(bet.id))!, ARCHIVE_KICKOFF);
    expect(await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ clvReliable: false, noOddsReason: "closing_quote_too_early" });
    // A resposta dos minutos finais chegou ao arquivo por outra aposta do jogo.
    await capture(beforeKickoff); vi.setSystemTime(ARCHIVE_NOW);
    expect(await maintainClosingArchive()).toMatchObject({ recovered: 1 });
    expect(await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ clvReliable: true, noOddsReason: null, closingPriceObservedAt: beforeKickoff });
  });
  it("troca a cotação cedo que congelou com o motivo do fornecedor", async () => {
    const { bet } = await seed();
    // Congelou com a cotação de 40 min antes e sem a linha nos 10 min finais.
    await db.prisma.betClosing.create({ data: { betId: bet.id, source: "CRON", provider: "pinnacle17", fetchedAt: ARCHIVE_KICKOFF,
      closingOdd: 1.9, closingRawOdd: 2, clv: 31, clvReliable: false, noOddsReason: "market_not_listed",
      closingPriceObservedAt: new Date(ARCHIVE_KICKOFF.getTime() - 40 * 60_000) } });
    // A resposta dos minutos finais chegou ao arquivo por outra aposta do jogo.
    await capture(beforeKickoff); vi.setSystemTime(ARCHIVE_NOW);
    expect(await maintainClosingArchive()).toMatchObject({ recovered: 1 });
    expect(await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ clvReliable: true, noOddsReason: null, closingPriceObservedAt: beforeKickoff });
  });
  it.each(["after-kickoff", "too-old", "before-registration"])("não usa resposta fora da janela: %s", async (kind) => {
    const registeredAt = kind === "before-registration" ? new Date(ARCHIVE_KICKOFF.getTime() - 10 * 60_000) : undefined;
    const { bet } = await seed({ registeredAt }); await frozenWithoutPrice(bet.id);
    await capture(kind === "after-kickoff" ? new Date(ARCHIVE_KICKOFF.getTime() + 1)
      : kind === "too-old" ? new Date(ARCHIVE_KICKOFF.getTime() - 61 * 60_000)
      : new Date(ARCHIVE_KICKOFF.getTime() - 11 * 60_000));
    vi.setSystemTime(ARCHIVE_NOW);
    expect(await recoverArchivedClosing(bet.id)).toBe(false);
  });
  it.each(["removed", "mode", "mode-roundtrip", "live", "identity", "kickoff", "period", "unit", "team-order", "segment"])(
    "mudança incompatível bloqueia a recuperação: %s", async (kind) => {
      const { bet, bankroll } = await seed(); await frozenWithoutPrice(bet.id);
      await capture(beforeKickoff); vi.setSystemTime(ARCHIVE_NOW);
      if (kind === "removed") await db.prisma.bet.update({ where: { id: bet.id }, data: { deletedAt: ARCHIVE_NOW } });
      if (kind === "mode") await db.prisma.bankroll.update({ where: { id: bankroll.id }, data: { sharpMode: "OFF" } });
      if (kind === "mode-roundtrip") {
        // O modo foi a OFF e voltou: a resposta pedida antes da volta não vale.
        await editarBankroll(bankroll.id, { sharpMode: "OFF" });
        await editarBankroll(bankroll.id, { sharpMode: "CLV_ONLY" });
      }
      if (kind === "live") await db.prisma.bet.update({ where: { id: bet.id }, data: { liveScoreHome: 0, liveScoreAway: 0 } });
      if (kind === "identity") await db.prisma.betSharp.update({ where: { betId: bet.id }, data: { providerMatchId: "999" } });
      if (kind === "kickoff") await db.prisma.bet.update({ where: { id: bet.id }, data: { data: new Date(ARCHIVE_KICKOFF.getTime() + 600_000) } });
      if (kind === "period") await db.prisma.bet.update({ where: { id: bet.id }, data: { mercado: "Money Line – 1st Half" } });
      if (kind === "unit") await db.prisma.bet.update({ where: { id: bet.id }, data: { mercado: "Total (Corners) – Match", selecao: "Over 9.5" } });
      if (kind === "team-order") await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: "Beta vs Alpha" } });
      if (kind === "segment") await db.prisma.marketSegmentPolicy.create({ data: { esporte: "Soccer", mercado: "Money Line – Match", phase: "SHARP_OFF" } });
      expect(await recoverArchivedClosing(bet.id)).toBe(false);
      expect((await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } })).closingOdd).toBeNull();
    });
  it.each<[string, BankrollEditInput]>([
    ["nome", { nome: "Outro nome" }],
    ["esportes do canal", { channelSports: ["Soccer"] }],
    ["pausa", { capturePaused: true }],
    ["formulário com o mesmo modo", { nome: "Recuperação", valorUnidade: 100, sharpMode: "CLV_ONLY", capturePolicy: "AUTO" }],
  ])("edição da banca que não muda o modo de medição não bloqueia a recuperação: %s", async (_, patch) => {
    const { bet, bankroll } = await seed(); await frozenWithoutPrice(bet.id);
    await capture(beforeKickoff); vi.setSystemTime(ARCHIVE_NOW);
    const before = await readClosingBet(bet.id);
    await editarBankroll(bankroll.id, patch);
    expect(closingContextHash((await readClosingBet(bet.id))!)).toBe(closingContextHash(before!));
    expect(await maintainClosingArchive()).toMatchObject({ checked: 1, recovered: 1 });
    expect((await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } })).clvReliable).toBe(true);
  });
  it("identidade confirmada só depois do kickoff fecha com a resposta de outra aposta do mesmo jogo", async () => {
    const { bet } = await seed({ sharp: false }); await capture(beforeKickoff);
    vi.setSystemTime(ARCHIVE_NOW); await matchIdentity(bet.id);
    const current = await readClosingBet(bet.id);
    await snapshotClosingForBet(current!, ARCHIVE_NOW);
    expect(await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ clvReliable: true, source: "REPROCESS", closingPriceObservedAt: beforeKickoff, fetchedAt: ARCHIVE_NOW });
    expect(await db.prisma.closingPriceWatch.count()).toBe(0);
  });
  it("manutenção recupera, sem HTTP, o mercado que passou a ser lido depois do congelamento", async () => {
    const { bet } = await seed({ mercado: "Mercado não reconhecido" }); await capture(beforeKickoff);
    vi.setSystemTime(new Date(ARCHIVE_KICKOFF.getTime() + 60_000));
    await snapshotClosingForBet((await readClosingBet(bet.id))!, new Date());
    // A série não mede o mercado que a Pinnacle17 não precifica: falta do fornecedor.
    expect(await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ closingOdd: null, clvReliable: false, noOddsReason: "unsupported_market" });
    await db.prisma.bet.update({ where: { id: bet.id }, data: { mercado: "Money Line – Match" } });
    vi.setSystemTime(ARCHIVE_NOW);
    expect(await maintainClosingArchive()).toMatchObject({ checked: 1, recovered: 1 });
    expect((await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } })).clvReliable).toBe(true);
    expect(await maintainClosingArchive()).toMatchObject({ checked: 0, recovered: 0 });
  });
  it("preserva fechamento manual mesmo quando ainda está sem cotação", async () => {
    const { bet } = await seed(); await capture(beforeKickoff); vi.setSystemTime(ARCHIVE_NOW);
    await db.prisma.betClosing.create({ data: { betId: bet.id, source: "MANUAL", fetchedAt: ARCHIVE_KICKOFF } });
    const before = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(await recoverArchivedClosing(bet.id)).toBe(false);
    expect(await maintainClosingArchive()).toMatchObject({ checked: 0 });
    expect(await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } })).toEqual(before);
  });
  it("falha da auditoria desfaz a escrita da cotação na mesma transação", async () => {
    const { bet } = await seed(); await frozenWithoutPrice(bet.id); await capture(beforeKickoff); vi.setSystemTime(ARCHIVE_NOW);
    await db.prisma.$executeRawUnsafe(`CREATE FUNCTION recovery_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action = 'closing.series.price_applied' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await db.prisma.$executeRawUnsafe(`CREATE TRIGGER recovery_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION recovery_fail_audit()`);
    try {
      await expect(recoverArchivedClosing(bet.id)).rejects.toThrow();
      expect((await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } })).closingOdd).toBeNull();
    } finally {
      await db.prisma.$executeRawUnsafe("DROP TRIGGER recovery_fail_audit ON audit_events");
      await db.prisma.$executeRawUnsafe("DROP FUNCTION recovery_fail_audit()");
    }
  });
  it.each(["edit", "purge", "manual"])("concorrência real recusa prova/estado que mudou durante a recuperação: %s", async (kind) => {
    const { bet } = await seed(); await frozenWithoutPrice(bet.id);
    const observationId = await capture(beforeKickoff); vi.setSystemTime(ARCHIVE_NOW);
    let unlock!: () => void, ready!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const writer = db.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bets WHERE id = ${bet.id} FOR UPDATE`;
      ready(); await gate;
      if (kind === "edit") await tx.bet.update({ where: { id: bet.id }, data: { odds: 3.5 } });
      if (kind === "purge") await tx.priceArchiveObservation.delete({ where: { id: observationId } });
      if (kind === "manual") await tx.betClosing.update({ where: { betId: bet.id }, data: { source: "MANUAL" } });
    }, { timeout: 10_000 });
    await locked; const recovery = recoverArchivedClosing(bet.id);
    try {
      await vi.waitFor(async () => {
        const rows = await db.prisma.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%FROM bets WHERE id =%FOR UPDATE%') AS blocked`;
        expect(rows[0]?.blocked).toBe(true);
      }, { timeout: 3000, interval: 20 });
    } finally { unlock(); }
    await writer; expect(await recovery).toBe(false);
    expect((await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } })).closingOdd).toBeNull();
    expect(await db.prisma.auditEvent.count({ where: { action: "closing.series.price_applied" } })).toBe(0);
  });
});

describe("arquivo de preços no banco", () => {
  it("corpo guardado é imutável", async () => {
    const id = await capture(beforeKickoff);
    await expect(db.prisma.priceArchiveObservation.update({ where: { id }, data: { sha256: "0".repeat(64) } })).rejects.toThrow();
  });
  it("teto de bytes e coleta concorrente eliminam o mais antigo sem exceder limite", async () => {
    config.mb = 1; vi.setSystemTime(ARCHIVE_NOW);
    const a = priceEnvelope(), b = priceEnvelope("pinnacle17", new Date(ARCHIVE_ENTRY.getTime() + 120_000));
    a.body = { data: randomBytes(700_000).toString("base64") }; b.body = { data: randomBytes(700_000).toString("base64") };
    const first = await archivePriceResponse(a); expect(first).not.toBeNull();
    await Promise.all([archivePriceResponse(b), archivePriceResponse(b)]);
    const usage = await db.prisma.priceArchiveUsage.findUniqueOrThrow({ where: { id: 1 } });
    expect(Number(usage.bytes)).toBeLessThanOrEqual(1024 * 1024);
    expect(await db.prisma.priceArchiveObservation.findUnique({ where: { id: first! } })).toBeNull();
    const rows = await db.prisma.priceArchiveObservation.findMany(); expect(Number(usage.bytes)).toBe(rows.reduce((n, r) => n + r.payloadBytes, 0));
  });
  it("desligar o arquivo mantém a limpeza e para de guardar", async () => {
    await capture(beforeKickoff); config.enabled = false; vi.setSystemTime(new Date(ARCHIVE_NOW.getTime() + 31 * 86_400_000));
    await maintainClosingArchive(); expect(await db.prisma.priceArchiveObservation.count()).toBe(0);
    expect(await archivePriceResponse(priceEnvelope())).toBeNull();
  });
});
