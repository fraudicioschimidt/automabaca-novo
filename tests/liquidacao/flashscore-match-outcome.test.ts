import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    SHARP_AUTO_MATCH_MIN_SCORE: 1.5,
  },
  findMany: vi.fn(),
  upsert: vi.fn(),
  list: vi.fn(),
  stats: vi.fn(),
  playerStats: vi.fn(),
  summary: vi.fn(),
  details: vi.fn(),
  settleScore: vi.fn(),
  settleStatus: vi.fn(),
  metric: vi.fn(),
  notify: vi.fn(),
  operationalAlert: vi.fn(),
  cooldown: vi.fn(),
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
    betResult: { upsert: mocks.upsert },
    // A primeira olhada gravada na aposta (`recordFlashscoreFirstCheckTx`).
    $executeRaw: async () => 1,
    // Quem entra na conferência da IA é filtrado no SQL (teste PostgreSQL em
    // flashscore-observation-store.db.test.ts); aqui a fila é o que o findMany devolve.
    $queryRaw: async () => [],
    iaJudgeCooldown: { upsert: mocks.cooldown },
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
  // Sem ficha: nenhum nome traduz.
  const original = (teams: { home: string; away: string }) => ({
    ...teams,
    homeResolution: {
      inputName: teams.home, resolvedName: teams.home, cardId: null, providerTeamId: null, strategy: "original", alternativeNames: [],
    },
    awayResolution: {
      inputName: teams.away, resolvedName: teams.away, cardId: null, providerTeamId: null, strategy: "original", alternativeNames: [],
    },
  });
  return {
    resolveTeamsForProvider: async (teams: { home: string; away: string }) => original(teams),
    resolveTeamsForProviders: async (teams: { home: string; away: string }, providers: readonly string[]) => providers.map(() => original(teams)),
  };
});
vi.mock("@/src/services/settlement/flashscore/score-settle", () => ({
  settleFromFlashscoreScore: mocks.settleScore,
}));
vi.mock("@/src/services/bets/settle", () => ({
  applyAutomaticBetStatusChange: mocks.settleStatus,
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
    getFlashscoreMatchPlayerStats: mocks.playerStats,
    getFlashscoreMatchSummary: mocks.summary,
    getFlashscoreMatchDetails: mocks.details,
  };
});

import { runFlashscoreObservationOnce } from "@/src/services/settlement/flashscore/observation";
import { BudgetExhaustedError, ProviderRequestError } from "@/src/domain/provider-error";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";
import { clearFlashscoreCatalogCache } from "@/src/providers/flashscore/catalog";
import { bet, group, kickoff, now } from "../helpers/flashscore-observation";
import { normalizeBetFields } from "@/src/services/bets/normalize-fields";
import { productionMarketCatalogClient } from "../fixtures/mercados-alias-producao";

/**
 * O que acontece com UMA aposta depois que a partida casou: cada mercado segue
 * seu ramo (placar, estatística, artilheiro, prop de jogador, adiada/cancelada,
 * prorrogação, fim inferido). Roda o ciclo inteiro porque o roteamento só existe
 * lá; o ciclo em si está em `flashscore-observation.test.ts`.
 */
describe("liquidação de aposta casada no FlashScore", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearFlashscoreCatalogCache();
    mocks.findMany.mockResolvedValue([bet]);
    mocks.list.mockResolvedValue(group);
    // Sem chave do FlashScore o cliente real devolve null: o padrão é o mesmo.
    mocks.summary.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue(undefined);
    mocks.metric.mockResolvedValue(undefined);
    mocks.settleScore.mockResolvedValue(true);
    mocks.cooldown.mockResolvedValue(undefined);
  });

  /**
   * Artilheiro é o único mercado que não sai nem do placar nem da estatística
   * de TIME: a pergunta é sobre jogador, e só o `player-stats` responde.
   */
  describe("artilheiro (Marcar a Qualquer Momento)", () => {
    const artilheiro = {
      ...bet,
      id: "bet-gs",
      mercado: "Anytime Goalscorer",
      selecao: "Franco Cristaldo",
    };
    const jogadores = {
      players: [
        {
          player_id: "p1",
          name: "Cristaldo Franco",
          short_name: "Cristaldo F.",
          team_id: "h",
          stats: { GOALS: { raw_value: "1" }, GOALS_OWN: { raw_value: "0" }, MATCH_MINUTES_PLAYED: { raw_value: "90" } },
        },
        {
          player_id: "p2",
          name: "Aguirre Thiago",
          short_name: "Aguirre T.",
          team_id: "a",
          stats: { GOALS: { raw_value: "0" }, GOALS_OWN: { raw_value: "0" }, MATCH_MINUTES_PLAYED: { raw_value: "90" } },
        },
      ],
    };

    beforeEach(() => {
      mocks.findMany.mockResolvedValue([artilheiro]);
      mocks.playerStats.mockResolvedValue(jogadores);
      mocks.settleStatus.mockResolvedValue({
        status: "WON",
        lucro: 1.5,
        previousStatus: "PENDING",
      });
    });

    it("liquida WON pelo jogador certo, mesmo com o nome na ordem invertida", async () => {
      const result = await runFlashscoreObservationOnce(now);
      expect(result).toMatchObject({ settled: 1, unsupported: 0 });
      expect(mocks.settleStatus).toHaveBeenCalledWith(
        expect.objectContaining({ betId: "bet-gs", newStatus: "WON" }),
      );
      // Não passa pelo caminho de placar: 2x3 diria WON por motivo errado.
      expect(mocks.settleScore).not.toHaveBeenCalled();
      // A evidência gravada carrega confiança e fonte.
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultSnapshot: expect.objectContaining({
            settlementOutcome: "settled_from_goalscorer",
            goalscorer: expect.objectContaining({
              resolvido: true,
              jogador: "Cristaldo Franco",
              source: "AUTO",
            }),
          }),
        }),
      }));
    });

    it("liquida LOST quando o jogador jogou e não marcou", async () => {
      mocks.findMany.mockResolvedValue([{ ...artilheiro, selecao: "Thiago Aguirre" }]);
      mocks.settleStatus.mockResolvedValue({
        status: "LOST",
        lucro: -1,
        previousStatus: "PENDING",
      });
      await runFlashscoreObservationOnce(now);
      expect(mocks.settleStatus).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus: "LOST" }),
      );
    });

    it.each([
      ["To Score 3+ Goals", "Franco Cristaldo"],
      ["To Score a Hat-trick", "Franco Cristaldo"],
      ["Anytime Goalscorer", "Franco Cristaldo 3+"],
    ])("'%s' / '%s' com 1 gol sai LOST, não WON", async (mercado, selecao) => {
      mocks.findMany.mockResolvedValue([{ ...artilheiro, mercado, selecao }]);
      mocks.settleStatus.mockResolvedValue({ status: "LOST", lucro: -1, previousStatus: "PENDING" });

      await runFlashscoreObservationOnce(now);

      expect(mocks.settleStatus).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "LOST" }));
    });

    it.each([
      "To Score or Assist",
      "Marcar a Qualquer Momento ou Dar Assistência",
      "To Score a Header",
    ])("'%s' não liquida pelo gol do jogador: vai para o operador", async (mercado) => {
      // Sem gol e com duas assistências: "marcar ou dar assistência" ganhou na casa.
      mocks.playerStats.mockResolvedValue({ players: [{
        player_id: "p1", name: "Cristaldo Franco", team_id: "h",
        stats: { GOALS: { raw_value: "0" }, ASSISTS_GOAL: { raw_value: "2" }, MATCH_MINUTES_PLAYED: { raw_value: "90" } },
      }] });
      mocks.findMany.mockResolvedValue([{ ...artilheiro, mercado }]);

      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ settled: 0, unsupported: 1 });
      expect(mocks.settleStatus).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringContaining("mais que o gol do jogador"),
        expect.objectContaining({ source: "settlement.flashscore-goalscorer" }),
      );
      // A recusa só depende do texto da aposta: não paga a lista de jogadores.
      expect(mocks.playerStats).not.toHaveBeenCalled();
    });

    it("primeiro a marcar de cabeça vai ao operador já na carência, sem buscar o feed", async () => {
      mocks.findMany.mockResolvedValue([{ ...artilheiro, mercado: "First Goalscorer - Header" }]);

      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ settled: 0, unsupported: 1 });
      expect(mocks.settleStatus).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringContaining("mais que o gol do jogador"),
        expect.objectContaining({ source: "settlement.flashscore-ordered-goalscorer" }),
      );
      expect(mocks.playerStats).not.toHaveBeenCalled();
      expect(mocks.summary).not.toHaveBeenCalled();
    });

    it("quantidade de gols sem leitura vai para o operador", async () => {
      mocks.findMany.mockResolvedValue([{ ...artilheiro, selecao: "Franco Cristaldo over 1.5" }]);

      await runFlashscoreObservationOnce(now);

      expect(mocks.settleStatus).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringContaining("quantos gols a aposta pede"),
        expect.objectContaining({ source: "settlement.flashscore-goalscorer" }),
      );
    });

    it("nome que não bate vira ação manual, nunca chute liquidado", async () => {
      mocks.findMany.mockResolvedValue([{ ...artilheiro, selecao: "Erling Haaland" }]);
      const result = await runFlashscoreObservationOnce(now);
      expect(result).toMatchObject({ settled: 0, unsupported: 1 });
      expect(mocks.settleStatus).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringContaining("Erling Haaland"),
        expect.objectContaining({
          source: "settlement.flashscore-goalscorer",
          autoResolve: false,
        }),
      );
    });

    it("homônimos na mesma partida param no operador", async () => {
      mocks.playerStats.mockResolvedValue({
        players: [
          { player_id: "s1", name: "Silva", stats: { GOALS: { raw_value: "1" } } },
          { player_id: "s2", name: "Silva", stats: { GOALS: { raw_value: "0" } } },
        ],
      });
      mocks.findMany.mockResolvedValue([{ ...artilheiro, selecao: "Silva" }]);
      const result = await runFlashscoreObservationOnce(now);
      expect(result).toMatchObject({ settled: 0, unsupported: 1 });
      expect(mocks.settleStatus).not.toHaveBeenCalled();
    });

    it("duas apostas da mesma partida custam UMA chamada de player-stats", async () => {
      mocks.findMany.mockResolvedValue([
        artilheiro,
        { ...artilheiro, id: "bet-gs2", selecao: "Thiago Aguirre" },
      ]);
      await runFlashscoreObservationOnce(now);
      expect(mocks.playerStats).toHaveBeenCalledTimes(1);
    });

    /**
     * Escalação que ainda não saiu ≠ escalação que não vai sair.
     *
     * A primeira leitura terminal chega antes de o feed publicar os jogadores, e
     * tratar isso como recusa definitiva custava DUAS coisas ao mesmo tempo: um
     * alerta de "resolver manualmente" para um dado que apareceria sozinho, e a
     * observação fechada de vez — `resultFinal: true` tira a aposta de
     * `listFlashscoreEligibleBets` e ela nunca mais volta. O caminho estatístico
     * irmão já esperava 6h pelo mesmo motivo.
     */
    it("lista de jogadores ainda não publicada espera, sem alertar nem fechar", async () => {
      mocks.playerStats.mockResolvedValue({ players: [] });

      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ settled: 0, unsupported: 0 });
      expect(mocks.operationalAlert).not.toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: false,
          resultSnapshot: expect.objectContaining({
            settlementOutcome: "goalscorer_pending",
          }),
        }),
      }));
    });

    it("passada a carência, aí sim chama o operador e fecha", async () => {
      mocks.playerStats.mockResolvedValue({ players: [] });
      // Sete horas depois do kickoff: se não publicou até aqui, não publica.
      const tarde = new Date(kickoff.getTime() + 7 * 3_600_000);

      const result = await runFlashscoreObservationOnce(tarde);

      expect(result).toMatchObject({ settled: 0, unsupported: 1 });
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringContaining("não publicou a lista de jogadores"),
        expect.objectContaining({
          source: "settlement.flashscore-goalscorer",
          autoResolve: false,
        }),
      );
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ resultFinal: true }),
      }));
    });

    it("breaker aberto na lista de jogadores não é falha da aposta: sem alerta e sem gravar", async () => {
      mocks.playerStats.mockRejectedValue(new CircuitOpenError("flashscore"));

      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ settled: 0, failures: 0 });
      expect(mocks.settleStatus).not.toHaveBeenCalled();
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).not.toHaveBeenCalled();
    });
  });

  /**
   * Props de jogador usam o mesmo `player-stats` do artilheiro, mas NUNCA o
   * placar nem as faltas/chutes do TIME. Uma prop gravada como Total – Match
   * (Bahia×Vasco) não pode liquidar pelo 0-0.
   */
  describe("prop de jogador (Fase 1 futebol)", () => {
    const prop = {
      ...bet,
      id: "bet-wj",
      mercado: "Total – Match",
      selecao: "willian jose over 0,5 sofre falta",
    };
    const jogadores = {
      players: [
        {
          player_id: "jD7L6o7T",
          name: "Willian Jose",
          short_name: "Willian J.",
          team_id: "h",
          stats: {
            GOALS: { raw_value: "0" },
            GOALS_OWN: { raw_value: "0" },
            FOULS_SUFFERED: { raw_value: "1" },
            FOULS_COMMITTED: { raw_value: "0" },
          },
        },
      ],
    };

    beforeEach(() => {
      mocks.findMany.mockResolvedValue([prop]);
      mocks.playerStats.mockResolvedValue(jogadores);
      mocks.settleStatus.mockResolvedValue({
        status: "WON",
        lucro: 1.5,
        previousStatus: "PENDING",
      });
    });

    it("Willian José Over 0.5 sofre falta liquida WON sem passar pelo placar", async () => {
      const result = await runFlashscoreObservationOnce(now);
      expect(result).toMatchObject({ settled: 1, unsupported: 0 });
      expect(mocks.settleStatus).toHaveBeenCalledWith(
        expect.objectContaining({ betId: "bet-wj", newStatus: "WON" }),
      );
      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.stats).not.toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultSnapshot: expect.objectContaining({
            settlementOutcome: "settled_from_player_prop",
            playerProp: expect.objectContaining({
              resolvido: true,
              jogador: "Willian Jose",
              chave: "FOULS_SUFFERED",
              valor: 1,
              source: "AUTO",
            }),
          }),
        }),
      }));
    });

    it("chave ausente não inventa zero — vai ao operador", async () => {
      mocks.playerStats.mockResolvedValue({
        players: [{
          player_id: "jD7L6o7T",
          name: "Willian Jose",
          stats: { GOALS: { raw_value: "0" }, FOULS_COMMITTED: { raw_value: "0" } },
        }],
      });
      const result = await runFlashscoreObservationOnce(now);
      expect(result).toMatchObject({ settled: 0, unsupported: 1 });
      expect(mocks.settleStatus).not.toHaveBeenCalled();
      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringContaining("estatística deste jogador"),
        expect.objectContaining({
          source: "settlement.flashscore-player-prop",
          autoResolve: false,
        }),
      );
    });

    it("lista vazia espera a carência, sem alertar nem fechar", async () => {
      mocks.playerStats.mockResolvedValue({ players: [] });
      const result = await runFlashscoreObservationOnce(now);
      expect(result).toMatchObject({ settled: 0, unsupported: 0 });
      expect(mocks.operationalAlert).not.toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: false,
          resultSnapshot: expect.objectContaining({
            settlementOutcome: "player_prop_pending",
          }),
        }),
      }));
    });
  });

  /**
   * Criar Aposta com perna de artilheiro passa pelo placar, mas a perna só
   * sai da lista de jogadores, que o feed publica com atraso.
   */
  describe("Criar Aposta com perna de jogador", () => {
    const criarAposta = {
      ...bet,
      id: "bet-bb",
      mercado: "Criar Aposta",
      selecao: "Over 2.5 + Franco Cristaldo",
      legsJson: { kind: "same_game", legs: [
        { evento: bet.evento, mercado: "Total – Match", selecao: "Over 2.5" },
        { evento: bet.evento, mercado: "Marcar a Qualquer Momento", selecao: "Franco Cristaldo" },
      ] },
    };

    beforeEach(() => {
      mocks.findMany.mockResolvedValue([criarAposta]);
      mocks.playerStats.mockResolvedValue({ players: [] });
      // A lista vazia faz o liquidador de placar recusar a perna de jogador.
      mocks.settleScore.mockResolvedValue(false);
    });

    it("lista que ainda não saiu: a observação fica aberta, sem alerta de falha", async () => {
      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ matched: 1, settled: 0, failures: 0 });
      expect(mocks.operationalAlert).not.toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: false,
          resultSnapshot: expect.objectContaining({ settlementOutcome: "score_extras_pending" }),
        }),
      }));
    });

    it("passada a carência, a observação fecha", async () => {
      const tarde = new Date(kickoff.getTime() + 7 * 3_600_000);

      await runFlashscoreObservationOnce(tarde);

      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ resultFinal: true }),
      }));
    });

    it.each([
      ["HTTP 503", new ProviderRequestError("flashscore", { error: "temporariamente indisponível", status: 503 })],
      ["breaker aberto", new CircuitOpenError("flashscore")],
      ["cota esgotada", new BudgetExhaustedError("flashscore")],
    ])("provider fora do ar (%s) não é falha da aposta: sem alerta e sem gravar", async (_label, error) => {
      mocks.playerStats.mockRejectedValue(error);

      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ settled: 0, failures: 0 });
      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).not.toHaveBeenCalled();
    });
  });

  /**
   * "Both Teams to Score" é o nome que a captura grava para Ambas Marcam: sai
   * do placar, sem pagar a lista de jogadores nem chamar o operador.
   */
  it.each([["Ambas Marcam", "Sim", "Yes"], ["Ambas Marcam", "Não", "No"]])(
    "'%s' / '%s' gravado pela captura liquida pelo placar",
    async (mercado, selecao, gravada) => {
      const normalized = await normalizeBetFields({
        evento: bet.evento, mercado, selecao, esporte: "Soccer", client: productionMarketCatalogClient(),
      });
      expect(normalized).toMatchObject({ mercado: "Both Teams to Score", selecao: gravada });
      mocks.findMany.mockResolvedValue([{ ...bet, mercado: normalized.mercado, selecao: normalized.selecao }]);

      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ settled: 1, unsupported: 0 });
      expect(mocks.settleScore).toHaveBeenCalledWith(
        expect.objectContaining({ mercado: "Both Teams to Score", selecao: gravada }),
        { homeScore: 2, awayScore: 3 },
        expect.anything(),
      );
      expect(mocks.playerStats).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).not.toHaveBeenCalled();
    },
  );

  /**
   * Criar Aposta num jogo que foi à prorrogação: as pernas de placar usam os
   * 90' reconstruídos, mas a estatística de jogador do feed soma a prorrogação.
   * 1-1 nos 90' e 2-1 no fim, com o gol de Cristaldo aos 105'.
   */
  describe("Criar Aposta com perna de jogador num jogo decidido na prorrogação", () => {
    const criarAposta = (total: string) => ({
      ...bet,
      id: "bet-et",
      mercado: "Total – Match",
      selecao: `${total} + Franco Cristaldo`,
      legsJson: { kind: "same_game", legs: [
        { evento: bet.evento, mercado: "Total – Match", selecao: total },
        { evento: bet.evento, mercado: "Marcar a Qualquer Momento", selecao: "Franco Cristaldo" },
      ] },
    });
    const golDe = (minutes: string, team: "home" | "away", playerId: string, nome: string) => ({
      minutes, team, players: [{ type: "Goal", name: nome, player_id: playerId, player_url: `/player/x/${playerId}/` }],
    });

    beforeEach(() => {
      mocks.list.mockResolvedValue([{ matches: [{
        ...group[0]!.matches[0]!,
        scores: { home: 2, away: 1 },
        match_status: {
          ...group[0]!.matches[0]!.match_status,
          stage: "After Extra Time",
          is_finished_after_extra_time: true,
        },
      }] }]);
      mocks.summary.mockResolvedValue([
        golDe("30", "home", "p3", "Silva J."),
        golDe("60", "away", "p2", "Aguirre T."),
        golDe("105", "home", "p1", "Cristaldo F."),
      ]);
      mocks.playerStats.mockResolvedValue({ players: [
        { player_id: "p1", name: "Cristaldo Franco", team_id: "h",
          stats: { GOALS: { raw_value: "1" }, GOALS_OWN: { raw_value: "0" }, MATCH_MINUTES_PLAYED: { raw_value: "120" } } },
      ] });
    });

    it("a perna de jogador não se decide pela estatística com a prorrogação: vai para o dono", async () => {
      mocks.findMany.mockResolvedValue([criarAposta("Over 1.5")]);

      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ settled: 0, unsupported: 1 });
      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.playerStats).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringMatching(/prorroga/i),
        expect.objectContaining({ source: "settlement.flashscore-extra-time", key: "bet-et" }),
      );
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: true,
          resultSnapshot: expect.objectContaining({ settlementOutcome: "manual_extra_time" }),
        }),
      }));
    });

    it("perna de placar perdida nos 90' decide o bilhete, sem a lista de jogadores", async () => {
      mocks.findMany.mockResolvedValue([criarAposta("Over 2.5")]);

      await runFlashscoreObservationOnce(now);

      expect(mocks.operationalAlert).not.toHaveBeenCalled();
      expect(mocks.playerStats).not.toHaveBeenCalled();
      expect(mocks.settleScore).toHaveBeenCalledWith(
        expect.objectContaining({ id: "bet-et" }),
        { homeScore: 1, awayScore: 1 },
        expect.objectContaining({ regulationScore: { home: 1, away: 1 }, players: null }),
      );
    });
  });

  /**
   * Jogo decidido nos pênaltis sem gol depois dos 90': 1-1, gol de Cristaldo
   * aos 30'. A lista de jogadores é do jogo inteiro: a contagem de gols é a dos
   * 90', e o resto somaria a prorrogação, que o feed não prova que não houve.
   */
  describe("Criar Aposta com perna de jogador num jogo decidido nos pênaltis", () => {
    const criarAposta = (playerLeg: { mercado: string; selecao: string }) => ({
      ...bet,
      id: "bet-pen",
      mercado: "Total – Match",
      selecao: `Over 1.5 + ${playerLeg.selecao}`,
      legsJson: { kind: "same_game", legs: [
        { evento: bet.evento, mercado: "Total – Match", selecao: "Over 1.5" },
        { evento: bet.evento, ...playerLeg },
      ] },
    });
    const goalLeg = { mercado: "Marcar a Qualquer Momento", selecao: "Franco Cristaldo" };
    // A estatística só no mercado da perna: escrita na seleção do bilhete, ela o levaria ao ramo de estatística.
    const shotsLeg = { mercado: "Player Shots On Target", selecao: "Franco Cristaldo" };
    const golDe = (minutes: string, team: "home" | "away", playerId: string, nome: string) => ({
      minutes, team, players: [{ type: "Goal", name: nome, player_id: playerId, player_url: `/player/x/${playerId}/` }],
    });
    const jogador = (playerId: string, name: string, teamId: string, gols: string, minutos: string) => ({
      player_id: playerId, name, team_id: teamId,
      stats: {
        GOALS: { raw_value: gols }, GOALS_OWN: { raw_value: "0" }, MATCH_MINUTES_PLAYED: { raw_value: minutos },
        SHOTS_ON_TARGET: { raw_value: "1" },
      },
    });
    const jogadores = (minutos: string) => ({ players: [
      jogador("p1", "Cristaldo Franco", "h", "1", minutos),
      jogador("p2", "Aguirre Thiago", "a", "1", minutos),
    ] });
    const finishedAfterPenalties = (extraTimeFlag: boolean) => mocks.list.mockResolvedValue([{ matches: [{
      ...group[0]!.matches[0]!,
      scores: { home: 1, away: 1 },
      match_status: {
        ...group[0]!.matches[0]!.match_status,
        stage: "After Penalties",
        is_finished_after_penalties: true,
        is_finished_after_extra_time: extraTimeFlag,
      },
    }] }]);

    beforeEach(() => {
      finishedAfterPenalties(false);
      mocks.summary.mockResolvedValue([
        golDe("30", "home", "p1", "Cristaldo F."),
        golDe("60", "away", "p2", "Aguirre T."),
      ]);
    });

    it.each([
      [false, "90"],
      [true, "120"],
    ])("sem gol depois dos 90', a perna de gol liquida pela lista (prorrogação marcada: %s, minutos %s)", async (extraTimeFlag, minutos) => {
      finishedAfterPenalties(extraTimeFlag);
      mocks.findMany.mockResolvedValue([criarAposta(goalLeg)]);
      mocks.playerStats.mockResolvedValue(jogadores(minutos));

      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ settled: 1, unsupported: 0 });
      expect(mocks.operationalAlert).not.toHaveBeenCalled();
      expect(mocks.settleScore).toHaveBeenCalledWith(
        expect.objectContaining({ id: "bet-pen" }),
        { homeScore: 1, awayScore: 1 },
        expect.objectContaining({
          regulationScore: { home: 1, away: 1 },
          players: expect.arrayContaining([expect.objectContaining({ nome: "Cristaldo Franco", gols: 1 })]),
        }),
      );
    });

    it("lista que conta mais gols que o placar vai para o dono", async () => {
      mocks.findMany.mockResolvedValue([criarAposta(goalLeg)]);
      mocks.playerStats.mockResolvedValue({ players: [...jogadores("90").players, jogador("p3", "Silva Joao", "h", "2", "90")] });

      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ settled: 0, unsupported: 1 });
      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringMatching(/conta mais gols que o placar/),
        expect.objectContaining({ source: "settlement.flashscore-extra-time", key: "bet-pen" }),
      );
    });

    it.each([
      [false, /não diz se houve prorrogação/],
      [true, /soma a prorrogação/],
    ])("a perna de chutes vai para o dono sem buscar a lista (prorrogação marcada: %s)", async (extraTimeFlag, why) => {
      finishedAfterPenalties(extraTimeFlag);
      mocks.findMany.mockResolvedValue([criarAposta(shotsLeg)]);

      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ settled: 0, unsupported: 1 });
      expect(mocks.playerStats).not.toHaveBeenCalled();
      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringMatching(why),
        expect.objectContaining({ source: "settlement.flashscore-extra-time", key: "bet-pen" }),
      );
    });
  });

  it("modo fallback liquida placar de basquete, não apenas futebol", async () => {
    mocks.findMany.mockResolvedValue([{ ...bet, esporte: "Basketball" }]);
    const result = await runFlashscoreObservationOnce(now);
    expect(result.settled).toBe(1);
    expect(mocks.settleScore).toHaveBeenCalledWith(
      expect.objectContaining({ esporte: "Basketball" }),
      { homeScore: 2, awayScore: 3 },
      expect.objectContaining({ scoredEvento: expect.any(String) }),
    );
  });

  it("modo fallback liquida cartões com as estatísticas do FlashScore", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      mercado: "Total (Bookings) – Match",
      selecao: "Under 5.5",
    }]);
    mocks.stats.mockResolvedValue({
      match: [
        { name: "Yellow cards", home_team: 2, away_team: 3 },
        { name: "Red cards", home_team: 0, away_team: 1 },
      ],
    });
    mocks.settleStatus.mockResolvedValue({ previousStatus: "PENDING", status: "LOST", lucro: -1 });

    const result = await runFlashscoreObservationOnce(now);

    expect(result.settled).toBe(1);
    expect(mocks.settleStatus).toHaveBeenCalledWith({
      betId: "bet-1",
      newStatus: "LOST",
      source: "flashscore",
      expectedTerms: { ...bet, mercado: "Total (Bookings) – Match" },
    });
  });

  it.each([
    {
      mercado: "Total (Corners) – 1st Half",
      selecao: "Over 4.5",
      period: "1st-half" as const,
      periodRows: [{ name: "Corner kicks", home_team: 3, away_team: 2 }],
    },
    {
      mercado: "Total (Corners) – 2nd Half",
      selecao: "Under 5.5",
      period: "2nd-half" as const,
      periodRows: [{ name: "Corner kicks", home_team: 2, away_team: 2 }],
    },
    {
      // Gravada antes de o período da seleção ir para o mercado.
      mercado: "Total (Corners) – Match",
      selecao: "Over 4.5 HT",
      period: "1st-half" as const,
      periodRows: [{ name: "Corner kicks", home_team: 3, away_team: 2 }],
    },
  ])("liquida estatísticas do bloco $period ($mercado / $selecao)", async ({ mercado, selecao, period, periodRows }) => {
    mocks.findMany.mockResolvedValue([{ ...bet, mercado, selecao }]);
    mocks.stats.mockResolvedValue({
      match: [{ name: "Corner kicks", home_team: 10, away_team: 8 }],
      [period]: periodRows,
    });
    mocks.settleStatus.mockResolvedValue({ previousStatus: "PENDING", status: "WON", lucro: 0.9 });

    const result = await runFlashscoreObservationOnce(now);

    expect(result.settled).toBe(1);
    expect(mocks.settleStatus).toHaveBeenCalledWith({
      betId: "bet-1",
      newStatus: "WON",
      source: "flashscore",
      expectedTerms: { ...bet, mercado, selecao },
    });
  });

  it("não usa cartão vermelho FT como fallback em mercado de 1º tempo", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      mercado: "Total (Bookings) – 1st Half",
      selecao: "Under 4.5",
    }]);
    mocks.list.mockResolvedValue([{ matches: [{
      ...group[0]!.matches[0]!,
      home_team: { ...group[0]!.matches[0]!.home_team, red_cards: 0 },
      away_team: { ...group[0]!.matches[0]!.away_team, red_cards: 1 },
      match_status: {
        ...group[0]!.matches[0]!.match_status,
        is_finished_after_extra_time: true,
      },
    }] }]);
    mocks.stats.mockResolvedValue({
      match: [
        { name: "Yellow cards", home_team: 3, away_team: 3 },
        { name: "Red cards", home_team: 0, away_team: 1 },
      ],
      "1st-half": [{ name: "Yellow cards", home_team: 2, away_team: 2 }],
    });
    mocks.settleStatus.mockResolvedValue({ previousStatus: "PENDING", status: "WON", lucro: 0.9 });

    const result = await runFlashscoreObservationOnce(now);

    expect(result.settled).toBe(1);
    expect(mocks.settleStatus).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "WON" }));
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        resultSnapshot: expect.objectContaining({
          stats: expect.objectContaining({ redCards: null }),
        }),
      }),
    }));
  });

  it("completa cartões vermelhos com a listagem quando o endpoint de stats omite a linha", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      mercado: "Total (Bookings) – Match",
      selecao: "Under 5.5",
    }]);
    mocks.list.mockResolvedValue([{ matches: [{
      ...group[0]!.matches[0]!,
      home_team: { ...group[0]!.matches[0]!.home_team, red_cards: 0 },
      away_team: { ...group[0]!.matches[0]!.away_team, red_cards: 1 },
    }] }]);
    mocks.stats.mockResolvedValue({
      match: [{ name: "Yellow cards", home_team: 2, away_team: 2 }],
    });
    mocks.settleStatus.mockResolvedValue({ previousStatus: "PENDING", status: "LOST", lucro: -1 });

    await runFlashscoreObservationOnce(now);

    expect(mocks.settleStatus).toHaveBeenCalledWith(expect.objectContaining({
      newStatus: "LOST",
    }));
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        resultSnapshot: expect.objectContaining({
          stats: expect.objectContaining({ redCards: { home: 0, away: 1 } }),
        }),
      }),
    }));
  });

  it("depois da graça pede o par de escanteios, não WON/LOST pelo placar", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      mercado: "Handicap (Corners) – Match",
      selecao: "Operario Ferroviario +1",
    }]);
    mocks.stats.mockResolvedValue({ match: [] });

    const tarde = new Date(kickoff.getTime() + 7 * 3_600_000);
    await runFlashscoreObservationOnce(tarde);

    expect(mocks.settleStatus).not.toHaveBeenCalled();
    expect(mocks.settleScore).not.toHaveBeenCalled();
    expect(mocks.operationalAlert).toHaveBeenCalledWith(
      expect.stringMatching(/par de escanteios/),
      expect.objectContaining({
        source: "settlement.flashscore-missing-stats",
        resourceId: "bet-1",
      }),
    );
  });

  it("Race to corners não cai no liquidador de placar", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      mercado: "Race to 3 Corners",
      selecao: "Athletic Club",
    }]);

    const result = await runFlashscoreObservationOnce(now);

    expect(result).toMatchObject({ settled: 0, unsupported: 1 });
    expect(mocks.settleScore).not.toHaveBeenCalled();
    expect(mocks.stats).not.toHaveBeenCalled();
    expect(mocks.operationalAlert).toHaveBeenCalledWith(
      expect.stringMatching(/primeiro a N/),
      expect.objectContaining({
        source: "settlement.flashscore-stat-unsupported",
        resourceId: "bet-1",
      }),
    );
  });

  it("mantém retry quando a estatística final ainda não foi publicada", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      mercado: "Handicap (Corners) – Match",
      selecao: "Operario Ferroviario +1",
    }]);
    mocks.stats.mockResolvedValue({ match: [] });

    await runFlashscoreObservationOnce(now);

    expect(mocks.settleStatus).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        resultFinal: false,
        resultSnapshot: expect.objectContaining({ settlementOutcome: "stats_pending" }),
      }),
    }));
  });

  it("alerta e mantém retry quando o endpoint de estatísticas falha", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      mercado: "Handicap (Corners) – Match",
      selecao: "Operario Ferroviario +1",
    }]);
    mocks.stats.mockRejectedValue(new Error("RapidAPI 503"));

    const result = await runFlashscoreObservationOnce(now);

    expect(result).toMatchObject({ matched: 1, settled: 0, failures: 1 });
    expect(mocks.settleStatus).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.operationalAlert).toHaveBeenCalledWith(
      expect.stringMatching(/1 aposta.*não foram conferidas/i),
      expect.objectContaining({ source: "settlement.flashscore" }),
    );
    // A amostra nomeia o jogo e diz o que fazer, não só o id interno.
    const [message] = mocks.operationalAlert.mock.calls[0] as [string];
    expect(message).toContain(`• ${bet.evento}: `);
    expect(message).toContain("👉");
  });

  it("modo fallback segura partida adiada na graça de 48h sem reembolsar", async () => {
    mocks.list.mockResolvedValue([{ matches: [{
      ...group[0]!.matches[0]!,
      scores: { home: null, away: null },
      match_status: {
        ...group[0]!.matches[0]!.match_status,
        stage: "Postponed",
        is_postponed: true,
        is_finished: false,
      },
    }] }]);

    const result = await runFlashscoreObservationOnce(now);

    expect(result.refunded).toBe(0);
    expect(mocks.settleStatus).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        resultFinal: false,
        resultSnapshot: expect.objectContaining({ settlementOutcome: "postponed_waiting" }),
      }),
    }));
  });

  it("modo fallback reembolsa partida adiada após a graça de 48h", async () => {
    mocks.list.mockResolvedValue([{ matches: [{
      ...group[0]!.matches[0]!,
      scores: { home: null, away: null },
      match_status: {
        ...group[0]!.matches[0]!.match_status,
        stage: "Postponed",
        is_postponed: true,
        is_finished: false,
      },
    }] }]);
    mocks.settleStatus.mockResolvedValue({ previousStatus: "PENDING", status: "VOID", lucro: 0 });

    const depois = new Date(kickoff.getTime() + 49 * 3_600_000);
    const result = await runFlashscoreObservationOnce(depois);

    expect(result.refunded).toBe(1);
    expect(mocks.settleStatus).toHaveBeenCalledWith({
      betId: "bet-1",
      newStatus: "VOID",
      source: "flashscore",
      expectedTerms: bet,
    });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ resultFinal: true }),
    }));
  });

  it("modo fallback reembolsa partida cancelada imediatamente", async () => {
    mocks.list.mockResolvedValue([{ matches: [{
      ...group[0]!.matches[0]!,
      scores: { home: null, away: null },
      match_status: {
        ...group[0]!.matches[0]!.match_status,
        stage: "Cancelled",
        is_cancelled: true,
        is_finished: false,
      },
    }] }]);
    mocks.settleStatus.mockResolvedValue({ previousStatus: "PENDING", status: "VOID", lucro: 0 });

    const result = await runFlashscoreObservationOnce(now);

    expect(result.refunded).toBe(1);
  });

  /**
   * Jogo que não aconteceu não paga estatística. `final` é verdadeiro nos três
   * casos — terminou, cancelou, adiou —; um portão de stats que olhasse só para
   * ele compraria a linha de escanteios de um jogo cancelado e a jogaria fora
   * no reembolso, uma chamada por aposta, todo ciclo.
   */
  it.each([
    { rotulo: "cancelada", status: { is_cancelled: true, is_postponed: false } },
    { rotulo: "adiada", status: { is_cancelled: false, is_postponed: true } },
  ])("não gasta cota de estatística em partida $rotulo", async ({ status }) => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      mercado: "Total (Corners) – Match",
      selecao: "Over 9.5",
    }]);
    mocks.list.mockResolvedValue([{ matches: [{
      ...group[0]!.matches[0]!,
      scores: { home: null, away: null },
      match_status: {
        ...group[0]!.matches[0]!.match_status,
        ...status,
        is_finished: false,
      },
    }] }]);
    mocks.settleStatus.mockResolvedValue({ previousStatus: "PENDING", status: "VOID", lucro: 0 });

    await runFlashscoreObservationOnce(now);

    expect(mocks.stats).not.toHaveBeenCalled();
  });

  it("modo fallback recusa liquidar jogo decidido na prorrogação/pênaltis", async () => {
    mocks.list.mockResolvedValue([{ matches: [{
      ...group[0]!.matches[0]!,
      scores: { home: 2, away: 1 },
      match_status: {
        ...group[0]!.matches[0]!.match_status,
        stage: "Finished after extra time",
        is_finished: true,
        is_finished_after_extra_time: true,
      },
    }] }]);

    // Depois da graça do resumo de gols: antes dela, os 90' ainda podem sair.
    const result = await runFlashscoreObservationOnce(new Date(kickoff.getTime() + 7 * 3_600_000));

    expect(result.settled).toBe(0);
    expect(result.unsupported).toBe(1);
    expect(mocks.settleScore).not.toHaveBeenCalled();
    expect(mocks.operationalAlert).toHaveBeenCalledWith(
      expect.stringMatching(/prorroga/i),
      expect.objectContaining({ source: "settlement.flashscore-extra-time" }),
    );
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        resultFinal: true,
        resultSnapshot: expect.objectContaining({ settlementOutcome: "manual_extra_time" }),
      }),
    }));
  });

  it("basquete na prorrogação: aposta no empate vai para o operador, não sai LOST pelo 110-105", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      esporte: "Basketball",
      mercado: "1X2",
      selecao: "Empate",
    }]);
    mocks.list.mockResolvedValue([{ matches: [{
      ...group[0]!.matches[0]!,
      scores: { home: 110, away: 105 },
      match_status: {
        ...group[0]!.matches[0]!.match_status,
        stage: "After Overtime",
        is_finished: true,
        is_finished_after_extra_time: true,
      },
    }] }]);

    const result = await runFlashscoreObservationOnce(now);

    expect(result.settled).toBe(0);
    expect(mocks.settleScore).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        resultSnapshot: expect.objectContaining({ settlementOutcome: "manual_extra_time" }),
      }),
    }));
  });

  /**
   * Os quatro textos reais de 1X2/tempo regulamentar do basquete, gravados
   * pela captura: 100-100 no tempo normal e 110-105 depois da prorrogação.
   */
  describe("1X2 do basquete gravado pela captura", () => {
    const TEXTOS: Array<[string, string]> = [
      ["1X2", "Athletic Club"],
      ["Tempo Regular", "Athletic Club"],
      ["Resultado Final 1x2", "1"],
      ["Resultado Final", "1 (TR)"],
    ];
    const capturada = async (mercado: string, selecao: string) => {
      const normalized = await normalizeBetFields({
        evento: bet.evento, mercado, selecao, esporte: "Basketball", client: productionMarketCatalogClient(),
      });
      return { ...bet, esporte: "Basketball", mercado: normalized.mercado, selecao: normalized.selecao };
    };
    const jogo = (stage: string, scores: { home: number; away: number }, overtime: boolean) => [{ matches: [{
      ...group[0]!.matches[0]!,
      scores,
      match_status: {
        ...group[0]!.matches[0]!.match_status,
        stage,
        is_finished: true,
        is_finished_after_extra_time: overtime,
      },
    }] }];

    it.each(TEXTOS)("'%s' / '%s' com prorrogação vai para o operador, não sai WON pelo 110-105", async (mercado, selecao) => {
      mocks.findMany.mockResolvedValue([await capturada(mercado, selecao)]);
      mocks.list.mockResolvedValue(jogo("After Overtime", { home: 110, away: 105 }, true));

      const result = await runFlashscoreObservationOnce(now);

      expect(result.settled).toBe(0);
      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultSnapshot: expect.objectContaining({ settlementOutcome: "manual_extra_time" }),
        }),
      }));
    });

    it.each(TEXTOS)("'%s' / '%s' sem prorrogação liquida pelo placar do jogo", async (mercado, selecao) => {
      const capturedBet = await capturada(mercado, selecao);
      mocks.findMany.mockResolvedValue([capturedBet]);
      mocks.list.mockResolvedValue(jogo("Finished", { home: 100, away: 98 }, false));

      await runFlashscoreObservationOnce(now);

      expect(mocks.settleScore).toHaveBeenCalledWith(
        expect.objectContaining({ mercado: "Money Line – Regulation Time" }),
        { homeScore: 100, awayScore: 98 },
        expect.objectContaining({ regulationScore: { home: 100, away: 98 } }),
      );
    });
  });

  it("liquida o agregado após prorrogação quando o mercado declara incluindo prolongamento", async () => {
    mocks.findMany.mockResolvedValue([{
      ...bet,
      mercado: "Total incluindo prolongamento",
      selecao: "Over 2.5",
    }]);
    mocks.list.mockResolvedValue([{ matches: [{
      ...group[0]!.matches[0]!,
      scores: { home: 2, away: 1 },
      match_status: {
        ...group[0]!.matches[0]!.match_status,
        stage: "Finished after extra time",
        is_finished: true,
        is_finished_after_extra_time: true,
      },
    }] }]);

    const result = await runFlashscoreObservationOnce(now);

    expect(result.settled).toBe(1);
    expect(result.unsupported).toBe(0);
    expect(mocks.settleScore).toHaveBeenCalledWith(
      expect.objectContaining({ mercado: "Total incluindo prolongamento" }),
      { homeScore: 2, awayScore: 1 },
      expect.objectContaining({ scoredEvento: expect.any(String) }),
    );
  });

  /**
   * A fila traz apostas que o IA-Judge liquidou (`listFlashscoreEligibleBets`):
   * o FlashScore confere, sem nunca liquidar nem desfazer.
   */
  describe("conferência da liquidação feita pela IA", () => {
    it("placar que confirma o resultado da IA não alerta", async () => {
      // 2x3 com Under 5.5: WON.
      mocks.findMany.mockResolvedValue([{ ...bet, status: "WON" }]);

      await runFlashscoreObservationOnce(now);

      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).not.toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: true,
          resultSnapshot: expect.objectContaining({ settlementOutcome: "crosscheck_agrees" }),
        }),
      }));
    });

    it("placar que contradiz a IA vira alerta de risco alto e tira a aposta da IA, sem mexer nela", async () => {
      mocks.findMany.mockResolvedValue([{ ...bet, status: "LOST" }]);

      await runFlashscoreObservationOnce(now);

      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.settleStatus).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringContaining("IA e FlashScore divergem"),
        expect.objectContaining({
          source: "settlement.ia-judge-crosscheck",
          key: "bet-1",
          risk: "HIGH",
          autoResolve: false,
        }),
      );
      const [texto] = mocks.operationalAlert.mock.calls[0]!;
      expect(texto).toContain("corrija em Operações liquidando com o resultado certo");
      expect(texto).not.toContain("Pendente");
      // A IA não volta a sugerir nem liquidar até o dono (ou o FlashScore) decidir.
      expect(mocks.cooldown).toHaveBeenCalledWith(expect.objectContaining({
        where: { key: "bet:bet-1" },
        create: expect.objectContaining({ reason: "flashscore_crosscheck_divergence" }),
      }));
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultSnapshot: expect.objectContaining({ settlementOutcome: "crosscheck_diverges" }),
        }),
      }));
    });

    it("prorrogação que o placar não decide avisa que a liquidação da IA ficou sem conferência", async () => {
      mocks.findMany.mockResolvedValue([{ ...bet, status: "WON" }]);
      mocks.list.mockResolvedValue([{ matches: [{
        ...group[0]!.matches[0]!,
        match_status: {
          ...group[0]!.matches[0]!.match_status,
          stage: "After Extra Time",
          is_finished_after_extra_time: true,
        },
      }] }]);

      await runFlashscoreObservationOnce(now);

      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringContaining("Não consegui conferir a liquidação da IA"),
        expect.objectContaining({ source: "settlement.ia-judge-crosscheck", key: "bet-1" }),
      );
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultSnapshot: expect.objectContaining({ settlementOutcome: "crosscheck_extra_time" }),
        }),
      }));
    });

    it("jogo interrompido também avisa, sem comparar pelo placar da interrupção", async () => {
      mocks.findMany.mockResolvedValue([{ ...bet, status: "WON" }]);
      mocks.list.mockResolvedValue([{ matches: [{
        ...group[0]!.matches[0]!,
        match_status: { ...group[0]!.matches[0]!.match_status, stage: "Awarded" },
      }] }]);

      await runFlashscoreObservationOnce(now);

      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringContaining("não foi jogado até o fim"),
        expect.objectContaining({ source: "settlement.ia-judge-crosscheck" }),
      );
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultSnapshot: expect.objectContaining({ settlementOutcome: "crosscheck_interrupted" }),
        }),
      }));
    });

    it("jogo ainda em andamento segue na fila, sem comparar", async () => {
      mocks.findMany.mockResolvedValue([{ ...bet, status: "LOST" }]);
      mocks.list.mockResolvedValue([{ matches: [{
        ...group[0]!.matches[0]!,
        match_status: { ...group[0]!.matches[0]!.match_status, stage: "2nd Half", is_finished: false },
      }] }]);

      await runFlashscoreObservationOnce(now);

      expect(mocks.operationalAlert).not.toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ resultFinal: false }),
      }));
    });
  });

  /**
   * Abandono, W.O. e resultado administrativo: o feed marca `is_finished` e
   * lista o placar do momento da interrupção, sem dizer quem abandonou.
   */
  describe("jogo que não foi jogado até o fim", () => {
    const tenis = {
      ...bet,
      id: "bet-tenis",
      evento: "Athletic Club vs Operario Ferroviario",
      esporte: "Tennis",
      mercado: "Match Winner",
      selecao: "Athletic Club",
    };
    const interrompida = (stage: string, scores: { home: number | null; away: number | null }, finished = true) => [{
      matches: [{
        ...group[0]!.matches[0]!,
        scores,
        match_status: { ...group[0]!.matches[0]!.match_status, stage, is_finished: finished },
      }],
    }];

    it("abandono no tênis com sets 1-1 vai para o operador, sem liquidar pelo placar", async () => {
      mocks.findMany.mockResolvedValue([tenis]);
      mocks.list.mockResolvedValue(interrompida("Finished / retired", { home: 1, away: 1 }));

      const result = await runFlashscoreObservationOnce(now);

      expect(result.settled).toBe(0);
      expect(result.unsupported).toBe(1);
      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringMatching(/abandono/),
        expect.objectContaining({ source: "settlement.flashscore-interrupted", key: "bet-tenis" }),
      );
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: true,
          resultSnapshot: expect.objectContaining({
            settlementOutcome: "manual_retired",
            stage: "Finished / retired",
          }),
        }),
      }));
    });

    it("Under 2.5 sets com abandono também não liquida", async () => {
      mocks.findMany.mockResolvedValue([{ ...tenis, mercado: "Total Sets", selecao: "Under 2.5" }]);
      mocks.list.mockResolvedValue(interrompida("Finished / retired", { home: 1, away: 0 }));

      await runFlashscoreObservationOnce(now);

      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultSnapshot: expect.objectContaining({ settlementOutcome: "manual_retired" }),
        }),
      }));
    });

    it("W.O. sem placar fecha a observação no operador em vez de esperar placar", async () => {
      mocks.findMany.mockResolvedValue([tenis]);
      mocks.list.mockResolvedValue(interrompida("Walkover", { home: null, away: null }));

      await runFlashscoreObservationOnce(now);

      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringMatching(/W\.O\./),
        expect.objectContaining({ source: "settlement.flashscore-interrupted" }),
      );
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: true,
          resultSnapshot: expect.objectContaining({ settlementOutcome: "manual_walkover" }),
        }),
      }));
    });

    it("futebol com resultado decidido fora de campo (Awarded) não liquida o 3-0", async () => {
      mocks.list.mockResolvedValue(interrompida("Awarded", { home: 3, away: 0 }));

      await runFlashscoreObservationOnce(now);

      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: true,
          resultSnapshot: expect.objectContaining({ settlementOutcome: "manual_awarded" }),
        }),
      }));
    });

    it("jogo interrompido sem flag de fim avisa, mas continua olhando (pode ser retomado)", async () => {
      mocks.list.mockResolvedValue(interrompida("Abandoned", { home: 1, away: 0 }, false));

      await runFlashscoreObservationOnce(now);

      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringMatching(/abandonado/),
        expect.objectContaining({ source: "settlement.flashscore-interrupted" }),
      );
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: false,
          resultSnapshot: expect.objectContaining({ settlementOutcome: "manual_abandoned" }),
        }),
      }));
    });

    it("jogo parado (Interrupted) avisa e continua olhando, sem liquidar pelo placar do momento", async () => {
      mocks.list.mockResolvedValue(interrompida("Interrupted", { home: 1, away: 0 }, false));

      await runFlashscoreObservationOnce(now);

      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.operationalAlert).toHaveBeenCalledWith(
        expect.stringMatching(/parado/),
        expect.objectContaining({ source: "settlement.flashscore-interrupted" }),
      );
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: false,
          resultSnapshot: expect.objectContaining({ settlementOutcome: "manual_interrupted" }),
        }),
      }));
    });
  });

  /**
   * A SOLDA entre o detector de fim e o settlement.
   *
   * `tests/providers/flashscore-terminal.test.ts` prova que `decidirTerminal` responde
   * `via: "inferencia"`; estes casos provam que o ramo de liquidação USA a
   * resposta, em vez de gatilhar em `match_status.is_finished`, que nesses
   * esportes é `false` para sempre.
   *
   * Testar a peça não é testar a máquina. Estes casos atravessam
   * observação → detector → settlement, a única camada onde essa solda pode
   * quebrar.
   */
  describe("liquidação por INFERÊNCIA (esporte sem flag terminal)", () => {
    const handebol = {
      ...bet,
      id: "bet-inf",
      esporte: "Handball",
      mercado: "Moneyline",
      selecao: "Athletic Club",
      competicao: "EHF",
      // Leitura anterior: mesmo placar, 40min atrás — confirma estabilidade.
      result: {
        resultSnapshot: { placar: "30x27" },
        resultCheckedAt: new Date(now.getTime() - 40 * 60_000),
      },
    };
    /** Handebol NUNCA popula `match_status`: é o que define o esporte inferido. */
    const partidaSemFlag = [{
      matches: [{
        ...group[0]!.matches[0]!,
        scores: { home: 30, away: 27 },
        match_status: {
          stage: null,
          is_cancelled: false,
          is_postponed: false,
          is_started: false,
          is_in_progress: false,
          is_finished: false,
        },
      }],
    }];

    beforeEach(() => {
      mocks.findMany.mockResolvedValue([handebol]);
      mocks.list.mockResolvedValue(partidaSemFlag);
    });

    it("liquida pelo placar e marca a evidência como inferida", async () => {
      const result = await runFlashscoreObservationOnce(now);

      expect(result).toMatchObject({ matched: 1, final: 1, settled: 1 });
      expect(mocks.settleScore).toHaveBeenCalledWith(
        expect.objectContaining({ id: "bet-inf" }),
        { homeScore: 30, awayScore: 27 },
        expect.objectContaining({ scoredEvento: expect.any(String) }),
      );
      // O sufixo `_inferido` é o que a rechecagem e o relatório diário leem.
      // Sem ele a rede de segurança da Etapa 1 não tem entrada nenhuma.
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: true,
          resultSnapshot: expect.objectContaining({
            settlementOutcome: "settled_from_score_inferido",
          }),
        }),
      }));
    });

    it("1º tempo fora do futebol: recusa na hora, sem esperar parciais que o feed não publica", async () => {
      mocks.findMany.mockResolvedValue([{ ...handebol, mercado: "1st Half Moneyline" }]);
      mocks.settleScore.mockResolvedValue(false);

      // Dentro da graça dos dados atrasados (4 h depois do kickoff).
      const result = await runFlashscoreObservationOnce(now);

      expect(result.settled).toBe(0);
      expect(mocks.details).not.toHaveBeenCalled();
      expect(mocks.settleScore.mock.calls[0]?.[2]).toMatchObject({ periodScores: null, awaitingData: false });
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultFinal: true,
          resultSnapshot: expect.objectContaining({ settlementOutcome: "manual_or_already_settled" }),
        }),
      }));
    });

    it("sem leitura anterior não liquida — e a observação fica ABERTA", async () => {
      mocks.findMany.mockResolvedValue([{ ...handebol, result: null }]);
      const result = await runFlashscoreObservationOnce(now);

      expect(result.settled).toBe(0);
      expect(mocks.settleScore).not.toHaveBeenCalled();
      // Aberta é o ponto: é o próximo ciclo que vira a segunda leitura. Fechar
      // aqui mataria a confirmação de estabilidade antes de ela acontecer.
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ resultFinal: false }),
      }));
    });

    it("placar que MUDOU entre as leituras não liquida", async () => {
      mocks.findMany.mockResolvedValue([{
        ...handebol,
        result: { ...handebol.result, resultSnapshot: { placar: "28x25" } },
      }]);
      const result = await runFlashscoreObservationOnce(now);

      expect(result.settled).toBe(0);
      expect(mocks.settleScore).not.toHaveBeenCalled();
    });

    /**
     * A SEGUNDA solda: a janela de estabilidade conta desde quando o placar
     * parou (`placarDesde`), não desde a leitura ANTERIOR. O job reobserva a
     * cada 10-15min; medida contra a leitura anterior, a distância nunca
     * chegaria aos 30min exigidos e o placar parado não liquidaria nunca.
     *
     * Este caso é justamente a cadência real: última leitura há 10min, placar
     * parado há 40. É a diferença entre "olhei agora há pouco" e "não muda há
     * meia hora".
     */
    it("liquida na cadência REAL de 10min quando o placar já está parado há 30", async () => {
      mocks.findMany.mockResolvedValue([{
        ...handebol,
        result: {
          resultSnapshot: {
            placar: "30x27",
            placarDesde: new Date(now.getTime() - 40 * 60_000).toISOString(),
          },
          resultCheckedAt: new Date(now.getTime() - 10 * 60_000),
        },
      }]);

      const result = await runFlashscoreObservationOnce(now);

      expect(result.settled).toBe(1);
      expect(mocks.settleScore).toHaveBeenCalled();
    });

    it("propaga a âncora enquanto o placar não muda e a reinicia quando muda", async () => {
      const ancora = new Date(now.getTime() - 40 * 60_000).toISOString();
      mocks.findMany.mockResolvedValue([{
        ...handebol,
        result: {
          resultSnapshot: { placar: "30x27", placarDesde: ancora },
          resultCheckedAt: new Date(now.getTime() - 10 * 60_000),
        },
      }]);
      await runFlashscoreObservationOnce(now);
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultSnapshot: expect.objectContaining({ placarDesde: ancora }),
        }),
      }));

      // Placar diferente do gravado: a contagem recomeça AGORA, senão um jogo
      // que voltou a marcar herdaria a estabilidade do placar velho.
      vi.clearAllMocks();
      mocks.upsert.mockResolvedValue(undefined);
      mocks.metric.mockResolvedValue(undefined);
      mocks.list.mockResolvedValue(partidaSemFlag);
      mocks.findMany.mockResolvedValue([{
        ...handebol,
        result: {
          resultSnapshot: { placar: "28x25", placarDesde: ancora },
          resultCheckedAt: new Date(now.getTime() - 10 * 60_000),
        },
      }]);
      await runFlashscoreObservationOnce(now);
      expect(mocks.settleScore).not.toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultSnapshot: expect.objectContaining({ placarDesde: now.toISOString() }),
        }),
      }));
    });

    /**
     * Artilheiro liquidado por DEDUÇÃO nossa também precisa da rede.
     *
     * Os ramos de placar e de estatística marcam `_inferido`; se o de
     * artilheiro devolvesse `settled_from_goalscorer` sempre, ficaria fora de
     * `OUTCOMES_INFERIDOS` e, portanto, invisível para a rechecagem e para o
     * relatório diário — dedução sem a rede que existe justamente para dedução.
     */
    it("marca artilheiro como inferido quando quem decidiu o fim fomos nós", async () => {
      mocks.findMany.mockResolvedValue([{
        ...handebol,
        mercado: "Anytime Goalscorer",
        selecao: "Franco Cristaldo",
      }]);
      mocks.playerStats.mockResolvedValue({
        players: [{
          player_id: "p1",
          name: "Cristaldo Franco",
          short_name: "Cristaldo F.",
          team_id: "h",
          stats: { GOALS: { raw_value: "1" }, GOALS_OWN: { raw_value: "0" } },
        }],
      });
      mocks.settleStatus.mockResolvedValue({
        previousStatus: "PENDING",
        status: "WON",
        lucro: 1,
      });

      await runFlashscoreObservationOnce(now);

      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          resultSnapshot: expect.objectContaining({
            settlementOutcome: "settled_from_goalscorer_inferido",
          }),
        }),
      }));
    });

    it("antes do portão de duração não liquida, mesmo com placar estável", async () => {
      // Handebol espera 4h; aqui são 2h desde o kickoff.
      const cedo = new Date(kickoff.getTime() + 2 * 3_600_000);
      mocks.findMany.mockResolvedValue([{
        ...handebol,
        result: { ...handebol.result, resultCheckedAt: new Date(cedo.getTime() - 40 * 60_000) },
      }]);
      const result = await runFlashscoreObservationOnce(cedo);

      expect(result.settled).toBe(0);
      expect(mocks.settleScore).not.toHaveBeenCalled();
    });
  });
});
