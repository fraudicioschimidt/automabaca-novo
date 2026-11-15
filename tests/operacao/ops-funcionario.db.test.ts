import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// O enrich depois do Vincular e do esporte: só conferido, sem pg-boss.
const enrich = vi.hoisted(() => ({ enqueue: vi.fn(async () => "job") }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ enqueueSharpEnrich: enrich.enqueue }));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: vi.fn(async () => ({})) }));

import { prisma } from "@/src/infra/prisma";
import type { Prisma } from "@/src/generated/prisma/client";
import * as training from "@/src/services/sharp/training-resolve";
import { deferTrainingCaseForAgent, readWriteBudget, applyVincularPlan, buildVincularPlan } from "@/src/services/ops/funcionario/escrita";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalogLink, seedTeamCard } from "../helpers/team-cards";
import { runFuncionario, type FuncionarioIo } from "@/scripts/ops-funcionario";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { spDayKey } from "@/src/domain/dates";
import * as settleEffects from "@/src/services/bets/settle-effects";
import { reportOperationalActions } from "@/src/services/ops/operational-actions";

/**
 * O `ops-funcionario` contra Postgres real: o executor delegado é obrigatório,
 * o plano não grava, a aplicação só aceita o plano do hash (e do mesmo
 * executor), e o teto de escritas do dono (somando os agentes dele) recusa
 * acima de 50 em 24 h e de 10 num minuto.
 */

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });

const EXECUTOR = "agent:gemini:por:fabricio";
// O relógio de verdade: as auditorias das escritas gravam o instante real, e o teto conta a partir dele.
let NOW = new Date();
const afterWrite = vi.fn(async () => {});

beforeEach(async () => {
  NOW = new Date();
  await db.reset();
  afterWrite.mockClear();
  enrich.enqueue.mockClear();
  await db.prisma.authSessionState.create({ data: { username: "fabricio", epoch: 1n } });
});

function run(args: string[], stdin?: unknown) {
  const io: FuncionarioIo = { readStdin: async () => stdin, afterWrite, now: () => NOW };
  return runFuncionario(args, io);
}

async function runJson(args: string[], stdin?: unknown) {
  const result = await run(args, stdin);
  return { code: result.code, body: result.stdout ? JSON.parse(result.stdout) as Record<string, unknown> & { planHash?: string } : null };
}

async function seedBankroll() {
  return db.prisma.bankroll.upsert({
    where: { slug: "tipster-a" }, update: {}, create: { nome: "Tipster A", slug: "tipster-a", valorUnidade: 100 },
  });
}

async function seedCaseBet() {
  const bankroll = await seedBankroll();
  const bet = await db.prisma.bet.create({
    data: {
      bankrollId: bankroll.id, data: new Date("2026-09-25T12:00:00Z"), evento: "Fla vs Verdao", esporte: "Soccer",
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: NOW, mercado: "Total", selecao: "Under 2.5", odds: 1.9, stake: 1,
    },
  });
  const tcase = await db.prisma.trainingCase.create({
    data: {
      betId: bet.id, evento: "Fla vs Verdao", esporte: "Soccer", pais: "Brazil", competicao: "Serie A", status: "OPEN",
      autoScore: 55,
      candidatesJson: [{
        matchId: 777, home: "Flamengo RJ", away: "Palmeiras SP", league: "Brazil - Serie A",
        matchDate: "2026-09-25 12:00:00", score: 55, swapped: false,
      }],
    },
  });
  await seedCatalogLink(db.prisma, {
    pinnacleEventId: "777", flashscoreMatchId: "fs-777", pinnacleHome: "Flamengo RJ", pinnacleAway: "Palmeiras SP",
    flashscoreHome: "Flamengo", flashscoreAway: "Palmeiras", flashscoreHomeTeamId: "fs-fla", flashscoreAwayTeamId: "fs-pal",
    kickoff: new Date("2026-09-25T12:00:00Z"),
  });
  // Os dois lados bem casados no jogo 777.
  await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil", pinnacleNames: [{ name: "Flamengo RJ", eventIds: ["777"] }] });
  await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-pal", flashscoreName: "Palmeiras", country: "Brazil", pinnacleNames: [{ name: "Palmeiras SP", eventIds: ["777"] }] });
  return { bankroll, bet, tcase };
}

async function seedSportPendingBet() {
  const bankroll = await seedBankroll();
  return db.prisma.bet.create({
    data: {
      bankrollId: bankroll.id, data: new Date("2026-09-25T20:00:00Z"), evento: "Time Raro vs Outro Raro", esporte: "Unknown",
      mercado: "Moneyline", selecao: "Time Raro", odds: 2, stake: 1, sportResolutionStatus: "PENDING", sportConfidence: 0,
      sportSource: "UNRESOLVED",
    },
  });
}

/** Decisões já gravadas por um agente, como as auditorias as contam: com a evidência nos detalhes. */
async function seedWrites(count: number, createdAt: Date, actor = EXECUTOR) {
  await db.prisma.auditEvent.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      actor, action: "bet.settle_delegated", resource: "bet", resourceId: `bet-${i}`, createdAt,
      details: { evidence: "FlashScore: placar final conferido" },
    })),
  });
}

/** O hash do candidato 0 do caso, como `pendencias` e `ficha` o mostram. */
function hashOf(tcase: { candidatesJson: unknown }): string {
  return canonicalSha256((tcase.candidatesJson as unknown[])[0]);
}

const VINCULAR_EVIDENCE = "Pinnacle lista Flamengo x Palmeiras às 12h na Serie A, mesmo horário do post";

describe("executor delegado obrigatório", () => {
  it("sem --executor, ou fora do formato, é uso errado e não lê nada", async () => {
    expect((await run(["pendencias"])).code).toBe(64);
    expect((await run(["pendencias", "--executor", "fabricio"])).code).toBe(64);
    expect((await run(["pendencias", "--executor", "agent:Gemini:por:fabricio"])).code).toBe(64);
  });

  it("o dono do executor precisa ser usuário do painel", async () => {
    const result = await runJson(["pendencias", "--executor", "agent:gemini:por:alguem"]);
    expect(result.code).toBe(2);
    expect(result.body?.erro).toMatch(/não é usuário do painel/);
  });

  it("escrita sem evidência ou sem motivo é uso errado", async () => {
    const { tcase } = await seedCaseBet();
    expect((await run(["vincular", "plan", tcase.id, "0", hashOf(tcase), "--executor", EXECUTOR])).code).toBe(64);
    // Sem o hash do candidato lido, o índice sozinho não basta.
    expect((await run(["vincular", "plan", tcase.id, "0", "--executor", EXECUTOR, "--evidencia", VINCULAR_EVIDENCE])).code).toBe(64);
    expect((await run(["ignorar", tcase.id, "--executor", EXECUTOR])).code).toBe(64);
    // Evidência curta demais é recusa, com o motivo.
    const short = await runJson(["vincular", "plan", tcase.id, "0", hashOf(tcase), "--executor", EXECUTOR, "--evidencia", "ok"]);
    expect(short.code).toBe(2);
  });
});

describe("pendencias e ficha", () => {
  it("lista o que a caixa manda para o dono, com os candidatos, e esconde o que já foi resolvido", async () => {
    const { bet, tcase } = await seedCaseBet();
    const sport = await seedSportPendingBet();
    const settled = await db.prisma.bet.create({
      data: {
        bankrollId: bet.bankrollId, data: new Date(NOW.getTime() - 27.5 * 3_600_000), evento: "A vs B", esporte: "Soccer",
        sportResolutionStatus: "CONFIRMED", sportResolvedAt: NOW, mercado: "Total", selecao: "Over 2.5", odds: 2, stake: 1,
      },
    });
    const common = { area: "x", actionType: "t", title: "t", incrementOccurrence: false, resource: "bet" } as const;
    await reportOperationalActions([
      { ...common, source: "training", key: tcase.id, description: "1 candidato", resource: "training-case", resourceId: tcase.id },
      { ...common, source: "sport-resolution", key: sport.id, description: "esporte", resourceId: sport.id },
      { ...common, source: "settlement.parado", key: settled.id, description: "O jogo terminou há 27 h", resourceId: settled.id },
      // Já liquidada depois da última reconciliação: não aparece.
      { ...common, source: "settlement.parado", key: bet.id, description: "velha", resourceId: bet.id },
    ], NOW);
    await db.prisma.bet.update({ where: { id: bet.id }, data: { status: "WON", lucro: 0.9, settledAt: NOW } });

    const { code, body } = await runJson(["pendencias", "--executor", EXECUTOR]);

    expect(code).toBe(0);
    expect(body?.totais).toEqual({ vincular: 1, esportes: 1, liquidar: 1, sugestoesIaJudge: 0, perguntasNaDm: 0 });
    expect(body?.vincular).toEqual([expect.objectContaining({
      caseId: tcase.id, betId: bet.id, candidatos: [expect.objectContaining({ indice: 0, hash: hashOf(tcase), home: "Flamengo RJ", matchId: 777 })],
    })]);
    expect(body?.esportes).toEqual([expect.objectContaining({ betId: sport.id, status: "PENDING" })]);
    expect(body?.liquidar).toEqual([expect.objectContaining({ betId: settled.id, situacao: "O jogo terminou há 27 h", horasDesdeOInicio: 27 })]);
  });

  it("a ficha traz a aposta, o post lido, os candidatos e o que o FlashScore viu", async () => {
    const { bet, tcase } = await seedCaseBet();
    await db.prisma.betCaptureEvidence.create({
      data: { betId: bet.id, parser: "gemini", caption: "Fla x Verdão under 2.5 @1.90", parsedJson: { evento: "Fla vs Verdao" }, expiresAt: NOW },
    });
    await db.prisma.betResult.create({
      data: {
        betId: bet.id, resultProvider: "flashscore", resultMatchId: "fs-777", scoreHome: 1, scoreAway: 0, resultFinal: true,
        resultSnapshot: { providerTeams: { home: "Flamengo", away: "Palmeiras", swapped: false }, score: { home: 1, away: 0 } },
      },
    });

    const { code, body } = await runJson(["ficha", bet.id, "--executor", EXECUTOR]);

    expect(code).toBe(0);
    expect(body).toMatchObject({
      aposta: { id: bet.id, evento: "Fla vs Verdao", odds: 1.9, status: "PENDING" },
      post: { legenda: "Fla x Verdão under 2.5 @1.90" },
      vincular: { caseId: tcase.id, candidatos: [expect.objectContaining({ indice: 0, hash: hashOf(tcase) })] },
      flashscore: { jogo: "fs-777", final: true, lados: { first: "Flamengo", second: "Palmeiras" } },
    });
    expect((await runJson(["ficha", "00000000-0000-4000-8000-000000000000", "--executor", EXECUTOR])).code).toBe(2);
  });
});

describe("vincular", () => {
  it("o plano mostra o jogo e os nomes que vai ensinar, sem gravar nada", async () => {
    const { bet, tcase } = await seedCaseBet();

    const { code, body } = await runJson(["vincular", "plan", tcase.id, "0", hashOf(tcase), "--executor", EXECUTOR, "--evidencia", VINCULAR_EVIDENCE]);

    expect(code).toBe(0);
    expect(body).toMatchObject({
      kind: "vincular", executor: EXECUTOR, caseId: tcase.id, candidateIndex: 0, evidence: VINCULAR_EVIDENCE,
      preview: {
        betId: bet.id, eventoDepois: "Flamengo RJ vs Palmeiras SP",
        nomes: [expect.objectContaining({ nome: "Fla", resultado: "ensinado" }), expect.objectContaining({ nome: "Verdao", resultado: "ensinado" })],
      },
    });
    expect(body?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).status).toBe("OPEN");
    expect(await db.prisma.teamTipsterName.count()).toBe(0);
    expect(await db.prisma.auditEvent.count()).toBe(0);
  });

  it("aplica só o plano do hash, com o ator do agente, e ensina os nomes", async () => {
    const { bet, tcase } = await seedCaseBet();
    const { body: plan } = await runJson(["vincular", "plan", tcase.id, "0", hashOf(tcase), "--executor", EXECUTOR, "--evidencia", VINCULAR_EVIDENCE]);

    const wrongHash = await runJson(["vincular", "apply", "f".repeat(64), "--executor", EXECUTOR], plan);
    expect(wrongHash.code).toBe(2);
    const edited = await runJson(["vincular", "apply", plan!.planHash!, "--executor", EXECUTOR], { ...plan, candidateIndex: 1 });
    expect(edited.code).toBe(2);
    const otherExecutor = await runJson(["vincular", "apply", plan!.planHash!, "--executor", "agent:claude:por:fabricio"], plan);
    expect(otherExecutor.code).toBe(2);
    expect((await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).status).toBe("OPEN");

    const applied = await runJson(["vincular", "apply", plan!.planHash!, "--executor", EXECUTOR], plan);

    expect(applied.code).toBe(0);
    expect(applied.body).toMatchObject({ kind: "saved", betId: bet.id, nomes: [{ resultado: "ensinado" }, { resultado: "ensinado" }] });
    expect(afterWrite).toHaveBeenCalledExactlyOnceWith([{ source: "training", key: tcase.id }], EXECUTOR);
    expect(enrich.enqueue).toHaveBeenCalledExactlyOnceWith(expect.anything(), bet.id, { origem: "funcionario-vincular" });
    expect(await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "training_case.resolve" } }))
      .toMatchObject({ actor: EXECUTOR, details: expect.objectContaining({ evidence: VINCULAR_EVIDENCE }) });
    expect(await db.prisma.teamTipsterName.findMany({ select: { name: true, status: true, decidedBy: true }, orderBy: { name: "asc" } }))
      .toEqual([
        { name: "Fla", status: "confirmed", decidedBy: EXECUTOR },
        { name: "Verdao", status: "confirmed", decidedBy: EXECUTOR },
      ]);

    // Reaplicar: o caso já está fechado.
    expect((await runJson(["vincular", "apply", plan!.planHash!, "--executor", EXECUTOR], plan)).code).toBe(3);
  });

  it("Vincular confere o teto novamente junto da decisão", async () => {
    const { tcase } = await seedCaseBet();
    const plan = await buildVincularPlan({ caseId: tcase.id, candidateIndex: 0, candidateHash: hashOf(tcase), evidence: VINCULAR_EVIDENCE, executor: EXECUTOR, now: NOW });
    await seedWrites(49, new Date(NOW.getTime() - 2 * 3_600_000));
    const realResolve = training.resolverTrainingCase;
    const spy = vi.spyOn(training, "resolverTrainingCase").mockImplementationOnce(async (...args) => {
      await seedWrites(1, new Date(NOW.getTime() - 2 * 3_600_000));
      return realResolve(...args);
    });
    try { expect(await applyVincularPlan(plan, plan.planHash, EXECUTOR, NOW)).toMatchObject({ kind: "refused", message: expect.stringContaining("Teto de escritas") }); }
    finally { spy.mockRestore(); }
    expect(await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).toMatchObject({ status: "OPEN" });
    expect(await db.prisma.auditEvent.count({ where: { action: "training_case.resolve" } })).toBe(0);
  });

  it("candidatos regravados entre a leitura do agente e o vincular: o índice aponta para outro jogo e o plano recusa", async () => {
    const { bet, tcase } = await seedCaseBet();
    const { body: pendencias } = await runJson(["pendencias", "--executor", EXECUTOR]);
    const lido = (await runJson(["ficha", bet.id, "--executor", EXECUTOR])).body as { vincular: { candidatos: Array<{ indice: number; hash: string }> } };
    expect(pendencias).toBeTruthy();
    // A busca automática regrava os candidatos do caso aberto: o índice 0 passa a ser outro jogo.
    await db.prisma.trainingCase.update({
      where: { id: tcase.id },
      data: { candidatesJson: [
        { matchId: 888, home: "Flamengo PI", away: "Palmeiras B", league: "Brazil - Serie D", matchDate: "2026-09-25 12:00:00", score: 60, swapped: false },
        ...(tcase.candidatesJson as object[]),
      ] },
    });

    const plan = await runJson(["vincular", "plan", tcase.id, "0", lido.vincular.candidatos[0]!.hash, "--executor", EXECUTOR, "--evidencia", VINCULAR_EVIDENCE]);

    expect(plan.code).toBe(2);
    expect(plan.body?.erro).toMatch(/candidatos do caso mudaram/);
    expect((await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).status).toBe("OPEN");
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ evento: "Fla vs Verdao" });
    expect(await db.prisma.teamTipsterName.count()).toBe(0);
  });

  it("a ação da caixa que não fecha depois do commit vira aviso: a escrita sai como gravada", async () => {
    const { bet, tcase } = await seedCaseBet();
    const { body: plan } = await runJson(["vincular", "plan", tcase.id, "0", hashOf(tcase), "--executor", EXECUTOR, "--evidencia", VINCULAR_EVIDENCE]);
    afterWrite.mockRejectedValueOnce(new Error("banco fora"));

    const applied = await runJson(["vincular", "apply", plan!.planHash!, "--executor", EXECUTOR], plan);

    expect(applied).toMatchObject({ code: 0, body: { kind: "saved", betId: bet.id, aviso: expect.stringContaining("Gravado") } });
    expect((await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).status).toBe("RESOLVED_MANUAL");
  });

  it("candidatos que mudaram depois do plano: não grava", async () => {
    const { tcase } = await seedCaseBet();
    const { body: plan } = await runJson(["vincular", "plan", tcase.id, "0", hashOf(tcase), "--executor", EXECUTOR, "--evidencia", VINCULAR_EVIDENCE]);
    await db.prisma.trainingCase.update({
      where: { id: tcase.id },
      data: { candidatesJson: [{ matchId: 888, home: "Outro", away: "Jogo", league: "Brazil - Serie B", matchDate: "2026-09-25 12:00:00", score: 50, swapped: false }] },
    });

    const result = await runJson(["vincular", "apply", plan!.planHash!, "--executor", EXECUTOR], plan);

    expect(result).toMatchObject({ code: 3, body: { kind: "conflict" } });
    expect((await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).status).toBe("OPEN");
  });
});

describe("ignorar", () => {
  it("confere o teto no commit mesmo quando a chamada começou antes de outra decisão", async () => {
    await seedWrites(49, new Date(NOW.getTime() - 2 * 3_600_000));
    const firstCase = await db.prisma.trainingCase.create({ data: { evento: "Primeiro", esporte: "Soccer" } });
    const secondCase = await db.prisma.trainingCase.create({ data: { evento: "Segundo", esporte: "Soccer" } });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realDefer = training.ignorarTrainingCase;
    const writeSpy = vi.spyOn(training, "ignorarTrainingCase").mockImplementationOnce(async (...args) => {
      entered(); await gate; return realDefer(...args);
    });
    const first = deferTrainingCaseForAgent({ caseId: firstCase.id, reason: "Candidato sem evidência suficiente", executor: EXECUTOR, now: NOW })
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await started;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(await deferTrainingCaseForAgent({ caseId: secondCase.id, reason: "Candidato sem evidência suficiente", executor: EXECUTOR, now: NOW }))
        .toMatchObject({ kind: "saved" });
      expect((await readWriteBudget(EXECUTOR, NOW)).usadasEm24h).toBe(50);
      release();
      expect(await first).toMatchObject({ value: { kind: "refused", message: expect.stringContaining("Teto de escritas") } });
      expect((await readWriteBudget(EXECUTOR, NOW)).usadasEm24h).toBe(50);
      expect(await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: firstCase.id } })).toMatchObject({ status: "OPEN" });
    } finally { release(); await first; writeSpy.mockRestore(); }
  });

  it("timeout reverte a decisão e sua auditoria juntos, liberando só o orçamento não usado", async () => {
    await seedWrites(49, new Date(NOW.getTime() - 2 * 3_600_000));
    const firstCase = await db.prisma.trainingCase.create({ data: { evento: "Primeiro", esporte: "Soccer" } });
    const secondCase = await db.prisma.trainingCase.create({ data: { evento: "Segundo", esporte: "Soccer" } });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const realTx = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => realTx(async (tx) => {
      const result = await fn(tx);
      entered(); await gate;
      return result;
    }, { ...options, timeout: 300 })) as typeof prisma.$transaction);
    const first = deferTrainingCaseForAgent({ caseId: firstCase.id, reason: "Candidato sem evidência suficiente", executor: EXECUTOR, now: NOW })
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await started;
      await new Promise((resolve) => setTimeout(resolve, 600));
      release();
      expect(await first).toHaveProperty("error");
      expect((await readWriteBudget(EXECUTOR, NOW)).usadasEm24h).toBe(49);
      expect(await deferTrainingCaseForAgent({ caseId: secondCase.id, reason: "Candidato sem evidência suficiente", executor: EXECUTOR, now: NOW })).toMatchObject({ kind: "saved" });
      release();
      expect((await readWriteBudget(EXECUTOR, NOW)).usadasEm24h).toBe(50);
      expect(await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: firstCase.id } })).toMatchObject({ status: "OPEN" });
    } finally { release(); await first; spy.mockRestore(); }
  });

  it("adia o caso com o motivo e o ator do agente", async () => {
    const { tcase } = await seedCaseBet();

    const result = await runJson(["ignorar", tcase.id, "--executor", EXECUTOR, "--motivo", "Nenhum candidato tem os dois times do post"]);

    expect(result).toMatchObject({ code: 0, body: { kind: "saved", caseId: tcase.id } });
    expect((await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).status).toBe("REJECTED");
    expect(await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "training_case.defer" } }))
      .toMatchObject({ actor: EXECUTOR, details: expect.objectContaining({ reason: "Nenhum candidato tem os dois times do post" }) });
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });
});

describe("esporte", () => {
  const EVIDENCE = "FlashScore lista Time Raro x Outro Raro na liga de basquete do Chile";

  it("o plano do esporte escolhido não grava; a aplicação confirma com a evidência e o executor", async () => {
    const bet = await seedSportPendingBet();

    const { code, body: plan } = await runJson(["esporte", "plan", bet.id, "basquete", "--executor", EXECUTOR, "--evidencia", EVIDENCE]);
    expect(code).toBe(0);
    expect(plan).toMatchObject({ executor: EXECUTOR, item: { betId: bet.id, candidate: { sport: "Basketball", source: "MANUAL", evidence: EVIDENCE } } });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).sportResolutionStatus).toBe("PENDING");

    expect((await runJson(["esporte", "apply", "0".repeat(64), "--executor", EXECUTOR], plan)).code).toBe(2);
    expect((await runJson(["esporte", "apply", plan!.planHash!, "--executor", "agent:claude:por:fabricio"], plan)).code).toBe(2);

    const applied = await runJson(["esporte", "apply", plan!.planHash!, "--executor", EXECUTOR], plan);

    expect(applied).toMatchObject({ code: 0, body: { kind: "saved", sport: "Basketball" } });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .toMatchObject({ esporte: "Basketball", sportResolutionStatus: "CONFIRMED", sportSource: "MANUAL" });
    expect(await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bet.sport_resolve.operator" } }))
      .toMatchObject({ actor: EXECUTOR, details: expect.objectContaining({ sport: "Basketball", evidence: EVIDENCE }) });
    expect(enrich.enqueue).toHaveBeenCalledTimes(1);
  });

  it("esporte e auditoria são revertidos juntos se a gravação da auditoria falha", async () => {
    const bet = await seedSportPendingBet();
    const plan = await runJson(["esporte", "plan", bet.id, "basquete", "--executor", EXECUTOR, "--evidencia", EVIDENCE]);
    const realTx = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => realTx(async (tx) => {
      const create = tx.auditEvent.create.bind(tx.auditEvent);
      const auditSpy = vi.spyOn(tx.auditEvent, "create").mockImplementation(((args) => {
        if (args.data.action === "bet.sport_resolve.operator") throw new Error("auditoria indisponível");
        return create(args);
      }) as typeof tx.auditEvent.create);
      try { return await fn(tx); } finally { auditSpy.mockRestore(); }
    }, options)) as typeof prisma.$transaction);
    try { await expect(runJson(["esporte", "apply", plan.body!.planHash!, "--executor", EXECUTOR], plan.body)).rejects.toThrow("auditoria indisponível"); }
    finally { spy.mockRestore(); }
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ esporte: "Unknown", sportResolutionStatus: "PENDING" });
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.sport_resolve.operator" } })).toBe(0);
    expect(enrich.enqueue).not.toHaveBeenCalled();
  });

  it("esporte desconhecido e aposta com esporte já confirmado são recusados", async () => {
    const bet = await seedSportPendingBet();
    expect((await runJson(["esporte", "plan", bet.id, "Quadribol", "--executor", EXECUTOR, "--evidencia", EVIDENCE])).code).toBe(2);
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { sportResolutionStatus: "CONFIRMED", esporte: "Soccer", sportConfidence: 100, sportSource: "MANUAL", sportResolvedAt: NOW },
    });
    expect(await runJson(["esporte", "plan", bet.id, "Basketball", "--executor", EXECUTOR, "--evidencia", EVIDENCE]))
      .toMatchObject({ code: 2, body: { ok: false, reason: "already_confirmed" } });
  });
});

describe("texto livre", () => {
  it("evidência e motivo que começam com \"-\" passam como texto, na forma --opção=texto", async () => {
    const { tcase } = await seedCaseBet();

    const result = await runJson(["ignorar", tcase.id, `--executor=${EXECUTOR}`, "--motivo=- nenhum candidato tem os dois times"]);

    expect(result.code).toBe(0);
    expect(await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "training_case.defer" } }))
      .toMatchObject({ details: expect.objectContaining({ reason: "- nenhum candidato tem os dois times" }) });
  });
});

describe("liquidar", () => {
  const EVIDENCE = "FlashScore: Flamengo 2 x 1 Palmeiras, jogo encerrado";

  async function settleBet(kickoff: Date, extra: { kickoffInferido?: boolean } = {}) {
    const bankroll = await seedBankroll();
    return db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id, data: kickoff, evento: "Flamengo RJ vs Palmeiras SP", esporte: "Soccer",
        sportResolutionStatus: "CONFIRMED", sportResolvedAt: NOW, mercado: "Total", selecao: "Over 2.5", odds: 2, stake: 1,
        ...extra,
      },
    });
  }

  async function openSuggestion(betId: string, suggestedStatus: "WON" | "LOST") {
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId }, select: { updatedAt: true } });
    return db.prisma.iaJudgeSuggestion.create({
      data: {
        betId, suggestedStatus, valueFound: "3 gols", confidence: 0.9, reason: "placar final 2x1",
        evidenceKind: "FLASHSCORE_STRUCTURED", betUpdatedAt: bet.updatedAt,
      },
    });
  }

  const request = (betId: string, newStatus = "WON") => ({ items: [{ betId, newStatus, evidence: EVIDENCE }] });

  async function planAndApply(betId: string, newStatus = "WON") {
    const plan = await runJson(["liquidar", "plan", `--executor=${EXECUTOR}`], request(betId, newStatus));
    if (plan.code !== 0) return { plan, applied: null };
    const applied = await runJson(["liquidar", "apply", plan.body!.planHash!, `--executor=${EXECUTOR}`], plan.body);
    return { plan, applied };
  }

  it("jogo terminado sem sugestão: liquida com recibo, com o ator do agente; o plano não grava", async () => {
    const bet = await settleBet(new Date(NOW.getTime() - 5 * 3_600_000));
    const plan = await runJson(["liquidar", "plan", `--executor=${EXECUTOR}`], request(bet.id));
    expect(plan).toMatchObject({ code: 0, body: { agent: "gemini", approvedBy: "fabricio", items: [{ betId: bet.id, newStatus: "WON" }] } });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");

    expect((await runJson(["liquidar", "apply", "0".repeat(64), `--executor=${EXECUTOR}`], plan.body)).code).toBe(2);
    expect((await runJson(["liquidar", "apply", plan.body!.planHash!, "--executor=agent:claude:por:fabricio"], plan.body)).code).toBe(2);
    const applied = await runJson(["liquidar", "apply", plan.body!.planHash!, `--executor=${EXECUTOR}`], plan.body);

    expect(applied).toMatchObject({ code: 0, body: { results: [{ betId: bet.id, kind: "saved", via: "recibo" }] } });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("WON");
    expect(await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bet.settle_delegated" } }))
      .toMatchObject({ actor: EXECUTOR, details: expect.objectContaining({ evidence: EVIDENCE }) });
    expect(await db.prisma.manualSettlementReceipt.count({ where: { betId: bet.id } })).toBe(1);
  });

  it("jogo em andamento ou com horário provisório, sem sugestão: recusa no plano", async () => {
    const live = await settleBet(new Date(NOW.getTime() - 3_600_000));
    const provisional = await settleBet(new Date(NOW.getTime() - 10 * 3_600_000), { kickoffInferido: true });

    for (const bet of [live, provisional]) {
      const { plan } = await planAndApply(bet.id);
      expect(plan.code).toBe(2);
      expect(plan.body).toMatchObject({ ok: false, refusals: [{ betId: bet.id }] });
    }
    expect(await db.prisma.bet.count({ where: { status: "PENDING" } })).toBe(2);
  });

  it("sugestão aberta com o mesmo resultado: homologa pelo caminho do IA-Judge, mesmo com o jogo recente", async () => {
    const bet = await settleBet(new Date(NOW.getTime() - 2.5 * 3_600_000));
    const suggestion = await openSuggestion(bet.id, "WON");

    const { applied } = await planAndApply(bet.id, "WON");

    expect(applied).toMatchObject({ code: 0, body: { results: [{ betId: bet.id, kind: "saved", via: "ia-judge" }] } });
    expect(await db.prisma.iaJudgeSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } }))
      .toMatchObject({ status: "APPROVED", resolvedBy: EXECUTOR });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "WON" });
    expect(await db.prisma.settlementEvent.findFirstOrThrow({ where: { betId: bet.id, type: "STATUS_CHANGED" } }))
      .toMatchObject({ payload: expect.objectContaining({ source: `ia-judge:${EXECUTOR}` }) });
    expect(await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bet.settle_delegated" } }))
      .toMatchObject({ actor: EXECUTOR, details: expect.objectContaining({ via: "ia-judge", suggestionId: suggestion.id, evidence: EVIDENCE }) });
    expect(await db.prisma.manualSettlementReceipt.count()).toBe(0);
  });

  it("sugestão aberta com outro resultado, jogo terminado: liquida com recibo e a sugestão fica aberta", async () => {
    const bet = await settleBet(new Date(NOW.getTime() - 5 * 3_600_000));
    const suggestion = await openSuggestion(bet.id, "LOST");

    const { applied } = await planAndApply(bet.id, "WON");

    expect(applied).toMatchObject({ code: 0, body: { results: [{ kind: "saved", via: "recibo" }] } });
    expect((await db.prisma.iaJudgeSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } })).status).toBe("PENDING");
  });

  it("a sugestão que o plano viu sumiu e o jogo é recente: recusa na aplicação, sem gravar", async () => {
    const bet = await settleBet(new Date(NOW.getTime() - 3_600_000));
    const suggestion = await openSuggestion(bet.id, "WON");
    const plan = await runJson(["liquidar", "plan", `--executor=${EXECUTOR}`], request(bet.id));
    await db.prisma.iaJudgeSuggestion.update({ where: { id: suggestion.id }, data: { status: "REJECTED" } });

    const applied = await runJson(["liquidar", "apply", plan.body!.planHash!, `--executor=${EXECUTOR}`], plan.body);

    expect(applied).toMatchObject({ code: 3, body: { results: [{ kind: "refused" }] } });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
  });

  it("múltipla só pela sugestão aberta do mesmo resultado: o bilhete antigo pode ter jogo em andamento", async () => {
    const legs = { kind: "parlay", legs: [
      { evento: "Flamengo RJ vs Palmeiras SP", mercado: "Moneyline", selecao: "Flamengo RJ" },
      { evento: "Santos SP vs Corinthians SP", mercado: "Moneyline", selecao: "Santos SP" },
    ] };
    const parlay = await settleBet(new Date(NOW.getTime() - 10 * 3_600_000));
    await db.prisma.bet.update({ where: { id: parlay.id }, data: { legsJson: legs } });

    const semSugestao = await planAndApply(parlay.id, "WON");
    expect(semSugestao.plan).toMatchObject({ code: 2, body: { ok: false, refusals: [{ betId: parlay.id, reason: expect.stringContaining("múltipla") }] } });

    await openSuggestion(parlay.id, "LOST");
    expect((await planAndApply(parlay.id, "WON")).plan.code).toBe(2);
    const { applied } = await planAndApply(parlay.id, "LOST");
    expect(applied).toMatchObject({ code: 0, body: { results: [{ betId: parlay.id, kind: "saved", via: "ia-judge" }] } });
  });

  it("falha depois do commit de um item: ele sai como gravado, com aviso, e o lote continua", async () => {
    const first = await settleBet(new Date(NOW.getTime() - 5 * 3_600_000));
    const second = await settleBet(new Date(NOW.getTime() - 5 * 3_600_000));
    const plan = await runJson(["liquidar", "plan", `--executor=${EXECUTOR}`], { items: [first, second].map((bet) => ({ betId: bet.id, newStatus: "WON", evidence: EVIDENCE })) });
    const spy = vi.spyOn(settleEffects, "finishBetStatusChange").mockRejectedValueOnce(new Error("aviso do Telegram fora"));
    try {
      const applied = await runJson(["liquidar", "apply", plan.body!.planHash!, `--executor=${EXECUTOR}`], plan.body);
      expect(applied).toMatchObject({ code: 0, body: { results: [
        { betId: first.id, kind: "saved", via: "recibo", aviso: expect.stringContaining("aviso do Telegram fora") },
        { betId: second.id, kind: "saved", via: "recibo" },
      ] } });
    } finally { spy.mockRestore(); }
    expect(await db.prisma.bet.count({ where: { status: "WON" } })).toBe(2);
    expect(afterWrite).toHaveBeenCalledExactlyOnceWith(
      [{ source: "settlement.parado", key: first.id }, { source: "settlement.parado", key: second.id }], EXECUTOR,
    );
  });

  it("preserva o commit e o orçamento do primeiro item quando outra decisão ocupa a última vaga do lote", async () => {
    const first = await settleBet(new Date(NOW.getTime() - 5 * 3_600_000));
    const second = await settleBet(new Date(NOW.getTime() - 5 * 3_600_000));
    const other = await db.prisma.trainingCase.create({ data: { evento: "Outro caso", esporte: "Soccer" } });
    const plan = await runJson(["liquidar", "plan", `--executor=${EXECUTOR}`], { items: [first, second].map((bet) => ({ betId: bet.id, newStatus: "WON", evidence: EVIDENCE })) });
    await seedWrites(48, new Date(NOW.getTime() - 2 * 3_600_000));
    const realTx = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => {
      const result = await realTx(fn, options);
      expect(await deferTrainingCaseForAgent({ caseId: other.id, executor: EXECUTOR, reason: "Candidato sem evidência suficiente", now: NOW })).toMatchObject({ kind: "saved" });
      return result;
    }) as typeof prisma.$transaction);
    try {
      const result = await runJson(["liquidar", "apply", plan.body!.planHash!, `--executor=${EXECUTOR}`], plan.body);
      expect(result).toMatchObject({ code: 3, body: { results: [{ kind: "saved" }, { kind: "refused", message: expect.stringContaining("Teto de escritas") }] } });
    } finally { spy.mockRestore(); }
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "WON" });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: "PENDING" });
    expect(await db.prisma.manualSettlementReceipt.count()).toBe(1);
    expect((await readWriteBudget(EXECUTOR, NOW)).usadasEm24h).toBe(50);
  });

  it("o lote conta no teto: acima dele não liquida nenhuma", async () => {
    const bet = await settleBet(new Date(NOW.getTime() - 5 * 3_600_000));
    await seedWrites(50, new Date(NOW.getTime() - 3_600_000));

    const { applied } = await planAndApply(bet.id);

    expect(applied?.code).toBe(2);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
  });
});

describe("teto de escritas por dono", () => {
  it("50 escritas nas últimas 24 h: a próxima é recusada sem gravar", async () => {
    const { tcase } = await seedCaseBet();
    await seedWrites(50, new Date(NOW.getTime() - 3 * 3_600_000));
    const { body: plan } = await runJson(["vincular", "plan", tcase.id, "0", hashOf(tcase), "--executor", EXECUTOR, "--evidencia", VINCULAR_EVIDENCE]);

    const result = await runJson(["vincular", "apply", plan!.planHash!, "--executor", EXECUTOR], plan);

    expect(result.code).toBe(2);
    expect(result.body?.erro).toMatch(/Teto de escritas: 50 de 50/);
    expect((await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).status).toBe("OPEN");
    expect((await runJson(["ignorar", tcase.id, "--executor", EXECUTOR, "--motivo", "Nenhum candidato serve aqui"])).code).toBe(2);
  });

  it("10 escritas no último minuto: recusa; as de mais de 24 h e as dos agentes de outro dono não contam", async () => {
    const { tcase } = await seedCaseBet();
    await seedWrites(10, new Date(NOW.getTime() - 20_000));
    const refused = await runJson(["ignorar", tcase.id, "--executor", EXECUTOR, "--motivo", "Nenhum candidato serve aqui"]);
    expect(refused.code).toBe(2);
    expect(refused.body?.erro).toMatch(/10 de 10 no último minuto/);

    await db.prisma.auditEvent.deleteMany();
    await seedWrites(60, new Date(NOW.getTime() - 25 * 3_600_000));
    await seedWrites(60, new Date(NOW.getTime() - 20_000), "agent:claude:por:outro-dono");
    expect((await runJson(["ignorar", tcase.id, "--executor", EXECUTOR, "--motivo", "Nenhum candidato serve aqui"])).code).toBe(0);
  });

  it("o teto é do dono: as escritas de outro agente dele contam", async () => {
    const { tcase } = await seedCaseBet();
    await seedWrites(25, new Date(NOW.getTime() - 3 * 3_600_000));
    await seedWrites(25, new Date(NOW.getTime() - 2 * 3_600_000), "agent:claude:por:fabricio");

    const refused = await runJson(["ignorar", tcase.id, "--executor", EXECUTOR, "--motivo", "Nenhum candidato serve aqui"]);

    expect(refused.code).toBe(2);
    expect(refused.body?.erro).toMatch(/Teto de escritas: 50 de 50/);
  });

  it("o lote do ops-resolve-sport, sem evidência, não gasta o teto do funcionário", async () => {
    const { tcase } = await seedCaseBet();
    await db.prisma.auditEvent.createMany({ data: Array.from({ length: 100 }, (_, i) => ({
      actor: EXECUTOR, action: "bet.sport_resolve.operator", resource: "bet", resourceId: `bet-${i}`, createdAt: new Date(NOW.getTime() - 20_000),
      details: { status: "resolved", reason: "strong_candidate_applied", forced: false, sport: "Soccer" },
    })) });

    expect((await readWriteBudget(EXECUTOR, NOW)).usadasEm24h).toBe(0);
    expect((await runJson(["ignorar", tcase.id, "--executor", EXECUTOR, "--motivo", "Nenhum candidato serve aqui"])).code).toBe(0);
    expect((await readWriteBudget(EXECUTOR, NOW)).usadasEm24h).toBe(1);
  });

  it("decisões de casos independentes disputando a última vaga: só uma faz commit", async () => {
    const tcase = await db.prisma.trainingCase.create({ data: { evento: "Primeiro", esporte: "Soccer" } });
    const other = await db.prisma.trainingCase.create({
      data: { evento: "Fla vs Verdao", esporte: "Soccer", status: "OPEN", autoScore: 10, candidatesJson: [] },
    });
    await seedWrites(49, new Date(NOW.getTime() - 3_600_000));

    const results = await Promise.all([
      runJson(["ignorar", tcase.id, `--executor=${EXECUTOR}`, "--motivo=Nenhum candidato serve aqui"]),
      runJson(["ignorar", other.id, `--executor=${EXECUTOR}`, "--motivo=Nenhum candidato serve aqui"]),
    ]);

    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(results.filter((r) => r.code === 2 || r.code === 3)).toHaveLength(1);
    expect((await readWriteBudget(EXECUTOR, NOW)).usadasEm24h).toBe(50);
    expect(await db.prisma.trainingCase.count({ where: { status: "REJECTED" } })).toBe(1);
  });

  it("três casos independentes na última vaga do minuto: só uma decisão fica gravada", async () => {
    // O teto lê o relógio real: datadas à frente, as nove seguem no último
    // minuto mesmo que a máquina ocupada atrase as três decisões.
    await seedWrites(9, new Date(NOW.getTime() + 600_000));
    const cases = await Promise.all(["Primeiro", "Segundo", "Terceiro"].map((evento) => db.prisma.trainingCase.create({ data: { evento, esporte: "Soccer" } })));
    const results = await Promise.allSettled(cases.map((item) => deferTrainingCaseForAgent({ caseId: item.id, executor: EXECUTOR, reason: "Candidato sem evidência suficiente", now: NOW })));
    expect(results.filter((result) => result.status === "fulfilled" && result.value.kind === "saved")).toHaveLength(1);
    // A perdedora que já estava na transação volta `refused`; a que só começou
    // depois do commit da vencedora (máquina ocupada) é recusada na conferência
    // de antes. As duas formas são recusa, e nada mais é gravado.
    expect(results.filter((result) => result.status === "rejected"
      ? result.reason instanceof RecusaDeNegocioError
      : result.value.kind === "refused")).toHaveLength(2);
    expect((await readWriteBudget(EXECUTOR, NOW)).usadasNoMinuto).toBe(10);
    expect(await db.prisma.trainingCase.count({ where: { status: "REJECTED" } })).toBe(1);
  });

  it("a decisão que chega com a vaga do minuto já gasta é recusada antes da transação", async () => {
    await seedWrites(10, new Date(NOW.getTime() + 600_000));
    const tcase = await db.prisma.trainingCase.create({ data: { evento: "Atrasado", esporte: "Soccer" } });
    await expect(deferTrainingCaseForAgent({ caseId: tcase.id, executor: EXECUTOR, reason: "Candidato sem evidência suficiente", now: NOW }))
      .rejects.toThrow(/10 de 10 no último minuto/);
    expect(await db.prisma.trainingCase.count({ where: { status: "REJECTED" } })).toBe(0);
  });

  it("janelas do orçamento preservam os limites exclusivos e ignoram os agentes de outro dono e outras ações", async () => {
    for (const elapsed of [86_400_000, 86_400_000 - 1, 60_000, 60_000 - 1, 10_000]) {
      await seedWrites(1, new Date(NOW.getTime() - elapsed));
    }
    await seedWrites(60, NOW, "agent:claude:por:outro-dono");
    await db.prisma.auditEvent.create({ data: { actor: EXECUTOR, action: "user.login", createdAt: NOW, details: { evidence: "não é decisão" } } });
    expect(await readWriteBudget(EXECUTOR, NOW)).toEqual({ usadasEm24h: 4, usadasNoMinuto: 2, restamEm24h: 46, restamNoMinuto: 8 });
  });

  it("o resumo do dia conta o que o executor fez hoje", async () => {
    const { tcase } = await seedCaseBet();
    await runJson(["ignorar", tcase.id, "--executor", EXECUTOR, "--motivo", "Nenhum candidato serve aqui"]);
    await seedWrites(2, NOW);

    const { code, body } = await runJson(["resumo", "--executor", EXECUTOR]);

    expect(code).toBe(0);
    expect(body).toMatchObject({
      dia: spDayKey(NOW), executor: EXECUTOR,
      feitas: { vinculados: 0, adiados: 1, esportes: 0, liquidadas: 2 },
      teto: { usadasEm24h: 3 },
    });
  });
});


it("o plano recusa a troca de candidato entre a conferência e a transação", async () => {
  const { bet, tcase } = await seedCaseBet();
  const plan = await buildVincularPlan({ caseId: tcase.id, candidateIndex: 0, candidateHash: hashOf(tcase), executor: EXECUTOR, evidence: "Conferi Flamengo x Palmeiras no catálogo sintético de teste" });
  const read = prisma.trainingCase.findUnique.bind(prisma.trainingCase);
  const spy = vi.spyOn(prisma.trainingCase, "findUnique").mockImplementation((async (args) => {
    const value = await read(args);
    if (args?.select?.status && args.select.candidatesJson && Object.keys(args.select).length === 2) {
      await db.prisma.trainingCase.update({ where: { id: tcase.id }, data: { candidatesJson: [{
        ...plan.candidate, matchId: 999, home: "Santos SP", away: "Corinthians SP",
      }] } });
    }
    return value;
  }) as typeof prisma.trainingCase.findUnique);
  try {
    expect(await applyVincularPlan(plan, plan.planHash, EXECUTOR)).toMatchObject({ kind: "conflict" });
  } finally { spy.mockRestore(); }
  expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ evento: bet.evento });
  expect(await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).toMatchObject({ status: "OPEN" });
  expect(await db.prisma.teamTipsterName.count()).toBe(0);
  expect(await db.prisma.auditEvent.count({ where: { action: "training_case.resolve" } })).toBe(0);
});
