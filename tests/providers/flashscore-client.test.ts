import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeFlashscorePlayers } from "@/src/providers/flashscore/player-stats";
import { resolveGoalscorer } from "@/src/domain/settlement/goalscorer";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  budget: vi.fn(async () => {}),
  cadence: vi.fn(async () => {}),
  breaker: vi.fn(async (_name, fn) => fn()),
  env: { FLASHSCORE_MODE: "on", FLASHSCORE_API_KEY: "secret-test" },
  fetchJson: vi.fn(),
}));

vi.mock("@/src/infra/logger", () => ({ createLogger: () => ({ warn: mocks.warn }) }));
vi.mock("@/src/infra/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/src/infra/circuit-breaker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/infra/circuit-breaker")>()),
  isBreakerOpen: async () => false,
  withBreaker: mocks.breaker,
}));
vi.mock("@/src/providers/budget", () => ({ chargeProviderRequest: mocks.budget }));
vi.mock("@/src/providers/request-cadence", () => ({ awaitProviderCadence: mocks.cadence }));
vi.mock("@/src/providers/core/http", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, fetchJsonWithRetry: mocks.fetchJson };
});

import {
  flashscoreQuotaFromHeaders,
  getFlashscoreMatchDetails,
  getFlashscoreMatchPlayerStats,
  getFlashscoreMatchSummary,
  listFlashscoreMatchesByDate,
} from "@/src/providers/flashscore/client";
import { FLASHSCORE_REQUEST_COOLDOWN_MS } from "@/src/providers/flashscore/limits";
import {
  flashscoreDateResponseSchema,
  flashscoreStatsResponseSchema,
} from "@/src/providers/flashscore/types";
import {
  FLASHSCORE_CANONICAL_SPORTS,
  flashscoreSettlesSportId,
  flashscoreSportId,
} from "@/src/providers/flashscore/sports";

/** O mesmo par que a observação usa: nome → id → perfil. */
const flashscoreSettlesSport = (sport: string): boolean => {
  const id = flashscoreSportId(sport);
  return id !== null && flashscoreSettlesSportId(id);
};

describe("cliente FlashScore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recusa D+11 antes de transporte, cota e breaker; D+1 continua disponível", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T15:00:00Z"));
    try {
      await expect(listFlashscoreMatchesByDate("2026-09-19")).rejects.toMatchObject({ name: "FlashscoreDateWindowError", retryAt: new Date("2026-09-12T03:00:00Z") });
      expect(mocks.breaker).not.toHaveBeenCalled();
      expect(mocks.fetchJson).not.toHaveBeenCalled();
      expect(mocks.budget).not.toHaveBeenCalled();
      mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: [] });
      await expect(listFlashscoreMatchesByDate("2026-09-09")).resolves.toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("classifica a recusa explícita de horizonte sem mascarar outros HTTP 400", async () => {
    mocks.fetchJson.mockImplementationOnce(async (params) => {
      params.onResponse(new Response(JSON.stringify({ message: "The API does not support fetching data more than 7 days in the future" }), { status: 400 }));
      return { ok: false, status: 400, error: "HTTP 400" };
    });
    await expect(listFlashscoreMatchesByDate("2026-07-22")).rejects.toMatchObject({ name: "FlashscoreDateWindowError" });
    // Outros 400 do list-by-date são recusa de contrato/cliente (gate), NÃO
    // ProviderRequestError estrutural — senão 5 sondas de sport.resolve abrem o
    // breaker e derrubam settlement.
    mocks.fetchJson.mockImplementationOnce(async (params) => {
      params.onResponse?.(new Response(JSON.stringify({ message: "Invalid sport_id" }), { status: 400 }));
      return { ok: false, status: 400, error: "HTTP 400" };
    });
    await expect(listFlashscoreMatchesByDate("2026-07-22", 3)).rejects.toMatchObject({
      name: "FlashscoreListByDateClientError",
      day: "2026-07-22",
      sportId: 3,
      providerMessage: "Invalid sport_id",
      provider: "flashscore",
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: "PROVIDER_CONTRACT_INVALID",
        endpoint: "/matches/list-by-date",
        date: "2026-07-22",
        sportId: 3,
        timezone: "America/Sao_Paulo",
        providerMessage: "Invalid sport_id",
        status: 400,
      }),
      expect.any(String),
    );
  });

  it("marca HTTP 400 de list-by-date como expectedFailure na telemetria", async () => {
    mocks.fetchJson.mockImplementationOnce(async (params) => {
      expect(await params.isExpectedFailure?.({ status: 400, error: "HTTP 400" })).toBe(true);
      params.onResponse?.(new Response(JSON.stringify({ message: "bad request" }), { status: 400 }));
      return { ok: false, status: 400, error: "HTTP 400" };
    });
    await expect(listFlashscoreMatchesByDate("2026-07-22")).rejects.toMatchObject({
      name: "FlashscoreListByDateClientError",
    });
  });

  it("usa uma cobrança, data SP e headers RapidAPI", async () => {
    mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: [] });
    await expect(listFlashscoreMatchesByDate("2026-07-22", 36)).resolves.toEqual([]);
    expect(mocks.fetchJson).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining("date=2026-07-22"),
      init: { headers: {
        "x-rapidapi-host": "flashscore4.p.rapidapi.com",
        "x-rapidapi-key": "secret-test",
      } },
    }));
    const beforeAttempt = mocks.fetchJson.mock.calls[0]?.[0]?.beforeAttempt;
    await beforeAttempt?.();
    expect(mocks.cadence).toHaveBeenCalledWith({
      provider: "flashscore",
      route: "global",
      cooldownMs: FLASHSCORE_REQUEST_COOLDOWN_MS,
    });
    expect(mocks.budget).toHaveBeenCalledWith("flashscore", "/matches/list-by-date");
    expect(mocks.cadence.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.budget.mock.invocationCallOrder[0] ?? Infinity);
    expect(mocks.fetchJson.mock.calls[0]?.[0]?.url).toContain("sport_id=36");
  });

  it("aceita partida futura cujo estágio ainda é nulo", async () => {
    mocks.fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      data: [{
        tournament_id: "future-tournament",
        matches: [{
          match_id: "future-match",
          timestamp: 1_785_000_000,
          home_team: { team_id: "home", name: "Home" },
          away_team: { team_id: "away", name: "Away" },
          scores: { home: null, away: null },
          match_status: {
            stage: null,
            is_cancelled: false,
            is_postponed: false,
            is_started: false,
            is_in_progress: false,
            is_finished: false,
          },
        }],
      }],
    });

    const groups = await listFlashscoreMatchesByDate("2026-07-22");
    expect(groups?.[0]?.matches[0]?.match_status.stage).toBeNull();
  });

  it("aceita country_name nulo usado pelo catálogo de eSports", async () => {
    mocks.fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      data: [{
        tournament_id: "esports-tournament",
        country_name: null,
        matches: [{
          match_id: "esports-match",
          timestamp: 1_785_000_000,
          home_team: { team_id: "home", name: "TYLOO" },
          away_team: { team_id: "away", name: "NOVA" },
          scores: { home: 0, away: 2 },
          match_status: {
            stage: null,
            is_cancelled: false,
            is_postponed: false,
            is_started: true,
            is_in_progress: false,
            is_finished: true,
          },
        }],
      }],
    });

    const groups = await listFlashscoreMatchesByDate("2026-07-22", 36);
    expect(groups?.[0]?.country_name).toBeNull();
  });

  describe("partida fora do contrato no list-by-date", () => {
    const partida = (matchId: string, extra: Record<string, unknown> = {}) => ({
      match_id: matchId,
      timestamp: 1_785_000_000,
      home_team: { team_id: "home", name: "Home" },
      away_team: { team_id: "away", name: "Away" },
      scores: { home: 1, away: 0 },
      match_status: {
        stage: "Finished", is_cancelled: false, is_postponed: false,
        is_started: true, is_in_progress: false, is_finished: true,
      },
      ...extra,
    });

    it("é descartada sozinha: as outras partidas do dia sobrevivem, e o descarte é registrado", async () => {
      mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: [
        { tournament_id: "t1", matches: [partida("ok-1"), partida("ruim-1", { home_team: { team_id: "h", name: "" } })] },
        { tournament_id: "t2", matches: [partida("ok-2"), partida("ok-3", { timestamp: 1_785_000_600 })] },
      ] });

      const groups = await listFlashscoreMatchesByDate("2026-07-22", 1);

      expect(groups?.map((group) => group.matches.map((m) => m.match_id))).toEqual([["ok-1"], ["ok-2", "ok-3"]]);
      const diagnostic = mocks.warn.mock.calls.find(([fields]) => fields?.rejected !== undefined)?.[0];
      expect(diagnostic).toMatchObject({
        eventCode: "PROVIDER_CONTRACT_INVALID",
        endpoint: "/matches/list-by-date",
        date: "2026-07-22",
        rejected: 1,
        total: 4,
        sample: ["ruim-1"],
      });
      expect(diagnostic.issues).toContainEqual({ code: "too_small", path: ["home_team", "name"] });
    });

    it.each([
      ["timestamp zero", { timestamp: 0 }],
      ["sem o objeto scores", { scores: undefined }],
      ["placar negativo", { scores: { home: -1, away: 0 } }],
      ["sem flag obrigatória de status", { match_status: { stage: null, is_cancelled: false } }],
    ])("%s não derruba o grupo nem o dia", async (_label, extra) => {
      mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: [
        { tournament_id: "t1", matches: [partida("ok-1"), partida("ruim", extra), partida("ok-2")] },
      ] });
      const groups = await listFlashscoreMatchesByDate("2026-07-22", 1);
      expect(groups?.[0]?.matches.map((m) => m.match_id)).toEqual(["ok-1", "ok-2"]);
    });

    it.each([1, 2, 3])("%i partidas todas inválidas não viram dia vazio", async (count) => {
      mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: [{ tournament_id: "t1",
        matches: Array.from({ length: count }, (_, i) => partida(`bad-${i}`, { timestamp: 0 })),
      }] });
      await expect(listFlashscoreMatchesByDate("2026-07-22", 1))
        .rejects.toMatchObject({ name: "ProviderRequestError", status: 200, billed: true });
    });

    it("a maioria fora do contrato continua falhando alto, com a cobrança", async () => {
      mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: [
        { tournament_id: "t1", matches: [partida("ok-1"), partida("r1", { timestamp: 0 }), partida("r2", { timestamp: 0 }), partida("r3", { timestamp: 0 })] },
      ] });
      await expect(listFlashscoreMatchesByDate("2026-07-22", 1)).rejects.toMatchObject({
        name: "ProviderRequestError",
        status: 200,
        billed: true,
      });
    });
  });

  it("falha alto e mantém a cobrança quando um 2xx quebra o contrato", async () => {
    mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: { unexpected: true } });
    await expect(listFlashscoreMatchesByDate("2026-07-22")).rejects.toMatchObject({
      name: "ProviderRequestError",
      billed: true,
    });
  });

  /**
   * O limite por minuto do plano Ultra chega como HTTP 200 com corpo de erro. Sem
   * a reclassificação ele cairia no Zod e viraria falha ESTRUTURAL: cinco delas
   * tirariam o FlashScore do ar por 15min como se estivesse quebrado.
   */
  it("limite por minuto vem como 200 e é reclassificado como 429, não como contrato quebrado", async () => {
    mocks.fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        message:
          "You have exceeded the rate limit per minute for your plan, ULTRA, by the API provider",
      },
    });
    await expect(listFlashscoreMatchesByDate("2026-07-22")).rejects.toMatchObject({
      name: "ProviderRequestError",
      status: 429,
    });
  });

  it("mensagem que não é de rate-limit continua sendo contrato quebrado", async () => {
    mocks.fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      data: { message: "Endpoint does not exist" },
    });
    await expect(listFlashscoreMatchesByDate("2026-07-22")).rejects.toMatchObject({
      name: "ProviderRequestError",
      status: 200,
    });
  });
});

describe("esportes: encontrar ≠ liquidar", () => {
  it("distingue liquidação por flag, por inferência e esporte sem resultado", () => {
    for (const esporte of ["Soccer", "Tennis", "Basketball", "Hockey"]) {
      expect(flashscoreSettlesSport(esporte)).toBe(true);
    }
    // Liquidam por inferência: o portão de duração vai de 4h a 12h e exige
    // estabilidade do placar antes de produzir efeito financeiro.
    for (const esporte of ["Baseball", "eSports", "American Football", "Volleyball"]) {
      expect(flashscoreSettlesSport(esporte)).toBe(true);
    }
    // Sem placar utilizável: nem liquidam, nem seguram.
    for (const esporte of ["Boxing", "MMA", "Aussie Rules"]) {
      expect(flashscoreSportId(esporte)).not.toBeNull();
      expect(flashscoreSettlesSport(esporte)).toBe(false);
    }
  });

  it("beisebol aponta para 6, não para o Superpesis finlandês (30)", () => {
    expect(flashscoreSportId("Baseball")).toBe(6);
    expect(flashscoreSportId("beisebol")).toBe(6);
  });

  it("hockey tem id e esporte desconhecido falha fechado", () => {
    expect(flashscoreSportId("Hockey")).toBe(4);
    expect(flashscoreSportId("Curling")).toBeNull();
    expect(flashscoreSettlesSport("Curling")).toBe(false);
  });

  /**
   * Ids medidos no feed: american-football=5 e volleyball=12. NENHUM dos dois
   * popula `match_status`; a liquidação só é segura depois do portão temporal e
   * da confirmação de estabilidade do placar.
   */
  it("american football e vôlei entram com id medido, liquidando por inferência", () => {
    expect(flashscoreSportId("American Football")).toBe(5);
    expect(flashscoreSportId("futebol americano")).toBe(5);
    expect(flashscoreSportId("Volleyball")).toBe(12);
    expect(flashscoreSportId("vôlei")).toBe(12);
    expect(flashscoreSettlesSport("American Football")).toBe(true);
    expect(flashscoreSettlesSport("Volleyball")).toBe(true);
  });

  /**
   * O FlashScore publica 34 esportes; o AutomaBACA modela os do registro do
   * domínio. Propor uma modalidade que o registro não tem geraria valor que o
   * resto do sistema recusa — não dá nem para registrar aposta nela.
   */
  it("a resolução de esporte só recebe os canônicos do AutomaBACA", () => {
    const nomes = FLASHSCORE_CANONICAL_SPORTS.map((s) => s.sport);
    expect(nomes).toContain("eSports");
    expect(nomes).toContain("Handball");
    expect(nomes).toContain("Cricket");
    // Publicados pelo provider e SEM contrato no domínio: nunca propostos.
    expect(nomes).not.toContain("Pesapallo");
    expect(nomes).not.toContain("Kabaddi");
    expect(nomes).not.toContain("Netball");
  });
});

describe("estatísticas ausentes", () => {
  // Boa parte das partidas de futebol devolve `[]` com HTTP 200. Lido como
  // quebra de contrato, o cliente lançaria, o settlement alertaria Operações e
  // a observação ficaria aberta, retentando de 30 em 30min para sempre.
  it("aceita [] como partida sem estatística publicada", () => {
    const parsed = flashscoreStatsResponseSchema.safeParse([]);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.match).toEqual([]);
      expect(parsed.data["1st-half"]).toBeUndefined();
    }
  });

  it("array COM conteúdo continua fora do contrato", () => {
    // Forma diferente de verdade: adivinhar o mapeamento aqui custaria
    // liquidação errada, então falha alto.
    expect(
      flashscoreStatsResponseSchema.safeParse([{ name: "Corner kicks", home_team: 5 }]).success,
    ).toBe(false);
  });

  it("objeto normal segue aceito, com os três blocos", () => {
    const parsed = flashscoreStatsResponseSchema.safeParse({
      match: [{ name: "Corner kicks", home_team: 5, away_team: 7 }],
      "1st-half": [{ name: "Corner kicks", home_team: 2, away_team: 3 }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data["1st-half"]).toHaveLength(1);
  });
});

describe("payload de duplas (tênis)", () => {
  const partidaBase = {
    match_id: "vP92hCNP",
    match_status: {
      stage: null,
      is_cancelled: false,
      is_postponed: false,
      is_started: false,
      is_in_progress: false,
      is_finished: false,
    },
    timestamp: 1784997600,
    scores: { home: null, away: null },
  };

  it("aceita o par de jogadores que o feed manda como array", () => {
    // Payload REAL (ATP - DOUBLES: Estoril). Um schema estrito rejeitaria e
    // derrubaria o catálogo INTEIRO do dia — não só a partida —, mandando o
    // resolvedor de esporte para a dead-letter.
    const parsed = flashscoreDateResponseSchema.safeParse([
      {
        tournament_id: "t1",
        name: "ATP - DOUBLES: Estoril (Portugal), clay",
        country_name: "Portugal",
        matches: [
          {
            ...partidaBase,
            home_team: [
              { team_id: "A57Xet1f", name: "Droguet T.", short_name: null },
              { team_id: "KGKot0sk", name: "Jacquet K.", short_name: null },
            ],
            away_team: [
              { team_id: "xx1", name: "Cabral R.", short_name: null },
              { team_id: "xx2", name: "Reis F.", short_name: null },
            ],
          },
        ],
      },
    ]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const match = parsed.data.groups[0]?.matches[0];
    // O par vira um "time" só — é assim que casa de aposta e Pinnacle o nomeiam.
    expect(match?.home_team.name).toBe("Droguet T. / Jacquet K.");
    expect(match?.home_team.team_id).toBe("A57Xet1f/KGKot0sk");
    expect(match?.away_team.name).toBe("Cabral R. / Reis F.");
  });

  it("simples continua objeto único, sem regressão", () => {
    const parsed = flashscoreDateResponseSchema.safeParse([
      {
        matches: [
          {
            ...partidaBase,
            home_team: { team_id: "h1", name: "van Assche L." },
            away_team: { team_id: "a1", name: "Muller A." },
          },
        ],
      },
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.groups[0]?.matches[0]?.home_team.name).toBe("van Assche L.");
  });
});

/**
 * Boxe e MMA devolvem `scores` como STRING de método+round ("TKO/2"), igual dos
 * dois lados. Como o Zod valida o GRUPO inteiro, uma luta reprovando derrubaria
 * o catálogo do dia daquele esporte — mesmo mecanismo das duplas no tênis.
 * Vira `null`: sem placar utilizável, e o resto do dia sobrevive.
 */
describe("placar-string de boxe/MMA", () => {
  const luta = (home: unknown, away: unknown) => ({
    match_id: "L1",
    match_status: {
      stage: null, is_cancelled: false, is_postponed: false, is_started: false,
      is_in_progress: false, is_finished: false,
    },
    timestamp: 1_785_000_000,
    home_team: { team_id: "a", name: "Lutador A" },
    away_team: { team_id: "b", name: "Lutador B" },
    scores: { home, away },
  });

  it("string de método vira placar nulo em vez de reprovar o grupo", () => {
    const parsed = flashscoreDateResponseSchema.safeParse([
      { name: "UFC", matches: [luta("TKO/2", "TKO/2"), luta(3, 1)] },
    ]);
    expect(parsed.success).toBe(true);
    const partidas = parsed.success ? parsed.data.groups[0]?.matches ?? [] : [];
    expect(partidas).toHaveLength(2);
    expect(partidas[0]?.scores).toEqual({ home: null, away: null });
    // A partida numérica do MESMO grupo continua intacta.
    expect(partidas[1]?.scores).toEqual({ home: 3, away: 1 });
  });
});

it("identifica campos recusados de player stats sem registrar valores externos", async () => {
  mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: { players: [{ player_id: null, name: 'private-name', stats: { GOALS: 'private-value' } }] } });
  await expect(getFlashscoreMatchPlayerStats('match-test')).rejects.toMatchObject({ name: 'ProviderRequestError', status: 200 });
  const diagnostic = mocks.warn.mock.calls.at(-1)?.[0];
  expect(diagnostic).toMatchObject({ eventCode: 'PROVIDER_CONTRACT_INVALID', matchId: 'match-test', endpoint: '/matches/match/player-stats' });
  expect(diagnostic.issues).toContainEqual({ code: 'invalid_type', path: ['players', '0', 'player_id'] });
  expect(JSON.stringify(diagnostic)).not.toContain('private-');
});

describe("cliente FlashScore: detalhes da partida", () => {
  beforeEach(() => vi.clearAllMocks());

  it("detalhes passam pela cadência/budget e preservam os parciais", async () => {
    const data = { match_id: "public-match", scores: { home_1st_quarter: 25 } };
    mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data });
    expect(await getFlashscoreMatchDetails("public-match")).toEqual(data);
    const request = mocks.fetchJson.mock.calls[0]![0];
    expect(request.url).toBe("https://flashscore4.p.rapidapi.com/api/flashscore/v2/matches/details?match_id=public-match");
    await request.beforeAttempt();
    expect(mocks.cadence).toHaveBeenCalledWith(expect.objectContaining({ provider: "flashscore", route: "global" }));
    expect(mocks.budget).toHaveBeenCalledWith("flashscore", "/matches/details");
  });

  it("envelope de quota com HTTP 200 não vira prova de placar", async () => {
    mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: { message: "You have exceeded the rate limit" } });
    await expect(getFlashscoreMatchDetails("public-match")).rejects.toThrow();
  });
});

describe("cliente FlashScore: resumo da partida", () => {
  beforeEach(() => vi.clearAllMocks());

  it("consulta o match_id e preserva a evidência mínima de gol", async () => {
    mocks.fetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: [{
        minutes: "90+4",
        team: "home",
        description: "",
        players: [{ name: "Player", player_id: "p1", type: "Goal" }],
      }],
    });

    await expect(getFlashscoreMatchSummary("match-90"))
      .resolves.toEqual([{
        minutes: "90+4",
        team: "home",
        description: "",
        players: [{ name: "Player", player_id: "p1", type: "Goal" }],
      }]);
    expect(mocks.fetchJson).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining("/matches/match/summary"),
    }));
    expect(mocks.fetchJson.mock.calls[0]?.[0]?.url).toContain("match_id=match-90");
    const beforeAttempt = mocks.fetchJson.mock.calls[0]?.[0]?.beforeAttempt;
    await beforeAttempt?.();
    expect(mocks.cadence).toHaveBeenCalledWith(expect.objectContaining({
      provider: "flashscore",
      route: "global",
    }));
    expect(mocks.budget).toHaveBeenCalledWith("flashscore", "/matches/match/summary");
  });
});

describe("cliente FlashScore: contagem publicada de gols", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [undefined, "LOST"], ["0", "LOST"], ["1", "WON"],
  ])("preserva a liquidação com contagem ausente ou válida (%j)", async (goals, expected) => {
    mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: { players: [{
      player_id: "player-test", name: "Jogador Sintético", stats: {
        ...(goals === undefined ? {} : { GOALS: { raw_value: goals } }),
        MATCH_MINUTES_PLAYED: { raw_value: "90" }, FOULS_SUFFERED: { raw_value: "indisponível" },
      },
    }] } });
    const payload = await getFlashscoreMatchPlayerStats("match-test");
    expect(payload).not.toBeNull();
    const jogadores = normalizeFlashscorePlayers(payload!);
    expect(resolveGoalscorer({ selecao: "Jogador Sintético", mercado: "Anytime Goalscorer", jogadores }))
      .toMatchObject({ ok: true, status: expected });
    expect(jogadores[0]?.stats?.FOULS_SUFFERED).toBeUndefined();
  });

  it.each([
    ["GOALS", "indisponível"], ["GOALS", "1.5"], ["GOALS", ""],
    ["GOALS_OWN", "-1"], ["GOALS_OWN", null], ["GOALS_OWN", undefined],
  ])("recusa %s malformado sem convertê-lo em zero (%j)", async (key, value) => {
    mocks.fetchJson.mockResolvedValue({ ok: true, status: 200, data: { players: [{
      player_id: "player-test", name: "Jogador Sintético", stats: {
        [key]: { raw_value: value }, MATCH_MINUTES_PLAYED: { raw_value: "90" },
      },
    }] } });
    await expect(getFlashscoreMatchPlayerStats("match-test")).rejects.toMatchObject({ name: "ProviderRequestError", status: 200 });
  });
});

describe("headers de cota do FlashScore", () => {
  it.each(["", " ", "\t"])("header vazio (%j) não prova saldo zero", (raw) => {
    const response = new Response(null, { headers: {
      "x-ratelimit-requests-remaining": raw, "x-ratelimit-requests-reset": raw,
    } });
    expect(flashscoreQuotaFromHeaders(response)).toEqual({ restante: null, resetEmSegundos: null });
  });
});
