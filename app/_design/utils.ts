// Cor e traçado compartilhados pelas telas do design, e o estado persistido.
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { Theme } from "./theme";

function hexToInt(hex: string): number {
  const h = hex.replace("#", "");
  return parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
}

export function uiHexA(hex: string, a: number): string {
  const n = hexToInt(hex);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Tinta legível (escura ou branca) sobre um fundo `hex`, pelo maior contraste WCAG. */
export function uiReadableOn(hex: string): string {
  const luminance = (rgb: number) => {
    const channels = [rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255].map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const background = luminance(hexToInt(hex));
  const dark = parseInt("1a1408", 16);
  const light = parseInt("ffffff", 16);
  const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return contrast(background, luminance(dark)) >= contrast(background, luminance(light))
    ? "#1a1408"
    : "#ffffff";
}

/** Índice estável em [0, n) a partir de um texto: a mesma chave cai sempre na mesma cor. */
export function uiStableIndex(key: string, n: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return n > 0 ? h % n : 0;
}

// Cores vivas são reservadas a marca, números grandes e marcas gráficas.
// Texto pequeno e controles continuam usando os tokens semânticos AA.
export function uiDisplayColor(T: Theme, color: string): string {
  if (color === T.pos) return T.posDisplay || T.pos;
  if (color === T.neg) return T.negDisplay || T.neg;
  if (color === T.accent) return T.brandAccent || T.accent;
  if (color === T.chartLine) return T.chartLineDisplay || T.chartLine;
  if (color === T.chartClv) return T.chartClvDisplay || T.chartClv;
  return color;
}

/** Coordenada de desenho, em centésimos de pixel; os valores da aposta ficam intactos. */
export function chartCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Série ordenada no eixo x: conserva primeiro, último, mínimo e máximo de
 * cada pixel. O traço fica proporcional à largura; o cursor usa a série inteira.
 */
export function sampleChartPoints<T extends { x: number; y: number }>(points: readonly T[]): readonly T[] {
  const first = points[0], last = points.at(-1);
  if (!first || !last || points.length <= 4 * Math.max(1, Math.ceil(last.x - first.x))) return points;
  const sampled: T[] = [];
  let start = 0, min = 0, max = 0, bucket = Math.floor(first.x);
  const flush = (end: number) => {
    for (const index of [...new Set([start, min, max, end])].sort((a, b) => a - b)) sampled.push(points[index]!);
  };
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!;
    if (!Number.isFinite(point.x) || point.x < points[i - 1]!.x) return points;
    const nextBucket = Math.floor(point.x);
    if (nextBucket !== bucket) {
      flush(i - 1);
      start = min = max = i;
      bucket = nextBucket;
    } else {
      if (point.y < points[min]!.y) min = i;
      if (point.y > points[max]!.y) max = i;
    }
  }
  flush(points.length - 1);
  return sampled;
}

/**
 * Bézier pelos pontos, com controles limitados ao trecho: suavizar não pode
 * inventar picos de lucro ou drawdown. Um ponto gera só M; sem pontos, vazio.
 */
export function uiSmooth(points: ReadonlyArray<{ x: number; y: number }>): string {
  const pts = sampleChartPoints(points);
  const first = pts[0];
  if (!first) return "";
  const c = chartCoordinate;
  const bounded = (value: number, a: number, b: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), value));
  let d = `M${c(first.x)},${c(first.y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i]!, p2 = pts[i + 1]!;
    const p0 = pts[i - 1] || p1, p3 = pts[i + 2] || p2;
    const x1 = bounded(p1.x + (p2.x - p0.x) / 6, p1.x, p2.x);
    const y1 = bounded(p1.y + (p2.y - p0.y) / 6, p1.y, p2.y);
    const x2 = bounded(p2.x - (p3.x - p1.x) / 6, p1.x, p2.x);
    const y2 = bounded(p2.y - (p3.y - p1.y) / 6, p1.y, p2.y);
    d += ` C${c(x1)},${c(y1)} ${c(x2)},${c(y2)} ${c(p2.x)},${c(p2.y)}`;
  }
  return d;
}

/** Estado persistido no localStorage (namespaced). Ex.: `usePersistedState('analyzer:tab', 'overview')`. */
export function usePersistedState<V>(key: string, initial: V): [V, Dispatch<SetStateAction<V>>] {
  const full = "automabaca:ui:" + key;
  // O primeiro render precisa ser idêntico no servidor e no cliente. O
  // valor persistido entra no effect abaixo, depois da hidratação.
  const [value, setValue] = useState<V>(() => initial);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(full);
      if (stored != null) setValue(JSON.parse(stored) as V);
    } catch {
      // Armazenamento indisponível ou valor corrompido: fica o inicial.
    }
  }, [full]);
  useEffect(() => {
    try {
      localStorage.setItem(full, JSON.stringify(value));
    } catch {
      // Armazenamento indisponível (modo privado, cota): o estado vale só na sessão.
    }
  }, [full, value]);
  return [value, setValue];
}
