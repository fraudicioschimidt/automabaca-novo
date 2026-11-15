import Link from "next/link";
import { uiHexA } from "../../utils";
import { porFaixa, SEM_COMPACTO, SO_COMPACTO } from "../../kit/faixas";
import { useDesign } from "../../kit/context";
import { Badge, BankrollLogo, Cap, DataGrid, Panel, SharpModeTag } from "../../kit/primitives";
import { ICONS, Icon } from "../../kit/icons";
import { fmtPct, fmtU } from "@/src/domain/formato-de-resultado";
import type { BankrollsScreenProps } from "../../screen-types";

type Tipster = BankrollsScreenProps["data"]["tipsters"][number];

const SORTS: [string, string][] = [['decisao', 'Edge'], ['lucro', 'Lucro'], ['roi', 'ROI'], ['apostas', 'Apostas'], ['nome', 'Nome']];
const GRID_COLS = '2.2fr 88px 96px 104px 92px 40px';

/** Lista dos tipsters com ordenação: cartões no compacto, tabela no largo. */
export function BankrollsListCard({ filtered, sortKey, setSortKey }: {
  filtered: Tipster[];
  sortKey: string;
  setSortKey: (key: string) => void;
}) {
  const { T } = useDesign();
  return (
    <Panel pad={0} style={{ overflow: 'hidden', marginBottom: 30 }}>
      <div style={{ padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderBottom: `1px solid ${T.borderSoft}` }}>
        <div {...porFaixa({ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }, { marginLeft: { largo: 'auto', medio: 0 }, width: { largo: 'auto', medio: '100%' } })}>
          <span style={{ fontFamily: T.font.body, fontSize: 11.5, color: T.textFaint }}>ordenar</span>
          {SORTS.map(([k, l]) => { const on = sortKey === k; return (<button key={k} onClick={() => setSortKey(k)} style={{ fontFamily: T.font.body, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '6px 10px', borderRadius: T.radiusSm, border: `1px solid ${on ? uiHexA(T.accent, 0.4) : 'transparent'}`, background: on ? T.accentSoft : T.surface2, color: on ? T.accent : T.textMuted }}>{l}</button>); })}
        </div>
      </div>
      <div className={SO_COMPACTO}>
        {filtered.length === 0 && <div style={{ padding: '48px 20px', textAlign: 'center', fontFamily: T.font.body, color: T.textFaint, fontSize: 14 }}>Nenhum tipster encontrado.</div>}
        {filtered.map((t, i) => <BankrollCardRow key={t.id} t={t} last={i === filtered.length - 1} />)}
      </div>
      <div className={`no-scrollbar ${SEM_COMPACTO}`} style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 720 }}>
          <DataGrid columns={GRID_COLS} style={{ gap: 12, padding: '11px 24px', borderBottom: `1px solid ${T.border}`, background: 'transparent' }}>
            {([['Tipster', 'left'], ['Apostas', 'right'], ['Unidade', 'right'], ['Lucro', 'right'], ['ROI', 'right'], ['', 'right']] satisfies [string, 'left' | 'right'][]).map(([c, a], i) => <Cap key={i} style={{ fontSize: 9.5, textAlign: a }}>{c}</Cap>)}
          </DataGrid>
          {filtered.length === 0 && <div style={{ padding: '48px', textAlign: 'center', fontFamily: T.font.body, color: T.textFaint, fontSize: 14 }}>Nenhum tipster encontrado.</div>}
          {filtered.map((t, i) => <BankrollTableRow key={t.id} t={t} last={i === filtered.length - 1} />)}
        </div>
      </div>
    </Panel>
  );
}

function BankrollCardRow({ t, last }: { t: Tipster; last: boolean }) {
  const { T, numFont, ink } = useDesign();
  return (
    <Link href={'/tipsters/' + t.id + '?bk=' + t.id} style={{ display: 'block', textDecoration: 'none', padding: '18px', borderBottom: !last ? `1px solid ${T.borderSoft}` : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <BankrollLogo name={t.name} logoUrl={t.logoUrl} toneKey={t.id} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: T.font.body, fontSize: 15, fontWeight: 600, color: T.text }}>{t.name}</span>
            {t.main && <Badge tone="sharp">principal</Badge>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, minWidth: 0 }}>
            <SharpModeTag mode={t.sharpMode} style={{ fontSize: 12 }} />
          </div>
        </div>
        <Icon d={ICONS.arrow} s={16} style={{ color: T.textFaint, flexShrink: 0 }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 8, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${T.borderSoft}` }}>
        {[
          ['Apostas', String(t.resolved), T.text],
          ['Unidade', t.unit, T.textMuted],
          ['Lucro', fmtU(t.lucro), ink(t.lucro)],
          ['ROI', t.hasRoi ? fmtPct(t.roi) : '—', t.hasRoi ? ink(t.roi) : T.textFaint],
        ].map(([label, value, color]) => (
          <div key={label} style={{ minWidth: 0 }}>
            <Cap style={{ fontSize: 8.5, marginBottom: 5 }}>{label}</Cap>
            <div style={{ ...numFont, fontSize: 12.5, fontWeight: 600, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
          </div>
        ))}
      </div>
    </Link>
  );
}

function BankrollTableRow({ t, last }: { t: Tipster; last: boolean }) {
  const { T, numFont, ink } = useDesign();
  return (
    <Link href={'/tipsters/' + t.id + '?bk=' + t.id} style={{ textDecoration: 'none', display: 'grid', gridTemplateColumns: GRID_COLS, gap: 12, padding: '15px 24px', borderBottom: !last ? `1px solid ${T.borderSoft}` : 'none', alignItems: 'center' }}
      onMouseEnter={(e) => e.currentTarget.style.background = T.surface2} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
        <BankrollLogo name={t.name} logoUrl={t.logoUrl} toneKey={t.id} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: T.font.body, fontSize: 15, fontWeight: 600, color: T.text }}>{t.name}</span>
            {t.main && <Badge tone="sharp">principal</Badge>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
            <SharpModeTag mode={t.sharpMode} style={{ fontSize: 12 }} />
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}><span style={{ ...numFont, fontSize: 14, fontWeight: 600, color: T.text }}>{t.resolved}</span><div style={{ fontSize: 10.5, color: T.textFaint, marginTop: 2 }}>resolvidas</div></div>
      <div style={{ textAlign: 'right' }}><span style={{ ...numFont, fontSize: 13.5, color: T.textMuted }}>{t.unit}</span></div>
      <div style={{ textAlign: 'right' }}><span style={{ ...numFont, fontSize: 14.5, fontWeight: 600, color: ink(t.lucro) }}>{fmtU(t.lucro)}</span></div>
      <div style={{ textAlign: 'right' }}><span style={{ ...numFont, fontSize: 13.5, fontWeight: 600, color: t.hasRoi ? ink(t.roi) : T.textFaint }}>{t.hasRoi ? fmtPct(t.roi) : '—'}</span></div>
      <div style={{ display: 'grid', placeItems: 'center', color: T.textFaint }}><Icon d={ICONS.arrow} s={16} /></div>
    </Link>
  );
}
