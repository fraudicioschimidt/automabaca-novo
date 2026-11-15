import { describe, expect, it } from "vitest";
import { judgeKickoffWindow } from "@/src/domain/settlement/eligibility";

/**
 * Janela do IA-Judge: antes de 6h o resultado pode não estar publicado; depois
 * de 30 dias a tip parada é caso para revisão humana, não para gastar busca.
 */
describe("judgeKickoffWindow", () => {
  const ref = new Date("2026-07-25T18:00:00Z");

  it("exige 6h desde o kickoff e limita a 30 dias", () => {
    const { maxKickoff, minKickoff } = judgeKickoffWindow(ref);
    expect(maxKickoff.toISOString()).toBe("2026-07-25T12:00:00.000Z");
    expect(minKickoff.toISOString()).toBe("2026-06-25T18:00:00.000Z");
  });

  it("a janela é sempre um intervalo válido", () => {
    const { maxKickoff, minKickoff } = judgeKickoffWindow(ref);
    expect(minKickoff.getTime()).toBeLessThan(maxKickoff.getTime());
  });
});
