import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { applyManualBetStatusChange } from "../helpers/settle";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";

/**
 * Rede de segurança da liquidação por INFERÊNCIA, contra Postgres real.
 *
 * Nos 22 esportes sem flag terminal quem afirma o fim do jogo é o AutomaBACA,
 * não o FlashScore. Se o portão de duração abrir no intervalo de um jogo que
 * atrasou, o placar parcial vira dinheiro invertido — e nada no sistema
 * perceberia. A rechecagem olha de novo bem depois e leva a divergência para o
 * dono decidir; o teste abaixo é o que prova que ela olha.
 */

const listMock = vi.fn();

/**
 * Interruptor para derrubar SÓ o alerta, mantendo o resto real. Existe para
 * provar a ordem alerta→marca: com a ordem invertida, um Telegram fora do ar
 * apagava a divergência para sempre (a marca `recheck` tira a aposta da fila de
 * uma vez, e o `catch` só somava uma falha).
 */
const alerta = vi.hoisted(() => ({ derrubado: false }));

vi.mock("@/src/services/ops/alerts", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/src/services/ops/alerts");
  return {
    ...actual,
    notifyPersistedOperationalAlert: async (
      ...args: Parameters<typeof actual.notifyPersistedOperationalAlert>
    ) => {
      if (alerta.derrubado) throw new Error("Telegram fora do ar");
      return actual.notifyPersistedOperationalAlert(...args);
    },
  };
});

vi.mock("@/src/providers/flashscore/client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    flashscoreConfigured: () => true,
    listFlashscoreMatchesByDate: (...args: unknown[]) => listMock(...args),
  };
});

const { clearFlashscoreCatalogCache } = await import("@/src/providers/flashscore/catalog");
const { runFlashscoreRecheckOnce } = await import(
  "@/src/services/settlement/flashscore/recheck"
);

let db: TestDb;
const NOW = new Date("2026-08-10T12:00:00Z");
const KICKOFF = new Date("2026-08-09T18:00:00Z");
const envAnterior: Record<string, string | undefined> = {};

beforeAll(() => {
  db = createTestDb();
  for (const key of ["TELEGRAM_NOTIFICATION_BOT_TOKEN", "TELEGRAM_NOTIFICATION_CHAT_ID"]) {
    envAnterior[key] = process.env[key];
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(envAnterior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCacheForTests();
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  await clearFlashscoreCatalogCache();
  listMock.mockReset();
  alerta.derrubado = false;
  // Sem bot configurado o alerta não sai pela rede e a asserção recai sobre a
  // ação operacional — que é o registro que de fato tem que existir.
  delete process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
  delete process.env.TELEGRAM_NOTIFICATION_CHAT_ID;
  resetEnvCacheForTests();
});

/** Partida no formato do catálogo (grupos por torneio). */
function catalogo(placar: { home: number; away: number } | null) {
  return [
    {
      tournament_id: "t1",
      name: "NPB",
      country_name: "Japan",
      matches: [
        {
          match_id: "fs-1",
          timestamp: Math.floor(KICKOFF.getTime() / 1_000),
          home_team: { name: "Hanshin Tigers", team_id: "h1" },
          away_team: { name: "Yomiuri Giants", team_id: "a1" },
          scores: { home: placar?.home ?? null, away: placar?.away ?? null },
          match_status: { is_finished: false, is_cancelled: false, is_postponed: false },
        },
      ],
    },
  ];
}

async function apostaLiquidadaPorInferencia(params: {
  outcome: string;
  placar: string;
  liquidadaHaHoras: number;
  esporte?: string;
}): Promise<string> {
  const banca = await db.prisma.bankroll.upsert({
    where: { slug: "recheck" },
    create: { nome: "Recheck", slug: "recheck" },
    update: {},
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolvedAt: new Date(),
      settledAt: KICKOFF,
      bankrollId: banca.id,
      data: KICKOFF,
      evento: "Hanshin Tigers vs Yomiuri Giants",
      esporte: params.esporte ?? "Baseball",
      mercado: "Moneyline",
      selecao: "Hanshin Tigers",
      odds: 2,
      stake: 1,
      status: "WON",
      sportResolutionStatus: "CONFIRMED",
    },
  });
  await db.prisma.betResult.create({
    data: {
      betId: bet.id,
      resultProvider: "flashscore",
      resultMatchId: "fs-1",
      resultFinal: true,
      resultCheckedAt: new Date(NOW.getTime() - params.liquidadaHaHoras * 3_600_000),
      resultSnapshot: {
        outcome: "matched",
        settlementOutcome: params.outcome,
        placar: params.placar,
        sportId: 6,
      },
    },
  });
  return bet.id;
}

async function marcaDe(betId: string): Promise<Record<string, unknown> | null> {
  const row = await db.prisma.betResult.findUniqueOrThrow({
    where: { betId },
    select: { resultSnapshot: true },
  });
  const snap = row.resultSnapshot as { recheck?: Record<string, unknown> } | null;
  return snap?.recheck ?? null;
}

describe("runFlashscoreRecheckOnce (Postgres real)", () => {
  it("placar que mudou depois vira alerta e ação que NÃO se auto-resolve", async () => {
    const betId = await apostaLiquidadaPorInferencia({
      outcome: "settled_from_score_inferido",
      placar: "2x1",
      liquidadaHaHoras: 10,
    });
    listMock.mockResolvedValue(catalogo({ home: 4, away: 1 }));

    const run = await runFlashscoreRecheckOnce(NOW);

    expect(run).toMatchObject({ divergentes: 1, conferidas: 0, falhas: 0 });
    const acao = await db.prisma.operationalAction.findFirstOrThrow({
      where: { resourceId: betId },
    });
    expect(acao.risk).toBe("HIGH");
    expect(acao.description).toContain("2x1");
    expect(acao.description).toContain("4x1");
    // `autoResolve: false` viaja na evidência — é o que impede a reconciliação
    // de fechar sozinha uma decisão de dinheiro.
    expect(acao.evidence).toMatchObject({ autoResolve: false, placarAgora: "4x1" });
    expect(await marcaDe(betId)).toMatchObject({
      resultado: "divergente",
      placarAgora: "4x1",
    });
  });

  it.each([2, 4])("resposta antiga com %i gols não marca nem alerta resultado substituído durante a consulta", async (home) => {
    const betId = await apostaLiquidadaPorInferencia({ outcome: "settled_from_score_inferido", placar: "2x1", liquidadaHaHoras: 10 });
    listMock.mockImplementationOnce(async () => {
      await applyManualBetStatusChange({ betId, newStatus: "PENDING", source: "manual:teste" });
      await applyManualBetStatusChange({ betId, newStatus: "WON", source: "manual:teste" });
      await db.prisma.betResult.update({ where: { betId }, data: {
        resultMatchId: "fs-new", resultCheckedAt: new Date(NOW.getTime() - 7 * 3_600_000),
        resultSnapshot: { outcome: "matched", settlementOutcome: "settled_from_score_inferido", placar: "5x2", sportId: 6 },
      } });
      return catalogo({ home, away: 1 });
    });
    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({ conferidas: 0, divergentes: 0, falhas: 0, obsolete: 1 });
    expect(await marcaDe(betId)).toBeNull();
    expect(await db.prisma.operationalAction.count({ where: { resourceId: betId, fingerprint: { startsWith: "settlement.flashscore-recheck:" } } })).toBe(0);
  });

  it("placar estável confere e não abre ação nenhuma", async () => {
    const betId = await apostaLiquidadaPorInferencia({
      outcome: "settled_from_score_inferido",
      placar: "2x1",
      liquidadaHaHoras: 10,
    });
    listMock.mockResolvedValue(catalogo({ home: 2, away: 1 }));

    const run = await runFlashscoreRecheckOnce(NOW);

    expect(run).toMatchObject({ conferidas: 1, divergentes: 0 });
    expect(await db.prisma.operationalAction.count()).toBe(0);
    expect(await marcaDe(betId)).toMatchObject({ resultado: "confere", placar: "2x1" });
  });

  it("placar que sumiu do feed conta como divergência (a leitura não era estável)", async () => {
    await apostaLiquidadaPorInferencia({
      outcome: "settled_from_score_inferido",
      placar: "2x1",
      liquidadaHaHoras: 10,
    });
    listMock.mockResolvedValue(catalogo(null));

    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({ divergentes: 1 });
  });

  it("liquidação por FLAG do fornecedor não é reconferida", async () => {
    // `settled_from_score` (sem `_inferido`) é afirmação do FlashScore, não
    // dedução nossa — gastar cota reconferindo seria desconfiar do fornecedor.
    const betId = await apostaLiquidadaPorInferencia({
      outcome: "settled_from_score",
      placar: "2x1",
      liquidadaHaHoras: 10,
      esporte: "Soccer",
    });
    listMock.mockResolvedValue(catalogo({ home: 9, away: 9 }));

    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({
      conferidas: 0,
      divergentes: 0,
    });
    expect(listMock).not.toHaveBeenCalled();
    expect(await marcaDe(betId)).toBeNull();
  });

  it("liquidação recente demais espera: o jogo pode ainda estar em andamento", async () => {
    await apostaLiquidadaPorInferencia({
      outcome: "settled_from_score_inferido",
      placar: "2x1",
      liquidadaHaHoras: 2,
    });
    listMock.mockResolvedValue(catalogo({ home: 4, away: 1 }));

    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({
      conferidas: 0,
      divergentes: 0,
    });
    expect(listMock).not.toHaveBeenCalled();
  });

  it("a marca impede reconferir a mesma aposta no dia seguinte", async () => {
    await apostaLiquidadaPorInferencia({
      outcome: "settled_from_score_inferido",
      placar: "2x1",
      liquidadaHaHoras: 10,
    });
    listMock.mockResolvedValue(catalogo({ home: 2, away: 1 }));
    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({ conferidas: 1 });

    await clearFlashscoreCatalogCache();
    listMock.mockClear();
    const segunda = await runFlashscoreRecheckOnce(new Date(NOW.getTime() + 86_400_000));

    expect(segunda).toMatchObject({ conferidas: 0, divergentes: 0, falhas: 0 });
    expect(listMock).not.toHaveBeenCalled();
  });

  /**
   * Provider indisponível ENCERRA a rodada, não a derruba.
   *
   * Este job roda uma vez por dia e a marca `recheck` o torna idempotente: a
   * passada de amanhã continua exatamente de onde esta parou. Fazer cota
   * esgotada virar exceção transformaria um dia sem cota em retry →
   * dead-letter → alerta HIGH, sobre um trabalho que só precisava esperar. O
   * sweep de alias segue a mesma regra.
   */
  it("provider fora do ar encerra a rodada limpa, sem marcar nada", async () => {
    const ids: string[] = [];
    for (const placar of ["2x1", "3x0", "1x1"]) {
      ids.push(
        await apostaLiquidadaPorInferencia({
          outcome: "settled_from_score_inferido",
          placar,
          liquidadaHaHoras: 10,
        }),
      );
    }
    listMock.mockResolvedValue(null);

    const run = await runFlashscoreRecheckOnce(NOW);
    expect(run).toMatchObject({ semProvider: 3, falhas: 0, conferidas: 0 });
    // Sem marca: as apostas voltam para a fila na próxima passada. Marcar aqui
    // seria dar por conferido o que nunca foi olhado.
    for (const betId of ids) expect(await marcaDe(betId)).toBeNull();
  });

  it.each(["2026-08-09", "2026-08-08", "2026-08-10"])("catálogo %s indisponível não prova que a partida sumiu", async (missingDay) => {
    const betId = await apostaLiquidadaPorInferencia({ outcome: "settled_from_score_inferido", placar: "2x1", liquidadaHaHoras: 10 });
    listMock.mockImplementation(async (day: string) => day === missingDay ? null : []);
    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({ semProvider: 1, ausentes: 0, falhas: 0 });
    expect(await marcaDe(betId)).toBeNull();
    await clearFlashscoreCatalogCache();
    listMock.mockResolvedValue(catalogo({ home: 4, away: 1 }));
    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({ divergentes: 1 });
    expect(await marcaDe(betId)).toMatchObject({ resultado: "divergente" });
  });

  it("três catálogos consultados e vazios comprovam ausência", async () => {
    const betId = await apostaLiquidadaPorInferencia({ outcome: "settled_from_score_inferido", placar: "2x1", liquidadaHaHoras: 10 });
    listMock.mockResolvedValue([]);
    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({ ausentes: 1, semProvider: 0 });
    expect(await marcaDe(betId)).toMatchObject({ resultado: "partida_ausente" });
  });

  it("uma aposta só, provider indisponível: também encerra limpa", async () => {
    const betId = await apostaLiquidadaPorInferencia({
      outcome: "settled_from_score_inferido",
      placar: "2x1",
      liquidadaHaHoras: 10,
    });
    listMock.mockResolvedValue(null);

    const run = await runFlashscoreRecheckOnce(NOW);
    expect(run).toMatchObject({ semProvider: 1, falhas: 0 });
    expect(await marcaDe(betId)).toBeNull();
  });

  /**
   * Cota esgotada vira `null` dentro do catálogo, mas breaker aberto e recusa
   * do fornecedor SOBEM como exceção — e caindo no `catch` por aposta viravam
   * `falhas`. São os dois caminhos, e o segundo é o mais comum na prática: o
   * breaker abre por 15min a cada 429.
   */
  it("breaker aberto também encerra limpa, não conta como falha", async () => {
    await apostaLiquidadaPorInferencia({
      outcome: "settled_from_score_inferido",
      placar: "2x1",
      liquidadaHaHoras: 10,
    });
    listMock.mockRejectedValue(new CircuitOpenError("flashscore"));

    const run = await runFlashscoreRecheckOnce(NOW);
    expect(run).toMatchObject({ semProvider: 1, falhas: 0 });
  });

  /**
   * O contra-peso: o que some da caixa é indisponibilidade, não bug. Erro NOSSO
   * continua derrubando o job para o pg-boss reter e realertar.
   */
  it("erro nosso continua falhando alto", async () => {
    await apostaLiquidadaPorInferencia({
      outcome: "settled_from_score_inferido",
      placar: "2x1",
      liquidadaHaHoras: 10,
    });
    listMock.mockRejectedValue(new TypeError("undefined is not a function"));

    await expect(runFlashscoreRecheckOnce(NOW)).rejects.toThrow(/erro nosso/);
  });

  /**
   * A ordem entre alertar e marcar É a correção. Marcando primeiro, a marca
   * `recheck` tira a aposta da fila para sempre e um alerta que falhou leva a
   * divergência junto — dinheiro possivelmente invertido, e ninguém sabendo.
   * Alertando primeiro, o pior caso é o alerta repetir amanhã, e
   * `sendOperationalAlert` deduplica pela `key` (o `betId`).
   */
  it("alerta que falha NÃO marca a aposta como conferida", async () => {
    const betId = await apostaLiquidadaPorInferencia({
      outcome: "settled_from_score_inferido",
      placar: "2x1",
      liquidadaHaHoras: 10,
    });
    listMock.mockResolvedValue(catalogo({ home: 4, away: 1 }));
    alerta.derrubado = true;

    // Uma aposta só, e ela falhou: fail-loud com a causa certa.
    await expect(runFlashscoreRecheckOnce(NOW)).rejects.toThrow(/ver o log por betId/);

    // O ponto: a aposta continua SEM marca, então a próxima passada tenta de
    // novo e o dono acaba avisado.
    expect(await marcaDe(betId)).toBeNull();

    // E na passada seguinte, com o Telegram de volta, a divergência sai.
    alerta.derrubado = false;
    await clearFlashscoreCatalogCache();
    listMock.mockResolvedValue(catalogo({ home: 4, away: 1 }));
    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({ divergentes: 1 });
    expect(await marcaDe(betId)).toMatchObject({ resultado: "divergente" });
  });
});

const VOLLEYBALL_KICKOFF = new Date("2026-08-09T19:30:00Z");

describe("rechecagem do vôlei liquidado por inferência", () => {
  it("confirma a terceira leitura estável pelo mesmo match_id, 6h depois", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Vôlei", slug: "volei-recheck" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: VOLLEYBALL_KICKOFF,
        bankrollId: bankroll.id,
        data: VOLLEYBALL_KICKOFF,
        evento: "Argentina vs Colombia",
        esporte: "Volleyball",
        mercado: "Moneyline",
        selecao: "Colombia",
        odds: 1.8,
        stake: 1,
        status: "WON",
      },
    });
    await db.prisma.betResult.create({
      data: {
        betId: bet.id,
        resultProvider: "flashscore",
        resultMatchId: "arg-col",
        resultFinal: true,
        resultCheckedAt: new Date(NOW.getTime() - 7 * 3_600_000),
        resultSnapshot: {
          outcome: "matched",
          settlementOutcome: "settled_from_score_inferido",
          placar: "0x3",
        },
      },
    });
    listMock.mockResolvedValue([{
      tournament_id: "south-america",
      name: "South American Championship",
      country_name: "World",
      matches: [{
        match_id: "arg-col",
        timestamp: Math.floor(VOLLEYBALL_KICKOFF.getTime() / 1_000),
        home_team: { team_id: "arg", name: "Argentina" },
        away_team: { team_id: "col", name: "Colombia" },
        scores: { home: 0, away: 3 },
        match_status: {
          is_finished: false,
          is_cancelled: false,
          is_postponed: false,
        },
      }],
    }]);

    await expect(runFlashscoreRecheckOnce(NOW)).resolves.toMatchObject({
      conferidas: 1,
      divergentes: 0,
      falhas: 0,
    });
    expect(listMock).toHaveBeenCalledWith("2026-08-09", 12);
    const result = await db.prisma.betResult.findUniqueOrThrow({
      where: { betId: bet.id },
      select: { resultSnapshot: true },
    });
    expect(result.resultSnapshot).toMatchObject({
      recheck: { resultado: "confere", placar: "0x3" },
    });
    await expect(db.prisma.operationalAction.count()).resolves.toBe(0);
  });
});

describe("rechecagem da múltipla liquidada por inferência", () => {
  async function duplaLiquidada(segundoDecidiu = true): Promise<string> {
    const banca = await db.prisma.bankroll.create({ data: { nome: "Dupla", slug: "dupla-recheck" } });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), settledAt: KICKOFF, bankrollId: banca.id,
        data: KICKOFF, evento: "Hanshin Tigers vs Yomiuri Giants | Chunichi Dragons vs Hiroshima Carp",
        esporte: "Baseball", mercado: "Moneyline", selecao: "Hanshin Tigers / Chunichi Dragons",
        odds: 3, stake: 1, status: "WON",
      },
    });
    await db.prisma.betResult.create({ data: {
      betId: bet.id, resultProvider: "flashscore", resultMatchId: "fs-1", resultFinal: true,
      resultCheckedAt: new Date(NOW.getTime() - 10 * 3_600_000),
      resultSnapshot: {
        outcome: "matched", ticket: true, sportId: 6, settlementOutcome: "settled_from_score_inferido",
        placares: {
          "fs-1": { placar: "2x1", placarDesde: KICKOFF.toISOString(), inferido: true },
          "fs-2": { placar: "3x0", placarDesde: KICKOFF.toISOString(), ...(segundoDecidiu ? { inferido: true } : {}) },
        },
      },
    } });
    return bet.id;
  }
  /** Os dois jogos da dupla no catálogo, com o placar de agora do segundo. */
  function catalogoDaDupla(segundo: { home: number; away: number }) {
    const [grupo] = catalogo({ home: 2, away: 1 });
    return [{ ...grupo!, matches: [...grupo!.matches, {
      ...grupo!.matches[0]!, match_id: "fs-2",
      home_team: { name: "Chunichi Dragons", team_id: "h2" }, away_team: { name: "Hiroshima Carp", team_id: "a2" },
      scores: segundo,
    }] }];
  }

  it("confere cada jogo pelo próprio match_id", async () => {
    const betId = await duplaLiquidada();
    listMock.mockResolvedValue(catalogoDaDupla({ home: 3, away: 0 }));

    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({ conferidas: 1, divergentes: 0, semBase: 0 });
    expect(await marcaDe(betId)).toMatchObject({ resultado: "confere" });
    expect(await db.prisma.operationalAction.count()).toBe(0);
  });

  it("jogo que ainda rolava quando a outra perna perdeu não é reconferido", async () => {
    const betId = await duplaLiquidada(false);
    listMock.mockResolvedValue(catalogoDaDupla({ home: 3, away: 2 }));

    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({ conferidas: 1, divergentes: 0 });
    expect(await marcaDe(betId)).toMatchObject({ resultado: "confere", placar: "2x1" });
  });

  it("um jogo com placar mudado vira alerta da dupla", async () => {
    const betId = await duplaLiquidada();
    listMock.mockResolvedValue(catalogoDaDupla({ home: 3, away: 2 }));

    expect(await runFlashscoreRecheckOnce(NOW)).toMatchObject({ divergentes: 1 });
    const acao = await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: betId } });
    expect(acao.description).toContain("3x0");
    expect(acao.description).toContain("3x2");
    expect(await marcaDe(betId)).toMatchObject({ resultado: "divergente" });
  });
});
