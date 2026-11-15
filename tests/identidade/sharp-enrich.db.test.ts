import { SharpContinuationError } from "@/src/services/sharp/enrich/continuation";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { enrichBetSharp, PrePinnacleRetryError } from "@/src/services/sharp/enrich/enrich-bet";
import { resetEnvCacheForTests } from "@/src/infra/env";
import type { BridgeQueryPage } from "@/src/providers/bridgeodds/types";

const page = JSON.parse(
  readFileSync(new URL("../fixtures/bridgeodds/connecticut-match.json", import.meta.url), "utf8"),
) as BridgeQueryPage;

const fakeQuery = async () => page.results;
const emptyQuery = async () => [];

let db: TestDb;

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
});

async function seedBet(
  sharpMode: "CLV_ONLY" | "IDENTITY_ONLY" | "OFF",
  status: "PENDING" | "WON" = "PENDING",
) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Big Data", slug: "big-data", valorUnidade: 100, sharpMode },
  });
  // Exatamente a aposta real capturada do canal (com o typo do tipster).
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      bankrollId: bankroll.id,
      data: new Date("2026-06-10T22:00:00Z"),
      evento: "AC Connecticut vs Vermont Grenn",
      esporte: "Soccer",
      mercado: "Total",
      selecao: "Under 4.75",
      odds: 1.9,
      stake: 0.5,
      status,
      settledAt: status === "PENDING" ? null : new Date("2026-06-10T22:00:00Z"),
      source: "test",
      sourceExternalId: `t-${sharpMode}`,
    },
  });
}

describe("enrichBetSharp (Postgres real + fixture real da API)", () => {
  it("post com hora: o match_date da Bridge, que não acompanha remarcação, não troca o horário", async () => {
    const bet = await seedBet("CLV_ONLY");
    await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });

    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.evento).toBe("AC Connecticut vs Vermont Green");
    expect(updated.data.toISOString()).toBe("2026-06-10T22:00:00.000Z");
    expect(updated.kickoffInferido).toBe(false);
  });

  it("não consulta provider enquanto o esporte estiver pendente", async () => {
    const bet = await seedBet("CLV_ONLY");
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: {
        esporte: "Unknown",
        sportResolutionStatus: "PENDING",
        sportConfidence: 0,
        sportSource: "UNRESOLVED",
        sportResolvedAt: null,
      },
    });
    const query = vi.fn(fakeQuery);

    await enrichBetSharp({ betId: bet.id }, { query });

    expect(query).not.toHaveBeenCalled();
    await expect(
      db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } }),
    ).resolves.toMatchObject({
      identityStatus: "PENDING",
      noOddsReason: "sport_pending",
    });
  });

  it("corrige identidade (typo do tipster) e grava o motivo do modo, sem escrever no sistema antigo de nomes", async () => {
    const bet = await seedBet("CLV_ONLY");
    // Post sem hora: o dia é a âncora, e o match_date da Bridge preenche o horário.
    await db.prisma.bet.update({ where: { id: bet.id }, data: { kickoffInferido: true } });
    await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });

    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.evento).toBe("AC Connecticut vs Vermont Green"); // Grenn → Green
    expect(updated.pais).toBe("USA");
    expect(updated.competicao).toBe("USL League 2");
    expect(updated.esporte).toBe("Soccer");
    // Kickoff corrigido pela Pinnacle (post sem hora → match_date é a verdade).
    const expectedKickoff = page.results.find((m) => m.away === "Vermont Green")!.match_date;
    expect(updated.data.toISOString()).toBe(new Date(expectedKickoff).toISOString());

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("MATCHED");
    expect(sharp.provider).toBe("bridgeodds");
    expect(sharp.confidence).toBeGreaterThan(75);
    expect(sharp.noOddsReason).toBe("clv_only");
  });

  it("liquidada recente: recupera só a identidade, depois do jogo", async () => {
    const bet = await seedBet("CLV_ONLY", "WON");
    await enrichBetSharp(
      { betId: bet.id },
      { query: fakeQuery, now: new Date("2026-06-11T12:00:00Z") },
    );

    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.status).toBe("WON");
    expect(updated.evento).toBe("AC Connecticut vs Vermont Green");

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("MATCHED");
    expect(sharp.provider).toBe("bridgeodds");
    expect(sharp.noOddsReason).toBe("clv_only");
  });

  it(
    "kickoffInferido: calendário BridgeOdds corrige data antes do match e zera a flag",
    async () => {
      const bet = await seedBet("CLV_ONLY");
      const expectedKickoff = page.results.find((m) => m.away === "Vermont Green")!.match_date;
      // Âncora = meia-noite do dia do post (date-only típico), longe do horário real.
      const anchor = new Date("2026-06-10T03:00:00Z");
      await db.prisma.bet.update({
        where: { id: bet.id },
        data: { data: anchor, kickoffInferido: true },
      });

      await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });

      const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
      expect(updated.kickoffInferido).toBe(false);
      expect(updated.data.toISOString()).toBe(new Date(expectedKickoff).toISOString());
      expect(updated.evento).toBe("AC Connecticut vs Vermont Green");
    },
    20_000,
  );

  it(
    "kickoffInferido capturado agora: corrige para o evento futuro e casa a identidade",
    async () => {
      const bet = await seedBet("CLV_ONLY");
      const now = new Date("2026-06-10T22:00:00Z");
      await db.prisma.bet.update({
        where: { id: bet.id },
        data: {
          data: new Date("2026-06-10T21:59:55Z"),
          kickoffInferido: true,
        },
      });

      await enrichBetSharp({ betId: bet.id }, { query: fakeQuery, now });

      const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
      expect(updated.data.toISOString()).toBe("2026-06-10T23:00:00.000Z");
      expect(updated.kickoffInferido).toBe(false);

      const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
      expect(sharp.identityStatus).toBe("MATCHED");
      expect(sharp.noOddsReason).toBe("clv_only");
    },
    20_000,
  );

  it(
    "jogo achado pela web em outro esporte: o enrich segue no esporte da aposta e chama o dono",
    async () => {
      const bet = await seedBet("CLV_ONLY");
      const now = new Date("2026-07-23T15:09:19Z");
      const kickoff = new Date("2026-07-24T00:30:00Z");
      await db.prisma.bet.update({
        where: { id: bet.id },
        data: {
          data: new Date("2026-07-23T15:09:14Z"),
          evento: "CD Colegio Los Leones vs CD Universidad De Concepcion",
          esporte: "Soccer",
          mercado: "Moneyline",
          selecao: "CD Universidad De Concepcion",
          kickoffInferido: true,
        },
      });
      const basketballMatch = {
        match_id: 1632598089,
        home: "CD Colegio Los Leones",
        away: "CD Universidad De Concepcion",
        sport: "Basquete",
        league: "Chile - LNB",
        match_date: kickoff.toISOString(),
        home_score: null,
        away_score: null,
        moneyline: {
          opening: { home: 2.1, away: 1.7, max_bet: 100 },
          closing: { home: 2.05, away: 1.72, max_bet: 200 },
        },
      };
      const query = vi.fn(async (params: { sport: string }) =>
        params.sport === "Basquete" ? [basketballMatch] : [],
      );
      const webSearch = vi.fn(async () => ({
        data: {
          found: true,
          kickoffIso: kickoff.toISOString(),
          actualSport: "Basketball",
          confidence: 0.98,
          country: "Chile",
          competition: "Chile - LNB",
          reason: "evento de basquete confirmado",
          sourceUrl: "https://example.com/chile-lnb",
        },
        provider: "gemini" as const,
        sources: [{ url: "https://example.com/chile-lnb" }],
      }));

      await enrichBetSharp(
        { betId: bet.id },
        { query: query as never, webSearch, now },
      );

      // O esporte é da captura, do resolvedor ou do dono: a busca de horário
      // não o troca, nem aplica o horário de um jogo de outro esporte.
      expect(query).not.toHaveBeenCalledWith(
        expect.objectContaining({ sport: "Basquete" }),
      );
      const updated = await db.prisma.bet.findUniqueOrThrow({
        where: { id: bet.id },
      });
      expect(updated).toMatchObject({
        esporte: "Soccer",
        competicao: "",
        pais: "",
        kickoffInferido: true,
      });
      expect(updated.data.toISOString()).toBe("2026-07-23T15:09:14.000Z");
      const review = await db.prisma.operationalAction.findFirstOrThrow({
        where: { resource: "bet", resourceId: bet.id, actionType: "sport.review" },
      });
      expect(review).toMatchObject({
        status: "OPEN",
        evidence: expect.objectContaining({ esporte: "Soccer", esporteSugerido: "Basketball", confianca: 98 }),
      });
      const sharp = await db.prisma.betSharp.findUniqueOrThrow({
        where: { betId: bet.id },
      });
      expect(sharp.identityStatus).not.toBe("MATCHED");
    },
    20_000,
  );

  it("o caso aberto fecha com a identidade gravada, e fica aberto quando a gravação é recusada", async () => {
    const bet = await seedBet("CLV_ONLY");
    const openCase = () => db.prisma.trainingCase.create({ data: {
      betId: bet.id, evento: bet.evento, esporte: bet.esporte, pais: "", competicao: "",
      status: "OPEN", candidatesJson: [], autoScore: 0,
    } });
    const first = await openCase();
    // A aposta muda enquanto a Bridge responde: a identidade não é gravada.
    const editedMidway = async () => {
      await db.prisma.bet.update({ where: { id: bet.id }, data: { odds: 2.1 } });
      return page.results;
    };
    await expect(enrichBetSharp({ betId: bet.id }, { query: editedMidway })).rejects.toThrow(/alterada/);
    await expect(db.prisma.trainingCase.findUniqueOrThrow({ where: { id: first.id } }))
      .resolves.toMatchObject({ status: "OPEN" });

    await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });
    await expect(db.prisma.trainingCase.findUniqueOrThrow({ where: { id: first.id } }))
      .resolves.toMatchObject({ status: "AUTO_APPLIED", resolution: "AUTO" });
  });

  it("IDENTITY_ONLY: identidade normalizada, SEM odds (motivo identity_only)", async () => {
    const bet = await seedBet("IDENTITY_ONLY");
    await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });

    // Mesma normalização de nome que CLV_ONLY — é o ponto do modo.
    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.evento).toBe("AC Connecticut vs Vermont Green");

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("MATCHED");
    // Motivo PRÓPRIO (não "sharp_off"): distingue canal-de-identidade de "em prova".
    expect(sharp.noOddsReason).toBe("identity_only");
  });

  it("linha que a Pinnacle não quota: MATCHED fica com a Bridge sem Pinnacle17 configurada", async () => {
    const bet = await seedBet("CLV_ONLY");
    // O book da fixture quota totais reais do jogo; 19.5 não existe em nenhum.
    await db.prisma.bet.update({ where: { id: bet.id }, data: { selecao: "Under 19.5" } });
    await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("MATCHED");
    expect(sharp.provider).toBe("bridgeodds");
    expect(sharp.noOddsReason).toBe("clv_only");
  });

  it("player prop: identidade casada, SEM odds (mercado que provider nenhum precifica)", async () => {
    const bet = await seedBet("CLV_ONLY");
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { mercado: "Artilheiro", selecao: "Kylian Mbappe" },
    });
    await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("MATCHED"); // identidade gravada (serve p/ settlement)
    expect(sharp.noOddsReason).toBe("clv_only");
  });

  it("esporte fora da cobertura de TODOS os providers: UNSUPPORTED com motivo escrito", async () => {
    // Xadrez não está em SPORTS de provider nenhum (providers/coverage.ts),
    // então `identityProviders` volta vazio e a aposta nunca terá CLV.
    // Terminalizar sem motivo deixaria a tela com campo vazio e sem explicação.
    const bet = await seedBet("CLV_ONLY");
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { esporte: "Chess", evento: "Carlsen vs Nakamura" },
    });
    const query = vi.fn(fakeQuery);

    await enrichBetSharp({ betId: bet.id }, { query });

    expect(query).not.toHaveBeenCalled();
    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("UNSUPPORTED");
    expect(sharp.noOddsReason).toBe("unsupported_market");
  });

  it("cartões: mercado reescrito no nome Pinnacle deixa rastro; sem Pinnacle17 configurada fica com a Bridge", async () => {
    // Pinnacle17 (único que precifica cartões) COBRE o mercado mas está
    // indisponível (aqui, não configurado; na prática, budget esgotado). O
    // bridge dizer "unsupported_market" (permanente, na denylist do revive)
    // condenaria a aposta a nunca mais buscar odds. Deve virar "no_prices"
    // (transitório) p/ o revive re-tentar quando houver budget.
    const bet = await seedBet("CLV_ONLY");
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { mercado: "Total Cards", selecao: "Over 3.5" },
    });
    await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });

    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.mercado).toBe("Total (Bookings) – Match"); // nome Pinnacle (não "Cards")
    // A reescrita do mercado deixa rastro: ela decide preço, liquidante e
    // segmento de probation, e a ficha tem o verbete "Mercado corrigido", que
    // precisa de quem o grave (portão: `trilha-da-aposta`).
    const correcao = await db.prisma.auditEvent.findFirst({
      where: { action: "bet.market_correct", resourceId: bet.id },
    });
    expect(correcao, "mercado reescrito sem linha nenhuma na ficha").not.toBeNull();
    expect(correcao?.details).toMatchObject({
      antes: { mercado: "Total Cards" },
      depois: { mercado: "Total (Bookings) – Match" },
    });
    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("MATCHED"); // identidade casou no bridge
    expect(sharp.noOddsReason).toBe("clv_only");
  });

  it("OFF: não toca em nada", async () => {
    const bet = await seedBet("OFF");
    await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });
    expect(await db.prisma.betSharp.count({ where: { betId: bet.id } })).toBe(0);
  });

  it("pré-Pinnacle: lança PrePinnacleRetryError e deixa PENDING visível", async () => {
    const bet = await seedBet("CLV_ONLY");
    await expect(
      enrichBetSharp({ betId: bet.id }, { query: emptyQuery }),
    ).rejects.toThrow(PrePinnacleRetryError);

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("PENDING");
  });

  it("não terminaliza identidade nas primeiras 24h após o kickoff", async () => {
    const bet = await seedBet("CLV_ONLY");
    const now = new Date("2026-06-11T00:00:00Z");
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { registradoEm: new Date("2026-06-10T20:00:00Z") },
    });

    await expect(
      enrichBetSharp({ betId: bet.id }, { query: emptyQuery, now }),
    ).rejects.toThrow(PrePinnacleRetryError);

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("PENDING");
  });

  it("aposta removida com esporte pendente é ignorada antes de criar BetSharp", async () => {
    const bet = await seedBet("CLV_ONLY");
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: {
        deletedAt: new Date(),
        esporte: "Unknown",
        sportResolutionStatus: "PENDING",
        sportConfidence: 0,
        sportSource: "UNRESOLVED",
        sportResolvedAt: null,
      },
    });
    await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });
    expect(await db.prisma.betSharp.count({ where: { betId: bet.id } })).toBe(0);
  });

  it("re-enrich é idempotente (upsert)", async () => {
    const bet = await seedBet("CLV_ONLY");
    await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });
    await enrichBetSharp({ betId: bet.id }, { query: fakeQuery });
    expect(await db.prisma.betSharp.count({ where: { betId: bet.id } })).toBe(1);
  });

  it("ZONA CINZENTA (score < teto) vai ao juiz e NÃO auto-aplica", async () => {
    // Teto no MÁXIMO que o env aceita (2 = 1.0 por lado): só um casamento
    // perfeito dos DOIS lados escapa da zona cinzenta. Amarrar o teste ao teto
    // do contrato, e não ao escore de um fixture, faz ele sobreviver a ajustes
    // de similaridade (um resgate de typo pode subir o par acima de um teto
    // escolhido a dedo e deixar a zona cinzenta sem exercício).
    process.env.SHARP_AUTO_MATCH_MIN_SCORE = "2";
    const saved = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GEMINI_API_KEYS: process.env.GEMINI_API_KEYS,
      GEMINI_PAID_API_KEY: process.env.GEMINI_PAID_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
      LLM_DISABLE_GROQ: process.env.LLM_DISABLE_GROQ,
      LLM_DISABLE_MISTRAL: process.env.LLM_DISABLE_MISTRAL,
    };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEYS;
    delete process.env.GEMINI_PAID_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    process.env.LLM_DISABLE_GROQ = "1";
    process.env.LLM_DISABLE_MISTRAL = "1";
    resetEnvCacheForTests();
    try {
      const bet = await seedBet("CLV_ONLY");
      // Avalia cedo, preserva o cursor e termina as buscas antes de declarar ausência.
      const paused = await enrichBetSharp({ betId: bet.id }, { query: fakeQuery }).catch((error: unknown) => error);
      expect(paused).toBeInstanceOf(SharpContinuationError);
      await expect(enrichBetSharp({ betId: bet.id }, {
        query: fakeQuery, continuation: (paused as SharpContinuationError).continuation,
      })).rejects.toThrow(PrePinnacleRetryError);
      const sharp = await db.prisma.betSharp.findUnique({ where: { betId: bet.id } });
      expect(sharp?.identityStatus).toBe("PENDING"); // NÃO virou MATCHED sozinho
      const tcase = await db.prisma.trainingCase.findFirst({ where: { betId: bet.id } });
      expect(tcase?.status).toBe("OPEN"); // caiu na camada 3 (fila humana)
    } finally {
      delete process.env.SHARP_AUTO_MATCH_MIN_SCORE;
      delete process.env.LLM_DISABLE_GROQ;
      delete process.env.LLM_DISABLE_MISTRAL;
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
        else delete process.env[k];
      }
      resetEnvCacheForTests();
    }
  });
});

describe("precedência MANUAL sobre o provider", () => {
  it("re-enrich não reescreve evento/competição de identidade resolvida à mão", async () => {
    // Canal CLV_ONLY nunca tem preço de entrada, então nunca bate no
    // `already_enriched` e re-enriquece sempre. Cada passada não pode
    // sobrescrever evento/competição/país com o valor do provider, desfazendo a
    // correção do operador em silêncio.
    const { applyBridgeIdentity } = await import("@/src/services/sharp/enrich/apply-identity");
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Manual", slug: `manual-${Date.now()}`, sharpMode: "CLV_ONLY" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: new Date("2026-08-10T18:00:00Z"),
        evento: "França vs Alemanha",
        esporte: "Soccer",
        competicao: "Liga Corrigida",
        pais: "Brasil",
        mercado: "Moneyline",
        selecao: "França -1.0",
        odds: 2,
        stake: 1,
      },
    });

    await applyBridgeIdentity({
      gameStart: null,
      bet: { ...bet, identityStatus: "MANUAL" },
      best: {
        match: {
          match_id: "1", home: "France", away: "Germany",
          league: "England / Premier League", sport: "soccer",
          match_date: "2026-08-10T18:00:00Z",
        },
        swapped: false, score: 1,
      } as never,
      via: "AUTO",
      teams: { home: "França", away: "Alemanha" },
      confidence: 99,
    });

    const depois = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(depois.evento).toBe("França vs Alemanha");
    expect(depois.selecao).toBe("França -1.0");
    expect(depois.competicao).toBe("Liga Corrigida");
    expect(depois.pais).toBe("Brasil");
  });

  it("recuperação histórica pós-kickoff usa provider resolvido via cascata e não agenda closing", async () => {
    const bet = await seedBet("CLV_ONLY", "WON");
    const pastKickoff = new Date("2026-06-10T20:00:00Z");
    const now = new Date("2026-06-11T12:00:00Z");
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: {
        data: pastKickoff,
        registradoEm: pastKickoff,
        kickoffInferido: false,
        status: "WON",
        settledAt: new Date("2026-06-10T23:00:00Z"),
      },
    });

    const mockBoss = {
      send: vi.fn(),
    };

    await enrichBetSharp(
      { betId: bet.id },
      { query: fakeQuery, now, boss: mockBoss as never },
    );

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("MATCHED");
    expect(sharp.provider).toBe("bridgeodds");
    expect(mockBoss.send).not.toHaveBeenCalled();
  });
});
