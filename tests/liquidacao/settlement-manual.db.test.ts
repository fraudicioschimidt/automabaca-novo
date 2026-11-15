import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { getSettlementManual } from "@/src/services/painel/operacoes/settlement-manual";
import { isOperationalAlertOpen } from "@/src/services/ops/alerts";
import { linkFlashscoreMatch } from "@/src/services/settlement/bet-result";
import { persistFlashscoreObservation } from "@/src/services/settlement/flashscore/observation-store";
import { applyManualBetStatusChange as applyBetStatusChange } from "../helpers/settle";
import type { BetStatus } from "@/src/generated/prisma/client";

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
});

const PAST = new Date("2026-01-01T12:00:00Z");
const FUTURE = new Date("2099-01-01T12:00:00Z");

async function seed() {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Banca", slug: "banca", valorUnidade: 50 },
  });
  const conta = await db.prisma.conta.create({
    data: { casaDeAposta: "Bet365", titular: "Fabricio", saldoInicial: 1000, saldoAtual: 1000 },
  });
  let n = 0;
  const mk = (over: { mercado: string; selecao: string; data?: Date; status?: BetStatus }) =>
    db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: (over.status ?? "PENDING") === "PENDING" ? null : (over.data ?? PAST),
        bankrollId: bankroll.id,
        contaId: conta.id,
        data: over.data ?? PAST,
        evento: `Evento ${(n += 1)}`,
        esporte: "Soccer",
        odds: 1.9,
        stake: 2,
        status: over.status ?? "PENDING",
        mercado: over.mercado,
        selecao: over.selecao,
      },
    });

  return {
    bankroll,
    conta,
    // Entram: PENDING com o jogo meses atrás, que o automático não liquidou.
    corners: await mk({ mercado: "Total de Escanteios", selecao: "Mais de 9.5" }),
    cards: await mk({ mercado: "Total (Bookings) – Match", selecao: "Under 5.5" }),
    moneyline: await mk({ mercado: "Moneyline", selecao: "Time A" }),
    // ficam de fora:
    cardsFuture: await mk({ mercado: "Cartões", selecao: "Mais de 4.5", data: FUTURE }), // futuro
    cornersWon: await mk({ mercado: "Escanteios", selecao: "Mais de 8.5", status: "WON" }), // já liquidada
  };
}

describe("getSettlementManual (Postgres real)", () => {
  it("inclui PENDING parada e exclui futuro/liquidado", async () => {
    const s = await seed();
    const ids = (await getSettlementManual()).map((r) => r.betId);

    expect(ids).toContain(s.corners.id);
    expect(ids).toContain(s.cards.id);
    expect(ids).toContain(s.moneyline.id);
    expect(ids).not.toContain(s.cardsFuture.id); // evento no futuro
    expect(ids).not.toContain(s.cornersWon.id); // já liquidada
    expect(ids).toHaveLength(3);
  });

  it("liquidar manualmente uma aposta (caminho real de settlement) a tira da lista", async () => {
    const s = await seed();
    await applyBetStatusChange(
      { betId: s.corners.id, newStatus: "WON", source: "manual" },
      { client: db.prisma },
    );

    const ids = (await getSettlementManual()).map((r) => r.betId);
    expect(ids).not.toContain(s.corners.id);
    expect(ids).toContain(s.cards.id);

    // E o ledger reflete o ganho (1.9 odds, 2u stake → +1.8u × R$50 = R$90).
    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: s.conta.id } });
    expect(Number(contaDb.saldoAtual)).toBe(1090);
  });

  it("avisa que a fila passou do limite só quando passou: 500 apostas cabem no card", async () => {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Banca", slug: "banca" } });
    const parada = (i: number) => ({
      bankrollId: bankroll.id, sportResolutionStatus: "CONFIRMED" as const, sportResolvedAt: PAST,
      data: new Date(PAST.getTime() + i * 60_000), evento: `Evento ${i}`, esporte: "Soccer",
      mercado: "Moneyline", selecao: "Time A", odds: 1.9, stake: 1,
    });
    const alerta = { source: "painel.settlement-manual", key: "card-truncado" };
    await db.prisma.bet.createMany({ data: Array.from({ length: 500 }, (_, i) => parada(i)) });

    expect(await getSettlementManual()).toHaveLength(500);
    expect(await isOperationalAlertOpen(alerta)).toBe(false);

    await db.prisma.bet.create({ data: parada(500) });
    const linhas = await getSettlementManual();
    expect(linhas).toHaveLength(500);
    expect(linhas.at(-1)?.evento).toBe("Evento 499"); // as mais antigas primeiro
    expect(await isOperationalAlertOpen(alerta)).toBe(true);
  });

  it("expõe score-resolvable MATCHED após 6h sem placar", async () => {
    const s = await seed();
    const stale = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: s.bankroll.id,
        data: new Date("2026-07-19T01:00:00Z"),
        evento: "Time A vs Time B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2,
        stake: 1,
        sharp: { create: { identityStatus: "MATCHED", confidence: 95 } },
      },
    });
    const recent = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: s.bankroll.id,
        data: new Date("2026-07-19T09:00:00Z"),
        evento: "Time C vs Time D",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Time C",
        odds: 2,
        stake: 1,
        sharp: { create: { identityStatus: "MATCHED", confidence: 95 } },
      },
    });

    const ids = (await getSettlementManual(new Date("2026-07-19T10:00:00Z"))).map(
      (row) => row.betId,
    );
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(recent.id);
  });

  it("expõe score-resolvable MATCHED com placar ingerido sem liquidação, antes das 6h", async () => {
    const s = await seed();
    const mk = (evento: string) => db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: s.bankroll.id,
        data: new Date("2026-07-19T09:00:00Z"),
        evento,
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: evento.split(" vs ")[0]!,
        odds: 2,
        stake: 1,
        sharp: { create: { identityStatus: "MATCHED", confidence: 95 } },
      },
    });
    const comPlacar = await mk("Time E vs Time F");
    const semPlacar = await mk("Time G vs Time H");
    // O placar entrou, mas o motor não decidiu a aposta: ela está presa no automático.
    await db.prisma.betResult.create({ data: { betId: comPlacar.id, scoreHome: 2, scoreAway: 1 } });

    const ids = (await getSettlementManual(new Date("2026-07-19T10:00:00Z"))).map((row) => row.betId);
    expect(ids).toContain(comPlacar.id);
    expect(ids).not.toContain(semPlacar.id);
  });

  describe("segue o automático, não o mercado nem a identidade sharp", () => {
    const NOW = new Date("2026-07-19T12:00:00Z");
    const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

    async function mkAt(over: {
      minutes: number;
      /** `data` fixa, no lugar de `minutes` antes de NOW. */
      at?: Date;
      registradoEm?: Date;
      liveScore?: { home: number; away: number };
      mercado?: string;
      selecao?: string;
      identityStatus?: "MATCHED" | "UNMATCHED";
      kickoffInferido?: boolean;
      esporte?: string;
      sportResolutionStatus?: "CONFIRMED" | "PENDING";
      result?: { resultFinal: boolean; resultMatchId?: string; resultSnapshot: object };
    }) {
      const bankroll = await db.prisma.bankroll.upsert({
        where: { slug: "banca-auto" },
        create: { nome: "Banca", slug: "banca-auto", valorUnidade: 50 },
        update: {},
      });
      const confirmed = (over.sportResolutionStatus ?? "CONFIRMED") === "CONFIRMED";
      return db.prisma.bet.create({
        data: {
          sportResolutionStatus: over.sportResolutionStatus ?? "CONFIRMED",
          sportResolvedAt: confirmed ? new Date() : null,
          bankrollId: bankroll.id,
          data: over.at ?? minutesAgo(over.minutes),
          registradoEm: over.registradoEm ?? minutesAgo(over.minutes),
          ...(over.liveScore ? { liveScoreHome: over.liveScore.home, liveScoreAway: over.liveScore.away } : {}),
          kickoffInferido: over.kickoffInferido ?? false,
          evento: `Casa ${over.minutes} vs Fora ${over.minutes}`,
          esporte: over.esporte ?? (confirmed ? "Soccer" : "Unknown"),
          mercado: over.mercado ?? "Moneyline",
          selecao: over.selecao ?? "Casa",
          odds: 2,
          stake: 1,
          ...(over.identityStatus
            ? { sharp: { create: { identityStatus: over.identityStatus, confidence: 95 } } }
            : {}),
          ...(over.result ? { result: { create: { resultProvider: "flashscore", ...over.result } } } : {}),
        },
      });
    }

    it("jogo recém-começado fica fora: o FlashScore ainda vai liquidá-lo", async () => {
      // Banca OFF (sem bet_sharp), liga que a Pinnacle não lista e escanteios:
      // o FlashScore liquida os três a partir de kickoff+90 min.
      const semSharp = await mkAt({ minutes: 5 });
      const unmatched = await mkAt({ minutes: 5, identityStatus: "UNMATCHED" });
      const escanteios = await mkAt({ minutes: 5, mercado: "Total de Escanteios", selecao: "Mais de 9.5" });
      // Às 5 h o automático ainda trabalha; às 7 h o operador precisa ver.
      const semSharp5h = await mkAt({ minutes: 5 * 60 });
      const semSharp7h = await mkAt({ minutes: 7 * 60 });

      const ids = (await getSettlementManual(NOW)).map((row) => row.betId);
      expect(ids).not.toContain(semSharp.id);
      expect(ids).not.toContain(unmatched.id);
      expect(ids).not.toContain(escanteios.id);
      expect(ids).not.toContain(semSharp5h.id);
      expect(ids).toContain(semSharp7h.id);
    });

    it("esporte não confirmado entra depois da janela de um jogo", async () => {
      const esporteRolando = await mkAt({ minutes: 60, sportResolutionStatus: "PENDING" });
      const esporteEncerrado = await mkAt({ minutes: 4 * 60, sportResolutionStatus: "PENDING" });

      const rows = await getSettlementManual(NOW);
      expect(rows.map((row) => row.betId)).not.toContain(esporteRolando.id);
      expect(rows.find((row) => row.betId === esporteEncerrado.id)?.cause).toEqual({ kind: "unconfirmed_sport" });
    });

    it("sem horário, entra só quando o jogo certamente acabou: fim do dia do jogo mais a janela", async () => {
      // `data` sem horário não é o apito. Post das 08:00 de SP com "19/07" e
      // sem hora: o jogo fica às 00:00 de SP do dia.
      const dayStart = new Date("2026-07-19T03:00:00Z");
      const soComODia = await mkAt({
        minutes: 0, at: dayStart, registradoEm: new Date("2026-07-19T11:00:00Z"), kickoffInferido: true,
      });
      // Post sem data às 12:00 de SP: o jogo fica no instante do post.
      const postAt = new Date("2026-07-19T15:00:00Z");
      const semData = await mkAt({ minutes: 0, at: postAt, registradoEm: postAt, kickoffInferido: true });
      // Tip ao vivo sem horário: a bola já rolava no post, e o jogo acaba na janela dele.
      const aoVivo = await mkAt({
        minutes: 0, at: postAt, registradoEm: postAt, kickoffInferido: true, liveScore: { home: 1, away: 0 },
      });
      const idsAt = async (iso: string) => (await getSettlementManual(new Date(iso))).map((row) => row.betId);

      // 10:00 de SP do mesmo dia: o jogo pode nem ter começado.
      expect(await idsAt("2026-07-19T13:00:00Z")).not.toContain(soComODia.id);
      // 16:00 de SP: a janela de um jogo desde o post sem data já passou.
      const afternoon = await idsAt("2026-07-19T19:00:00Z");
      expect(afternoon).not.toContain(semData.id);
      expect(afternoon).toContain(aoVivo.id);
      // O dia acaba às 03:00 UTC de 20/07; mais a janela, 06:00.
      const beforeGameOver = await idsAt("2026-07-20T05:59:00Z");
      expect(beforeGameOver).not.toContain(soComODia.id);
      expect(beforeGameOver).not.toContain(semData.id);
      const rows = await getSettlementManual(new Date("2026-07-20T06:00:00Z"));
      expect(rows.find((row) => row.betId === soComODia.id)?.cause).toEqual({ kind: "inferred_kickoff" });
      expect(rows.map((row) => row.betId)).toContain(semData.id);
    });

    it("jogo adiado fica fora nas 48 h em que o FlashScore espera a remarcação", async () => {
      const postponed = { outcome: "matched", settlementOutcome: "postponed_waiting" };
      const waiting = await mkAt({
        minutes: 7 * 60, result: { resultFinal: false, resultMatchId: "fs-adiado", resultSnapshot: postponed },
      });
      const graceOver = await mkAt({
        minutes: 49 * 60, result: { resultFinal: false, resultMatchId: "fs-adiado-2", resultSnapshot: postponed },
      });
      // Snapshot sem `settlementOutcome` não cai na exclusão.
      const noOutcome = await mkAt({
        minutes: 8 * 60, result: { resultFinal: false, resultMatchId: "fs-casado", resultSnapshot: { outcome: "matched" } },
      });
      // Bilhete: o snapshot conta as pernas adiadas, sem `settlementOutcome`.
      const ticketSnapshot = (postponedWaiting: number) => ({
        outcome: "matched", ticket: true, unfinished: postponedWaiting > 0, fixtures: 2, scored: 1, postponedWaiting,
      });
      const ticketWaiting = await mkAt({
        minutes: 7 * 60, result: { resultFinal: false, resultMatchId: "fs-perna", resultSnapshot: ticketSnapshot(1) },
      });
      const ticketGraceOver = await mkAt({
        minutes: 49 * 60, result: { resultFinal: false, resultMatchId: "fs-perna-2", resultSnapshot: ticketSnapshot(1) },
      });
      const ticketNothingPostponed = await mkAt({
        minutes: 7 * 60, result: { resultFinal: false, resultMatchId: "fs-perna-3", resultSnapshot: ticketSnapshot(0) },
      });

      const rows = await getSettlementManual(NOW);
      const ids = rows.map((row) => row.betId);
      expect(ids).not.toContain(waiting.id);
      expect(rows.find((row) => row.betId === graceOver.id)?.cause).toEqual({
        kind: "stalled", flashscoreOutcome: "matched", settlementOutcome: "postponed_waiting",
      });
      expect(ids).toContain(noOutcome.id);
      expect(ids).not.toContain(ticketWaiting.id);
      expect(ids).toContain(ticketGraceOver.id);
      expect(ids).toContain(ticketNothingPostponed.id);
    });

    it("observação fechada sem liquidar entra na hora, com o motivo do FlashScore", async () => {
      const prorrogacao = await mkAt({
        minutes: 150,
        result: {
          resultFinal: true,
          resultMatchId: "fs-1",
          resultSnapshot: { outcome: "matched", settlementOutcome: "manual_extra_time" },
        },
      });
      // Esporte que o FlashScore não liquida: a observação fecha às 1h30 sem
      // saber se o jogo acabou, e o IA-Judge ainda tenta a partir de 6 h.
      const esporteSemCobertura = await mkAt({
        minutes: 2 * 60,
        result: { resultFinal: true, resultSnapshot: { outcome: "unsupported_sport" } },
      });
      const esporteSemCobertura7h = await mkAt({
        minutes: 7 * 60,
        result: { resultFinal: true, resultSnapshot: { outcome: "unsupported_sport" } },
      });

      const rows = await getSettlementManual(NOW);
      const ids = rows.map((row) => row.betId);
      expect(rows.find((row) => row.betId === prorrogacao.id)?.cause).toEqual({
        kind: "flashscore_refused",
        settlementOutcome: "manual_extra_time",
      });
      expect(ids).not.toContain(esporteSemCobertura.id);
      expect(rows.find((row) => row.betId === esporteSemCobertura7h.id)?.cause).toEqual({
        kind: "stalled",
        flashscoreOutcome: "unsupported_sport",
        settlementOutcome: null,
      });
    });

    it("jogo vinculado cedo em esporte que o FlashScore não liquida espera as 6 h", async () => {
      // O enrich vincula o jogo antes do apito. A kickoff+90 min a observação
      // fecha sem ver o fim, e o vínculo continua gravado.
      const linkedAndClosed = async (esporte: string, sportId: number, minutes: number) => {
        const bet = await mkAt({ minutes, esporte });
        await linkFlashscoreMatch(db.prisma, bet.id, `fs-${sportId}-${minutes}`);
        await persistFlashscoreObservation({
          bet,
          checkedAt: NOW,
          final: true,
          snapshot: { outcome: "sport_without_terminal_status", sport: esporte, sportId },
        });
        return bet;
      };
      const mma = await linkedAndClosed("MMA", 28, 95);
      const aussieRules = await linkedAndClosed("Aussie Rules", 18, 95);
      const mma7h = await linkedAndClosed("MMA", 28, 7 * 60);

      const rows = await getSettlementManual(NOW);
      const ids = rows.map((row) => row.betId);
      expect(ids).not.toContain(mma.id);
      expect(ids).not.toContain(aussieRules.id);
      expect(rows.find((row) => row.betId === mma7h.id)?.cause).toEqual({
        kind: "stalled",
        flashscoreOutcome: "sport_without_terminal_status",
        settlementOutcome: null,
      });
    });

    it("aposta com sugestão do IA-Judge pendente fica só em Homologar", async () => {
      const comSugestao = await mkAt({ minutes: 8 * 60, mercado: "Total de Escanteios", selecao: "Mais de 9.5" });
      const recusada = await mkAt({ minutes: 9 * 60, mercado: "Total de Escanteios", selecao: "Mais de 9.5" });
      const suggestion = (betId: string, betUpdatedAt: Date, status: "PENDING" | "REJECTED") => ({
        betId,
        betUpdatedAt,
        status,
        suggestedStatus: "WON" as const,
        valueFound: "12",
        confidence: 0.85,
        reason: "12 escanteios",
        evidenceKind: "GROUNDED_WEB" as const,
      });
      await db.prisma.iaJudgeSuggestion.createMany({
        data: [
          suggestion(comSugestao.id, comSugestao.updatedAt, "PENDING"),
          suggestion(recusada.id, recusada.updatedAt, "REJECTED"),
        ],
      });

      const ids = (await getSettlementManual(NOW)).map((row) => row.betId);
      expect(ids).not.toContain(comSugestao.id);
      expect(ids).toContain(recusada.id);
    });
  });
});
