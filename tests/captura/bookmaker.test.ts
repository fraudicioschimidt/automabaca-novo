import { describe, expect, it } from "vitest";
import { canonicalizeBookmakerName } from "@/src/domain/bookmaker";

describe("canonicalizeBookmakerName", () => {
  it("unifica caixa e separadores de marcas conhecidas", () => {
    expect(canonicalizeBookmakerName("bet365")).toBe("Bet365");
    expect(canonicalizeBookmakerName(" Bet 365 ")).toBe("Bet365");
    expect(canonicalizeBookmakerName("kto")).toBe("KTO");
    expect(canonicalizeBookmakerName("Betfair Exchange")).toBe("Betfair");
    expect(canonicalizeBookmakerName("Bet365 BR")).toBe("Bet365");
    expect(canonicalizeBookmakerName("Betano Brasil")).toBe("Betano");
  });

  it("preserva marcas desconhecidas sem inventar grafia", () => {
    expect(canonicalizeBookmakerName("Casa Regional")).toBe("Casa Regional");
    expect(canonicalizeBookmakerName("Casa Regional Online")).toBe("Casa Regional Online");
    expect(canonicalizeBookmakerName("Casa Regional Oficial")).toBe("Casa Regional Oficial");
    expect(canonicalizeBookmakerName("Casa Regional VIP")).toBe("Casa Regional VIP");
  });

  it("remove sufixos operacionais somente de marcas conhecidas", () => {
    for (const variant of [
      "Betfair Sportsbook",
      "Betfair International",
      "Betfair Esportes",
      "Betfair Sportsbook Online",
    ]) {
      expect(canonicalizeBookmakerName(variant), variant).toBe("Betfair");
    }
    expect(canonicalizeBookmakerName("Betano Apostas")).toBe("Betano");
    expect(canonicalizeBookmakerName("Superbet Online")).toBe("Superbet");
    expect(canonicalizeBookmakerName("KTO Apostas")).toBe("KTO");
    expect(canonicalizeBookmakerName("Bet365 Oficial")).toBe("Bet365");
    expect(canonicalizeBookmakerName("Betano VIP")).toBe("Betano");
    expect(canonicalizeBookmakerName("Stake Brasil Oficial")).toBe("Stake");
  });

  it("plano/nível da conta não cria marca nova", () => {
    expect(canonicalizeBookmakerName("Betano Pro")).toBe("Betano");
    expect(canonicalizeBookmakerName("Stake Premium")).toBe("Stake");
    expect(canonicalizeBookmakerName("KTO Plus")).toBe("KTO");
    expect(canonicalizeBookmakerName("Betano Club")).toBe("Betano");
    expect(canonicalizeBookmakerName("Pixbet Clube")).toBe("Pixbet");
    expect(canonicalizeBookmakerName("Superbet Premium Brasil")).toBe("Superbet");
    // O sufixo só some quando o resto é marca conhecida.
    expect(canonicalizeBookmakerName("Casa Regional Pro")).toBe("Casa Regional Pro");
    expect(canonicalizeBookmakerName("Casa Regional Clube")).toBe("Casa Regional Clube");
  });

  it("edição e canal da mesma casa não criam marca nova", () => {
    expect(canonicalizeBookmakerName("Betano Prime")).toBe("Betano");
    expect(canonicalizeBookmakerName("Stake Global")).toBe("Stake");
    expect(canonicalizeBookmakerName("1xBet Lite")).toBe("1xBet");
    expect(canonicalizeBookmakerName("Betano Express")).toBe("Betano");
    expect(canonicalizeBookmakerName("Stake Mobile")).toBe("Stake");
    expect(canonicalizeBookmakerName("Pixbet App")).toBe("Pixbet");
    expect(canonicalizeBookmakerName("Betfair Exchange Mobile")).toBe("Betfair");
    expect(canonicalizeBookmakerName("Casa Regional App")).toBe("Casa Regional App");
    expect(canonicalizeBookmakerName("Casa Regional Prime")).toBe("Casa Regional Prime");
  });

  it("qualquer sufixo sobre marca conhecida converge; desconhecida é preservada", () => {
    // Regra estrutural: o PREFIXO de palavras precisa ser uma marca conhecida.
    // Enumerar adjetivos (Oficial → Pro → Prime → Gold …) nunca converge.
    for (const [nome, esperado] of [
      ["Betano Gold", "Betano"],
      ["Stake Platinum", "Stake"],
      ["KTO Diamond", "KTO"],
      ["Betano Silver", "Betano"],
      ["Bwin Bronze", "Bwin"],
      ["Betano Play", "Betano"],
      ["Bet 365 Gold", "Bet365"],
      ["Esportes da Sorte Gold", "Esportes da Sorte"],
      ["Superbet Titanium Elite", "Superbet"],
      ["Betano-VIP", "Betano"],
    ] as const) {
      expect(canonicalizeBookmakerName(nome), nome).toBe(esperado);
    }
    for (const nome of ["Casa Regional Gold", "Casa Regional Play", "Casa Regional"]) {
      expect(canonicalizeBookmakerName(nome), nome).toBe(nome);
    }
  });

  it("canal de operação colado não cria marca nova", () => {
    // Live/TV/Casino/Official são CANAIS da mesma casa. A segurança segue
    // estrutural: só remove quando o que sobra é marca do catálogo.
    for (const [nome, esperado] of [
      ["StakeLive", "Stake"],
      ["BetanoTV", "Betano"],
      ["StakeCasino", "Stake"],
      ["StakeOfficial", "Stake"],
      ["BetanoOfficial", "Betano"],
      ["Bet365Live", "Bet365"],
      ["KTO.tv", "KTO"],
      ["Betano Live Casino", "Betano"],
    ] as const) {
      expect(canonicalizeBookmakerName(nome), nome).toBe(esperado);
    }
    for (const nome of ["CasinoRegional", "Casa Regional Live", "LiveBet"]) {
      expect(canonicalizeBookmakerName(nome), nome).toBe(nome);
    }
    // `sports` (EN) é a mesma classe de `esportes` (PT) e converge igual.
    for (const [nome, esperado] of [
      ["StakeSports", "Stake"],
      ["BetanoSports", "Betano"],
      ["Bet365Sports", "Bet365"],
      ["StakeSportsbook", "Stake"],
    ] as const) {
      expect(canonicalizeBookmakerName(nome), nome).toBe(esperado);
    }
    expect(canonicalizeBookmakerName("Sports")).toBe("Sports");
  });

  it("domínio colado e sufixo 'bet' convergem para a marca", () => {
    for (const [nome, esperado] of [
      ["Stake.bet", "Stake"],
      ["Stake.io", "Stake"],
      ["Betano.com", "Betano"],
      ["1xBet.io", "1xBet"],
      ["BetanoBet", "Betano"],
      ["PixbetBet", "Pixbet"],
    ] as const) {
      expect(canonicalizeBookmakerName(nome), nome).toBe(esperado);
    }
    // Marcas que TERMINAM em "bet" continuam intactas pelo lookup direto.
    expect(canonicalizeBookmakerName("VaideBet")).toBe("VaideBet");
    expect(canonicalizeBookmakerName("Novibet")).toBe("Novibet");
    expect(canonicalizeBookmakerName("EstrelaBet")).toBe("EstrelaBet");
    expect(canonicalizeBookmakerName("Casa Regional.com")).toBe("Casa Regional.com");
  });

  it("normaliza marcas brasileiras conhecidas", () => {
    expect(canonicalizeBookmakerName("SUPER BET")).toBe("Superbet");
    expect(canonicalizeBookmakerName("novibet")).toBe("Novibet");
    expect(canonicalizeBookmakerName("estrela bet")).toBe("EstrelaBet");
    expect(canonicalizeBookmakerName("BET NACIONAL")).toBe("Betnacional");
    expect(canonicalizeBookmakerName("pix bet")).toBe("Pixbet");
    expect(canonicalizeBookmakerName("PARIMATCH")).toBe("Parimatch");
    expect(canonicalizeBookmakerName("esportes da sorte")).toBe("Esportes da Sorte");
    expect(canonicalizeBookmakerName("vaidebet")).toBe("VaideBet");
    expect(canonicalizeBookmakerName("1xbet")).toBe("1xBet");
    expect(canonicalizeBookmakerName("BWIN")).toBe("Bwin");
    expect(canonicalizeBookmakerName("rivalo")).toBe("Rivalo");
  });
});
