import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClosingGuard from "@/src/services/sharp/closing-guard";
import type { ClosingSyncBet } from "@/src/services/sharp/closing/types";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  findById: vi.fn(),
  find: vi.fn(),
  bridgeClv: vi.fn(),
  writeOnce: vi.fn(async () => true),
}));

vi.mock("@/src/services/sharp/closing/pinnacle17-snapshot", () => ({
  snapshotClosingForBet: mocks.snapshot,
}));
vi.mock("@/src/infra/env", () => ({
  getEnv: () => ({ SHARP_AUTO_MATCH_MIN_SCORE: 1.5 }),
}));
vi.mock("@/src/infra/prisma", () => ({
  prisma: { bet: { updateMany: vi.fn(async () => ({ count: 1 })) } },
}));
vi.mock("@/src/services/sharp/enrich/identity-cache", () => ({
  applyTeamAliases: async (teams: { home: string; away: string }) => teams,
}));
vi.mock("@/src/providers/bridgeodds/match", () => ({
  findBridgeMatchById: mocks.findById,
  findBridgeMatchByIdWithEvidence: async (...args: unknown[]) => {
    const match = await mocks.findById(...args);
    return match
      ? { match, observedAt: new Date("2026-07-22T22:00:00Z") }
      : null;
  },
  findBridgeMatch: mocks.find,
}));
vi.mock("@/src/providers/bridgeodds/snapshot-cache", () => ({
  writeBridgeMatchSnapshot: async (params: { match: unknown; observedAt?: Date }) => ({
    match: params.match,
    observedAt: params.observedAt ?? new Date("2026-07-22T22:00:00Z"),
  }),
}));
vi.mock("@/src/services/sharp/closing/bridge-clv", () => ({
  processBridgeClv: mocks.bridgeClv,
}));
vi.mock("@/src/services/sharp/closing-guard", async (original) => ({
  ...await original<typeof ClosingGuard>(),
  writeClosingOnce: mocks.writeOnce,
}));

import {
  processBridgeClosing,
  processNonBridgeClosing,
} from "@/src/services/sharp/closing/process-bet";
import { shouldUseBridgeClosing } from "@/src/services/sharp/closing/sync";

const bet = {
  id: "closing-1",
  evento: "A vs B",
  esporte: "Soccer",
  competicao: "Liga",
  pais: "BR",
  mercado: "Total – Match",
  selecao: "Under 2.5",
  odds: 1.9,
  stake: 1,
  status: "PENDING",
  data: new Date("2026-07-22T18:00:00Z"),
  registradoEm: new Date("2026-07-22T17:00:00Z"),
  kickoffInferido: false,
  liveTextAtCapture: false,
  sharp: { provider: "pinnacle17", providerMatchId: "x" },
  closing: {
    fetchedAt: new Date("2026-07-22T18:00:20Z"),
    clv: 2,
    closingOdd: 1.85,
  },
} satisfies ClosingSyncBet;

describe("fronteira entre closing e resultado", () => {
  beforeEach(() => vi.clearAllMocks());

  it("não consulta provider nem liquida quando o CLV não precisa de captura", async () => {
    const result = await processNonBridgeClosing(
      bet,
      {},
      new Date("2026-07-22T22:00:00Z"),
      false,
    );

    expect(result).toEqual({ closed: false });
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it("mantém o snapshot de CLV dos providers não-Bridge", async () => {
    mocks.snapshot.mockResolvedValue({ closed: true });
    const result = await processNonBridgeClosing(
      { ...bet, closing: null },
      {},
      new Date("2026-07-22T17:50:00Z"),
      false,
    );

    expect(result).toEqual({ closed: true });
    expect(mocks.snapshot).toHaveBeenCalledOnce();
  });

  it("preserva Pinnacle17 no closing mesmo dentro da matriz BridgeOdds", () => {
    expect(shouldUseBridgeClosing({
      persistedProvider: "pinnacle17",
      bridgeAuthoritative: true,
    })).toBe(false);
    expect(shouldUseBridgeClosing({
      persistedProvider: "bridgeodds",
      bridgeAuthoritative: false,
    })).toBe(true);
  });

  it("usa BridgeOdds para CLV, mas ignora qualquer placar do payload", async () => {
    const bridgeBet: ClosingSyncBet = {
      ...bet,
      sharp: { provider: "bridgeodds", providerMatchId: "bridge-1" },
      closing: null,
    };
    mocks.findById.mockResolvedValue({
      match_id: 1,
      home: "A",
      away: "B",
      home_score: 2,
      away_score: 0,
    });
    mocks.bridgeClv.mockResolvedValue(true);

    const result = await processBridgeClosing(
      bridgeBet,
      {},
      new Date("2026-07-22T22:00:00Z"),
    );

    expect(result).toEqual({ closed: true });
    expect(mocks.bridgeClv).toHaveBeenCalledOnce();
  });

  it("segmento SHARP_OFF congela a aposta da Bridge sem consultar a Bridge", async () => {
    const bridgeBet: ClosingSyncBet = {
      ...bet,
      sharp: { provider: "bridgeodds", providerMatchId: "bridge-1" },
      closing: null,
    };
    const now = new Date("2026-07-22T18:05:00Z");

    await expect(processBridgeClosing(bridgeBet, {}, now, true)).resolves.toEqual({ closed: true });

    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.bridgeClv).not.toHaveBeenCalled();
    expect(mocks.writeOnce).toHaveBeenCalledWith(bridgeBet, "fetchedAt", expect.objectContaining({
      clvReliable: false,
      noOddsReason: "sharp_off",
      fetchedAt: now,
    }));
  });

  it("não troca de fixture quando o ID Bridge salvo deixa de resolver", async () => {
    const bridgeBet: ClosingSyncBet = {
      ...bet,
      sharp: { provider: "bridgeodds", providerMatchId: "bridge-salvo" },
      closing: null,
    };
    mocks.findById.mockResolvedValue(null);
    mocks.find.mockResolvedValue({
      ok: true,
      best: { score: 99, match: { match_id: "outro-fixture" } },
      candidates: [{ score: 99, match: { match_id: "outro-fixture" } }],
    });

    const result = await processBridgeClosing(
      bridgeBet,
      {},
      new Date("2026-07-22T22:00:00Z"),
    );

    expect(result).toEqual({ closed: false });
    expect(mocks.find).toHaveBeenCalledOnce();
    expect(mocks.bridgeClv).not.toHaveBeenCalled();
  });

  it("ignora ID de outro provider ao migrar closing coberto para BridgeOdds", async () => {
    const legacyBet: ClosingSyncBet = {
      ...bet,
      sharp: { provider: "pinnacle17", providerMatchId: "987654" },
      closing: null,
    };
    mocks.find.mockResolvedValue({
      ok: true,
      best: { score: 2, match: { match_id: 77, home: "A", away: "B", league: "BR - Liga" } },
      candidates: [],
      stalePrices: false,
      priceObservedAt: new Date("2026-07-22T22:00:00Z"),
    });
    mocks.bridgeClv.mockResolvedValue(true);

    await expect(processBridgeClosing(
      legacyBet,
      {},
      new Date("2026-07-22T22:00:00Z"),
    )).resolves.toEqual({ closed: true });

    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.find).toHaveBeenCalledOnce();
    expect(mocks.bridgeClv).toHaveBeenCalledOnce();
  });
});
