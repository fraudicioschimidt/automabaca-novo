import type { Dispatch, SetStateAction } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { uiHexA } from "../../utils";
import { useDesign } from "../../kit/context";
import { ICONS, Icon } from "../../kit/icons";

export function BankrollsHeader({ total, q, setQ }: { total: number; q: string; setQ: Dispatch<SetStateAction<string>> }) {
  const router = useRouter();
  const { T, numFont } = useDesign();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, rowGap: 14, flexWrap: 'wrap', marginBottom: 26 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h1 style={{ margin: 0, fontFamily: T.font.display, fontSize: 32, fontWeight: T.displayWeight, letterSpacing: T.displaySpacing, color: T.text, lineHeight: 1 }}>Tipsters</h1>
        <span style={{ ...numFont, fontSize: 15, fontWeight: 600, color: T.textFaint }}>{total}</span>
      </div>
      <div style={{ flex: '1 1 280px', display: 'flex', alignItems: 'center', gap: 11, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radiusMd, padding: '0 14px', minWidth: 220 }}>
        <Icon d={ICONS.search} s={17} style={{ color: T.textFaint }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar tipster" placeholder="Buscar tipster por nome ou segmento…" style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', padding: '11px 0', fontFamily: T.font.body, fontSize: 14, color: T.text }} />
      </div>
      {/* A carteira: todas as bancas juntas no Analyzer, em reais. */}
      <Link href="/analyzer" prefetch={false} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: T.font.body, fontSize: 14, fontWeight: 600, padding: '10px 16px', borderRadius: T.radiusMd, border: `1px solid ${T.border}`, background: T.surface, color: T.text, textDecoration: 'none', whiteSpace: 'nowrap' }}>
        <Icon d={ICONS.analyzer} s={17} />Analyzer da carteira</Link>
      <button onClick={() => router.push('/config?nova=1')} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: T.font.body, fontSize: 14, fontWeight: 600, padding: '11px 18px', borderRadius: T.radiusMd, border: 'none', background: T.accent, color: T.accentText, boxShadow: `0 8px 20px -8px ${uiHexA(T.accent, 0.55)}`, whiteSpace: 'nowrap' }}>
        <Icon d={ICONS.plus} s={17} />Novo tipster</button>
    </div>
  );
}
