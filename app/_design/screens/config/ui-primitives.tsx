"use client";
import type { CSSProperties, HTMLAttributes, MouseEventHandler, ReactNode } from "react";
import { uiHexA } from "../../utils";
import { Panel } from "../../kit/primitives";
import { Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import styles from "./config-card.module.css";
import type { Theme } from "../../theme";

/**
 * Painel da Config: sem padding (cada linha tem o seu) e sem vazar a borda
 * arredondada. Define `--config-pad-x`, o respiro lateral das linhas.
 */
export function ConfigCard({ pad = 0, style, className, ...props }: HTMLAttributes<HTMLDivElement> & { pad?: number | string }) {
  return <Panel pad={pad} className={className ? `${styles.card} ${className}` : styles.card} style={{ overflow: 'hidden', ...style }} {...props} />;
}

export function CardHead({ title, right, sub }: { title: ReactNode; right?: ReactNode; sub?: ReactNode }) {
  const { T } = useDesign();
  return (
    <div {...porFaixa({ display: 'flex', alignItems: 'center', gap: 12, borderBottom: `1px solid ${T.borderSoft}` }, { flexWrap: { largo: 'nowrap', compacto: 'wrap' }, padding: { largo: '22px 26px', compacto: '18px' } })}>
      <h2 style={{ margin: 0, fontFamily: T.font.display, fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: T.text }}>{title}</h2>
      {sub && <span style={{ fontFamily: T.font.body, fontSize: 12.5, color: T.textFaint }}>{sub}</span>}
      {right && <div {...porFaixa({}, { marginLeft: { largo: 'auto', compacto: 0 }, width: { largo: 'auto', compacto: '100%' } })}>{right}</div>}
    </div>
  );
}

export function IconBtn({ icon, onClick, danger, label }: { icon: string; onClick: MouseEventHandler<HTMLButtonElement>; danger?: boolean; label: string }) {
  const { T } = useDesign();
  return (
    <button onClick={onClick} aria-label={label} title={label} onMouseEnter={(e) => { e.currentTarget.style.background = danger ? T.negSoft : T.surface2; e.currentTarget.style.color = danger ? T.neg : T.text; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.textFaint; }}
      style={{ width: 44, height: 44, borderRadius: T.radiusSm, border: 'none', background: 'transparent', color: T.textFaint, cursor: 'pointer', display: 'grid', placeItems: 'center', transition: `all ${T.motion.fast}` }}>
      <Icon d={icon} s={16} /></button>
  );
}

export function TextBtn({ children, onClick, kind, disabled = false }: { children: ReactNode; onClick: MouseEventHandler<HTMLButtonElement>; kind?: 'primary' | 'danger'; disabled?: boolean }) {
  const { T } = useDesign();
  const c = kind === 'primary' ? { bg: T.accent, fg: T.accentText, bd: 'none' } : kind === 'danger' ? { bg: 'transparent', fg: T.textMuted, bd: `1px solid ${T.border}` } : { bg: 'transparent', fg: T.text, bd: `1px solid ${T.border}` };
  return (
    <button type="button" onClick={onClick} disabled={disabled} onMouseEnter={(e) => { if (kind === 'danger') { e.currentTarget.style.borderColor = uiHexA(T.neg, 0.4); e.currentTarget.style.color = T.neg; } else e.currentTarget.style.filter = 'brightness(0.97)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; if (kind === 'danger') { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; } }}
      style={{ fontFamily: T.font.body, fontSize: 13, fontWeight: 600, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1, padding: '8px 14px', borderRadius: T.radiusSm, border: c.bd, background: c.bg, color: c.fg, whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>{children}</button>
  );
}

/** Campo de texto da Config (a caixa do modal soma `width: 100%`). */
export function inputStyle(T: Theme): CSSProperties {
  return { boxSizing: 'border-box', fontFamily: T.font.body, fontSize: 14, color: T.text, background: T.surface2, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '10px 12px', outline: 'none' };
}
