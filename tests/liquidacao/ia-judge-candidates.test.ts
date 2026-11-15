import { describe, expect, it } from "vitest";
import {
  FAILURE_COOLDOWN_MS,
  QUOTA_COOLDOWN_MS,
  UNRESOLVED_COOLDOWN_MS,
  formatCooldownHours,
  retryCooldownMs,
} from "@/src/services/settlement/ia-judge/candidates";

const HOUR_MS = 3_600_000;

describe("duração exibida do IA-Judge", () => {
  it("deriva o texto das constantes canônicas", () => {
    expect(formatCooldownHours(QUOTA_COOLDOWN_MS)).toBe("6h");
    expect(formatCooldownHours(FAILURE_COOLDOWN_MS)).toBe("24h");
    expect(formatCooldownHours(UNRESOLVED_COOLDOWN_MS)).toBe("3h");
    expect(formatCooldownHours(QUOTA_COOLDOWN_MS)).toBe(`${QUOTA_COOLDOWN_MS / HOUR_MS}h`);
    expect(formatCooldownHours(FAILURE_COOLDOWN_MS)).toBe(`${FAILURE_COOLDOWN_MS / HOUR_MS}h`);
  });

  it("recusa duração que não é hora inteira positiva", () => {
    expect(() => formatCooldownHours(90_000)).toThrow(/inválida/);
    expect(() => formatCooldownHours(0)).toThrow(/inválida/);
    expect(() => formatCooldownHours(-HOUR_MS)).toThrow(/inválida/);
  });
});

describe("espera até a próxima busca de uma aposta sem resposta", () => {
  const kickoff = new Date("2026-09-01T12:00:00Z");
  const after = (hours: number) => new Date(kickoff.getTime() + hours * HOUR_MS);

  it("sem resultado na web: tenta de novo no mesmo dia só no primeiro dia, depois espaça", () => {
    expect(retryCooldownMs("unresolved", kickoff, after(8))).toBe(3 * HOUR_MS);
    expect(retryCooldownMs("unresolved", kickoff, after(23))).toBe(3 * HOUR_MS);
    expect(retryCooldownMs("unresolved", kickoff, after(24))).toBe(12 * HOUR_MS);
    expect(retryCooldownMs("unresolved", kickoff, after(71))).toBe(12 * HOUR_MS);
    expect(retryCooldownMs("unresolved", kickoff, after(72))).toBe(24 * HOUR_MS);
    expect(retryCooldownMs("unresolved", kickoff, after(167))).toBe(24 * HOUR_MS);
    expect(retryCooldownMs("unresolved", kickoff, after(168))).toBe(72 * HOUR_MS);
    expect(retryCooldownMs("unresolved", kickoff, after(29 * 24))).toBe(72 * HOUR_MS);
  });

  it("sem confiança: nunca menos de 24h, e 72h depois da primeira semana", () => {
    expect(retryCooldownMs("low_confidence", kickoff, after(8))).toBe(FAILURE_COOLDOWN_MS);
    expect(retryCooldownMs("low_confidence", kickoff, after(48))).toBe(FAILURE_COOLDOWN_MS);
    expect(retryCooldownMs("low_confidence", kickoff, after(100))).toBe(FAILURE_COOLDOWN_MS);
    expect(retryCooldownMs("low_confidence", kickoff, after(168))).toBe(72 * HOUR_MS);
  });
});
