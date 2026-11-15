import { describe, expect, it } from "vitest";
import { queuedEnrichBetId } from "@/src/services/sharp/revive";

describe("queuedEnrichBetId", () => {
  it("usa o betId autoritativo do payload quando diverge da singleton legada", () => {
    expect(queuedEnrichBetId({
      singletonKey: "bet:antiga",
      data: { betId: "atual" },
    })).toBe("atual");
  });

  it("aceita singleton bet: apenas como fallback para payload legado", () => {
    expect(queuedEnrichBetId({ singletonKey: "bet:legada", data: {} })).toBe("legada");
    expect(queuedEnrichBetId({ singletonKey: "outra-chave", data: null })).toBeNull();
  });
});
