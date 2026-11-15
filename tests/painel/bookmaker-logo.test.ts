import { describe, expect, it } from "vitest";
import { bookmakerLogoSrc, normalizeBookmakerName } from "@/app/_design/lib/bookmaker-logo";

describe("bookmakerLogoSrc", () => {
  it("mapeia nomes reais de casas para logos publicas", () => {
    expect(bookmakerLogoSrc("Bet365")).toBe("/bookmakers/bet365.png");
    expect(bookmakerLogoSrc("Bet 365")).toBe("/bookmakers/bet365.png");
    expect(bookmakerLogoSrc("Casa de Apostas")).toBe("/bookmakers/casadeapostas.png");
    expect(bookmakerLogoSrc("Esportes da Sorte")).toBe("/bookmakers/esportesdasorte.png");
    expect(bookmakerLogoSrc("Rei do Pitaco")).toBe("/bookmakers/reidopitaco.png");
  });

  it("aceita aliases comuns e nomes com dominio", () => {
    expect(bookmakerLogoSrc("Ai.bet")).toBe("/bookmakers/ai.png");
    expect(bookmakerLogoSrc("stake.bet.br")).toBe("/bookmakers/stake.png");
    expect(bookmakerLogoSrc("1 para 1")).toBe("/bookmakers/1pra1.png");
    expect(bookmakerLogoSrc("Jogo de Ouro.bet.br")).toBe("/bookmakers/jogodeouro.png");
  });

  it("nao confunde esporte ou nome desconhecido com casa", () => {
    expect(bookmakerLogoSrc("Soccer")).toBeNull();
    expect(bookmakerLogoSrc("Basketball")).toBeNull();
    expect(bookmakerLogoSrc("Banco do Brasil")).toBeNull();
    expect(bookmakerLogoSrc("")).toBeNull();
  });

  it("normaliza acentos, pontuacao e caixa", () => {
    expect(normalizeBookmakerName("  BÉT.PONTO-BET  ")).toBe("betpontobet");
  });
});
