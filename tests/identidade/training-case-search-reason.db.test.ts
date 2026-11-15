import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@/src/services/sharp/enrich/pinnacle17-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/sharp/enrich/pinnacle17-identity")>()),
  tryPinnacle17Identity: vi.fn(async () => ({ resolved: false })),
}));

const { enrichBetSharp, PrePinnacleRetryError } = await import("@/src/services/sharp/enrich/enrich-bet");
const { recordTrainingCase, recordTrainingFailure, isWaitingProviderTrainingReason } = await import(
  "@/src/services/sharp/enrich/training-cases"
);
const { reconcileOperationalActions } = await import("@/src/services/ops/action-sources");

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

async function seedBet() {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Treino", slug: `treino-${Math.random()}`, sharpMode: "CLV_ONLY" },
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      data: new Date("2026-08-09T19:30:00Z"),
      registradoEm: new Date("2026-08-08T18:00:00Z"),
      evento: "Argentina vs Colombia",
      esporte: "Soccer",
      pais: "World",
      competicao: "International",
      mercado: "Moneyline",
      selecao: "Colombia",
      odds: 1.8,
      stake: 1,
      status: "PENDING",
    },
  });
}

describe("TrainingCase com motivo de busca", () => {
  it("cota/truncado não abre caso de treino vazio", async () => {
    const bet = await seedBet();
    await recordTrainingFailure(bet, "budget_truncated");
    await recordTrainingCase(bet, [], "OPEN", null, "esporte_Soccer_sem_match_nos_tiers");
    expect(isWaitingProviderTrainingReason("pinnacle17_budget")).toBe(true);
    await expect(db.prisma.trainingCase.count({ where: { betId: bet.id } })).resolves.toBe(0);
  });

  it("o caminho real sem resultados materializa o motivo terminal", async () => {
    const bet = await seedBet();
    await enrichBetSharp(
      { betId: bet.id },
      { query: vi.fn(async () => []), now: new Date("2026-08-11T20:00:00Z") },
    );

    await expect(db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } }))
      .resolves.toMatchObject({ identityStatus: "UNMATCHED" });
    await expect(db.prisma.trainingCase.findFirstOrThrow({ where: { betId: bet.id } }))
      .resolves.toMatchObject({
        status: "OPEN",
        candidatesJson: [],
        llmVerdictJson: {
          source: "matching",
          reason: "past_event:no_results",
        },
      });
  });

  it("motivo terminal não apaga candidatos já coletados", async () => {
    const bet = await seedBet();
    await recordTrainingCase(bet, [{
      match: {
        match_id: 42,
        sport: "Soccer",
        home: "Argentina",
        away: "Colombia",
        league: "International",
        match_date: "2026-08-09T19:30:00Z",
      },
      score: 1.4,
      swapped: false,
    }], "OPEN", null, "below_threshold");

    await recordTrainingFailure(bet, "past_event:below_threshold");

    const row = await db.prisma.trainingCase.findFirstOrThrow({ where: { betId: bet.id } });
    expect(row.candidatesJson).toHaveLength(1);
    expect(row.llmVerdictJson).toMatchObject({
      source: "matching",
      reason: "past_event:below_threshold",
    });
  });

  it("nova tentativa sem candidato não apaga os candidatos do caso aberto", async () => {
    const bet = await seedBet();
    await recordTrainingCase(bet, [{
      match: {
        match_id: 42,
        sport: "Soccer",
        home: "Argentina",
        away: "Colombia",
        league: "International",
        match_date: "2026-08-09T19:30:00Z",
      },
      score: 1.4,
      swapped: false,
    }], "OPEN", null, "below_threshold");

    // A Bridge oscilou: a busca seguinte voltou vazia.
    await recordTrainingCase(bet, [], "OPEN", null, "no_results");

    const row = await db.prisma.trainingCase.findFirstOrThrow({ where: { betId: bet.id } });
    expect(row.candidatesJson).toHaveLength(1);
    expect(row.autoScore).toBe(70);
    expect(row.llmVerdictJson).toMatchObject({ source: "matching", reason: "no_results" });
  });

  it("terminalização não apaga a justificativa real do juiz LLM", async () => {
    const bet = await seedBet();
    await recordTrainingCase(bet, [], "OPEN", {
      candidateIndex: -1,
      confidence: 0.92,
      reason: "equipes femininas não correspondem",
    });

    await recordTrainingFailure(bet, "past_event:below_threshold");

    await expect(db.prisma.trainingCase.findFirstOrThrow({ where: { betId: bet.id } }))
      .resolves.toMatchObject({
        llmVerdictJson: {
          candidateIndex: -1,
          reason: "equipes femininas não correspondem",
        },
      });
  });
});

describe("caso de treino sem candidato antes do jogo", () => {
  it("fica aberto, mas só chega ao dono se a busca continuar sem o jogo 6 h depois do início", async () => {
    const bet = await seedBet();
    const kickoff = new Date(Date.now() + 86_400_000);
    await db.prisma.bet.update({ where: { id: bet.id }, data: { data: kickoff } });

    await expect(enrichBetSharp({ betId: bet.id }, { query: vi.fn(async () => []) }))
      .rejects.toBeInstanceOf(PrePinnacleRetryError);

    const caso = await db.prisma.trainingCase.findFirstOrThrow({ where: { betId: bet.id } });
    expect(caso).toMatchObject({
      status: "OPEN",
      candidatesJson: [],
      llmVerdictJson: { source: "matching", reason: "no_results" },
    });
    await expect(db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } }))
      .resolves.toMatchObject({ identityStatus: "PENDING" });
    // Nada automático troca o jogo do post: sem candidato real, quem decide é o dono.
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ evento: "Argentina vs Colombia", pais: "World", competicao: "International" });

    // Antes do jogo o revival ainda pode casar sozinho: nada na caixa do dono.
    await reconcileOperationalActions();
    await expect(db.prisma.operationalAction.count({ where: { resource: "training-case" } })).resolves.toBe(0);

    await reconcileOperationalActions(new Date(kickoff.getTime() + 7 * 3_600_000));
    await expect(db.prisma.operationalAction.findFirstOrThrow({
      where: { resource: "training-case", resourceId: caso.id },
    })).resolves.toMatchObject({
      status: "OPEN",
      actionType: "training.resolve",
      title: "Resolver identidade: Argentina vs Colombia",
      description: "A busca automática ainda não achou o jogo, horas depois do início; corrija o nome do evento na ficha da aposta.",
    });
  });
});
