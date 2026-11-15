import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalogLink, seedTeamCard } from "../helpers/team-cards";

const findEvent = vi.hoisted(() => vi.fn());
const resolvePinnacleSharp = vi.hoisted(() => vi.fn());
vi.mock("@/src/providers/pinnacle17/sharp", async (original) => ({
  ...await original<typeof import("@/src/providers/pinnacle17/sharp")>(),
  resolvePinnacle17SharpForBet: resolvePinnacleSharp,
}));
vi.mock("@/src/providers/pinnacle17/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/providers/pinnacle17/client")>(),
  findPinnacle17EventById: findEvent,
}));
const { applyBridgeIdentity, bridgeMatchGameStart } = await import("@/src/services/sharp/enrich/apply-identity");

const { resolvePinnacle17Identity } = await import("@/src/services/sharp/enrich/pinnacle17-identity");
const { upsertSharp } = await import("@/src/services/sharp/enrich/upsert-sharp");

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

describe("applyBridgeIdentity (Postgres real)", () => {
  it("respeita MANUAL em BetSharp mesmo com snapshot em memória desatualizado", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Manual Identity Bankroll", slug: "manual-idn-bankroll" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        evento: "Equipe A vs Equipe B (Manual)",
        esporte: "Soccer",
        competicao: "Liga Custom",
        pais: "Brasil",
        mercado: "Match Odds",
        selecao: "Equipe A",
        odds: 1.95,
        stake: 1.0,
        status: "PENDING",
        sportResolutionStatus: "CONFIRMED",
        sportConfidence: 95,
        sportSource: "TEAM_ID",
        sportResolvedAt: new Date(),
        data: new Date("2026-09-01T20:00:00Z"),
        registradoEm: new Date(),
        sharp: {
          create: {
            provider: "bridgeodds",
            identityStatus: "MANUAL",
          },
        },
      },
      include: { sharp: true },
    });

    // Simulamos um enrich com snapshot stale onde bet.identityStatus é null/PENDING
    const staleBet = {
      id: bet.id,
      identityStatus: null, // stale in-memory snapshot
      evento: bet.evento,
      esporte: bet.esporte,
      mercado: bet.mercado,
      selecao: bet.selecao,
      data: bet.data,
      kickoffInferido: false,
    };

    const mockBest = {
      match: {
        match_id: 99999,
        sport: "Soccer",
        league: "Brazil - Serie A",
        home: "Auto Home Team",
        away: "Auto Away Team",
        match_date: "2026-09-01T20:00:00Z",
      },
      swapped: false,
      score: 95,
      homeScore: 95,
      awayScore: 95,
      leagueScore: 95,
      dateScore: 95,
    };

    await applyBridgeIdentity({
      gameStart: null,
      bet: staleBet,
      best: mockBest,
      via: "AUTO",
      teams: { home: "Auto Home Team", away: "Auto Away Team" },
      confidence: 95,
    });

    // Verifica se os campos canônicos manuais (evento, competicao, pais) NÃO foram sobrescritos
    const freshBet = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(freshBet.evento).toBe("Equipe A vs Equipe B (Manual)");
    expect(freshBet.competicao).toBe("Liga Custom");
    expect(freshBet.pais).toBe("Brasil");
    // A decisão foi de quem vinculou: o enrich não a registra como automática.
    expect(await db.prisma.auditEvent.count({ where: { action: { in: ["identidade_auto", "identidade_llm"] }, resourceId: bet.id } })).toBe(0);
  });

  it.each([
    ["AUTO", ["Mengao", "Verdao"]],
    ["LLM", []],
  ] as const)("casamento %s: a aposta ganha o jogo; só o automático ensina o nome do tipster à ficha", async (via, learned) => {
    // O jogo da Bridge (o id é o do evento da Pinnacle17) ligado ao do FlashScore, com as fichas dos dois lados.
    const kickoff = new Date("2026-09-01T20:00:00Z");
    await seedCatalogLink(db.prisma, {
      pinnacleEventId: "4242", flashscoreMatchId: "fs-4242", pinnacleHome: "Flamengo RJ", pinnacleAway: "Palmeiras SP",
      flashscoreHome: "Flamengo", flashscoreAway: "Palmeiras", flashscoreHomeTeamId: "fs-fla", flashscoreAwayTeamId: "fs-pal", kickoff,
    });
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", pinnacleNames: [{ name: "Flamengo RJ", eventIds: ["4242"] }] });
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-pal", flashscoreName: "Palmeiras", pinnacleNames: [{ name: "Palmeiras SP", eventIds: ["4242"] }] });
    const bankroll = await db.prisma.bankroll.create({ data: { nome: `Banca ${via}`, slug: `banca-${via.toLowerCase()}` } });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id, evento: "Mengao vs Verdao", esporte: "Soccer", competicao: "", pais: "",
        mercado: "Match Odds", selecao: "Mengao", odds: 1.95, stake: 1, status: "PENDING",
        sportResolutionStatus: "CONFIRMED", sportConfidence: 95, sportSource: "TEXT", sportResolvedAt: new Date(),
        data: new Date("2026-09-01T20:00:00Z"), registradoEm: new Date(),
      },
    });

    await applyBridgeIdentity({
      gameStart: null,
      bet: { id: bet.id, identityStatus: null, evento: bet.evento, esporte: bet.esporte, mercado: bet.mercado,
        selecao: bet.selecao, data: bet.data, kickoffInferido: false },
      best: {
        match: { match_id: 4242, sport: "Soccer", league: "Brazil - Serie A", home: "Flamengo RJ", away: "Palmeiras SP",
          match_date: "2026-09-01T20:00:00Z" },
        swapped: false, score: via === "AUTO" ? 1.8 : 1.1,
      },
      via,
      teams: { home: "Mengao", away: "Verdao" },
      confidence: via === "AUTO" ? 90 : 55,
      judgeConfidence: via === "LLM" ? 0.8 : null,
    });

    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { evento: true } }))
      .toEqual({ evento: "Flamengo RJ vs Palmeiras SP" });
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: via === "AUTO" ? "identidade_auto" : "identidade_llm", resourceId: bet.id } });
    expect(audit.details).toMatchObject({ antes: { evento: bet.evento, esporte: bet.esporte, pais: bet.pais,
      competicao: bet.competicao, data: bet.data.toISOString() }, depois: { evento: after.evento, esporte: after.esporte,
      pais: after.pais, competicao: after.competicao, data: after.data.toISOString() } });
    const names = await db.prisma.teamTipsterName.findMany({ orderBy: { name: "asc" }, select: { name: true, status: true, firstBetId: true } });
    expect(names).toEqual(learned.map((name) => ({ name, status: "pending", firstBetId: bet.id })));
  });

  it("seleção \"Casa\" com o jogo de mando trocado continua no mesmo time", async () => {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Banca lado", slug: "banca-lado" } });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id, evento: "Palmeiras vs Flamengo", esporte: "Soccer", competicao: "", pais: "",
        mercado: "Asian Handicap", selecao: "Casa -0.5", odds: 1.95, stake: 1, status: "PENDING",
        sportResolutionStatus: "CONFIRMED", sportConfidence: 95, sportSource: "TEXT", sportResolvedAt: new Date(),
        data: new Date("2026-09-01T20:00:00Z"), registradoEm: new Date(),
      },
    });

    await applyBridgeIdentity({
      gameStart: null,
      bet: { id: bet.id, identityStatus: null, evento: bet.evento, esporte: bet.esporte, mercado: bet.mercado,
        selecao: bet.selecao, data: bet.data, kickoffInferido: false },
      best: {
        match: { match_id: 4343, sport: "Soccer", league: "Brazil - Serie A", home: "Flamengo RJ", away: "Palmeiras SP",
          match_date: "2026-09-01T20:00:00Z" },
        swapped: true, score: 1.9,
      },
      via: "AUTO",
      teams: { home: "Palmeiras", away: "Flamengo" },
      confidence: 95,
    });

    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { evento: true, selecao: true } }))
      .toEqual({ evento: "Flamengo RJ vs Palmeiras SP", selecao: "Palmeiras SP -0.5" });
  });

  it.each([
    // A Bridge ficou com 20:00, o horário da primeira listagem.
    ["com a Pinnacle17, vale o horário dela (jogo antecipado 3 h)", new Date("2026-09-01T17:00:00Z"), false, "2026-09-01T22:00:00Z", "2026-09-01T17:00:00.000Z"],
    ["sem a Pinnacle17, o horário do post fica, mesmo diferente do da Bridge", null, false, "2026-09-01T22:00:00Z", "2026-09-01T22:00:00.000Z"],
    ["sem a Pinnacle17 e sem hora no post, o match_date preenche", null, true, "2026-09-01T03:00:00Z", "2026-09-01T20:00:00.000Z"],
  ] as const)("horário do jogo casado pela Bridge: %s", async (_caso, gameStart, inferido, betData, esperado) => {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Banca horario", slug: `banca-horario-${betData}` } });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id, evento: "Palmeiras vs Sao Paulo", esporte: "Soccer", competicao: "", pais: "",
        mercado: "Match Odds", selecao: "Palmeiras", odds: 1.95, stake: 1, status: "PENDING",
        sportResolutionStatus: "CONFIRMED", sportConfidence: 95, sportSource: "TEXT", sportResolvedAt: new Date(),
        data: new Date(betData), kickoffInferido: inferido, registradoEm: new Date(),
      },
    });

    await applyBridgeIdentity({
      bet: { id: bet.id, identityStatus: null, evento: bet.evento, esporte: bet.esporte, mercado: bet.mercado,
        selecao: bet.selecao, data: bet.data, kickoffInferido: inferido },
      best: {
        match: { match_id: 5151, sport: "Soccer", league: "Brazil - Serie A", home: "Palmeiras", away: "Sao Paulo",
          match_date: "2026-09-01T20:00:00Z" },
        swapped: false, score: 2,
      },
      via: "AUTO",
      teams: { home: "Palmeiras", away: "Sao Paulo" },
      confidence: 100,
      gameStart,
    });

    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { data: true, kickoffInferido: true } });
    expect(updated.data.toISOString()).toBe(esperado);
    expect(updated.kickoffInferido).toBe(false);
  });
});

describe("bridgeMatchGameStart", () => {
  const match = { match_id: 5151, sport: "Futebol", match_date: "2026-09-01T20:00:00Z" };
  const betKickoff = new Date("2026-09-02T01:00:00Z");

  it("procura o jogo da Pinnacle17 pelo id da Bridge nos dias do match_date e da aposta", async () => {
    findEvent.mockResolvedValueOnce({ id: 5151, startTime: "2026-09-01T17:00:00.000Z" });
    await expect(bridgeMatchGameStart(match, betKickoff)).resolves.toEqual(new Date("2026-09-01T17:00:00Z"));
    expect(findEvent).toHaveBeenCalledWith({
      sportId: 29, eventId: "5151", around: [new Date("2026-09-01T20:00:00Z"), betKickoff],
    });
  });

  it("sem o jogo, com falha da Pinnacle17 ou esporte que ela não tem: null", async () => {
    findEvent.mockResolvedValueOnce(null);
    await expect(bridgeMatchGameStart(match, betKickoff)).resolves.toBeNull();
    findEvent.mockRejectedValueOnce(new Error("circuito aberto"));
    await expect(bridgeMatchGameStart(match, betKickoff)).resolves.toBeNull();
    findEvent.mockClear();
    await expect(bridgeMatchGameStart({ ...match, sport: "Xadrez" }, betKickoff)).resolves.toBeNull();
    expect(findEvent).not.toHaveBeenCalled();
  });
});


it("a Bridge mantém o mando do placar ao vivo mesmo com snapshot antigo sem o placar", async () => {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Live", slug: "live" } });
  const bet = await db.prisma.bet.create({ data: {
    bankrollId: bankroll.id, evento: "Flamengo vs Palmeiras", esporte: "Soccer", mercado: "Asian Handicap",
    selecao: "Flamengo -0.5", odds: 2, stake: 1, data: new Date("2026-09-01T20:00:00Z"),
    sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(),
  } });
  await db.prisma.bet.update({ where: { id: bet.id }, data: { liveScoreHome: 1, liveScoreAway: 0 } });
  await applyBridgeIdentity({
    bet, teams: { home: "Flamengo", away: "Palmeiras" }, via: "LLM", confidence: 95, gameStart: null,
    best: { match: { match_id: 999, sport: "Soccer", home: "Palmeiras SP", away: "Flamengo RJ", league: "Brazil - Serie A", match_date: bet.data.toISOString() },
      swapped: true, score: 1.9 },
  });
  const saved = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
  expect(saved).toMatchObject({ evento: "Flamengo RJ vs Palmeiras SP", liveScoreHome: 1, liveScoreAway: 0 });
  expect(resolveResultFromScore({ ...saved, odds: 2, stake: 1, homeScore: 2, awayScore: 1 })).toMatchObject({ ok: true, status: "LOST" });
});


describe("histórico da identidade Pinnacle17", () => {
  it("persiste a decisão e os campos anteriores e posteriores na mesma aposta", async () => {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Pinnacle", slug: "pinnacle", sharpMode: "IDENTITY_ONLY" } });
    const bet = await db.prisma.bet.create({ data: { bankrollId: bankroll.id, evento: "Mengao vs Verdao", esporte: "Soccer",
      mercado: "Money Line – Match", selecao: "Mengao", data: new Date("2026-09-01T20:00:00Z"), odds: 2, stake: 1,
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date() }, include: { bankroll: true } });
    const event = { id: 4242, startTime: bet.data.toISOString(), league: { name: "Serie A", country: "Brazil" },
      homeTeam: { name: "Flamengo RJ" }, awayTeam: { name: "Palmeiras SP" } };
    resolvePinnacleSharp.mockResolvedValue({ matched: true, mainEvent: event, score: 2, swapped: false,
      current: null, priceReference: null, closingReservationCreated: false });
    await resolvePinnacle17Identity(bet, { home: "Mengao", away: "Verdao" }, upsertSharp);
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after.evento).toBe("Flamengo RJ vs Palmeiras SP");
    const audits = await db.prisma.auditEvent.findMany({ where: { action: "identidade_auto", resourceId: bet.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({ provider: "pinnacle17", providerMatchId: "4242",
      antes: { evento: bet.evento, pais: bet.pais, competicao: bet.competicao, selecao: bet.selecao },
      depois: { evento: after.evento, pais: after.pais, competicao: after.competicao, selecao: after.selecao } });
  });

  const AUTO_ACTIONS = { in: ["identidade_auto", "identidade_llm"] };
  async function seedBet(sharp?: { identityStatus: "MANUAL"; provider: string; providerMatchId: string }) {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Pinnacle", slug: "pinnacle", sharpMode: "IDENTITY_ONLY" } });
    return db.prisma.bet.create({ data: { bankrollId: bankroll.id, evento: "Mengao vs Verdao", esporte: "Soccer",
      mercado: "Money Line – Match", selecao: "Mengao", data: new Date("2026-09-01T20:00:00Z"), odds: 2, stake: 1,
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), ...(sharp ? { sharp: { create: sharp } } : {}) },
      include: { bankroll: true, sharp: true } });
  }
  const matchedEvent = (startTime: string) => ({ matched: true, score: 2, swapped: false, current: null, priceReference: null,
    closingReservationCreated: false, mainEvent: { id: 4242, startTime, league: { name: "Serie A", country: "Brazil" },
      homeTeam: { name: "Flamengo RJ" }, awayTeam: { name: "Palmeiras SP" } } });

  it("a reexecução que repete o mesmo jogo não acrescenta outro evento; a que muda a aposta, sim", async () => {
    const bet = await seedBet();
    resolvePinnacleSharp.mockResolvedValue(matchedEvent(bet.data.toISOString()));
    await resolvePinnacle17Identity(bet, { home: "Mengao", away: "Verdao" }, upsertSharp);
    const rerun = async () => resolvePinnacle17Identity(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id },
      include: { bankroll: true, sharp: true } }), { home: "Mengao", away: "Verdao" }, upsertSharp);

    await rerun();
    expect(await db.prisma.auditEvent.count({ where: { action: AUTO_ACTIONS, resourceId: bet.id } })).toBe(1);

    // O jogo remarcado muda o horário da aposta: isso entra no histórico.
    resolvePinnacleSharp.mockResolvedValue(matchedEvent("2026-09-02T20:00:00.000Z"));
    await rerun();
    const audits = await db.prisma.auditEvent.findMany({ where: { action: AUTO_ACTIONS, resourceId: bet.id }, orderBy: { createdAt: "asc" } });
    expect(audits).toHaveLength(2);
    expect(audits[1]!.details).toMatchObject({ antes: { data: "2026-09-01T20:00:00.000Z" }, depois: { data: "2026-09-02T20:00:00.000Z" } });
  });

  it("aposta vinculada pelo dono não ganha evento de identidade automática", async () => {
    const bet = await seedBet({ identityStatus: "MANUAL", provider: "pinnacle17", providerMatchId: "4242" });
    resolvePinnacleSharp.mockResolvedValue(matchedEvent(bet.data.toISOString()));
    await resolvePinnacle17Identity(bet, { home: "Mengao", away: "Verdao" }, upsertSharp);
    expect(await db.prisma.auditEvent.count({ where: { action: AUTO_ACTIONS, resourceId: bet.id } })).toBe(0);
    expect(await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ identityStatus: "MANUAL", providerMatchId: "4242" });
  });
});
