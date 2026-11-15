import { describe, expect, it } from "vitest";
import {
  marketNeedsFlashscoreStats,
  normalizeFlashscoreStats,
} from "@/src/providers/flashscore/stats";

describe("estatísticas FlashScore", () => {
  it("normaliza escanteios e cartões do bloco da partida", () => {
    const stats = normalizeFlashscoreStats({
      match: [
        { name: "Corner kicks", home_team: 7, away_team: 4 },
        { name: "Yellow cards", home_team: 2, away_team: 3 },
        { name: "Red cards", home_team: 0, away_team: 1 },
        // A API pode repetir linhas; a primeira linha agregada é canônica.
        { name: "Corner kicks", home_team: 99, away_team: 99 },
      ],
    });
    expect(stats).toMatchObject({
      corners: { home: 7, away: 4 },
      yellowCards: { home: 2, away: 3 },
      redCards: { home: 0, away: 1 },
    });
    // Família que o feed não trouxe fica `null` — nunca zero.
    expect(stats.shotsOnTarget).toBeNull();
    expect(stats.fouls).toBeNull();
  });

  it("normaliza as famílias medidas pela sonda do feed", () => {
    const stats = normalizeFlashscoreStats({
      match: [
        { name: "Total shots", home_team: 18, away_team: 8 },
        { name: "Shots on target", home_team: 9, away_team: 3 },
        { name: "Fouls", home_team: 11, away_team: 12 },
        { name: "Offsides", home_team: 4, away_team: 0 },
        { name: "Goalkeeper saves", home_team: 1, away_team: 2 },
        // Compostos ficam de fora: a unidade não é contagem simples.
        { name: "Ball possession", home_team: "58%", away_team: "42%" },
        { name: "Passes", home_team: "83% (272/327)", away_team: "68% (164/242)" },
      ],
    });
    expect(stats.shotsTotal).toEqual({ home: 18, away: 8 });
    expect(stats.shotsOnTarget).toEqual({ home: 9, away: 3 });
    expect(stats.fouls).toEqual({ home: 11, away: 12 });
    expect(stats.offsides).toEqual({ home: 4, away: 0 });
    expect(stats.saves).toEqual({ home: 1, away: 2 });
  });

  it("identifica mercados estatísticos sem confundir total de gols", () => {
    expect(marketNeedsFlashscoreStats("Total (Bookings) – Match", "Under 5.5")).toBe(true);
    expect(marketNeedsFlashscoreStats("Handicap (Corners) – Match", "Away +1")).toBe(true);
    expect(marketNeedsFlashscoreStats("Total – Match", "Under 2.5")).toBe(false);
  });

  it("roteia chutes/faltas/impedimentos/defesas para o caminho de estatística", () => {
    // Roteamento é DELIBERADAMENTE mais largo que o resolvedor: "chutes" solto
    // chega aqui e vira revisão manual, em vez de cair no caminho de GOLS.
    expect(marketNeedsFlashscoreStats("Total – Match", "Over 9.5 chutes")).toBe(true);
    expect(marketNeedsFlashscoreStats("Total de Finalizações", "Over 20.5")).toBe(true);
    expect(marketNeedsFlashscoreStats("Total de Faltas", "Under 24.5")).toBe(true);
    expect(marketNeedsFlashscoreStats("Total de Impedimentos", "Over 3.5")).toBe(true);
    expect(marketNeedsFlashscoreStats("Total de Defesas", "Over 4.5")).toBe(true);
  });

  it("prop de jogador não dispara a estatística de TIME", () => {
    expect(
      marketNeedsFlashscoreStats(
        "Total – Match",
        "willian jose over 0,5 sofre falta",
        "Bahia vs Vasco da Gama",
      ),
    ).toBe(false);
    expect(marketNeedsFlashscoreStats("Player Cards", "Casemiro over 0.5")).toBe(false);
  });

  it("race-to não gasta a chamada de estatística de TIME", () => {
    expect(marketNeedsFlashscoreStats("Race to 3 Corners", "Athletic Club")).toBe(false);
    expect(marketNeedsFlashscoreStats("Race to 3 Cantos", "Athletic Club")).toBe(false);
    expect(marketNeedsFlashscoreStats("Corrida ate 3 escanteios", "Casa")).toBe(false);
  });

  it("seleciona o bloco estatístico correspondente ao período do mercado", () => {
    const response = {
      match: [{ name: "Corner kicks", home_team: 10, away_team: 8 }],
      "1st-half": [{ name: "Corner kicks", home_team: 3, away_team: 2 }],
      "2nd-half": [{ name: "Corner kicks", home_team: 7, away_team: 6 }],
    };
    expect(normalizeFlashscoreStats(response, "FT").corners).toEqual({ home: 10, away: 8 });
    expect(normalizeFlashscoreStats(response, "HT").corners).toEqual({ home: 3, away: 2 });
    expect(normalizeFlashscoreStats(response, "SECOND_HALF").corners).toEqual({ home: 7, away: 6 });
  });

  it("aceita o rótulo singular Yellow Card", () => {
    expect(normalizeFlashscoreStats({
      match: [{ name: "Yellow Card", home_team: "2", away_team: "1" }],
    }).yellowCards).toEqual({ home: 2, away: 1 });
  });
});
