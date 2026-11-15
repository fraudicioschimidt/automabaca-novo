import { describe, expect, it } from "vitest";
import { BRIDGE_CATALOG_TTL_MS } from "@/src/providers/bridgeodds/catalog";
import {
  CADENCIA_HISTORICAL_MS,
  CADENCIA_LONGE_MS,
  CADENCIA_PERTO_MS,
  reviveCadenciaMs,
} from "@/src/domain/enrich-cadence";

describe("enrich-cadence", () => {
  it("reviveCadenciaMs: perto, longe e histórico", () => {
    expect(reviveCadenciaMs(true)).toBe(CADENCIA_PERTO_MS);
    expect(reviveCadenciaMs(false)).toBe(CADENCIA_LONGE_MS);
    expect(reviveCadenciaMs(true, true)).toBe(CADENCIA_HISTORICAL_MS);
  });

  it("nenhuma cadência é mais curta que o TTL do catálogo", () => {
    // Tentar antes de o catálogo expirar relê a MESMA lista em memória: gasta CPU
    // e não traz informação nova. O TTL é o piso natural da cadência.
    for (const ms of [CADENCIA_PERTO_MS, CADENCIA_LONGE_MS]) {
      expect(ms).toBeGreaterThanOrEqual(BRIDGE_CATALOG_TTL_MS);
    }
  });

  it("ordem preservada: perto do kickoff tenta mais que longe; histórico por último", () => {
    expect(CADENCIA_PERTO_MS).toBeLessThan(CADENCIA_LONGE_MS);
    expect(CADENCIA_HISTORICAL_MS).toBeGreaterThan(CADENCIA_LONGE_MS);
  });
});
