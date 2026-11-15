import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { resetEnvCacheForTests } from "@/src/infra/env";
import type { FlashscoreMatch } from "@/src/providers/flashscore/types";
import type { FlashscoreSummaryResponse } from "@/src/providers/flashscore/summary";
import type { SummaryCache } from "@/src/services/settlement/flashscore/settle";
import { observeFlashscoreTicketBet } from "@/src/services/settlement/flashscore/ticket";
import { ticketFixtureExtraTimeNeed } from "@/src/services/settlement/flashscore/regulation";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";
import { toNumber } from "@/src/domain/money";
import { applyAutomaticBetStatusChange } from "@/src/services/bets/settle";
import { alterarStatusConta, criarConta } from "@/src/services/contas/manage";

/**
 * Prorrogação numa múltipla. O `scores` do FlashScore é o agregado de 120', e o
 * caminho do bilhete o lia sem nenhum boundary: um jogo empatado em 90' que
 * virou na prorrogação pagava como VITÓRIA de 90' uma perna que tinha perdido.
 * A aposta simples já recusava o mesmo placar desde sempre — estes testes
 * fixam a simetria entre os dois caminhos.
 */

const FINISHED = {
  stage: "Finished",
  is_cancelled: false,
  is_postponed: false,
  is_started: true,
  is_in_progress: false,
  is_finished: true,
} as const;

describe("ticketFixtureExtraTimeNeed", () => {
  it("usa o placar listado quando o jogo terminou no tempo normal", () => {
    expect(ticketFixtureExtraTimeNeed({
      status: FINISHED,
      mercados: ["Moneyline"],
    })).toBe("aggregate");
  });

  it("exige os 90' quando a prorrogação decidiu e o mercado é de tempo normal", () => {
    expect(ticketFixtureExtraTimeNeed({
      status: { ...FINISHED, is_finished_after_extra_time: true },
      mercados: ["Moneyline"],
    })).toBe("regulation");
  });

  it("aceita o agregado quando toda perna do confronto inclui a prorrogação", () => {
    expect(ticketFixtureExtraTimeNeed({
      status: { ...FINISHED, is_finished_after_extra_time: true },
      mercados: ["Vencedor incluindo prorrogação", "Total incluindo prorrogação"],
    })).toBe("aggregate");
  });

  it("bloqueia pênaltis mesmo com mercado que inclui prorrogação", () => {
    expect(ticketFixtureExtraTimeNeed({
      status: {
        ...FINISHED,
        is_finished_after_extra_time: true,
        is_finished_after_penalties: true,
      },
      mercados: ["Vencedor incluindo prorrogação"],
    })).toBe("blocked");
  });

  it("bloqueia confronto cujas pernas misturam 90' e prorrogação", () => {
    // `scoresByEvento` carrega UM placar por evento; um número só não paga as
    // duas leituras do mesmo jogo.
    expect(ticketFixtureExtraTimeNeed({
      status: { ...FINISHED, is_finished_after_extra_time: true },
      mercados: ["Moneyline", "Vencedor incluindo prorrogação"],
    })).toBe("blocked");
  });

  it("bloqueia confronto sem perna conhecida — fail-closed", () => {
    expect(ticketFixtureExtraTimeNeed({
      status: { ...FINISHED, is_finished_after_extra_time: true },
      mercados: [],
    })).toBe("blocked");
  });
});

let db: TestDb;
const KICKOFF = new Date("2026-07-25T18:00:00Z");
const NOW = new Date("2026-07-25T23:00:00Z");
const envAnterior: Record<string, string | undefined> = {};

beforeAll(() => {
  db = createTestDb();
  for (const key of ["FLASHSCORE_MODE", "FLASHSCORE_API_KEY"]) {
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
  process.env.FLASHSCORE_MODE = "on";
  process.env.FLASHSCORE_API_KEY = "chave-de-teste";
  resetEnvCacheForTests();
});

function partida(params: {
  id: string;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  extraTime?: boolean;
}): FlashscoreMatch {
  return {
    match_id: params.id,
    timestamp: Math.floor(KICKOFF.getTime() / 1_000),
    home_team: { team_id: `${params.id}-h`, name: params.home },
    away_team: { team_id: `${params.id}-a`, name: params.away },
    scores: { home: params.homeScore, away: params.awayScore },
    match_status: params.extraTime
      ? { ...FINISHED, is_finished_after_extra_time: true }
      : { ...FINISHED },
  };
}

/** Gol simples do lado informado, no minuto informado. */
function gol(team: "home" | "away", minutes: string): FlashscoreSummaryResponse[number] {
  return { minutes, team, players: [{ type: "Goal", name: `Autor ${minutes}` }] };
}

/** Múltipla de dois jogos, ambas as pernas em mercado de 90'. */
async function multiplaDeNoventa(): Promise<string> {
  const banca = await db.prisma.bankroll.upsert({
    where: { slug: "et" },
    create: { nome: "ET", slug: "et" },
    update: {},
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: banca.id,
      data: KICKOFF,
      evento: "France vs Morocco | Spain vs Italy",
      esporte: "Soccer",
      competicao: "World Cup",
      pais: "FIFA",
      mercado: "Moneyline",
      selecao: "France / Spain",
      legsJson: {
        kind: "parlay",
        legs: [
          { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
          { evento: "Spain vs Italy", mercado: "Moneyline", selecao: "Spain" },
        ],
      },
      odds: 2,
      stake: 1,
      status: "PENDING",
      sportResolutionStatus: "CONFIRMED",
      kickoffInferido: false,
    },
  });
  return bet.id;
}

async function loadEligible(id: string): Promise<EligibleBet> {
  return db.prisma.bet.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      evento: true,
      esporte: true,
      competicao: true,
      pais: true,
      mercado: true,
      selecao: true,
      legsJson: true,
      liveScoreHome: true,
      liveScoreAway: true,
      odds: true,
      stake: true,
      status: true,
      data: true,
      registradoEm: true,
      kickoffInferido: true,
      liveTextAtCapture: true,
      sharp: { select: { provider: true, providerMatchId: true } },
      closing: {
        select: {
          fetchedAt: true,
          clv: true,
          closingOdd: true,
          lateRefreshedAt: true,
        },
      },
      result: {
        select: {
          scoreHome: true,
          resultSnapshot: true,
          resultCheckedAt: true,
          resultProvider: true,
          resultFinal: true,
        },
      },
    },
  });
}

/** Jogos: France 2–1 Morocco só na PRORROGAÇÃO (1–1 em 90'); Spain 1–0 Italy. */
function partidasComProrrogacao(): FlashscoreMatch[] {
  return [
    partida({ id: "fs-fr", home: "France", away: "Morocco", homeScore: 2, awayScore: 1, extraTime: true }),
    partida({ id: "fs-es", home: "Spain", away: "Italy", homeScore: 1, awayScore: 0 }),
  ];
}

describe("múltipla com confronto decidido na prorrogação", () => {
  it("liquida pelos 90' — a perna do mercado de tempo normal PERDEU", async () => {
    const betId = await multiplaDeNoventa();
    // 1–1 em 90' (France 25', Morocco 70') e 2–1 no agregado (France 105').
    const summaryCache: SummaryCache = new Map([
      ["fs-fr", Promise.resolve([gol("home", "25"), gol("away", "70"), gol("home", "105")])],
    ]);

    const run = await observeFlashscoreTicketBet({
      bet: await loadEligible(betId),
      matches: partidasComProrrogacao(),
      sportId: 1,
      day: "2026-07-25",
      now: NOW,
      loadMatches: async () => null,
      summaryCache,
    });

    expect(run).toMatchObject({ matched: true, final: true, settled: true });
    // France empatava em 90': o bilhete é LOST, não WON.
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }))
      .resolves.toMatchObject({ status: "LOST" });
  });

  it("summary que ainda não saiu: o confronto espera o resumo dentro da graça", async () => {
    const betId = await multiplaDeNoventa();

    const run = await observeFlashscoreTicketBet({
      bet: await loadEligible(betId),
      matches: partidasComProrrogacao(),
      sportId: 1,
      day: "2026-07-25",
      now: new Date(KICKOFF.getTime() + 3 * 3_600_000),
      loadMatches: async () => null,
      summaryCache: new Map([["fs-fr", Promise.resolve([])]]),
    });

    expect(run).toMatchObject({ settled: false, final: false });
    expect(await db.prisma.operationalAction.count({ where: { resource: "bet", resourceId: betId } })).toBe(0);
    await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId } }))
      .resolves.toMatchObject({ resultFinal: false });
  });

  it("não liquida quando o summary não reconstrói os 90' até o fim da graça", async () => {
    const betId = await multiplaDeNoventa();
    const summaryCache: SummaryCache = new Map([
      ["fs-fr", Promise.resolve(null)],
    ]);

    const run = await observeFlashscoreTicketBet({
      bet: await loadEligible(betId),
      matches: partidasComProrrogacao(),
      sportId: 1,
      day: "2026-07-25",
      now: new Date(KICKOFF.getTime() + 7 * 3_600_000),
      loadMatches: async () => null,
      summaryCache,
    });

    expect(run.settled).toBe(false);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }))
      .resolves.toMatchObject({ status: "PENDING", settledAt: null });
    // Nunca sai da fila em silêncio: o operador recebe a ação durável.
    const acao = await db.prisma.operationalAction.findFirst({
      where: { resource: "bet", resourceId: betId },
      select: { title: true, description: true, status: true },
    });
    expect(acao).toMatchObject({ status: "OPEN" });
    expect(acao?.title).toContain("prorrogação");
    // O alerta nomeia o confronto travado, não só "pernas incompletas".
    expect(acao?.description).toContain("France vs Morocco");
  });

  it("usa o agregado quando o jogo NÃO foi à prorrogação", async () => {
    const betId = await multiplaDeNoventa();

    const run = await observeFlashscoreTicketBet({
      bet: await loadEligible(betId),
      matches: [
        partida({ id: "fs-fr", home: "France", away: "Morocco", homeScore: 2, awayScore: 1 }),
        partida({ id: "fs-es", home: "Spain", away: "Italy", homeScore: 1, awayScore: 0 }),
      ],
      sportId: 1,
      day: "2026-07-25",
      now: NOW,
      loadMatches: async () => null,
      summaryCache: new Map(),
    });

    expect(run.settled).toBe(true);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }))
      .resolves.toMatchObject({ status: "WON" });
  });
});

describe("múltipla com jogos em horários distantes", () => {
  const SEGUNDO_JOGO_MS = 5.5 * 3_600_000;
  const maisTarde = (match: FlashscoreMatch): FlashscoreMatch =>
    ({ ...match, timestamp: Math.floor((KICKOFF.getTime() + SEGUNDO_JOGO_MS) / 1_000) });
  const observar = async (betId: string, segundo: FlashscoreMatch, now: Date) => observeFlashscoreTicketBet({
    bet: await loadEligible(betId),
    matches: [partida({ id: "fs-fr", home: "France", away: "Morocco", homeScore: 2, awayScore: 1 }), segundo],
    sportId: 1,
    day: "2026-07-25",
    now,
    loadMatches: async () => null,
    summaryCache: new Map(),
  });

  it("a perna do jogo da noite, a mais de 3 h do horário do bilhete, casa e o bilhete fecha", async () => {
    const betId = await multiplaDeNoventa();

    const run = await observar(
      betId,
      maisTarde(partida({ id: "fs-es", home: "Spain", away: "Italy", homeScore: 1, awayScore: 0 })),
      new Date(KICKOFF.getTime() + 9 * 3_600_000),
    );

    expect(run).toMatchObject({ matched: true, final: true, settled: true });
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).resolves.toMatchObject({ status: "WON" });
  });

  it("a perna adiada espera as 48 h contadas do começo dela, não do horário do bilhete", async () => {
    const betId = await multiplaDeNoventa();
    const spain = maisTarde(partida({ id: "fs-es", home: "Spain", away: "Italy", homeScore: 0, awayScore: 0 }));
    const adiado = { ...spain, match_status: { ...spain.match_status, is_postponed: true, is_finished: false } };

    const run = await observar(betId, adiado, new Date(KICKOFF.getTime() + 50 * 3_600_000));

    expect(run).toMatchObject({ matched: true, final: false, settled: false });
    await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId } }))
      .resolves.toMatchObject({ resultSnapshot: expect.objectContaining({ postponedWaiting: 1 }) });
  });
});

describe("múltipla com confronto que não foi jogado até o fim", () => {
  it("não paga a perna pelo placar administrativo e chama o operador", async () => {
    const betId = await multiplaDeNoventa();
    const awarded = partida({ id: "fs-fr", home: "France", away: "Morocco", homeScore: 3, awayScore: 0 });

    const run = await observeFlashscoreTicketBet({
      bet: await loadEligible(betId),
      matches: [
        { ...awarded, match_status: { ...awarded.match_status, stage: "Awarded" } },
        partida({ id: "fs-es", home: "Spain", away: "Italy", homeScore: 1, awayScore: 0 }),
      ],
      sportId: 1,
      day: "2026-07-25",
      now: NOW,
      loadMatches: async () => null,
      summaryCache: new Map(),
    });

    expect(run.settled).toBe(false);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }))
      .resolves.toMatchObject({ status: "PENDING" });
    const acao = await db.prisma.operationalAction.findFirst({
      where: { resource: "bet", resourceId: betId, status: "OPEN" },
      select: { title: true, description: true },
    });
    expect(acao?.title).toContain("jogo não concluído");
    expect(acao?.description).toContain("France vs Morocco");
    const result = await db.prisma.betResult.findUniqueOrThrow({ where: { betId } });
    expect(result.resultSnapshot).toMatchObject({ interrupted: 1, extraTimeBlocked: 0 });
  });
});

/**
 * Múltipla que o IA-Judge já liquidou volta à fila só para conferência. Passar
 * pela liquidação religaria a conta: com a conta original encerrada, ou com a
 * conta da casa cadastrada depois, o dinheiro mudaria de lugar.
 */
describe("múltipla liquidada pela IA só é conferida", () => {
  const opts = () => ({ client: db.prisma });

  async function ticketSettledByIa(params: { withAccount: boolean }) {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Conferência", slug: `conferencia-${Math.random()}`, valorUnidade: 50 },
    });
    const accountA = params.withAccount
      ? (await criarConta({
          casaDeAposta: "Betano", titular: "Titular", saldoInicial: 100, bankrollIds: [bankroll.id], actor: "audit",
        }, opts())).contaId
      : null;
    const bet = await db.prisma.bet.create({
      data: {
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        contaId: accountA,
        casaDeAposta: "Betano",
        valorUnidade: 50,
        data: KICKOFF,
        evento: "France vs Morocco | Spain vs Italy",
        esporte: "Soccer",
        competicao: "World Cup",
        pais: "FIFA",
        mercado: "Moneyline",
        selecao: "France / Spain",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
            { evento: "Spain vs Italy", mercado: "Moneyline", selecao: "Spain" },
          ],
        },
        odds: 2,
        stake: 1,
        status: "PENDING",
        sportResolutionStatus: "CONFIRMED",
        kickoffInferido: false,
      },
    });
    await applyAutomaticBetStatusChange({ betId: bet.id, newStatus: "WON", source: "ia-judge:ia_judge_auto" }, opts());
    return { bankroll, betId: bet.id, accountA };
  }

  const bothWon = () => [
    partida({ id: "fs-fr", home: "France", away: "Morocco", homeScore: 2, awayScore: 1 }),
    partida({ id: "fs-es", home: "Spain", away: "Italy", homeScore: 1, awayScore: 0 }),
  ];

  const observe = async (betId: string, matches: FlashscoreMatch[]) => observeFlashscoreTicketBet({
    bet: await loadEligible(betId),
    matches,
    sportId: 1,
    day: "2026-07-25",
    now: NOW,
    loadMatches: async () => null,
    summaryCache: new Map(),
  });

  const ledger = async (betId: string) => (await db.prisma.movimentacao.findMany({
    where: { betId }, orderBy: { createdAt: "asc" }, select: { contaId: true, tipo: true, valor: true },
  })).map((m) => [m.contaId, m.tipo, toNumber(m.valor)]);
  const balance = async (contaId: string) =>
    toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual);

  it("conta original ENCERRADA e conta nova da casa: nada muda", async () => {
    const { bankroll, betId, accountA } = await ticketSettledByIa({ withAccount: true });
    await alterarStatusConta({ contaId: accountA!, status: "ENCERRADA", expectedStatus: "ATIVA", actor: "audit" }, opts());
    const { contaId: accountB } = await criarConta({
      casaDeAposta: "Betano", titular: "Titular", saldoInicial: 100, bankrollIds: [bankroll.id], actor: "audit",
    }, opts());
    const before = await ledger(betId);

    const run = await observe(betId, bothWon());

    expect(run.settled).toBe(false);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }))
      .resolves.toMatchObject({ status: "WON", contaId: accountA });
    expect(await ledger(betId)).toEqual(before);
    expect(await balance(accountA!)).toBe(150);
    expect(await balance(accountB)).toBe(100);
    const result = await db.prisma.betResult.findUniqueOrThrow({ where: { betId } });
    expect(result.resultSnapshot).toMatchObject({ settlementOutcome: "crosscheck_agrees" });
  });

  it("aposta sem conta e conta da casa cadastrada depois: o saldo continua o mesmo", async () => {
    const { bankroll, betId } = await ticketSettledByIa({ withAccount: false });
    const { contaId } = await criarConta({
      casaDeAposta: "Betano", titular: "Titular", saldoInicial: 100, bankrollIds: [bankroll.id], actor: "audit",
    }, opts());

    await observe(betId, bothWon());

    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }))
      .resolves.toMatchObject({ status: "WON", contaId: null });
    expect(await ledger(betId)).toEqual([]);
    expect(await balance(contaId)).toBe(100);
  });

  it("cancelamento parcial não gera falsa divergência com uma liquidação já homologada", async () => {
    const { betId, accountA } = await ticketSettledByIa({ withAccount: true });
    const matches = bothWon();
    matches[0]!.scores = { home: 0, away: 1 };
    matches[1]!.match_status = { ...FINISHED, stage: "Cancelled", is_cancelled: true, is_finished: false };
    const before = await ledger(betId);

    await observe(betId, matches);

    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).resolves.toMatchObject({ status: "WON" });
    expect(await ledger(betId)).toEqual(before);
    expect(await balance(accountA!)).toBe(150);
    const action = await db.prisma.operationalAction.findFirst({ where: { resource: "bet", resourceId: betId, status: "OPEN" } });
    expect(action?.title).toContain("sem conferência");
    expect(action?.description).toContain("perna anulada");
    expect(action?.risk).toBe("MEDIUM");
    const result = await db.prisma.betResult.findUniqueOrThrow({ where: { betId } });
    expect(result.resultSnapshot).toMatchObject({ settlementOutcome: "crosscheck_cancelled" });
  });

  it("todas as pernas canceladas contradizem o WON da IA: alerta, sem reembolsar", async () => {
    const { betId, accountA } = await ticketSettledByIa({ withAccount: true });
    const cancelled = bothWon().map((match) => ({
      ...match,
      scores: { home: null, away: null },
      match_status: { ...match.match_status, stage: "Cancelled", is_cancelled: true, is_finished: false },
    }));

    await observe(betId, cancelled);

    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }))
      .resolves.toMatchObject({ status: "WON" });
    expect(await balance(accountA!)).toBe(150);
    const acao = await db.prisma.operationalAction.findFirst({
      where: { resource: "bet", resourceId: betId, status: "OPEN" },
      select: { title: true, description: true, risk: true },
    });
    expect(acao?.title).toContain("Liquidação da IA divergente");
    expect(acao?.risk).toBe("HIGH");
    expect(acao?.description).not.toContain("Pendente");
  });
});

/**
 * Múltipla de jogos diferentes com perna do tempo regulamentar (1X2 do
 * basquete): o placar regulamentar de cada confronto chega à perna dele.
 */
describe("múltipla com perna do tempo regulamentar", () => {
  async function basketballParlay(): Promise<string> {
    const banca = await db.prisma.bankroll.create({ data: { nome: "Basquete", slug: `basquete-${Math.random()}` } });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolvedAt: new Date(), bankrollId: banca.id, data: KICKOFF,
        evento: "Lakers vs Celtics | Bulls vs Knicks", esporte: "Basketball", competicao: "NBA", pais: "USA",
        mercado: "Money Line – Regulation Time", selecao: "Lakers / Bulls",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "Lakers vs Celtics", mercado: "Money Line – Regulation Time", selecao: "Lakers" },
            { evento: "Bulls vs Knicks", mercado: "Money Line – Game", selecao: "Bulls" },
          ],
        },
        odds: 4, stake: 1, status: "PENDING", sportResolutionStatus: "CONFIRMED", kickoffInferido: false,
      },
    });
    return bet.id;
  }

  const observe = async (betId: string, matches: FlashscoreMatch[]) => observeFlashscoreTicketBet({
    bet: await loadEligible(betId),
    matches,
    sportId: 3,
    day: "2026-07-25",
    now: NOW,
    loadMatches: async () => null,
    summaryCache: new Map(),
  });

  it("sem prorrogação, a perna do tempo regulamentar liquida pelo placar do confronto dela", async () => {
    const betId = await basketballParlay();

    const run = await observe(betId, [
      partida({ id: "bb-1", home: "Lakers", away: "Celtics", homeScore: 101, awayScore: 99 }),
      partida({ id: "bb-2", home: "Bulls", away: "Knicks", homeScore: 110, awayScore: 100 }),
    ]);

    expect(run.settled).toBe(true);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }))
      .resolves.toMatchObject({ status: "WON" });
  });

  it("com prorrogação no confronto da perna regulamentar, vai para o operador", async () => {
    const betId = await basketballParlay();

    const run = await observe(betId, [
      partida({ id: "bb-1", home: "Lakers", away: "Celtics", homeScore: 110, awayScore: 105, extraTime: true }),
      partida({ id: "bb-2", home: "Bulls", away: "Knicks", homeScore: 110, awayScore: 100 }),
    ]);

    expect(run.settled).toBe(false);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }))
      .resolves.toMatchObject({ status: "PENDING" });
  });
});

/**
 * Esporte sem flag de fim (beisebol, handebol, vôlei…): o fim de cada jogo da
 * múltipla é deduzido como na aposta simples — placar parado há meia hora
 * depois do portão de duração —, pela leitura anterior do MESMO confronto.
 */
describe("múltipla de esporte inferido", () => {
  const HOUR = 3_600_000;
  async function duplaDeBeisebol(): Promise<string> {
    const banca = await db.prisma.bankroll.create({ data: { nome: "MLB", slug: "mlb" } });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolvedAt: new Date(), bankrollId: banca.id, data: KICKOFF,
        evento: "New York Yankees vs Boston Red Sox | Chicago Cubs vs Houston Astros",
        esporte: "Baseball", competicao: "MLB", pais: "USA", mercado: "Moneyline",
        selecao: "New York Yankees / Chicago Cubs",
        legsJson: { kind: "parlay", legs: [
          { evento: "New York Yankees vs Boston Red Sox", mercado: "Moneyline", selecao: "New York Yankees" },
          { evento: "Chicago Cubs vs Houston Astros", mercado: "Moneyline", selecao: "Chicago Cubs" },
        ] },
        odds: 3, stake: 1, status: "PENDING", sportResolutionStatus: "CONFIRMED", kickoffInferido: false,
      },
    });
    return bet.id;
  }
  /** O feed de beisebol nunca marca o fim: `is_finished` fica false. */
  const jogos = (cubs: number) => [
    { ...partida({ id: "fs-nyy", home: "New York Yankees", away: "Boston Red Sox", homeScore: 5, awayScore: 3 }),
      match_status: { ...FINISHED, stage: null, is_finished: false } },
    { ...partida({ id: "fs-chc", home: "Chicago Cubs", away: "Houston Astros", homeScore: cubs, awayScore: 1 }),
      match_status: { ...FINISHED, stage: null, is_finished: false } },
  ] as FlashscoreMatch[];
  const observe = async (betId: string, matches: FlashscoreMatch[], now: Date) => observeFlashscoreTicketBet({
    bet: await loadEligible(betId), matches, sportId: 6, day: "2026-07-25", now,
    loadMatches: async () => null, summaryCache: new Map(),
  });
  const snapshot = async (betId: string) =>
    (await db.prisma.betResult.findUniqueOrThrow({ where: { betId } })).resultSnapshot as Record<string, unknown>;

  it("liquida na leitura seguinte com os placares parados, e marca a inferência", async () => {
    const betId = await duplaDeBeisebol();

    expect(await observe(betId, jogos(2), new Date(KICKOFF.getTime() + 7 * HOUR)))
      .toMatchObject({ settled: false, final: false });
    expect(await snapshot(betId)).toMatchObject({ placares: {
      "fs-nyy": { placar: "5x3" }, "fs-chc": { placar: "2x1" },
    } });

    expect(await observe(betId, jogos(2), new Date(KICKOFF.getTime() + 7.5 * HOUR)))
      .toMatchObject({ settled: true, final: true });
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).resolves.toMatchObject({ status: "WON" });
    expect(await snapshot(betId)).toMatchObject({
      settlementOutcome: "settled_from_score_inferido",
      placares: { "fs-nyy": { inferido: true }, "fs-chc": { inferido: true } },
    });
  });

  it("perna que perdeu decide a múltipla; o jogo ainda rolando não fica marcado como deduzido", async () => {
    const betId = await duplaDeBeisebol();
    const cubsPerdendo = jogos(0);
    await observe(betId, cubsPerdendo, new Date(KICKOFF.getTime() + 7 * HOUR));
    // Yankees x Red Sox segue rolando; os Cubs perderam por 0x1, placar parado.
    const yankeesRolando = [{ ...cubsPerdendo[0]!, scores: { home: 6, away: 3 } }, cubsPerdendo[1]!];

    expect(await observe(betId, yankeesRolando, new Date(KICKOFF.getTime() + 7.5 * HOUR)))
      .toMatchObject({ settled: true });
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).resolves.toMatchObject({ status: "LOST" });
    const placares = (await snapshot(betId)).placares as Record<string, Record<string, unknown>>;
    expect(placares["fs-chc"]).toMatchObject({ placar: "0x1", inferido: true });
    expect(placares["fs-nyy"]).toMatchObject({ placar: "6x3" });
    expect(placares["fs-nyy"]).not.toHaveProperty("inferido");
  });

  it("placar que mudou entre as leituras não liquida e renova a âncora", async () => {
    const betId = await duplaDeBeisebol();
    await observe(betId, jogos(1), new Date(KICKOFF.getTime() + 7 * HOUR));

    const later = new Date(KICKOFF.getTime() + 7.5 * HOUR);
    expect(await observe(betId, jogos(2), later)).toMatchObject({ settled: false, final: false });
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).resolves.toMatchObject({ status: "PENDING" });
    expect(await snapshot(betId)).toMatchObject({ placares: {
      "fs-nyy": { placar: "5x3", placarDesde: new Date(KICKOFF.getTime() + 7 * HOUR).toISOString() },
      "fs-chc": { placar: "2x1", placarDesde: later.toISOString() },
    } });
  });
});


describe("múltipla parcialmente cancelada", () => {
  it.each([false, true])("cancelamento com outra perna perdida (ordem invertida: %s) exige conferir a casa", async (reverse) => {
    const betId = await multiplaDeNoventa();
    const matches = [
      partida({ id: "fs-fr", home: "France", away: "Morocco", homeScore: 0, awayScore: 1 }),
      { ...partida({ id: "fs-es", home: "Spain", away: "Italy", homeScore: 0, awayScore: 0 }),
        match_status: { ...FINISHED, stage: "Cancelled", is_cancelled: true, is_finished: false } },
    ];
    const { bankrollId } = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    const { contaId } = await criarConta({ casaDeAposta: "Betano", titular: "Teste", saldoInicial: 100,
      bankrollIds: [bankrollId], actor: "audit" }, { client: db.prisma });
    await db.prisma.bet.update({ where: { id: betId }, data: { contaId, casaDeAposta: "Betano", valorUnidade: 50 } });
    for (let cycle = 0; cycle < 2; cycle++) {
      const run = await observeFlashscoreTicketBet({ bet: await loadEligible(betId), matches: reverse ? matches.toReversed() : matches,
        sportId: 1, day: "2026-07-25", now: NOW, loadMatches: async () => null, summaryCache: new Map(),
      });
      expect(run).toMatchObject({ settled: false, final: true });
    }
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } })).resolves.toMatchObject({ status: "PENDING" });
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: contaId } })).saldoAtual)).toBe(100);
    expect(await db.prisma.movimentacao.count({ where: { betId } })).toBe(0);
    const actions = await db.prisma.operationalAction.findMany({ where: { resource: "bet", resourceId: betId, status: "OPEN" } });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.description).toContain("anulada");
  });
});
