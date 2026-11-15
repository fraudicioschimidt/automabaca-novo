import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/src/generated/prisma/client";
import { applyBetEdit } from "@/src/services/bets/edit";
import { reconcileOperationalActions } from "@/src/services/ops/action-sources";
import { readMatchingDay, recordMatchingDay } from "@/src/services/ops/digests/matching-day";
import { persistFlashscoreObservation } from "@/src/services/settlement/flashscore/observation-store";
import { createTestDb, type TestDb } from "../helpers/db";

// A reconciliação da caixa também lê a dead-letter do pg-boss e pode avisar.
vi.mock("@/src/services/ops/dlq/replay", () => ({ listDeadLetters: vi.fn(async () => []) }));
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperationalAlert: vi.fn(async () => true),
  sendOperatorNotification: vi.fn(async () => true),
}));

/** O casamento de jogos de um dia, lido e gravado no Postgres real. */

let db: TestDb;
beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

/** O dia 23/09 em São Paulo. */
const DAY = { start: new Date("2026-09-23T03:00:00Z"), end: new Date("2026-09-24T03:00:00Z") };
const at = (iso: string) => new Date(iso);
const CANDIDATES = [{ matchId: 1, home: "Home", away: "Away", score: 60 }];

let bankrollId: string;
let betCount = 0;

beforeEach(async () => {
  await db.reset();
  betCount = 0;
  bankrollId = (await db.prisma.bankroll.create({
    data: { nome: "Canal Casamento", slug: "canal-casamento", valorUnidade: 100, capitalInicial: 100 },
  })).id;
});

function createBet(over: {
  data: Date;
  kickoffInferido?: boolean;
  status?: "PENDING" | "WON" | "LOST" | "VOID" | "CANCELED";
  settledAt?: Date;
  deletedAt?: Date;
  snapshot?: Prisma.InputJsonObject;
  flashscoreFirstCheckedAt?: Date;
}) {
  betCount += 1;
  return db.prisma.bet.create({
    data: {
      bankrollId,
      data: over.data,
      kickoffInferido: over.kickoffInferido ?? false,
      evento: `Home ${betCount} vs Away ${betCount}`,
      esporte: "Soccer",
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: at("2026-09-20T12:00:00Z"),
      mercado: "Moneyline",
      selecao: "Casa",
      odds: 2,
      stake: 1,
      valorUnidade: 100,
      status: over.status ?? "PENDING",
      // A remoção de aposta pendente a cancela com `settledAt` no instante dela.
      settledAt: over.settledAt ?? (over.status === "CANCELED" ? over.deletedAt : undefined),
      deletedAt: over.deletedAt,
      flashscoreFirstCheckedAt: over.flashscoreFirstCheckedAt,
      ...(over.snapshot ? {
        result: { create: { resultProvider: "flashscore", resultCheckedAt: DAY.end, resultSnapshot: over.snapshot } },
      } : {}),
    },
  });
}

function createTrainingCase(betId: string, over: { createdAt: Date; candidatesJson?: Prisma.InputJsonArray }) {
  return db.prisma.trainingCase.create({
    data: {
      betId,
      evento: "Home vs Away",
      esporte: "Soccer",
      candidatesJson: over.candidatesJson ?? CANDIDATES,
      createdAt: over.createdAt,
    },
  });
}

/** Aposta liquidada pelos eventos dados, em ordem; a última saída de pendente dá o `settledAt`. */
async function settleWithEvents(
  status: "WON" | "LOST" | "VOID",
  events: Array<{ from: string; to: string; source: string; at: Date }>,
  over: { deletedAt?: Date } = {},
) {
  const exits = events.filter((event) => event.from === "PENDING" && event.to !== "PENDING");
  const bet = await createBet({
    data: at("2026-09-23T00:00:00Z"),
    status: over.deletedAt ? "CANCELED" : status,
    settledAt: exits.at(-1)?.at,
    deletedAt: over.deletedAt,
  });
  for (const [index, event] of events.entries()) {
    await db.prisma.settlementEvent.create({
      data: {
        betId: bet.id,
        type: "STATUS_CHANGED",
        payload: { from: event.from, to: event.to, lucro: 0, source: event.source, changedAt: event.at.toISOString() },
        payloadHash: `hash-${index}`,
        createdAt: event.at,
      },
    });
  }
}

describe("fila Vincular do dia", () => {
  it("conta o caso pelo instante em que a caixa de ações o abriu, que o estado posterior não desfaz", async () => {
    // Entrou na fila ontem e continua lá.
    const yesterday = await createBet({ data: at("2026-09-22T20:00:00Z") });
    await createTrainingCase(yesterday.id, { createdAt: at("2026-09-22T10:00:00Z") });
    // Kickoff provisório do dia 22 (00:00 SP): entra na fila no fim daquele dia.
    const provisional = await createBet({ data: at("2026-09-22T03:00:00Z"), kickoffInferido: true });
    await createTrainingCase(provisional.id, { createdAt: at("2026-09-22T05:00:00Z") });
    // Resolvido pelo revival dois minutos depois do prazo: nunca virou ação.
    const unseen = await createBet({ data: at("2026-09-23T20:00:00Z") });
    const unseenCase = await createTrainingCase(unseen.id, { createdAt: at("2026-09-23T10:00:00Z") });
    // Com candidatos, entra no início do jogo.
    const withCandidates = await createBet({ data: at("2026-09-23T22:00:00Z") });
    const withCandidatesCase = await createTrainingCase(withCandidates.id, { createdAt: at("2026-09-23T10:00:00Z") });

    await reconcileOperationalActions(at("2026-09-22T20:05:00Z"));
    await reconcileOperationalActions(at("2026-09-23T03:05:00Z"));
    await db.prisma.trainingCase.update({
      where: { id: unseenCase.id },
      data: { status: "AUTO_APPLIED", resolution: "AUTO", resolvedAt: at("2026-09-23T20:02:00Z") },
    });
    await reconcileOperationalActions(at("2026-09-23T20:05:00Z"));
    await reconcileOperationalActions(at("2026-09-23T22:05:00Z"));
    // Depois disso o kickoff provisório vira real e a busca volta sem candidatos:
    // pelo estado de agora, nenhum dos dois estaria na fila no dia 23.
    await db.prisma.bet.update({
      where: { id: provisional.id },
      data: { kickoffInferido: false, data: at("2026-09-24T23:00:00Z") },
    });
    await db.prisma.trainingCase.update({ where: { id: withCandidatesCase.id }, data: { candidatesJson: [] } });
    await reconcileOperationalActions(at("2026-09-23T23:00:00Z"));

    expect((await readMatchingDay(DAY)).trainingQueueBets).toBe(2);
  });

  it("o caso que sai da fila e volta conta no dia em que volta, uma vez por aposta", async () => {
    const bet = await createBet({ data: at("2026-09-22T18:00:00Z") });
    const trainingCase = await createTrainingCase(bet.id, { createdAt: at("2026-09-22T10:00:00Z") });
    await reconcileOperationalActions(at("2026-09-22T18:05:00Z"));
    // Adiado, sai da fila no mesmo dia 22.
    await db.prisma.trainingCase.update({
      where: { id: trainingCase.id },
      data: { status: "REJECTED", resolvedAt: at("2026-09-22T19:00:00Z") },
    });
    await reconcileOperationalActions(at("2026-09-22T19:05:00Z"));
    expect((await readMatchingDay(DAY)).trainingQueueBets).toBe(0);

    // Reaberto (kickoff mudou), volta à fila no dia 23.
    await db.prisma.trainingCase.update({ where: { id: trainingCase.id }, data: { status: "OPEN", resolvedAt: null } });
    await reconcileOperationalActions(at("2026-09-23T12:05:00Z"));
    expect((await readMatchingDay(DAY)).trainingQueueBets).toBe(1);

    // Um segundo caso da mesma aposta na fila do mesmo dia não conta de novo.
    await createTrainingCase(bet.id, { createdAt: at("2026-09-23T12:10:00Z") });
    await reconcileOperationalActions(at("2026-09-23T12:15:00Z"));
    expect((await readMatchingDay(DAY)).trainingQueueBets).toBe(1);
  });
});

describe("liquidação do dia", () => {
  it("separa o automático do à mão pelo evento que tirou a aposta de pendente", async () => {
    await settleWithEvents("WON", [{ from: "PENDING", to: "WON", source: "flashscore", at: at("2026-09-23T20:00:00Z") }]);
    await settleWithEvents("LOST", [
      { from: "PENDING", to: "LOST", source: "ia-judge:ia_judge_auto", at: at("2026-09-23T21:00:00Z") },
    ]);
    await settleWithEvents("WON", [{ from: "PENDING", to: "WON", source: "manual:fabricio", at: at("2026-09-23T22:00:00Z") }]);
    // Sugestão do IA-Judge aprovada pelo dono no painel: à mão.
    await settleWithEvents("VOID", [{ from: "PENDING", to: "VOID", source: "ia-judge:fabricio", at: at("2026-09-23T22:30:00Z") }]);
    // Corrigida pelo dono depois: quem liquidou foi o automático.
    await settleWithEvents("LOST", [
      { from: "PENDING", to: "WON", source: "flashscore", at: at("2026-09-23T12:00:00Z") },
      { from: "WON", to: "LOST", source: "manual:fabricio", at: at("2026-09-23T23:00:00Z") },
    ]);
    // Reaberta e liquidada de novo à mão: vale a última saída de pendente.
    await settleWithEvents("LOST", [
      { from: "PENDING", to: "WON", source: "flashscore", at: at("2026-09-22T20:00:00Z") },
      { from: "WON", to: "PENDING", source: "manual:fabricio", at: at("2026-09-23T10:00:00Z") },
      { from: "PENDING", to: "LOST", source: "manual:fabricio", at: at("2026-09-23T11:00:00Z") },
    ]);
    // Liquidada ontem, e removida hoje.
    await settleWithEvents("WON", [{ from: "PENDING", to: "WON", source: "flashscore", at: at("2026-09-22T20:00:00Z") }]);
    await settleWithEvents("WON", [{ from: "PENDING", to: "WON", source: "flashscore", at: at("2026-09-23T19:00:00Z") }], {
      deletedAt: at("2026-09-23T20:00:00Z"),
    });

    expect((await readMatchingDay(DAY)).settled).toEqual({ automatic: 3, manual: 3 });
  });
});

describe("FlashScore sem o jogo", () => {
  const notFound = (outcome: string, providerIds: number) => ({
    outcome,
    identityResolution: {
      strategy: "not_matched", home: "provider_alias", away: "provider_alias", learned: 0, reused: 0, providerIds,
    },
  });

  it("conta pela primeira olhada, por motivo, e os dois ids só quando o par faltou", async () => {
    const game = at("2026-09-23T18:00:00Z");
    const lookedAt = at("2026-09-23T19:30:00Z");
    const looked = (snapshot: Prisma.InputJsonObject, over: { data?: Date; flashscoreFirstCheckedAt?: Date } = {}) =>
      createBet({ data: over.data ?? game, snapshot, flashscoreFirstCheckedAt: over.flashscoreFirstCheckedAt ?? lookedAt });
    await looked({ outcome: "matched" });
    await looked(notFound("no_candidate", 2));
    await looked(notFound("below_threshold", 2));
    // Com os dois ids ele achou o par: horário e rodada dupla não são identidade.
    await looked(notFound("kickoff_mismatch", 2));
    await looked(notFound("ambiguous", 2));
    // Jogo do dia 22 olhado só no dia 23 (esporte confirmado tarde): é do dia 23.
    await looked(notFound("no_candidate", 0), { data: at("2026-09-22T15:00:00Z"), flashscoreFirstCheckedAt: at("2026-09-23T14:00:00Z") });
    // Jogo do dia 23 olhado pela primeira vez depois da meia-noite: é do dia 24.
    await looked(notFound("no_candidate", 2), { data: at("2026-09-24T01:00:00Z"), flashscoreFirstCheckedAt: at("2026-09-24T03:10:00Z") });
    // Múltipla sem nenhum confronto achado.
    await looked({ outcome: "no_candidate", ticket: true, fixtures: 2 });
    // Esporte que ele não liquida, aposta removida, olhada de antes da coluna existir e vínculo cedo sem olhada: fora.
    await looked({ outcome: "unsupported_sport" });
    await createBet({
      data: game, status: "CANCELED", deletedAt: at("2026-09-23T20:00:00Z"),
      snapshot: notFound("no_candidate", 2), flashscoreFirstCheckedAt: lookedAt,
    });
    await createBet({ data: game, snapshot: notFound("no_candidate", 2) });
    const early = await createBet({ data: game });
    await db.prisma.betResult.create({ data: { betId: early.id, resultProvider: "flashscore", resultMatchId: "fs-9" } });

    expect((await readMatchingDay(DAY)).flashscore).toEqual({
      looked: 7,
      notFoundByReason: { no_candidate: 3, below_threshold: 1, kickoff_mismatch: 1, ambiguous: 1 },
      notFoundWithBothTeamIds: 2,
      evidenceErased: 0,
    });
  });

  describe("a correção pela ficha apaga a evidência", () => {
    const nextDay = { start: DAY.end, end: at("2026-09-25T03:00:00Z") };
    const loadTerms = (id: string) => db.prisma.bet.findUniqueOrThrow({ where: { id }, include: { captureEvidence: true } });
    const look = async (betId: string, checkedAt: Date) => persistFlashscoreObservation({
      bet: await loadTerms(betId), checkedAt, final: false, snapshot: notFound("no_candidate", 2),
    });
    const fixTeamName = (bet: Awaited<ReturnType<typeof createBet>>) => applyBetEdit({
      betId: bet.id,
      actor: "test",
      fields: {
        data: bet.data, evento: "Home FC vs Away 1", esporte: bet.esporte, competicao: bet.competicao, pais: bet.pais,
        mercado: bet.mercado, selecao: bet.selecao, odds: 2, stake: 1,
      },
    });
    const empty = { looked: 0, notFoundByReason: {}, notFoundWithBothTeamIds: 0, evidenceErased: 0 };

    it("depois do resumo do dia: a aposta não conta de novo no dia da olhada seguinte", async () => {
      // Jogo às 20:00 do dia 23 em São Paulo; o FlashScore olha às 21:30 e não acha.
      const bet = await createBet({ data: at("2026-09-23T23:00:00Z") });
      await look(bet.id, at("2026-09-24T00:30:00Z"));
      // Resumo das 00:05 do dia 24, sobre o dia 23.
      expect((await readMatchingDay(DAY)).flashscore).toEqual({
        looked: 1, notFoundByReason: { no_candidate: 1 }, notFoundWithBothTeamIds: 1, evidenceErased: 0,
      });

      // De manhã o dono corrige o nome do time, a evidência sai, e o FlashScore olha de novo.
      await fixTeamName(bet);
      await expect(db.prisma.betResult.findUnique({ where: { betId: bet.id } })).resolves.toBeNull();
      await look(bet.id, at("2026-09-24T12:00:00Z"));

      // Resumo das 00:05 do dia 25, sobre o dia 24.
      expect((await readMatchingDay(nextDay)).flashscore).toEqual(empty);
    });

    it("antes do resumo do dia: a aposta conta no dia da olhada, como evidência apagada", async () => {
      // Olhada às 20:31 do dia 23 em São Paulo; às 21:00 o dono corrige pela ficha.
      const bet = await createBet({ data: at("2026-09-23T22:00:00Z") });
      await look(bet.id, at("2026-09-23T23:31:00Z"));
      await fixTeamName(bet);

      // Resumo das 00:05 do dia 24, antes da olhada seguinte: olhada, sem desfecho.
      expect((await readMatchingDay(DAY)).flashscore).toEqual({
        looked: 1, notFoundByReason: {}, notFoundWithBothTeamIds: 0, evidenceErased: 1,
      });

      // A olhada seguinte, às 00:30 do dia 24, não a traz para o dia 24.
      await look(bet.id, at("2026-09-24T03:30:00Z"));
      expect((await readMatchingDay(nextDay)).flashscore).toEqual(empty);
    });
  });
});

describe("série diária", () => {
  const matching = {
    trainingQueueBets: 1,
    settled: { automatic: 2, manual: 1 },
    flashscore: { looked: 4, notFoundByReason: { no_candidate: 1 }, notFoundWithBothTeamIds: 1, evidenceErased: 1 },
    catalog: { linkedGames: 3, teamCards: 10, newTeamCards: 2 },
  };

  it("grava uma linha por dia, no início do dia, e a retentativa não a troca", async () => {
    await recordMatchingDay(DAY, matching, { casadas: 5, total: 6 });
    await recordMatchingDay(DAY, { ...matching, trainingQueueBets: 9 }, { casadas: 6, total: 6 });

    const rows = await db.prisma.operationalMetric.findMany({ where: { kind: "daily", name: "matching" } });
    expect(rows).toEqual([expect.objectContaining({
      outcome: "snapshot",
      occurredAt: DAY.start,
      labels: { day: "2026-09-23", ...matching, identityBeforeKickoff: { matched: 5, total: 6 },
        provenance: { version: 1, recordedAt: expect.any(String), start: DAY.start.toISOString(), end: DAY.end.toISOString(), releaseSha: expect.any(String) } },
    })]);
  });
});

describe("concorrência da série diária", () => {
  it("duas gravações concorrentes conservam um único snapshot", async () => {
    await db.prisma.$executeRawUnsafe(`CREATE FUNCTION test_delay_daily_metric() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'daily' THEN PERFORM pg_sleep(0.1); END IF; RETURN NEW; END $$`);
    await db.prisma.$executeRawUnsafe(`CREATE TRIGGER test_delay_daily_metric BEFORE INSERT ON operational_metrics FOR EACH ROW EXECUTE FUNCTION test_delay_daily_metric()`);
    try {
      const matching = await readMatchingDay(DAY);
      await Promise.all(Array.from({ length: 4 }, () => recordMatchingDay(DAY, matching, { casadas: 0, total: 0 })));
      expect(await db.prisma.operationalMetric.count({ where: { kind: "daily", name: "matching", occurredAt: DAY.start } })).toBe(1);
    } finally {
      await db.prisma.$executeRawUnsafe(`DROP TRIGGER test_delay_daily_metric ON operational_metrics`);
      await db.prisma.$executeRawUnsafe(`DROP FUNCTION test_delay_daily_metric()`);
    }
  });
});
