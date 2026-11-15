import Link from "next/link";
import type { ReactNode } from "react";
import { useDesign } from "../../kit/context";
import { uiReadableOn } from "../../utils";
import { bookmakerLogoSrc } from "../../lib/bookmaker-logo";
import { Icon } from "../../kit/icons";
import type { ContaStatus } from "../../adapters/contas";
import type { Theme } from "../../theme";
import { roundMoney } from "@/src/domain/money";

/**
 * Cor de saldo: negativo em vermelho, o resto no texto normal. Saldo positivo
 * não é ganho, então não fica verde como o resultado.
 */
export const balanceInk = (T: Theme, n: number) => (roundMoney(n, 2) < 0 ? T.neg : T.text);

export function FieldLabel({ children }: { children?: ReactNode }) {
  const { T } = useDesign();
  return (
    <div style={{ fontFamily: T.font.body, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: T.textFaint, marginBottom: 6 }}>
      {children}
    </div>
  );
}

/** Logo da casa (imagem conhecida) ou monograma na cor da conta. */
export function ContaLogo({ a, s = 44 }: { a: { name: string; color: string }; s?: number }) {
  const { T } = useDesign();
  const src = bookmakerLogoSrc(a.name);
  const logoText = src ? T.text : uiReadableOn(a.color);
  return (
    <div style={{ width: s, height: s, borderRadius: s * 0.27, flexShrink: 0, display: 'grid',
      placeItems: 'center', color: logoText, background: src ? T.surface : a.color,
      border: src ? `1px solid ${T.border}` : 'none', overflow: 'hidden', fontFamily: T.font.body,
      fontWeight: 700, fontSize: s * 0.34, letterSpacing: '-0.02em' }}>
      {src
        // eslint-disable-next-line @next/next/no-img-element -- ícone estático e pequeno; o next/image não ganha nada aqui.
        ? <img src={src} alt={a.name} width={s} height={s} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : a.name.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 2).toUpperCase()}
    </div>
  );
}

export function StatusPill({ s, big = false }: { s: ContaStatus; big?: boolean }) {
  const { T } = useDesign();
  const statusMeta = { ativa: ['Ativa', T.pos, T.posSoft], limitada: ['Limitada', T.neg, T.negSoft], encerrada: ['Encerrada', T.textMuted, T.surface2] };
  const [l, c, bg] = statusMeta[s];
  return <span style={{ fontFamily: T.font.body, fontSize: big ? 12 : 11, fontWeight: 600, color: c, background: bg, padding: big ? '4px 11px' : '3px 9px', borderRadius: 999 }}>{l}</span>;
}

/** Ação em texto com ícone; `soon` a mostra esmaecida (ainda sem backend). */
export function ActionLink({ icon, children, tone, onClick, href, soon }: {
  icon: string;
  children?: ReactNode;
  tone?: string;
  onClick?: () => void;
  href?: string;
  soon?: boolean;
}) {
  const { T } = useDesign();
  const c = tone === 'neg' ? T.neg : tone === 'accent' ? T.accent : T.text;
  const inner = (<span title={soon ? 'Em breve' : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: T.font.body, fontSize: 13, fontWeight: 600, color: c, cursor: 'pointer', opacity: soon ? 0.5 : 1 }}><Icon d={icon} s={15} />{children}</span>);
  return href ? <Link href={href} style={{ textDecoration: 'none' }}>{inner}</Link> : <button onClick={onClick} style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }}>{inner}</button>;
}
