import { describe, expect, it } from "vitest";
import { sampleChartPoints, uiReadableOn, uiSmooth, uiStableIndex } from "@/app/_design/utils";

describe("uiReadableOn", () => {
  it("escolhe o foreground de maior contraste WCAG", () => {
    expect(uiReadableOn("#a9803c")).toBe("#1a1408");
    expect(uiReadableOn("#785822")).toBe("#ffffff");
    expect(uiReadableOn("#fff")).toBe("#1a1408");
    expect(uiReadableOn("#000")).toBe("#ffffff");
  });
});

describe("uiStableIndex", () => {
  it("a mesma chave cai sempre no mesmo índice, dentro do intervalo", () => {
    expect(uiStableIndex("cestinha", 7)).toBe(uiStableIndex("cestinha", 7));
    for (const key of ["", "main", "big-data", "um-slug-bem-mais-comprido-que-os-outros"]) {
      const index = uiStableIndex(key, 7);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(7);
    }
    expect(uiStableIndex("main", 0)).toBe(0);
  });
});

describe("uiSmooth", () => {
  it("mantém o traçado de 25 mil pontos dentro de um orçamento proporcional à largura", () => {
    const points = Array.from({ length: 25_000 }, (_, i) => ({ x: 800 * i / 24_999, y: 100 + Math.sin(i) * 80 }));
    const d = uiSmooth(points);
    expect(d.length).toBeLessThan(300_000);
    expect(d).toMatch(/^M0,100/);
    expect(Number(d.split(",").at(-1))).toBeCloseTo(points.at(-1)!.y, 1);
  });

  it("todo path começa por M, inclusive com um ponto só", () => {
    expect(uiSmooth([])).toBe("");
    expect(uiSmooth([{ x: 484, y: 108 }])).toBe("M484,108");
    const dois = uiSmooth([{ x: 0, y: 10 }, { x: 100, y: 50 }]);
    expect(dois.startsWith("M0,10 C")).toBe(true);
    expect(dois.endsWith(" 100,50")).toBe(true);
  });

  it("a área fechada sobre a curva continua um path válido com um ponto", () => {
    // É assim que os gráficos montam a área: a curva e o retorno pela base.
    const area = `${uiSmooth([{ x: 484, y: 108 }])} L484,200 L484,200 Z`;
    expect(area).toMatch(/^M484,108 L/);
  });
});

describe("resolução da curva por pixel", () => {
  it("conserva os picos, os vales, a ordem e as pontas sem alterar a série original", () => {
    const points = Array.from({ length: 25_000 }, (_, i) => ({ x: 800 * i / 24_999, y: 100, index: i }));
    points[12001]!.y = -500;
    points[12003]!.y = 900;
    const samples = sampleChartPoints(points);
    expect(samples.length).toBeLessThanOrEqual(4 * 801);
    expect(samples[0]).toBe(points[0]);
    expect(samples.at(-1)).toBe(points.at(-1));
    expect(samples).toContain(points[12001]);
    expect(samples).toContain(points[12003]);
    expect(samples.map((p) => p.index)).toEqual(samples.map((p) => p.index).sort((a, b) => a - b));
    expect(new Set(samples).size).toBe(samples.length);
    expect(points).toHaveLength(25_000);
  });
});


describe("a curva financeira não inventa extremos", () => {
  it.each([
    { label: "pico de lucro", values: [0, 100, 100, 0] },
    { label: "drawdown após recuperação", values: [0, -100, 0, 0] },
    { label: "perda máxima", values: [0, -100, -100, 0] },
  ])("suavização respeita cada resultado observado: $label", ({ values }) => {
    const points = values.map((y, i) => ({ x: i * 100, y }));
    const path = uiSmooth(points);
    const segments = [...path.matchAll(/C([^C]+)/g)].map((match) => match[1]!.trim().split(/[ ,]+/).map(Number));
    expect(segments).toHaveLength(points.length - 1);
    segments.forEach((segment, i) => {
      const from = points[i]!, to = points[i + 1]!;
      const [x1, y1, x2, y2, x3, y3] = segment as [number, number, number, number, number, number];
      for (let step = 0; step <= 100; step++) {
        const t = step / 100, u = 1 - t;
        const x = u ** 3 * from.x + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3;
        const y = u ** 3 * from.y + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3;
        expect(x).toBeGreaterThanOrEqual(from.x - 0.01);
        expect(x).toBeLessThanOrEqual(to.x + 0.01);
        expect(y).toBeGreaterThanOrEqual(Math.min(from.y, to.y) - 0.01);
        expect(y).toBeLessThanOrEqual(Math.max(from.y, to.y) + 0.01);
      }
    });
  });
});
