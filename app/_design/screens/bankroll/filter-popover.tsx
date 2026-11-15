import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import { useDesign } from "../../kit/context";
import { Icon } from "../../kit/icons";
import { DEFAULT_BANKROLL_FILTERS, type BankrollFilters } from "../../lib/bankroll-filters";
import { contagem } from "../../lib/plural";
import type { FilterRow } from "./use-bankroll-state";

function RowBtn({ onClick, children, style }: { onClick: () => void; children: ReactNode; style?: CSSProperties }) {
  const { T } = useDesign();
  return (
    <button type="button" onClick={onClick} onMouseEnter={(e) => (e.currentTarget.style.background = T.surface2)}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', cursor: 'pointer',
        border: 'none', background: 'transparent', borderRadius: T.radiusSm, padding: '11px 12px', fontFamily: T.font.body,
        fontSize: 14, color: T.text, transition: `background ${T.motion.fast}`, ...style }}>{children}</button>
  );
}

export function FilterPopover({
  filters, setFilters, setFilterPane, setF,
  filterRows, activeFilterCount, filtered, allBets, pane,
}: {
  filters: BankrollFilters;
  setFilters: Dispatch<SetStateAction<BankrollFilters>>;
  setFilterPane: (pane: FilterRow["key"] | null) => void;
  setF: (patch: Partial<BankrollFilters>) => void;
  filterRows: FilterRow[];
  activeFilterCount: number;
  filtered: readonly unknown[];
  allBets: readonly unknown[];
  pane: FilterRow | undefined;
}) {
  const { T, numFont } = useDesign();
  return (
    <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 60,
      width: 300, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radiusMd,
      boxShadow: T.cardShadow, overflow: 'hidden' }}>
      {!pane ? (
        <div style={{ padding: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px 10px' }}>
            <div style={{ fontFamily: T.font.display, fontSize: 15, fontWeight: 600, color: T.text }}>Filtros</div>
            {activeFilterCount > 0 && <button type="button" onClick={() => setFilters(DEFAULT_BANKROLL_FILTERS)} style={{ marginLeft: 'auto',
              fontFamily: T.font.body, fontSize: 12.5, fontWeight: 500, color: T.accent, background: 'transparent', border: 'none', cursor: 'pointer' }}>Limpar tudo</button>}
          </div>
          {filterRows.map((r) => {
            const on = r.cur !== 'Todas' && r.cur !== 'Qualquer' && r.cur !== 'Todos';
            return (
              <RowBtn key={r.key} onClick={() => setFilterPane(r.key)}>
                <span style={{ flex: 1 }}>{r.label}</span>
                <span style={{ fontSize: 13, fontWeight: on ? 600 : 400, color: on ? T.accent : T.textMuted, maxWidth: 120,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.cur}</span>
                <Icon d="M8 4l6 6-6 6" s={14} style={{ color: T.textFaint }} />
              </RowBtn>
            );
          })}
          <div style={{ borderTop: `1px solid ${T.borderSoft}`, margin: '8px 4px 0', padding: '12px 8px 6px', fontSize: 12.5, color: T.textMuted }}>
            <b style={{ ...numFont, color: T.text }}>{filtered.length}</b> de {contagem(allBets.length, 'aposta')}
          </div>
        </div>
      ) : (
        <div style={{ padding: 8 }}>
          <RowBtn onClick={() => setFilterPane(null)} style={{ padding: '6px 10px 10px' }}>
            <Icon d="M12 4l-6 6 6 6" s={15} style={{ color: T.textMuted }} />
            <span style={{ fontFamily: T.font.display, fontSize: 15, fontWeight: 600 }}>{pane.label}</span>
          </RowBtn>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {pane.opts.map(([lb, v]) => {
              const sel = filters[pane.key] === v;
              return (
                <RowBtn key={lb} onClick={() => { setF({ [pane.key]: v }); setFilterPane(null); }}>
                  <span style={{ flex: 1, color: sel ? T.accent : T.text, fontWeight: sel ? 600 : 400 }}>{lb}</span>
                  {sel && <Icon d="M4 10l4 4 8-9" s={15} w={2} style={{ color: T.accent }} />}
                </RowBtn>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
