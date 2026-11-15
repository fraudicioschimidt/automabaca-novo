import { uiHexA } from "../../utils";
import { contagem } from "../../lib/plural";
import { ICONS, Icon } from "../../kit/icons";
import { BankrollLogo, Cap, SharpModeTag } from "../../kit/primitives";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import { CardHead, ConfigCard, IconBtn, TextBtn, inputStyle } from "./ui-primitives";
import type { BancasLista } from "./use-bancas";
import { sportLabel } from "../../lib/sport-options";

export function ConfigHeader({ canManage, onNewBanca }: { canManage: boolean; onNewBanca: () => void }) {
  const { T } = useDesign();
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 28 }}>
      <div>
        <h1 style={{ margin: 0, fontFamily: T.font.display, fontSize: 32, fontWeight: T.displayWeight, letterSpacing: T.displaySpacing, color: T.text, lineHeight: 1.05 }}>Config</h1>
        <div style={{ fontFamily: T.font.body, fontSize: 14, color: T.textMuted, marginTop: 6 }}>Tipsters, taxonomia de mercados e as fichas de times.</div>
      </div>
      {canManage ? <div {...porFaixa({}, { marginLeft: { largo: 'auto', compacto: 0 }, width: { largo: 'auto', compacto: '100%' } })}>
        <button onClick={onNewBanca} onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(0.97)'; }} onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: T.font.body, fontSize: 14, fontWeight: 600, padding: '11px 18px', borderRadius: T.radiusMd, border: 'none', background: T.accent, color: T.accentText, boxShadow: `0 8px 20px -8px ${uiHexA(T.accent, 0.55)}` }}>
          <Icon d={ICONS.plus} s={17} />Novo tipster</button>
      </div> : null}
    </div>
  );
}

export function BancasCard({ bancas, adding, creating, canManage, newBanca, setNewBanca, setAdding, addBanca, openEdit, onRemove }: BancasLista & { canManage: boolean }) {
  const { T, numFont } = useDesign();
  const campo = inputStyle(T);
  return (
    <ConfigCard style={{ marginBottom: 22 }}>
      <CardHead title="Tipsters" sub={contagem(bancas.length, 'ativo')} />
      {canManage && adding && (
        <div {...porFaixa({ display: 'flex', gap: 12, padding: '18px var(--config-pad-x)', background: T.surface2, borderBottom: `1px solid ${T.borderSoft}` }, { flexDirection: { largo: 'row', compacto: 'column' }, alignItems: { largo: 'flex-end', compacto: 'stretch' } })}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}><Cap style={{ fontSize: 10 }}>Nome</Cap><input disabled={creating} autoFocus maxLength={120} value={newBanca.name} onChange={(e) => setNewBanca((s) => ({ ...s, name: e.target.value }))} placeholder="Nome do tipster" style={campo} /></label>
          <label {...porFaixa({ display: 'flex', flexDirection: 'column', gap: 6 }, { width: { largo: 110, compacto: 'auto' } })}><Cap style={{ fontSize: 10 }}>Unidade R$</Cap><input disabled={creating} value={newBanca.unit} onChange={(e) => setNewBanca((s) => ({ ...s, unit: e.target.value }))} style={{ ...campo, fontFamily: T.font.num }} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}><Cap style={{ fontSize: 10 }}>Canal Telegram</Cap><input disabled={creating} maxLength={20} value={newBanca.channel} onChange={(e) => setNewBanca((s) => ({ ...s, channel: e.target.value }))} placeholder="-100..." style={{ ...campo, fontFamily: T.font.num }} /></label>
          <TextBtn kind="primary" disabled={creating} onClick={addBanca}>{creating ? 'Adicionando…' : 'Adicionar'}</TextBtn>
          <TextBtn disabled={creating} onClick={() => { setAdding(false); setNewBanca({ name: '', unit: '100', channel: '' }); }}>Cancelar</TextBtn>
        </div>
      )}
      {bancas.map((b, i) => (
        <div key={b.id} {...porFaixa({ display: 'flex', alignItems: 'center', padding: '18px var(--config-pad-x)', borderBottom: i < bancas.length - 1 ? `1px solid ${T.borderSoft}` : 'none' }, { gap: { largo: 16, compacto: 10 } })}>
          <BankrollLogo name={b.name} logoUrl={b.logoUrl} toneKey={b.slug || b.id} s={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: T.font.display, fontSize: 17, fontWeight: 600, color: T.text }}>{b.name}</span>
              <SharpModeTag mode={b.sharpMode} style={{ fontSize: 12.5 }} />
              {b.capturePaused ? <span title={b.pausedSince ? `Captura pausada desde ${b.pausedSince}` : 'Captura pausada'} style={{ fontFamily: T.font.body, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.neg, background: T.negSoft, padding: '3px 8px', borderRadius: 6 }}>Pausada</span> : null}
            </div>
            <div style={{ ...numFont, fontSize: 12.5, color: T.textMuted, marginTop: 4 }}>{b.unit} <span style={{ color: T.textFaint }}>· canal {b.channel}{b.channelSports?.length ? ` · ${b.channelSports.map(sportLabel).join(', ')}` : ''}</span></div>
          </div>
          {canManage ? <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <IconBtn icon={ICONS.edit} label={`Editar ${b.name}`} onClick={() => openEdit(b)} />
            <IconBtn icon={ICONS.trash} label={`Excluir ${b.name} permanentemente`} danger onClick={() => onRemove(b)} />
          </div> : null}
        </div>
      ))}
    </ConfigCard>
  );
}
