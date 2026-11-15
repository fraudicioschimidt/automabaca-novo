import { describe, expect, it } from "vitest";
import { isPermanentNoOddsReason } from "@/src/domain/no-odds-reason";
import { classifyEnrichSkip } from "@/src/services/sharp/enrich/enrich-bet";

describe("classifyEnrichSkip", () => {
  const base = {
    deletedAt: null as Date | null,
    status: "PENDING",
    kickoffInferido: false,
    bankroll: { sharpMode: "CLV_ONLY" },
    sharp: null as {
      identityStatus: string;
      noOddsReason: string | null;
    } | null,
  };

  it("settled / OFF / deleted", () => {
    expect(classifyEnrichSkip({ ...base, status: "WON" })).toBe("settled");
    expect(
      classifyEnrichSkip({
        ...base,
        status: "WON",
        allowSettledIdentityRecovery: true,
      }),
    ).toBeNull();
    expect(classifyEnrichSkip({ ...base, bankroll: { sharpMode: "OFF" } })).toBe("bankroll_off");
    expect(classifyEnrichSkip({ ...base, deletedAt: new Date() })).toBe("deleted");
  });

  it("UNMATCHED/UNSUPPORTED sem kickoffInferido → terminal", () => {
    expect(
      classifyEnrichSkip({
        ...base,
        sharp: { identityStatus: "UNMATCHED", noOddsReason: null },
      }),
    ).toBe("terminal_identity");
    expect(
      classifyEnrichSkip({
        ...base,
        sharp: { identityStatus: "UNSUPPORTED", noOddsReason: null },
      }),
    ).toBe("terminal_identity");
  });

  it("UNMATCHED com kickoffInferido ainda roda (calendário pode corrigir)", () => {
    expect(
      classifyEnrichSkip({
        ...base,
        kickoffInferido: true,
        sharp: { identityStatus: "UNMATCHED", noOddsReason: null },
      }),
    ).toBeNull();
  });

  it("múltipla não volta a caçar um único jogo", () => {
    expect(
      classifyEnrichSkip({
        ...base,
        sharp: { identityStatus: "UNSUPPORTED", noOddsReason: "multipla" },
      }),
    ).toBe("already_enriched");
  });

  it("MATCHED em idle permanente → already_enriched", () => {
    expect(
      classifyEnrichSkip({
        ...base,
        sharp: { identityStatus: "MATCHED", noOddsReason: "sharp_off" },
      }),
    ).toBe("already_enriched");
    expect(
      classifyEnrichSkip({
        ...base,
        sharp: { identityStatus: "MATCHED", noOddsReason: "identity_only" },
      }),
    ).toBe("already_enriched");
    expect(
      classifyEnrichSkip({
        ...base,
        bankroll: { sharpMode: "CLV_ONLY" },
        sharp: { identityStatus: "MATCHED", noOddsReason: "clv_only" },
      }),
    ).toBe("already_enriched");
  });

  it("MATCHED sem preço transitório → segue (pré-Pinnacle)", () => {
    expect(
      classifyEnrichSkip({
        ...base,
        sharp: { identityStatus: "MATCHED", noOddsReason: "sem_linha_atual" },
      }),
    ).toBeNull();
    expect(
      classifyEnrichSkip({
        ...base,
        sharp: { identityStatus: "PENDING", noOddsReason: null },
      }),
    ).toBeNull();
  });

  it("isPermanentNoOddsReason cobre a denylist", () => {
    expect(isPermanentNoOddsReason("sharp_off")).toBe(true);
    expect(isPermanentNoOddsReason("clv_only")).toBe(true);
    expect(isPermanentNoOddsReason("identity_only")).toBe(true);
    expect(isPermanentNoOddsReason("no_prices")).toBe(false);
  });
});
