import { useEffect, useMemo, useState } from "react";
import type { BankrollActions } from "../../action-contracts";
import { useDesign } from "../../kit/context";
import { mergeUniqueBets } from "../../lib/bankroll-bets";
import { aggregateCalendarDays } from "../../lib/bankroll-calendar";
import {
  DEFAULT_BANKROLL_FILTERS,
  normalizeBankrollFilters,
  selectBankrollHistory,
  type BankrollFilters,
} from "../../lib/bankroll-filters";
import { BANKROLL_RUNTIME, groupByDay } from "../../lib/bankroll-runtime";
import { parseDayKeyParts, resolveTodayKey } from "../../lib/calendar-date";
import { resumirApostas } from "../../lib/resumo-de-apostas";
import { sportLabel } from "../../lib/sport-options";
import { usePersistedState } from "../../utils";
import { bankrollKpis, shareStats } from "./bankroll-kpis";
import { MV_LABEL } from "./constants";
import { makeResults, resultLabelFromResults } from "./settle";
import { applySettlementOverride, type SettlementOverride } from "./settlement-view";
import type { BankrollBet, BankrollData, BankrollView, LocalBet, Overlay, ResultMenuState } from "./types";
import { useBankrollActions } from "./use-bankroll-actions";
import { useBatchRemoval } from "./use-batch-removal";
import { useCloseOnScrollOrEscape, useDismissOnOutside } from "./use-dismiss";
import { sharpModeLabel } from "../../lib/sharp-mode";

/** Nome, logo e o seletor de bancas do cabeçalho; sem dado, a banca-padrão do runtime. */
function bankrollIdentity(AB: BankrollView) {
  const bk = AB.bk;
  if (!bk) {
    return { bkName: 'Big Data', bkSlug: 'main', bkLogoUrl: null, bkItems: [{ name: 'Big Data', href: '/tipsters/main', cur: true }] };
  }
  return {
    bkName: bk.name,
    bkSlug: bk.slug,
    bkLogoUrl: bk.logoUrl || null,
    bkItems: [{ name: bk.name, href: '/tipsters/' + bk.slug, cur: true }]
      .concat(AB.tips.filter((t) => t.id !== bk.slug).map((t) => ({ name: t.name, href: '/tipsters/' + t.id, cur: false }))),
  };
}

export type FilterRow = { key: keyof BankrollFilters; label: string; cur: string; opts: Array<[string, string]> };

function buildFilterRows(allBets: readonly BankrollBet[], filters: BankrollFilters): FilterRow[] {
  const sportOpts = [...new Set(allBets.map((b) => b.esporte).filter(Boolean))].sort((a, b) => sportLabel(a).localeCompare(sportLabel(b), 'pt-BR'));
  const regionOpts = [...new Set(allBets.map((b) => b.region))];
  const lineOpts = [...new Set(allBets.map((b) => b.line))];
  return [
    { key: 'sport', label: 'Esporte', cur: (!filters.sport || filters.sport === 'todos') ? 'Todos' : sportLabel(filters.sport),
      opts: [['Todos', 'todos'], ...sportOpts.map((s): [string, string] => [sportLabel(s), s])] },
    { key: 'region', label: 'Região / liga', cur: filters.region === 'todas' ? 'Todas' : filters.region,
      opts: [['Todas', 'todas'], ...regionOpts.map((r): [string, string] => [r, r])] },
    { key: 'line', label: 'Linha', cur: filters.line === 'todas' ? 'Todas' : filters.line,
      opts: [['Todas', 'todas'], ...lineOpts.map((l): [string, string] => [l, l])] },
    { key: 'odds', label: 'Faixa de odds', cur: filters.odds === 'todas' ? 'Todas' : filters.odds,
      opts: [['Todas', 'todas'], ['< 1.90', '<1.90'], ['1.90 – 1.95', '1.90–1.95'], ['1.95 – 2.00', '1.95–2.00'], ['2.00 +', '2.00+']] },
    { key: 'movement', label: 'Movimento de linha', cur: filters.movement === 'todas' ? 'Todas' : (MV_LABEL[filters.movement] ?? ''),
      opts: [['Todas', 'todas'], ['Steam', 'steam'], ['Drift', 'drift'], ['Estável', 'estavel']] },
  ];
}

/**
 * Apostas do servidor + as otimistas da tela (criadas, liquidadas, excluídas).
 * O App Router pode preservar o estado ao trocar só o `[slug]`: ao mudar de
 * banca, os otimistas da anterior são descartados.
 */
function useHistoryWithOptimism(bankrollSlug: string | null, serverBets: BankrollView["BETS"]) {
  const [extraBets, setExtraBets] = useState<LocalBet[]>([]);
  const [resultOverrides, setResultOverrides] = useState<Record<string, SettlementOverride>>({});
  const [deletedBetIds, setDeletedBetIds] = useState(() => new Set<string>());

  useEffect(() => {
    if (!bankrollSlug) return;
    setExtraBets([]);
    setResultOverrides({});
    setDeletedBetIds(new Set());
  }, [bankrollSlug]);

  const allBets: BankrollBet[] = useMemo(() => {
    const merged = mergeUniqueBets<BankrollBet>(extraBets, serverBets).sort((a, b) => a.day < b.day ? 1 : a.day > b.day ? -1 : 0);
    return merged
      .filter((b) => !deletedBetIds.has(b.id))
      .map((b) => applySettlementOverride(b, resultOverrides[b.id]));
  }, [extraBets, resultOverrides, deletedBetIds, serverBets]);

  return { allBets, setExtraBets, setResultOverrides, setDeletedBetIds };
}

type BankrollStateProps = BankrollActions & { data: BankrollData | null };

export function useBankrollState({
  data, onFetchClosing, onSettleBet, onDeleteBet, onExportCsv, onRegisterBet, onChangeSharpMode,
  onPreviewRemoval, onRemoveBets, onRestoreBets,
}: BankrollStateProps) {
  const { T, ink } = useDesign();
  const AB: BankrollView = data ? { ...BANKROLL_RUNTIME, ...data } : BANKROLL_RUNTIME;
  const todayKey = resolveTodayKey(AB.todayKey);
  const todayParts = parseDayKeyParts(todayKey);

  const [tab, setTab] = usePersistedState('refino:tab', 'todas');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ b12: true, b13: true });
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [calMonth, setCalMonth] = useState(() => ({ y: todayParts.year, m: todayParts.monthIndex }));
  const [selDay, setSelDay] = useState(todayKey);
  const [showFilters, setShowFilters] = useState(false);
  const [resultMenu, setResultMenu] = useState<ResultMenuState | null>(null);
  const [storedFilters, setFilters] = usePersistedState<BankrollFilters>('refino:filters', DEFAULT_BANKROLL_FILTERS);
  const filters = useMemo(() => normalizeBankrollFilters(storedFilters), [storedFilters]);
  const [filterPane, setFilterPane] = useState<FilterRow["key"] | null>(null);
  const [openMonths, setOpenMonths] = useState<Set<string> | null>(null);
  const [bkOpen, setBkOpen] = useState(false);
  const [sharpOpen, setSharpOpen] = useState(false);

  const { allBets, setExtraBets, setResultOverrides, setDeletedBetIds } = useHistoryWithOptimism(AB.bk?.slug ?? null, AB.BETS);

  // "Removidas" lista o que saiu da banca: as apostas da banca, os KPIs e a
  // busca delas ficam como em "Todas".
  const removedTab = tab === 'removidas';
  const { filtered, counts, activeFilterCount } = useMemo(
    () => selectBankrollHistory(allBets, { tab: removedTab ? 'todas' : tab, query: removedTab ? '' : q, filters }),
    [allBets, tab, removedTab, q, filters],
  );
  const groups = useMemo(() => groupByDay(filtered), [filtered]);
  const dayAgg = useMemo(() => aggregateCalendarDays(allBets), [allBets]);
  const RESULTS = makeResults(T);
  const RESULT_LABEL = resultLabelFromResults(RESULTS);

  const recorte = useMemo(() => resumirApostas(filtered), [filtered]);
  const kpis = bankrollKpis({
    AB, T, ink, allBets, filtered, recorte,
    filtroAtivo: activeFilterCount > 0 || (!removedTab && (tab !== 'todas' || q.trim() !== '')),
  });

  const setF = (patch: Partial<BankrollFilters>) => setFilters((f) => ({ ...normalizeBankrollFilters(f), ...patch }));
  const filterRows = buildFilterRows(allBets, filters);
  const pane = filterRows.find((r) => r.key === filterPane);

  const actions = useBankrollActions({
    AB, todayKey, allBets, filtered, overlay, setOverlay, setExtraBets,
    setResultMenu, setResultOverrides, setDeletedBetIds, resultLabel: RESULT_LABEL,
    onFetchClosing, onSettleBet, onDeleteBet, onExportCsv, onRegisterBet, onChangeSharpMode,
  });

  const removal = useBatchRemoval({
    slug: AB.bk?.slug, visibleBets: filtered, setDeletedBetIds, onPreviewRemoval, onRemoveBets, onRestoreBets,
  });

  useCloseOnScrollOrEscape(resultMenu, setResultMenu);
  useDismissOnOutside(showFilters, setShowFilters, '[data-filter-pop]', true);
  useDismissOnOutside(bkOpen, setBkOpen, '[data-bk-pop]', false);
  useDismissOnOutside(sharpOpen, setSharpOpen, '[data-sharp-pop]', true);

  const bkSeg = sharpModeLabel(actions.currentSharpMode);

  return {
    AB,
    tab, setTab, q, setQ, open, setOpen, overlay, setOverlay,
    todayKey, calMonth, setCalMonth, selDay, setSelDay, showFilters, setShowFilters,
    fetchingClosing: actions.fetchingClosing, exporting: actions.exporting,
    resultMenu, setResultMenu, settling: actions.settling, registering: actions.registering,
    filters, setFilters, filterPane, setFilterPane, openMonths, setOpenMonths,
    formErr: actions.formErr, preview: actions.preview, bkOpen, setBkOpen,
    sharpOpen, setSharpOpen, currentSharpMode: actions.currentSharpMode, handleChangeSharpMode: actions.handleChangeSharpMode,
    allBets, filtered, groups, counts, activeFilterCount, dayAgg,
    ...bankrollIdentity(AB), bkSeg, M: AB.METRICS,
    setF, filterRows, pane, RESULTS, RESULT_LABEL,
    settlementNotice: actions.settlementNotice, confirmSettlement: actions.confirmSettlement,
    closeSettlementNotice: actions.closeSettlementNotice,
    ...kpis, ...shareStats(AB),
    exportCSV: actions.exportCSV, copyVisible: actions.copyVisible,
    handleFetchClosing: actions.handleFetchClosing, doSettle: actions.doSettle,
    doDelete: actions.doDelete, addBet: actions.addBet, formCb: actions.formCb,
    removal,
  };
}
