import type { CSSProperties, ReactNode } from "react";
import { useDesign } from "../../kit/context";
import { Icon } from "../../kit/icons";
import { uiHexA } from "../../utils";

export function Label({ children, style, className }: { children?: ReactNode; style?: CSSProperties; className?: string }) {
  const { T } = useDesign();
  return (
    <div className={className} style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase',
      color: T.textFaint, fontFamily: T.font.body, ...style }}>{children}</div>
  );
}

export function Btn({ icon, children, primary, onClick, soft, active, disabled }: {
  icon?: string;
  children?: ReactNode;
  primary?: boolean;
  onClick?: () => void;
  soft?: boolean;
  active?: boolean;
  disabled?: boolean;
}) {
  const { T } = useDesign();
  return (
    <button type="button" onClick={disabled ? undefined : onClick} disabled={disabled}
      onMouseEnter={(e) => { if (disabled) return; e.currentTarget.style.filter = 'brightness(0.96)'; if (!primary) e.currentTarget.style.background = active ? T.accentSoft : T.surface2; }}
      onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; e.currentTarget.style.transform = 'none'; if (!primary) e.currentTarget.style.background = active ? T.accentSoft : soft ? T.surface2 : 'transparent'; }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = 'scale(0.97)'; }}
      onMouseUp={(e) => { e.currentTarget.style.transform = 'none'; }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, cursor: disabled ? 'wait' : 'pointer',
        fontFamily: T.font.body, fontSize: 13.5, fontWeight: primary ? 600 : active ? 600 : 500,
        padding: primary ? '10px 16px' : '9px 13px', borderRadius: T.radiusMd,
        border: primary ? 'none' : `1px solid ${active ? uiHexA(T.accent, 0.45) : T.border}`,
        background: primary ? T.accent : active ? T.accentSoft : soft ? T.surface2 : 'transparent',
        color: primary ? T.accentText : active ? T.accent : T.text, whiteSpace: 'nowrap',
        boxShadow: primary ? `0 1px 2px ${uiHexA(T.accent, 0.35)}, 0 8px 20px -8px ${uiHexA(T.accent, 0.55)}` : 'none',
        transition: `transform ${T.motion.fast}, filter ${T.motion.fast}, background ${T.motion.fast}`, letterSpacing: '-0.01em',
        opacity: disabled ? 0.65 : 1,
      }}>{icon && <Icon d={icon} s={16} />}{children}</button>
  );
}
