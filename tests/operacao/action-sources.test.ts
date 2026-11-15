import { describe, expect, it } from "vitest";
import { stalledSettlementText } from "@/src/services/ops/action-sources";

describe("stalledSettlementText", () => {
  const text = (flashscoreOutcome: string | null) => stalledSettlementText({ sportConfirmed: true, flashscoreOutcome });

  it("explica a parada pelo FlashScore, que liquida sem identidade sharp", () => {
    expect(text("below_threshold")).toMatch(/FlashScore não achou o jogo/);
    expect(text("matched")).toMatch(/FlashScore casou/);
    expect(text("unsupported_sport")).toMatch(/não liquida este esporte/);
    // Sem observação gravada, a culpa não é da identidade sharp.
    expect(text(null)).toMatch(/ainda não observou este jogo/);
    expect(text(null)).not.toMatch(/identidade/i);
  });

  it("esporte não confirmado: o FlashScore nunca vai observar, e o texto não promete que vai", () => {
    const unconfirmed = stalledSettlementText({ sportConfirmed: false, flashscoreOutcome: null });
    expect(unconfirmed).toMatch(/esporte não foi confirmado/);
    expect(unconfirmed).not.toMatch(/ainda não observou/);
  });
});
