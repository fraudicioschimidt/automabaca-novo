import { describe, expect, it } from "vitest";
import { canonicalizeAsianHandicapSelecao } from "@/src/domain/asian-handicap-line";
import {
  extractSignedNumbers,
  lineToQuarters,
  parseLineQuarters,
} from "@/src/domain/settlement/lines";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";

const base = {
  evento: "Flamengo vs Palmeiras",
  odds: 2.0,
  stake: 1,
};

describe("lineToQuarters / parseLineQuarters", () => {
  it("linhas válidas viram quartos inteiros; inválidas viram null", () => {
    expect(lineToQuarters(-0.25)).toBe(-1);
    expect(lineToQuarters(2.5)).toBe(10);
    expect(lineToQuarters(0)).toBe(0);
    expect(lineToQuarters(2.3)).toBeNull();
    expect(lineToQuarters(Number.NaN)).toBeNull();
    expect(lineToQuarters(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("linha dupla explícita vira a média (quarter line)", () => {
    expect(parseLineQuarters("-0.5, -1.0", { allowNegative: true })).toBe(-3); // -0.75
    expect(parseLineQuarters("Over 2.0, 2.5", { allowNegative: false })).toBe(9); // 2.25
  });

  it("linha dupla separada por espaço só vira split quando dista meia unidade", () => {
    expect(parseLineQuarters("+0 -0.5", { allowNegative: true })).toBe(-1);
    expect(parseLineQuarters("-1 -1.5", { allowNegative: true })).toBe(-5);
    expect(parseLineQuarters("+1 +1.5", { allowNegative: true })).toBe(5);
    expect(parseLineQuarters("-0.5 -110", { allowNegative: true })).toBeNull();
  });

  it("normaliza sinais separados, sinais por extenso e splits defensivos", () => {
    expect(parseLineQuarters("+ 0 ,- 0.5", { allowNegative: true })).toBe(-1);
    expect(parseLineQuarters("Flamengo menos 0.5", { allowNegative: true })).toBe(-2);
    expect(parseLineQuarters("Flamengo mais 0.5", { allowNegative: true })).toBe(2);
    expect(parseLineQuarters("-0.5 / -1.0", { allowNegative: true })).toBe(-3);
    expect(parseLineQuarters("0,0.5", { allowNegative: true })).toBe(1);
    expect(parseLineQuarters("1-,1.5", { allowNegative: true })).toBeNull();
  });

  it.each(["−", "–", "—"])("canonicalização preserva sinal %s em decimal e split", (minus) => {
    expect(canonicalizeAsianHandicapSelecao(`Flamengo ${minus}0,25`, base.evento, "Asian Handicap"))
      .toBe("Flamengo -0.25");
    expect(canonicalizeAsianHandicapSelecao(`Flamengo 0.0, ${minus}0.5`, base.evento, "Asian Handicap"))
      .toBe("Flamengo -0.25");
  });

  it("extrai sinais e vírgula decimal sem inventar linhas ambíguas", () => {
    expect(extractSignedNumbers("AH −0,5 / +1.25")).toEqual([-0.5, 1.25]);
    expect(extractSignedNumbers("sem linha")).toEqual([]);
    expect(parseLineQuarters("", { allowNegative: true })).toBeNull();
    expect(parseLineQuarters("-0,5", { allowNegative: true })).toBe(-2);
    expect(parseLineQuarters("-0,25", { allowNegative: true })).toBe(-1);
    expect(parseLineQuarters("-0,75", { allowNegative: true })).toBe(-3);
    expect(parseLineQuarters("Flamengo -0,5", { allowNegative: true })).toBe(-2);
    expect(parseLineQuarters("+0,5", { allowNegative: true })).toBe(2);
    expect(parseLineQuarters("+0,25", { allowNegative: true })).toBe(1);
    expect(parseLineQuarters("+0,75", { allowNegative: true })).toBe(3);
    expect(parseLineQuarters("Under -0.5", { allowNegative: false })).toBeNull();
    expect(parseLineQuarters("0.25, 0.5", { allowNegative: true })).toBeNull();
    expect(parseLineQuarters("Over 2.3", { allowNegative: false })).toBeNull();
    expect(parseLineQuarters("Over 2, 2.5, 3", { allowNegative: false })).toBeNull();
    expect(parseLineQuarters("Mais que 2.5 @ 1.90", { allowNegative: false })).toBe(10);
    // Sem direção nem sinal, uma única casa decimal segue sendo o candidato
    // inequívoco quando o outro número é só metadado do jogo/período.
    expect(parseLineQuarters("Linha 2.5 jogo 3", { allowNegative: false })).toBe(10);
  });
});

describe("parseLineQuarters — números soltos e separadores sem procedência", () => {
  it("só faz média de par colado por vírgula; número solto não vira linha", () => {
    // Ler "Over 2 5" como 3.5 ou "AH França -1.0 jogo 3" como +1.0 decidiria
    // settlement contra um mercado que ninguém apostou.
    expect(parseLineQuarters("Over 2 5", { allowNegative: false })).toBeNull();
    expect(parseLineQuarters("AH França -1.0 jogo 3", { allowNegative: true })).toBe(-4);
    expect(parseLineQuarters("Time A -1.5 no 2 tempo", { allowNegative: true })).toBe(-6);
    expect(parseLineQuarters("Schalke 04 -1.5", { allowNegative: true })).toBe(-6);
    expect(parseLineQuarters("Over 2.5 jogo 3", { allowNegative: false })).toBe(10);
    expect(parseLineQuarters("Over 2.5 - Odds 1.90", { allowNegative: false })).toBe(10);
    expect(parseLineQuarters("Under 3.5 @ 1.85", { allowNegative: false })).toBe(14);
    // Split line legítima da Bet365 continua virando quarter line.
    expect(parseLineQuarters("Over 2.0,2.5", { allowNegative: false })).toBe(9);
    expect(parseLineQuarters("-0.5, -1.0", { allowNegative: true })).toBe(-3);
    expect(parseLineQuarters("Over 2.5", { allowNegative: false })).toBe(10);
    expect(parseLineQuarters("Over 2 15ª R.", { allowNegative: false })).toBe(8);
  });

  it("separador sem procedência falha fechado: nem média, nem escolher perna", () => {
    // Média mistura números de conceitos diferentes; escolher a primeira
    // perna decide dinheiro em silêncio. Enquanto não
    // houver grafia real da captura, a resposta é `null`.
    for (const selecao of ["Over 2.0; 2.5", "Over 2.0 | 2.5", "Over 2.0 & 2.5", "Over 2.0 e 2.5"]) {
      expect(parseLineQuarters(selecao, { allowNegative: false }), selecao).toBeNull();
    }
    expect(parseLineQuarters("-0.5; -1.0", { allowNegative: true })).toBeNull();
    // Combo com estatística também para de virar total simples.
    expect(parseLineQuarters("Over 2.5 e 1 escanteio", { allowNegative: false })).toBeNull();
    // A captura não pode gravar a perna escolhida: devolve o texto original.
    expect(
      pinnacleizeSelecao({ selecao: "Over 2.0; 2.5", mercadoPinnacle: "Total", evento: base.evento }),
    ).toBe("Over 2.0; 2.5");
    // Grafia conhecida (vírgula/barra) e odd anexada continuam resolvendo.
    expect(parseLineQuarters("Over 2.0, 2.5", { allowNegative: false })).toBe(9);
    expect(parseLineQuarters("Over 2.0/2.5", { allowNegative: false })).toBe(9);
    expect(parseLineQuarters("Over 2.5 @ 1.90", { allowNegative: false })).toBe(10);
  });
});

describe("canonicalizeAsianHandicapSelecao — vírgula: split Bet365 × decimal em português", () => {
  it("canonicalização não inverte handicap escrito com vírgula decimal", () => {
    expect(canonicalizeAsianHandicapSelecao("Time A -0,5", "Time A vs Time B", "Handicap – Match"))
      .toBe("Time A -0.5");
    expect(canonicalizeAsianHandicapSelecao("Time A 0.0,+0.5", "Time A vs Time B", "Handicap – Match"))
      .toBe("Time A +0.25");
  });

  it("canonicaliza split cuja primeira perna é inteira sem confundir decimal PT", () => {
    expect(canonicalizeAsianHandicapSelecao("Over 2,2.5", "A vs B", "Total – Match"))
      .toBe("Over 2.25");
    expect(canonicalizeAsianHandicapSelecao("Time A 0,0.5", "Time A vs Time B", "Handicap – Match"))
      .toBe("Time A +0.25");
    expect(canonicalizeAsianHandicapSelecao("Time A -0,5", "Time A vs Time B", "Handicap – Match"))
      .toBe("Time A -0.5");
  });
});
