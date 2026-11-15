// @vitest-environment jsdom
import { renderDesignMarkup } from "../helpers/design-markup";
import { act } from "react";
import * as designUtils from "@/app/_design/utils";
import { renderClickable } from "../helpers/click-render";
import { describe, expect, it, vi } from "vitest";
import { AreaChart, MultiCurveChart, MonthlyChart } from "@/app/_design/screens/analyzer/charts/linha-do-tempo";
import { getTheme } from "@/app/_design/theme";

const T = getTheme("light");

describe("gráficos do Analyzer", () => {
  it("cursor lê a série completa sem redesenhar a geometria do traço", () => {
    const draw = vi.spyOn(designUtils, "uiSmooth");
    const points = Array.from({ length: 2500 }, (_, i) => ({ v: i / 10, label: `Aposta ${i}` }));
    const view = renderClickable(<AreaChart pts={points} color={T.pos} />);
    try {
      const svg = view.container.querySelector("svg")!;
      vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, width: 800, height: 250 }));
      act(() => window.dispatchEvent(new Event("resize")));
      draw.mockClear();
      for (const clientX of [50, 400, 780]) act(() => svg.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX })));
      expect(view.container.textContent).toContain("Acumulado");
      expect(view.container.textContent).toMatch(/Aposta 24/);
      expect(draw).not.toHaveBeenCalled();
    } finally { view.unmount(); vi.restoreAllMocks(); }
  });

  it("renderiza a evolução acumulada sem depender de variáveis de outro gráfico", () => {
    const html = renderDesignMarkup(
      <AreaChart
        pts={[{ v: 0, label: "Início" }, { v: 1.25, label: "Hoje" }]}
        color={T.pos}
      />,
    );
    expect(html).toContain("Evolução acumulada");
    expect(html).toContain("Hoje");
  });

  it("desenha a curva de pé: tempo da esquerda para a direita, lucro maior mais alto", () => {
    const html = renderDesignMarkup(
      <AreaChart
        pts={[{ v: -1, label: "Início" }, { v: 0.5 }, { v: 2, label: "Hoje" }]}
        color={T.pos}
      />,
    );
    // Os vértices da linha: o `M` e o fim de cada trecho `C` do traço sem preenchimento.
    const linha = /<path d="(M[^"]+)" fill="none"/.exec(html)?.[1] ?? "";
    const pontos = [...linha.matchAll(/(?:M|\s)([-\d.]+),([-\d.]+)(?=\s+C|$)/g)].map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
    expect(pontos).toHaveLength(3);
    const [primeiro, meio, ultimo] = pontos as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    expect(primeiro.x).toBeLessThan(meio.x);
    expect(meio.x).toBeLessThan(ultimo.x);
    // SVG cresce para baixo: valor maior é y MENOR.
    expect(ultimo.y).toBeLessThan(meio.y);
    expect(meio.y).toBeLessThan(primeiro.y);
    // O rótulo do eixo mais alto é o maior valor.
    const rotulos = [...html.matchAll(/<text x="0" y="([\d.]+)"[^>]*>([^<]+)<\/text>/g)]
      .map(([, y, texto]) => ({ y: Number(y), texto: texto ?? "" }))
      .sort((a, b) => a.y - b.y);
    expect(rotulos[0]!.texto.startsWith("+")).toBe(true);
    expect(rotulos.at(-1)!.texto.startsWith("-")).toBe(true);
  });

  it("a linha é lisa: um ponto só, no último valor", () => {
    const html = renderDesignMarkup(
      <AreaChart pts={Array.from({ length: 30 }, (_, i) => ({ v: Math.sin(i) * i, label: `${i + 1}/08` }))} color={T.pos} />,
    );
    const circulos = [...html.matchAll(/<circle cx="([\d.]+)"/g)].map(([, x]) => Number(x));
    expect(circulos).toHaveLength(1);
    const xs = [...html.matchAll(/<path d="M([\d.]+),/g)].map(([, x]) => Number(x));
    expect(circulos[0]).toBeGreaterThan(Math.max(...xs));
  });

  /**
   * A borda direita carrega o EIXO do ROI, não o ROI do último item: esse
   * rótulo ficaria a meia largura do ponto que nomeia quando há um período só,
   * e `data[n-1]` não é "o mais recente" em "Top casas por lucro", onde o eixo
   * x não é tempo. O valor de cada ponto vem no hover.
   * Ver `tests/painel/eixo-secundario`.
   */
  it("declara o eixo do ROI em vez de rotular um ponto na borda", () => {
    const html = renderDesignMarkup(
      <MonthlyChart
        data={[
          { label: "Jun", v: 1, roi: 3 },
          { label: "Jul", v: 2, roi: 8 },
        ]}
      />,
    );
    expect(html).toContain("0.0%");
    expect(html).not.toContain("+8.0%");
  });

  it("sem nenhum ROI no recorte, não desenha o eixo do ROI", () => {
    const html = renderDesignMarkup(
      <MonthlyChart
        data={[
          { label: "Jun", v: 1, roi: null },
          { label: "Jul", v: -0.5, roi: null },
        ]}
      />,
    );
    expect(html).toContain("Jul");
    expect(html).not.toContain("0.0%");
    expect(html).not.toContain("5.5%");
  });

  it("várias curvas no mesmo eixo: a legenda nomeia cada uma e a que lucra mais termina mais alto", () => {
    const html = renderDesignMarkup(
      <MultiCurveChart
        labels={["", "01/09", "02/09"]}
        series={[
          { key: "alta", name: "Sobe", color: T.chartSeries[0]!, values: [0, 1, 3] },
          { key: "baixa", name: "Desce", color: T.chartSeries[1]!, values: [0, -1, -2] },
        ]}
      />,
    );
    expect(html).toContain("Sobe");
    expect(html).toContain("Desce");
    const curveEnd = (key: string) => {
      const d = html.match(new RegExp(`data-curve="${key}"[^>]*d="([^"]+)"`))?.[1] ?? "";
      return Number(d.split(",").at(-1));
    };
    // SVG cresce para baixo: o fim da curva que sobe tem y menor.
    expect(curveEnd("alta")).toBeLessThan(curveEnd("baixa"));
  });
});
