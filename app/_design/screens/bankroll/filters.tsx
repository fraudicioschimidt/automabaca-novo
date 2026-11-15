import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useDesign } from "../../kit/context";
import { ICONS } from "../../kit/icons";
import { DEFAULT_BANKROLL_FILTERS, type BankrollFilters } from "../../lib/bankroll-filters";
import { sportLabel } from "../../lib/sport-options";
import { uiHexA } from "../../utils";
import { MV_LABEL } from "./constants";
import type { Overlay } from "./types";
import { Btn } from "./ui-primitives";

type SetFilters = Dispatch<SetStateAction<BankrollFilters>>;
type SetF = (patch: Partial<BankrollFilters>) => void;

function ActiveChip({ label, onClear }: { label: string | undefined; onClear: () => void }) {
  const { T } = useDesign();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.font.body, fontSize: 12.5, fontWeight: 500,
      color: T.text, background: T.accentSoft, border: `1px solid ${uiHexA(T.accent, 0.35)}`, padding: '5px 6px 5px 11px', borderRadius: T.pill }}>
      {label}
      <button type="button" onClick={onClear} aria-label={`Remover filtro ${label}`} title={`Remover ${label}`} style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, margin: '-8px -8px -8px 0', borderRadius: T.pill, border: 'none',
        background: 'transparent', color: T.accent, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
    </span>
  );
}

export function ActiveFilterChips({ filters, setFilters, setF, activeFilterCount }: {
  filters: BankrollFilters;
  setFilters: SetFilters;
  setF: SetF;
  activeFilterCount: number;
}) {
  const { T } = useDesign();
  if (activeFilterCount <= 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 18 }}>
      {filters.sport && filters.sport !== 'todos' && <ActiveChip label={sportLabel(filters.sport)} onClear={() => setF({ sport: 'todos' })} />}
      {filters.region !== 'todas' && <ActiveChip label={filters.region} onClear={() => setF({ region: 'todas' })} />}
      {filters.line !== 'todas' && <ActiveChip label={filters.line} onClear={() => setF({ line: 'todas' })} />}
      {filters.odds !== 'todas' && <ActiveChip label={`Odds ${filters.odds}`} onClear={() => setF({ odds: 'todas' })} />}
      {filters.movement !== 'todas' && <ActiveChip label={MV_LABEL[filters.movement]} onClear={() => setF({ movement: 'todas' })} />}
      <button type="button" onClick={() => setFilters(DEFAULT_BANKROLL_FILTERS)} style={{ fontFamily: T.font.body, fontSize: 12, fontWeight: 500,
        color: T.textMuted, background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 6px' }}>Limpar tudo</button>
    </div>
  );
}

export function SubTools({
  overlay, setOverlay, showFilters, setShowFilters, setFilterPane,
  activeFilterCount, FilterPopoverEl, marginBottom,
}: {
  overlay: Overlay | null;
  setOverlay: (overlay: Overlay) => void;
  showFilters: boolean;
  setShowFilters: Dispatch<SetStateAction<boolean>>;
  setFilterPane: (pane: null) => void;
  activeFilterCount: number;
  FilterPopoverEl: ReactNode;
  marginBottom: number;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom }}>
      <Btn icon={ICONS.bars} soft active={overlay === 'estatisticas'} onClick={() => setOverlay('estatisticas')}>Estatísticas</Btn>
      <div data-filter-pop="" style={{ position: 'relative' }}>
        <Btn icon={ICONS.filter} soft active={showFilters || activeFilterCount > 0} onClick={() => { setShowFilters((s) => !s); setFilterPane(null); }}>
          {activeFilterCount > 0 ? `Filtros · ${activeFilterCount}` : 'Filtros'}</Btn>
        {showFilters && FilterPopoverEl}
      </div>
      <Btn icon={ICONS.cal} soft active={overlay === 'calendario'} onClick={() => setOverlay('calendario')}>Calendário</Btn>
    </div>
  );
}
