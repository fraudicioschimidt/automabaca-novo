import { renderDesignMarkup } from "../helpers/design-markup";
import { describe, expect, it } from "vitest";
import { HBars } from "@/app/_design/screens/analyzer/charts/distribuicao";
import {
  escalaDeBarras,
  regua,
  type BarraGeom,
} from "@/app/_design/lib/barra-com-sinal";

/**
 * Onde o valor cai no trilho: a ponta livre da barra. Numa barra negativa é a
 * ESQUERDA (a direita está ancorada no zero, igual para todas as negativas).
 */
function pontaDaBarra(b: BarraGeom): number {
  return b.negativa ? b.esquerdaPct : b.esquerdaPct + b.larguraPct;
}

/**
 * Barra não desenha o MÓDULO deixando o sinal só na cor.
 *
 * Largura a partir de `Math.abs(valor)`, ancorada na borda esquerda, faz
 * comprimento e mérito apontarem para lados opostos — e o olho lê comprimento
 * antes de cor. Com ROI −0,2% contra −2,5%, a PIOR casa desenharia a barra mais
 * longa; com CLV de −20% a +30%, a aposta que mais perdeu para o fechamento
 * desenharia mais que uma que ganhou +10%.
 *
 * A propriedade que mata a classe inteira é uma só: **a posição da ponta livre
 * da barra é monotônica no valor**. Ela é varrida abaixo sobre uma grade, e
 * nenhuma implementação que use módulo como comprimento a satisfaz.
 *
 * O portão também cobre a régua (a referência agregada):
 * ela entra na escala em vez de ser desenhada na borda, e a legenda tem de
 * declarar a BASE — agregado sem base é a armadilha do `resumo-de-apostas`.
 */

describe("a escala carrega o sinal na geometria", () => {
  /**
   * A propriedade central. Se alguém voltar a usar `Math.abs` como comprimento,
   * este caso cai: dois valores simétricos passariam a ter a MESMA ponta.
   */
  it("a ponta da barra é monotônica no valor", () => {
    const valores = [-20.06, -12, -2.5, -0.2, 0, 0.2, 4, 10, 29.97];
    const { barras } = escalaDeBarras(valores);
    const pontas = barras.map(pontaDaBarra);
    for (let i = 1; i < valores.length; i += 1) {
      expect(
        pontas[i]!,
        `valor ${valores[i]} devia terminar à direita de ${valores[i - 1]}`,
      ).toBeGreaterThan(pontas[i - 1]!);
    }
  });

  it("com negativo o trilho centra, e o negativo cresce para a esquerda", () => {
    const { centrada, barras } = escalaDeBarras([-2.5, -0.2]);
    expect(centrada).toBe(true);
    expect(barras[0]!.negativa).toBe(true);
    expect(barras[0]!.esquerdaPct).toBeLessThan(50);
    // A ponta ancorada é o zero, no meio: as duas terminam ali.
    expect(barras[0]!.esquerdaPct + barras[0]!.larguraPct).toBeCloseTo(50);
  });

  it("sem negativo o trilho NÃO centra — metade da largura não se joga fora", () => {
    const { centrada, barras } = escalaDeBarras([10, 40, 25]);
    expect(centrada).toBe(false);
    expect(barras.every((b) => b.esquerdaPct === 0)).toBe(true);
    expect(barras[1]!.larguraPct).toBe(100);
  });

  it("valor nulo ou zero não desenha comprimento, e a linha continua existindo", () => {
    const { barras } = escalaDeBarras([5, null, 0, undefined]);
    expect(barras).toHaveLength(4);
    expect(barras.slice(1).every((b) => b.larguraPct === 0)).toBe(true);
  });

  it("escala sem alcance (tudo zero) não inventa proporção", () => {
    const e = escalaDeBarras([0, 0], { referencia: 0 });
    expect(e.barras.every((b) => b.larguraPct === 0)).toBe(true);
    expect(e.reguaPct).toBeNull();
  });
});

describe("a régua entra na escala e declara a base", () => {
  it("referência além do maior valor não é desenhada fora do trilho", () => {
    const e = escalaDeBarras([1, 2], { referencia: 10 });
    expect(e.reguaPct).toBe(100);
    expect(Math.max(...e.barras.map(pontaDaBarra))).toBeLessThanOrEqual(100);
  });

  it("referência negativa centra o trilho mesmo com todos os valores positivos", () => {
    const e = escalaDeBarras([1, 2], { referencia: -1 });
    expect(e.centrada).toBe(true);
    expect(e.reguaPct!).toBeLessThan(50);
  });

  it("sem referência não há régua", () => {
    expect(escalaDeBarras([1, 2]).reguaPct).toBeNull();
  });

  /**
   * Com uma casa só, a régua sairia colada na ponta da única barra, com a
   * legenda repetindo o número que já está ao lado dela.
   */
  it("com uma barra só, o agregado É a barra — e a régua some", () => {
    expect(escalaDeBarras([9.9], { referencia: 9.9 }).reguaPct).toBeNull();
    expect(escalaDeBarras([9.9, null], { referencia: 9.9 }).reguaPct).toBeNull();
    expect(escalaDeBarras([9.9, 2], { referencia: 6 }).reguaPct).not.toBeNull();
  });

  it("régua sem valor, sem texto ou sem descrição não vira marca", () => {
    expect(regua({ valor: null, texto: "x", descricao: "y" })).toBeNull();
    expect(regua({ valor: Number.NaN, texto: "x", descricao: "y" })).toBeNull();
    expect(regua({ valor: 1, texto: "", descricao: "y" })).toBeNull();
    expect(regua({ valor: 1, texto: "x", descricao: "" })).toBeNull();
    expect(regua({ valor: 1.5, texto: "+1,5%", descricao: "ROI agregado de 2 casas" }))
      .toEqual({ v: 1.5, rotulo: "ROI agregado de 2 casas: +1,5%" });
  });
});

describe("o desenho renderizado", () => {
  /** `left:12.5%;width:30%` de cada barra, na ordem em que saem no HTML. */
  function geometriasNoHtml(html: string): { esquerda: number; largura: number }[] {
    return [...html.matchAll(/left:([-\d.]+)%;width:([\d.]+)%/g)].map((m) => ({
      esquerda: Number(m[1]),
      largura: Number(m[2]),
    }));
  }

  /**
   * Com escala por módulo, a barra de −2,5% sairia com 100% de largura e a de
   * −0,2% com 8%.
   */
  it("a casa com ROI melhor termina à direita da pior", () => {
    const html = renderDesignMarkup(
      <HBars
        items={[
          { l: "(sem casa)", v: -0.2, label2: "−0,2%" },
          { l: "Bet365", v: -2.5, label2: "−2,5%" },
        ]}
      />,
    );
    const geoms = geometriasNoHtml(html);
    // Sem `left`, a barra é ancorada na borda e o sinal ficou só na cor.
    expect(geoms, "as barras não declaram posição no trilho").toHaveLength(2);
    const [semCasa, bet365] = geoms;
    expect(bet365!.esquerda).toBeLessThan(semCasa!.esquerda);
    expect(semCasa!.largura).toBeLessThan(bet365!.largura);
  });

  it("a régua sai no HTML com a legenda que a explica", () => {
    const html = renderDesignMarkup(
      <HBars
        items={[
          { l: "(sem casa)", v: -0.2, label2: "−0,2%" },
          { l: "Bet365", v: -2.5, label2: "−2,5%" },
        ]}
        referencia={regua({ valor: -0.9, texto: "−0,9%", descricao: "ROI agregado de 2 casas do gráfico" })}
      />,
    );
    expect(html).toContain('data-regua="true"');
    expect(html).toContain("ROI agregado de 2 casas do gráfico: −0,9%");
  });

  it("sem referência não sobra nem marca nem legenda", () => {
    const html = renderDesignMarkup(
      <HBars items={[{ l: "Bet365", v: -2.5, label2: "−2,5%" }, { l: "x", v: 1, label2: "1" }]} />,
    );
    expect(html).not.toContain("data-regua");
    expect(html).not.toContain("dashed");
  });
});
