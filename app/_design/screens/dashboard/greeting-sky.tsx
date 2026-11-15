import type { ReactNode } from "react";
import { moonIllumination, type SpSky } from "@/src/domain/sky";
import { useDesign } from "../../kit/context";
import { useChartId } from "../../lib/responsive-chart";

/*
 * O sol ou a lua ao lado do "Bom dia, Fabricio", em emoji 3D. De dia, o sol
 * da hora: nascendo e se pondo atrás de nuvens, com uma nuvenzinha à tarde.
 * À noite, a lua na fase do dia, como se vê do Brasil, do mesmo tamanho do
 * sol para ficar à mesma distância do nome. Tudo desenhado em 64×64.
 */

type Tint = { top: string; bottom: string; shadow: string };
type SunColors = readonly [string, string, string, string, string];

const HIGH_SUN: SunColors = ["#fff8cc", "#ffdc4f", "#ffb21f", "#f7900e", "#d45f00"];
const WHITE_CLOUD: Tint = { top: "#ffffff", bottom: "#d9e3f0", shadow: "rgba(170,95,20,.32)" };
const LOW_SUN = {
  sunrise: {
    body: ["#fff4cc", "#ffd46a", "#ffa647", "#f98a2e", "#d86410"] as SunColors,
    glow: "#ffc98a", ray: ["#ffd46a", "#ff9a3a"],
    cloud: { top: "#fff8f5", bottom: "#f5cfdc", shadow: "rgba(200,90,110,.28)" },
  },
  sunset: {
    body: ["#ffe2ae", "#ffa55e", "#f5703a", "#df482a", "#a8301a"] as SunColors,
    glow: "#ff9468", ray: ["#ffae6b", "#ec5d33"],
    cloud: { top: "#fff1e8", bottom: "#dcb0d4", shadow: "rgba(150,60,110,.3)" },
  },
} as const;

const MOON = {
  lit: ["#fffef7", "#fff4c9", "#fcdf86", "#efc35b", "#d9a23c"],
  litStops: ["0", ".26", ".6", ".86", "1"],
  shade: "#b06d12", rim: "#fffbea", glow: "#ffe39a", bounce: "#fff2c6",
  bowl: ["#a8691a", "#c48a30", "#fff4d6"],
};
// O lado escuro também é uma esfera: lilás acinzentado no claro, azul-noite no escuro.
const MOON_DARK_SIDE = {
  light: { stops: ["#d3d7ea", "#a7adcb", "#8088ad"], crater: "rgba(70,78,125,.2)", rim: "rgba(80,88,135,.3)" },
  dark: { stops: ["#4f5677", "#333954", "#23273b"], crater: "rgba(10,12,30,.3)", rim: "rgba(170,180,230,.2)" },
};
// Crateras fixas: no lado claro têm fundo e borda; no escuro, só a marca.
const CRATERS = [[39.5, 22, 4.8], [24, 39.5, 4], [41, 41.5, 3.1], [30.5, 49, 2.2], [48, 31, 2.1], [14.5, 34.5, 1.8], [32.5, 31.5, 1.5], [20.5, 47, 1.3], [27, 13.5, 1.4]] as const;

/** Parte iluminada da lua vista do hemisfério norte; quem desenha espelha para o Brasil. */
function litPath(phase: number, cx: number, cy: number, r: number): string {
  const k = Math.cos(2 * Math.PI * phase), rx = Math.max(0.001, Math.abs(k) * r);
  const top = `${cx} ${cy - r}`, bottom = `${cx} ${cy + r}`;
  if (phase < 0.5) return `M${top} A${r} ${r} 0 0 1 ${bottom} A${rx} ${r} 0 0 ${k > 0 ? 0 : 1} ${top} Z`;
  return `M${top} A${r} ${r} 0 0 0 ${bottom} A${rx} ${r} 0 0 ${k > 0 ? 1 : 0} ${top} Z`;
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const at = (deg: number) => `${(cx + r * Math.cos(deg * Math.PI / 180)).toFixed(2)} ${(cy + r * Math.sin(deg * Math.PI / 180)).toFixed(2)}`;
  return `M${at(fromDeg)} A${r} ${r} 0 0 1 ${at(toDeg)}`;
}

const highlight = (id: string) => (
  <radialGradient id={id}><stop offset="0" stopColor="#fff" stopOpacity={0.9} /><stop offset="1" stopColor="#fff" stopOpacity={0} /></radialGradient>
);

function SunBody({ id, cx, cy, r, colors, highlightId }: { id: string; cx: number; cy: number; r: number; colors: SunColors; highlightId: string }) {
  const hx = cx - r * 0.36, hy = cy - r * 0.45;
  return (
    <>
      <defs>
        <radialGradient id={`${id}-body`} cx="40%" cy="34%" r="72%" fx="36%" fy="30%">
          <stop offset="0" stopColor={colors[0]} /><stop offset=".36" stopColor={colors[1]} /><stop offset=".8" stopColor={colors[2]} /><stop offset="1" stopColor={colors[3]} />
        </radialGradient>
        <radialGradient id={`${id}-shade`} cx="38%" cy="32%" r="78%">
          <stop offset=".6" stopColor={colors[4]} stopOpacity={0} /><stop offset="1" stopColor={colors[4]} stopOpacity={0.34} />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={r} fill={`url(#${id}-body)`} />
      <circle cx={cx} cy={cy} r={r} fill={`url(#${id}-shade)`} />
      <ellipse cx={hx} cy={hy} rx={r * 0.42} ry={r * 0.25} transform={`rotate(-32 ${hx} ${hy})`} fill={`url(#${highlightId})`} />
    </>
  );
}

const CLOUD_SHAPE = (
  <>
    <rect x={0} y={-9} width={30} height={9} rx={4.5} />
    <circle cx={8.5} cy={-8.2} r={6.2} />
    <circle cx={17} cy={-11.2} r={8} />
    <circle cx={24.6} cy={-6.8} r={5.2} />
  </>
);

/** Nuvem fofa com origem no canto de baixo à esquerda e 30 de largura. */
function Cloud({ id, x, y, scale, tint, drift = true }: { id: string; x: number; y: number; scale: number; tint: Tint; drift?: boolean }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-fill`} gradientUnits="userSpaceOnUse" x1={0} y1={-19} x2={0} y2={0}>
          <stop offset="0" stopColor={tint.top} /><stop offset="1" stopColor={tint.bottom} />
        </linearGradient>
        <filter id={`${id}-blur`} x="-30%" y="-40%" width="160%" height="180%"><feGaussianBlur stdDeviation={1.2} /></filter>
      </defs>
      <g transform={`translate(${x} ${y}) scale(${scale})`}>
        <g className={drift ? "sky-drift" : undefined}>
          <g fill={tint.shadow} filter={`url(#${id}-blur)`} transform="translate(-.6 1.4)">{CLOUD_SHAPE}</g>
          <g fill={`url(#${id}-fill)`}>{CLOUD_SHAPE}</g>
          <ellipse cx={15} cy={-15.2} rx={4.6} ry={1.9} fill="#fff" opacity={0.85} />
          <ellipse cx={7} cy={-11} rx={2.4} ry={1.1} fill="#fff" opacity={0.7} />
        </g>
      </g>
    </>
  );
}

function HighSun({ id, withCloud }: { id: string; withCloud: boolean }) {
  return (
    <>
      <defs>
        {highlight(`${id}-hl`)}
        <radialGradient id={`${id}-glow`}><stop offset=".45" stopColor="#ffc94d" stopOpacity={0.36} /><stop offset="1" stopColor="#ffc94d" stopOpacity={0} /></radialGradient>
        <linearGradient id={`${id}-ray`} x1={0} y1={0} x2={0} y2={1}><stop offset="0" stopColor="#ffd752" /><stop offset="1" stopColor="#ff9a1a" /></linearGradient>
      </defs>
      <circle cx={32} cy={32} r={31} fill={`url(#${id}-glow)`} />
      <g className="sky-spin" fill={`url(#${id}-ray)`} stroke={`url(#${id}-ray)`} strokeWidth={2.6} strokeLinejoin="round">
        {Array.from({ length: 10 }, (_, i) => <path key={i} d="M32 5 L35.4 17.5 L28.6 17.5 Z" transform={`rotate(${i * 36} 32 32)`} />)}
      </g>
      <SunBody id={`${id}-sun`} cx={32} cy={32} r={16.5} colors={HIGH_SUN} highlightId={`${id}-hl`} />
      {withCloud && <Cloud id={`${id}-cloud`} x={29} y={58} scale={1.02} tint={WHITE_CLOUD} />}
    </>
  );
}

/** O sol baixo, meio escondido atrás de nuvens rosadas (nascer) ou lilases (pôr). */
function LowSun({ id, rising }: { id: string; rising: boolean }) {
  const cy = 38, r = 15.5;
  const c = rising ? LOW_SUN.sunrise : LOW_SUN.sunset;
  return (
    <>
      <defs>
        {highlight(`${id}-hl`)}
        <radialGradient id={`${id}-glow`} cy="59%"><stop offset=".35" stopColor={c.glow} stopOpacity={0.5} /><stop offset="1" stopColor={c.glow} stopOpacity={0} /></radialGradient>
        <linearGradient id={`${id}-ray`} x1={0} y1={0} x2={0} y2={1}><stop offset="0" stopColor={c.ray[0]} /><stop offset="1" stopColor={c.ray[1]} /></linearGradient>
      </defs>
      <circle cx={32} cy={cy} r={30} fill={`url(#${id}-glow)`} />
      <g className={rising ? "sky-rise" : "sky-sink"}>
        <g className="sky-breathe" fill={`url(#${id}-ray)`} stroke={`url(#${id}-ray)`} strokeWidth={2.4} strokeLinejoin="round">
          {Array.from({ length: 7 }, (_, i) => <path key={i} d={`M32 ${cy - 26} L34.6 ${cy - r - 1} L29.4 ${cy - r - 1} Z`} transform={`rotate(${(i - 3) * 27} 32 ${cy})`} />)}
        </g>
        <SunBody id={`${id}-sun`} cx={32} cy={cy} r={r} colors={c.body} highlightId={`${id}-hl`} />
      </g>
      <Cloud id={`${id}-back`} x={2} y={60} scale={1.08} tint={c.cloud} drift={false} />
      <Cloud id={`${id}-front`} x={28.5} y={58} scale={1} tint={c.cloud} />
    </>
  );
}

function Star({ x, y, size, fill, delay }: { x: number; y: number; size: number; fill: string; delay?: 2 | 3 }) {
  const c = size * 0.2;
  return (
    <g className={delay ? `sky-twinkle sky-twinkle-${delay}` : "sky-twinkle"}>
      <path d={`M${x} ${y - size} Q${x + c} ${y - c} ${x + size} ${y} Q${x + c} ${y + c} ${x} ${y + size} Q${x - c} ${y + c} ${x - size} ${y} Q${x - c} ${y - c} ${x} ${y - size} Z`} fill={fill} />
      <circle cx={x - size * 0.1} cy={y - size * 0.1} r={size * 0.17} fill="#fff" opacity={0.95} />
    </g>
  );
}

/** A lua dourada em 3D, na fase do dia, com a borda da sombra suave. */
function Moon({ id, phase, darkTheme }: { id: string; phase: number; darkTheme: boolean }) {
  const R = 23, cx = 31, cy = 32, hx = cx - 8.5, hy = cy - 10;
  const lit = moonIllumination(phase);
  const side = darkTheme ? MOON_DARK_SIDE.dark : MOON_DARK_SIDE.light;
  const url = (name: string) => `url(#${id}-${name})`;
  const sphere = { gradientUnits: "userSpaceOnUse", cx: cx - 6, cy: cy - 8, r: R * 1.32, fx: cx - 9, fy: cy - 11 } as const;
  const glare = <ellipse cx={hx} cy={hy} rx={8.5} ry={4.8} transform={`rotate(-32 ${hx} ${hy})`} fill={url("hl")} />;
  return (
    <>
      <defs>
        <radialGradient id={`${id}-glow`} gradientUnits="userSpaceOnUse" cx={cx} cy={cy} r={31.5}>
          <stop offset=".68" stopColor={MOON.glow} stopOpacity={0.2 + lit * 0.45} /><stop offset="1" stopColor={MOON.glow} stopOpacity={0} />
        </radialGradient>
        <radialGradient id={`${id}-lit`} {...sphere}>
          {MOON.lit.map((color, i) => <stop key={color} offset={MOON.litStops[i]} stopColor={color} />)}
        </radialGradient>
        <radialGradient id={`${id}-dark`} {...sphere}>
          <stop offset="0" stopColor={side.stops[0]} /><stop offset=".62" stopColor={side.stops[1]} /><stop offset="1" stopColor={side.stops[2]} />
        </radialGradient>
        <radialGradient id={`${id}-shade`} gradientUnits="userSpaceOnUse" cx={cx - 3} cy={cy - 4} r={R + 1}>
          <stop offset=".6" stopColor={MOON.shade} stopOpacity={0} /><stop offset="1" stopColor={MOON.shade} stopOpacity={0.42} />
        </radialGradient>
        <linearGradient id={`${id}-bowl`} x1={0} y1={0} x2={1} y2={1}>
          <stop offset="0" stopColor={MOON.bowl[0]} stopOpacity={0.62} /><stop offset=".55" stopColor={MOON.bowl[1]} stopOpacity={0.34} /><stop offset="1" stopColor={MOON.bowl[2]} stopOpacity={0.55} />
        </linearGradient>
        <radialGradient id={`${id}-hl`}><stop offset="0" stopColor="#fff" stopOpacity={0.95} /><stop offset="1" stopColor="#fff" stopOpacity={0} /></radialGradient>
        <radialGradient id={`${id}-star`} cx="42%" cy="40%" r="60%"><stop offset="0" stopColor="#fffdf2" /><stop offset=".5" stopColor="#ffe07a" /><stop offset="1" stopColor="#f5b52e" /></radialGradient>
        <filter id={`${id}-soft`} x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation={1} /></filter>
        <filter id={`${id}-blur`} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation={0.7} /></filter>
        <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" x={0} y={0} width={64} height={64}>
          <path d={litPath(phase, cx, cy, R + 1.6)} transform={`translate(${2 * cx} 0) scale(-1 1)`} fill="#fff" filter={url("soft")} />
        </mask>
      </defs>
      <circle cx={cx} cy={cy} r={31.5} fill={url("glow")} />
      <circle cx={cx} cy={cy} r={R} fill={url("dark")} />
      <g fill={side.crater}>{CRATERS.map(([x, y, r]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={r} />)}</g>
      <g opacity={0.25}>{glare}</g>
      <circle cx={cx} cy={cy} r={R - 0.45} fill="none" stroke={side.rim} strokeWidth={0.9} />
      {lit > 0.015 && (
        <g mask={url("mask")}>
          <circle cx={cx} cy={cy} r={R} fill={url("lit")} />
          {CRATERS.map(([x, y, r]) => (
            <g key={`${x}-${y}`}>
              <circle cx={x} cy={y} r={r} fill={url("bowl")} />
              <path d={`M${x - r * 0.74} ${y + r * 0.67} A${r} ${r} 0 0 0 ${x + r * 0.7} ${y - r * 0.71}`} fill="none" stroke={MOON.rim} strokeOpacity={0.95} strokeWidth={Math.max(0.6, r * 0.2)} strokeLinecap="round" />
            </g>
          ))}
          <circle cx={cx} cy={cy} r={R} fill={url("shade")} />
          <path d={arcPath(cx, cy, R - 1.6, 15, 105)} stroke={MOON.bounce} strokeOpacity={0.75} strokeWidth={1.8} fill="none" strokeLinecap="round" filter={url("blur")} />
          <g opacity={0.9}>{glare}</g>
        </g>
      )}
      <Star x={55.5} y={8.5} size={6.6} fill={url("star")} />
      <Star x={7.5} y={55.5} size={4.2} fill={url("star")} delay={2} />
      <Star x={58.5} y={49} size={2.6} fill={url("star")} delay={3} />
    </>
  );
}

export function GreetingSky({ sky, size = 46 }: { sky: SpSky; size?: number }) {
  const { T } = useDesign();
  const id = useChartId("ceu");
  let art: ReactNode;
  if (sky.moment === "night") art = <Moon id={id} phase={sky.moonPhase} darkTheme={T.mode === "dark"} />;
  else if (sky.moment === "sunrise" || sky.moment === "sunset") art = <LowSun id={id} rising={sky.moment === "sunrise"} />;
  else art = <HighSun id={id} withCloud={sky.moment === "afternoon"} />;
  return (
    // Enfeite: o nome da saudação fica só com o texto; o balão diz a hora do sol ou a fase da lua.
    <span aria-hidden="true" title={sky.label} style={{ display: "inline-block", verticalAlign: "middle", margin: "-14px 0 -12px 6px", position: "relative", top: -2, lineHeight: 0 }}>
      <svg className="sky-pop" width={size} height={size} viewBox="0 0 64 64">{art}</svg>
    </span>
  );
}
