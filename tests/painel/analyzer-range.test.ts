import { describe, expect, it } from "vitest";
import {
  inAnalyzerRange,
  inAnalyzerRangeAnterior,
  janelaAnteriorDoRange,
  janelaDoRange,
  rotuloDoPeriodoAnterior,
  textoDaJanela,
} from "@/app/_design/lib/analyzer-range";

const HOJE = "2026-07-15";

/** Todos os dias de um mês em volta de HOJE, para varrer as duas janelas. */
function diasAoRedor(): string[] {
  const base = Date.UTC(2026, 6, 15);
  const out: string[] = [];
  for (let d = -25; d <= 3; d++) out.push(new Date(base + d * 86_400_000).toISOString().slice(0, 10));
  return out;
}

describe("filtro temporal do Analyzer", () => {
  it("últimos 7 dias inclui hoje e os seis dias anteriores", () => {
    expect(inAnalyzerRange("2026-07-15", HOJE, "7d")).toBe(true);
    expect(inAnalyzerRange("2026-07-09", HOJE, "7d")).toBe(true);
    expect(inAnalyzerRange("2026-07-08", HOJE, "7d")).toBe(false);
  });

  it("do jogo futuro só entra a pendente, em qualquer recorte com prazo", () => {
    for (const range of ["hoje", "7d", "30d", "90d"] as const) {
      expect(inAnalyzerRange("2026-07-16", HOJE, range, true)).toBe(true);
      expect(inAnalyzerRange("2026-07-16", HOJE, range, false)).toBe(false);
    }
    // A pendente de jogo antes da janela continua fora, e nunca cai na janela anterior.
    expect(inAnalyzerRange("2026-07-08", HOJE, "7d", true)).toBe(false);
    expect(inAnalyzerRangeAnterior("2026-07-16", HOJE, "7d")).toBe(false);
  });

  it("não inclui futuro e rejeita chaves de calendário impossíveis", () => {
    expect(inAnalyzerRange("2026-07-16", HOJE, "7d")).toBe(false);
    expect(inAnalyzerRange("2026-02-31", HOJE, "hoje")).toBe(false);
  });
});

/**
 * A janela anterior é comparável com a atual.
 *
 * Comparação de período é o lugar clássico de errar por um dia, e o erro é
 * invisível: se as janelas se sobrepõem, a mesma aposta entra nos dois lados e
 * a "variação" é artefato da conta. Se têm tamanhos diferentes, o delta mede
 * volume em vez de desempenho. Nos dois casos o número sai plausível.
 */
describe("janela anterior do Analyzer", () => {
  it("as duas janelas NUNCA se sobrepõem", () => {
    for (const range of ["hoje", "7d"] as const) {
      for (const dia of diasAoRedor()) {
        const atual = inAnalyzerRange(dia, HOJE, range);
        const anterior = inAnalyzerRangeAnterior(dia, HOJE, range);
        expect(atual && anterior, `${dia} caiu nas duas janelas de "${range}"`).toBe(false);
      }
    }
  });

  it("as duas janelas têm o MESMO comprimento", () => {
    for (const range of ["hoje", "7d"] as const) {
      const dias = diasAoRedor();
      const nAtual = dias.filter((d) => inAnalyzerRange(d, HOJE, range)).length;
      const nAnterior = dias.filter((d) => inAnalyzerRangeAnterior(d, HOJE, range)).length;
      expect(nAnterior, `"${range}": comparar janelas de tamanhos diferentes mede volume, não desempenho`).toBe(nAtual);
    }
  });

  it("a janela anterior é COLADA na atual, sem buraco", () => {
    // Buraco entre elas esconderia dias e faria o "anterior" pular um pedaço.
    expect(inAnalyzerRange("2026-07-09", HOJE, "7d"), "último dia da atual").toBe(true);
    expect(inAnalyzerRangeAnterior("2026-07-08", HOJE, "7d"), "primeiro dia da anterior").toBe(true);
    expect(inAnalyzerRangeAnterior("2026-07-02", HOJE, "7d"), "último dia da anterior").toBe(true);
    expect(inAnalyzerRangeAnterior("2026-07-01", HOJE, "7d"), "já é anterior demais").toBe(false);
  });

  it("hoje compara com ontem, e só com ontem", () => {
    expect(inAnalyzerRangeAnterior("2026-07-14", HOJE, "hoje")).toBe(true);
    expect(inAnalyzerRangeAnterior("2026-07-15", HOJE, "hoje"), "hoje não é anterior a si mesmo").toBe(false);
    expect(inAnalyzerRangeAnterior("2026-07-13", HOJE, "hoje")).toBe(false);
  });

  it("`tudo` não tem anterior — comparar com o vazio daria variação infinita", () => {
    for (const dia of diasAoRedor()) {
      expect(inAnalyzerRangeAnterior(dia, HOJE, "tudo")).toBe(false);
    }
    expect(rotuloDoPeriodoAnterior("tudo")).toBeNull();
  });

  it("futuro e data impossível ficam fora da janela anterior também", () => {
    expect(inAnalyzerRangeAnterior("2026-07-16", HOJE, "7d")).toBe(false);
    expect(inAnalyzerRangeAnterior("2026-02-31", HOJE, "7d")).toBe(false);
  });

  it("todo range com anterior tem rótulo, e o rótulo nomeia a janela certa", () => {
    expect(rotuloDoPeriodoAnterior("hoje")).toBe("ontem");
    expect(rotuloDoPeriodoAnterior("7d")).toBe("os 7 dias anteriores");
  });
});

/**
 * O recorte declara a EXTENSÃO, e ela sai da mesma derivação do filtro.
 *
 * Um recorte que só se nomeia (`Últimos 7 dias`, `Tudo`) deixa o operador ler
 * um ROI sem saber de que período, e o delta compara com uma janela que ele
 * nunca vê.
 *
 * O jeito silencioso de estragar isso é escrever o rótulo à mão: erra por
 * um dia, sai plausível, e ninguém confere um texto contra um predicado. Por
 * isso o caso central varre o mês inteiro exigindo que `inAnalyzerRange` e a
 * janela exibida concordem DIA A DIA — é `hover-e-desenho-mesma-geometria`
 * aplicado ao tempo.
 */
function dentro(dia: string, janela: { inicio: string; fim: string } | null): boolean {
  return janela != null && dia >= janela.inicio && dia <= janela.fim;
}

describe("a janela exibida é a mesma que o filtro aplica", () => {
  it("rótulo e filtro concordam dia a dia, no mês inteiro em volta", () => {
    for (const range of ["hoje", "7d"] as const) {
      const janela = janelaDoRange(range, HOJE, []);
      for (const dia of diasAoRedor()) {
        expect(
          dentro(dia, janela),
          `"${range}" em ${dia}: a janela exibida (${textoDaJanela(janela)}) discorda do filtro`,
        ).toBe(inAnalyzerRange(dia, HOJE, range));
      }
    }
  });

  it("a janela ANTERIOR exibida também bate com o predicado, dia a dia", () => {
    for (const range of ["hoje", "7d"] as const) {
      const janela = janelaAnteriorDoRange(range, HOJE);
      for (const dia of diasAoRedor()) {
        expect(
          dentro(dia, janela),
          `"${range}" em ${dia}: a janela anterior exibida discorda do predicado`,
        ).toBe(inAnalyzerRangeAnterior(dia, HOJE, range));
      }
    }
  });

  it("em `tudo` a extensão é a do DADO, não uma data inventada", () => {
    // `tudo` não tem janela pedida: inventar `[primeiro dia, hoje]` excluiria
    // aposta de jogo FUTURO, que o filtro inclui. A base alcançável é o dado.
    const dias = ["2026-07-02", "2026-06-28", "2026-07-20"];
    expect(janelaDoRange("tudo", HOJE, dias)).toEqual({
      inicio: "2026-06-28", fim: "2026-07-20",
    });
    // Sem dado não há extensão a declarar — melhor nada do que uma faixa falsa.
    expect(janelaDoRange("tudo", HOJE, [])).toBe(null);
    // E `tudo` continua sem comparativo.
    expect(janelaAnteriorDoRange("tudo", HOJE)).toBe(null);
    expect(rotuloDoPeriodoAnterior("tudo")).toBe(null);
  });

  it("o texto da janela colapsa quando ela é de um dia só", () => {
    expect(textoDaJanela(janelaDoRange("hoje", HOJE, []))).toBe("15/07");
    expect(textoDaJanela(janelaDoRange("7d", HOJE, []))).toBe("09/07 – 15/07");
    expect(textoDaJanela(janelaAnteriorDoRange("hoje", HOJE))).toBe("14/07");
    expect(textoDaJanela(janelaAnteriorDoRange("7d", HOJE))).toBe("02/07 – 08/07");
    expect(textoDaJanela(null)).toBe(null);
  });

  it("dia inválido no conjunto não contamina a extensão", () => {
    expect(janelaDoRange("tudo", HOJE, ["2026-02-31", "2026-07-05"]))
      .toEqual({ inicio: "2026-07-05", fim: "2026-07-05" });
  });
});
