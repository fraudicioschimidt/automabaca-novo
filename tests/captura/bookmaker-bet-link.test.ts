import { describe, expect, it } from "vitest";
import { bookmakerFromBetLinks } from "@/src/domain/bookmaker-bet-link";
import { enrichParsedBetFromCaption } from "@/src/services/capture/preparation/parse-caption-enrich";

describe("casa comprovada pelo link do bilhete", () => {
  it.each([
    ["https://www.bet365.bet.br/dl/sportsbookredirect?bet=1&bs=%7C200259948", "Bet365"],
    ["https://www.bet365.bet.br/s/r/dM8y9", "Bet365"],
    ["https://www.bet365.bet.br/#/AC/B1/C1/D8/E201884755/F3/I3/", "Bet365"],
    ["https://www.bet365.com/#/IP/EV152008788195C18", "Bet365"],
    ["https://www.betano.bet.br/bookingcode/CJGJNJLK/", "Betano"],
    ["https://www.kto.bet.br/esportes/futebol/inglaterra/jogo/102814293", "KTO"],
  ])("reconhece %s", (url, brand) => {
    expect(bookmakerFromBetLinks(`Igux Props VIP\n\n${url}\n1u`)).toBe(brand);
  });
  it("recusa marcas divergentes, domínios parecidos e links que não são de aposta", () => {
    for (const text of [
      "https://www.bet365.bet.br/dl/sportsbookredirect?bet=1 https://www.betano.bet.br/bookingcode/X/",
      "https://bet365.bet.br.example.com/dl/sportsbookredirect?bet=1",
      "https://bet365.bet.br@other.test/dl/sportsbookredirect?bet=1",
      "https://other.test/?next=https%3A%2F%2Fbet365.bet.br",
      "https://help.bet365.bet.br/s/pt-br/sportsrules/soccer/match-statistics",
      "https://www.bet365.bet.br/promos/pt-br/soccer",
      "Bet365 seria melhor, mas sem link do bilhete",
    ]) expect(bookmakerFromBetLinks(text)).toBeNull();
  });
  it("preenche omissão do parser e preserva a casa explícita no bilhete", () => {
    const bet = { evento: "Santa Fe vs Vasco", esporte: "Soccer", mercado: "Player Shots", selecao: "Cauan Barros Over 0.5", odds: 2.25, stake: 2, data: null, pais: "", competicao: "", casaDeAposta: "" };
    const caption = "https://www.bet365.bet.br/dl/sportsbookredirect?bet=1";
    expect(enrichParsedBetFromCaption(bet, caption).casaDeAposta).toBe("Bet365");
    expect(enrichParsedBetFromCaption({ ...bet, casaDeAposta: "KTO" }, caption).casaDeAposta).toBe("KTO");
  });
});
