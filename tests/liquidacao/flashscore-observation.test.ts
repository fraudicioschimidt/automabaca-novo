import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    SHARP_AUTO_MATCH_MIN_SCORE: 1.5,
  },
  findMany: vi.fn(),
  upsert: vi.fn(),
  resultFind: vi.fn(async (): Promise<{ resultMatchId: string | null } | null> => null),
  list: vi.fn(),
  settleScore: vi.fn(),
  metric: vi.fn(),
  notify: vi.fn(),
  operationalAlert: vi.fn(),
  bridgeFind: vi.fn(),
  stats: vi.fn(),
  ambiguousSide: null as "home" | "away" | null,
  /** A primeira olhada gravada na aposta (`recordFlashscoreFirstCheckTx`). */
  executeRaw: vi.fn(async () => 1),
  /** Ids FlashScore que as fichas dão para os times da aposta. */
  providerTeamIds: { home: null, away: null } as { home: string | null; away: string | null },
}));

vi.mock("@/src/infra/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/src/infra/prisma", () => {
  let rows: Array<{ id: string }> = [];
  const prisma = {
    bet: {
      findMany: async (...args: unknown[]) => {
        rows = await mocks.findMany(...args);
        return rows;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = rows.find((bet) => bet.id === where.id);
        if (!row) throw new Error("Aposta não encontrada na fixture.");
        return row;
      },
    },
    betResult: { upsert: mocks.upsert, findUnique: mocks.resultFind },
    $executeRaw: mocks.executeRaw,
    // Nenhuma liquidação do IA-Judge para conferir.
    $queryRaw: async () => [],
    // Settle consulta o breaker antes do catálogo; sem linha = CLOSED.
    providerCircuit: { findUnique: async () => null },
  };
  // Aqui o banco é simulado; atomicidade e edições concorrentes têm testes PostgreSQL.
  return { prisma: {
    ...prisma,
    $transaction: async (operation: (tx: typeof prisma) => Promise<unknown>) => operation(prisma),
  } };
});
vi.mock("@/src/providers/provider-cache", () => ({
  readProviderCache: async () => null,
  writeProviderCache: async () => {},
  deleteProviderCache: async () => {},
}));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: mocks.metric }));
vi.mock("@/src/services/sharp/enrich/identity-cache", () => ({
  applyTeamAliases: async (teams: unknown) => teams,
  pinnacleTeamsFrom: async (teams: unknown) => teams,
}));
vi.mock("@/src/services/teams/resolve", () => {
  // Sem ficha: nenhum nome traduz. `ambiguousSide` simula o nome com duas
  // fichas, e `providerTeamIds`, o id que a ficha dá ao time.
  const resolution = (inputName: string, ambiguous: boolean, providerTeamId: string | null) => ({
    inputName,
    resolvedName: inputName,
    cardId: providerTeamId ? `card-${providerTeamId}` : null,
    providerTeamId,
    strategy: ambiguous ? "ambiguous" : providerTeamId ? "flashscore_name" : "original",
    alternativeNames: [],
  });
  const resolve = (teams: { home: string; away: string }) => ({
    ...teams,
    homeResolution: resolution(teams.home, mocks.ambiguousSide === "home", mocks.providerTeamIds.home),
    awayResolution: resolution(teams.away, mocks.ambiguousSide === "away", mocks.providerTeamIds.away),
  });
  return {
    resolveTeamsForProvider: async (teams: { home: string; away: string }) => resolve(teams),
    resolveTeamsForProviders: async (teams: { home: string; away: string }, providers: readonly string[]) => providers.map(() => resolve(teams)),
  };
});
vi.mock("@/src/services/settlement/flashscore/score-settle", () => ({
  settleFromFlashscoreScore: mocks.settleScore,
}));
vi.mock("@/src/providers/bridgeodds/match", () => ({
  findBridgeMatch: mocks.bridgeFind,
}));
vi.mock("@/src/services/bets/settle", () => ({
  applyAutomaticBetStatusChange: vi.fn(),
  BetNotPendingError: class BetNotPendingError extends Error {},
}));
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperatorNotification: mocks.notify,
  sendOperationalAlert: mocks.operationalAlert,
}));
vi.mock("@/src/providers/flashscore/client", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    flashscoreConfigured: () => true,
    listFlashscoreMatchesByDate: mocks.list,
    getFlashscoreMatchStats: mocks.stats,
  };
});

import { ProviderRequestError } from "@/src/domain/provider-error";
import { runFlashscoreObservationOnce } from "@/src/services/settlement/flashscore/observation";
import { BetSettlementTermsChangedError } from "@/src/services/bets/settle-terms";
import { clearFlashscoreCatalogCache } from "@/src/providers/flashscore/catalog";
import { bet, group, kickoff, now } from "../helpers/flashscore-observation";

/**
 * O ciclo de observação: agrupamento por esporte e dia, chamadas ao catálogo,
 * falhas de cota e de provider, casamento de identidade e bilhetes. O que cada
 * mercado faz com a partida casada está em `flashscore-match-outcome.test.ts`.
 */
describe("observação FlashScore", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearFlashscoreCatalogCache();
    mocks.findMany.mockResolvedValue([bet]);
    mocks.list.mockResolvedValue(group);
    mocks.upsert.mockResolvedValue(undefined);
    mocks.resultFind.mockResolvedValue(null);
    mocks.metric.mockResolvedValue(undefined);
    mocks.settleScore.mockResolvedValue(true);
    mocks.stats.mockResolvedValue(null);
    mocks.ambiguousSide = null;
    mocks.providerTeamIds = { home: null, away: null };
  });

  it("descarta snapshot invalidado por edição sem finalizar nem alertar falha do provider", async () => {
    mocks.settleScore.mockRejectedValueOnce(new BetSettlementTermsChangedError(bet.id));
    const result = await runFlashscoreObservationOnce(now);
    expect(result.failures).toBe(0);
    expect(result.settled).toBe(0);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.operationalAlert).not.toHaveBeenCalled();
  });

  it("dupla fallback monta scoresByEvento por confronto, não pelo evento amassado", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      id: "bet-parlay",
      evento: "France vs Morocco | Spain vs Italy",
      mercado: "Moneyline",
      selecao: "France / Spain",
      legsJson: {
        kind: "parlay",
        legs: [
          { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
          { evento: "Spain vs Italy", mercado: "Moneyline", selecao: "Spain" },
        ],
      },
    }]);
    const finished = {
      stage: "Finished",
      is_cancelled: false,
      is_postponed: false,
      is_started: true,
      is_in_progress: false,
      is_finished: true,
    };
    mocks.list.mockResolvedValue([{
      matches: [
        {
          match_id: "fs-fr",
          timestamp: Math.floor(kickoff.getTime() / 1_000),
          home_team: { team_id: "fr", name: "France" },
          away_team: { team_id: "ma", name: "Morocco" },
          scores: { home: 2, away: 1 },
          match_status: finished,
        },
        {
          match_id: "fs-es",
          timestamp: Math.floor(kickoff.getTime() / 1_000),
          home_team: { team_id: "es", name: "Spain" },
          away_team: { team_id: "it", name: "Italy" },
          scores: { home: 1, away: 0 },
          match_status: finished,
        },
      ],
    }]);

    const result = await runFlashscoreObservationOnce(now);
    expect(result).toMatchObject({ processed: 1, matched: 1, final: 1, settled: 1 });
    expect(mocks.settleScore).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bet-parlay" }),
      expect.objectContaining({ homeScore: 2, awayScore: 1 }),
      expect.objectContaining({
        alertIncompleteLegs: true,
        // Terminaram no tempo normal: o placar regulamentar é o listado.
        scoresByEvento: [
          { evento: "France vs Morocco", home: 2, away: 1, regulation: { home: 2, away: 1 } },
          { evento: "Spain vs Italy", home: 1, away: 0, regulation: { home: 1, away: 0 } },
        ],
      }),
    );
  });

  /**
   * A competição do bilhete não é a de cada perna: um bilhete gravado com a
   * competição feminina não faz a perna masculina procurar o jogo feminino.
   */
  it("a categoria da competição do bilhete não vale para as pernas", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      id: "bet-parlay-liga",
      evento: "France vs Morocco | Spain vs Italy",
      competicao: "Champions League Women",
      mercado: "Moneyline",
      selecao: "France / Spain",
      legsJson: {
        kind: "parlay",
        legs: [
          { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
          { evento: "Spain vs Italy", mercado: "Moneyline", selecao: "Spain" },
        ],
      },
    }]);
    const finished = group[0]!.matches[0]!.match_status;
    mocks.list.mockResolvedValue([{
      matches: [
        { match_id: "fs-fr", timestamp: Math.floor(kickoff.getTime() / 1_000),
          home_team: { team_id: "fr", name: "France" }, away_team: { team_id: "ma", name: "Morocco" },
          scores: { home: 2, away: 1 }, match_status: finished },
        { match_id: "fs-es", timestamp: Math.floor(kickoff.getTime() / 1_000),
          home_team: { team_id: "es", name: "Spain" }, away_team: { team_id: "it", name: "Italy" },
          scores: { home: 1, away: 0 }, match_status: finished },
      ],
    }]);

    const result = await runFlashscoreObservationOnce(now);

    expect(result).toMatchObject({ processed: 1, matched: 1, settled: 1 });
  });

  it("dupla com um confronto em andamento não marca observação final", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      id: "bet-parlay-live",
      evento: "France vs Morocco | Spain vs Italy",
      mercado: "Moneyline",
      selecao: "France / Spain",
      legsJson: {
        kind: "parlay",
        legs: [
          { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
          { evento: "Spain vs Italy", mercado: "Moneyline", selecao: "Spain" },
        ],
      },
    }]);
    mocks.list.mockResolvedValue([{
      matches: [
        {
          match_id: "fs-fr",
          timestamp: Math.floor(kickoff.getTime() / 1_000),
          home_team: { team_id: "fr", name: "France" },
          away_team: { team_id: "ma", name: "Morocco" },
          scores: { home: 2, away: 1 },
          match_status: {
            stage: "Finished",
            is_cancelled: false,
            is_postponed: false,
            is_started: true,
            is_in_progress: false,
            is_finished: true,
          },
        },
        {
          match_id: "fs-es",
          timestamp: Math.floor(kickoff.getTime() / 1_000),
          home_team: { team_id: "es", name: "Spain" },
          away_team: { team_id: "it", name: "Italy" },
          scores: { home: 0, away: 0 },
          match_status: {
            stage: "2nd half",
            is_cancelled: false,
            is_postponed: false,
            is_started: true,
            is_in_progress: true,
            is_finished: false,
          },
        },
      ],
    }]);

    const result = await runFlashscoreObservationOnce(now);
    expect(result.final).toBe(0);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        resultFinal: false,
        resultMatchId: "fs-fr",
      }),
    }));
    expect(mocks.settleScore).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bet-parlay-live" }),
      expect.anything(),
      expect.objectContaining({ alertIncompleteLegs: false }),
    );
  });

  it("modo fallback reutiliza o settlement canônico de placar", async () => {
    const result = await runFlashscoreObservationOnce(now);
    expect(result.settled).toBe(1);
    expect(mocks.settleScore).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bet-1" }),
      { homeScore: 2, awayScore: 3 },
      expect.objectContaining({ scoredEvento: expect.any(String) }),
    );
    // Pendente, ou liquidada pela IA há menos de 7 dias (só conferência).
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: [expect.objectContaining({ OR: expect.arrayContaining([{ status: "PENDING" }]) })],
      }),
    }));
  });

  it("modo fallback não consulta BridgeOdds para validar o resultado", async () => {

    const result = await runFlashscoreObservationOnce(now);

    expect(result.settled).toBe(1);
    expect(mocks.settleScore).toHaveBeenCalledOnce();
    expect(mocks.bridgeFind).not.toHaveBeenCalled();
  });

  it("mantém 30 dias de lookback no fallback autoritativo", async () => {
    await runFlashscoreObservationOnce(now);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        data: expect.objectContaining({
          gte: new Date(now.getTime() - 30 * 86_400_000),
        }),
      }),
    }));
  });

  it("busca dias adjacentes somente quando o catálogo principal não encontra o jogo", async () => {
    mocks.list
      .mockResolvedValueOnce([{ matches: [] }])
      .mockResolvedValueOnce(group);

    const result = await runFlashscoreObservationOnce(now);

    expect(result.matched).toBe(1);
    expect(mocks.list).toHaveBeenNthCalledWith(1, "2026-07-22", 1);
    expect(mocks.list).toHaveBeenNthCalledWith(2, "2026-07-21", 1);
  });

  /**
   * O horário é trava da PARTIDA: o jogo que liquida começa a no máximo 3 h do
   * horário da aposta, nem pelo `resultMatchId` já vinculado nem pela busca, que
   * aceita até 18 h.
   */
  it("não aceita nem por id o jogo a mais de 3 h do horário da aposta", async () => {
    const seisHorasDepois = Math.floor(kickoff.getTime() / 1_000) + 6 * 3_600;
    mocks.findMany.mockResolvedValue([{
      ...bet,
      result: { resultMatchId: "fs-1", resultFinal: false, resultCheckedAt: null, resultSnapshot: null },
    }]);
    mocks.resultFind.mockResolvedValue({ resultMatchId: "fs-1" });
    mocks.list.mockResolvedValue([{ matches: [{ ...group[0]!.matches[0]!, timestamp: seisHorasDepois }] }]);

    const result = await runFlashscoreObservationOnce(now);

    expect(result).toMatchObject({ matched: 0, unmatched: 1, settled: 0 });
    expect(mocks.settleScore).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        resultFinal: false,
        resultSnapshot: expect.objectContaining({ outcome: "kickoff_mismatch" }),
      }),
      // O id velho sai: a aposta deixa a insistência de 10 min dos já casados.
      update: expect.objectContaining({ resultMatchId: null, resultMatchConfidence: null }),
    }));
  });

  it("jogo fora do catálogo desta olhada não solta o vínculo", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      result: { resultMatchId: "fs-1", resultFinal: false, resultCheckedAt: null, resultSnapshot: null },
    }]);
    mocks.resultFind.mockResolvedValue({ resultMatchId: "fs-1" });
    mocks.list.mockResolvedValue([{ matches: [] }]);

    const result = await runFlashscoreObservationOnce(now);

    expect(result).toMatchObject({ matched: 0, unmatched: 1 });
    const update = mocks.upsert.mock.calls.at(-1)![0].update as Record<string, unknown>;
    expect(update.resultSnapshot).toMatchObject({ outcome: "no_candidate" });
    expect(update).not.toHaveProperty("resultMatchId");
  });

  /**
   * Com os ids dos dois times a busca não cai para o nome, e o jogo que falta no
   * catálogo fica para o dono: a observação grava que conhecia os dois, que é
   * o que o casamento do dia conta.
   */
  it("sem o jogo e com um dos ids das fichas noutra partida, grava que conhecia os dois e não liquida pelo nome", async () => {
    mocks.providerTeamIds = { home: "id-antigo-casa", away: "id-antigo-fora" };
    const [day] = group;
    const [partida] = day!.matches;
    const doTimeDaCasa = {
      ...partida!, match_id: "fs-outro", home_team: { team_id: "id-antigo-casa", name: "Outro Nome" },
      away_team: { team_id: "z", name: "Terceiro" },
    };
    mocks.list.mockResolvedValue([{ ...day, matches: [partida, doTimeDaCasa] }]);

    const result = await runFlashscoreObservationOnce(now);

    expect(result).toMatchObject({ matched: 0, unmatched: 1, settled: 0 });
    expect(mocks.executeRaw).toHaveBeenCalledOnce();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        resultSnapshot: {
          outcome: "no_candidate",
          identityResolution: {
            strategy: "not_matched",
            home: "flashscore_name",
            away: "flashscore_name",
            providerIds: 2,
          },
        },
      }),
    }));
  });

  it("com os dois ids das fichas fora do catálogo, os nomes idênticos liquidam", async () => {
    mocks.providerTeamIds = { home: "id-antigo-casa", away: "id-antigo-fora" };

    const result = await runFlashscoreObservationOnce(now);

    expect(result).toMatchObject({ matched: 1, settled: 1 });
    expect(mocks.settleScore).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bet-1" }),
      { homeScore: 2, awayScore: 3 },
      expect.anything(),
    );
  });

  it("a partida casada liquida e grava de onde veio o jogo", async () => {
    const result = await runFlashscoreObservationOnce(now);

    expect(result).toMatchObject({ matched: 1, unmatched: 0, settled: 1 });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        resultMatchId: "fs-1",
        resultSnapshot: expect.objectContaining({
          outcome: "matched",
          identityResolution: expect.objectContaining({ strategy: "fuzzy", source: "search" }),
        }),
      }),
    }));
  });

  it.each(["home", "away"] as const)(
    "nome com duas fichas (%s) busca com a grafia original e liquida",
    async (side) => {
      mocks.ambiguousSide = side;

      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ matched: 1, settled: 1 });
      expect(mocks.settleScore).toHaveBeenCalledOnce();
    },
  );

  it("consulta o catálogo esportivo correto para basquete", async () => {
    mocks.findMany.mockResolvedValue([{ ...bet, esporte: "Basketball" }]);
    await runFlashscoreObservationOnce(now);
    expect(mocks.list).toHaveBeenCalledWith("2026-07-22", 3);
  });

  it("registra esporte desconhecido sem consumir uma chamada", async () => {
    mocks.findMany.mockResolvedValue([{ ...bet, esporte: "Sepak Takraw" }]);
    const result = await runFlashscoreObservationOnce(now);
    expect(result.unsupported).toBe(1);
    expect(mocks.list).not.toHaveBeenCalled();
    // Esporte fora da cobertura não é olhada de jogo: a primeira olhada fica vazia.
    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        resultFinal: true,
        resultSnapshot: { outcome: "unsupported_sport", sport: "Sepak Takraw" },
      }),
    }));
  });

  /**
   * Cota esgotada NÃO derruba o liquidador primário.
   *
   * "Todos os dias falharam" só acusa defeito quando havia mais de um dia para
   * falhar E o motivo foi NOSSO. Contar cota esgotada junto com bug faria um dia
   * sem cota derrubar este job a cada 10min assim que houvesse dois esportes
   * pendentes.
   *
   * A pressão de cota já tem canal próprio (`Budget flashscore em N%`);
   * transformá-la também em dead-letter é ruído sobre informação que o dono já
   * tem. A mesma regra vale no sweep de alias e na rechecagem por inferência.
   */
  it("cota esgotada em TODOS os grupos encerra limpo, não vira dead-letter", async () => {
    mocks.findMany.mockResolvedValue([bet, { ...bet, id: "bet-2", esporte: "Basketball" }]);
    mocks.list.mockResolvedValue(null);

    const result = await runFlashscoreObservationOnce(now);
    expect(result.failures).toBe(2);
    expect(result.settled).toBe(0);
  });

  it("erro NOSSO em todos os grupos continua derrubando o job", async () => {
    mocks.findMany.mockResolvedValue([bet, { ...bet, id: "bet-2", esporte: "Basketball" }]);
    mocks.list.mockRejectedValue(new TypeError("undefined is not a function"));

    await expect(runFlashscoreObservationOnce(now)).rejects.toThrow(/erro nosso/i);
  });

  it("um grupo só falhando NÃO vira dead-letter — o próximo ciclo tenta de novo", async () => {
    mocks.list.mockResolvedValue(null);
    const result = await runFlashscoreObservationOnce(now);
    expect(result.failures).toBe(1);
    expect(result.settled).toBe(0);
  });

  it("estatística fora do contrato é falha da aposta, não fornecedor fora do ar: o lote segue", async () => {
    const corners = { ...bet, id: "bet-corners", mercado: "Total (Corners) – Match", selecao: "Over 9.5" };
    mocks.findMany.mockResolvedValue([corners, bet]);
    mocks.stats.mockRejectedValue(new ProviderRequestError("FlashScore /matches/match/stats", {
      status: 200, error: "payload fora do contrato esperado",
    }));

    const result = await runFlashscoreObservationOnce(now);

    expect(mocks.stats).toHaveBeenCalledOnce();
    expect(result.failures).toBe(1);
    // A aposta seguinte do mesmo dia ainda é liquidada neste ciclo.
    expect(mocks.settleScore.mock.calls.map(([settled]) => settled.id)).toEqual([bet.id]);
    expect(mocks.operationalAlert).toHaveBeenCalled();
  });
});
