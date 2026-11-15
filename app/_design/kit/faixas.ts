import type { CSSProperties } from "react";
import type { CssVarsStyle } from "./css-vars";
import styles from "./faixas.module.css";

/**
 * Um valor por faixa de largura (`app/_design/layout.ts`). `medio` repete
 * `largo` e `compacto` repete `medio` quando omitidos:
 * `compact ? a : b` vira `{ largo: b, compacto: a }` e `wide ? a : b` vira
 * `{ largo: a, medio: b }`.
 */
export type Faixa<V extends string | number = string | number> = { largo: V; medio?: V; compacto?: V };

const PROPRIEDADES = {
  gridTemplateColumns: "grid-template-columns",
  gridColumn: "grid-column",
  gap: "gap",
  padding: "padding",
  fontSize: "font-size",
  width: "width",
  height: "height",
  minHeight: "min-height",
  marginLeft: "margin-left",
  left: "left",
  right: "right",
  flex: "flex",
  flexWrap: "flex-wrap",
  flexDirection: "flex-direction",
  flexShrink: "flex-shrink",
  alignItems: "align-items",
  justifyContent: "justify-content",
  whiteSpace: "white-space",
  overflowX: "overflow-x",
  borderLeft: "border-left",
  borderTop: "border-top",
} as const satisfies Partial<Record<keyof CSSProperties, string>>;

type PropriedadeResponsiva = keyof typeof PROPRIEDADES;
type EstiloPorFaixa = Partial<Record<PropriedadeResponsiva, Faixa>>;

/** Número vira px, como o React faz no `style`; estas não têm unidade. */
const SEM_UNIDADE = new Set<PropriedadeResponsiva>(["flex", "flexShrink", "gridColumn"]);

function valorCss(prop: PropriedadeResponsiva, v: string | number): string {
  return typeof v === "number" && !SEM_UNIDADE.has(prop) ? `${v}px` : String(v);
}

/**
 * `className` + `style` para espalhar no elemento: `fixo` vale em toda
 * largura; cada entrada de `porLargura` muda com a faixa, por media query.
 * Uma propriedade não pode estar nos dois: o inline venceria a classe.
 *
 *   <div {...porFaixa({ display: 'grid', gap: 16 },
 *     { gridTemplateColumns: { largo: 'repeat(4,1fr)', compacto: 'repeat(2,1fr)' } })} />
 */
export function porFaixa(
  fixo: CSSProperties,
  porLargura: EstiloPorFaixa,
  className?: string,
): { className: string; style: CSSProperties } {
  const classes = className ? [className] : [];
  const style: CssVarsStyle = { ...fixo };
  for (const [prop, faixa] of Object.entries(porLargura) as [PropriedadeResponsiva, Faixa | undefined][]) {
    if (!faixa) continue;
    const css = PROPRIEDADES[prop];
    const medio = faixa.medio ?? faixa.largo;
    const compacto = faixa.compacto ?? medio;
    style[`--fx-l-${css}`] = valorCss(prop, faixa.largo);
    style[`--fx-m-${css}`] = valorCss(prop, medio);
    style[`--fx-c-${css}`] = valorCss(prop, compacto);
    classes.push(styles[prop]!);
  }
  return { className: classes.join(" "), style };
}

/** Só no compacto (< 1024px): a variante de lista das telas com tabela. */
export const SO_COMPACTO = styles.soCompacto!;
/** Fora do compacto (≥ 1024px). */
export const SEM_COMPACTO = styles.semCompacto!;
