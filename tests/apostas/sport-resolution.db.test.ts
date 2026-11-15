import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTeamCard } from "../helpers/team-cards";
import type * as ProviderCandidates from "@/src/services/bets/sport-resolution/provider-candidates";

// Busca web desligada por padrão, como no ambiente de teste; o bloco das
// vezes da web liga e controla a resposta.
const web = vi.hoisted(() => ({ available: vi.fn(() => false), search: vi.fn() }));
// O catálogo da Pinnacle17 real; o bloco do aprendizado injeta um candidato.
const pinnacle17 = vi.hoisted(() => ({
  candidates: vi.fn(),
  actual: undefined as undefined | typeof ProviderCandidates.findPinnacle17SportCandidates,
}));
const enrich = vi.hoisted(() => ({ enqueue: vi.fn(async () => "job") }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ enqueueSharpEnrich: enrich.enqueue }));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: vi.fn(async () => ({})) }));
vi.mock("@/src/infra/llm/gemini-search", async (original) => ({
  ...await original<typeof import("@/src/infra/llm/gemini-search")>(),
  isGeminiSearchAvailable: web.available,
}));
vi.mock("@/src/services/bets/sport-resolution/provider-candidates", async (original) => {
  const actual = await original<typeof ProviderCandidates>();
  pinnacle17.actual = actual.findPinnacle17SportCandidates;
  pinnacle17.candidates.mockImplementation(actual.findPinnacle17SportCandidates);
  return { ...actual, searchWebSportCandidate: web.search, findPinnacle17SportCandidates: pinnacle17.candidates };
});
import { resetEnvCacheForTests } from "@/src/infra/env";
import { SPORT_RESOLVER_VERSION, UNKNOWN_SPORT } from "@/src/domain/sports/detect";
import { findTeamIdentitySportCandidates } from "@/src/services/bets/sport-resolution/team-candidates";
import { LOCAL_IDENTITY_CANDIDATE_CONFIDENCE } from "@/src/services/bets/sport-resolution/decision";
import { resolveSportForCaptureAsync } from "@/src/services/bets/sport-resolution/capture";
import { collectSportCandidates } from "@/src/services/bets/sport-resolution/collect-candidates";
import { resolvePendingBetSport } from "@/src/services/bets/sport-resolution/resolve";
import { applySportResolutionPlan, buildSportResolutionPlan, resolvePendingSportsForOperator } from "@/src/services/bets/sport-resolution/operator";
import { persistCandidates } from "@/src/services/bets/sport-resolution/persistence";
import * as providerCache from "@/src/providers/provider-cache";
import { SportResolutionStatus } from "@/src/generated/prisma/enums";
import { sportPendingMessage } from "@/src/domain/sport-pending";

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

/** Ficha com o nome do FlashScore e o da Pinnacle (2 jogos) iguais a `name`. */
async function seedCard(name: string, sport: string, options: {
  country?: string;
  pinnacleGames?: number;
  flashscoreName?: string;
  tipsterNames?: Array<{ name: string; status?: "pending" | "confirmed" }>;
} = {}) {
  await seedTeamCard(db.prisma, {
    sport, flashscoreTeamId: `fs-${sport}-${name}-${options.country ?? ""}`, flashscoreName: options.flashscoreName ?? name,
    country: options.country ?? "", pinnacleNames: [{ name, games: options.pinnacleGames ?? 2 }],
    tipsterNames: options.tipsterNames ?? [],
  });
}

describe("esporte pelas fichas dos times", () => {
  it("acha o basquete pelos nomes de tipster confirmados nas duas fichas, como pista abaixo de 70", async () => {
    await seedCard("CD Colegio Los Leones", "Basketball", { country: "Chile", tipsterNames: [{ name: "Leones Quilpue" }] });
    await seedCard("CD Universidad de Concepcion", "Basketball", { country: "Chile", tipsterNames: [{ name: "Universidad de Concepcion" }] });

    await expect(findTeamIdentitySportCandidates("Leones Quilpue vs Universidad de Concepcion")).resolves.toEqual([
      expect.objectContaining({
        sport: "Basketball",
        confidence: LOCAL_IDENTITY_CANDIDATE_CONFIDENCE,
        source: "TEAM_ID",
        provider: "team_identity",
        strategy: "team_cards",
      }),
    ]);
  });

  it("não acha quando um nome leva a duas fichas", async () => {
    await seedCard("Universidad", "Basketball", { country: "Chile" });
    await seedCard("Universidad", "Basketball", { country: "Peru" });
    await seedCard("Leones", "Basketball", { country: "Chile" });

    await expect(findTeamIdentitySportCandidates("Leones vs Universidad")).resolves.toEqual([]);
  });

  it("acha pelo nome da Pinnacle de um lado e pelo nome do FlashScore do outro", async () => {
    await seedCard("CA Tigre", "Soccer", { country: "Argentina", flashscoreName: "Tigre" });
    await seedCard("Central Cordoba SdE", "Soccer", { country: "Argentina", flashscoreName: "Central Cordoba" });

    await expect(findTeamIdentitySportCandidates("CA Tigre vs Central Cordoba")).resolves.toEqual([
      expect.objectContaining({ sport: "Soccer", confidence: LOCAL_IDENTITY_CANDIDATE_CONFIDENCE, strategy: "team_cards" }),
    ]);
  });

  it("nome da Pinnacle visto num jogo só e nome de tipster pendente não acham a ficha", async () => {
    await seedCard("Ashton United", "Soccer", { country: "England", pinnacleGames: 1, flashscoreName: "Ashton" });
    await seedCard("Ilkeston Town", "Soccer", { country: "England", tipsterNames: [{ name: "Ilkeston", status: "pending" }] });

    await expect(findTeamIdentitySportCandidates("Ashton United vs Ilkeston Town")).resolves.toEqual([]);
    await expect(findTeamIdentitySportCandidates("Ashton vs Ilkeston")).resolves.toEqual([]);
    await expect(findTeamIdentitySportCandidates("Ashton vs Ilkeston Town")).resolves.toEqual([
      expect.objectContaining({ sport: "Soccer", strategy: "team_cards" }),
    ]);
  });

  it("desambigua times homônimos quando o país do contexto é informado", async () => {
    await seedCard("Huracan", "Soccer", { country: "Argentina" });
    await seedCard("Huracan", "Soccer", { country: "Uruguay" });
    await seedCard("Velez Sarsfield", "Soccer", { country: "Argentina" });

    // Sem país: ambiguidade -> falha fechado (retorna vazio)
    await expect(findTeamIdentitySportCandidates("Huracan vs Velez Sarsfield")).resolves.toEqual([]);

    // Com país: desambigua para o Huracan argentino
    await expect(
      findTeamIdentitySportCandidates("Huracan vs Velez Sarsfield", { pais: "Argentina" }),
    ).resolves.toEqual([
      expect.objectContaining({ sport: "Soccer", confidence: LOCAL_IDENTITY_CANDIDATE_CONFIDENCE, strategy: "team_cards" }),
    ]);
  });
});

/** Os mesmos dois times com ficha no basquete e no futebol. */
async function seedHomonymIdentities() {
  for (const sport of ["Basketball", "Soccer"]) {
    for (const name of ["Leones", "Concepcion"]) await seedCard(name, sport);
  }
}

describe("resolvePendingBetSport persiste conflito sem inventar esporte", () => {
  const bridgeEnv = {
    BRIDGEODDS_URL: process.env.BRIDGEODDS_URL,
    BRIDGEODDS_USER: process.env.BRIDGEODDS_USER,
    BRIDGEODDS_PASS: process.env.BRIDGEODDS_PASS,
  };

  beforeEach(() => {
    delete process.env.BRIDGEODDS_URL;
    delete process.env.BRIDGEODDS_USER;
    delete process.env.BRIDGEODDS_PASS;
    resetEnvCacheForTests();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(bridgeEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCacheForTests();
  });

  async function seedHomonymBet(channelSports: string[], overrides: Record<string, unknown> = {}) {
    await seedHomonymIdentities();
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Canal", slug: "sport-channel", channelSports } });
    return db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id, data: new Date("2026-08-20T18:00:00Z"), evento: "Leones vs Concepcion", esporte: UNKNOWN_SPORT,
        mercado: "Moneyline", selecao: "Leones", odds: 2, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 0,
        sportSource: "UNRESOLVED", source: "test", sourceExternalId: "sport-channel",
        ...overrides,
      },
    });
  }

  it.each([[["Basketball", "Volleyball"]], [["Basketball"]]])("esportes do canal %j desempatam time homônimo", async (channelSports) => {
    const bet = await seedHomonymBet(channelSports);
    const run = await resolvePendingBetSport(bet.id, { now: new Date("2026-08-20T18:05:00Z") });
    expect(run).toMatchObject({ status: "resolved", candidate: { sport: "Basketball" } });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ esporte: "Basketball", sportResolutionStatus: "CONFIRMED" });
  });

  it("conflito apontado pela captura fica para o dono mesmo com candidato forte, e a leitura dela é preservada", async () => {
    const signals = [
      { source: "EMOJI", sport: "Soccer", confidence: 95, value: "⚽" },
      { source: "CHANNEL", sport: "Basketball", confidence: 95, value: "esportes do canal" },
    ];
    const bet = await seedHomonymBet(["Basketball"], { sportResolutionStatus: "CONFLICT", sportEvidence: signals });
    const now = new Date("2026-08-20T18:05:00Z");

    expect(await resolvePendingBetSport(bet.id, { now })).toMatchObject({ status: "conflict", reason: "capture_conflict" });
    const row = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(row).toMatchObject({ esporte: UNKNOWN_SPORT, sportResolutionStatus: "CONFLICT" });
    expect(row.sportEvidence).toMatchObject({
      candidates: expect.arrayContaining([expect.objectContaining({ sport: "Basketball" })]),
      capture: { status: "CONFLICT", signals },
    });

    // Numa segunda passada a leitura da captura continua lá.
    expect(await resolvePendingBetSport(bet.id, { now })).toMatchObject({ status: "conflict", reason: "capture_conflict" });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).sportEvidence)
      .toMatchObject({ capture: { status: "CONFLICT", signals } });

    // A execução forçada é o dono pedindo a resolução.
    expect(await resolvePendingBetSport(bet.id, { now, force: true })).toMatchObject({ status: "resolved", candidate: { sport: "Basketball" } });
  });

  it("o canal só desempata sem candidato forte: web forte de fora do canal vira conflito", async () => {
    web.available.mockReturnValue(true);
    web.search.mockResolvedValue({ answered: true, candidate: {
      sport: "Basketball", confidence: 95, source: "WEB", provider: "web", strategy: "grounded_search",
      competition: "LNB", country: "Chile", kickoffIso: "2026-08-20T18:00:00.000Z",
    } });
    try {
      // Homônimo em futebol e basquete; o canal marca só futebol.
      const bet = await seedHomonymBet(["Soccer"]);
      expect(await resolvePendingBetSport(bet.id, { attempt: 1, now: new Date("2026-08-20T18:05:00Z") }))
        .toMatchObject({ status: "conflict", reason: "outside_channel_sports" });
      expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
        .toMatchObject({ esporte: UNKNOWN_SPORT, sportResolutionStatus: "CONFLICT" });
    } finally {
      web.available.mockReturnValue(false);
      web.search.mockReset();
    }
  });

  it("homônimo só fora dos esportes do canal fica pendente: o nome não prova o jogo", async () => {
    const bet = await seedHomonymBet(["Tennis"]);
    expect(await resolvePendingBetSport(bet.id, { now: new Date("2026-08-20T18:05:00Z") })).toMatchObject({ status: "pending" });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ esporte: UNKNOWN_SPORT, sportResolutionStatus: "PENDING" });
  });

  it("homônimos com ficha nos dois esportes, sem canal, ficam pendentes e sem esporte", async () => {
    await seedHomonymIdentities();
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Sem canal", slug: "sport-homonym" } });
    const bet = await db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data: new Date("2026-08-20T18:00:00Z"), evento: "Leones vs Concepcion", esporte: UNKNOWN_SPORT,
      mercado: "Moneyline", selecao: "Leones", odds: 2, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 0,
      sportSource: "UNRESOLVED", source: "test", sourceExternalId: "sport-homonym",
    } });

    const run = await resolvePendingBetSport(bet.id, { now: new Date("2026-08-20T18:05:00Z") });
    expect(run).toMatchObject({ status: "pending", candidate: null });
    expect(run.candidates.filter((c) => c.source === "TEAM_ID").map((c) => c.confidence))
      .toEqual([LOCAL_IDENTITY_CANDIDATE_CONFIDENCE, LOCAL_IDENTITY_CANDIDATE_CONFIDENCE]);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .toMatchObject({ esporte: UNKNOWN_SPORT, sportResolutionStatus: "PENDING", sportResolvedAt: null });
  });
});

describe("persistência e resolução contra edição concorrente", () => {
  it("persistCandidates com CAS não sobrescreve aposta CONFIRMED quando recebe PENDING ou CONFLICT", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "CAS Bankroll", slug: "cas-bankroll" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        evento: "Santos vs Sao Paulo",
        esporte: "Soccer",
        competicao: "Paulista",
        pais: "Brasil",
        mercado: "Match Odds",
        selecao: "Santos",
        odds: 2.20,
        stake: 1.0,
        status: "PENDING",
        sportResolutionStatus: "CONFIRMED",
        sportConfidence: 95,
        sportSource: "TEAM_ID",
        sportResolvedAt: new Date(),
        data: new Date(),
        registradoEm: new Date(),
        captureEvidence: {
          create: {
            parser: "universal",
            parsedJson: { evento: "Santos vs Sao Paulo" },
            expiresAt: new Date("2026-12-31T00:00:00Z"),
          },
        },
      },
    });

    // Tentativa concorrente de persistir PENDING
    await expect(persistCandidates(bet, [], SportResolutionStatus.PENDING, null)).rejects.toThrow(/mudou durante/);

    let betInDb = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(betInDb.sportResolutionStatus).toBe("CONFIRMED");
    expect(betInDb.esporte).toBe("Soccer");
    expect(betInDb.sportConfidence).toBe(95);

    // Tentativa concorrente de persistir CONFLICT
    await expect(persistCandidates(bet, [], SportResolutionStatus.CONFLICT, null)).rejects.toThrow(/mudou durante/);

    betInDb = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(betInDb.sportResolutionStatus).toBe("CONFIRMED");
    expect(betInDb.esporte).toBe("Soccer");

    // Para aposta que realmente está PENDING, persistCandidates atualiza com sucesso
    const pendingBet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        evento: "Gremio vs Inter",
        esporte: "Unknown",
        competicao: "Gaucho",
        pais: "Brasil",
        mercado: "Match Odds",
        selecao: "Gremio",
        odds: 2.0,
        stake: 1.0,
        status: "PENDING",
        sportResolutionStatus: "PENDING",
        sportConfidence: 0,
        sportSource: "UNRESOLVED",
        data: new Date(),
        registradoEm: new Date(),
      },
    });

    await persistCandidates(pendingBet, [], SportResolutionStatus.CONFLICT, null);
    const updatedPendingBet = await db.prisma.bet.findUniqueOrThrow({ where: { id: pendingBet.id } });
    expect(updatedPendingBet.sportResolutionStatus).toBe("CONFLICT");
  });

  it("resolvePendingBetSport preserva mercado e seleção vigentes editados manualmente", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Manual Edit Bank", slug: "manual-edit-bank" },
    });

    // A aposta foi capturada inicialmente como "Match Odds" / "Flamengo",
    // mas o operador editou manualmente para "Handicap Asiático +1.5" / "Palmeiras +1.5"
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        data: new Date("2026-08-20T18:00:00Z"),
        evento: "Flamengo vs Palmeiras",
        esporte: "Unknown",
        // A competição confirma o futebol no resolvedor.
        competicao: "Brasileirão",
        mercado: "Handicap Asiático +1.5", // Edição legítima do operador
        selecao: "Palmeiras +1.5",        // Edição legítima do operador
        odds: 1.95,
        stake: 1.0,
        sportResolutionStatus: "PENDING",
        sportConfidence: 0,
        sportSource: "UNRESOLVED",
        source: "test",
        sourceExternalId: "manual-edit-preserved",
        captureEvidence: {
          create: {
            parser: "universal",
            // parsedJson contém os termos originais crus do OCR/Telegram
            parsedJson: {
              evento: "Flamengo vs Palmeiras",
              mercado: "Match Odds",
              selecao: "Flamengo",
            },
            expiresAt: new Date("2026-12-31T00:00:00Z"),
          },
        },
      },
    });

    const run = await resolvePendingBetSport(bet.id, {
      now: new Date("2026-08-20T18:05:00Z"),
    });

    expect(run.status).toBe("resolved");
    expect(run.candidate?.sport).toBe("Soccer");

    const betAfter = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(betAfter.sportResolutionStatus).toBe("CONFIRMED");
    expect(betAfter.esporte).toBe("Soccer");
    // Invariante crucial: mercado e seleção vigentes foram PRESERVADOS, não sobrescritos por parsedJson
    expect(betAfter.mercado).toBe("Handicap Asiático +1.5");
    expect(betAfter.selecao).toBe("Palmeiras +1.5");
  });
});

describe("identidade local dos times contra o post, o canal e a linha", () => {
  /** Clubes de futebol com ficha: a base local diz "Soccer". */
  async function seedSoccerClubs() {
    for (const name of ["Flamengo", "Corinthians"]) await seedCard(name, "Soccer", { country: "Brazil" });
  }

  const bet = {
    evento: "Flamengo vs Corinthians", esporte: UNKNOWN_SPORT, competicao: "", pais: "",
    mercado: "Total", selecao: "Over 160.5", odds: 1.9, stake: 1, data: new Date("2026-08-20T18:00:00Z"), casaDeAposta: "",
  };
  const llmBasketball = {
    sport: "Basketball" as const, status: "PENDING" as const, confidence: 80, source: "LLM" as const,
    evidence: [{ source: "LLM" as const, sport: "Basketball" as const, confidence: 80, value: "classificação estruturada" }],
    resolverVersion: SPORT_RESOLVER_VERSION,
  };

  it("total de basquete não vira futebol pela identidade dos times", async () => {
    await seedSoccerClubs();
    const decision = await resolveSportForCaptureAsync({ bet, caption: "Flamengo vs Corinthians\nOver 160.5" });
    expect(decision).toMatchObject({ status: "PENDING" });
    expect(decision.sport).not.toBe("Soccer");
  });

  it("canal só de futebol com total 160.5 vira conflito, não confirmação pela identidade", async () => {
    await seedSoccerClubs();
    const decision = await resolveSportForCaptureAsync({ bet, caption: "Over 160.5", channelSports: ["Soccer"] });
    expect(decision).toMatchObject({ status: "CONFLICT", sport: null });
  });

  it("IA lendo basquete não é atropelada pela identidade de futebol", async () => {
    await seedSoccerClubs();
    const decision = await resolveSportForCaptureAsync({
      bet: { ...bet, selecao: "Over 2.5", sportResolution: llmBasketball }, caption: "Over 2.5",
    });
    expect(decision).toMatchObject({ status: "PENDING", sport: "Basketball" });
  });

  it("a identidade com id não confirma a captura, com a IA de outro esporte fraca ou firme", async () => {
    await seedSoccerClubs();
    const llm = (confidence: number) => ({ ...llmBasketball, confidence, evidence: [{ ...llmBasketball.evidence[0]!, confidence }] });
    const weak = await resolveSportForCaptureAsync({ bet: { ...bet, selecao: "Over 2.5", sportResolution: llm(40) }, caption: "Over 2.5" });
    expect(weak).toMatchObject({ status: "PENDING", sport: "Basketball" });
    const firm = await resolveSportForCaptureAsync({ bet: { ...bet, selecao: "Over 2.5", sportResolution: llm(70) }, caption: "Over 2.5" });
    expect(firm).toMatchObject({ status: "PENDING", sport: "Basketball" });
  });

  it("no canal de vários esportes, a IA fraca de fora dele vira conflito, mesmo com a identidade dentro", async () => {
    await seedSoccerClubs();
    const weakTennis = { ...llmBasketball, sport: "Tennis" as const, confidence: 40,
      evidence: [{ ...llmBasketball.evidence[0]!, sport: "Tennis" as const, confidence: 40 }] };
    const decision = await resolveSportForCaptureAsync({
      bet: { ...bet, selecao: "Over 2.5", sportResolution: weakTennis }, caption: "Over 2.5", channelSports: ["Soccer", "Basketball"],
    });
    expect(decision).toMatchObject({ status: "CONFLICT", sport: null });
  });

  it("no resolvedor, a identidade dos times não segura a web de outro esporte: Flamengo e Corinthians têm basquete", async () => {
    await seedSoccerClubs();
    // Sem a BridgeOdds, os catálogos não acham o jogo e a web tem a vez.
    vi.stubEnv("BRIDGEODDS_URL", "");
    resetEnvCacheForTests();
    web.available.mockReturnValue(true);
    web.search.mockResolvedValue({ answered: true, candidate: {
      sport: "Basketball", confidence: 90, source: "WEB", provider: "web", strategy: "grounded_search",
      competition: "NBB", country: "Brazil", kickoffIso: bet.data.toISOString(),
    } });
    try {
      const bankroll = await db.prisma.bankroll.create({ data: { nome: "IA fraca", slug: "ia-fraca" } });
      const weakLlm = { ...llmBasketball, confidence: 40, evidence: [{ ...llmBasketball.evidence[0]!, confidence: 40 }] };
      const pending = await db.prisma.bet.create({ data: {
        bankrollId: bankroll.id, data: bet.data, evento: bet.evento, esporte: UNKNOWN_SPORT, mercado: "Moneyline",
        selecao: "Flamengo", odds: 1.9, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 40,
        sportSource: "LLM", source: "test", sourceExternalId: "ia-fraca",
        captureEvidence: { create: { parser: "llm", parsedJson: { evento: bet.evento, sportResolution: weakLlm },
          expiresAt: new Date("2026-12-31T00:00:00Z") } },
      } });
      const run = await resolvePendingBetSport(pending.id, { attempt: 1, now: new Date("2026-08-20T17:00:00Z") });
      expect(run).toMatchObject({ status: "resolved", candidate: { sport: "Basketball", provider: "web" } });
      expect(run.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ sport: "Soccer", source: "TEAM_ID" })]));
    } finally {
      vi.unstubAllEnvs();
      resetEnvCacheForTests();
      web.available.mockReturnValue(false);
      web.search.mockReset();
    }
  });

  it("a ficha e o post coerente não confirmam sozinhos: quem confirma é quem acha o jogo", async () => {
    await seedSoccerClubs();
    const decision = await resolveSportForCaptureAsync({ bet: { ...bet, selecao: "Over 2.5" }, caption: "Over 2.5" });
    expect(decision).toMatchObject({ status: "PENDING", sport: null });
  });

  /** Futebol e basquete com os mesmos nomes. */
  async function seedMixedHomonyms() {
    await seedSoccerClubs();
    for (const name of ["Flamengo", "Corinthians"]) await seedCard(name, "Basketball", { country: "Brazil" });
  }
  const handicap = { ...bet, evento: "Flamengo x Corinthians", mercado: "Handicap", selecao: "Flamengo -4.5" };

  it("homônimo em dois esportes não confirma sozinho; o canal escolhe quando sobra um", async () => {
    await seedMixedHomonyms();
    expect(await findTeamIdentitySportCandidates("Flamengo x Corinthians")).toEqual(expect.arrayContaining([
      expect.objectContaining({ sport: "Soccer", confidence: LOCAL_IDENTITY_CANDIDATE_CONFIDENCE, strategy: "homonym_pair" }),
      expect.objectContaining({ sport: "Basketball", confidence: LOCAL_IDENTITY_CANDIDATE_CONFIDENCE, strategy: "homonym_pair" }),
    ]));

    const alone = await resolveSportForCaptureAsync({ bet: handicap, caption: "Flamengo x Corinthians\nFlamengo -4.5" });
    expect(alone).toMatchObject({ status: "PENDING", sport: null });

    const byChannel = await resolveSportForCaptureAsync({ bet: handicap, caption: "Flamengo -4.5", channelSports: ["Basketball", "Volleyball"] });
    expect(byChannel).toMatchObject({ status: "CONFIRMED", sport: "Basketball", source: "CHANNEL" });
  });

  it("no resolvedor, o homônimo misto também espera o canal", async () => {
    await seedMixedHomonyms();
    const seedBet = async (slug: string, channelSports: string[]) => {
      const bankroll = await db.prisma.bankroll.create({ data: { nome: slug, slug, channelSports } });
      return db.prisma.bet.create({ data: {
        bankrollId: bankroll.id, data: bet.data, evento: handicap.evento, esporte: UNKNOWN_SPORT, mercado: handicap.mercado,
        selecao: handicap.selecao, odds: 1.9, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 0,
        sportSource: "UNRESOLVED", source: "test", sourceExternalId: slug,
      } });
    };
    const now = new Date("2026-08-20T18:05:00Z");
    const alone = await seedBet("homonimo-sem-canal", []);
    expect(await resolvePendingBetSport(alone.id, { now })).toMatchObject({ status: "pending" });
    const inChannel = await seedBet("homonimo-canal", ["Basketball", "Volleyball"]);
    expect(await resolvePendingBetSport(inChannel.id, { now })).toMatchObject({ status: "resolved", candidate: { sport: "Basketball", source: "CHANNEL" } });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: inChannel.id } })).toMatchObject({ esporte: "Basketball", sportSource: "CHANNEL" });
  });

  it("nome de tipster pendente não entra na consulta", async () => {
    await seedSoccerClubs();
    await db.prisma.teamTipsterName.create({ data: {
      cardId: (await db.prisma.teamCard.findFirstOrThrow({ where: { flashscoreName: "Flamengo" } })).id,
      sport: "Soccer", country: "Brazil", category: "principal", name: "Mengao", nameNorm: "mengao",
      firstBetId: "bet-1", firstPinnacleEventId: "ev-1", firstDay: "2026-08-19",
    } });
    await expect(findTeamIdentitySportCandidates("Mengao vs Corinthians")).resolves.toEqual([]);
  });

  it("no resolvedor, o post, a linha e o placar desmentem a identidade, que sem eles é só pista", async () => {
    await seedSoccerClubs();
    const searchBet = { evento: bet.evento, data: bet.data, pais: "", competicao: "", mercado: "Total", selecao: "Over 160.5" };
    const identityOf = (candidates: Array<{ source: string; strategy?: string }>) => candidates.find((c) => c.source === "TEAM_ID")?.strategy;
    expect(identityOf(await collectSportCandidates(searchBet, []))).toBe("team_cards_contradicted");
    expect(identityOf(await collectSportCandidates({ ...searchBet, selecao: "Over 2.5" }, [], { postSports: ["Basketball"] })))
      .toBe("team_cards_contradicted");
    expect(identityOf(await collectSportCandidates({ ...searchBet, mercado: "Moneyline", selecao: "Flamengo" }, [], { postScores: [{ home: 77, away: 97 }] })))
      .toBe("team_cards_contradicted");

    const coherent = await collectSportCandidates({ ...searchBet, selecao: "Over 2.5" }, []);
    expect(coherent).toEqual([expect.objectContaining({
      sport: "Soccer", confidence: LOCAL_IDENTITY_CANDIDATE_CONFIDENCE, source: "TEAM_ID", strategy: "team_cards",
    })]);
  });

  /** As fichas de futebol, com o "Botafogo" do tipster confirmado na do Botafogo FR RJ. */
  async function seedBotafogoFlamengo() {
    await seedCard("Botafogo FR RJ", "Soccer", { country: "Brazil", tipsterNames: [{ name: "Botafogo" }] });
    await seedCard("Flamengo", "Soccer", { country: "Brazil" });
  }
  const botafogoPost = "Botafogo 77x97 Flamengo\nFlamengo +8.5\nFlamengo ML";
  const botafogoBets = [
    { ...bet, evento: "Botafogo vs Flamengo", mercado: "Handicap", selecao: "Flamengo +8.5" },
    { ...bet, evento: "Botafogo vs Flamengo", mercado: "Moneyline", selecao: "Flamengo" },
  ];

  it("Botafogo 77x97 Flamengo, com +8.5 e ML: os nomes de futebol não confirmam futebol", async () => {
    await seedBotafogoFlamengo();
    expect(await findTeamIdentitySportCandidates("Botafogo vs Flamengo"))
      .toEqual([expect.objectContaining({ sport: "Soccer", strategy: "team_cards" })]);
    for (const parsed of botafogoBets) {
      expect(await resolveSportForCaptureAsync({ bet: parsed, caption: botafogoPost })).toMatchObject({ status: "PENDING", sport: null });
      // O canal marcado só com futebol não confirma: o +8.5 e o 77x97 discordam.
      expect(await resolveSportForCaptureAsync({ bet: parsed, caption: botafogoPost, channelSports: ["Soccer"] }))
        .toMatchObject({ status: "PENDING", sport: null });
      expect(await resolveSportForCaptureAsync({ bet: parsed, caption: botafogoPost, channelSports: ["Basketball"] }))
        .toMatchObject({ status: "CONFIRMED", sport: "Basketball", source: "CHANNEL" });
    }
  });

  it("no resolvedor, o placar do post desmente os nomes de futebol da aposta ML", async () => {
    await seedBotafogoFlamengo();
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Botafogo", slug: "botafogo-basquete" } });
    const moneyline = botafogoBets[1]!;
    const stored = await db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data: bet.data, evento: moneyline.evento, esporte: UNKNOWN_SPORT, mercado: moneyline.mercado,
      selecao: moneyline.selecao, odds: 1.9, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 0,
      sportSource: "UNRESOLVED", source: "test", sourceExternalId: "botafogo-ml",
      captureEvidence: { create: { parser: "llm", caption: botafogoPost, parsedJson: { evento: moneyline.evento },
        expiresAt: new Date("2026-12-31T00:00:00Z") } },
    } });
    const run = await resolvePendingBetSport(stored.id, { now: new Date("2026-08-20T18:05:00Z"), evaluateOnly: true });
    expect(run.status).toBe("pending");
    expect(run.candidates).toEqual([expect.objectContaining({ sport: "Soccer", source: "TEAM_ID", strategy: "team_cards_contradicted" })]);
  });

  it("o resolvedor lê a IA gravada na captura e deixa a aposta pendente", async () => {
    await seedSoccerClubs();
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Basquete", slug: "basquete-identidade" } });
    const pending = await db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data: bet.data, evento: bet.evento, esporte: UNKNOWN_SPORT, mercado: "Moneyline",
      selecao: "Flamengo", odds: 1.9, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 80,
      sportSource: "LLM", source: "test", sourceExternalId: "basquete-identidade",
      captureEvidence: { create: { parser: "llm", parsedJson: { evento: bet.evento, sportResolution: llmBasketball },
        expiresAt: new Date("2026-12-31T00:00:00Z") } },
    } });
    const run = await resolvePendingBetSport(pending.id, { now: new Date("2026-08-20T18:05:00Z"), evaluateOnly: true });
    expect(run.status).toBe("pending");
    expect(run.candidates.find((c) => c.source === "TEAM_ID")?.confidence).toBeLessThan(92);
  });
});

describe("critério único no resolvedor", () => {
  const KICKOFF = new Date("2026-08-21T14:00:00Z");
  const now = new Date("2026-08-20T14:00:00Z");
  const webBasketball = (confidence: number, detail: { competition?: string; country?: string } = { competition: "LNB", country: "Chile" }) => ({
    sport: "Basketball" as const, confidence, source: "WEB" as const, provider: "web" as const, strategy: "grounded_search",
    kickoffIso: KICKOFF.toISOString(), ...detail,
  });

  beforeEach(() => {
    vi.stubEnv("BRIDGEODDS_URL", "");
    resetEnvCacheForTests();
    web.available.mockReturnValue(true);
    web.search.mockReset();
  });
  afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });
  afterAll(() => { web.available.mockReturnValue(false); });

  async function pendingBet(options: { slug: string; evento?: string; competicao?: string; pais?: string; llm?: { sport: string; confidence: number } }) {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: options.slug, slug: options.slug } });
    const evento = options.evento ?? "Time Raro vs Outro Raro";
    const llm = options.llm;
    return db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data: KICKOFF, evento, esporte: UNKNOWN_SPORT, competicao: options.competicao ?? "", pais: options.pais ?? "",
      mercado: "Moneyline", selecao: evento.split(" vs ")[0]!, odds: 2, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 0,
      sportSource: "UNRESOLVED", source: "test", sourceExternalId: options.slug,
      ...(llm ? { captureEvidence: { create: { parser: "llm", expiresAt: new Date("2026-12-31T00:00:00Z"), parsedJson: {
        evento, sportResolution: { status: "PENDING", sport: llm.sport, confidence: llm.confidence, source: "LLM",
          evidence: [{ source: "LLM", sport: llm.sport, confidence: llm.confidence, value: "classificação estruturada" }] },
      } } } } : {}),
    } });
  }

  it("a leitura do post que discorda do jogo achado vira conflito, e a caixa de ações diz quem", async () => {
    web.search.mockResolvedValue({ answered: true, candidate: webBasketball(95) });
    const bet = await pendingBet({ slug: "post-discorda", llm: { sport: "Soccer", confidence: 85 } });

    expect(await resolvePendingBetSport(bet.id, { attempt: 1, now })).toMatchObject({
      status: "conflict", reason: "post_dissent", dissent: { sport: "Soccer", source: "LLM", confidence: 85, fromPost: true },
    });
    const row = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(row).toMatchObject({ esporte: UNKNOWN_SPORT, sportResolutionStatus: "CONFLICT" });
    expect(sportPendingMessage(row.sportEvidence)).toBe("A busca achou o jogo, mas a leitura da IA aponta Soccer (85%).");

    // O plano do operador mostra a discordância que a execução forçada não deixa segurar.
    expect(await buildSportResolutionPlan({ betId: bet.id, executor: "agent:claude:por:operador", now })).toMatchObject({
      ok: true, plan: { item: { candidate: { sport: "Basketball" }, overriddenPostDissent: { sport: "Soccer", source: "LLM", confidence: 85 } } },
    });
    // A execução forçada é o dono pedindo a resolução.
    expect(await resolvePendingBetSport(bet.id, { attempt: 1, now, force: true })).toMatchObject({
      status: "resolved", candidate: { sport: "Basketball" }, overriddenPostDissent: { sport: "Soccer" },
    });
  });

  it("identidade só de nomes em outro esporte não segura a web: Flamengo e Corinthians têm basquete", async () => {
    for (const name of ["Flamengo", "Corinthians"]) await seedCard(name, "Soccer", { country: "Brazil" });
    web.search.mockResolvedValue({ answered: true, candidate: webBasketball(95) });
    const bet = await pendingBet({ slug: "nomes-discordam", evento: "Flamengo vs Corinthians" });

    const run = await resolvePendingBetSport(bet.id, { attempt: 1, now });
    expect(run).toMatchObject({ status: "resolved", candidate: { sport: "Basketball", provider: "web" } });
    expect(run.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sport: "Soccer", confidence: LOCAL_IDENTITY_CANDIDATE_CONFIDENCE, provider: "team_identity" }),
    ]));
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ esporte: "Basketball", sportResolutionStatus: "CONFIRMED" });
  });

  it("a web confirma a partir de 90 quando a fonte acrescenta detalhe, e não confirma repetindo a aposta", async () => {
    web.search.mockResolvedValue({ answered: true, candidate: webBasketball(90) });
    const withDetail = await pendingBet({ slug: "web-90" });
    expect(await resolvePendingBetSport(withDetail.id, { attempt: 1, now })).toMatchObject({ status: "resolved", candidate: { sport: "Basketball", confidence: 90 } });

    web.search.mockResolvedValue({ answered: true, candidate: webBasketball(95) });
    const echo = await pendingBet({ slug: "web-eco", competicao: "LNB", pais: "Chile" });
    expect(await resolvePendingBetSport(echo.id, { attempt: 1, now })).toMatchObject({ status: "pending", reason: "web_without_detail" });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: echo.id } })).toMatchObject({ sportResolutionStatus: "PENDING", esporte: UNKNOWN_SPORT });
  });
});

describe("o resolvedor no lugar da triagem", () => {
  const KICKOFF = new Date("2026-08-21T14:00:00Z");
  const HOUR = 3_600_000;

  // Sem BridgeOdds: a espera de capacidade dele não entra no caminho.
  beforeEach(() => { vi.stubEnv("BRIDGEODDS_URL", ""); resetEnvCacheForTests(); });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCacheForTests();
    web.available.mockReturnValue(false);
    web.search.mockReset();
  });

  async function pendingBet(slug: string, overrides: Record<string, unknown> = {}) {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: slug, slug } });
    return db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data: KICKOFF, evento: "Time Raro vs Outro Raro", esporte: UNKNOWN_SPORT,
      mercado: "Moneyline", selecao: "Time Raro", odds: 2, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 0,
      sportSource: "UNRESOLVED", source: "test", sourceExternalId: slug, ...overrides,
    } });
  }

  it("esgotado o backoff antes do jogo, ainda acorda perto dele, mesmo sem a web", async () => {
    const bet = await pendingBet("perto-do-jogo");
    // A última tentativa do backoff (3 rápidas + 12 de 2 h), um dia antes do jogo.
    expect(await resolvePendingBetSport(bet.id, { attempt: 15, now: new Date(KICKOFF.getTime() - 20 * HOUR) }))
      .toMatchObject({ status: "pending", nextWebSearchAt: new Date(KICKOFF.getTime() - 3 * HOUR) });
    expect(await resolvePendingBetSport(bet.id, { attempt: 16, now: new Date(KICKOFF.getTime() - 3 * HOUR) }))
      .toMatchObject({ status: "pending", nextWebSearchAt: new Date(KICKOFF.getTime() - 45 * 60_000) });
    expect(web.search).not.toHaveBeenCalled();
  });

  it("aposta liquidada tem o esporte confirmado sem trocar o horário que a liquidou", async () => {
    web.available.mockReturnValue(true);
    // O próximo confronto dos mesmos times, duas semanas depois.
    web.search.mockResolvedValue({ answered: true, candidate: {
      sport: "Basketball", confidence: 95, source: "WEB", provider: "web", strategy: "grounded_search",
      competition: "LNB", country: "Chile", kickoffIso: "2026-09-04T14:00:00.000Z",
    } });
    const posted = new Date("2026-08-21T00:00:00Z");
    const bet = await pendingBet("liquidada", { data: posted, kickoffInferido: true, status: "WON", lucro: 1, settledAt: KICKOFF });

    expect(await resolvePendingBetSport(bet.id, { attempt: 1, now: new Date(KICKOFF.getTime() + HOUR) }))
      .toMatchObject({ status: "resolved", candidate: { sport: "Basketball" } });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({
      esporte: "Basketball", sportResolutionStatus: "CONFIRMED", status: "WON", data: posted, kickoffInferido: true,
    });
  });
});

describe("ops-resolve-sport", () => {
  const EXECUTOR = "agent:claude:por:operador";
  const NOW = new Date("2026-08-20T18:05:00Z");

  beforeEach(async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
  });

  async function pendingBet(status: "PENDING" | "CONFIRMED" | "CONFLICT" = "PENDING", data = new Date("2026-08-20T18:00:00Z")) {
    if (await db.prisma.teamCard.count() === 0) await seedHomonymIdentities();
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Ops", slug: `ops-${status}-${data.getTime()}`, channelSports: ["Basketball"] } });
    return db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data, evento: "Leones vs Concepcion",
      esporte: status === "CONFIRMED" ? "Soccer" : UNKNOWN_SPORT, mercado: "Moneyline", selecao: "Leones", odds: 2, stake: 1,
      sportResolutionStatus: status, sportConfidence: status === "CONFIRMED" ? 100 : 0,
      sportSource: status === "CONFIRMED" ? "MANUAL" : "UNRESOLVED", sportResolvedAt: status === "CONFIRMED" ? NOW : null,
      // Conflito que a captura apontou: os sinais do post contra o canal.
      ...(status === "CONFLICT" ? { sportEvidence: [
        { source: "TEXT", sport: "Soccer", confidence: 95, value: "⚽" },
        { source: "CHANNEL", sport: "Basketball", confidence: 95, value: "esportes do canal" },
      ] } : {}),
      source: "test", sourceExternalId: `ops-${status}-${data.getTime()}`,
    } });
  }

  async function planOf(betId: string) {
    const result = await buildSportResolutionPlan({ betId, executor: EXECUTOR, now: NOW });
    if (!result.ok) throw new Error(`sem plano: ${result.run.status} ${result.run.reason}`);
    return result.plan;
  }

  it("--all pula as CONFLICT, inclusive as que nasceram em conflito na captura", async () => {
    const conflict = await pendingBet("CONFLICT");
    const pending = await pendingBet();
    const runs = await resolvePendingSportsForOperator({ executor: EXECUTOR, aplicar: true, now: NOW });
    expect(runs.map((run) => run.betId)).toEqual([pending.id]);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: conflict.id } }))
      .toMatchObject({ esporte: UNKNOWN_SPORT, sportResolutionStatus: "CONFLICT" });
    expect(await db.prisma.auditEvent.count({ where: { actor: EXECUTOR, resourceId: conflict.id } })).toBe(0);
    expect(await db.prisma.auditEvent.findFirstOrThrow({ where: { actor: EXECUTOR, resourceId: pending.id } }))
      .toMatchObject({ action: "bet.sport_resolve.operator", details: expect.objectContaining({ status: "resolved", forced: false }) });
  });

  it("--all não força: fica na janela do resolvedor, e só a aposta nomeada passa dela", async () => {
    const old = await pendingBet("PENDING", new Date("2026-08-01T18:00:00Z"));
    expect(await resolvePendingSportsForOperator({ executor: EXECUTOR, aplicar: false, now: NOW })).toEqual([]);
    expect((await planOf(old.id)).item.candidate).toMatchObject({ sport: "Basketball" });
  });

  it("--all começa pelas mais recentes e pula a PENDING que nasceu em conflito", async () => {
    const older = await pendingBet("PENDING", new Date("2026-08-20T17:00:00Z"));
    const newer = await pendingBet("PENDING", new Date("2026-08-20T19:00:00Z"));
    await db.prisma.bet.update({ where: { id: older.id }, data: { registradoEm: new Date("2026-08-20T10:00:00Z") } });
    await db.prisma.bet.update({ where: { id: newer.id }, data: { registradoEm: new Date("2026-08-20T12:00:00Z") } });
    // Forçada antes pelo dono, voltou a PENDING, mas a captura apontou conflito.
    const bornInConflict = await pendingBet("PENDING", new Date("2026-08-20T20:00:00Z"));
    await db.prisma.bet.update({ where: { id: bornInConflict.id }, data: { sportEvidence: {
      candidates: [], capture: { status: "CONFLICT", signals: [{ source: "TEXT", sport: "Soccer", confidence: 95, value: "⚽" }] },
    } } });

    const runs = await resolvePendingSportsForOperator({ executor: EXECUTOR, aplicar: false, now: NOW });
    expect(runs.map((run) => run.betId)).toEqual([newer.id, older.id]);
  });

  it("o plano mostra o que seria gravado, com a revisão lida, e não grava", async () => {
    enrich.enqueue.mockClear();
    const bet = await pendingBet();
    const plan = await planOf(bet.id);
    expect(plan).toMatchObject({
      version: 1, executor: EXECUTOR, createdAt: NOW.toISOString(), planHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      item: {
        betId: bet.id, expectedVersion: bet.manualSettlementVersion,
        preview: { evento: "Leones vs Concepcion", mercado: "Moneyline", selecao: "Leones" },
        candidate: { sport: "Basketball" },
        identity: { data: bet.data.toISOString(), kickoffInferido: false, competicao: "", pais: "" },
      },
    });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ esporte: UNKNOWN_SPORT, sportResolutionStatus: "PENDING" });
    expect(await db.prisma.auditEvent.count({ where: { actor: EXECUTOR } })).toBe(0);
    expect(enrich.enqueue).not.toHaveBeenCalled();
  });

  it("aplica o plano aprovado, registra o executor e manda para o enrich", async () => {
    enrich.enqueue.mockClear();
    const bet = await pendingBet();
    const plan = await planOf(bet.id);
    expect(await applySportResolutionPlan(plan, plan.planHash, EXECUTOR)).toEqual({ betId: bet.id, kind: "saved", sport: "Basketball" });
    expect(enrich.enqueue).toHaveBeenCalledExactlyOnceWith(expect.anything(), bet.id, { origem: "sport-resolved-operator" });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ esporte: "Basketball", sportResolutionStatus: "CONFIRMED" });
    expect(await db.prisma.auditEvent.findFirstOrThrow({ where: { actor: EXECUTOR, resourceId: bet.id } })).toMatchObject({
      action: "bet.sport_resolve.operator",
      details: expect.objectContaining({ sport: "Basketball", forced: true, planHash: plan.planHash }),
    });
    // Reaplicar o mesmo plano não grava de novo.
    expect(await applySportResolutionPlan(plan, plan.planHash, EXECUTOR)).toMatchObject({ kind: "refused", reason: "already_confirmed" });
  });

  it("grava o esporte e o jogo do plano, mesmo que o fornecedor diga outra coisa na hora de aplicar", async () => {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Plano", slug: "ops-plano" } });
    const bet = await db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data: new Date("2026-08-20T03:00:00Z"), kickoffInferido: true, evento: "Time Raro vs Outro Raro",
      esporte: UNKNOWN_SPORT, mercado: "Moneyline", selecao: "Time Raro", odds: 2, stake: 1, sportResolutionStatus: "PENDING",
      sportConfidence: 0, sportSource: "UNRESOLVED", source: "test", sourceExternalId: "ops-plano",
    } });
    pinnacle17.candidates.mockResolvedValue([{ sport: "Basketball", confidence: 95, source: "PROVIDER", provider: "pinnacle17",
      matchId: "p17-b", kickoffIso: "2026-08-20T23:00:00.000Z", competition: "LNB", country: "Chile" }]);
    try {
      const plan = await planOf(bet.id);
      pinnacle17.candidates.mockResolvedValue([{ sport: "Soccer", confidence: 95, source: "PROVIDER", provider: "pinnacle17",
        matchId: "p17-s", kickoffIso: "2026-08-21T01:00:00.000Z", competition: "Primera B", country: "Colombia" }]);
      expect(await applySportResolutionPlan(plan, plan.planHash, EXECUTOR)).toMatchObject({ kind: "saved", sport: "Basketball" });
      expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({
        esporte: "Basketball", sportResolutionStatus: "CONFIRMED", competicao: "LNB", pais: "Chile",
        data: new Date("2026-08-20T23:00:00.000Z"), kickoffInferido: false,
        sportEvidence: expect.objectContaining({ planHash: plan.planHash, selected: expect.objectContaining({ matchId: "p17-b" }) }),
      });
    } finally {
      pinnacle17.candidates.mockImplementation(pinnacle17.actual!);
    }
  });

  it("aposta que mudou depois do plano: recusa sem gravar", async () => {
    const bet = await pendingBet();
    const plan = await planOf(bet.id);
    await db.prisma.bet.update({ where: { id: bet.id }, data: { odds: 2.1 } });
    expect(await applySportResolutionPlan(plan, plan.planHash, EXECUTOR)).toMatchObject({ betId: bet.id, kind: "conflict" });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ esporte: UNKNOWN_SPORT, sportResolutionStatus: "PENDING" });
    expect(await db.prisma.auditEvent.count({ where: { actor: EXECUTOR } })).toBe(0);
  });

  it("plano editado depois de gerado ou hash que não é o dele: recusa sem gravar", async () => {
    const bet = await pendingBet();
    const plan = await planOf(bet.id);
    const edited = { ...plan, item: { ...plan.item, candidate: { ...plan.item.candidate, sport: "Soccer" } } };
    await expect(applySportResolutionPlan(edited, plan.planHash, EXECUTOR)).rejects.toThrow(/alterado/);
    await expect(applySportResolutionPlan(plan, "0".repeat(64), EXECUTOR)).rejects.toThrow(/hash aprovado/);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ sportResolutionStatus: "PENDING" });
  });

  it("só o executor do plano aplica, e a pedido de um usuário do painel", async () => {
    const bet = await pendingBet();
    const plan = await planOf(bet.id);
    await expect(applySportResolutionPlan(plan, plan.planHash, "agent:gemini:por:operador")).rejects.toThrow(/outro executor/);
    await db.prisma.authSessionState.deleteMany();
    await expect(applySportResolutionPlan(plan, plan.planHash, EXECUTOR)).rejects.toThrow(/não é usuário do painel/);
    await expect(resolvePendingSportsForOperator({ executor: EXECUTOR, aplicar: true, now: NOW })).rejects.toThrow(/não é usuário do painel/);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ sportResolutionStatus: "PENDING" });
    expect(await db.prisma.auditEvent.count({ where: { actor: EXECUTOR } })).toBe(0);
  });

  it("o esporte fica confirmado e segue para o enrich mesmo se a memória da busca na web não puder ser apagada", async () => {
    enrich.enqueue.mockClear();
    const bet = await pendingBet();
    const plan = await planOf(bet.id);
    const spy = vi.spyOn(providerCache, "deleteProviderCache").mockRejectedValueOnce(new Error("banco fora"));
    try {
      expect(await applySportResolutionPlan(plan, plan.planHash, EXECUTOR)).toMatchObject({ kind: "saved", sport: "Basketball" });
    } finally { spy.mockRestore(); }
    expect(enrich.enqueue).toHaveBeenCalledTimes(1);
  });

  it("aposta já CONFIRMED não gera plano", async () => {
    const bet = await pendingBet("CONFIRMED");
    expect(await buildSportResolutionPlan({ betId: bet.id, executor: EXECUTOR, now: NOW }))
      .toMatchObject({ ok: false, run: { status: "ignored", reason: "already_confirmed" } });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ esporte: "Soccer", sportSource: "MANUAL" });
  });

  it("exige executor agent:<nome>:por:<dono>", async () => {
    await expect(resolvePendingSportsForOperator({ executor: "sport-resolver", aplicar: true })).rejects.toThrow(/executor/);
    await expect(buildSportResolutionPlan({ betId: "x", executor: "sport-resolver" })).rejects.toThrow(/executor/);
  });
});

describe("a confirmação do esporte não ensina nome de time", () => {
  it("o jogo da Pinnacle17 confirma o futebol e nenhum nome é aprendido", async () => {
    const kickoff = new Date("2026-08-20T18:00:00Z");
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Sem alias", slug: "sport-no-alias" } });
    const bet = await db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data: kickoff, evento: "Flamengo vs Palmeiras", esporte: UNKNOWN_SPORT,
      mercado: "Moneyline", selecao: "Flamengo", odds: 2, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 0,
      sportSource: "UNRESOLVED", source: "test", sourceExternalId: "sport-no-alias",
    } });
    pinnacle17.candidates.mockResolvedValue([{
      sport: "Soccer", confidence: 95, source: "PROVIDER", provider: "pinnacle17", matchId: "p17-1",
      home: "Flamengo RJ", away: "Palmeiras SP", kickoffIso: kickoff.toISOString(), competition: "Brazil - Serie A",
    }]);
    try {
      const run = await resolvePendingBetSport(bet.id, { now: new Date("2026-08-20T18:05:00Z") });

      expect(pinnacle17.candidates).toHaveBeenCalled();
      expect(run).toMatchObject({ status: "resolved", candidate: { sport: "Soccer", provider: "pinnacle17" } });
      expect(await db.prisma.teamTipsterName.count()).toBe(0);
    } finally {
      pinnacle17.candidates.mockImplementation(pinnacle17.actual!);
    }
  });

  it("clássico multiesportivo: a unidade que a leitura escreveu desmente o jogo de futebol", async () => {
    const kickoff = new Date("2026-08-20T18:00:00Z");
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Clássico", slug: "sport-classico" } });
    // O registro normaliza "Handicap de Pontos" para "Asian Handicap": a unidade fica só na leitura.
    const bet = await db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data: kickoff, evento: "Real Madrid vs Barcelona", esporte: UNKNOWN_SPORT,
      mercado: "Asian Handicap", selecao: "Real Madrid -4.5", odds: 1.9, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 0,
      sportSource: "UNRESOLVED", source: "test", sourceExternalId: "sport-classico",
      captureEvidence: { create: { parser: "llm", expiresAt: new Date("2026-12-31T00:00:00Z"),
        parsedJson: { evento: "Real Madrid vs Barcelona", mercado: "Handicap de Pontos", selecao: "Real Madrid -4.5" } } },
    } });
    const game = (sport: "Soccer" | "Basketball") => ({
      sport, confidence: 95, source: "PROVIDER", provider: "pinnacle17", matchId: `p17-${sport}`,
      home: "Real Madrid", away: "Barcelona", kickoffIso: kickoff.toISOString(),
    });
    pinnacle17.candidates.mockResolvedValue([game("Soccer"), game("Basketball")]);
    try {
      const run = await resolvePendingBetSport(bet.id, { now: new Date("2026-08-20T12:00:00Z") });
      expect(run).toMatchObject({ status: "resolved", candidate: { sport: "Basketball", provider: "pinnacle17" } });
      expect(run.candidates).toContainEqual(expect.objectContaining({ sport: "Soccer", strategy: "pinnacle17_contradicted" }));
    } finally {
      pinnacle17.candidates.mockImplementation(pinnacle17.actual!);
    }
  });
});

describe("vezes da busca web do resolvedor, contadas do kickoff", () => {
  const KICKOFF = new Date("2026-08-21T14:00:00Z");
  const before = (ms: number) => new Date(KICKOFF.getTime() - ms);
  const HOUR = 3_600_000;
  const weakWeb = { sport: "Basketball", confidence: 88, source: "WEB", provider: "web", strategy: "grounded_search",
    kickoffIso: KICKOFF.toISOString(), competition: "LNB", country: "Chile" } as const;

  beforeEach(() => {
    // Sem BridgeOdds: a espera de capacidade dele não entra no caminho da web.
    vi.stubEnv("BRIDGEODDS_URL", "");
    resetEnvCacheForTests();
    web.available.mockReturnValue(true);
    web.search.mockReset();
    web.search.mockResolvedValue({ answered: true, candidate: weakWeb });
  });
  afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });
  afterAll(() => { web.available.mockReturnValue(false); });

  async function unknownBet(kickoffInferido = false) {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Web", slug: "web-memory" } });
    return db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data: KICKOFF, kickoffInferido, evento: "Time Raro vs Outro Raro", esporte: UNKNOWN_SPORT,
      mercado: "Moneyline", selecao: "Time Raro", odds: 2, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 0,
      sportSource: "UNRESOLVED", source: "test", sourceExternalId: "web-memory",
    } });
  }
  const webIn = (run: Awaited<ReturnType<typeof resolvePendingBetSport>>) => run.candidates.find((c) => c.provider === "web");
  async function searchedAt(betId: string, steps: Array<[number, Date]>) {
    const searched: number[] = [];
    for (const [attempt, now] of steps) {
      const calls = web.search.mock.calls.length;
      const run = await resolvePendingBetSport(betId, { attempt, now });
      if (web.search.mock.calls.length > calls) searched.push(attempt);
      expect(run.status).toBe("pending");
      expect(webIn(run), `tentativa ${attempt} sem o candidato da web`).toMatchObject({ sport: "Basketball", confidence: 88 });
    }
    return searched;
  }

  it("busca na tentativa 1, com menos de 3 h e com menos de 45 min, e reaproveita nas outras", async () => {
    const bet = await unknownBet();
    expect(await searchedAt(bet.id, [
      [1, before(20 * HOUR)], [2, before(19 * HOUR)], [4, before(10 * HOUR)],
      [5, before(2 * HOUR)], [6, before(HOUR)], [7, before(30 * 60_000)], [8, new Date(KICKOFF.getTime() + HOUR)],
    ])).toEqual([1, 5, 7]);
  });

  it("devolve quando abre a próxima vez", async () => {
    const bet = await unknownBet();
    expect(await resolvePendingBetSport(bet.id, { attempt: 1, now: before(20 * HOUR) })).toMatchObject({ nextWebSearchAt: before(3 * HOUR) });
    expect(await resolvePendingBetSport(bet.id, { attempt: 2, now: before(2 * HOUR) })).toMatchObject({ nextWebSearchAt: before(45 * 60_000) });
  });

  it("falha da busca não gasta a vez", async () => {
    const bet = await unknownBet();
    web.search.mockResolvedValueOnce({ answered: false, candidate: null });
    await resolvePendingBetSport(bet.id, { attempt: 1, now: before(20 * HOUR) });
    expect(web.search).toHaveBeenCalledTimes(1);
    await resolvePendingBetSport(bet.id, { attempt: 2, now: before(19 * HOUR) });
    expect(web.search).toHaveBeenCalledTimes(2);
    await resolvePendingBetSport(bet.id, { attempt: 3, now: before(18 * HOUR) });
    expect(web.search).toHaveBeenCalledTimes(2);
  });

  it("kickoff inferido só tem a primeira vez", async () => {
    const bet = await unknownBet(true);
    expect(await searchedAt(bet.id, [[1, before(20 * HOUR)], [5, before(2 * HOUR)], [7, before(30 * 60_000)]])).toEqual([1]);
  });

  it("aposta editada não reaproveita a resposta de outros termos", async () => {
    const bet = await unknownBet();
    await resolvePendingBetSport(bet.id, { attempt: 1, now: before(20 * HOUR) });
    await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: "Outro Jogo vs Mais Um" } });
    web.search.mockResolvedValue({ answered: true, candidate: null });
    expect(webIn(await resolvePendingBetSport(bet.id, { attempt: 2, now: before(19 * HOUR) }))).toBeUndefined();
  });

  it("a métrica da confirmação diz a etapa e o tempo desde a captura; a simulação não grava", async () => {
    vi.stubEnv("OBSERVABILITY_METRICS_IN_TEST", "true");
    const bet = await unknownBet();
    web.search.mockResolvedValue({ answered: true, candidate: { ...weakWeb, confidence: 95 } });
    expect(await resolvePendingBetSport(bet.id, { attempt: 1, now: before(20 * HOUR), evaluateOnly: true })).toMatchObject({ status: "evaluated" });
    expect(await db.prisma.operationalMetric.count({ where: { name: "sport.resolve" } })).toBe(0);
    expect(await db.prisma.providerCache.count({ where: { provider: "sport-web" } })).toBe(0);

    expect(await resolvePendingBetSport(bet.id, { attempt: 1, now: before(20 * HOUR) })).toMatchObject({ status: "resolved" });
    const metric = await db.prisma.operationalMetric.findFirstOrThrow({ where: { name: "sport.resolve", labels: { path: ["result"], equals: "resolved" } } });
    expect(metric.labels).toMatchObject({ stage: "web", captureToResolutionMs: expect.any(Number) });
  });
});


describe("canal marcado depois da captura: a regra dele vale para a pendente", () => {
  const bridgeEnv = {
    BRIDGEODDS_URL: process.env.BRIDGEODDS_URL,
    BRIDGEODDS_USER: process.env.BRIDGEODDS_USER,
    BRIDGEODDS_PASS: process.env.BRIDGEODDS_PASS,
  };
  const now = new Date("2026-09-24T19:00:00Z");
  let seq = 0;

  beforeEach(() => {
    delete process.env.BRIDGEODDS_URL;
    delete process.env.BRIDGEODDS_USER;
    delete process.env.BRIDGEODDS_PASS;
    resetEnvCacheForTests();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(bridgeEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCacheForTests();
  });

  /** A aposta como a captura gravou com o canal em "vários/não sei"; depois o dono marcou o canal. */
  async function pendingBet(channelSports: string[], over: { selecao?: string; evidence?: Array<{ source: string; sport: string; confidence: number; value: string }> } = {}) {
    const slug = `canal-${++seq}`;
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Big Data", slug, channelSports } });
    const selecao = over.selecao ?? "Limanovia Limanowa +1.25";
    const evidence = over.evidence ?? [{ source: "LLM", sport: "Soccer", confidence: 85, value: "Handicap Asiático, Polonia" }];
    return db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, data: new Date("2026-09-25T20:00:00Z"), evento: "Unia Tarnow vs Limanovia Limanowa",
      esporte: UNKNOWN_SPORT, mercado: "Handicap – Match", selecao, odds: 1.9, stake: 1,
      sportResolutionStatus: "PENDING", sportConfidence: 0, sportSource: "UNRESOLVED", source: "test",
      sourceExternalId: slug,
      captureEvidence: { create: {
        parser: "gemini", caption: `Unia Tarnow x Limanovia Limanowa ${selecao}`,
        parsedJson: { evento: "Unia Tarnow vs Limanovia Limanowa", mercado: "Handicap – Match", selecao,
          sportResolution: { sport: null, status: "PENDING", confidence: 85, source: "UNRESOLVED", evidence, resolverVersion: SPORT_RESOLVER_VERSION } },
        expiresAt: new Date("2026-12-31T00:00:00Z"),
      } },
    } });
  }

  it("canal só de futebol confirma a pendente que nada desmente, como a captura faria", async () => {
    const bet = await pendingBet(["Soccer"]);
    expect(await resolvePendingBetSport(bet.id, { now }))
      .toMatchObject({ status: "resolved", candidate: { sport: "Soccer", source: "CHANNEL", strategy: "channel_only_sport" } });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .toMatchObject({ esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportSource: "CHANNEL" });
  });

  it("confirmado o futebol, o \"R\" de reserva dos dois times vira Reserva no evento e na seleção", async () => {
    const bet = await pendingBet(["Soccer"], { selecao: "Talleres R +0.5" });
    await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: "Talleres R vs Gimnasia Mendoza R" } });
    expect(await resolvePendingBetSport(bet.id, { now })).toMatchObject({ status: "resolved", candidate: { sport: "Soccer" } });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { evento: true, selecao: true } }))
      .toEqual({ evento: "Talleres Reserva vs Gimnasia Mendoza Reserva", selecao: "Talleres Reserva +0.5" });
  });

  it("não confirma quando o post aponta outro esporte, o canal tem vários ou a linha sai da escala", async () => {
    const otherSport = await pendingBet(["Soccer"], { evidence: [{ source: "LLM", sport: "Basketball", confidence: 85, value: "NBL" }] });
    const twoSports = await pendingBet(["Soccer", "Basketball"]);
    const outOfScale = await pendingBet(["Soccer"], { selecao: "Limanovia Limanowa +15.5" });
    for (const bet of [otherSport, twoSports, outOfScale]) {
      expect(await resolvePendingBetSport(bet.id, { now })).toMatchObject({ status: "pending" });
      expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
        .toMatchObject({ esporte: UNKNOWN_SPORT, sportResolutionStatus: "PENDING" });
    }
  });
});
