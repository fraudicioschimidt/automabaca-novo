import { uiDisplayColor, uiHexA, uiSmooth } from "../../utils";
import { useDesign } from "../../kit/context";

/** Minicurva de lucro acumulado das linhas do ranking. */
export function Spark({ data, w = 132, h = 34, color, fluid = false }: {
  data: number[];
  w?: number;
  h?: number;
  color?: string;
  /** Ocupa a largura do contêiner (viewBox esticado) em vez de `w` fixo. */
  fluid?: boolean;
}) {
  const { T, mode } = useDesign();
  const lo = Math.min(0, ...data), hi = Math.max(0, ...data), rng = (hi - lo) || 1;
  // Com um ponto só, `i / (length - 1)` divide por zero e o SVG vira `MNaN,NaN`:
  // justamente o tipster no primeiro dia de dados ficaria sem curva.
  const X = (i: number) => (data.length === 1 ? w / 2 : (w - 4) * (i / (data.length - 1)) + 2);
  const Y = (v: number) => 3 + (h - 6) * (1 - (v - lo) / rng);
  const pts = data.map((v, i) => ({ x: X(i), y: Y(v) }));
  const first = pts[0], last = pts[pts.length - 1], lastValue = data[data.length - 1];
  if (!first || !last || lastValue === undefined) return null;
  const line = uiSmooth(pts);
  const c = uiDisplayColor(T, color || (lastValue >= 0 ? T.pos : T.neg));
  return (
    <svg width={fluid ? '100%' : w} height={h} viewBox={fluid ? `0 0 ${w} ${h}` : undefined} preserveAspectRatio={fluid ? 'none' : undefined} style={{ display: 'block' }}>
      <line x1={2} x2={w - 2} y1={Y(0)} y2={Y(0)} stroke={T.borderSoft} strokeDasharray="2 3" />
      <path d={line + ` L${last.x},${h} L${first.x},${h} Z`} fill={uiHexA(c, mode === 'dark' ? 0.16 : 0.1)} />
      <path d={line} fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last.x} cy={last.y} r="2.6" fill={c} />
    </svg>
  );
}
