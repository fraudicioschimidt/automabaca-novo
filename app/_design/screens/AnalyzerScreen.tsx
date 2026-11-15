"use client";
// Analyzer: métricas por aba (overview, CLV, período, segmentos…) de uma banca
// ou da carteira (todas as bancas, dinheiro em reais).

import { lazy, Suspense, useState, useCallback } from "react";
import ReactDOM from "react-dom";
import type { AnalyzerPeriod } from "@/src/domain/analyzer-query";
import type { AnalyzerScreenProps } from "../screen-types";
import { usePersistedState } from "../utils";
import { useDesign } from "../kit/context";
import { AppShell } from "../kit/primitives";
import { AppSidebar } from "../AppSidebar";

import { Skeleton, SkeletonRegiao } from "../kit/Skeleton";
import { BRL_FORMAT, UNITS_FORMAT } from "@/src/domain/formato-de-resultado";
import { AnalyzerCard, MoneyFormatContext, PlaceholderTab } from "./analyzer/ui-primitives";
import { PeriodCard } from "./analyzer/period-card";
import { AnalyzerHeader, tabButtonId, tabPanelId, type AnalyzerTab } from "./analyzer/header";
import {
  segViewsOf,
  useAnaliseDoRecorte,
  type AnaliseDoRecorte,
  type PropsDaAba,
  type RecorteDeApostas,
  type SegView,
} from "./analyzer/use-analise-do-recorte";
const AnalyzerLargeHistory = lazy(() => import("./analyzer/large-history").then((module) => ({ default: module.AnalyzerLargeHistory })));
const OverviewTab = lazy(() => import("./analyzer/overview-tab").then((module) => ({ default: module.OverviewTab })));
const ClvTab = lazy(() => import("./analyzer/clv-tab").then((module) => ({ default: module.ClvTab })));
const SteamTab = lazy(() => import("./analyzer/steam-tab").then((module) => ({ default: module.SteamTab })));
const TimingTab = lazy(() => import("./analyzer/timing-tab").then((module) => ({ default: module.TimingTab })));
const LiquidezTab = lazy(() => import("./analyzer/liquidez-tab").then((module) => ({ default: module.LiquidezTab })));
const SegmentosTab = lazy(() => import("./analyzer/segmentos-tab").then((module) => ({ default: module.SegmentosTab })));
const CasasTab = lazy(() => import("./analyzer/casas-tab").then((module) => ({ default: module.CasasTab })));
const PeriodoTab = lazy(() => import("./analyzer/periodo-tab").then((module) => ({ default: module.PeriodoTab })));
const StakeSimulatorTab = lazy(() => import("./analyzer/simulador-tab").then((module) => ({ default: module.StakeSimulatorTab })));
const Sheet = lazy(() => import("../kit/overlay-sheet").then((module) => ({ default: module.Sheet })));
const GavetaDeApostas = lazy(() => import("./analyzer/gaveta-de-apostas").then((module) => ({ default: module.GavetaDeApostas })));

/** A gaveta aberta: o recorte e o elemento que devolve o foco ao fechar. */
type RecorteAberto = RecorteDeApostas & { origem: HTMLElement | null };

export function AnalyzerScreen({ data = null, slug = null, bkId: bkIdProp = null, onQueryChange = null, queryPending = false }: AnalyzerScreenProps) {
  const [tab, setTab] = usePersistedState<AnalyzerTab>('analyzer:tab', 'overview');
  const portfolio = data?.scope === 'portfolio';
  // A carteira guarda a própria dimensão: abre em Canal, e a banca, que não
  // tem essa dimensão, não herda a escolha.
  const [bankrollSeg, setBankrollSeg] = usePersistedState<SegView>('analyzer:seg', 'esporte');
  const [portfolioSeg, setPortfolioSeg] = usePersistedState<SegView>('analyzer:carteira:seg', 'canal');
  const segViews = segViewsOf(portfolio);
  const guardada = portfolio ? portfolioSeg : bankrollSeg;
  const segView = segViews.includes(guardada) ? guardada : segViews[0]!;
  const setSegView = portfolio ? setPortfolioSeg : setBankrollSeg;

  const [localRange, setLocalRange] = usePersistedState<AnalyzerPeriod>('analyzer:range', 'tudo');
  const range = data?.query?.periodo ?? localRange;
  const setRange = (periodo: AnalyzerPeriod) => onQueryChange ? onQueryChange({ periodo, pagina: 1 }) : setLocalRange(periodo);
  const bkId = bkIdProp || ((typeof location !== 'undefined') ? new URLSearchParams(location.search).get('bk') : null);
  const bkName = data?.bk.name || 'Tipster';
  const analise = useAnaliseDoRecorte({ data, tab, segView, range });
  const { todayKey, FB, janela, futurePending, rotuloAnterior, janelaAnterior, anterior, emCursoAtual } = analise;

  /**
   * A gaveta: as apostas por trás do número clicado. Guarda o recorte pronto
   * (título, contexto, apostas, resumo), não a coordenada de onde veio: refazer
   * o filtro aqui é como a linha diz 12 e a gaveta abre 11.
   */
  const [recorte, setRecorte] = useState<RecorteAberto | null>(null);
  const abrirRecorte = useCallback((r: RecorteDeApostas) => {
    // A origem do foco é capturada no clique: quando a gaveta e o Sheet (ambos
    // `lazy`) montam, o foco já saiu da linha.
    const origem = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setRecorte({ ...r, origem });
  }, []);
  const fecharRecorte = useCallback(() => setRecorte(null), []);

  const periodCard = (
    <PeriodCard range={range} setRange={setRange}
      todayKey={todayKey} FB={FB}
      janela={data?.largeHistory && range === "tudo"
        ? (data.largeHistory.firstDay && data.largeHistory.lastDay
          ? { inicio: data.largeHistory.firstDay, fim: data.largeHistory.lastDay } : null)
        : janela}
      janelaAnterior={data?.largeHistory ? null : janelaAnterior} rotuloAnterior={rotuloAnterior}
      query={data?.query} onQueryChange={onQueryChange} pending={queryPending}
      totalCount={data?.largeHistory?.total} futurePending={data?.largeHistory ? 0 : futurePending} />
  );

  const tabProps: PropsDaAba = { periodCard, FB, anterior, emCursoAtual, abrirRecorte };

  return (
    <MoneyFormatContext value={portfolio ? BRL_FORMAT : UNITS_FORMAT}>
    <AppShell sidebar={<AppSidebar active="Tipsters" />}>
      <div className="app-main" style={{ flex: 1, minWidth: 0, padding: '48px' }}>
        <AnalyzerHeader tab={tab} setTab={setTab} data={data} slug={slug} bkId={bkId} bkName={bkName} />
        <div role="tabpanel" id={tabPanelId(tab)} aria-labelledby={tabButtonId(tab)} tabIndex={0}>
        {data?.largeHistory && onQueryChange ? <>
          {periodCard}
          <Suspense fallback={<p role="status">Carregando histórico…</p>}>
            <AnalyzerLargeHistory history={data.largeHistory} onChange={onQueryChange}
              pending={queryPending} />
          </Suspense>
        </> : <Suspense fallback={<EsqueletoDaAba />}>
          <AbaDoAnalyzer tab={tab} analise={analise} segView={segView} segViews={segViews} setSegView={setSegView} tabProps={tabProps}
            simulator={{
              portfolio,
              wholeHistory: range === 'tudo' && !data?.query?.esporte && !data?.query?.casa,
            }} />
        </Suspense>}
        </div>
      </div>
      {recorte && typeof document !== 'undefined' && ReactDOM.createPortal(
        <GavetaDoRecorte recorte={recorte} onClose={fecharRecorte} />, document.body)}
    </AppShell>
    </MoneyFormatContext>
  );
}

function AbaDoAnalyzer({ tab, analise, segView, segViews, setSegView, tabProps, simulator }: {
  tab: AnalyzerTab;
  analise: AnaliseDoRecorte;
  segView: SegView;
  segViews: readonly SegView[];
  setSegView: (segView: SegView) => void;
  tabProps: PropsDaAba;
  simulator: { portfolio: boolean; wholeHistory: boolean };
}) {
  // O hook calcula exatamente a agregação da aba aberta: a da aba escolhida
  // aqui nunca é nula.
  const { D, E, S, Z, P, segData, C, K } = analise;
  return tab === 'overview' ? <OverviewTab {...tabProps} D={D!} />
    : tab === 'clv' ? <ClvTab {...tabProps} E={E!} />
    : tab === 'steam' ? <SteamTab {...tabProps} S={S!} />
    : tab === 'timing' ? <TimingTab {...tabProps} Z={Z!} />
    : tab === 'liquidez' ? <LiquidezTab {...tabProps} Z={Z!} />
    : tab === 'segmentos' ? <SegmentosTab {...tabProps} segData={segData!} carteira={C} segView={segView} segViews={segViews} setSegView={setSegView} />
    : tab === 'casas' ? <CasasTab {...tabProps} P={P!} />
    : tab === 'periodo' ? <PeriodoTab {...tabProps} P={P!} />
    : tab === 'simulador' ? <StakeSimulatorTab periodCard={tabProps.periodCard} K={K!} {...simulator} />
    : <PlaceholderTab />;
}

/** Reserva a altura de um cartão com gráfico, para a página não saltar quando o dado chega. */
function EsqueletoDaAba() {
  const { T } = useDesign();
  return (
    <AnalyzerCard>
      <SkeletonRegiao rotulo="Carregando a análise desta aba…">
        <Skeleton altura={13} largura="42%" />
        <div style={{ height: 10 }} />
        <Skeleton altura={11} largura="68%" />
        <div style={{ height: 20 }} />
        <Skeleton altura={230} raio={T.radiusMd} />
      </SkeletonRegiao>
    </AnalyzerCard>
  );
}

function GavetaDoRecorte({ recorte, onClose }: { recorte: RecorteAberto; onClose: () => void }) {
  return (
    <Suspense fallback={<div role="status" className="design-overlay-loading">Carregando…</div>}>
      {/* Sem `height`: a gaveta abraça o conteúdo (o `max-height` do Sheet limita). */}
      <Sheet cardPad={24} onClose={onClose} wide
        focoDeVolta={recorte.origem}
        title={recorte.titulo} sub={recorte.contexto}>
        <GavetaDeApostas apostas={recorte.apostas} resumo={recorte.resumo} />
      </Sheet>
    </Suspense>
  );
}
