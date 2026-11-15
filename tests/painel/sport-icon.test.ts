import { describe, expect, it } from "vitest";
import { sportIconSrc } from "@/app/_design/lib/sport-icon";

/**
 * sportIconSrc mapeia o `esporte` da aposta (vocabulário de detectEsporte:
 * Soccer/Basketball/Tennis/…) para o PNG em /public/sports-icons. Esporte sem
 * ícone ou ausente → null (a tela cai no ícone genérico). Lógica pura.
 */
describe("sportIconSrc", () => {
  it("mapeia os esportes de detectEsporte que têm ícone", () => {
    expect(sportIconSrc("Soccer")).toBe("/sports-icons/soccer.png");
    expect(sportIconSrc("Basketball")).toBe("/sports-icons/basketball.png");
    expect(sportIconSrc("Tennis")).toBe("/sports-icons/tennis.png");
    expect(sportIconSrc("Volleyball")).toBe("/sports-icons/volleyball.png");
    expect(sportIconSrc("Hockey")).toBe("/sports-icons/hockey.png");
    expect(sportIconSrc("Baseball")).toBe("/sports-icons/baseball.png");
    // "American Football" → football.png (o soccer.png é o futebol comum)
    expect(sportIconSrc("American Football")).toBe("/sports-icons/football.png");
    expect(sportIconSrc("eSports")).toBe("/sports-icons/esports.png");
  });

  it("é robusto a caixa e acento (dado manual pode vir em PT)", () => {
    expect(sportIconSrc("FUTEBOL")).toBe("/sports-icons/soccer.png");
    expect(sportIconSrc("Tênis")).toBe("/sports-icons/tennis.png");
    expect(sportIconSrc("  basquete  ")).toBe("/sports-icons/basketball.png");
    expect(sportIconSrc("E-SPORTS")).toBe("/sports-icons/esports.png");
  });

  it("esporte sem ícone ou ausente → null (fallback para ícone genérico)", () => {
    expect(sportIconSrc("Críquete")).toBeNull();
    expect(sportIconSrc("")).toBeNull();
    expect(sportIconSrc(null)).toBeNull();
    expect(sportIconSrc(undefined)).toBeNull();
  });
});
