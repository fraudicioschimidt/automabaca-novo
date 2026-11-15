import { describe, expect, it } from "vitest";
import { admitsAsianFractionalSettlement } from "@/src/domain/settlement/half-guard";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";

describe("SET-001 — Guarda de HALF em Mercados Binários vs Asiáticos", () => {
  it("rejeita mercados puramente binários (1X2, Moneyline, Resultado Final, Vencedor)", () => {
    expect(admitsAsianFractionalSettlement("1X2", "Flamengo")).toBe(false);
    expect(admitsAsianFractionalSettlement("Vencedor do Encontro", "Flamengo")).toBe(false);
    expect(admitsAsianFractionalSettlement("Resultado Final", "Empate")).toBe(false);
    expect(admitsAsianFractionalSettlement("Moneyline", "Palmeiras")).toBe(false);
    expect(admitsAsianFractionalSettlement("Match Winner", "Team A")).toBe(false);
  });

  it("rejeita mercados binários de Ambas Marcam (BTTS)", () => {
    expect(admitsAsianFractionalSettlement("Ambas Marcam", "Sim")).toBe(false);
    expect(admitsAsianFractionalSettlement("Both Teams To Score", "Yes")).toBe(false);
    expect(admitsAsianFractionalSettlement("Ambas Equipes Marcam", "Não")).toBe(false);
  });

  it("rejeita mercados de Dupla Chance e Draw No Bet", () => {
    expect(admitsAsianFractionalSettlement("Dupla Chance", "1X")).toBe(false);
    expect(admitsAsianFractionalSettlement("Empate Anula", "Flamengo")).toBe(false);
    expect(admitsAsianFractionalSettlement("Draw No Bet", "Flamengo DNB")).toBe(false);
  });

  it("admite linhas asiáticas de quarto (quarter lines)", () => {
    expect(admitsAsianFractionalSettlement("Handicap Asiático", "Flamengo -0.25")).toBe(true);
    expect(admitsAsianFractionalSettlement("Handicap Asiático", "Palmeiras +0.75")).toBe(true);
    expect(admitsAsianFractionalSettlement("Handicap Asiático", "Flamengo 0, -0.5")).toBe(true);
    expect(admitsAsianFractionalSettlement("Total de Gols", "Over 2.25")).toBe(true);
    expect(admitsAsianFractionalSettlement("Total de Gols", "Under 1.75")).toBe(true);
    expect(admitsAsianFractionalSettlement("Gols Asiáticos", "Mais de 2.0, 2.5")).toBe(true);
  });

  it("rejeita linhas de meio (half lines) que são puramente ganha/perde sem meio-ganho", () => {
    expect(admitsAsianFractionalSettlement("Handicap Asiático", "Flamengo -0.5")).toBe(false);
    expect(admitsAsianFractionalSettlement("Handicap Asiático", "Palmeiras +1.5")).toBe(false);
    expect(admitsAsianFractionalSettlement("Total de Gols", "Over 2.5")).toBe(false);
    expect(admitsAsianFractionalSettlement("Total de Gols", "Under 1.5")).toBe(false);
  });

  it("o dígito do meio-tempo não faz a linha dividida", () => {
    // Lido, "0,5 1ºT" seria a linha 0.5/1 e deixaria passar um HALF_WON.
    for (const selecao of ["Over 0,5 1ºT", "Over 0,5 (1°T)", "Over 1,5 2T"]) {
      expect(admitsAsianFractionalSettlement("Total", selecao), selecao).toBe(false);
    }
    expect(admitsAsianFractionalSettlement("Total 1ºT", "Over 0,5")).toBe(false);
    expect(admitsAsianFractionalSettlement("Total", "Over 1,75 1T")).toBe(true);
    expect(admitsAsianFractionalSettlement("Total 1ºT", "Over 0,75")).toBe(true);
  });

  it.each([
    ["Total 2.25", "Over"],
    ["Home Team Total 1.25", "Over"],
    ["Handicap Asiático -0.25", "Flamengo"],
  ])("aceita o meio resultado calculado com linha no mercado %s / %s", (mercado, selecao) => {
    expect(resolveResultFromScore({ mercado, selecao, evento: "Flamengo vs Palmeiras", esporte: "Soccer",
      homeScore: 1, awayScore: 1, odds: 2, stake: 1 })).toMatchObject({ ok: true, status: "HALF_LOST", lucro: -0.5 });
    expect(admitsAsianFractionalSettlement(mercado, selecao)).toBe(true);
  });

  it.each([
    ["Total 2.25", "Over 2.3"],
    ["Total 2.25", "Over 2.0, 3.5"],
    ["Handicap Asiático -0.25", "Flamengo -0.5, +1.0"],
    ["Total 2.5", "Over"],
    ["Moneyline 2.25", "Flamengo"],
    ["Mercado desconhecido 2.25", "Over"],
  ])("não usa rótulo para resgatar termos inválidos ou binários %s / %s", (mercado, selecao) => {
    expect(admitsAsianFractionalSettlement(mercado, selecao)).toBe(false);
  });
});
