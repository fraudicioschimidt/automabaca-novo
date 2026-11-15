import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approveIaJudgeSuggestion: vi.fn(),
  resolveOperationalActionBySourceKey: vi.fn(),
  sendOperatorNotification: vi.fn(),
}));

vi.mock("@/src/services/settlement/ia-judge/suggestions", () => ({
  approveIaJudgeSuggestion: mocks.approveIaJudgeSuggestion,
}));
vi.mock("@/src/services/ops/operational-actions", () => ({
  resolveOperationalActionBySourceKey: mocks.resolveOperationalActionBySourceKey,
}));
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperatorNotification: mocks.sendOperatorNotification,
}));

import { autoSettleGroundedIaJudgeSuggestion } from "@/src/services/settlement/ia-judge/cycle";

describe("auto-liquidação do IA-Judge", () => {
  it("autoSettleGroundedIaJudgeSuggestion resolve ação operacional com a chave correta", async () => {
    mocks.approveIaJudgeSuggestion.mockResolvedValue({ status: "WON" });
    mocks.resolveOperationalActionBySourceKey.mockResolvedValue(true);
    mocks.sendOperatorNotification.mockResolvedValue(undefined);

    const now = new Date();
    await autoSettleGroundedIaJudgeSuggestion({
      suggestionId: "sug-123",
      current: {
        id: "bet-999",
        evento: "Time A vs Time B",
        mercado: "Match Odds",
        selecao: "Time A",
        bankrollNome: "Principal",
        data: now,
      } as never,
      confidence: 0.99,
      valueFound: "2-0",
      reason: "Validado com fonte oficial",
      sourceUrl: "https://flashscore.com/match/123",
      now,
    });

    expect(mocks.resolveOperationalActionBySourceKey).toHaveBeenCalledWith(
      "settlement.parado",
      "bet-999",
      "Liquidada automaticamente via IA-Judge",
      now,
    );
  });
});
