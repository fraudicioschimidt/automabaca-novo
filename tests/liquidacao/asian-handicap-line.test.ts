import { describe, expect, it } from "vitest";
import {
  asianHandicapLineNeedsRetry,
  asianHandicapSideNeedsRetry,
  canonicalizeAsianHandicapSelecao,
} from "@/src/domain/asian-handicap-line";
import { parseLineQuarters } from "@/src/domain/settlement/lines";

describe("canonicalizeAsianHandicapSelecao", () => {
  it("Colômbia 0.0, -0.5 → -0.25", () => {
    expect(
      canonicalizeAsianHandicapSelecao(
        "Colômbia 0.0, -0.5",
        "Colômbia vs Equador",
        "Asian Handicap",
      ),
    ).toBe("Colômbia -0.25");
  });

  it("0.0,+0.5 colado → +0.25", () => {
    expect(
      canonicalizeAsianHandicapSelecao(
        "FC Flora Tallinn 0.0,+0.5",
        "FC Flora Tallinn vs Rival",
        "Asian Handicap",
      ),
    ).toBe("FC Flora Tallinn +0.25");
  });

  it("Flamengo -0.5, -1.0 → -0.75", () => {
    expect(
      canonicalizeAsianHandicapSelecao(
        "Flamengo -0.5, -1.0",
        "Flamengo vs Palmeiras",
        "Asian Handicap",
      ),
    ).toBe("Flamengo -0.75");
  });

  it("split Bet365 abreviado herda sinal negativo sem inverter dinheiro", () => {
    expect(
      canonicalizeAsianHandicapSelecao(
        "Flamengo -2,2.5",
        "Flamengo vs Palmeiras",
        "Asian Handicap",
      ),
    ).toBe("Flamengo -2.25");
  });

  it("split positivo sem sinal explícito falha fechado", () => {
    expect(
      canonicalizeAsianHandicapSelecao(
        "Flamengo 2,2.5",
        "Flamengo vs Palmeiras",
        "Asian Handicap",
      ),
    ).toBe("Flamengo 2,2.5");
    expect(
      canonicalizeAsianHandicapSelecao(
        "Flamengo +2,2.5",
        "Flamengo vs Palmeiras",
        "Asian Handicap",
      ),
    ).toBe("Flamengo +2.25");
  });

  it("sinais explícitos opostos falham fechados em vez de trocar a linha", () => {
    expect(
      canonicalizeAsianHandicapSelecao(
        "Flamengo -2,+2.5",
        "Flamengo vs Palmeiras",
        "Asian Handicap",
      ),
    ).toBe("Flamengo -2,+2.5");
    expect(
      canonicalizeAsianHandicapSelecao(
        "Flamengo +2,-2.5",
        "Flamengo vs Palmeiras",
        "Asian Handicap",
      ),
    ).toBe("Flamengo +2,-2.5");
  });

  it("Total asiático Bet365: Over 2.0, 2.5 → Over 2.25 (sem sinal +)", () => {
    expect(
      canonicalizeAsianHandicapSelecao(
        "Over 2.0, 2.5",
        "Ponte Preta vs Criciuma",
        "Total – Match",
      ),
    ).toBe("Over 2.25");
    expect(
      canonicalizeAsianHandicapSelecao(
        "Mais de 2.0,2.5",
        "Ponte Preta vs Criciuma",
        "Total",
      ),
    ).toBe("Over 2.25");
  });

  it("split que cai em linha inteira mantém a casa decimal do dedup", () => {
    // "Over 2" e "Over 2.0" são a MESMA linha, mas o dedup de registerBet
    // compara string: a canonicalização precisa sair na grafia que a captura
    // sem split também produz.
    expect(
      canonicalizeAsianHandicapSelecao(
        "Over 1.75, 2.25",
        "Ponte Preta vs Criciuma",
        "Total – Match",
      ),
    ).toBe("Over 2.0");
    expect(
      parseLineQuarters("Over 2.0", { allowNegative: false }),
    ).toBe(parseLineQuarters("Over 2", { allowNegative: false }));
  });

  it("linha única intacta", () => {
    expect(
      canonicalizeAsianHandicapSelecao("Flamengo -0.5", "Flamengo vs Palmeiras", "Asian Handicap"),
    ).toBe("Flamengo -0.5");
  });

  it("remove marcador AH colado à linha sem apagar o handicap", () => {
    for (const selecao of [
      "Bolivar -2ah",
      "Bolivar -2 AH",
      "Bolivar -2 A.H.",
      "Bolivar -2 Asian Handicap",
    ]) {
      expect(
        canonicalizeAsianHandicapSelecao(
          selecao,
          "Bolivar vs Oriente Petroleiro",
          "Handicap – Match",
        ),
        selecao,
      ).toBe("Bolivar -2");
    }
  });

  it("não remove AH de mercado que não é handicap", () => {
    expect(
      canonicalizeAsianHandicapSelecao("Bolivar -2ah", "Bolivar vs Oriente", "Moneyline"),
    ).toBe("Bolivar -2ah");
  });

  it("Moneyline sem split → no-op", () => {
    expect(
      canonicalizeAsianHandicapSelecao("Flamengo", "Flamengo vs Palmeiras", "Moneyline"),
    ).toBe("Flamengo");
  });
});

describe("asianHandicapLineNeedsRetry", () => {
  it("zero isolado sem time → suspeito de split truncado", () => {
    expect(asianHandicapLineNeedsRetry("0", "Athletic Club vs X")).toBe(true);
    expect(asianHandicapLineNeedsRetry("0.0", "Athletic Club vs X")).toBe(true);
  });

  it("AH 0 / 0.0 com time (level ball) é linha válida — não retry", () => {
    expect(asianHandicapLineNeedsRetry("Athletic Club 0.0", "Athletic Club vs X")).toBe(
      false,
    );
    expect(asianHandicapLineNeedsRetry("Athletic Club 0", "Athletic Club vs X")).toBe(
      false,
    );
    expect(
      asianHandicapLineNeedsRetry(
        "Lørenskog 0.0",
        "Lørenskog v Honefoss",
      ),
    ).toBe(false);
  });

  it("já tem split ou linha real → false", () => {
    expect(asianHandicapLineNeedsRetry("A 0.0, -0.5", "A vs B")).toBe(false);
    expect(asianHandicapLineNeedsRetry("Flamengo -0.25", "Flamengo vs X")).toBe(false);
    expect(asianHandicapLineNeedsRetry("Flamengo -0.5", "Flamengo vs X")).toBe(false);
    expect(asianHandicapLineNeedsRetry("Over 2.0", "Flamengo vs X")).toBe(false);
    expect(asianHandicapLineNeedsRetry("Under 3.0", "Flamengo vs X")).toBe(false);
  });

  it("zero sem lado casado no evento → ainda suspeito", () => {
    // Sufixo "MG" sem match de lado → trata como truncamento clássico.
    expect(
      asianHandicapLineNeedsRetry("Athletic Club, MG 0", "Outro Time vs X"),
    ).toBe(true);
  });
});

describe("asianHandicapSideNeedsRetry", () => {
  it("não pede lado de handicap para total explícito sem mercado", () => {
    expect(asianHandicapSideNeedsRetry("Over 2.5", "Flamengo vs Palmeiras")).toBe(false);
    expect(asianHandicapSideNeedsRetry("Under 3.5", "Flamengo vs Palmeiras")).toBe(false);
    expect(asianHandicapSideNeedsRetry("Mais de 2.5", "Flamengo vs Palmeiras")).toBe(false);
  });

  it("split nu sem time (Luis / círculo) → true", () => {
    expect(
      asianHandicapSideNeedsRetry(
        "0.0, -0.5",
        "Yanbian Longding vs Nanjing City",
        "Asian Handicap",
      ),
    ).toBe(true);
    expect(
      asianHandicapSideNeedsRetry(
        "0.0, +0.5",
        "Plaza Colonia vs Miramar Misiones",
        "Handicap Asiático",
      ),
    ).toBe(true);
    expect(
      asianHandicapSideNeedsRetry(
        "+0.5, +1.0",
        "Deportes Temuco vs Deportes Copiapo",
        "Handicap – Match",
      ),
    ).toBe(true);
  });

  it("já tem time (incl. visitante) → false", () => {
    expect(
      asianHandicapSideNeedsRetry(
        "Deportes Copiapo +0.5, +1.0",
        "Deportes Temuco vs Deportes Copiapo",
        "Asian Handicap",
      ),
    ).toBe(false);
    expect(
      asianHandicapSideNeedsRetry(
        "Yanbian Longding -0.25",
        "Yanbian Longding vs Nanjing City",
        "Asian Handicap",
      ),
    ).toBe(false);
  });

  it("sem linha numérica → false (retry de truncamento cobre)", () => {
    expect(
      asianHandicapSideNeedsRetry(
        "Charlotte Independence",
        "Spokane Velocity vs Charlotte Independence",
        "Asian Handicap",
      ),
    ).toBe(false);
  });

  it("Moneyline → false", () => {
    expect(
      asianHandicapSideNeedsRetry("Flamengo", "Flamengo vs Palmeiras", "Moneyline"),
    ).toBe(false);
  });

  it("parseLineQuarters normaliza zero com sinal (+0 e -0) em qualquer posição do split", () => {
    expect(parseLineQuarters("-0, +0.5", { allowNegative: true })).toBe(1);
    expect(parseLineQuarters("+0, -0.5", { allowNegative: true })).toBe(-1);
    expect(parseLineQuarters("-0, -0.5", { allowNegative: true })).toBe(-1);
    expect(parseLineQuarters("+0, +0.5", { allowNegative: true })).toBe(1);
    expect(parseLineQuarters("+0.5, -0", { allowNegative: true })).toBe(1);
    expect(parseLineQuarters("-0.5, +0", { allowNegative: true })).toBe(-1);
    expect(parseLineQuarters("-0.5, -0", { allowNegative: true })).toBe(-1);
    expect(parseLineQuarters("+0.5, +0", { allowNegative: true })).toBe(1);
  });

  describe("T2-BUG-01: Herança de sinal e sinais opostos em split asiático", () => {
    it("split decimal com sinal negativo na 1ª perna herda o sinal para a 2ª perna", () => {
      expect(parseLineQuarters("-2.0,2.5", { allowNegative: true })).toBe(-9);
      expect(parseLineQuarters("-2.0, 2.5", { allowNegative: true })).toBe(-9);
      expect(parseLineQuarters("-2, 2.5", { allowNegative: true })).toBe(-9);
      expect(parseLineQuarters("Flamengo -2.0, 2.5", { allowNegative: true })).toBe(-9);
      expect(
        canonicalizeAsianHandicapSelecao("Flamengo -2.0, 2.5", "Flamengo vs Palmeiras", "Asian Handicap"),
      ).toBe("Flamengo -2.25");
      expect(
        canonicalizeAsianHandicapSelecao("Flamengo -2.0,2.5", "Flamengo vs Palmeiras", "Asian Handicap"),
      ).toBe("Flamengo -2.25");
    });

    it("split decimal com sinal positivo na 1ª perna herda o sinal para a 2ª perna", () => {
      expect(parseLineQuarters("+2.0, 2.5", { allowNegative: true })).toBe(9);
      expect(parseLineQuarters("+2, 2.5", { allowNegative: true })).toBe(9);
      expect(parseLineQuarters("Flamengo +2.0, 2.5", { allowNegative: true })).toBe(9);
      expect(
        canonicalizeAsianHandicapSelecao("Flamengo +2.0, 2.5", "Flamengo vs Palmeiras", "Asian Handicap"),
      ).toBe("Flamengo +2.25");
    });

    it("split com sinais opostos explícitos ou não declarados falha fechado (null)", () => {
      expect(parseLineQuarters("2, -2.5", { allowNegative: true })).toBeNull();
      expect(parseLineQuarters("2.0, -2.5", { allowNegative: true })).toBeNull();
      expect(parseLineQuarters("-2, +2.5", { allowNegative: true })).toBeNull();
      expect(parseLineQuarters("+2, -2.5", { allowNegative: true })).toBeNull();
      expect(parseLineQuarters("Flamengo 2, -2.5", { allowNegative: true })).toBeNull();
      expect(parseLineQuarters("Flamengo 2.0, 2.5", { allowNegative: true })).toBeNull();
      expect(parseLineQuarters("Flamengo 2, 2.5", { allowNegative: true })).toBeNull();

      expect(
        canonicalizeAsianHandicapSelecao("Flamengo 2, -2.5", "Flamengo vs Palmeiras", "Asian Handicap"),
      ).toBe("Flamengo 2, -2.5");
      expect(
        canonicalizeAsianHandicapSelecao("Flamengo 2.0, 2.5", "Flamengo vs Palmeiras", "Asian Handicap"),
      ).toBe("Flamengo 2.0, 2.5");
    });
  });

  describe("T2-BUG-02: Validação de distância exata 0.5 (2 quartos) em splits", () => {
    it("splits de total com distância diferente de 0.5 falham fechados (null)", () => {
      expect(parseLineQuarters("Over 2.0, 3.0", { allowNegative: false })).toBeNull();
      expect(parseLineQuarters("Over 1.5, 2.5", { allowNegative: false })).toBeNull();
      expect(parseLineQuarters("Over 2, 3", { allowNegative: false })).toBeNull();
      expect(parseLineQuarters("Over 1.0, 2.0", { allowNegative: false })).toBeNull();
      expect(parseLineQuarters("Over 0.5, 2.5", { allowNegative: false })).toBeNull();
      expect(
        canonicalizeAsianHandicapSelecao("Over 2.0, 3.0", "Time A vs Time B", "Total – Match"),
      ).toBe("Over 2.0, 3.0");
      expect(
        canonicalizeAsianHandicapSelecao("Over 1.5, 2.5", "Time A vs Time B", "Total – Match"),
      ).toBe("Over 1.5, 2.5");
    });

    it("splits de handicap com distância diferente de 0.5 falham fechados (null)", () => {
      expect(parseLineQuarters("-1.0, -2.0", { allowNegative: true })).toBeNull();
      expect(parseLineQuarters("-0.5, -1.5", { allowNegative: true })).toBeNull();
      expect(parseLineQuarters("Flamengo -1.0, -2.0", { allowNegative: true })).toBeNull();
      expect(parseLineQuarters("Flamengo -2, -3", { allowNegative: true })).toBeNull();
      expect(
        canonicalizeAsianHandicapSelecao("Flamengo -1.0, -2.0", "Flamengo vs Palmeiras", "Asian Handicap"),
      ).toBe("Flamengo -1.0, -2.0");
    });

    it("splits com distância de exatamente 0.5 continuam aceitos", () => {
      expect(parseLineQuarters("Over 2.0, 2.5", { allowNegative: false })).toBe(9);
      expect(parseLineQuarters("Over 2.0/2.5", { allowNegative: false })).toBe(9);
      expect(parseLineQuarters("-0.5, -1.0", { allowNegative: true })).toBe(-3);
      expect(parseLineQuarters("-1.0, -1.5", { allowNegative: true })).toBe(-5);
    });
  });

});
