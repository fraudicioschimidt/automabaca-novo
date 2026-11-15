import { renderDesignMarkup } from "../helpers/design-markup";
import { describe, expect, it } from "vitest";
import { DeltaVsAnterior } from "@/app/_design/screens/analyzer/shared";
import { formaDoDelta, textoDeAmostraCurta } from "@/app/_design/lib/comparacao-de-janelas";
import { AMOSTRA_MINIMA_EXIBICAO } from "@/src/domain/analyzer/shared";
import { getTheme } from "@/app/_design/theme";
import { uiDisplayColor } from "@/app/_design/utils";

/**
 * Guarda de comparação não confere UMA base enquanto o número usa OUTRA — e
 * janela não troca de elenco sem dizer.
 *
 * A guarda do `DeltaVsAnterior` usa a base DO KPI, não a contagem de APOSTAS da
 * janela: lucro/ROI contam resolvidas, CLV conta fechamentos confiáveis, steam
 * conta aberturas. Guardando pela contagem de apostas, a tela imprimiria
 *
 *     CLV médio   5,53% (n=60)  vs  −20,06% (n=1)  →  "+25,6 p.p." VERDE
 *
 * com 28 apostas na janela anterior e só um fechamento confiável. O recorte
 * `hoje` de uma banca é onde isso aparece primeiro (base 1 contra 7). Família
 * do `resumo-de-apostas` e do `cobertura-na-tela`.
 *
 * Irmãos: `analyzer-range` prova mesmo TAMANHO de janela;
 * `balde-em-curso` prova mesma LIQUIDAÇÃO; este prova mesma BASE.
 */

describe("a forma do delta sai da base DO NÚMERO", () => {
  const base = (atual: number, anterior: number) => ({ atual, anterior });
  const args = (b: { atual: number; anterior: number }) => ({
    rotuloAnterior: "os 7 dias anteriores",
    atual: 8,
    anterior: 5,
    base: b,
  });

  it("é 'amostra-curta' exatamente quando um dos lados fica abaixo do piso", () => {
    for (let a = 1; a <= 12; a++) {
      for (let p = 1; p <= 12; p++) {
        const curto = a < AMOSTRA_MINIMA_EXIBICAO || p < AMOSTRA_MINIMA_EXIBICAO;
        expect(formaDoDelta(args(base(a, p))), `${a}/${p}`).toBe(
          curto ? "amostra-curta" : "delta",
        );
      }
    }
  });

  /** Base 60 contra base 1. */
  it("base 1 do outro lado não autoriza delta, mesmo com 60 deste", () => {
    expect(formaDoDelta(args(base(60, 1)))).toBe("amostra-curta");
  });

  /**
   * "não apostei nada lá" e "apostei, mas quase nada fechou" pedem frases
   * diferentes. Colapsá-las esconderia justamente o caso do CLV.
   */
  it("base anterior ZERO é 'anterior-vazia', nunca 'amostra-curta'", () => {
    expect(formaDoDelta(args(base(60, 0)))).toBe("anterior-vazia");
    expect(formaDoDelta(args(base(0, 0)))).toBe("anterior-vazia");
  });

  it("sem rótulo não compara; valor nulo ou não-finito não compara", () => {
    expect(formaDoDelta({ ...args(base(60, 60)), rotuloAnterior: null })).toBe("sem-anterior");
    expect(formaDoDelta({ ...args(base(60, 60)), rotuloAnterior: "" })).toBe("sem-anterior");
    expect(formaDoDelta({ ...args(base(60, 60)), atual: null })).toBe("sem-valor");
    expect(formaDoDelta({ ...args(base(60, 60)), anterior: undefined })).toBe("sem-valor");
    expect(formaDoDelta({ ...args(base(60, 60)), atual: Number.NaN })).toBe("sem-valor");
  });

  it("entrada torta falha FECHADO: base negativa ou NaN nunca vira delta", () => {
    expect(formaDoDelta(args(base(60, -3)))).toBe("anterior-vazia");
    expect(formaDoDelta(args(base(Number.NaN, 60)))).toBe("amostra-curta");
    expect(formaDoDelta(args(base(60, Number.NaN)))).toBe("anterior-vazia");
  });

  /** Mesma regra do `textoDeEmCurso`: número sem base não significa nada. */
  it("o texto de amostra curta nomeia AS DUAS contagens e a janela", () => {
    const t = textoDeAmostraCurta({ atual: 60, anterior: 1 }, "os 7 dias anteriores");
    expect(t).toContain("60");
    expect(t).toContain("1");
    expect(t).toContain("os 7 dias anteriores");
  });
});

describe("as superfícies declaram a base — nenhuma nasce muda", () => {
  const T = getTheme("light");
  // A cor que um delta positivo ganha: é ela que afirma o sinal.
  const corDoSinal = uiDisplayColor(T, T.pos);
  const delta = (base: { atual: number; anterior: number }) =>
    renderDesignMarkup(
      <DeltaVsAnterior
        atual={5.53}
        anterior={-20.06}
        base={base}
        rotuloAnterior="os 7 dias anteriores"
      />,
    );

  it("com base curta, o DOM não traz número nem sinal — só a explicação", () => {
    const html = delta({ atual: 60, anterior: 1 });
    expect(html).toContain("amostra curta");
    expect(html).toContain("60");
    expect(html).toContain("os 7 dias anteriores");
    // O que NÃO pode chegar: a afirmação.
    expect(html).not.toContain("p.p.");
    expect(html).not.toContain("+25");
    expect(html).not.toContain(corDoSinal);
  });

  it("com base folgada, o delta volta a afirmar — a guarda não come o caso bom", () => {
    const html = delta({ atual: 60, anterior: 25 });
    expect(html).toContain("p.p.");
    expect(html).toContain("vs os 7 dias anteriores");
    expect(html).toContain(corDoSinal);
    expect(html).not.toContain("amostra curta");
  });
});
