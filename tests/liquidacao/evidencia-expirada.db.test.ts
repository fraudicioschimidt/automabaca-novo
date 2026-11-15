import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BetStatus } from "@/src/generated/prisma/enums";
import { toNumber } from "@/src/domain/money";
import { resolveTicketFromScore, type EligibleBet } from "@/src/domain/settlement/ticket-resolution";
import { registerBet } from "@/src/services/bets/register";
import { purgeOldAuditEvents } from "@/src/services/ops/audit-purge";
import { getBetDetail } from "@/src/services/painel/queries/bet-rows";
import { eligibleBetSelect } from "@/src/services/sharp/closing/sync";
import { toBet } from "@/app/_design/adapters/aposta";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * A evidência bruta da captura (legenda, parse) vive 30 dias. Liquidação e
 * ficha continuam decidindo igual depois da purga: o que decide dinheiro fica
 * gravado na própria aposta.
 */

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
beforeEach(async () => { await db.reset(); });
afterAll(async () => db.dispose());

const KICKOFF = new Date("2026-06-15T19:00:00Z");
const DEPOIS_DA_RETENCAO = () => new Date(Date.now() + 31 * 86_400_000);

async function capturar(params: { mercado: string; selecao: string; caption: string }) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Evidência", slug: "evidencia", valorUnidade: 100 },
  });
  const result = await registerBet({
    bankrollId: bankroll.id, data: KICKOFF, evento: "Flamengo vs Palmeiras", esporte: "Soccer",
    mercado: params.mercado, selecao: params.selecao, odds: 1.9, stake: 1, casaDeAposta: "Betano",
    source: "telegram-channel:-100123", sourceExternalId: "777", actor: "teste",
    captureEvidence: { parser: "universal", caption: params.caption, parsed: { selecao: params.selecao } },
  }, { client: db.prisma });
  return result.betId;
}

async function lerParaLiquidar(betId: string) {
  return db.prisma.bet.findUniqueOrThrow({ where: { id: betId }, select: eligibleBetSelect }) as unknown as Promise<EligibleBet>;
}

async function purgarEvidencia() {
  const { deletedCaptureEvidence } = await purgeOldAuditEvents(DEPOIS_DA_RETENCAO());
  expect(deletedCaptureEvidence).toBe(1);
}

function liquidar(bet: EligibleBet, score: Omit<Parameters<typeof resolveTicketFromScore>[1], "odds" | "stake">) {
  return resolveTicketFromScore(bet, { ...score, odds: toNumber(bet.odds), stake: toNumber(bet.stake) });
}

describe("liquidação depois da purga da evidência de captura", () => {
  it("handicap ao vivo em 1-0 continua pagando pelo restante do jogo", async () => {
    const betId = await capturar({
      mercado: "Asian Handicap", selecao: "Flamengo -0.5", caption: "Entrada: (1-0) Flamengo -0.5",
    });
    await purgarEvidencia();

    // Final 2-1: depois da entrada ficou 1-1, e o -0.5 perde. Pelo jogo inteiro ganharia.
    expect(liquidar(await lerParaLiquidar(betId), { homeScore: 2, awayScore: 1 }))
      .toMatchObject({ ok: true, status: BetStatus.LOST });
  });

  it("legenda que dizia ao vivo continua barrando o handicap de 1º tempo", async () => {
    const betId = await capturar({
      mercado: "Handicap Asiático - 1º Tempo", selecao: "Flamengo -0.5",
      caption: "Entrada ao vivo\nFlamengo -0.5 1º tempo",
    });
    const tempos = { homeScore: 2, awayScore: 0, periodScores: { ht: { home: 1, away: 0 }, sh: { home: 1, away: 0 } } };
    // Sem o placar da entrada, o restante do 1º tempo não se deduz.
    expect(liquidar(await lerParaLiquidar(betId), tempos))
      .toEqual({ ok: false, reason: "unsupported_live_score" });

    await purgarEvidencia();

    expect(liquidar(await lerParaLiquidar(betId), tempos))
      .toEqual({ ok: false, reason: "unsupported_live_score" });
  });
});

describe("ficha depois da purga da evidência de captura", () => {
  it("mostra o 0-0 da entrada ao vivo gravado na aposta", async () => {
    const betId = await capturar({
      mercado: "Asian Handicap", selecao: "Flamengo -0.5", caption: "Entrada: (0-0) Flamengo -0.5",
    });
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }))
      .resolves.toMatchObject({ liveScoreHome: 0, liveScoreAway: 0 });
    await purgarEvidencia();

    const row = await getBetDetail(betId);
    expect(row && toBet(row).d.liveScoreAtTip).toBe("0-0");
  });
});
