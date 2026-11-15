"use client";
import type { ReactNode } from "react";
import { useDesign } from "./context";

/**
 * A tecla de atalho, escrita onde o gesto acontece. O texto vem de
 * `lib/atalhos` (o mesmo registro que o `keydown` consulta), nunca digitado no
 * chamador. `aria-hidden`: o leitor de tela recebe o gesto pelo rótulo do controle.
 */
export function Tecla({ children, tom = "faint" }: { children?: ReactNode; tom?: "faint" | "muted" }) {
  const { T } = useDesign();
  if (!children) return null;
  return (
    <kbd
      aria-hidden="true"
      style={{
        fontFamily: T.font.num,
        fontSize: 10,
        lineHeight: 1,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "0.04em",
        padding: "3px 5px",
        borderRadius: 4,
        border: `1px solid ${T.border}`,
        background: T.surface2,
        color: tom === "muted" ? T.textMuted : T.textFaint,
        whiteSpace: "nowrap",
      }}
    >{children}</kbd>
  );
}
