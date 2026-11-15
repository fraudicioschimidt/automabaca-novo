import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import * as betResult from "@/src/services/settlement/bet-result";
import { applyBetEdit } from "@/src/services/bets/edit";
import { resolveProvisionalKickoff } from "@/src/services/sharp/enrich/kickoff-provisional";
import { KICKOFF_RESOLVE_ATTEMPT_ACTION } from "@/src/services/sharp/enrich/kickoff-attempts";
import { findBetsParaReviver } from "@/src/services/sharp/revive";
import { CADENCIA_PERTO_MS } from "@/src/domain/enrich-cadence";

/**
 * Kickoff persistente: misses respeitam cooldown e voltam a tentar.
 */

const BRIDGE_KICKOFF_COOLDOWN_KEY = (betId: string) => `kickoff-bridge:${betId}`;
const WEB_KICKOFF_COOLDOWN_KEY = (betId: string) => `kickoff-web:${betId}`;

async function hasKickoffResolveAttempt(betId: string): Promise<boolean> {
  const row = await db.prisma.auditEvent.findFirst({
    where: { resource: "bet", resourceId: betId, action: KICKOFF_RESOLVE_ATTEMPT_ACTION },
    select: { id: true },
  });
  return Boolean(row);
}

let db: TestDb;
const AGORA = new Date("2026-07-09T18:00:00Z");
let seq = 0;

beforeAll(() => {
  db = createTestDb();
  process.env.BRIDGEODDS_URL ??= "https://fake.local";
  process.env.BRIDGEODDS_USER ??= "test";
  process.env.BRIDGEODDS_PASS ??= "test";
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  seq = 0;
});

async function seedBet(opts?: { data?: Date }) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "T", slug: `t-oneshot-${seq++}`, sharpMode: "CLV_ONLY" },
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      bankrollId: bankroll.id,
      data: opts?.data ?? new Date("2026-07-10T03:00:00Z"),
      evento: "Central Coast Mariners vs Blacktown Spartans",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Central Coast Mariners",
      odds: 1.9,
      stake: 1,
      kickoffInferido: true,
    },
  });
}

function fieldsOf(bet: {
  id: string;
  evento: string;
  esporte: string;
  data: Date;
  kickoffInferido: boolean;
}) {
  return {
    id: bet.id,
    evento: bet.evento,
    esporte: bet.esporte,
    pais: "",
    competicao: "",
    data: bet.data,
    kickoffInferido: bet.kickoffInferido,
  };
}

/** Isola testes Bridge/web: catálogos FS/Pinnacle17 forçados a miss. */
const nullCatalogs = {
  flashscoreSchedule: async () => null,
  pinnacle17Schedule: async () => null,
};

describe("kickoff persistente (ciclo Bridge→web)", () => {
  it("falha ao salvar vínculo do FlashScore reverte o horário e permite tentar novamente", async () => {
    const bet = await seedBet();
    const scheduled = new Date("2026-07-10T15:00:00Z");
    const deps = { now: AGORA, flashscoreSchedule: async () => ({
      kickoff: scheduled, sport: "Soccer", country: "Australia", competition: "A-League",
      confidence: 1, matchId: "fs-kickoff", sourceUrl: "https://www.flashscore.com/match/fs-kickoff/",
    }) };
    const failure = vi.spyOn(betResult, "linkFlashscoreMatch").mockRejectedValueOnce(new Error("conexão caiu ao salvar o vínculo"));
    try {
      await expect(resolveProvisionalKickoff(fieldsOf(bet), deps)).rejects.toThrow(/conexão caiu/);
      expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
        .toMatchObject({ data: bet.data, kickoffInferido: true });
      expect(await db.prisma.betResult.count({ where: { betId: bet.id } })).toBe(0);
      expect(await hasKickoffResolveAttempt(bet.id)).toBe(false);
    } finally { failure.mockRestore(); }
    await resolveProvisionalKickoff(fieldsOf(bet), deps);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .toMatchObject({ data: scheduled, kickoffInferido: false });
    expect(await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ resultProvider: "flashscore", resultMatchId: "fs-kickoff" });
  });

  it("miss web grava audit e repete após o cooldown", async () => {
    const bet = await seedBet();
    const query = vi.fn(async () => []);
    const webSearch = vi.fn(async () => null);

    await resolveProvisionalKickoff(fieldsOf(bet), {
      query: query as never,
      webSearch,
      now: AGORA,
      ...nullCatalogs,
    });

    expect(query.mock.calls.length).toBeGreaterThan(0);
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(await hasKickoffResolveAttempt(bet.id)).toBe(true);

    const bridgeCalls = query.mock.calls.length;
    query.mockClear();
    webSearch.mockClear();

    // Catálogos mudam ao longo do dia: depois do cooldown, tenta novamente. A
    // prova de "tentou" é o attempt + a busca web, não a contagem de GETs: o
    // catálogo do dia é cache de processo, e reaproveitá-lo é o comportamento
    // desejado (o TTL de identidade governa a releitura em produção).
    const later = new Date(AGORA.getTime() + 7 * 3_600_000);
    await resolveProvisionalKickoff(
      { ...fieldsOf(bet), kickoffInferido: true },
      { query: query as never, webSearch, now: later, ...nullCatalogs },
    );
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(bridgeCalls).toBeGreaterThan(0);

    const attempts = await db.prisma.auditEvent.count({
      where: { resourceId: bet.id, action: KICKOFF_RESOLVE_ATTEMPT_ACTION },
    });
    expect(attempts).toBe(2);
  });

  it("CD web_kickoff_miss expirado do legado não bloqueia nova tentativa", async () => {
    const bet = await seedBet();
    const query = vi.fn(async () => []);
    const webSearch = vi.fn(async () => null);

    // Legado: só CD web miss, sem AuditEvent.
    await db.prisma.iaJudgeCooldown.create({
      data: {
        key: WEB_KICKOFF_COOLDOWN_KEY(bet.id),
        reason: "web_kickoff_miss",
        expiresAt: new Date(AGORA.getTime() - 60_000), // já expirado
      },
    });

    await resolveProvisionalKickoff(fieldsOf(bet), {
      query: query as never,
      webSearch,
      now: AGORA,
      ...nullCatalogs,
    });

    expect(query.mock.calls.length).toBeGreaterThan(0);
    expect(webSearch).toHaveBeenCalledTimes(1);
  });

  it("só Bridge CD (web ainda não rodou): web pode completar o ciclo", async () => {
    const bet = await seedBet();
    const query = vi.fn(async () => []);
    const webSearch = vi.fn(async () => null);

    await db.prisma.iaJudgeCooldown.create({
      data: {
        key: BRIDGE_KICKOFF_COOLDOWN_KEY(bet.id),
        reason: "bridge_kickoff_miss",
        expiresAt: new Date(AGORA.getTime() + 2 * 3_600_000),
      },
    });

    await resolveProvisionalKickoff(fieldsOf(bet), {
      query: query as never,
      webSearch,
      now: AGORA,
      ...nullCatalogs,
    });

    expect(query.mock.calls.length).toBe(0);
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(await hasKickoffResolveAttempt(bet.id)).toBe(true);
  });

  it("hit Bridge grava attempt source bridge e não chama web", async () => {
    const scheduled = new Date("2026-07-10T15:00:00Z");
    const bet = await seedBet();
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { evento: "AC Connecticut vs Vermont Green" },
    });
    // Uma página só: devolver o mesmo jogo em N datas → empate SCORE_MARGIN.
    let served = false;
    const query = vi.fn(async () => {
      if (served) return [];
      served = true;
      return [
        {
          match_id: 1631723956,
          home: "AC Connecticut",
          away: "Vermont Green",
          sport: "Futebol",
          league: "USA - USL League 2",
          match_date: scheduled.toISOString(),
          home_score: null,
          away_score: null,
        },
      ];
    });
    const webSearch = vi.fn(async () => null);

    await resolveProvisionalKickoff(
      { ...fieldsOf(bet), evento: "AC Connecticut vs Vermont Green" },
      { query: query as never, webSearch, now: AGORA, ...nullCatalogs },
    );

    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.kickoffInferido).toBe(false);
    expect(updated.data.toISOString()).toBe(scheduled.toISOString());
    expect(webSearch).not.toHaveBeenCalled();

    const attempt = await db.prisma.auditEvent.findFirstOrThrow({
      where: { resourceId: bet.id, action: KICKOFF_RESOLVE_ATTEMPT_ACTION },
    });
    expect((attempt.details as { source?: string; aplicado?: boolean }).source).toBe("bridge");
    expect((attempt.details as { aplicado?: boolean }).aplicado).toBe(true);
  });

  it("hit web corrige horário e preserva a identidade Pinnacle existente", async () => {
    const bet = await seedBet();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { pais: "Australia", competicao: "Australia - NPL NSW" } });
    const scheduled = new Date("2026-07-10T15:00:00Z");
    const query = vi.fn(async () => []);
    const webSearch = vi.fn(async () => ({
      data: {
        found: true,
        kickoffIso: scheduled.toISOString(),
        actualSport: "Soccer",
        confidence: 0.95,
        country: "Australia",
        competition: "NPL New South Wales",
        reason: "fonte oficial",
        sourceUrl: "https://example.com/match",
      },
      provider: "gemini" as const,
      sources: [{ url: "https://example.com/match" }],
    }));

    await resolveProvisionalKickoff({ ...fieldsOf(bet), pais: "Australia", competicao: "Australia - NPL NSW" }, {
      query: query as never,
      webSearch,
      now: AGORA,
      ...nullCatalogs,
    });

    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.kickoffInferido).toBe(false);
    expect(updated.data.toISOString()).toBe(scheduled.toISOString());
    expect(updated.pais).toBe("Australia");
    expect(updated.competicao).toBe("Australia - NPL NSW");
    expect(await hasKickoffResolveAttempt(bet.id)).toBe(true);
    expect(webSearch).toHaveBeenCalledTimes(1);

    const attempt = await db.prisma.auditEvent.findFirstOrThrow({
      where: { resourceId: bet.id, action: KICKOFF_RESOLVE_ATTEMPT_ACTION },
    });
    expect((attempt.details as { source?: string; aplicado?: boolean }).source).toBe("web");
    expect((attempt.details as { aplicado?: boolean }).aplicado).toBe(true);

    query.mockClear();
    webSearch.mockClear();
    await resolveProvisionalKickoff(
      { ...fieldsOf(updated), kickoffInferido: false, data: updated.data },
      { query: query as never, webSearch, now: AGORA, ...nullCatalogs },
    );
    expect(query.mock.calls.length).toBe(0);
    expect(webSearch).not.toHaveBeenCalled();
  });

  describe("jogo achado em outro esporte", () => {
    const scheduled = new Date("2026-07-24T00:30:00Z");
    const webFinds = (confidence: number, kickoffIso = scheduled.toISOString()) => vi.fn(async () => ({
      data: {
        found: true, kickoffIso, actualSport: "Basketball", confidence,
        country: "Chile", competition: "Chile - LNB", reason: "evento de basquete", sourceUrl: "https://example.com/basketball-event",
      },
      provider: "gemini" as const,
      sources: [{ url: "https://example.com/basketball-event" }],
    }));
    const run = (fields: ReturnType<typeof fieldsOf> & { sportSource?: string }, confidence: number) =>
      resolveProvisionalKickoff(fields, { query: vi.fn(async () => []) as never, webSearch: webFinds(confidence), now: AGORA, ...nullCatalogs });
    const reviewOf = (betId: string) => db.prisma.operationalAction.findFirst({ where: { resource: "bet", resourceId: betId, actionType: "sport.review" } });

    async function expectUntouched(bet: { id: string; data: Date }, esporte = "Soccer") {
      const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
      expect(after).toMatchObject({ esporte, kickoffInferido: true, sportResolutionStatus: "CONFIRMED" });
      expect(after.data.toISOString()).toBe(bet.data.toISOString());
      return after;
    }

    it.each(["TEXT", "TEAM_ID", "WEB", "MANUAL", "CHANNEL"] as const)(
      "esporte vindo de %s não é trocado, o horário não entra e o dono é chamado",
      async (sportSource) => {
        const seeded = await seedBet();
        const bet = await db.prisma.bet.update({ where: { id: seeded.id }, data: { sportSource, sportConfidence: 95 } });
        const fields = { ...fieldsOf(bet), sportSource };
        await resolveProvisionalKickoff(fields, { query: vi.fn(async () => []) as never, webSearch: webFinds(0.98), now: AGORA, ...nullCatalogs });

        const after = await expectUntouched(bet);
        expect(after).toMatchObject({ sportSource, sportConfidence: 95 });
        expect(fields).toMatchObject({ esporte: "Soccer", kickoffInferido: true });
        const attempt = await db.prisma.auditEvent.findFirstOrThrow({ where: { resourceId: bet.id, action: KICKOFF_RESOLVE_ATTEMPT_ACTION } });
        expect(attempt.details).toMatchObject({ aplicado: false, esporteAnterior: "Soccer", esporteResolvido: "Basketball", missReason: "other_sport" });
        expect(await reviewOf(bet.id)).toMatchObject({
          status: "OPEN",
          evidence: expect.objectContaining({ esporte: "Soccer", esporteSugerido: "Basketball", confianca: 98, sportSource }),
        });
        // A mesma resposta não volta a cada ciclo do enrich.
        expect(await db.prisma.iaJudgeCooldown.findUnique({ where: { key: WEB_KICKOFF_COOLDOWN_KEY(bet.id) } })).not.toBeNull();
      },
    );

    it("com 90 a ação já abre; abaixo de 90 fica só a tentativa", async () => {
      const bet = await seedBet();
      await run({ ...fieldsOf(bet), sportSource: "TEXT" }, 0.9);
      await expectUntouched(bet);
      expect(await reviewOf(bet.id)).toMatchObject({ status: "OPEN", evidence: expect.objectContaining({ confianca: 90 }) });

      const weak = await seedBet();
      await resolveProvisionalKickoff({ ...fieldsOf(weak), sportSource: "TEXT" }, {
        query: vi.fn(async () => []) as never, webSearch: vi.fn(async () => null), now: AGORA,
        flashscoreSchedule: async () => ({ kickoff: scheduled, sport: "Basketball", confidence: 0.89, country: null, competition: null, matchId: "fs-1" }),
        pinnacle17Schedule: async () => null,
      });
      await expectUntouched(weak);
      expect(await reviewOf(weak.id)).toBeNull();
      expect(await db.prisma.auditEvent.findFirstOrThrow({ where: { resourceId: weak.id, action: KICKOFF_RESOLVE_ATTEMPT_ACTION, details: { path: ["source"], equals: "flashscore" } } }))
        .toMatchObject({ details: expect.objectContaining({ aplicado: false, esporteResolvido: "Basketball" }) });
    });

    it("o calendário seguinte ainda pode dar o horário no esporte da aposta", async () => {
      const bet = await seedBet();
      const inSoccer = new Date("2026-07-10T15:00:00Z");
      await resolveProvisionalKickoff({ ...fieldsOf(bet), sportSource: "TEAM_ID" }, {
        query: vi.fn(async () => []) as never, webSearch: vi.fn(async () => null), now: AGORA,
        flashscoreSchedule: async () => ({ kickoff: scheduled, sport: "Basketball", confidence: 1, country: "Chile", competition: "LNB", matchId: "fs-basket" }),
        pinnacle17Schedule: async () => ({ kickoff: inSoccer, sport: null, country: null, competition: "A-League", source: "pinnacle17" as const }),
      });

      const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
      expect(after).toMatchObject({ esporte: "Soccer", kickoffInferido: false });
      expect(after.data.toISOString()).toBe(inSoccer.toISOString());
      // O jogo de basquete não vira o jogo de resultado da aposta.
      expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
      expect(await reviewOf(bet.id)).toMatchObject({
        status: "OPEN",
        description: expect.stringContaining("mas a aposta está em Soccer, segundo a identidade dos times."),
        evidence: expect.objectContaining({ via: "flashscore", confianca: 100 }),
      });
    });

    it("ação dispensada não reabre para o mesmo candidato; outro horário reabre", async () => {
      const seeded = await seedBet();
      const bet = await db.prisma.bet.update({ where: { id: seeded.id }, data: { sportSource: "MANUAL", sportConfidence: 100 } });
      await run({ ...fieldsOf(bet), sportSource: "MANUAL" }, 0.98);
      const action = await db.prisma.operationalAction.findFirstOrThrow({ where: { resource: "bet", resourceId: bet.id } });
      await db.prisma.operationalAction.update({ where: { id: action.id }, data: { status: "DISMISSED", resolvedAt: new Date() } });

      // Passado o cooldown da web, a mesma resposta volta.
      await db.prisma.iaJudgeCooldown.deleteMany({ where: { key: WEB_KICKOFF_COOLDOWN_KEY(bet.id) } });
      await run({ ...fieldsOf(bet), sportSource: "MANUAL" }, 0.98);
      expect(await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({ status: "DISMISSED", reopenCount: 0 });

      await db.prisma.iaJudgeCooldown.deleteMany({ where: { key: WEB_KICKOFF_COOLDOWN_KEY(bet.id) } });
      await resolveProvisionalKickoff({ ...fieldsOf(bet), sportSource: "MANUAL" }, {
        query: vi.fn(async () => []) as never, webSearch: webFinds(0.98, "2026-07-24T02:00:00.000Z"), now: AGORA, ...nullCatalogs,
      });
      expect(await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({ status: "OPEN", reopenCount: 1 });
    });
  });

  it("edit limpa attempt + CDs e libera novo ciclo", async () => {
    const bet = await seedBet();
    const query = vi.fn(async () => []);
    const webSearch = vi.fn(async () => null);

    await resolveProvisionalKickoff(fieldsOf(bet), {
      query: query as never,
      webSearch,
      now: AGORA,
      ...nullCatalogs,
    });
    expect(await hasKickoffResolveAttempt(bet.id)).toBe(true);
    expect(
      await db.prisma.iaJudgeCooldown.findUnique({
        where: { key: BRIDGE_KICKOFF_COOLDOWN_KEY(bet.id) },
      }),
    ).toBeTruthy();

    await applyBetEdit({
      betId: bet.id,
      actor: "test",
      fields: {
        data: bet.data,
        evento: "Novo Time A vs Novo Time B",
        esporte: "Soccer",
        competicao: "",
        pais: "",
        mercado: "Moneyline",
        selecao: "Novo Time A",
        odds: 1.95,
        stake: 1,
        kickoffInferido: true,
      },
    });

    expect(await hasKickoffResolveAttempt(bet.id)).toBe(false);
    expect(
      await db.prisma.iaJudgeCooldown.findUnique({
        where: { key: BRIDGE_KICKOFF_COOLDOWN_KEY(bet.id) },
      }),
    ).toBeNull();
    expect(
      await db.prisma.iaJudgeCooldown.findUnique({
        where: { key: WEB_KICKOFF_COOLDOWN_KEY(bet.id) },
      }),
    ).toBeNull();

    query.mockClear();
    webSearch.mockClear();
    const edited = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    await resolveProvisionalKickoff(fieldsOf({ ...edited, kickoffInferido: true }), {
      query: query as never,
      webSearch,
      now: AGORA,
      ...nullCatalogs,
    });
    // Ciclo novo se prova pelo attempt e pela busca web. O evento mudou, mas o
    // DIA é o mesmo: o catálogo em memória serve o nome novo sem gastar cota.
    expect(webSearch).toHaveBeenCalled();
    expect(await hasKickoffResolveAttempt(bet.id)).toBe(true);
  });
});

describe("kickoff-bridge cooldown", () => {
  it("2ª resolveProvisionalKickoff no intervalo não chama Bridge", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "T", slug: "t-kickoff-cd", sharpMode: "CLV_ONLY" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: new Date("2026-07-10T03:00:00Z"),
        evento: "Central Coast Mariners vs Blacktown Spartans",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Central Coast Mariners",
        odds: 1.9,
        stake: 1,
        kickoffInferido: true,
      },
    });

    const query = vi.fn(async () => []);
    const fields = {
      id: bet.id,
      evento: bet.evento,
      esporte: bet.esporte,
      pais: "",
      competicao: "",
      data: bet.data,
      kickoffInferido: true,
    };

    const nullCatalogs = {
      flashscoreSchedule: async () => null,
      pinnacle17Schedule: async () => null,
    };

    await resolveProvisionalKickoff(fields, {
      query: query as never,
      now: AGORA,
      webSearch: async () => null,
      ...nullCatalogs,
    });
    expect(query.mock.calls.length).toBeGreaterThan(0);
    expect(query.mock.calls.length).toBeLessThanOrEqual(14);

    const cd = await db.prisma.iaJudgeCooldown.findUnique({
      where: { key: BRIDGE_KICKOFF_COOLDOWN_KEY(bet.id) },
    });
    expect(cd).toBeTruthy();
    expect(cd!.expiresAt.getTime()).toBeGreaterThan(AGORA.getTime());

    query.mockClear();
    await resolveProvisionalKickoff(
      { ...fields, kickoffInferido: true },
      { query: query as never, now: AGORA, webSearch: async () => null, ...nullCatalogs },
    );
    expect(query.mock.calls.length).toBe(0);
  });

  it("revive segue com Bridge+web em CD (catálogos FS/Pinnacle17 ainda podem corrigir)", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "T2", slug: "t-kickoff-cd2", sharpMode: "CLV_ONLY" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: new Date(AGORA.getTime() + 2 * 3_600_000),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 1.9,
        stake: 1,
        kickoffInferido: true,
        sharp: { create: { identityStatus: "PENDING", confidence: 0 } },
      },
    });
    await db.prisma.$executeRaw`
      UPDATE bet_sharp SET "updatedAt" = ${new Date(AGORA.getTime() - CADENCIA_PERTO_MS - 60_000)}
      WHERE "betId" = ${bet.id}
    `;
    await db.prisma.iaJudgeCooldown.create({
      data: {
        key: BRIDGE_KICKOFF_COOLDOWN_KEY(bet.id),
        reason: "bridge_kickoff_miss",
        expiresAt: new Date(AGORA.getTime() + 2 * 3_600_000),
      },
    });

    expect(await findBetsParaReviver(AGORA)).toContain(bet.id);
    await db.prisma.iaJudgeCooldown.create({
      data: {
        key: WEB_KICKOFF_COOLDOWN_KEY(bet.id),
        reason: "web_kickoff_miss",
        expiresAt: new Date(AGORA.getTime() + 2 * 3_600_000),
      },
    });
    // CDs Bridge/web não bloqueiam revive — FS/Pinnacle17 ainda podem acertar.
    expect(await findBetsParaReviver(AGORA)).toContain(bet.id);
  });
});
