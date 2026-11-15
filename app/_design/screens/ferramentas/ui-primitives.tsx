import type { HTMLAttributes } from "react";
import { useDesign } from "../../kit/context";
import { Cap, Panel } from "../../kit/primitives";
import { Icon } from "../../kit/icons";
import { porFaixa } from "../../kit/faixas";

/** Painel das ferramentas: respiro menor no compacto. */
export function ToolCard({ style, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <Panel pad={null} {...props} {...porFaixa(style ?? {}, { padding: { largo: 28, compacto: 18 } }, className)} />;
}

export function ToolHead({ icon, title, right }: { icon: string; title: string; right?: string }) {
  const { T } = useDesign();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 22, flexWrap: 'wrap' }}>
      <div {...porFaixa({ borderRadius: T.radiusSm, background: T.accentSoft, color: T.accent, display: 'grid', placeItems: 'center' }, { width: { largo: 34, compacto: 44 }, height: { largo: 34, compacto: 44 } })}><Icon d={icon} s={18} /></div>
      <h3 style={{ margin: 0, fontFamily: T.font.display, fontSize: 18, fontWeight: 600, color: T.text, letterSpacing: '-0.01em' }}>{title}</h3>
      {right && <div {...porFaixa({ fontFamily: T.font.body, fontSize: 12.5, color: T.textFaint }, { marginLeft: { largo: 'auto', compacto: 0 }, width: { largo: 'auto', compacto: '100%' } })}>{right}</div>}
    </div>
  );
}

/** Campo numérico com rótulo e sufixo de unidade. */
export function ToolField({ label, suffix, value, onChange, w }: {
  label: string;
  suffix?: string;
  value: string;
  onChange: (value: string) => void;
  w?: number | string;
}) {
  const { T } = useDesign();
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: w ? 'none' : 1, width: w || 'auto' }}>
      <Cap style={{ fontSize: 10 }}>{label}</Cap>
      <div style={{ display: 'flex', alignItems: 'center', background: T.surface2, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '0 12px' }}>
        <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal"
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', padding: '11px 0', fontFamily: T.font.num, fontVariantNumeric: 'tabular-nums', fontSize: 15, fontWeight: 600, color: T.text }} />
        {suffix && <span style={{ fontFamily: T.font.num, fontVariantNumeric: 'tabular-nums', fontSize: 13, color: T.textFaint, marginLeft: 6 }}>{suffix}</span>}
      </div>
    </label>
  );
}
