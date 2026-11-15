import type { CSSProperties, ReactNode } from "react";
import { CAPTURE_HINT, CAPTURE_OPTS, SHARP_OPTS, STAKE_OPTS, opcao } from "./constants";
import { ModalForm } from "../../kit/ModalForm";
import { BankrollLogo } from "../../kit/primitives";
import { useDesign } from "../../kit/context";
import { inputStyle } from "./ui-primitives";
import type { BancaModal } from "./use-bancas";
import { parseMoneyInput, parseDecimalInput } from "@/src/domain/decimal-input";
import { SPORT_OPTIONS, sportLabel } from "../../lib/sport-options";

function FieldLabel({ children }: { children: ReactNode }) {
  const { T } = useDesign();
  return <div style={{ fontFamily: T.font.body, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: T.textFaint, marginBottom: 6 }}>{children}</div>;
}

/**
 * Esportes que o canal posta. Nenhum marcado = "vários/não sei" (o padrão): o
 * esporte sai do conteúdo de cada post. Um só confirma a aposta nele.
 */
function ChannelSportsField({ selected, confirmed, onChange }: {
  selected: readonly string[];
  confirmed: ReadonlyArray<{ sport: string; bets: number }>;
  onChange: (sports: string[]) => void;
}) {
  const { T } = useDesign();
  const history = new Set(confirmed.map((c) => c.sport));
  // O que o histórico confirmou vem primeiro: é o palpite mais provável.
  const options = [...SPORT_OPTIONS].sort((a, z) => Number(history.has(z.value)) - Number(history.has(a.value)));
  const toggle = (sport: string) => onChange(selected.includes(sport) ? selected.filter((s) => s !== sport) : [...selected, sport]);
  const chip = (active: boolean): CSSProperties => ({
    fontFamily: T.font.body, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '6px 11px', borderRadius: 999,
    border: `1px solid ${active ? T.accent : T.border}`, background: active ? T.accentSoft : 'transparent', color: active ? T.accent : T.textMuted,
  });
  const total = confirmed.reduce((sum, c) => sum + c.bets, 0);
  return (
    <div role="group" aria-label="Esportes do canal">
      <FieldLabel>Esportes do canal</FieldLabel>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button type="button" aria-pressed={selected.length === 0} onClick={() => onChange([])} style={chip(selected.length === 0)}>Vários / não sei</button>
        {options.map((o) => <button key={o.value} type="button" aria-pressed={selected.includes(o.value)} onClick={() => toggle(o.value)} style={chip(selected.includes(o.value))}>{o.label}</button>)}
      </div>
      <span style={{ display: 'block', marginTop: 6, fontFamily: T.font.body, fontSize: 11.5, lineHeight: 1.45, color: T.textFaint }}>
        Com um esporte só, a aposta já nasce com ele confirmado; com vários, só eles valem, e time homônimo fica no esporte do canal. Se o post, a IA ou o time apontarem só outro esporte, ou a linha do total não combinar com o esporte, a aposta fica em conflito para você conferir.
        {total > 0 ? ` Histórico confirmado: ${confirmed.map((c) => `${sportLabel(c.sport)} ${c.bets}`).join(' · ')}.` : ''}
      </span>
    </div>
  );
}

export function ConfigModals({ ov, pend, closeOv, bform, setBform, logoBusy, onPickLogo, removeLogo, submitEdit, submitRemove }: BancaModal) {
  const { T } = useDesign();
  const fieldStyle: CSSProperties = { ...inputStyle(T), width: '100%' };

  if (!ov) return null;

  if (ov.kind === 'editBanca') {
    const b = ov.banca;
    const nameOk = (bform.name || '').trim().length > 0;
    const unitNum = parseMoneyInput(bform.unit);
    const unitOk = unitNum != null && unitNum > 0;
    const stakeNum = parseDecimalInput(bform.defaultStakeUnits);
    const stakeOk = (bform.stakePolicy || 'MESSAGE') === 'MESSAGE' || (stakeNum != null && stakeNum > 0 && stakeNum <= 100 && Math.round(stakeNum * 1e6) / 1e6 === stakeNum);
    return (
      <ModalForm pending={pend} onClose={closeOv} title="Editar tipster" sub={b.name} submitLabel="Salvar" canSubmit={nameOk && unitOk && stakeOk && !logoBusy} onSubmit={() => submitEdit(b)}>
        <div>
          <FieldLabel>Logo</FieldLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <BankrollLogo name={b.name} logoUrl={bform.logoUrl} toneKey={b.slug || b.id} s={56} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.font.body, fontSize: 13, fontWeight: 600, cursor: logoBusy ? 'default' : 'pointer', padding: '8px 14px', borderRadius: T.radiusSm, border: `1px solid ${T.border}`, background: 'transparent', color: T.text, opacity: logoBusy ? 0.6 : 1 }}>
                  {logoBusy ? '…' : (bform.logoUrl ? 'Trocar' : 'Enviar logo')}
                  <input type="file" accept="image/png,image/jpeg,image/webp" disabled={logoBusy || pend} onChange={onPickLogo} style={{ display: 'none' }} />
                </label>
                {bform.logoUrl && <button type="button" disabled={logoBusy || pend} onClick={removeLogo} style={{ fontFamily: T.font.body, fontSize: 13, fontWeight: 600, cursor: logoBusy ? 'default' : 'pointer', padding: '8px 14px', borderRadius: T.radiusSm, border: `1px solid ${T.border}`, background: 'transparent', color: T.textMuted, opacity: logoBusy ? 0.6 : 1 }}>Remover</button>}
              </div>
              <span style={{ fontFamily: T.font.body, fontSize: 11.5, color: T.textFaint }}>PNG, JPG ou WebP · até 2 MB</span>
            </div>
          </div>
        </div>
        <label><FieldLabel>Nome</FieldLabel><input maxLength={120} value={bform.name || ''} onChange={(e) => setBform((f) => ({ ...f, name: e.target.value }))} placeholder="Nome do tipster" style={fieldStyle} /></label>
        <label><FieldLabel>Unidade (R$)</FieldLabel><input inputMode="decimal" value={bform.unit || ''} onChange={(e) => setBform((f) => ({ ...f, unit: e.target.value }))} placeholder="100" style={{ ...fieldStyle, fontFamily: T.font.num }} /><span style={{ display: 'block', marginTop: 6, fontFamily: T.font.body, fontSize: 11.5, lineHeight: 1.45, color: T.textFaint }}>A nova unidade vale para as próximas apostas. O histórico preserva o valor vigente no registro.</span></label>
        <label><FieldLabel>Canal Telegram</FieldLabel><input maxLength={20} value={bform.channel || ''} onChange={(e) => setBform((f) => ({ ...f, channel: e.target.value }))} placeholder="-100… (vazio = sem canal)" style={{ ...fieldStyle, fontFamily: T.font.num }} /></label>
        <ChannelSportsField selected={bform.channelSports ?? []} confirmed={b.confirmedSports ?? []} onChange={(channelSports) => setBform((f) => ({ ...f, channelSports }))} />
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input type="checkbox" checked={bform.capturePaused === true} onChange={(e) => setBform((f) => ({ ...f, capturePaused: e.target.checked }))} style={{ marginTop: 3 }} />
          <span>
            <span style={{ display: 'block', fontFamily: T.font.body, fontSize: 14, fontWeight: 600, color: T.text }}>Pausar captura</span>
            <span style={{ display: 'block', marginTop: 4, fontFamily: T.font.body, fontSize: 11.5, lineHeight: 1.45, color: T.textFaint }}>Posts novos do canal ficam em Monitoramento › Canais, sem leitura, e voltam pelo &quot;Capturar mesmo assim&quot; ou por um 👍 no post. Reações e apostas já registradas seguem normais, e o histórico de CLV fica.</span>
          </span>
        </label>
        <label><FieldLabel>Stake das capturas</FieldLabel>
          <select value={bform.stakePolicy || 'MESSAGE'} onChange={(e) => setBform((f) => ({ ...f, stakePolicy: opcao(STAKE_OPTS, e.target.value) }))} style={{ ...fieldStyle, cursor: 'pointer' }}>
            {STAKE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <span style={{ display: 'block', marginTop: 6, fontFamily: T.font.body, fontSize: 11.5, lineHeight: 1.45, color: T.textFaint }}>Vale para novas capturas do Telegram. O histórico mantém as stakes já registradas.</span>
        </label>
        {bform.stakePolicy && bform.stakePolicy !== 'MESSAGE' && <label><FieldLabel>Stake padrão (u)</FieldLabel>
          <input inputMode="decimal" value={bform.defaultStakeUnits || ''} onChange={(e) => setBform((f) => ({ ...f, defaultStakeUnits: e.target.value }))} placeholder="1" style={{ ...fieldStyle, fontFamily: T.font.num }} />
          <span style={{ display: 'block', marginTop: 6, fontFamily: T.font.body, fontSize: 11.5, lineHeight: 1.45, color: T.textFaint }}>{bform.stakePolicy === 'ALWAYS' ? 'Cada aposta usa este valor, mesmo que a mensagem informe outra stake.' : 'A stake informada na mensagem tem prioridade. Este valor preenche apenas a ausência.'}</span>
        </label>}
        <label><FieldLabel>Modo sharp</FieldLabel>
          <select value={bform.sharpMode || 'CLV_ONLY'} onChange={(e) => setBform((f) => ({ ...f, sharpMode: opcao(SHARP_OPTS, e.target.value) }))} style={{ ...fieldStyle, cursor: 'pointer' }}>
            {SHARP_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label><FieldLabel>Odd autoritativa na captura</FieldLabel>
          <select value={bform.capturePolicy || 'AUTO'} onChange={(e) => setBform((f) => ({ ...f, capturePolicy: opcao(CAPTURE_OPTS, e.target.value) }))} style={{ ...fieldStyle, cursor: 'pointer' }}>
            {CAPTURE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <span style={{ display: 'block', marginTop: 6, fontFamily: T.font.body, fontSize: 11.5, lineHeight: 1.45, color: T.textFaint }}>{CAPTURE_HINT[bform.capturePolicy || 'AUTO']}</span>
        </label>
      </ModalForm>
    );
  }

  if (ov.kind === 'removeBanca') {
    const b = ov.banca;
    return (
      <ModalForm pending={pend} onClose={closeOv} title="Excluir tipster permanentemente" sub={b.name} submitLabel="Excluir definitivamente" submitTone="neg" onSubmit={() => submitRemove(b)}>
        <div style={{ fontFamily: T.font.body, fontSize: 14, color: T.text, lineHeight: 1.55 }}>
          O tipster <b>{b.name}</b> e {b.betCount === 1 ? 'sua 1 aposta' : `suas ${b.betCount || 0} apostas`} serão excluídos definitivamente. Os efeitos financeiros dessas apostas também serão removidos das contas vinculadas. Esta ação não pode ser desfeita.
        </div>
      </ModalForm>
    );
  }

  return null;
}
