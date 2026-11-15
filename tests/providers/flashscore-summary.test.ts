import { describe, expect, it } from "vitest";
import { resolveFlashscoreRegulationScore } from "@/src/providers/flashscore/summary";

describe("placar regulamentar pelo summary FlashScore", () => {
  it("separa gol da prorrogação e inclui acréscimo de 90 minutos", () => {
    expect(resolveFlashscoreRegulationScore({
      listedScore: { home: 2, away: 2 },
      summary: [
        { minutes: "16", team: "home", players: [{ type: "Goal" }] },
        { minutes: "90+7", team: "away", players: [{ type: "Goal" }] },
        { minutes: "105", team: "home", players: [{ type: "Goal" }] },
        { minutes: "117", team: "away", players: [{ type: "Goal" }] },
      ],
    })).toEqual({
      regulationScore: { home: 1, away: 1 },
      aggregateScore: { home: 2, away: 2 },
      goalEvents: 4,
      extraTimeGoalEvents: 2,
    });
  });

  it("orienta gol contra para o adversário", () => {
    expect(resolveFlashscoreRegulationScore({
      listedScore: { home: 1, away: 0 },
      summary: [
        { minutes: "27", team: "away", players: [{ type: "Own goal" }] },
      ],
    })?.regulationScore).toEqual({ home: 1, away: 0 });
  });

  it.each([
    {
      label: "summary incompleto",
      summary: [{ minutes: "16", team: "home" as const, players: [{ type: "Goal" }] }],
      listedScore: { home: 2, away: 0 },
    },
    {
      label: "gol sem minuto",
      summary: [{ team: "home" as const, players: [{ type: "Goal" }] }],
      listedScore: { home: 1, away: 0 },
    },
    { label: "summary vazio", summary: [], listedScore: { home: 0, away: 0 } },
  ])("recusa $label", ({ summary, listedScore }) => {
    expect(resolveFlashscoreRegulationScore({ summary, listedScore })).toBeNull();
  });
});
