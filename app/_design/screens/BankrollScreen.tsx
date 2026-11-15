"use client";
// Tela de uma bankroll: histórico, métricas, gráfico e ações sobre as apostas.

import React, { Suspense, useEffect, useState } from "react";
import * as ReactDOM from "react-dom";
import { AppSidebar } from "../AppSidebar";
import { AppShell } from "../kit/primitives";
import type { BankrollScreenProps } from "../screen-types";

import { ActiveFilterChips, SubTools } from "./bankroll/filters";
import { BankrollHeader } from "./bankroll/header";
import { MetricsGrid } from "./bankroll/metrics-grid";
import { useBankrollState } from "./bankroll/use-bankroll-state";

const BetHistory = React.lazy(() => import("./bankroll/bet-history").then((module) => ({ default: module.BetHistory })));
const ProfitChart = React.lazy(() => import("./bankroll/profit-chart").then((module) => ({ default: module.ProfitChart })));
const StatsView = React.lazy(() => import("./bankroll-stats").then((module) => ({ default: module.StatsView })));
const AddBetSheet = React.lazy(() => import("./bankroll/add-bet-sheet").then((module) => ({ default: module.AddBetSheet })));
const CalendarView = React.lazy(() => import("./bankroll/calendar-view").then((module) => ({ default: module.CalendarView })));
const EmptyState = React.lazy(() => import("./bankroll/empty-state").then((module) => ({ default: module.EmptyState })));
const ShareContent = React.lazy(() => import("./bankroll/share-content").then((module) => ({ default: module.ShareContent })));
const Sheet = React.lazy(() => import("../kit/overlay-sheet").then((module) => ({ default: module.Sheet })));
const SettlementNotice = React.lazy(() => import("./bankroll/settlement-notice").then((module) => ({ default: module.SettlementNotice })));
const ResultMenu = React.lazy(() => import("./bankroll/result-menu").then((module) => ({ default: module.ResultMenu })));
const FilterPopover = React.lazy(() => import("./bankroll/filter-popover").then((module) => ({ default: module.FilterPopover })));
const BatchRemovalConfirm = React.lazy(() => import("./bankroll/batch-removal-confirm").then((module) => ({ default: module.BatchRemovalConfirm })));

function OverlayFallback() {
  return <div role="status" className="design-overlay-loading">Carregando…</div>;
}

function SectionFallback({ history = false }: { history?: boolean }) {
  return <div role="status" className={`design-section-loading${history ? " design-section-loading--history" : ""}`}>Carregando seção…</div>;
}

export function BankrollScreen({ emptyState = false, data = null, canManage = true, onFetchClosing = null, onSettleBet = null, onDeleteBet = null, onExportCsv = null, onRegisterBet = null, onChangeSharpMode = null, onPreviewRemoval = null, onRemoveBets = null, onRestoreBets = null }: BankrollScreenProps) {
  const [showDeferredSections, setShowDeferredSections] = useState(false);

  useEffect(() => {
    const schedule = window.requestIdleCallback
      ? window.requestIdleCallback(() => setShowDeferredSections(true), { timeout: 800 })
      : window.setTimeout(() => setShowDeferredSections(true), 0);
    return () => {
      if (typeof window.requestIdleCallback === 'function') window.cancelIdleCallback(schedule);
      else window.clearTimeout(schedule);
    };
  }, []);

  const bk = useBankrollState({
    data, onFetchClosing, onSettleBet, onDeleteBet, onExportCsv, onRegisterBet, onChangeSharpMode,
    onPreviewRemoval, onRemoveBets, onRestoreBets,
  });

  const Sidebar = <AppSidebar active="Tipsters" />;

  return (
    <AppShell sidebar={Sidebar}>
      <div className="app-main" style={{ flex: 1, minWidth: 0, padding: '44px' }}>
        <BankrollHeader
          AB={bk.AB}
          bkName={bk.bkName} bkSlug={bk.bkSlug} bkLogoUrl={bk.bkLogoUrl} M={bk.M}
          bkOpen={bk.bkOpen} setBkOpen={bk.setBkOpen} bkItems={bk.bkItems}
          sharpOpen={bk.sharpOpen} setSharpOpen={bk.setSharpOpen}
          currentSharpMode={bk.currentSharpMode} onChangeSharpMode={bk.handleChangeSharpMode}
          fetchingClosing={bk.fetchingClosing} exporting={bk.exporting}
          onFetchClosing={bk.handleFetchClosing} exportCSV={bk.exportCSV} setOverlay={bk.setOverlay}
          canManage={canManage}
        />
        {emptyState ? (
          <Suspense fallback={<OverlayFallback />}><EmptyState setOverlay={bk.setOverlay} canManage={canManage} /></Suspense>
        ) : (
          <React.Fragment>
            <MetricsGrid metrics={bk.metrics} recorteInfo={bk.recorteInfo} />
            <SubTools
              overlay={bk.overlay} setOverlay={bk.setOverlay}
              showFilters={bk.showFilters} setShowFilters={bk.setShowFilters} setFilterPane={bk.setFilterPane}
              activeFilterCount={bk.activeFilterCount}
              marginBottom={bk.activeFilterCount ? 14 : 22}
              FilterPopoverEl={
                <Suspense fallback={null}>
                  <FilterPopover
                    filters={bk.filters} setFilters={bk.setFilters}
                    setFilterPane={bk.setFilterPane} setF={bk.setF}
                    filterRows={bk.filterRows} activeFilterCount={bk.activeFilterCount}
                    filtered={bk.filtered} allBets={bk.allBets} pane={bk.pane}
                  />
                </Suspense>
              }
            />
            <ActiveFilterChips filters={bk.filters} setFilters={bk.setFilters} setF={bk.setF} activeFilterCount={bk.activeFilterCount} />
            {showDeferredSections ? <Suspense fallback={<SectionFallback />}>
              <ProfitChart AB={bk.AB} />
            </Suspense> : <SectionFallback />}
            {showDeferredSections ? <Suspense fallback={<SectionFallback history />}>
              <BetHistory
                AB={bk.AB} filterKey={JSON.stringify(bk.filters)}
                q={bk.q} setQ={bk.setQ} tab={bk.tab} setTab={bk.setTab} counts={bk.counts} filtered={bk.filtered} groups={bk.groups}
                open={bk.open} setOpen={bk.setOpen} setResultMenu={bk.setResultMenu} settling={bk.settling}
                copyVisible={bk.copyVisible} openMonths={bk.openMonths} setOpenMonths={bk.setOpenMonths}
                canManage={canManage} removal={bk.removal}
              />
            </Suspense> : <SectionFallback history />}
          </React.Fragment>
        )}
      </div>
      {bk.overlay === 'calendario' && ReactDOM.createPortal(
        <Suspense fallback={<OverlayFallback />}><Sheet cardPad="var(--bk-pad)" onClose={() => bk.setOverlay(null)} wide height="min(720px, calc(100vh - 80px))" title="Calendário" sub={(bk.AB.historyTotal ?? 0) > bk.AB.BETS.length ? `Amostra das ${bk.AB.BETS.length} mais recentes de ${bk.AB.historyTotal} · clique num dia para ver as apostas` : "Resultado por dia · clique num dia para ver as apostas"}>
          <CalendarView
            todayKey={bk.todayKey}
            calMonth={bk.calMonth} setCalMonth={bk.setCalMonth} selDay={bk.selDay} setSelDay={bk.setSelDay}
            dayAgg={bk.dayAgg} allBets={bk.allBets}
          />
        </Sheet></Suspense>, document.body)}
      {bk.overlay === 'estatisticas' && ReactDOM.createPortal(
        <Suspense fallback={<OverlayFallback />}><Sheet cardPad="var(--bk-pad)" onClose={() => bk.setOverlay(null)} wide title="Estatísticas" sub={(bk.AB.historyTotal ?? 0) > bk.AB.BETS.length ? `Visão analítica da amostra carregada (${bk.AB.BETS.length} de ${bk.AB.historyTotal})` : "Visão analítica do período filtrado"}>
          <StatsView bets={bk.filtered} />
        </Sheet></Suspense>, document.body)}
      {canManage && bk.overlay === 'adicionar' && ReactDOM.createPortal(
        <Suspense fallback={<OverlayFallback />}><Sheet cardPad="var(--bk-pad)" onClose={() => bk.setOverlay(null)} title="Adicionar aposta" sub={bk.bkName + ' · nova entrada do tipster'}>
          <AddBetSheet todayKey={bk.todayKey} formCb={bk.formCb} formErr={bk.formErr} preview={bk.preview} addBet={bk.addBet} registering={bk.registering} onClose={() => bk.setOverlay(null)} />
        </Sheet></Suspense>, document.body)}
      {bk.overlay === 'compartilhar' && ReactDOM.createPortal(
        <Suspense fallback={<OverlayFallback />}><Sheet cardPad="var(--bk-pad)" onClose={() => bk.setOverlay(null)} title="Compartilhar desempenho" sub={bk.bkName + ' · cartão pronto para print'}>
          <ShareContent
            bkName={bk.bkName} bkSeg={bk.bkSeg} mLucro={bk.share.lucro} mRoi={bk.share.roi} mClv={bk.share.clv} mOpen={bk.share.open}
            hasRoi={bk.share.hasRoi} hasClv={bk.share.hasClv} hasAcerto={bk.hasAcerto}
            shN={bk.shN} shAcerto={bk.shAcerto} shEq={bk.shEq}
          />
        </Sheet></Suspense>, document.body)}
      {canManage && bk.settlementNotice && ReactDOM.createPortal(
        <Suspense fallback={<OverlayFallback />}><Sheet cardPad="var(--bk-pad)"
          title={bk.settlementNotice.kind === 'conflict' ? 'A aposta mudou' : 'Confirmação do resultado'} onClose={bk.closeSettlementNotice}>
          <SettlementNotice notice={bk.settlementNotice} labels={bk.RESULT_LABEL}
            busy={Boolean(bk.settling)} onConfirm={bk.confirmSettlement} onClose={bk.closeSettlementNotice} />
        </Sheet></Suspense>, document.body)}
      {canManage && bk.removal.confirm && ReactDOM.createPortal(
        <Suspense fallback={<OverlayFallback />}>
          <BatchRemovalConfirm plan={bk.removal.confirm.plan} changed={bk.removal.confirm.changed} busy={bk.removal.busy}
            onConfirm={bk.removal.confirmRemoval} onClose={bk.removal.closeConfirm} />
        </Suspense>, document.body)}
      {canManage && bk.resultMenu && ReactDOM.createPortal(
        <div onClick={() => bk.setResultMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 250 }}>
          <Suspense fallback={<OverlayFallback />}>
            <ResultMenu menu={bk.resultMenu} results={bk.RESULTS}
              onPick={(res, cash) => bk.doSettle(bk.resultMenu!.b, res, cash)}
              onDelete={() => bk.doDelete(bk.resultMenu!.b)} />
          </Suspense>
        </div>, document.body)}
    </AppShell>
  );
}
