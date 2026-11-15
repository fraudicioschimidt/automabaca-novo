import { describe, expect, it } from "vitest";
import {
  AUTO_MATCH_MIN_GAP,
  autoMatchAmbiguous,
} from "@/src/services/sharp/enrich/training-cases";
import type { BridgeMatchCandidate } from "@/src/providers/bridgeodds/scoring";

function cand(score: number, matchId: number): BridgeMatchCandidate {
  return {
    score,
    swapped: false,
    match: {
      match_id: matchId,
      home: `Home${matchId}`,
      away: `Away${matchId}`,
      sport: "Futebol",
      league: "Test",
      match_date: "2026-07-10T15:00:00Z",
      home_score: null,
      away_score: null,
    },
  };
}

describe("autoMatchAmbiguous", () => {
  it("gap < 0.1 com ambos acima do piso típico → ambíguo", () => {
    expect(autoMatchAmbiguous([cand(1.85, 1), cand(1.8, 2)])).toBe(true);
    expect(AUTO_MATCH_MIN_GAP).toBe(0.1);
  });

  it("gap ≥ 0.1 → não ambíguo", () => {
    expect(autoMatchAmbiguous([cand(1.9, 1), cand(1.7, 2)])).toBe(false);
  });

  it("um só candidato → não ambíguo", () => {
    expect(autoMatchAmbiguous([cand(2.0, 1)])).toBe(false);
  });
});
