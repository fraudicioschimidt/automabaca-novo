import { beforeEach, expect, it, vi } from "vitest";
import type { ApplyIdentityResult } from "@/src/services/sharp/enrich/apply-identity";
import type { SharpIdentityOutcome } from "@/src/services/sharp/enrich/sharp-identity";

const mocks = vi.hoisted(() => ({
  bet: vi.fn(), identity: vi.fn(), applyIdentity: vi.fn(), upsert: vi.fn(), watch: vi.fn(), closingReference: vi.fn(),
}));
vi.mock("@/src/services/sharp/enrich/pinnacle17-identity", () => ({ tryClosingReferenceFallback: mocks.closingReference }));
vi.mock("@/src/infra/prisma", () => ({ prisma: { bet: { findUnique: mocks.bet }, betSharp: { findUnique: async () => ({ noOddsReason: null }) } } }));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => null }));
vi.mock("@/src/services/sharp/enrich/sharp-identity", () => ({ resolveSharpIdentity: mocks.identity }));
vi.mock("@/src/services/sharp/enrich/apply-identity", () => ({
  applyBridgeIdentity: mocks.applyIdentity,
  bridgeMatchGameStart: async () => null,
}));
vi.mock("@/src/services/sharp/enrich/upsert-sharp", () => ({ upsertSharp: mocks.upsert, markEnrichDeadLettered: vi.fn() }));
vi.mock("@/src/services/sharp/enrich/kickoff-provisional", () => ({ resolveProvisionalKickoff: async () => {} }));
vi.mock("@/src/services/sharp/enrich/resolve-kickoff-flashscore", () => ({ linkEarlyFlashscoreMatch: async () => {} }));
vi.mock("@/src/services/sharp/enrich/training-cases", () => ({ recordTrainingFailure: vi.fn(), closeOpenTrainingCase: vi.fn() }));
vi.mock("@/src/services/sharp/segment-policy", () => ({ isSegmentSharpOff: async () => false }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperatorNotification: async () => {} }));
vi.mock("@/src/services/sharp/closing/series", () => ({ ensureClosingWatch: mocks.watch }));

import { enrichBetSharp } from "@/src/services/sharp/enrich/enrich-bet";

beforeEach(() => { vi.clearAllMocks(); });

// A banca CLV_ONLY grava só a identidade, e a idade da tip não muda isso: o
// preço fica todo para o fechamento.
it.each([false, true])("grava só identidade, com termos canônicos (tip antiga=%s)", async (oldEntry) => {
  const now = new Date();
  const kickoff = new Date(now.getTime() + 86_400_000);
  const entry = new Date(now.getTime() - (oldEntry ? 3_600_000 : 10_000));
  const bet = {
    id: "synthetic-bet", evento: "Inter de Milão vs Udinese", esporte: "Soccer",
    mercado: "Moneyline", selecao: "Inter de Milão", competicao: "", pais: "",
    odds: 1.9, data: kickoff, registradoEm: now, sourcePostedAt: entry,
    deletedAt: null, status: "PENDING", sportResolutionStatus: "CONFIRMED",
    kickoffInferido: false, legsJson: null, sharp: null,
    bankroll: { sharpMode: "CLV_ONLY" },
  };
  const match = {
    match_id: 12345, home: "Internazionale", away: "Udinese", sport: "Futebol",
    league: "Italy - Serie A", match_date: kickoff.toISOString(),
    moneyline: { closing: { home: 1.8, draw: 3.5, away: 4.5, max_bet: 100 } },
  };
  const applied: ApplyIdentityResult = {
    esporteCanonico: "Soccer", competicao: "Serie A", pais: "Italy",
    mercado: "Money Line – Match", selecao: "Internazionale",
    data: kickoff, kickoff, kickoffValido: true, kickoffInferido: false,
  };
  mocks.bet.mockResolvedValue(bet);
  mocks.applyIdentity.mockResolvedValue(applied);
  mocks.identity.mockResolvedValue({
    status: "bridge_resolved", result: {
      best: { match, score: 2, swapped: false }, provider: "bridgeodds", via: "AUTO",
      cached: false, teams: { home: "Inter de Milão", away: "Udinese" },
      aliased: {}, confidence: 100, judgeConfidence: null,
      priceFresh: true, priceObservedAt: now, segmentOff: false,
    },
  } as SharpIdentityOutcome);

  await enrichBetSharp({ betId: bet.id }, { now });
  expect(mocks.upsert).toHaveBeenCalledWith(bet.id, expect.objectContaining({
    identityStatus: "MATCHED", providerMatchId: "12345", priceReference: null, noOddsReason: "clv_only",
  }));
  expect(bet.sourcePostedAt).toBe(entry);
  expect(bet.odds).toBe(1.9);
});

it("identidade confirmada pela Pinnacle17 cria a agenda do fechamento", async () => {
  const now = new Date();
  const kickoff = new Date(now.getTime() + 86_400_000);
  const bet = {
    id: "synthetic-watch", evento: "Alpha vs Beta", esporte: "Soccer",
    mercado: "Money Line – Match", selecao: "Alpha", competicao: "", pais: "",
    odds: 2.1, data: kickoff, registradoEm: now, sourcePostedAt: now,
    deletedAt: null, status: "PENDING", sportResolutionStatus: "CONFIRMED",
    kickoffInferido: false, legsJson: null, sharp: null,
    bankroll: { sharpMode: "CLV_ONLY" },
  };
  mocks.bet.mockResolvedValue(bet);
  mocks.identity.mockResolvedValue({ status: "pinnacle17_resolved" } as SharpIdentityOutcome);
  const boss = { send: vi.fn() };

  await enrichBetSharp({ betId: bet.id }, { now, boss: boss as never });
  expect(mocks.watch).toHaveBeenCalledExactlyOnceWith(bet.id, boss, now);
  expect(boss.send).not.toHaveBeenCalled();
});

/** Aposta já casada pela Bridge (aqui, pelo Vincular), com o jogo ainda por começar. */
function linkedBet(over: { mercado: string; selecao: string; noOddsReason: string | null }) {
  const now = new Date();
  return {
    id: "synthetic-linked", evento: "Alpha vs Beta", esporte: "Soccer",
    mercado: over.mercado, selecao: over.selecao, competicao: "Serie A", pais: "Brazil",
    odds: 1.9, data: new Date(now.getTime() + 86_400_000), registradoEm: now, sourcePostedAt: now,
    deletedAt: null, status: "PENDING", sportResolutionStatus: "CONFIRMED",
    kickoffInferido: false, legsJson: null,
    sharp: { identityStatus: "MANUAL", provider: "bridgeodds", providerMatchId: "777", confidence: 100, noOddsReason: over.noOddsReason },
    bankroll: { sharpMode: "CLV_ONLY" },
  };
}

it("vinculada num mercado que a Bridge não precifica: busca a referência da Pinnacle17 pelo id e agenda o fechamento", async () => {
  const bet = linkedBet({ mercado: "Total (Corners) – Match", selecao: "Over 9.5", noOddsReason: null });
  mocks.bet.mockResolvedValue(bet);
  mocks.closingReference.mockResolvedValue({ done: true });

  await enrichBetSharp({ betId: bet.id }, { now: new Date(), boss: { send: vi.fn() } as never });

  expect(mocks.closingReference).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    betId: bet.id, matchId: 777, home: "Alpha", away: "Beta", kickoffUtc: bet.data,
  }));
  expect(mocks.identity).not.toHaveBeenCalled();
  expect(mocks.watch).toHaveBeenCalledOnce();
});

it("a Pinnacle17 ainda sem a linha: fica o motivo dela, que deixa a aposta tentar de novo", async () => {
  const bet = linkedBet({ mercado: "Total (Corners) – Match", selecao: "Over 9.5", noOddsReason: "market_not_listed" });
  mocks.bet.mockResolvedValue(bet);
  mocks.closingReference.mockResolvedValue({ done: false, reason: "market_not_listed" });

  await enrichBetSharp({ betId: bet.id }, { now: new Date() });

  expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith(bet.id, { identityStatus: "MATCHED", confidence: 100, noOddsReason: "market_not_listed" });
});

it("vinculada num mercado que a Bridge precifica: fecha pela Bridge, sem consultar a Pinnacle17", async () => {
  const bet = linkedBet({ mercado: "Total – Match", selecao: "Over 2.5", noOddsReason: null });
  mocks.bet.mockResolvedValue(bet);

  await enrichBetSharp({ betId: bet.id }, { now: new Date() });

  expect(mocks.closingReference).not.toHaveBeenCalled();
  expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith(bet.id, { identityStatus: "MATCHED", confidence: 100, noOddsReason: "clv_only" });
});
