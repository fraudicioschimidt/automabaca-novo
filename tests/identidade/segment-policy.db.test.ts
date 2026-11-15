import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  evaluateSegmentPolicies,
  getSegmentPhase,
  invalidateSegmentPolicyCache,
  SEGMENT_MIN_BETS,
  SEGMENT_RETEST_AFTER_DAYS,
  SEGMENT_WINDOW_DAYS,
} from "@/src/services/sharp/segment-policy";
import { checkContasDrift } from "@/src/services/contas/drift";
import { criarConta } from "@/src/services/contas/manage";

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  invalidateSegmentPolicyCache();
});

/**
 * Semeia N apostas avaliadas de um segmento, com `okRatio` de CLV confiável.
 * As demais ficam sem CLV pelo motivo dado; sem motivo, é o fornecedor sem
 * preço na linha.
 */
async function seedSegment(params: {
  bankrollId: string;
  esporte: string;
  mercado: string;
  n: number;
  okRatio: number;
  noOddsReason?: string;
  fetchedAt?: Date;
  tag?: string;
}): Promise<void> {
  const now = params.fetchedAt?.getTime() ?? Date.now();
  const ids: string[] = [];
  for (let i = 0; i < params.n; i++) {
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: params.bankrollId,
        data: new Date(now - i * 3_600_000),
        evento: `Time A${i} vs Time B${i}`,
        esporte: params.esporte,
        competicao: "Liga X",
        pais: "X",
        casaDeAposta: "Casa",
        mercado: params.mercado,
        selecao: "Over 2.5",
        odds: 1.9,
        stake: 1,
        source: "seed",
        sourceExternalId: `${params.esporte}:${params.mercado}:${params.noOddsReason ?? "base"}:${params.tag ?? ""}:${i}`,
      },
      select: { id: true },
    });
    ids.push(bet.id);
  }
  await db.prisma.betSharp.createMany({
    data: ids.map((betId) => ({ betId, identityStatus: "MATCHED" as const, confidence: 90 })),
  });
  const okAte = Math.round(params.n * params.okRatio);
  await db.prisma.betClosing.createMany({
    data: ids.map((betId, i) => ({
      betId,
      fetchedAt: new Date(now),
      clvReliable: i < okAte,
      noOddsReason: i < okAte ? null : params.noOddsReason ?? "no_prices",
    })),
  });
}

describe("probation por segmento esporte×mercado (Postgres real)", () => {
  it.each(["snapshot", "formula"])("marcador confiável com %s inválido não promove o segmento", async (kind) => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Prova", slug: "prova", sharpMode: "CLV_ONLY" } });
    const mercado = "Total – Match";
    await seedSegment({ bankrollId: bank.id, esporte: "Soccer", mercado, n: SEGMENT_MIN_BETS, okRatio: 0.3, tag: "valid" });
    await seedSegment({ bankrollId: bank.id, esporte: "Soccer", mercado, n: SEGMENT_MIN_BETS, okRatio: 1, tag: "invalid" });
    if (kind === "snapshot") await db.prisma.$executeRaw`
      UPDATE bet_closing SET "closingPriceSnapshot" = '{}'::jsonb WHERE "betId" IN
        (SELECT id FROM bets WHERE "sourceExternalId" LIKE '%:invalid:%')`;
    if (kind === "formula") await db.prisma.$executeRaw`
      UPDATE bet_closing SET clv = 80 WHERE "betId" IN
        (SELECT id FROM bets WHERE "sourceExternalId" LIKE '%:invalid:%')`;
    await evaluateSegmentPolicies();
    const policy = await db.prisma.marketSegmentPolicy.findFirstOrThrow({ where: { esporte: "Soccer", mercado } });
    expect(policy).toMatchObject({ phase: "SHARP_OFF", betsAvaliadas: SEGMENT_MIN_BETS });
    expect(policy.clvReliablePct?.toNumber()).toBe(30);
  });

  it.each([0.3, 0.6])("identidade vinculada pelo dono tem o mesmo peso da identidade automática na cobertura (%s)", async (ratio) => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Vincular", slug: "vincular", sharpMode: "CLV_ONLY" } });
    const mercado = "Total – Match";
    await seedSegment({ bankrollId: bank.id, esporte: "Soccer", mercado, n: SEGMENT_MIN_BETS, okRatio: ratio });
    await db.prisma.betSharp.updateMany({ data: { identityStatus: "MANUAL" } });
    expect(await evaluateSegmentPolicies()).toMatchObject({ segmentos: 1 });
    const policy = await db.prisma.marketSegmentPolicy.findFirstOrThrow({ where: { esporte: "Soccer", mercado } });
    expect(policy).toMatchObject({ phase: ratio < 0.5 ? "SHARP_OFF" : "SHARP_ACTIVE", betsAvaliadas: SEGMENT_MIN_BETS });
    expect(policy.clvReliablePct?.toNumber()).toBe(ratio * 100);
  });

  it("não deixa congelamentos sharp_off engrossarem a própria amostra", async () => {
    const banca = await db.prisma.bankroll.create({
      data: { nome: "Off", slug: "off", sharpMode: "CLV_ONLY" },
    });
    await seedSegment({
      bankrollId: banca.id,
      esporte: "Soccer",
      mercado: "Total (Corners) – Match",
      n: SEGMENT_MIN_BETS,
      okRatio: 0.3,
    });
    await evaluateSegmentPolicies();
    await seedSegment({
      bankrollId: banca.id,
      esporte: "Soccer",
      mercado: "Total (Corners) – Match",
      n: SEGMENT_MIN_BETS,
      okRatio: 0,
      noOddsReason: "sharp_off",
    });
    await evaluateSegmentPolicies();
    const policy = await db.prisma.marketSegmentPolicy.findFirstOrThrow({
      where: { esporte: "Soccer", mercado: "Total (Corners) – Match" },
    });
    expect(policy.betsAvaliadas).toBe(SEGMENT_MIN_BETS);
    expect(policy.clvReliablePct?.toNumber()).toBe(30);
  });

  it("motivo fora da base (entrada ao vivo) não entra no denominador", async () => {
    const banca = await db.prisma.bankroll.create({ data: { nome: "B", slug: "b", sharpMode: "CLV_ONLY" } });
    const mercado = "Total – Match";
    await seedSegment({ bankrollId: banca.id, esporte: "Soccer", mercado, n: SEGMENT_MIN_BETS, okRatio: 0.6 });
    await seedSegment({ bankrollId: banca.id, esporte: "Soccer", mercado, n: SEGMENT_MIN_BETS, okRatio: 0, noOddsReason: "aposta_ao_vivo" });
    await evaluateSegmentPolicies();
    const policy = await db.prisma.marketSegmentPolicy.findFirstOrThrow({ where: { esporte: "Soccer", mercado } });
    expect(policy).toMatchObject({ phase: "SHARP_ACTIVE", betsAvaliadas: SEGMENT_MIN_BETS });
    expect(policy.clvReliablePct?.toNumber()).toBe(60);
  });

  it("falha nossa não conta contra o fornecedor: só CLV confiável e motivo dele entram", async () => {
    const banca = await db.prisma.bankroll.create({ data: { nome: "S", slug: "s", sharpMode: "CLV_ONLY" } });
    const mercado = "Total – Match";
    // Metade com CLV confiável e metade sem preço na linha do fornecedor: 50%.
    await seedSegment({ bankrollId: banca.id, esporte: "Soccer", mercado, n: SEGMENT_MIN_BETS, okRatio: 0.5, tag: "fornecedor" });
    // A captura que não aconteceu perto do apito e o motivo que o vocabulário
    // não conhece são conserto nosso: não derrubam o segmento.
    await seedSegment({ bankrollId: banca.id, esporte: "Soccer", mercado, n: SEGMENT_MIN_BETS, okRatio: 0,
      noOddsReason: "kickoff_sem_captura", tag: "sistema" });
    await seedSegment({ bankrollId: banca.id, esporte: "Soccer", mercado, n: 20, okRatio: 0,
      noOddsReason: "motivo_de_outra_versao", tag: "desconhecido" });
    await evaluateSegmentPolicies();
    const policy = await db.prisma.marketSegmentPolicy.findFirstOrThrow({ where: { esporte: "Soccer", mercado } });
    expect(policy).toMatchObject({ phase: "SHARP_ACTIVE", betsAvaliadas: SEGMENT_MIN_BETS });
    expect(policy.clvReliablePct?.toNumber()).toBe(50);
  });

  it("decide pela janela recente, não pelo histórico inteiro", async () => {
    const banca = await db.prisma.bankroll.create({ data: { nome: "J", slug: "j", sharpMode: "CLV_ONLY" } });
    const now = new Date("2026-09-23T12:00:00Z");
    const mercado = "Total – Match";
    await seedSegment({ bankrollId: banca.id, esporte: "Soccer", mercado, n: SEGMENT_MIN_BETS, okRatio: 0.9,
      fetchedAt: new Date(now.getTime() - (SEGMENT_WINDOW_DAYS + 10) * 86_400_000), tag: "antigo" });
    await seedSegment({ bankrollId: banca.id, esporte: "Soccer", mercado, n: SEGMENT_MIN_BETS, okRatio: 0.3,
      fetchedAt: new Date(now.getTime() - 86_400_000), tag: "recente" });
    await evaluateSegmentPolicies(now);
    expect(await db.prisma.marketSegmentPolicy.findFirstOrThrow({ where: { esporte: "Soccer", mercado } }))
      .toMatchObject({ phase: "SHARP_OFF", betsAvaliadas: SEGMENT_MIN_BETS });
  });

  it("SHARP_OFF volta a ser testado depois de N dias, só com o que fechou desde então", async () => {
    const banca = await db.prisma.bankroll.create({ data: { nome: "R", slug: "r", sharpMode: "CLV_ONLY" } });
    const t0 = new Date("2026-09-01T12:00:00Z");
    const day = 86_400_000;
    const mercado = "Total (Corners) – Match";
    await seedSegment({ bankrollId: banca.id, esporte: "Soccer", mercado, n: 2 * SEGMENT_MIN_BETS, okRatio: 0.1, fetchedAt: t0, tag: "ruim" });
    await evaluateSegmentPolicies(t0);
    expect(await db.prisma.marketSegmentPolicy.findFirstOrThrow({ where: { mercado } })).toMatchObject({ phase: "SHARP_OFF" });

    const retest = new Date(t0.getTime() + (SEGMENT_RETEST_AFTER_DAYS + 1) * day);
    await evaluateSegmentPolicies(retest);
    // A amostra velha ainda está na janela, mas não decide o novo teste.
    expect(await db.prisma.marketSegmentPolicy.findFirstOrThrow({ where: { mercado } })).toMatchObject({ phase: "PROBATION" });

    await seedSegment({ bankrollId: banca.id, esporte: "Soccer", mercado, n: SEGMENT_MIN_BETS, okRatio: 0.9,
      fetchedAt: new Date(retest.getTime() + day), tag: "bom" });
    await evaluateSegmentPolicies(new Date(retest.getTime() + 2 * day));
    const policy = await db.prisma.marketSegmentPolicy.findFirstOrThrow({ where: { mercado } });
    expect(policy).toMatchObject({ phase: "SHARP_ACTIVE", betsAvaliadas: SEGMENT_MIN_BETS, sampleStartedAt: retest });
    expect(policy.clvReliablePct?.toNumber()).toBe(90);

    // Fora da PROBATION a amostra continua começando no religamento: a ruim de
    // antes, ainda na janela, não derruba o segmento de novo.
    await evaluateSegmentPolicies(new Date(retest.getTime() + 3 * day));
    expect(await db.prisma.marketSegmentPolicy.findFirstOrThrow({ where: { mercado } }))
      .toMatchObject({ phase: "SHARP_ACTIVE", betsAvaliadas: SEGMENT_MIN_BETS });
  });

  it("decisão MANUAL do dono não é sobrescrita nem religada", async () => {
    const banca = await db.prisma.bankroll.create({ data: { nome: "M", slug: "m", sharpMode: "CLV_ONLY" } });
    const now = new Date("2026-09-23T12:00:00Z");
    await db.prisma.marketSegmentPolicy.createMany({ data: [
      { esporte: "Soccer", mercado: "Total – Match", phase: "SHARP_ACTIVE", source: "MANUAL" },
      { esporte: "Soccer", mercado: "Handicap – Match", phase: "SHARP_OFF", source: "MANUAL", decidedAt: new Date("2026-01-01T00:00:00Z") },
    ] });
    await seedSegment({ bankrollId: banca.id, esporte: "Soccer", mercado: "Total – Match", n: SEGMENT_MIN_BETS, okRatio: 0.1,
      fetchedAt: new Date(now.getTime() - 86_400_000) });
    await evaluateSegmentPolicies(now);
    expect(await db.prisma.marketSegmentPolicy.findFirstOrThrow({ where: { mercado: "Total – Match" } }))
      .toMatchObject({ phase: "SHARP_ACTIVE", source: "MANUAL" });
    expect(await db.prisma.marketSegmentPolicy.findFirstOrThrow({ where: { mercado: "Handicap – Match" } }))
      .toMatchObject({ phase: "SHARP_OFF", source: "MANUAL" });
  });

  it("normaliza hífen, en dash e caixa na chave do segmento", async () => {
    await db.prisma.marketSegmentPolicy.create({
      data: { esporte: "Soccer", mercado: "Total – Match", phase: "SHARP_OFF" },
    });
    expect(await getSegmentPhase("soccer", "Total - Match")).toBe("SHARP_OFF");
  });

  it("CLV confiável <50% em ≥100 apostas → SHARP_OFF; ≥50% → SHARP_ACTIVE", async () => {
    const banca = await db.prisma.bankroll.create({
      data: { nome: "T", slug: "t", valorUnidade: 100, capitalInicial: 100, sharpMode: "CLV_ONLY" },
      select: { id: true },
    });

    // Segmento ruim: corners com 30% confiável (a dor real do dono).
    await seedSegment({
      bankrollId: banca.id,
      esporte: "Soccer",
      mercado: "Total (Corners) – Match",
      n: SEGMENT_MIN_BETS,
      okRatio: 0.3,
    });
    // Segmento bom: game-line 90% confiável.
    await seedSegment({
      bankrollId: banca.id,
      esporte: "Soccer",
      mercado: "Total",
      n: SEGMENT_MIN_BETS,
      okRatio: 0.9,
    });
    // Volume insuficiente: não decide.
    await seedSegment({
      bankrollId: banca.id,
      esporte: "Tennis",
      mercado: "Match Winner",
      n: 10,
      okRatio: 0,
    });

    const r = await evaluateSegmentPolicies();
    expect(r.segmentos).toBe(2); // tênis ficou fora (n<100)

    expect(await getSegmentPhase("Soccer", "Total (Corners) – Match")).toBe("SHARP_OFF");
    expect(await getSegmentPhase("Soccer", "Total")).toBe("SHARP_ACTIVE");
    expect(await getSegmentPhase("Tennis", "Match Winner")).toBe("PROBATION");
  });
});

describe("drift de saldo (invariante do ledger)", () => {
  it("conta íntegra não alerta; saldo adulterado gera AuditEvent uma vez por dia", async () => {
    const { contaId } = await criarConta(
      { casaDeAposta: "Bet365", titular: "Maria", saldoInicial: 500 },
      { client: db.prisma },
    );

    let r = await checkContasDrift();
    expect(r.drifts).toBe(0);

    // Simula bug: saldo diverge do ledger em R$50.
    await db.prisma.conta.update({ where: { id: contaId }, data: { saldoAtual: 550 } });
    r = await checkContasDrift();
    expect(r.drifts).toBe(1);
    const audits = await db.prisma.auditEvent.findMany({ where: { action: "conta_drift" } });
    expect(audits).toHaveLength(1);

    // Mesmo dia: não duplica o alerta.
    r = await checkContasDrift();
    expect(r.drifts).toBe(1);
    expect(await db.prisma.auditEvent.count({ where: { action: "conta_drift" } })).toBe(1);
  });
});
