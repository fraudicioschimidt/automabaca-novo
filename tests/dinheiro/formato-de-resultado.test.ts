import { describe, expect, it } from "vitest";
import { BRL_FORMAT, fmtBrl, fmtBrlPerUnit, fmtOdds, fmtPct, fmtPp, fmtRate, fmtU, fmtUnit, UNITS_FORMAT } from "@/src/domain/formato-de-resultado";

/**
 * Sinal em número que aparece como zero.
 *
 * O `+` afirma ganho e o `-` afirma perda. Zero não é nem um nem outro — uma
 * aposta anulada mostrada como `+0.00u` lê como ganho minúsculo, e um aviso de
 * liquidação no Telegram diria `VOID (+0.00u)`.
 *
 * A doença mais escorregadia é a segunda: o sinal decidido pelo valor BRUTO em
 * vez do EXIBIDO. `-0.004` arredonda para `0.00` e viraria `-0.00u`, um traço em
 * cima de um zero, afirmando uma perda que a própria linha não mostra.
 */

describe("zero exibido não carrega sinal", () => {
  it.each([
    [0, "0.00u"],
    [-0, "0.00u"],
    [0.004, "0.00u"],
    [-0.004, "0.00u"],
    [0.0001, "0.00u"],
    [-0.0001, "0.00u"],
  ])("fmtU(%s) = %s", (entrada, esperado) => {
    expect(fmtU(entrada)).toBe(esperado);
  });

  it.each([
    [0, "0.0%"],
    [-0, "0.0%"],
    [0.04, "0.0%"],
    [-0.04, "0.0%"],
  ])("fmtPct(%s) = %s", (entrada, esperado) => {
    expect(fmtPct(entrada)).toBe(esperado);
  });

  it("fmtUnit também: quantidade nunca vem com traço sobre zero", () => {
    expect(fmtUnit(-0.004)).toBe("0.00u");
    expect(fmtUnit(0)).toBe("0.00u");
  });

  it("o sinal volta assim que o valor EXIBIDO deixa de ser zero", () => {
    expect(fmtU(0.005)).toBe("+0.01u");
    expect(fmtU(-0.005)).toBe("-0.01u");
    expect(fmtPct(0.05)).toBe("+0.1%");
    expect(fmtPct(-0.05)).toBe("-0.1%");
  });

  it("os valores normais seguem como antes", () => {
    expect(fmtU(1.25)).toBe("+1.25u");
    expect(fmtU(-0.5)).toBe("-0.50u");
    expect(fmtU(1.25, false)).toBe("1.25u");
    expect(fmtU(-0.5, false)).toBe("-0.50u");
    expect(fmtUnit(2)).toBe("2.00u");
    expect(fmtPct(3.14)).toBe("+3.1%");
    expect(fmtOdds(1.9)).toBe("1.900");
  });

  it("ausência continua travessão, não zero", () => {
    for (const f of [fmtU, fmtUnit, fmtPct, fmtOdds]) {
      expect(f(null)).toBe("—");
      expect(f(undefined)).toBe("—");
    }
  });

  it("um traço só: o menos é ASCII em todo lugar (número copiado cola como número)", () => {
    for (const texto of [fmtU(-2), fmtPct(-2), fmtUnit(-2)]) {
      expect(texto).not.toContain("−");
      expect(texto).toContain("-");
    }
  });
});

describe("valores não finitos e arredondamento", () => {
  it("fmtOdds, fmtU, fmtUnit e fmtPct usam roundMoney e evitam float drift", () => {
    expect(fmtOdds(NaN)).toBe("—");
    expect(fmtOdds(Infinity)).toBe("—");
    expect(fmtOdds(1.0055)).toBe("1.006");
    expect(fmtU(NaN)).toBe("—");
    expect(fmtUnit(Infinity)).toBe("—");
    expect(fmtPct(-Infinity)).toBe("—");
    expect(fmtU(1.005)).toBe("+1.01u");
    expect(fmtU(-0.004)).toBe("0.00u");
  });
});

describe("reais", () => {
  it("saldo negativo mostra o traço; positivo e zero ficam sem sinal", () => {
    expect(fmtBrl(-123.45)).toBe("-R$ 123,45");
    expect(fmtBrl(1234.5)).toBe("R$ 1.234,50");
    expect(fmtBrl(0)).toBe("R$ 0,00");
    expect(fmtBrl(-0.004)).toBe("R$ 0,00");
  });

  it("com sinal, o ganho leva '+' e a perda o hífen ASCII", () => {
    expect(fmtBrl(50, true)).toBe("+R$ 50,00");
    expect(fmtBrl(-50, true)).toBe("-R$ 50,00");
    expect(fmtBrl(0, true)).toBe("R$ 0,00");
    expect(fmtBrl(-2, true)).not.toContain("−");
  });

  it("ausência é travessão", () => {
    expect(fmtBrl(null)).toBe("—");
    expect(fmtBrl(NaN)).toBe("—");
  });
});

describe("dinheiro da tela: unidades na banca, reais na carteira", () => {
  it("em unidades é o fmtU/fmtUnit de sempre", () => {
    expect(UNITS_FORMAT.signed(1.25)).toBe("+1.25u");
    expect(UNITS_FORMAT.amount(2)).toBe("2.00u");
    expect(UNITS_FORMAT.axis(-0.5)).toBe("-0.50u");
  });

  it("em reais, resultado com sinal e quantidade sem '+'", () => {
    expect(BRL_FORMAT.signed(62.5)).toBe("+R$ 62,50");
    expect(BRL_FORMAT.signed(-62.5)).toBe("-R$ 62,50");
    expect(BRL_FORMAT.amount(1234.5)).toBe("R$ 1.234,50");
  });

  it("no eixo, reais curtos com o sinal do texto exibido", () => {
    const semEspacoEspecial = (texto: string) => texto.replace(/\s/g, " ");
    expect(semEspacoEspecial(BRL_FORMAT.axis(1234))).toBe("+R$ 1,2 mil");
    expect(BRL_FORMAT.axis(-850)).toBe("-R$ 850");
    expect(BRL_FORMAT.axis(146.6)).toBe("+R$ 147");
    expect(semEspacoEspecial(BRL_FORMAT.axis(999.6))).toBe("+R$ 1 mil");
    expect(BRL_FORMAT.axis(-0.4)).toBe("R$ 0");
    expect(BRL_FORMAT.axis(null)).toBe("—");
  });
});

describe("taxa, pontos percentuais e valor da unidade", () => {
  it("taxa tem uma casa e nunca sinal: o mesmo acerto sai igual em toda tela", () => {
    expect(fmtRate(54.28)).toBe("54.3%");
    expect(fmtRate(54)).toBe("54.0%");
    expect(fmtRate(0)).toBe("0.0%");
    expect(fmtRate(null)).toBe("—");
  });

  it("diferença de percentuais em p.p., com sinal e hífen ASCII", () => {
    expect(fmtPp(1.24)).toBe("+1.2 p.p.");
    expect(fmtPp(-0.4)).toBe("-0.4 p.p.");
    expect(fmtPp(0.04)).toBe("0.0 p.p.");
    expect(fmtPp(null)).toBe("—");
  });

  it("valor da unidade sai igual do servidor e da edição otimista", () => {
    expect(fmtBrlPerUnit(12.5)).toBe("R$12,5/u");
    expect(fmtBrlPerUnit(100)).toBe("R$100/u");
  });
});
