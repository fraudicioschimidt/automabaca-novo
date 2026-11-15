import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ getPlayerEvidence: vi.fn() }));
// A liquidação cancela o enrich pendente e avisa o dono depois do commit; aqui só o banco importa.
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => ({}) }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ cancelPendingSharpEnrich: vi.fn() }));
vi.mock("@/src/services/ops/alerts", () => ({
  notifyPersistedOperationalAlert: vi.fn(),
  sendOperationalAlert: vi.fn(),
  sendOperatorNotification: vi.fn(),
}));
vi.mock("@/src/providers/flashscore/player-evidence", () => ({ getFlashscorePlayerEvidence: mocked.getPlayerEvidence }));

import { canonicalSha256 } from "@/src/domain/canonical-json";
import { createTestDb, type TestDb } from "../helpers/db";
import { applyManualBetStatusChange } from "../helpers/settle";
import { getBetSettlementCard } from "@/app/_design/adapters/aposta";
import { playerPropRule } from "@/src/domain/settlement/player-prop-rules";
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import type { BetStatus, Prisma } from "@/src/generated/prisma/client";
import { softDeleteBet } from "@/src/services/bets/remove";
import { applyAutomaticBetStatusChange } from "@/src/services/bets/settle";
import { approveIaJudgeSuggestion } from "@/src/services/settlement/ia-judge/suggestions";
import { persistFlashscoreObservation } from "@/src/services/settlement/flashscore/observation-store";
import { settlePersistentPlayerProp } from "@/src/services/settlement/flashscore/player-props";

/**
 * O cartão "Como foi liquidada" contra o Postgres real: quem decidiu sai do
 * último STATUS_CHANGED gravado pela liquidação de verdade, e a sugestão do
 * IA-Judge só é prova da liquidação que ela aprovou.
 */
let db: TestDb;
beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  vi.clearAllMocks();
});

async function seedBet(over: { mercado?: string; selecao?: string } = {}) {
  const bankroll = await db.prisma.bankroll.upsert({
    where: { slug: "cartao" },
    create: { nome: "Cartão", slug: "cartao", valorUnidade: 50, vincularContas: false },
    update: {},
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date("2026-06-15T12:00:00Z"),
      bankrollId: bankroll.id,
      data: new Date("2026-06-15T19:00:00Z"),
      evento: "Flamengo vs Palmeiras",
      esporte: "Soccer",
      mercado: over.mercado ?? "Total de gols",
      selecao: over.selecao ?? "Mais de 2.5",
      odds: 1.9,
      stake: 1,
    },
  });
}

async function suggestion(betId: string, suggestedStatus: BetStatus, valueFound: string) {
  const { updatedAt } = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId }, select: { updatedAt: true } });
  return db.prisma.iaJudgeSuggestion.create({
    data: {
      betId, suggestedStatus, valueFound, confidence: 0.97, reason: `Achou ${valueFound}.`,
      sourceUrl: "https://www.sofascore.com/match/1", evidenceKind: "GROUNDED_WEB", betUpdatedAt: updatedAt,
    },
  });
}

describe("getBetSettlementCard", () => {
  it("conserva a fonte citada por redirecionamento na prova homologada", async () => {
    const bet = await seedBet();
    const s = await suggestion(bet.id, "WON", "3 gols");
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/prova-resultado";
    await db.prisma.iaJudgeSuggestion.update({ where: { id: s.id }, data: {
      sourceUrl: redirect, groundingSources: [{ url: redirect, title: "sofascore.com" }],
    } });
    await approveIaJudgeSuggestion({ suggestionId: s.id, actor: "dono" });
    expect(await getBetSettlementCard(bet.id)).toMatchObject({ judge: { link: redirect, site: "sofascore.com" } });
  });

  it("a prova segue a aprovação desta liquidação mesmo quando a transação termina com atraso", async () => {
    const bet = await seedBet();
    const first = await suggestion(bet.id, "WON", "Primeira prova");
    await approveIaJudgeSuggestion({ suggestionId: first.id, actor: "dono" });
    await applyManualBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual:dono" });
    const second = await suggestion(bet.id, "WON", "Prova atualizada");
    await approveIaJudgeSuggestion({ suggestionId: second.id, actor: "dono" });
    const change = await db.prisma.settlementEvent.findFirstOrThrow({ where: { betId: bet.id, type: "STATUS_CHANGED" }, orderBy: { createdAt: "desc" } });
    const changedAt = new Date((change.payload as { changedAt: string }).changedAt).getTime();
    // Duas aprovações próximas: a segunda teve trabalho financeiro mais demorado.
    await db.prisma.iaJudgeSuggestion.update({ where: { id: first.id }, data: { resolvedAt: new Date(changedAt - 100) } });
    await db.prisma.iaJudgeSuggestion.update({ where: { id: second.id }, data: { resolvedAt: new Date(changedAt + 1500) } });
    expect(await getBetSettlementCard(bet.id)).toMatchObject({ judge: { found: "Prova atualizada" } });
  });

  it("sem vínculo explícito, aceita somente a aprovação inequívoca", async () => {
    const bet = await seedBet();
    const s = await suggestion(bet.id, "WON", "3 gols");
    await approveIaJudgeSuggestion({ suggestionId: s.id, actor: "dono" });
    const change = await db.prisma.settlementEvent.findFirstOrThrow({ where: { betId: bet.id, type: "STATUS_CHANGED" } });
    const payload = { ...(change.payload as Prisma.JsonObject) };
    delete payload.judgeSuggestionId;
    await db.prisma.settlementEvent.update({ where: { id: change.id }, data: { payload, payloadHash: canonicalSha256(payload) } });
    expect(await getBetSettlementCard(bet.id)).toMatchObject({ judge: { found: "3 gols" } });

    await db.prisma.iaJudgeSuggestion.create({ data: {
      betId: bet.id, suggestedStatus: "WON", status: "APPROVED", valueFound: "Outra prova",
      confidence: 0.97, evidenceKind: "GROUNDED_WEB", reason: "Prova de outro ciclo próximo", resolvedBy: "dono", resolvedAt: new Date(),
    } });
    expect(await getBetSettlementCard(bet.id)).toMatchObject({ judge: null });
  });

  it.each(["ausente", "outra-aposta", "outro-ator", "outro-resultado", "rejeitada"])(
    "um vínculo inválido não é substituído por outra aprovação próxima: %s", async (invalid) => {
      const bet = await seedBet();
      const s = await suggestion(bet.id, "WON", "3 gols");
      await approveIaJudgeSuggestion({ suggestionId: s.id, actor: "dono" });
      const otherBet = await seedBet();
      const other = await suggestion(otherBet.id, "WON", "4 gols");
      const change = await db.prisma.settlementEvent.findFirstOrThrow({ where: { betId: bet.id, type: "STATUS_CHANGED" } });
      const payload = { ...(change.payload as Prisma.JsonObject),
        judgeSuggestionId: invalid === "ausente" ? "inexistente" : invalid === "outra-aposta" ? other.id : s.id,
      };
      await db.prisma.settlementEvent.update({ where: { id: change.id }, data: { payload, payloadHash: canonicalSha256(payload) } });
      if (invalid === "outro-ator") await db.prisma.iaJudgeSuggestion.update({ where: { id: s.id }, data: { resolvedBy: "outro" } });
      if (invalid === "outro-resultado") await db.prisma.iaJudgeSuggestion.update({ where: { id: s.id }, data: { suggestedStatus: "LOST" } });
      if (invalid === "rejeitada") await db.prisma.iaJudgeSuggestion.update({ where: { id: s.id }, data: { status: "REJECTED" } });
      expect(await getBetSettlementCard(bet.id)).toMatchObject({ judge: null });
    },
  );

  it("liquidada pelo FlashScore: o placar e o jogo gravados na observação", async () => {
    const bet = await seedBet();
    await applyAutomaticBetStatusChange({ betId: bet.id, newStatus: "WON", source: "flashscore" });
    await db.prisma.betResult.create({
      data: {
        betId: bet.id, scoreHome: 2, scoreAway: 1, resultProvider: "flashscore", resultMatchId: "m1",
        resultMatchConfidence: 1, resultFinal: true, resultCheckedAt: new Date(),
        resultSnapshot: {
          settlementOutcome: "settled_from_score", score: { home: 2, away: 1 },
          providerTeams: { home: "Flamengo RJ", away: "Palmeiras", swapped: false },
        },
      },
    });

    expect(await getBetSettlementCard(bet.id)).toMatchObject({
      source: "liquidação automática pelo FlashScore",
      score: { value: "2-1", kind: "decided" },
      fixture: "Flamengo RJ vs Palmeiras · casamento 100%",
      outcome: "pelo placar final",
      judge: null,
    });
  });

  it("liquidada à mão no meio do jogo: a leitura congelada da observação aberta não passa por placar final", async () => {
    const bet = await seedBet();
    // A última leitura antes de o dono liquidar, aos 75'; a aposta liquidada sai da fila e ela fica assim.
    await db.prisma.betResult.create({
      data: {
        betId: bet.id, resultProvider: "flashscore", resultMatchId: "m1", resultMatchConfidence: 1,
        resultFinal: false, resultCheckedAt: new Date(),
        resultSnapshot: { settlementOutcome: "not_attempted", score: { home: 1, away: 0 }, stage: "2nd Half", finished: false },
      },
    });
    await applyManualBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual:dono" });

    expect(await getBetSettlementCard(bet.id)).toMatchObject({
      source: "ação manual (dono)",
      score: { value: "1-0", kind: "partial", detail: 'fim do jogo não confirmado · FlashScore: "2nd Half"' },
    });
  });

  it("liquidada pelo IA-Judge automático: o que a IA achou, com certeza e fonte", async () => {
    const bet = await seedBet({ mercado: "Total de Escanteios", selecao: "Mais de 9.5" });
    const s = await suggestion(bet.id, "WON", "11 escanteios");
    await approveIaJudgeSuggestion({ suggestionId: s.id, actor: "ia_judge_auto" });

    expect(await getBetSettlementCard(bet.id)).toMatchObject({
      source: "IA-Judge automático",
      score: null,
      crossCheck: "sem conferência do FlashScore",
      judge: { found: "11 escanteios", confidence: "97%", link: "https://www.sofascore.com/match/1", site: "sofascore.com", fromFlashscore: false },
    });
  });

  it("a sugestão aprovada antes de reabrir não vira prova da liquidação seguinte", async () => {
    const bet = await seedBet({ mercado: "Total de Escanteios", selecao: "Mais de 9.5" });
    const first = await suggestion(bet.id, "WON", "11 escanteios");
    await approveIaJudgeSuggestion({ suggestionId: first.id, actor: "ia_judge_auto" });
    await applyManualBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual:dono" });

    // Reliquidada pela IA de novo: vale a sugestão desta liquidação.
    const second = await suggestion(bet.id, "LOST", "8 escanteios");
    await approveIaJudgeSuggestion({ suggestionId: second.id, actor: "dono" });
    expect(await getBetSettlementCard(bet.id)).toMatchObject({ source: "IA-Judge (dono)", judge: { found: "8 escanteios" } });

    // Reaberta e liquidada à mão: nenhuma das duas sugestões é a prova.
    await applyManualBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual:dono" });
    await applyManualBetStatusChange({ betId: bet.id, newStatus: "VOID", source: "manual:dono" });
    expect(await getBetSettlementCard(bet.id)).toMatchObject({ source: "ação manual (dono)", judge: null, crossCheck: null });
  });

  it("mesmo ator e mesmo status depois de reabrir: vale a sugestão aprovada na hora desta liquidação", async () => {
    const bet = await seedBet({ mercado: "Total de Escanteios", selecao: "Mais de 9.5" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-06-15T21:30:00Z"));
      const first = await suggestion(bet.id, "WON", "11 escanteios");
      await approveIaJudgeSuggestion({ suggestionId: first.id, actor: "ia_judge_auto" });
      vi.setSystemTime(new Date("2026-06-16T09:00:00Z"));
      await applyManualBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual:dono" });
      vi.setSystemTime(new Date("2026-06-16T15:00:00Z"));
      const second = await suggestion(bet.id, "WON", "12 escanteios, pelo relatório oficial");
      await approveIaJudgeSuggestion({ suggestionId: second.id, actor: "ia_judge_auto" });
    } finally {
      vi.useRealTimers();
    }

    expect(await getBetSettlementCard(bet.id)).toMatchObject({
      source: "IA-Judge automático",
      at: "16/06 12:00",
      judge: { found: "12 escanteios, pelo relatório oficial" },
    });
  });

  it("prop de jogador: a estatística da liquidação, e a rechecagem de 24h que divergiu na Conferência", async () => {
    const at = (minutes: number) => new Date(new Date("2026-09-08T20:00:00Z").getTime() + minutes * 60_000);
    const lineups = ["home", "away"].map((side) => ({ side,
      startingLineups: Array.from({ length: 11 }, (_, i) => ({
        player_id: i === 0 && side === "home" ? "tom" : `${side}${i}`, name: i === 0 && side === "home" ? "Fellows T." : `${side} Player ${i}`,
      })),
      substitutes: [], substitutedPlayers: [],
    }));
    const reading = (minutes: number, shots: number) => ({ lineups, fetchedAt: at(minutes), stats: { players: [{
      player_id: "tom", name: "Fellows Tom", team_id: "h", in_base_lineup: true,
      stats: { SHOTS_TOTAL: { raw_value: String(shots) }, MATCH_MINUTES_PLAYED: { raw_value: "90" } },
    }] } });
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Props", slug: "props", sharpMode: "IDENTITY_ONLY", playerPropsAutoSettlement: true },
    });
    const bet = await db.prisma.bet.create({ data: {
      bankrollId: bankroll.id, evento: "Southampton vs Swansea", esporte: "Soccer", sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: at(-180), mercado: "Player Shots", selecao: "Tom Fellows Over 1.5", competicao: "Championship",
      casaDeAposta: "Bet365", data: at(-180), registradoEm: at(-240), odds: 2.32, stake: 1.25,
    } });
    await db.prisma.betPlayerProp.create({ data: { betId: bet.id, terms: buildPlayerPropTerms(bet)!, rule: playerPropRule("Bet365", "shots_total") } });
    const params = { bet: { ...await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }), playerPropRevision: 1 }, matchId: "fixture", homeId: "h", awayId: "a", swapped: false, extraTime: false };

    // Duas leituras iguais a 10 min liquidam; a observação grava a prova no snapshot, como `observeSingleBet`.
    mocked.getPlayerEvidence.mockResolvedValueOnce(reading(0, 2)).mockResolvedValueOnce(reading(10, 2)).mockResolvedValueOnce(reading(1440, 0));
    await settlePersistentPlayerProp({ ...params, now: at(0) });
    const settled = await settlePersistentPlayerProp({ ...params, now: at(10) });
    expect(settled).toMatchObject({ settled: true });
    await persistFlashscoreObservation({
      bet: params.bet, checkedAt: at(10), matchId: "fixture", confidence: 1, final: true,
      snapshot: { outcome: "matched", settlementOutcome: settled.settlementOutcome, stage: "Finished", finished: true,
        score: { home: 1, away: 0 }, playerProp: settled.evidencia } as Prisma.InputJsonValue,
    });
    expect(await getBetSettlementCard(bet.id)).toMatchObject({
      source: "liquidação automática pelo FlashScore", player: "Fellows Tom · 2 chutes", crossCheck: null,
    });

    // A rechecagem regrava a prova da prop com a leitura dela; o jogador que decidiu fica.
    await settlePersistentPlayerProp({ ...params, bet: { ...await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }), playerPropRevision: 1 }, now: at(1440), recheck: true });
    expect(await getBetSettlementCard(bet.id)).toMatchObject({
      player: "Fellows Tom · 2 chutes",
      crossCheck: "a rechecagem 24h depois leu Fellows Tom · 0 chutes (Perdida); a divergência está para conferir em Config › Jogadores",
    });
  });

  it("sem cartão na pendente, na reaberta e na removida", async () => {
    const pending = await seedBet();
    expect(await getBetSettlementCard(pending.id)).toBeNull();

    const reopened = await seedBet();
    await applyAutomaticBetStatusChange({ betId: reopened.id, newStatus: "WON", source: "flashscore" });
    await applyManualBetStatusChange({ betId: reopened.id, newStatus: "PENDING", source: "manual:dono" });
    expect(await getBetSettlementCard(reopened.id)).toBeNull();

    const removed = await seedBet();
    await applyManualBetStatusChange({ betId: removed.id, newStatus: "LOST", source: "manual:dono" });
    await softDeleteBet({ betId: removed.id, actor: "agent:teste", motivo: "teste", origin: "painel" });
    expect(await getBetSettlementCard(removed.id)).toBeNull();

    expect(await getBetSettlementCard("nao-existe")).toBeNull();
  });
});
