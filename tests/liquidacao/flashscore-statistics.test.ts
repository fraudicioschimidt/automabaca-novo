import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";
import {
  ESTATISTICAS_VAZIAS,
  processFlashscoreStatisticOutcome,
} from "@/src/services/settlement/flashscore/statistics";

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  settle: vi.fn(),
}));

vi.mock("@/src/services/ops/alerts", () => ({
  sendOperationalAlert: mocks.alert,
}));
vi.mock("@/src/services/settlement/flashscore/settle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/settlement/flashscore/settle")>()),
  settleFlashscoreBet: mocks.settle,
}));


const bet = {
  id: "bet-stat",
  evento: "Athletic Club vs Operario Ferroviario",
  esporte: "Soccer",
  mercado: "Total (Corners) – Match",
  selecao: "Over 8.5",
  odds: 1.9,
  stake: 1,
  data: new Date("2026-07-22T18:00:00Z"),
} as unknown as EligibleBet;

describe("processFlashscoreStatisticOutcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settle.mockResolvedValue(true);
    mocks.alert.mockResolvedValue(true);
  });

  it("espera a graça sem ticket quando o feed ainda não publicou a linha", async () => {
    const result = await processFlashscoreStatisticOutcome({
      bet,
      stats: ESTATISTICAS_VAZIAS,
      statsPeriod: "FT",
      now: new Date("2026-07-22T22:00:00Z"),
      viaInferencia: false,
    });
    expect(result).toMatchObject({
      settled: false,
      observationFinal: false,
      settlementOutcome: "stats_pending",
    });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("depois da graça pede o par de escanteios, não WON/LOST", async () => {
    const result = await processFlashscoreStatisticOutcome({
      bet,
      stats: ESTATISTICAS_VAZIAS,
      statsPeriod: "FT",
      now: new Date("2026-07-23T01:00:00Z"),
      viaInferencia: false,
    });
    expect(result).toMatchObject({
      settled: false,
      unsupported: true,
      observationFinal: true,
      settlementOutcome: "manual_missing_stats",
    });
    expect(mocks.alert).toHaveBeenCalledWith(
      expect.stringMatching(/par de escanteios/),
      expect.objectContaining({
        source: "settlement.flashscore-missing-stats",
        resourceId: "bet-stat",
        evidence: expect.objectContaining({ reason: "missing_stat", statistic: "corners" }),
      }),
    );
    expect(mocks.alert.mock.calls[0]?.[0]).not.toMatch(/WON|LOST|Ganhou|Perdeu/);
  });

  it("chutes sem família abre ticket estatístico em vez de fechar calado", async () => {
    const result = await processFlashscoreStatisticOutcome({
      bet: { ...bet, mercado: "Chutes", selecao: "Athletic Club" },
      stats: ESTATISTICAS_VAZIAS,
      statsPeriod: "FT",
      now: new Date("2026-07-22T22:00:00Z"),
      viaInferencia: false,
    });
    expect(result.settlementOutcome).toBe("manual_unsupported_market");
    expect(mocks.alert).toHaveBeenCalledWith(
      expect.stringMatching(/estatística/),
      expect.objectContaining({ source: "settlement.flashscore-stat-unsupported" }),
    );
  });
});
