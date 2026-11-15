import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTeamCard } from "../helpers/team-cards";
import { resetEnvCacheForTests } from "@/src/infra/env";
import type { FlashscoreMatch } from "@/src/providers/flashscore/types";
import {
  persistFlashscoreObservation,
  listFlashscoreEligibleBets,
} from "@/src/services/settlement/flashscore/observation-store";
import { observeFlashscoreTicketBet } from "@/src/services/settlement/flashscore/ticket";
import { settleFromFlashscoreScore } from "@/src/services/settlement/flashscore/score-settle";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";

/**
 * Cadência da observação: o FlashScore só liquida se olhar o jogo DEPOIS que
 * ele acaba. A primeira olhada acontece 90min após o kickoff — com o jogo quase
 * sempre ainda rolando — então o intervalo até a segunda decide a latência da
 * liquidação. Evento já casado usa retry atento; evento ainda não localizado
 * usa ritmo econômico para preservar a cota do próprio FlashScore.
 */

let db: TestDb;
const NOW = new Date("2026-07-26T02:00:00Z");
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

/** Aposta PENDENTE já observada uma vez, sem resultado final. */
async function apostaObservada(params: {
  evento: string;
  kickoffHorasAtras: number;
  olhadaMinutosAtras: number;
  /** false = evento não encontrado no catálogo (nome divergente). */
  casou?: boolean;
}): Promise<string> {
  const banca = await db.prisma.bankroll.upsert({
    where: { slug: "obs" },
    create: { nome: "Obs", slug: "obs" },
    update: {},
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: banca.id,
      data: new Date(NOW.getTime() - params.kickoffHorasAtras * 3_600_000),
      evento: params.evento,
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Casa",
      odds: 2,
      stake: 1,
      status: "PENDING",
      sportResolutionStatus: "CONFIRMED",
      kickoffInferido: false,
    },
  });
  await db.prisma.betResult.create({
    data: {
      betId: bet.id,
      resultFinal: false,
      resultCheckedAt: new Date(NOW.getTime() - params.olhadaMinutosAtras * 60_000),
      // `resultMatchId` = o FlashScore ACHOU o evento no catálogo e falta só o
      // placar final. É o que decide o ritmo.
      ...(params.casou === false ? {} : { resultMatchId: "fs-match-1" }),
    },
  });
  return bet.id;
}

describe("conferência das liquidações do IA-Judge", () => {
  async function settledByIa(
    evento: string,
    opts: { approvedDaysAgo?: number; suggestion?: boolean; correctedBy?: string } = {},
  ) {
    const betId = await apostaObservada({ evento, kickoffHorasAtras: 30, olhadaMinutosAtras: 11 });
    await db.prisma.bet.update({ where: { id: betId }, data: { status: "WON", lucro: 1, settledAt: NOW } });
    const statusChanged = (source: string, to: string, minutesAgo: number) => db.prisma.settlementEvent.create({
      data: {
        betId, type: "STATUS_CHANGED", payload: { from: "PENDING", to, source },
        payloadHash: `${betId}-${source}-${to}`, createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
      },
    });
    await statusChanged(opts.suggestion === false ? "manual:fabricio" : "ia-judge:ia_judge_auto", "WON", 60);
    if (opts.correctedBy) await statusChanged(opts.correctedBy, "LOST", 30);
    if (opts.suggestion !== false) {
      await db.prisma.iaJudgeSuggestion.create({
        data: {
          betId, suggestedStatus: "WON", valueFound: "2-1", confidence: 1, reason: "busca",
          provider: "gemini", status: "APPROVED", evidenceKind: "GROUNDED_WEB", resolvedBy: "ia_judge_auto",
          resolvedAt: new Date(NOW.getTime() - (opts.approvedDaysAgo ?? 1) * 86_400_000),
        },
      });
    }
    return betId;
  }

  it("aposta liquidada pela IA na última semana continua sendo observada", async () => {
    const recente = await settledByIa("IA recente vs Rival");
    const antiga = await settledByIa("IA antiga vs Rival", { approvedDaysAgo: 8 });
    const manual = await settledByIa("Manual vs Rival", { suggestion: false });
    const corrigida = await settledByIa("Corrigida vs Rival", { correctedBy: "manual:fabricio" });

    const ids = (await listFlashscoreEligibleBets({ now: NOW })).map((b) => b.id);
    // O dono corrigiu depois da IA: a decisão já é dele, não há o que conferir.
    expect(ids).not.toContain(corrigida);

    expect(ids).toContain(recente);
    expect(ids).not.toContain(antiga);
    expect(ids).not.toContain(manual);
  });

  it("um lote inteiro de correções do dono não tira a pendente do ciclo", async () => {
    // 250 liquidações da IA corrigidas pelo dono, com jogo anterior ao da
    // pendente: o limite do lote precisa contar só quem ainda é conferido.
    const banca = await db.prisma.bankroll.upsert({
      where: { slug: "obs" },
      create: { nome: "Obs", slug: "obs" },
      update: {},
    });
    const corrigidas = Array.from({ length: 250 }, (_, i) => `corrigida-${String(i).padStart(3, "0")}`);
    const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
    await db.prisma.bet.createMany({
      data: corrigidas.map((id, i) => ({
        id, bankrollId: banca.id, data: minutesAgo(30 * 60), evento: `Corrigida ${i} vs Rival`,
        esporte: "Soccer", mercado: "Moneyline", selecao: "Casa", odds: 2, stake: 1,
        status: "LOST" as const, lucro: -1, settledAt: NOW, sportResolvedAt: NOW,
        sportResolutionStatus: "CONFIRMED" as const, kickoffInferido: false,
      })),
    });
    await db.prisma.betResult.createMany({
      data: corrigidas.map((betId) => ({
        betId, resultFinal: false, resultCheckedAt: minutesAgo(11), resultMatchId: "fs-match-1",
      })),
    });
    await db.prisma.settlementEvent.createMany({
      data: corrigidas.flatMap((betId) => [
        { betId, type: "STATUS_CHANGED", payload: { from: "PENDING", to: "WON", source: "ia-judge:ia_judge_auto" },
          payloadHash: `${betId}-ia`, createdAt: minutesAgo(60) },
        { betId, type: "STATUS_CHANGED", payload: { from: "WON", to: "LOST", source: "manual:fabricio" },
          payloadHash: `${betId}-manual`, createdAt: minutesAgo(30) },
      ]),
    });
    await db.prisma.iaJudgeSuggestion.createMany({
      data: corrigidas.map((betId) => ({
        betId, suggestedStatus: "WON" as const, valueFound: "2-1", confidence: 1, reason: "busca",
        provider: "gemini", status: "APPROVED" as const, evidenceKind: "GROUNDED_WEB" as const,
        resolvedBy: "ia_judge_auto", resolvedAt: minutesAgo(24 * 60),
      })),
    });
    const pendente = await apostaObservada({ evento: "Pendente vs Rival", kickoffHorasAtras: 3, olhadaMinutosAtras: 11 });

    const ids = (await listFlashscoreEligibleBets({ now: NOW })).map((b) => b.id);
    expect(ids).toContain(pendente);
    expect(ids.filter((id) => corrigidas.includes(id))).toEqual([]);
  });
});

describe("cadência da observação FlashScore", () => {
  it("evento casado volta em 10min, e não antes disso", async () => {
    const jogoRecente = 2;
    const olhadaFresca = await apostaObservada({
      evento: "Olhado ha 9min vs Rival",
      kickoffHorasAtras: jogoRecente,
      olhadaMinutosAtras: 9,
    });
    const olhadaVencida = await apostaObservada({
      evento: "Olhado ha 11min vs Rival",
      kickoffHorasAtras: jogoRecente,
      olhadaMinutosAtras: 11,
    });

    const elegiveis = await listFlashscoreEligibleBets({
      now: NOW,
    });
    const ids = elegiveis.map((b) => b.id);
    expect(ids).toContain(olhadaVencida);
    expect(ids).not.toContain(olhadaFresca);
  });

  it("evento casado mantém retry atento mesmo várias horas após o kickoff", async () => {
    // Quem já casou o evento está a um placar de resolver. A idade do jogo não
    // reduz a cadência enquanto o FlashScore ainda é a fonte de resultado.
    const foraDaJanela = 4;
    const casadoOlhadoHa40min = await apostaObservada({
      evento: "Fora da janela, casado, olhado ha 40min vs Rival",
      kickoffHorasAtras: foraDaJanela,
      olhadaMinutosAtras: 40,
    });

    const ids = (await listFlashscoreEligibleBets({
      now: NOW,
    })).map((b) => b.id);
    expect(ids).toContain(casadoOlhadoHa40min);
  });

  it("dupla olhada pelo caminho amassado volta em 10min, não em 6h", async () => {
    const banca = await db.prisma.bankroll.upsert({
      where: { slug: "obs" },
      create: { nome: "Obs", slug: "obs" },
      update: {},
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: banca.id,
        data: new Date(NOW.getTime() - 2 * 3_600_000),
        evento: "France vs Morocco | Spain vs Italy",
        esporte: "Soccer",
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
        result: {
          create: {
            resultFinal: false,
            resultCheckedAt: new Date(NOW.getTime() - 39 * 60_000),
            resultSnapshot: {
              outcome: "no_candidate",
              identityResolution: { strategy: "not_matched" },
            },
          },
        },
      },
    });

    const idsCedo = (await listFlashscoreEligibleBets({
      now: new Date(NOW.getTime() - 30 * 60_000),
    })).map((row) => row.id);
    expect(idsCedo).not.toContain(bet.id);

    const idsRetry = (await listFlashscoreEligibleBets({
      now: NOW,
    })).map((row) => row.id);
    expect(idsRetry).toContain(bet.id);
  });

  it("evento NÃO casado espera as 6h — nome errado não se corrige sozinho", async () => {
    // Aposta com erro de digitação no evento ("Sherewsbury", "Valladollid")
    // nunca vai casar. Olhada a cada 30min, gastaria chamadas o dia inteiro
    // sem resolver nada.
    const naoCasadoOlhadoHa40min = await apostaObservada({
      evento: "Sem casar, olhado ha 40min vs Rival",
      kickoffHorasAtras: 2,
      olhadaMinutosAtras: 40,
      casou: false,
    });
    const naoCasadoOlhadoHa7h = await apostaObservada({
      evento: "Sem casar, olhado ha 7h vs Rival",
      kickoffHorasAtras: 8,
      olhadaMinutosAtras: 7 * 60,
      casou: false,
    });

    const ids = (await listFlashscoreEligibleBets({
      now: NOW,
    })).map((b) => b.id);
    expect(ids).not.toContain(naoCasadoOlhadoHa40min);
    expect(ids).toContain(naoCasadoOlhadoHa7h);
  });

  it("atualização sem matchId não apaga o casamento já gravado", async () => {
    const betId = await apostaObservada({
      evento: "Casado, persist sem matchId vs Rival",
      kickoffHorasAtras: 2,
      olhadaMinutosAtras: 40,
    });
    const bet = await db.prisma.bet.findUniqueOrThrow({
      where: { id: betId }, include: { captureEvidence: true },
    });
    await persistFlashscoreObservation({
      bet,
      checkedAt: NOW,
      final: false,
      snapshot: { outcome: "matched", ticket: true },
    });
    await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId } }))
      .resolves.toMatchObject({ resultMatchId: "fs-match-1" });
  });

  it("o jogo recusado pelo horário sai do vínculo, só se ainda for o vinculado", async () => {
    const betId = await apostaObservada({ evento: "Remarcado vs Rival", kickoffHorasAtras: 2, olhadaMinutosAtras: 40 });
    await db.prisma.betResult.update({ where: { betId }, data: { resultMatchConfidence: 0.9 } });
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId }, include: { captureEvidence: true } });

    // Outro caminho vinculou outro jogo no meio: esse fica.
    await persistFlashscoreObservation({
      bet, checkedAt: NOW, final: false, snapshot: { outcome: "kickoff_mismatch" }, releaseMatchId: "fs-match-velho",
    });
    await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId } }))
      .resolves.toMatchObject({ resultMatchId: "fs-match-1" });

    await persistFlashscoreObservation({
      bet, checkedAt: NOW, final: false, snapshot: { outcome: "kickoff_mismatch" }, releaseMatchId: "fs-match-1",
    });
    await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId } }))
      .resolves.toMatchObject({ resultMatchId: null, resultMatchConfidence: null });
  });

  it("grava na aposta a primeira olhada uma vez só, sem mexer na revisão nem no updatedAt", async () => {
    const banca = await db.prisma.bankroll.create({ data: { nome: "Nova", slug: "nova" } });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: banca.id, data: new Date(NOW.getTime() - 2 * 3_600_000), evento: "Nunca olhada vs Rival",
        esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: NOW,
        mercado: "Moneyline", selecao: "Casa", odds: 2, stake: 1, status: "PENDING",
      },
      include: { captureEvidence: true },
    });

    await persistFlashscoreObservation({ bet, checkedAt: NOW, final: false, snapshot: { outcome: "no_candidate" } });
    await persistFlashscoreObservation({
      bet, checkedAt: new Date(NOW.getTime() + 6 * 3_600_000), final: false, snapshot: { outcome: "matched" },
    });

    // A sugestão do IA-Judge feita antes da olhada compara o `updatedAt` da aposta.
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).resolves.toMatchObject({
      flashscoreFirstCheckedAt: NOW,
      updatedAt: bet.updatedAt,
      manualSettlementVersion: bet.manualSettlementVersion,
    });
  });

  it("a aposta que já estava em observação fica com a leitura anterior como primeira olhada", async () => {
    // Olhada 40 min atrás, antes de a coluna existir.
    const betId = await apostaObservada({ evento: "Ja olhada vs Rival", kickoffHorasAtras: 3, olhadaMinutosAtras: 40, casou: false });
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId }, include: { captureEvidence: true } });

    await persistFlashscoreObservation({ bet, checkedAt: NOW, final: false, snapshot: { outcome: "no_candidate" } });

    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }))
      .resolves.toMatchObject({ flashscoreFirstCheckedAt: new Date(NOW.getTime() - 40 * 60_000) });
  });

  it("esporte que o FlashScore não liquida não grava a primeira olhada", async () => {
    const banca = await db.prisma.bankroll.create({ data: { nome: "Dardos", slug: "dardos" } });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: banca.id, data: new Date(NOW.getTime() - 2 * 3_600_000), evento: "Littler vs Humphries",
        esporte: "Darts", sportResolutionStatus: "CONFIRMED", sportResolvedAt: NOW,
        mercado: "Moneyline", selecao: "Littler", odds: 2, stake: 1, status: "PENDING",
      },
      include: { captureEvidence: true },
    });

    await persistFlashscoreObservation({
      bet, checkedAt: NOW, final: true, snapshot: { outcome: "unsupported_sport", sport: "Darts" },
    });

    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ flashscoreFirstCheckedAt: null });
    await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } }))
      .resolves.toMatchObject({ resultSnapshot: { outcome: "unsupported_sport" } });
  });

  it("dupla incompleta persiste matchId, volta em 10min e liquida no segundo olhar", async () => {
    const kickoff = new Date(NOW.getTime() - 2 * 3_600_000);
    const banca = await db.prisma.bankroll.upsert({
      where: { slug: "obs" },
      create: { nome: "Obs", slug: "obs" },
      update: {},
    });
    const created = await db.prisma.bet.create({
      data: {
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: banca.id,
        data: kickoff,
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

    const first = await observeFlashscoreTicketBet({
      bet: await loadEligible(created.id),
      matches: [
        flashscoreMatch({
          id: "fs-fr",
          home: "France",
          away: "Morocco",
          kickoff,
          homeScore: 2,
          awayScore: 1,
        }),
        flashscoreMatch({
          id: "fs-es",
          home: "Spain",
          away: "Italy",
          kickoff,
          homeScore: 0,
          awayScore: 0,
          live: true,
        }),
      ],
      sportId: 1,
      day: "2026-07-25",
      now: NOW,
      loadMatches: async () => null,
    });
    expect(first).toMatchObject({ matched: true, final: false, settled: false });
    await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId: created.id } }))
      .resolves.toMatchObject({
        resultMatchId: "fs-fr",
        resultFinal: false,
      });

    const idsCedo = (await listFlashscoreEligibleBets({
      now: new Date(NOW.getTime() + 9 * 60_000),
    })).map((bet) => bet.id);
    expect(idsCedo).not.toContain(created.id);

    const idsRetry = (await listFlashscoreEligibleBets({
      now: new Date(NOW.getTime() + 10 * 60_000),
    })).map((bet) => bet.id);
    expect(idsRetry).toContain(created.id);

    const second = await observeFlashscoreTicketBet({
      bet: await loadEligible(created.id),
      matches: [
        flashscoreMatch({
          id: "fs-fr",
          home: "France",
          away: "Morocco",
          kickoff,
          homeScore: 2,
          awayScore: 1,
        }),
        flashscoreMatch({
          id: "fs-es",
          home: "Spain",
          away: "Italy",
          kickoff,
          homeScore: 1,
          awayScore: 0,
        }),
      ],
      sportId: 1,
      day: "2026-07-25",
      now: new Date(NOW.getTime() + 10 * 60_000),
      loadMatches: async () => null,
    });
    expect(second).toMatchObject({ matched: true, final: true, settled: true });
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: created.id } }))
      .resolves.toMatchObject({ status: "WON" });
    await expect(db.prisma.betResult.findUniqueOrThrow({ where: { betId: created.id } }))
      .resolves.toMatchObject({ resultFinal: true, resultMatchId: "fs-fr" });
  });

  it("ticket não liquida fixture feminina com IDs do masculino", async () => {
    const kickoff = new Date(NOW.getTime() - 2 * 3_600_000);
    async function seedMaleIdentity(name: string, teamId: string) {
      await seedTeamCard(db.prisma, {
        flashscoreTeamId: teamId, flashscoreName: name, country: "England", pinnacleNames: [{ name }],
      });
    }
    await seedMaleIdentity("Tottenham", "male-tot");
    await seedMaleIdentity("Arsenal", "male-ars");

    const banca = await db.prisma.bankroll.upsert({
      where: { slug: "obs" },
      create: { nome: "Obs", slug: "obs" },
      update: {},
    });
    const created = await db.prisma.bet.create({
      data: {
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: banca.id,
        data: kickoff,
        evento: "Tottenham vs Arsenal | Spain vs Italy",
        esporte: "Soccer",
        competicao: "Premier League",
        pais: "England",
        mercado: "Moneyline",
        selecao: "Tottenham / Spain",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "Tottenham vs Arsenal", mercado: "Moneyline", selecao: "Tottenham" },
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

    const women = {
      ...flashscoreMatch({
        id: "fs-w",
        home: "Tottenham W",
        away: "Arsenal W",
        kickoff,
        homeScore: 2,
        awayScore: 0,
      }),
      home_team: { team_id: "male-tot", name: "Tottenham W" },
      away_team: { team_id: "male-ars", name: "Arsenal W" },
    };
    const spain = flashscoreMatch({
      id: "fs-es",
      home: "Spain",
      away: "Italy",
      kickoff,
      homeScore: 1,
      awayScore: 0,
    });

    await expect(settleFromFlashscoreScore(
      await loadEligible(created.id),
      { homeScore: 2, awayScore: 0 },
      {
        scoresByEvento: [
          { evento: "Tottenham vs Arsenal", home: 2, away: 0 },
          { evento: "Spain vs Italy", home: 1, away: 0 },
        ],
      },
    )).resolves.toBe(true);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: created.id } }))
      .resolves.toMatchObject({ status: "WON" });

    await db.prisma.bet.update({
      where: { id: created.id },
      data: { status: "PENDING", lucro: 0, settledAt: null },
    });
    await db.prisma.betResult.deleteMany({ where: { betId: created.id } });

    const observed = await observeFlashscoreTicketBet({
      bet: await loadEligible(created.id),
      matches: [women, spain],
      sportId: 1,
      day: "2026-07-25",
      now: NOW,
      loadMatches: async () => null,
    });

    // O matcher recusa o candidato, mesmo com os dois ids: a aposta é da
    // Premier League e a partida é feminina. Não é o aprendizado que veta.
    expect(observed.identityBlocked).toEqual([]);
    expect(observed.settled).toBe(false);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: created.id } }))
      .resolves.toMatchObject({ status: "PENDING" });
  });
});

function flashscoreMatch(params: {
  id: string;
  home: string;
  away: string;
  kickoff: Date;
  homeScore: number;
  awayScore: number;
  live?: boolean;
}): FlashscoreMatch {
  return {
    match_id: params.id,
    timestamp: Math.floor(params.kickoff.getTime() / 1_000),
    home_team: { team_id: `${params.id}-h`, name: params.home },
    away_team: { team_id: `${params.id}-a`, name: params.away },
    scores: { home: params.homeScore, away: params.awayScore },
    match_status: params.live
      ? {
          stage: "2nd half",
          is_cancelled: false,
          is_postponed: false,
          is_started: true,
          is_in_progress: true,
          is_finished: false,
        }
      : {
          stage: "Finished",
          is_cancelled: false,
          is_postponed: false,
          is_started: true,
          is_in_progress: false,
          is_finished: true,
        },
  };
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
