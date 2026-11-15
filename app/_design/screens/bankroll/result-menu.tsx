"use client";

import React, { useState, type CSSProperties } from "react";
import { parseDecimalInput } from "@/src/domain/decimal-input";
import type { StatusDeTela } from "@/src/domain/status-de-aposta";
import { useDesign } from "../../kit/context";
import { ICONS, Icon } from "../../kit/icons";
import { toast } from "../../toast";
import type { ResultOption } from "./settle";
import type { ResultMenuState } from "./types";

// Menu "alterar resultado" ancorado no clique (fixed, em portal para não ser
// cortado pelo overflow do card). `menu` = { b, x, y }; onPick(result, cashoutLucro?).
export function ResultMenu({ menu, results, onPick, onDelete }: {
  menu: ResultMenuState;
  results: readonly ResultOption[];
  onPick: (result: StatusDeTela, cashoutLucro?: number) => void;
  onDelete: () => void;
}) {
  const { T } = useDesign();
  const { b, x, y } = menu;
  // Sem linha asiática fracionária a liquidação recusa o ½; o vigente fica à vista.
  const offered = results.filter(([res]) =>
    b.allowsHalfResult !== false || (res !== 'halfwon' && res !== 'half') || b.status === res);
  const [cashMode, setCashMode] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [cashVal, setCashVal] = useState('');
  const W = deleteMode ? 248 : 216;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1440;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
  const left = Math.max(12, Math.min(x - W, vw - W - 12)); // alinha a borda direita ao clique
  const menuHeight = cashMode ? 230 : deleteMode ? 216 : 420;
  const top = Math.max(12, Math.min(y + 6, vh - menuHeight - 12));
  const applyCash = () => {
    const v = parseDecimalInput(cashVal);
    if (v === null) { toast('Informe o lucro do cashout (em u)', 'warn'); return; }
    onPick('cashout', v);
  };
  const itemBtn: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px',
    minHeight: 44,
    borderRadius: T.radiusSm, border: 'none', cursor: 'pointer', fontFamily: T.font.body, fontSize: 13.5,
    color: T.text, textAlign: 'left', transition: `background ${T.motion.fast}` };
  return (
    <div role={deleteMode ? 'alertdialog' : 'dialog'} aria-label={deleteMode ? 'Excluir aposta' : 'Alterar resultado'}
      onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', top, left, width: W, zIndex: 251,
      background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radiusMd, boxShadow: T.cardShadow,
      padding: 6, minHeight: !cashMode && !deleteMode ? 407 : undefined, fontFamily: T.font.body }}>
      {!cashMode && !deleteMode ? (
        <React.Fragment>
          <div style={{ padding: '5px 10px 8px', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: T.textFaint }}>Alterar resultado</div>
          {offered.map(([res, label, col]) => {
            const isCur = b.status === res;
            return (
              <button type="button" key={res} onClick={() => { if (res === 'cashout') setCashMode(true); else onPick(res); }}
                onMouseEnter={(e) => { if (!isCur) e.currentTarget.style.background = T.surface2; }}
                onMouseLeave={(e) => { if (!isCur) e.currentTarget.style.background = 'transparent'; }}
                style={{ ...itemBtn, background: isCur ? T.surface2 : 'transparent' }}>
                <span style={{ width: 7, height: 7, borderRadius: 7, background: col, flexShrink: 0 }} />
                <span style={{ flex: 1, fontWeight: isCur ? 600 : 500 }}>{label}</span>
                {res === 'cashout'
                  ? <Icon d="M8 4l6 6-6 6" s={13} style={{ color: T.textFaint }} />
                  : (isCur && <Icon d="M4 10l4 4 8-9" s={14} w={2} style={{ color: T.accent }} />)}
              </button>
            );
          })}
          <div style={{ height: 1, background: T.borderSoft, margin: '5px 6px' }} />
          <button type="button" onClick={() => setDeleteMode(true)}
            onMouseEnter={(e) => { e.currentTarget.style.background = T.negSoft; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            style={{ ...itemBtn, background: 'transparent', color: T.neg }}>
            <Icon d={ICONS.trashTall} s={15} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, fontWeight: 600 }}>Excluir aposta</span>
          </button>
        </React.Fragment>
      ) : cashMode ? (
        <div style={{ padding: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: T.textFaint, marginBottom: 8 }}>Lucro do cashout total (u)</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8, lineHeight: 1.4 }}>
            Retorno recebido menos a stake, em unidades. Encerra o bilhete inteiro.
          </div>
          <input autoFocus type="text" inputMode="decimal" value={cashVal} onChange={(e) => setCashVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyCash(); }} placeholder="ex.: 0,30  ·  -0,20"
            style={{ width: '100%', boxSizing: 'border-box', fontFamily: T.font.num, fontSize: 14, color: T.text,
              background: T.surface2, border: `1px solid ${T.border}`,
              borderRadius: T.radiusSm, padding: '10px 12px', outline: 'none' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={() => setCashMode(false)} style={{ flex: 1, fontFamily: T.font.body, fontSize: 13,
              fontWeight: 600, cursor: 'pointer', padding: '9px 12px', borderRadius: T.radiusSm,
              border: `1px solid ${T.border}`, background: 'transparent', color: T.text }}>Voltar</button>
            <button type="button" onClick={applyCash} style={{ flex: 1, fontFamily: T.font.body, fontSize: 13, fontWeight: 600,
              cursor: 'pointer', padding: '9px 12px', borderRadius: T.radiusSm, border: 'none',
              background: T.accent, color: T.accentText }}>Aplicar</button>
          </div>
        </div>
      ) : (
        <div style={{ padding: 8 }}>
          <div style={{ ...T.type.cap, color: T.neg, marginBottom: 8 }}>Excluir aposta?</div>
          <div style={{ ...T.type.rowTitle, color: T.text, lineHeight: 1.35, marginBottom: 5,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {b.home} vs {b.away}
          </div>
          <div style={{ ...T.type.caption, color: T.textMuted, lineHeight: 1.45 }}>
            Ela sairá da lista do tipster e seus lançamentos serão estornados.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button type="button" autoFocus onClick={() => setDeleteMode(false)} style={{ flex: 1, minHeight: 44,
              ...T.type.link, cursor: 'pointer', padding: '9px 12px',
              borderRadius: T.radiusSm, border: `1px solid ${T.border}`, background: 'transparent', color: T.text }}>
              Cancelar
            </button>
            <button type="button" onClick={onDelete} style={{ flex: 1, minHeight: 44,
              ...T.type.link, cursor: 'pointer', padding: '9px 12px', borderRadius: T.radiusSm,
              border: 'none', background: T.neg, color: T.surface }}>
              Excluir aposta
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
