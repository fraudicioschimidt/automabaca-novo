import type { Dispatch, SetStateAction } from "react";
import Link from "next/link";
import { fmtUnit } from "@/src/domain/formato-de-resultado";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import { ICONS, Icon } from "../../kit/icons";
import { toast } from "../../toast";
import { BankrollLogo, SharpModeTag } from "../../kit/primitives";
import { SHARP_MODES, sharpModeLabel } from "../../lib/sharp-mode";
import type { BankrollView, Overlay } from "./types";
import { Btn } from "./ui-primitives";
import type { SharpModeKey } from "./use-sharp-mode";

type BankrollItem = { name: string; href: string; cur: boolean };

export function BankrollHeader({
  AB, bkName, bkSlug, bkLogoUrl, M,
  bkOpen, setBkOpen, bkItems,
  sharpOpen, setSharpOpen, currentSharpMode, onChangeSharpMode,
  fetchingClosing, exporting,
  onFetchClosing, exportCSV, setOverlay, canManage = true,
}: {
  AB: BankrollView;
  bkName: string;
  bkSlug: string;
  bkLogoUrl: string | null;
  M: BankrollView["METRICS"];
  bkOpen: boolean;
  setBkOpen: Dispatch<SetStateAction<boolean>>;
  bkItems: BankrollItem[];
  sharpOpen: boolean;
  setSharpOpen: Dispatch<SetStateAction<boolean>>;
  currentSharpMode: string;
  onChangeSharpMode: (key: SharpModeKey) => void;
  fetchingClosing: boolean;
  exporting: boolean;
  onFetchClosing: () => void;
  exportCSV: () => void;
  setOverlay: (overlay: Overlay) => void;
  canManage?: boolean;
}) {
  const { T, numFont } = useDesign();
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, rowGap: 14, flexWrap: 'wrap', marginBottom: 30 }}>
      <Link href="/tipsters" title="Voltar para os tipsters" aria-label="Voltar para os tipsters" {...porFaixa({ marginTop: 4, display: 'grid', placeItems: 'center',
        borderRadius: T.radiusSm, border: `1px solid ${T.border}`, background: 'transparent',
        color: T.textMuted, textDecoration: 'none', cursor: 'pointer', flexShrink: 0 }, { width: { largo: 34, compacto: 44 }, height: { largo: 34, compacto: 44 } })}><Icon d={ICONS.back} s={17} /></Link>
      <BankrollLogo name={bkName} logoUrl={bkLogoUrl} toneKey={bkSlug} s={{ largo: 52, compacto: 44 }} />
      <div {...porFaixa({ minWidth: 0 }, { flex: { largo: '1 1 280px', compacto: '1 1 180px' } })}>
        <div {...porFaixa({ display: 'flex', alignItems: 'center', marginBottom: 5, minWidth: 0 }, { gap: { largo: 13, compacto: 8 }, flexWrap: { largo: 'nowrap', compacto: 'wrap' } })}>
          <div data-bk-pop="" style={{ position: 'relative', minWidth: 0 }}>
            <button type="button" onClick={() => setBkOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, maxWidth: '100%' }}>
              <h1 {...porFaixa({ margin: 0, fontFamily: T.font.display,
                fontWeight: T.displayWeight, letterSpacing: T.displaySpacing, color: T.text, lineHeight: 1,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, { fontSize: { largo: 30, compacto: 24 } })}>{bkName}</h1>
              <Icon d={ICONS.chevronDownWide} s={19} style={{ color: T.textFaint, flexShrink: 0 }} />
            </button>
            {bkOpen && (
              <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 70, width: 240, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radiusMd, boxShadow: T.cardShadow, overflow: 'hidden', padding: 6 }}>
                {bkItems.map((it) => (
                  <Link key={it.name} href={it.href} style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', padding: '9px 11px', borderRadius: T.radiusSm, background: it.cur ? T.surface2 : 'transparent' }}
                    onMouseEnter={(e) => { if (!it.cur) e.currentTarget.style.background = T.surface2; }} onMouseLeave={(e) => { if (!it.cur) e.currentTarget.style.background = 'transparent'; }}>
                    <span style={{ flex: 1, fontFamily: T.font.body, fontSize: 14, fontWeight: it.cur ? 600 : 500, color: T.text }}>{it.name}</span>
                    {it.cur && <Icon d="M4 10l4 4 8-9" s={15} w={2} style={{ color: T.accent }} />}
                  </Link>
                ))}
              </div>
            )}
          </div>
          <div data-sharp-pop="" style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              disabled={!canManage}
              onClick={() => setSharpOpen((o) => !o)}
              title={canManage ? "Alterar modo sharp do tipster" : undefined}
              aria-label={`Modo sharp: ${sharpModeLabel(currentSharpMode)}${canManage ? ' (alterar)' : ''}`}
              aria-expanded={canManage ? sharpOpen : undefined}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 13,
                background: 'transparent',
                border: 'none',
                padding: '4px 6px',
                margin: '0 -6px',
                borderRadius: T.radiusXs,
                cursor: canManage ? 'pointer' : 'default',
                transition: `background ${T.motion.fast}`,
              }}
              onMouseEnter={(e) => {
                if (canManage) e.currentTarget.style.background = T.surface2;
              }}
              onMouseLeave={(e) => {
                if (canManage) e.currentTarget.style.background = 'transparent';
              }}
            >
              <SharpModeTag mode={currentSharpMode} />
              {canManage && <Icon d={ICONS.chevronDownWide} s={12} style={{ color: T.textFaint }} />}
            </button>
            {sharpOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  left: 0,
                  zIndex: 75,
                  width: 260,
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  borderRadius: T.radiusMd,
                  boxShadow: T.cardShadow,
                  overflow: 'hidden',
                  padding: 6,
                }}
              >
                <div style={{ padding: '4px 8px 6px', fontFamily: T.font.body, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.textFaint }}>
                  Modo Sharp
                </div>
                {SHARP_MODES.map((opt) => {
                  const isCur = currentSharpMode === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => {
                        setSharpOpen(false);
                        onChangeSharpMode(opt.key);
                      }}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        gap: 2,
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        borderRadius: T.radiusSm,
                        background: isCur ? T.surface2 : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => { if (!isCur) e.currentTarget.style.background = T.surface2; }}
                      onMouseLeave={(e) => { if (!isCur) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        <span style={{ fontFamily: T.font.body, fontSize: 13, fontWeight: isCur ? 700 : 500, color: isCur ? T.accent : T.text }}>
                          {opt.label}
                        </span>
                        {isCur && <Icon d="M4 10l4 4 8-9" s={14} w={2} style={{ color: T.accent }} />}
                      </div>
                      <span style={{ fontFamily: T.font.body, fontSize: 11, color: T.textFaint }}>
                        {opt.desc}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div {...porFaixa({ fontFamily: T.font.body, color: T.textMuted, display: 'flex',
          gap: 7, alignItems: 'center' }, { fontSize: { largo: 13.5, compacto: 12.5 }, whiteSpace: { largo: 'nowrap', compacto: 'normal' }, flexWrap: { largo: 'nowrap', compacto: 'wrap' } })}>
          <span>Capital <b style={{ ...numFont, color: T.text, fontWeight: 600 }}>{fmtUnit(M.capital)}</b></span>
          <span style={{ color: T.textFaint }}>·</span><span>{M.ops} operações</span>
          <span style={{ color: T.textFaint }}>·</span><span>período filtrado</span>
        </div>
      </div>
      <div {...porFaixa({ display: 'flex', gap: 8, paddingTop: 4, flexWrap: 'wrap' }, { marginLeft: { largo: 'auto', compacto: 0 }, width: { largo: 'auto', compacto: '100%' }, flexShrink: { largo: 0, compacto: 1 } })}>
        <Btn icon={ICONS.analyzer} onClick={() => { window.location.href = AB.bk ? ('/tipsters/' + AB.bk.slug + '/analyzer') : '/tipsters/main/analyzer'; }}>Analyzer</Btn>
        {canManage ? <Btn icon={ICONS.odds} active={fetchingClosing} onClick={() => {
          if (fetchingClosing) return;
          if (!AB.bk) { toast('Odds de fechamento — em breve', 'info'); return; }
          onFetchClosing();
        }}>{fetchingClosing ? 'Buscando…' : 'Odds fechamento'}</Btn> : null}
        <Btn icon={ICONS.export} onClick={exportCSV} disabled={exporting}>{exporting ? 'Exportando…' : 'Exportar'}</Btn>
        <Btn icon="M10 13V3m0 0l-3 3m3-3l3 3M5 12v4h10v-4" onClick={() => setOverlay('compartilhar')}>Compartilhar</Btn>
        {canManage ? <Btn icon={ICONS.plus} primary onClick={() => setOverlay('adicionar')}>Adicionar aposta</Btn> : null}
      </div>
    </div>
  );
}
