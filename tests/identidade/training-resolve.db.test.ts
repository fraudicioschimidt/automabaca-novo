import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { playerPropRule } from "@/src/domain/settlement/player-prop-rules";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { normalizeStr } from "@/src/domain/text";
import { seedCatalogLink, seedTeamCard } from "../helpers/team-cards";
import { upsertSharp } from "@/src/services/sharp/enrich/upsert-sharp";
import {
  ignorarTrainingCase,
  previewTrainingCaseResolution,
  resolverTrainingCase,
  type CaseCandidate,
} from "@/src/services/sharp/training-resolve";
import {
  recordTrainingCase,
  recordTrainingFailure,
  trainingCaseDueForOwnerWhere,
  dismissOrphanTrainingCases,
  expireStaleTrainingCases,
} from "@/src/services/sharp/enrich/training-cases";

/**
 * Resolução de um caso do Vincular (dono ou agente) contra Postgres real: a
 * aposta passa a carregar os nomes, o país e o campeonato da Pinnacle, e os
 * nomes do tipster entram confirmados nas fichas dos times do jogo escolhido.
 * Adiar rejeita o caso atual, mas mantém a identidade recuperável.
 */

const findEvent = vi.hoisted(() => vi.fn());
vi.mock("@/src/providers/pinnacle17/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/providers/pinnacle17/client")>(),
  findPinnacle17EventById: findEvent,
}));

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  findEvent.mockReset();
  findEvent.mockResolvedValue(null);
});

const CANDIDATO: CaseCandidate = {
  matchId: 777,
  home: "Flamengo RJ",
  away: "Palmeiras SP",
  league: "Brazil - Serie A",
  matchDate: "2026-08-01 16:00:00",
  score: 55,
  swapped: false,
};

async function seedCase(evento = "Fla vs Verdao") {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Banca T", slug: "banca-t", valorUnidade: 100 },
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      data: new Date("2026-08-01T16:00:00Z"),
      evento,
      esporte: "Soccer",
      mercado: "Total",
      selecao: "Under 2.5",
      odds: 1.9,
      stake: 1,
      status: "PENDING",
    },
  });
  const tcase = await db.prisma.trainingCase.create({
    data: {
      betId: bet.id,
      evento,
      esporte: "Soccer",
      pais: "Brazil",
      competicao: "Serie A",
      status: "OPEN",
      candidatesJson: [CANDIDATO],
      autoScore: 55,
    },
  });
  return { bet, tcase };
}

describe("resolverTrainingCase (Postgres real)", () => {
  it("uma revisão legítima da aposta permite novo caso, descartando o snapshot anterior", async () => {
    const { bet, tcase } = await seedCase();
    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });
    const changed = await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: "Outra Casa vs Outro Fora" } });
    await db.prisma.betSharp.update({ where: { betId: bet.id }, data: { identityStatus: "PENDING" } });
    await recordTrainingCase(bet, [], "OPEN", null, "no_results");
    expect(await db.prisma.trainingCase.count({ where: { betId: bet.id, status: "OPEN" } })).toBe(0);
    await recordTrainingCase(changed, [], "OPEN", null, "no_results");
    expect(await db.prisma.trainingCase.findFirstOrThrow({ where: { betId: bet.id, status: "OPEN" } }))
      .toMatchObject({ evento: changed.evento });
  });

  it("resultado externo tardio não cria outro OPEN depois do Vincular", async () => {
    const { bet, tcase } = await seedCase();
    // O worker já leu a aposta e está esperando o provider/juiz.
    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });
    // Agora a busca externa volta, com o snapshot que precedeu a decisão.
    await recordTrainingCase(bet, [], "OPEN", null, "no_results");
    expect(await db.prisma.trainingCase.count({ where: { betId: bet.id, status: "OPEN" } })).toBe(0);
    expect(await db.prisma.trainingCase.count({ where: { ...trainingCaseDueForOwnerWhere(new Date("2026-08-02T12:00:00Z")), betId: bet.id } })).toBe(0);
    expect(await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).toMatchObject({ status: "RESOLVED_MANUAL" });
    expect(await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } })).toMatchObject({ identityStatus: "MANUAL", providerMatchId: "777" });
  });

  it("o jogo escolhido vale para a aposta: nomes, país e campeonato da Pinnacle", async () => {
    const { bet, tcase } = await seedCase();
    await seedCatalogLink(db.prisma, {
      pinnacleEventId: "777", flashscoreMatchId: "fs-777", pinnacleHome: "Flamengo RJ", pinnacleAway: "Palmeiras SP",
      flashscoreHome: "Flamengo", flashscoreAway: "Palmeiras", flashscoreHomeTeamId: "fs-fla", flashscoreAwayTeamId: "fs-pal",
      kickoff: new Date("2026-08-01T16:00:00Z"),
    });
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", pinnacleNames: [{ name: "Flamengo RJ", eventIds: ["777"] }] });
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-pal", flashscoreName: "Palmeiras", pinnacleNames: [{ name: "Palmeiras SP", eventIds: ["777"] }] });

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });
    expect(r.betId).toBe(bet.id);

    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({
      evento: "Flamengo RJ vs Palmeiras SP",
      pais: "Brazil",
      competicao: "Serie A",
      kickoffInferido: false,
    });
    expect(await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } })).toMatchObject({
      identityStatus: "MANUAL", provider: "bridgeodds", providerMatchId: "777",
    });

    const closed = await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } });
    expect(closed).toMatchObject({ status: "RESOLVED_MANUAL", resolution: "MANUAL" });

    const audit = await db.prisma.auditEvent.findMany({ where: { action: "training_case.resolve" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: "operador", resource: "training_case", resourceId: tcase.id });
    expect(audit[0]!.details).toMatchObject({ betId: bet.id, candidateIndex: 0, providerMatchId: "777" });
    // A ficha da aposta mostra quem vinculou e o antes/depois de cada campo.
    const naAposta = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "identidade_vinculada", resource: "bet", resourceId: bet.id } });
    expect(naAposta).toMatchObject({ actor: "operador" });
    expect(naAposta.details).toMatchObject({
      match: "Flamengo RJ vs Palmeiras SP", providerMatchId: "777",
      antes: { evento: "Fla vs Verdao", selecao: "Under 2.5", kickoffInferido: false },
      depois: { evento: "Flamengo RJ vs Palmeiras SP", selecao: "Under 2.5", pais: "Brazil", competicao: "Serie A", kickoffInferido: false },
    });
  });

  it("\"Casa\" com o jogo de mando trocado continua no mesmo time", async () => {
    const { bet, tcase } = await seedCase("Verdao vs Fla");
    await db.prisma.bet.update({ where: { id: bet.id }, data: { mercado: "Asian Handicap", selecao: "Casa -0.5" } });
    await db.prisma.trainingCase.update({ where: { id: tcase.id }, data: { candidatesJson: [{ ...CANDIDATO, swapped: true }] } });

    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });

    // O "Casa" do post era o Verdão; no jogo da Pinnacle ele é o visitante.
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { evento: true, selecao: true } }))
      .toEqual({ evento: "Flamengo RJ vs Palmeiras SP", selecao: "Palmeiras SP -0.5" });
  });

  it("jogo remarcado: o horário gravado é o da Pinnacle17, não o match_date da Bridge", async () => {
    const { bet, tcase } = await seedCase();
    // A Bridge guarda o horário da primeira listagem; a Pinnacle17 adiou o jogo 27 h.
    findEvent.mockResolvedValue({ startTime: "2026-08-02T19:00:00.000Z" });

    const preview = await previewTrainingCaseResolution({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });
    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });

    expect(findEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: "777" }));
    expect(preview.plano.kickoff?.toISOString()).toBe("2026-08-02T19:00:00.000Z");
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { data: true, kickoffInferido: true } }))
      .toEqual({ data: new Date("2026-08-02T19:00:00.000Z"), kickoffInferido: false });
  });

  it("vincular limpa o motivo da identidade anterior", async () => {
    const { bet, tcase } = await seedCase();
    await db.prisma.betSharp.create({ data: {
      betId: bet.id, identityStatus: "UNMATCHED", noOddsReason: "identidade_nao_casada",
    } });

    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });

    expect(await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } })).toMatchObject({
      identityStatus: "MANUAL", provider: "bridgeodds", providerMatchId: "777", noOddsReason: null, priceReference: null,
    });
  });

  it("placar exato com o jogo de mando trocado mantém o evento na ordem do post", async () => {
    const { bet, tcase } = await seedCase("Verdao vs Fla");
    await db.prisma.bet.update({ where: { id: bet.id }, data: { mercado: "Correct Score", selecao: "2-1" } });
    await db.prisma.trainingCase.update({ where: { id: tcase.id }, data: { candidatesJson: [{ ...CANDIDATO, swapped: true }] } });

    const preview = await previewTrainingCaseResolution({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });
    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });

    // O 2 do placar é do Verdão, que na Pinnacle é o visitante.
    expect(preview.eventoDepois).toBe("Palmeiras SP vs Flamengo RJ");
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { evento: true, selecao: true } }))
      .toEqual({ evento: "Palmeiras SP vs Flamengo RJ", selecao: "2-1" });
  });

  it("aposta aberta perde a observação do FlashScore feita com o nome antigo", async () => {
    const aberta = await seedCase();
    await db.prisma.betResult.create({ data: { betId: aberta.bet.id, resultProvider: "flashscore", resultMatchId: "fs-antigo" } });

    await resolverTrainingCase({ caseId: aberta.tcase.id, candidateIndex: 0, actor: "operador" });

    expect(await db.prisma.betResult.count({ where: { betId: aberta.bet.id } })).toBe(0);
  });

  it("a observação final de uma partida não sobrevive ao novo vínculo de uma aposta pendente", async () => {
    const { bet, tcase } = await seedCase();
    await db.prisma.betResult.create({ data: { betId: bet.id, resultProvider: "flashscore", resultMatchId: "fs-antigo",
      resultFinal: true, scoreHome: 3, scoreAway: 0, resultSnapshot: { placar: "3-0" }, resultCheckedAt: new Date() } });
    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });
    expect(await db.prisma.betResult.findUnique({ where: { betId: bet.id } })).toBeNull();
  });

  it.each(["PENDING", "WON"] as const)("o novo vínculo só invalida a evidência da prop pendente (status %s)", async (status) => {
    const { bet, tcase } = await seedCase();
    const propBet = await db.prisma.bet.update({ where: { id: bet.id }, data: { mercado: "Player Shots", selecao: "Jogador Over 1.5", casaDeAposta: "Bet365", status, lucro: status === "WON" ? 0.9 : 0, settledAt: status === "WON" ? new Date() : null } });
    const terms = buildPlayerPropTerms(propBet)!;
    const rule = playerPropRule("Bet365", terms.family);
    const identity = await db.prisma.playerIdentity.create({ data: { canonicalName: "Jogador", sport: "Soccer", providerPlayerId: "jogador-antigo" } });
    await db.prisma.betPlayerProp.create({ data: { betId: bet.id, terms, rule,
      playerIdentityId: identity.id, providerMatchId: "fs-antigo", resolutionStatus: "MATCHED", evidence: { stable: true, proposedStatus: "WON" } } });
    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });
    expect(await db.prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: bet.id } })).toMatchObject({
      ...(status === "PENDING"
        ? { revision: 2, playerIdentityId: null, providerMatchId: null, resolutionStatus: "PENDING", evidence: null }
        : { revision: 1, playerIdentityId: identity.id, providerMatchId: "fs-antigo", resolutionStatus: "MATCHED", evidence: { stable: true, proposedStatus: "WON" } }),
      terms, rule,
    });
  });

  it("a seleção que nomeia o time do tipster passa a nomear o da Pinnacle", async () => {
    const { bet, tcase } = await seedCase();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { mercado: "Asian Handicap", selecao: "Verdao +0.5" } });

    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });

    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { selecao: true } }))
      .toEqual({ selecao: "Palmeiras SP +0.5" });
  });

  it("aposta já liquidada ganha os nomes, mas não troca o horário que a liquidou", async () => {
    const { bet, tcase } = await seedCase();
    const liquidadaEm = new Date("2026-08-01T15:00:00Z");
    await db.prisma.bet.update({ where: { id: bet.id }, data: { status: "WON", lucro: 0.9, settledAt: new Date(), data: liquidadaEm } });
    const observation = await db.prisma.betResult.create({ data: { betId: bet.id, resultProvider: "flashscore", resultMatchId: "fs-conferido", resultFinal: true, scoreHome: 3, scoreAway: 0 } });

    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });

    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { evento: true, data: true } }))
      .toEqual({ evento: "Flamengo RJ vs Palmeiras SP", data: liquidadaEm });
    expect(await db.prisma.betResult.findUnique({ where: { betId: bet.id } })).toEqual(observation);
  });

  it("candidato inexistente lança erro acionável (não fecha o caso)", async () => {
    const { tcase } = await seedCase();
    await expect(
      resolverTrainingCase({ caseId: tcase.id, candidateIndex: 9, actor: "operador" }),
    ).rejects.toThrow(/Candidato 9 inválido/);
    const still = await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } });
    expect(still.status).toBe("OPEN");
  });
});

/** O lado bem casado no jogo 777: a evidência do evento na ficha. */
const IN_777 = (name: string) => [{ name, eventIds: ["777"] }];
/** A chave da liga do candidato ("Brazil - Serie A"), como o pareamento grava. */
const SERIE_A = `${normalizeStr("Brazil")}|${normalizeStr("Brazil - Serie A")}`;

describe("o Vincular ensina o nome do tipster (Postgres real)", () => {
  const KICKOFF = new Date("2026-08-01T16:00:00Z");
  const linkFor777 = (extra: Partial<Parameters<typeof seedCatalogLink>[1]> = {}) => seedCatalogLink(db.prisma, {
    pinnacleEventId: "777", flashscoreMatchId: "fs-777", pinnacleHome: "Flamengo RJ", pinnacleAway: "Palmeiras SP",
    flashscoreHome: "Flamengo", flashscoreAway: "Palmeiras", flashscoreHomeTeamId: "fs-fla", flashscoreAwayTeamId: "fs-pal",
    kickoff: KICKOFF, ...extra,
  });
  const names = () => db.prisma.teamTipsterName.findMany({
    orderBy: { name: "asc" },
    select: { cardId: true, name: true, status: true, decidedBy: true, confirmedByBetId: true },
  });

  it("com a ligação do jogo, os dois nomes entram confirmados nas fichas, com quem decidiu", async () => {
    const { bet, tcase } = await seedCase();
    await linkFor777();
    const fla = await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil", pinnacleNames: IN_777("Flamengo RJ") });
    const pal = await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-pal", flashscoreName: "Palmeiras", country: "Brazil", pinnacleNames: IN_777("Palmeiras SP") });

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(r.nomes.map((n) => [n.lado, n.nome, n.resultado, n.cardId])).toEqual([
      ["casa", "Fla", "ensinado", fla], ["fora", "Verdao", "ensinado", pal],
    ]);
    expect(await names()).toEqual([
      { cardId: fla, name: "Fla", status: "confirmed", decidedBy: "fabricio", confirmedByBetId: bet.id },
      { cardId: pal, name: "Verdao", status: "confirmed", decidedBy: "fabricio", confirmedByBetId: bet.id },
    ]);
    expect(await db.prisma.auditEvent.count({ where: { action: "team_tipster_name.choice", actor: "fabricio" } })).toBe(2);
  });

  it("a ligação invertida em relação ao jogo escolhido leva cada nome à ficha certa", async () => {
    const { tcase } = await seedCase();
    // Na ligação, o Palmeiras é o mandante da Pinnacle17 (e o visitante do FlashScore).
    await linkFor777({
      pinnacleHome: "Palmeiras SP", pinnacleAway: "Flamengo RJ", swapped: true,
      flashscoreHome: "Flamengo", flashscoreAway: "Palmeiras", flashscoreHomeTeamId: "fs-fla", flashscoreAwayTeamId: "fs-pal",
    });
    const fla = await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil", pinnacleNames: IN_777("Flamengo RJ") });
    const pal = await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-pal", flashscoreName: "Palmeiras", country: "Brazil", pinnacleNames: IN_777("Palmeiras SP") });

    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect((await names()).map((n) => [n.name, n.cardId])).toEqual([["Fla", fla], ["Verdao", pal]]);
  });

  it("sem ligação, a ficha vem do nome da Pinnacle do candidato, com um jogo só", async () => {
    const { tcase } = await seedCase();
    const fla = await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil",
      pinnacleNames: [{ name: "Flamengo RJ", games: 1, leagueKey: SERIE_A }],
    });

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(r.nomes.map((n) => [n.nome, n.resultado])).toEqual([["Fla", "ensinado"], ["Verdao", "sem_ficha"]]);
    expect(r.nomes[1]!.mensagem).toBe("sem ficha para ensinar");
    expect((await names()).map((n) => [n.name, n.cardId, n.status])).toEqual([["Fla", fla, "confirmed"]]);
  });

  it("com a ligação, só o lado bem casado naquele jogo tem ficha: sem evidência do evento é sem ficha", async () => {
    const { tcase } = await seedCase();
    await linkFor777();
    // As fichas existem, mas o pareamento não casou os lados neste jogo (amistoso, lado fraco).
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil", pinnacleNames: [{ name: "Flamengo RJ", games: 2 }] });
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-pal", flashscoreName: "Palmeiras", country: "Brazil" });

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(r.nomes.map((n) => n.resultado)).toEqual(["sem_ficha", "sem_ficha"]);
    expect(await db.prisma.teamTipsterName.count()).toBe(0);
  });

  it("com a ligação, a evidência do jogo noutra categoria que a da ficha não ensina", async () => {
    const { tcase } = await seedCase();
    await linkFor777();
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil",
      pinnacleNames: [{ name: "Flamengo RJ", eventIds: ["777"], category: "reserva" }],
    });

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(r.nomes[0]).toMatchObject({ nome: "Fla", resultado: "categoria" });
    expect(await db.prisma.teamTipsterName.count()).toBe(0);
  });

  it("o nome entra no esporte da ficha, não no do caso", async () => {
    const { tcase } = await seedCase();
    await db.prisma.trainingCase.update({ where: { id: tcase.id }, data: { esporte: "Futsal" } });
    await linkFor777();
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil", pinnacleNames: IN_777("Flamengo RJ") });

    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(await db.prisma.teamTipsterName.findFirstOrThrow({ select: { name: true, sport: true } }))
      .toEqual({ name: "Fla", sport: "Soccer" });
  });

  it("sem ligação, a ficha só vista noutra liga não ensina", async () => {
    const { tcase } = await seedCase();
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil",
      pinnacleNames: [{ name: "Flamengo RJ", games: 1, leagueKey: `${normalizeStr("Brazil")}|${normalizeStr("Brazil - Copa do Brasil")}` }],
    });

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(r.nomes[0]).toMatchObject({ nome: "Fla", resultado: "sem_ficha" });
    expect(await db.prisma.teamTipsterName.count()).toBe(0);
  });

  it("o mesmo nome confirmado ao mesmo tempo noutra ficha: vira conflito e o vínculo fica", async () => {
    const { bet, tcase } = await seedCase();
    await linkFor777();
    const fla = await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil", pinnacleNames: IN_777("Flamengo RJ") });
    const outra = await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-flu", flashscoreName: "Fluminense", country: "Brazil" });
    let inserted!: () => void;
    let release!: () => void;
    const insertedSignal = new Promise<void>((resolve) => { inserted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Outra transação grava "Fla" confirmado na outra ficha e segura o commit.
    const concurrent = db.prisma.$transaction(async (tx) => {
      await tx.teamTipsterName.create({
        data: {
          cardId: outra, sport: "Soccer", country: "Brazil", category: "principal", name: "Fla", nameNorm: "fla",
          status: "confirmed", firstBetId: "outra", firstPinnacleEventId: "ev-outro", firstDay: "2026-08-01",
        },
      });
      inserted();
      await gate;
    }, { timeout: 20_000 });
    await insertedSignal;

    const resolving = resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    release();
    await concurrent;
    const r = await resolving;

    expect(r.nomes[0]).toMatchObject({ nome: "Fla", resultado: "nome_de_outra_ficha" });
    expect(await db.prisma.teamTipsterName.count({ where: { cardId: fla } })).toBe(0);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).evento).toBe("Flamengo RJ vs Palmeiras SP");
    expect((await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).status).toBe("RESOLVED_MANUAL");
  });

  it("sem ficha nenhuma, a aposta fica vinculada do mesmo jeito", async () => {
    const { bet, tcase } = await seedCase();

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(r.nomes.map((n) => n.resultado)).toEqual(["sem_ficha", "sem_ficha"]);
    expect(await db.prisma.teamTipsterName.count()).toBe(0);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).evento).toBe("Flamengo RJ vs Palmeiras SP");
    expect((await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).status).toBe("RESOLVED_MANUAL");
  });

  it("sem ligação, o nome da Pinnacle em duas fichas do contexto não ensina", async () => {
    const { tcase } = await seedCase();
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil", pinnacleNames: [{ name: "Flamengo RJ", games: 1, leagueKey: SERIE_A }] });
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla-2", flashscoreName: "Flamengo SP", country: "Brazil", pinnacleNames: [{ name: "Flamengo RJ", games: 1 }] });

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(r.nomes[0]!.resultado).toBe("ficha_ambigua");
    expect(await db.prisma.teamTipsterName.count()).toBe(0);
  });

  it("o nome confirmado de outra ficha não é tomado: fica auditado e vai no resultado", async () => {
    const { tcase } = await seedCase();
    await linkFor777();
    const fla = await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil", pinnacleNames: IN_777("Flamengo RJ") });
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-pal", flashscoreName: "Palmeiras", country: "Brazil", pinnacleNames: IN_777("Palmeiras SP") });
    const outra = await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-fla-outro", flashscoreName: "Fluminense", country: "Brazil", tipsterNames: [{ name: "Fla" }],
    });

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(r.nomes[0]).toMatchObject({ nome: "Fla", resultado: "nome_de_outra_ficha", mensagem: "nome já é de outra ficha: não ensinado" });
    expect(await db.prisma.teamTipsterName.count({ where: { cardId: fla } })).toBe(0);
    expect(await db.prisma.teamTipsterName.findFirstOrThrow({ where: { cardId: outra } })).toMatchObject({ name: "Fla", status: "confirmed" });
    const conflict = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "team_tipster_name.conflict" } });
    expect(conflict).toMatchObject({ actor: "fabricio", resourceId: fla });
    expect(conflict.details).toMatchObject({ name: "Fla", confirmedCardId: outra, via: "vincular" });
  });

  it("o nome pendente da mesma ficha vira confirmado; o já confirmado fica como está", async () => {
    const { tcase } = await seedCase();
    await linkFor777();
    const fla = await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil", pinnacleNames: IN_777("Flamengo RJ"),
      tipsterNames: [{ name: "Fla", status: "pending" }],
    });
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-pal", flashscoreName: "Palmeiras", country: "Brazil", pinnacleNames: IN_777("Palmeiras SP"),
      tipsterNames: [{ name: "Verdao" }],
    });

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "agent:gemini:por:fabricio" });

    expect(r.nomes.map((n) => n.resultado)).toEqual(["ensinado", "ja_confirmado"]);
    expect(await db.prisma.teamTipsterName.findFirstOrThrow({ where: { cardId: fla } }))
      .toMatchObject({ status: "confirmed", decidedBy: "agent:gemini:por:fabricio" });
  });

  it("nome genérico sem país e competição não é ensinado", async () => {
    const { tcase } = await seedCase("Estudiantes vs Verdao");
    await db.prisma.trainingCase.update({
      where: { id: tcase.id },
      data: { candidatesJson: [{ ...CANDIDATO, home: "Club Atletico Avellaneda", league: "Serie A" }] },
    });
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-rac", flashscoreName: "Racing Club", pinnacleNames: [{ name: "Club Atletico Avellaneda", games: 1, leagueKey: `|${normalizeStr("Serie A")}` }],
    });

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(r.nomes[0]).toMatchObject({ nome: "Estudiantes", resultado: "nome_generico" });
    expect(await db.prisma.teamTipsterName.count()).toBe(0);
  });

  it("categoria diferente da ficha não é ensinada", async () => {
    const { tcase } = await seedCase("Fla Sub-20 vs Verdao");
    await linkFor777();
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil", pinnacleNames: IN_777("Flamengo RJ") });

    const r = await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(r.nomes[0]).toMatchObject({ nome: "Fla Sub-20", resultado: "categoria" });
  });

  it("o agente vincula com a evidência na trilha e na resolução do caso", async () => {
    const { tcase } = await seedCase();
    const actor = "agent:gemini:por:fabricio";

    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor, evidence: "Mesmo horário e liga na Pinnacle" });

    expect((await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).resolutionEvidence)
      .toMatchObject({ source: "agent", evidence: "Mesmo horário e liga na Pinnacle" });
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "training_case.resolve" } });
    expect(audit).toMatchObject({ actor });
    expect(audit.details).toMatchObject({ evidence: "Mesmo horário e liga na Pinnacle" });
  });

  it("a prévia diz o que ensinaria sem gravar nada", async () => {
    const { bet, tcase } = await seedCase();
    await linkFor777();
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", country: "Brazil", pinnacleNames: IN_777("Flamengo RJ") });

    const preview = await previewTrainingCaseResolution({ caseId: tcase.id, candidateIndex: 0, actor: "fabricio" });

    expect(preview.nomes.map((n) => n.resultado)).toEqual(["ensinado", "sem_ficha"]);
    expect(preview.plano.providerMatchId).toBe("777");
    expect(await db.prisma.teamTipsterName.count()).toBe(0);
    expect(await db.prisma.auditEvent.count()).toBe(0);
    expect((await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).status).toBe("OPEN");
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).evento).toBe("Fla vs Verdao");
  });
});

describe("ignorarTrainingCase (Postgres real)", () => {
  it("fecha o caso por 2h e mantém a identidade PENDING", async () => {
    const { bet, tcase } = await seedCase();
    await db.prisma.betSharp.create({
      data: { betId: bet.id, identityStatus: "PENDING", confidence: 0 },
    });

    await ignorarTrainingCase(tcase.id, "operador");

    const closed = await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } });
    expect(closed.status).toBe("REJECTED");
    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp.identityStatus).toBe("PENDING");
    expect(sharp.identityResolvedAt).toBeNull();
    const cooldown = await db.prisma.iaJudgeCooldown.findUniqueOrThrow({
      where: { key: `training-review:${bet.id}` },
    });
    expect(cooldown.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // O adiamento é decisão do operador: fica na trilha com quem decidiu.
    expect(await db.prisma.auditEvent.findMany({
      where: { action: "training_case.defer", resourceId: tcase.id },
      select: { actor: true, resource: true },
    })).toEqual([{ actor: "operador", resource: "training_case" }]);
  });

  it("guard OPEN: resolver/ignorar um caso já fechado lança erro", async () => {
    const { tcase } = await seedCase();
    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" }); // → RESOLVED_MANUAL
    await expect(
      resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" }),
    ).rejects.toThrow(/não está aberto/);
    await expect(ignorarTrainingCase(tcase.id, "operador")).rejects.toThrow(/não está aberto/);
  });
});

describe("expireStaleTrainingCases (Postgres real)", () => {
  it("expira casos OPEN de jogos passados (>3d), mantém os recentes", async () => {
    const { tcase: antigo } = await seedCase(); // kickoff 2026-08-01
    const bankroll = await db.prisma.bankroll.findFirstOrThrow();
    const betRecente = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date("2026-08-09T16:00:00Z"),
        evento: "X vs Y",
        esporte: "Soccer",
        mercado: "Total",
        selecao: "Over 1.5",
        odds: 1.9,
        stake: 1,
        status: "PENDING",
      },
    });
    const recente = await db.prisma.trainingCase.create({
      data: {
        betId: betRecente.id,
        evento: "X vs Y",
        esporte: "Soccer",
        pais: "Brazil",
        competicao: "Serie A",
        status: "OPEN",
        candidatesJson: [],
        autoScore: 0,
      },
    });

    // "Agora" = 2026-08-10 → cutoff 08-07: antigo (08-01) expira, recente (08-09) fica.
    const n = await expireStaleTrainingCases(new Date("2026-08-10T00:00:00Z"));
    expect(n).toBe(1);
    expect(
      (await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: antigo.id } })).status,
    ).toBe("EXPIRED");
    expect(
      (await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: recente.id } })).status,
    ).toBe("OPEN");
  });
});

describe("dismissOrphanTrainingCases (Postgres real)", () => {
  it("expira OPEN cujo bet tem deletedAt e grava audit", async () => {
    const { bet, tcase } = await seedCase();
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { deletedAt: new Date(), status: "CANCELED", settledAt: new Date() },
    });

    const n = await dismissOrphanTrainingCases({ actor: "test" });
    expect(n).toBe(1);
    expect(
      (await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).status,
    ).toBe("EXPIRED");
    expect(
      await db.prisma.auditEvent.count({
        where: { action: "training_case.bet_deleted_dismiss", resourceId: tcase.id },
      }),
    ).toBe(1);
  });
});

describe("resolverTrainingCase e identidade MANUAL (Postgres real)", () => {
  it("atualiza BetSharp para MANUAL e upsertSharp MATCHED preserva MANUAL", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Manual Sharp Bank", slug: "manual-sharp-bank" },
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
        odds: 2.0,
        stake: 1.0,
        status: "PENDING",
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        data: new Date(),
        registradoEm: new Date(),
      },
    });
    await db.prisma.betSharp.create({
      data: {
        betId: bet.id,
        identityStatus: "UNMATCHED",
        confidence: 0,
      },
    });

    const tcase = await db.prisma.trainingCase.create({
      data: {
        betId: bet.id,
        evento: "Santos vs Sao Paulo",
        esporte: "Soccer",
        pais: "Brasil",
        competicao: "Paulista",
        status: "OPEN",
        candidatesJson: [
          {
            home: "Santos FC",
            away: "Sao Paulo FC",
            score: 95,
            matchId: "pin-santos-1",
            matchDate: "2026-08-31T20:00:00Z",
            league: "Brazil - Paulista",
          },
        ],
        autoScore: 60,
      },
    });

    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });

    const sharpAfterManual = await db.prisma.betSharp.findUniqueOrThrow({
      where: { betId: bet.id },
    });
    expect(sharpAfterManual.identityStatus).toBe("MANUAL");
    expect(sharpAfterManual.providerMatchId).toBe("pin-santos-1");

    // Upsert posterior com MATCHED deve preservar identityStatus MANUAL
    await upsertSharp(bet.id, {
      identityStatus: "MATCHED",
      confidence: 100,
      provider: "bridgeodds",
      providerMatchId: "pin-santos-1",
      noOddsReason: "sem_referencia_sharp",
    }, db.prisma);

    const sharpAfterEnrich = await db.prisma.betSharp.findUniqueOrThrow({
      where: { betId: bet.id },
    });
    expect(sharpAfterEnrich.identityStatus).toBe("MANUAL");
    expect(sharpAfterEnrich.noOddsReason).toBe("sem_referencia_sharp");
  });
});

describe("ignorarTrainingCase com identidade casada (Postgres real)", () => {
  it("preserva betSharp MATCHED e reseta apenas PENDING/UNMATCHED", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Training Ignore Bank", slug: "training-ignore-bank" },
    });
    const betMatched = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        evento: "Chelsea vs Liverpool",
        esporte: "Soccer",
        competicao: "Premier League",
        pais: "Inglaterra",
        mercado: "Match Odds",
        selecao: "Chelsea",
        odds: 2.50,
        stake: 1.0,
        status: "PENDING",
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        data: new Date(),
        registradoEm: new Date(),
      },
    });
    await db.prisma.betSharp.create({
      data: {
        betId: betMatched.id,
        identityStatus: "MATCHED",
        provider: "bridgeodds",
        providerMatchId: "pm-chelsea-1",
        confidence: 100,
        identityResolvedAt: new Date(),
      },
    });
    const tcaseMatched = await db.prisma.trainingCase.create({
      data: {
        betId: betMatched.id,
        evento: "Chelsea vs Liverpool",
        esporte: "Soccer",
        pais: "Inglaterra",
        competicao: "Premier League",
        status: "OPEN",
        candidatesJson: [],
        autoScore: 70,
      },
    });

    await ignorarTrainingCase(tcaseMatched.id, "operador");

    const sharpAfter = await db.prisma.betSharp.findUniqueOrThrow({
      where: { betId: betMatched.id },
    });
    expect(sharpAfter.identityStatus).toBe("MATCHED");
    expect(sharpAfter.providerMatchId).toBe("pm-chelsea-1");
  });
});


describe("resolução preserva a escolha e a entrada ao vivo", () => {
  it("mantém o placar imutável ligado ao time original quando o mando muda", async () => {
    const { bet, tcase } = await seedCase("Flamengo vs Palmeiras");
    await db.prisma.bet.update({ where: { id: bet.id }, data: {
      mercado: "Asian Handicap", selecao: "Flamengo -0.5", liveScoreHome: 1, liveScoreAway: 0,
    } });
    const candidate = { ...CANDIDATO, home: "Palmeiras SP", away: "Flamengo RJ", swapped: true };
    await db.prisma.trainingCase.update({ where: { id: tcase.id }, data: { candidatesJson: [candidate] } });
    const preview = await previewTrainingCaseResolution({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });
    expect(preview.eventoDepois).toBe("Flamengo RJ vs Palmeiras SP");
    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador", expectedCandidateHash: canonicalSha256(candidate) });
    const saved = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(saved).toMatchObject({ evento: preview.eventoDepois, selecao: "Flamengo RJ -0.5", liveScoreHome: 1, liveScoreAway: 0 });
    expect(resolveResultFromScore({
      ...saved, odds: Number(saved.odds), stake: Number(saved.stake), homeScore: 2, awayScore: 1,
    })).toMatchObject({ ok: true, status: "LOST", lucro: -1 });
  });

  it("recusa o candidato atualizado desde que a opção foi exibida", async () => {
    const { bet, tcase } = await seedCase();
    await db.prisma.trainingCase.update({ where: { id: tcase.id }, data: { candidatesJson: [{ ...CANDIDATO, matchId: 888 }] } });
    await expect(resolverTrainingCase({
      caseId: tcase.id, candidateIndex: 0, actor: "operador", expectedCandidateHash: canonicalSha256(CANDIDATO),
    })).rejects.toThrow(/candidatos.*mudaram/);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ evento: bet.evento });
    expect(await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } })).toMatchObject({ status: "OPEN" });
    expect(await db.prisma.auditEvent.count()).toBe(0);
  });

  it.each(["case", "failure"] as const)("a escrita antiga (%s) preserva o caso e o diagnóstico depois da decisão manual", async (write) => {
    const { bet, tcase } = await seedCase();
    await resolverTrainingCase({ caseId: tcase.id, candidateIndex: 0, actor: "operador" });
    if (write === "case") await recordTrainingCase(bet, [], "OPEN", null);
    else await recordTrainingFailure(bet, "past_event:no_results");
    expect(await db.prisma.trainingCase.count({ where: { betId: bet.id, status: "OPEN" } })).toBe(0);
    const saved = await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } });
    expect(saved).toMatchObject({ status: "RESOLVED_MANUAL", resolution: "MANUAL" });
    expect(saved.resolvedAt).not.toBeNull();
    expect(saved.llmVerdictJson).toBeNull();
  });
});
