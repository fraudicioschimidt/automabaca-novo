import type { CSSProperties, Dispatch, SetStateAction } from "react";
import type { ContaActions, ContasData } from "../../action-contracts";
import type { ContaActionResult } from "@/app/(painel)/contas/actions";
import { useDesign } from "../../kit/context";
import { ModalForm } from "../../kit/ModalForm";
import { FieldLabel } from "./ui-primitives";
import { parseMoneyInput } from "@/src/domain/decimal-input";
import { ICONS, Icon } from "../../kit/icons";

const movMeta = { DEPOSITO: ['Depósito', 'Entrada de caixa na conta'], SAQUE: ['Saque', 'Retirada de caixa da conta'], BONUS: ['Bônus', 'Crédito já disponível em dinheiro. Freebets e créditos sujeitos a rollover têm regras próprias e não entram neste saldo.'], AJUSTE_MANUAL: ['Ajuste', 'Correção manual de saldo'] } as const;

export type ContaForm = {
  mutId?: string; valor?: string; desc?: string; casa?: string; titular?: string;
  apelido?: string; saldo?: string; bankrollIds?: string[];
};
export type ContaOverlay =
  | { kind: "mov"; accId: string; tipo: keyof typeof movMeta }
  | { kind: "conta"; accId: string | null }
  | { kind: "excluir"; accId: string };
type Props = ContaActions & {
  A: ContasData; ov: ContaOverlay | null; pend: boolean; closeOv: () => void;
  form: ContaForm; setForm: Dispatch<SetStateAction<ContaForm>>;
  bkQuery: string; setBkQuery: (query: string) => void;
  run: (action: () => Promise<ContaActionResult>, message: string) => Promise<void>;
};

type BankrollPickerProps = Pick<Props, "form" | "setForm" | "bkQuery" | "setBkQuery"> & {
  options: NonNullable<ContasData["bankrollOptions"]>;
  fieldStyle: CSSProperties;
};

/** Vínculo da conta com bancas: busca + lista marcável; o estado mora no formulário. */
function BankrollPicker({ options, form, setForm, bkQuery, setBkQuery, fieldStyle }: BankrollPickerProps) {
  const { T } = useDesign();
  const selectedIds = form.bankrollIds || [];
  const query = bkQuery.trim().toLowerCase();
  const visibleBks = options.filter((b) => !query || b.name.toLowerCase().includes(query));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
        <div style={{ fontFamily: T.font.body, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: T.textFaint }}>Tipsters vinculados</div>
        <span style={{ marginLeft: 'auto', fontFamily: T.font.num, fontVariantNumeric: 'tabular-nums', fontSize: 11.5, fontWeight: 600, color: T.textFaint }}>
          {selectedIds.length}/{options.length}
        </span>
      </div>
      <div style={{ border: `1px solid ${T.border}`, borderRadius: T.radiusMd, background: T.surface2, overflow: 'hidden' }}>
        <div style={{ padding: 10, borderBottom: `1px solid ${T.borderSoft}` }}>
          <input value={bkQuery} onChange={(e) => setBkQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
            placeholder="Buscar tipster…" style={{ ...fieldStyle, padding: '9px 11px', fontSize: 13.5, background: T.surface }} />
        </div>
        <div style={{ maxHeight: 188, overflowY: 'auto' }}>
          {visibleBks.map((b) => {
            const sel = selectedIds.includes(b.id);
            return (
              <button type="button" key={b.id} onClick={() => setForm((f) => { const s = new Set(f.bankrollIds || []); if (s.has(b.id)) s.delete(b.id); else s.add(b.id); return { ...f, bankrollIds: [...s] }; })}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  border: 'none', borderTop: `1px solid ${T.borderSoft}`, background: sel ? T.accentSoft : 'transparent',
                  color: sel ? T.text : T.textMuted, cursor: 'pointer', textAlign: 'left', fontFamily: T.font.body }}>
                <span style={{ width: 18, height: 18, borderRadius: 6, border: `1px solid ${sel ? T.accent : T.border}`,
                  background: sel ? T.accent : T.surface, color: sel ? T.accentText : 'transparent',
                  display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                  <Icon d={ICONS.check} s={12} w={2.2} />
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: T.text }}>{b.name}</span>
                </span>
                {sel && <span style={{ fontFamily: T.font.body, fontSize: 11.5, fontWeight: 600, color: T.accent }}>vinculado</span>}
              </button>
            );
          })}
          {visibleBks.length === 0 && (
            <div style={{ padding: '14px 12px', fontFamily: T.font.body, fontSize: 12.5, color: T.textFaint }}>Nenhum tipster encontrado.</div>
          )}
        </div>
      </div>
      {selectedIds.length > 0 && (
        <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 8, fontFamily: T.font.body, fontSize: 12, color: T.textMuted }}>
          <span>{selectedIds.length} selecionada{selectedIds.length === 1 ? '' : 's'}</span>
          <button type="button" onClick={() => setForm((f) => ({ ...f, bankrollIds: [] }))} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: T.font.body, fontSize: 12, fontWeight: 600, color: T.accent }}>Limpar</button>
        </div>
      )}
    </div>
  );
}

export function ContasOverlays({ A, ov, pend, closeOv, form, setForm, bkQuery, setBkQuery, run, onMovimentar, onCriar, onEditar, onRemover }: Props) {
  const { T } = useDesign();
  const fieldStyle: CSSProperties = { width: '100%', boxSizing: 'border-box', fontFamily: T.font.body, fontSize: 14, color: T.text, background: T.surface2, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '10px 12px', outline: 'none' };
  const bkOpts = A.bankrollOptions ?? [];

  if (!ov) return null;

  if (ov.kind === 'mov') {
    const [lbl, sub] = movMeta[ov.tipo] || ['Movimentação', ''];
    const acc = A.accounts.find((a) => a.id === ov.accId);
    const v = parseMoneyInput(form.valor);
    const ok = v != null && (ov.tipo === 'AJUSTE_MANUAL' ? Math.abs(v) > 0 : v > 0);
    return (
      <ModalForm pending={pend} onClose={closeOv} title={acc ? `${lbl} · ${acc.name}` : lbl} sub={sub} submitLabel={lbl} canSubmit={Boolean(ok && onMovimentar && form.mutId)}
        onSubmit={() => {
          const clientMutationId = form.mutId;
          if (!ok || v === null || !onMovimentar || !clientMutationId) return;
          return run(() => onMovimentar({ contaId: ov.accId, tipo: ov.tipo, valor: v, descricao: form.desc?.trim() || undefined, clientMutationId }), `${lbl} registrado`);
        }}>
        <label><FieldLabel>{ov.tipo === 'AJUSTE_MANUAL' ? 'Valor (R$, − para débito)' : 'Valor (R$)'}</FieldLabel><input inputMode="decimal" value={form.valor || ''} onChange={(e) => setForm((f) => ({ ...f, valor: e.target.value }))} placeholder={ov.tipo === 'AJUSTE_MANUAL' ? 'ex.: -50,00' : '0,00'} style={fieldStyle} /></label>
        <label><FieldLabel>Descrição (opcional)</FieldLabel><input maxLength={500} value={form.desc || ''} onChange={(e) => setForm((f) => ({ ...f, desc: e.target.value }))} placeholder="ex.: PIX, bônus de cadastro…" style={fieldStyle} /></label>
      </ModalForm>
    );
  }

  if (ov.kind === 'conta') {
    const editing = !!ov.accId;
    const casaOk = (form.casa || '').trim().length > 0;
    const titularOk = (form.titular || '').trim().length > 0;
    const saldo = parseMoneyInput(form.saldo || '0');
    const ok = casaOk && titularOk && (editing || (saldo != null && saldo >= 0));
    return (
      <ModalForm pending={pend} onClose={closeOv} title={editing ? 'Editar conta' : 'Nova conta'} sub={editing ? 'Casa, titular e vínculos' : 'Casa, titular, saldo inicial e vínculos'} submitLabel={editing ? 'Salvar' : 'Criar conta'} canSubmit={Boolean(ok && (editing ? onEditar : onCriar))}
        onSubmit={() => {
          if (!ok) return;
          const input = { casaDeAposta: form.casa?.trim() ?? "", titular: form.titular?.trim() ?? "", apelido: form.apelido?.trim() || undefined, bankrollIds: form.bankrollIds ?? [] };
          const contaId = ov.accId;
          const requestId = form.mutId;
          if (contaId && onEditar) return run(() => onEditar({ ...input, contaId }), "Conta atualizada");
          if (!contaId && onCriar && saldo !== null && requestId) return run(() => onCriar({ ...input, saldoInicial: saldo, requestId }), "Conta criada");
          return;
        }}>
        <label><FieldLabel>Casa de aposta</FieldLabel><input maxLength={100} value={form.casa || ''} onChange={(e) => setForm((f) => ({ ...f, casa: e.target.value }))} placeholder="ex.: Bet365" style={fieldStyle} /></label>
        <label><FieldLabel>Titular</FieldLabel><input maxLength={160} value={form.titular || ''} onChange={(e) => setForm((f) => ({ ...f, titular: e.target.value }))} placeholder="Nome do titular" style={fieldStyle} /></label>
        <label><FieldLabel>Apelido (opcional)</FieldLabel><input maxLength={120} value={form.apelido || ''} onChange={(e) => setForm((f) => ({ ...f, apelido: e.target.value }))} placeholder="ex.: conta principal" style={fieldStyle} /></label>
        {!editing && <label><FieldLabel>Saldo inicial (R$)</FieldLabel><input inputMode="decimal" value={form.saldo || ''} onChange={(e) => setForm((f) => ({ ...f, saldo: e.target.value }))} placeholder="0,00" style={fieldStyle} /></label>}
        {bkOpts.length > 0 ? <BankrollPicker options={bkOpts} form={form} setForm={setForm} bkQuery={bkQuery} setBkQuery={setBkQuery} fieldStyle={fieldStyle} /> : null}
      </ModalForm>
    );
  }

  if (ov.kind === 'excluir') {
    const acc = A.accounts.find((a) => a.id === ov.accId);
    return (
      <ModalForm pending={pend} onClose={closeOv} title="Excluir conta" sub={acc ? acc.name : ''} submitLabel="Excluir" submitTone="neg"
        canSubmit={Boolean(onRemover)} onSubmit={() => onRemover ? run(() => onRemover(ov.accId), 'Conta removida') : undefined}>
        <div style={{ fontFamily: T.font.body, fontSize: 14, color: T.text, lineHeight: 1.55 }}>A conta vira <b>encerrada</b> e sai da operação (soft-delete — o histórico é preservado; movimentações e apostas vinculadas continuam no banco). Confirmar?</div>
      </ModalForm>
    );
  }

  return null;
}
