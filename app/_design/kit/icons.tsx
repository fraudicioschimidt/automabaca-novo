import type { CSSProperties } from "react";

/**
 * Paths dos ícones das telas (viewBox 20×20, traço que herda `currentColor`).
 * Variantes com nome próprio (`arrowDown`/`arrowDownShort`, `trash`/`trashTall`)
 * desenham diferente de propósito: cada tela manteve o traço que já tinha.
 */
export const ICONS = {
  analyzer: "M3 16l5-6 4 3 5-8M3 19h16",
  arrow: "M4 10h11m-4-4l4 4-4 4",
  arrowDown: "M10 5v10m0 0l-4-4m4 4l4-4",
  arrowDownShort: "M10 6v8m0 0l4-4m-4 4l-4-4",
  arrowUp: "M10 15V5m0 0l-4 4m4-4l4 4",
  arrowUpShort: "M10 14V6m0 0l-4 4m4-4l4 4",
  back: "M13 4l-6 6 6 6",
  ban: "M5 5l10 10M10 3a7 7 0 100 14 7 7 0 000-14",
  bank: "M3 7l7-4 7 4M4 8h12v7H4zM7 8v7M13 8v7",
  bars: "M4 16V9m4 7V5m4 11v-4m4 4V8",
  bolt: "M11 2L4 12h5l-1 6 7-10h-5z",
  cal: "M4 5h12v11H4zM4 8h12M7 3v3M13 3v3",
  calc: "M5 3h10v14H5zM8 6h4M7 10h.01M10 10h.01M13 10h.01M7 13h.01M10 13h.01M13 13h.01",
  check: "M4 10l4 4 8-9",
  chevronDown: "M6 8l4 4 4-4",
  chevronDownWide: "M5 8l5 5 5-5",
  chevronRight: "M8 5l5 5-5 5",
  clock: "M10 5v5l3 2M10 3a7 7 0 100 14 7 7 0 000-14",
  close: "M5 5l10 10M15 5L5 15",
  clv: "M10 3a7 7 0 100 14 7 7 0 000-14M10 7v3l2 1",
  copy: "M7 7h8v8H7zM5 5h8",
  cup: "M6 4h8v3a4 4 0 01-8 0zM8 11h4M7 16h6M10 11v5",
  db: "M10 3c3.3 0 6 1 6 2.5S13.3 8 10 8 4 7 4 5.5 6.7 3 10 3zM4 5.5v9C4 16 6.7 17 10 17s6-1 6-2.5v-9M4 10c0 1.5 2.7 2.5 6 2.5s6-1 6-2.5",
  edit: "M13 4l3 3-8 8H5v-3z",
  export: "M10 3v9m0 0l-3-3m3 3l3-3M4 15v2h12v-2",
  filter: "M3 5h14M6 10h8M9 15h2",
  gift: "M4 9h12v7H4zM4 6h12v3H4zM10 6v10M10 6S8.5 3 6.5 4 8 6 10 6zM10 6s1.5-3 3.5-2-1.5 2-3.5 2",
  heart: "M3 11h3l2-5 3 9 2-4h4",
  inbox: "M3 11h4l1 2h4l1-2h4M4 11l2-6h8l2 6v4H4z",
  logo: "M3 14l4-5 3 2 4-6 3 4",
  logout: "M12 4H5v12h7M9 10h8m0 0l-3-3m3 3l-3 3",
  lucro: "M3 16l5-6 4 3 5-8",
  menu: "M4 6h12M4 10h12M4 14h12",
  minus: "M5 10h10",
  moon: "M16 11.5A6.5 6.5 0 118.5 4a5 5 0 007.5 7.5z",
  odds: "M3 10h14M10 3v14",
  pencil: "M4 14.5V17h2.5L15 8.5 12.5 6 4 14.5zM11.5 7l2.5 2.5",
  plus: "M10 4v12M4 10h12",
  refresh: "M15 8a5 5 0 10.5 3M15 4v4h-4",
  replay: "M5 8a5 5 0 11-.5 3M5 4v4h4",
  rocket: "M5 15c-1 1-1 3-1 3s2 0 3-1m1-2l5-5a4 4 0 00-5-5l-5 5 5 5z",
  search: "M9 3a6 6 0 104.5 10.5L17 17M9 3a6 6 0 014.5 10.5",
  sparkle: "M10 3l1.5 4.5L16 9l-4.5 1.5L10 15l-1.5-4.5L4 9l4.5-1.5z",
  sun: "M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6L15 15M15 5l-1.4 1.4M6.4 13.6L5 15",
  swap: "M5 7h9m0 0l-3-3m3 3l-3 3M15 13H6m0 0l3-3m-3 3l3 3",
  target: "M10 3a7 7 0 100 14 7 7 0 000-14M10 7a3 3 0 100 6 3 3 0 000-6M10 10v.01",
  tg: "M3 10l14-6-3 13-4-3-2 3-1-4z",
  trash: "M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10",
  trashLines: "M4 6h12M8 6V4h4v2m-6 0 1 11h6l1-11M9 9v5m2-5v5",
  trashTall: "M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11",
  trendDown: "M4 6l5 6 3-3 4 5",
  trendUp: "M4 14l4-5 3 2 4-6",
  tune: "M4 7h8M14 7h2M4 13h2M8 13h8M10 5v4M6 11v4",
  user: "M10 10a3 3 0 100-6 3 3 0 000 6zM4 17a6 6 0 0112 0",
  walletOpen: "M3 6h12a1 1 0 011 1v8a1 1 0 01-1 1H3zM3 6V5a1 1 0 011-1h9M14 10h2",
  warn: "M10 3l7 13H3zM10 8v4M10 14.5v.5",
} as const;

/** Ícone de traço; `fill` pinta o path em vez de contorná-lo. */
export function Icon({
  d,
  s = 18,
  w = 1.6,
  fill = false,
  className,
  style,
  "aria-hidden": ariaHidden,
}: {
  d: string;
  s?: number;
  w?: number;
  fill?: boolean;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true";
}) {
  return (
    <svg
      aria-hidden={ariaHidden}
      className={className}
      width={s}
      height={s}
      viewBox="0 0 20 20"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
    >
      <path d={d} />
    </svg>
  );
}
