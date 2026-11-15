import { describe, expect, it } from "vitest";
import { computeLucroFromStatus } from "@/src/domain/lucro";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { statusFromAdjustedQuarters } from "@/src/domain/settlement/lines";
import { foldLegStatuses } from "@/src/domain/bet-legs";
import { resolveCapturePolicy } from "@/src/domain/capture-policy";
import { isActiveOperationalActionStatus } from "@/src/domain/operational-action-status";
import type { BetStatus } from "@/src/domain/bet-status";

describe("domínio com literais puros, sem tipos do Prisma", () => {
  it("computeLucroFromStatus works with pure string literals", () => {
    const wonStatus: BetStatus = "WON";
    const lostStatus: BetStatus = "LOST";
    const halfWonStatus: BetStatus = "HALF_WON";
    const halfLostStatus: BetStatus = "HALF_LOST";
    const pendingStatus: BetStatus = "PENDING";
    const voidStatus: BetStatus = "VOID";
    const canceledStatus: BetStatus = "CANCELED";
    const cashoutStatus: BetStatus = "CASHOUT";

    expect(computeLucroFromStatus({ status: wonStatus, stake: 10, odds: 2.5 })).toBe(15);
    expect(computeLucroFromStatus({ status: lostStatus, stake: 10, odds: 2.5 })).toBe(-10);
    expect(computeLucroFromStatus({ status: halfWonStatus, stake: 10, odds: 2.5 })).toBe(7.5);
    expect(computeLucroFromStatus({ status: halfLostStatus, stake: 10, odds: 2.5 })).toBe(-5);
    expect(computeLucroFromStatus({ status: pendingStatus, stake: 10, odds: 2.5 })).toBe(0);
    expect(computeLucroFromStatus({ status: voidStatus, stake: 10, odds: 2.5 })).toBe(0);
    expect(computeLucroFromStatus({ status: canceledStatus, stake: 10, odds: 2.5 })).toBe(0);
    expect(computeLucroFromStatus({ status: cashoutStatus, stake: 10, odds: 2.5, currentLucro: 3 })).toBe(3);
  });

  it("statusFromAdjustedQuarters returns pure string literals", () => {
    expect(statusFromAdjustedQuarters(0)).toBe("VOID");
    expect(statusFromAdjustedQuarters(1)).toBe("HALF_WON");
    expect(statusFromAdjustedQuarters(-1)).toBe("HALF_LOST");
    expect(statusFromAdjustedQuarters(2)).toBe("WON");
    expect(statusFromAdjustedQuarters(-2)).toBe("LOST");
  });

  it("resolveResultFromScore resolves to pure string literal status", () => {
    const res = resolveResultFromScore({
      mercado: "Moneyline",
      selecao: "Flamengo",
      evento: "Flamengo vs Vasco",
      homeScore: 2,
      awayScore: 1,
      odds: 2.0,
      stake: 1,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe("WON");
      expect(res.lucro).toBe(1);
    }
  });

  it("foldLegStatuses works with pure string literals", () => {
    expect(foldLegStatuses([])).toEqual({ ok: false, reason: "incomplete" });
    expect(foldLegStatuses(["WON", "WON"])).toEqual({ ok: true, status: "WON" });
    expect(foldLegStatuses(["WON", "LOST"])).toEqual({ ok: true, status: "LOST" });
    expect(foldLegStatuses(["WON", "PENDING"])).toEqual({ ok: false, reason: "needs_review" });
  });

  it("resolveCapturePolicy works with pure domain literals", () => {
    expect(resolveCapturePolicy("CAPTION_ODD", "1u @1.90")).toEqual({
      captionOddAuthoritative: true,
      requireCaptionOdd: true,
    });
    expect(resolveCapturePolicy("IMAGE_ODD", "1u @1.90")).toEqual({
      captionOddAuthoritative: false,
      requireCaptionOdd: false,
    });
  });

  it("isActiveOperationalActionStatus checks status strings", () => {
    expect(isActiveOperationalActionStatus("OPEN")).toBe(true);
    expect(isActiveOperationalActionStatus("ACKED")).toBe(true);
    expect(isActiveOperationalActionStatus("RUNNING")).toBe(true);
    expect(isActiveOperationalActionStatus("RESOLVED")).toBe(false);
  });
});