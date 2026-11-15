import { describe, expect, it } from "vitest";
import { allowsSettlementWithoutConfirmedSport } from "@/src/services/bets/settle";

describe("allowsSettlementWithoutConfirmedSport", () => {
  it("libera só VOID/CANCELED manuais; recusa placar automático e o antigo marcador do tipster", () => {
    expect(allowsSettlementWithoutConfirmedSport("WON", "telegram-edit")).toBe(false);
    expect(allowsSettlementWithoutConfirmedSport("VOID", "telegram-edit")).toBe(false);
    expect(allowsSettlementWithoutConfirmedSport("VOID", "manual")).toBe(true);
    expect(allowsSettlementWithoutConfirmedSport("CANCELED", "manual:ui")).toBe(true);
    expect(allowsSettlementWithoutConfirmedSport("WON", "score")).toBe(false);
    expect(allowsSettlementWithoutConfirmedSport("WON", "flashscore")).toBe(false);
    expect(allowsSettlementWithoutConfirmedSport("CASHOUT", "telegram-edit")).toBe(false);
  });
});
