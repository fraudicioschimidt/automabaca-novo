import type { CSSProperties, ReactNode } from "react";
import { useDesign } from "./context";
import type { Theme } from "../theme";

// Em escopo de módulo: tipos estáveis, os inputs não remontam a cada render.
export function fieldStyle(T: Theme): CSSProperties {
  return { width: '100%', boxSizing: 'border-box', fontFamily: T.font.body, fontSize: 14, color: T.text,
    background: T.surface2, border: `1px solid ${T.border}`,
    borderRadius: T.radiusSm, padding: '11px 13px', outline: 'none' };
}

export function FormField({ label, hint, children, span }: { label: string; hint?: string; children: ReactNode; span?: boolean }) {
  const { T } = useDesign();
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 7, gridColumn: span ? '1 / -1' : 'auto' }}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.textFaint, fontFamily: T.font.body }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: T.textFaint }}>{hint}</span>}
    </label>
  );
}
