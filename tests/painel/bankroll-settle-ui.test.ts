import { describe, expect, it } from "vitest";
import { computeOverride } from "@/app/_design/screens/bankroll/settle";

describe("override visual de settlement", () => {
  const bet = { stake: 0.333333, odds: 1.95 };

  it("usa a mesma precisão de seis casas do domínio no modo local", () => {
    expect(computeOverride(bet, "won").profit).toBe(0.316666);
    expect(computeOverride(bet, "half", undefined).profit).toBe(-0.166667);
  });

  it("prefere o lucro normalizado confirmado pelo servidor", () => {
    expect(computeOverride(bet, "cashout", 0.1234567, 0.123457)).toEqual({
      status: "cashout",
      profit: 0.123457,
    });
  });

  it("recusa cashout local fora do intervalo financeiro da aposta", () => {
    expect(() => computeOverride(bet, "cashout", 1)).toThrow(/intervalo possível/i);
  });
});
