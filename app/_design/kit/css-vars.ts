import type { CSSProperties } from "react";

/**
 * `style` com variáveis CSS (`'--x': v`), que o `CSSProperties` do React não
 * declara. O valor vai para a folha `.module.css` do componente; `undefined`
 * não é emitido.
 */
export type CssVarsStyle = CSSProperties & Record<`--${string}`, string | number | undefined>;

/** Identidade tipada: o `style` leva variáveis CSS sem cast, e o literal é conferido. */
export function cssVars(style: CssVarsStyle): CSSProperties {
  return style;
}
