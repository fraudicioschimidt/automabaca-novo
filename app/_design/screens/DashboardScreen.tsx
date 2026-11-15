"use client";
// Dashboard: central de tipsters/bankrolls.
import { useState, useMemo, useEffect } from "react";
import { usePersistedState } from "../utils";
import { AppSidebar } from "../AppSidebar";
import { AppShell } from "../kit/primitives";
import { porFaixa } from "../kit/faixas";
import { aggregateTipsterMetrics, compareTipstersByKey, DEFAULT_TIPSTER_SORT, hasTipsterMetric, melhorPorTaxa } from "../lib/tipster-metrics";
import { AMOSTRA_MINIMA_EXIBICAO } from "@/src/domain/analyzer/shared";
import { sumMoneyBy } from "@/src/domain/money";

import { DashboardHeader } from "./dashboard/header";
import { HojeCard } from "./dashboard/hoje-card";
import { DesdeUltimaVisita } from "./dashboard/desde-ultima-visita";
import { DashboardKpis } from "./dashboard/kpis";
import { EquityCard } from "./dashboard/equity-card";
import { DestaquesCard } from "./dashboard/destaques-card";
import { RankingCard } from "./dashboard/ranking-card";
import type { DashboardScreenProps } from "../screen-types";

export function DashboardScreen({ data, onMarkVisit = null }: DashboardScreenProps) {
  const TIP = data;

  // Depois de mostrar o resumo, a visita avança até o instante desta leitura.
  // Falhar aqui só alarga o próximo resumo; não há o que avisar.
  const readAt = TIP.visit?.readAt;
  useEffect(() => {
    if (!onMarkVisit || !readAt) return;
    onMarkVisit(readAt).catch(() => undefined);
  }, [onMarkVisit, readAt]);

  const [sortKey, setSortKey] = usePersistedState('dash:sort:v2', DEFAULT_TIPSTER_SORT);
  const [alertOpen, setAlertOpen] = useState(false);

  useEffect(() => {
    if (!alertOpen) return;
    const h = (e: PointerEvent) => { if (!(e.target as Element).closest('[data-alert-pop]')) setAlertOpen(false); };
    document.addEventListener('pointerdown', h);
    return () => document.removeEventListener('pointerdown', h);
  }, [alertOpen]);

  const A = useMemo(() => {
    const ts = TIP.tipsters;
    const metric = aggregateTipsterMetrics(ts);
    const lucro = metric.lucro;
    const staked = metric.staked;
    const nTot = ts.reduce((s, t) => s + t.n, 0);
    const open = ts.reduce((s, t) => s + t.open, 0);
    const clv = metric.clv ?? 0;
    const roi = metric.roi ?? 0;
    const L = ts[0]?.equity.length ?? 2;
    const vazioT = { id: '', name: '—', lucro: 0, clv: 0, roi: 0, n: 0, open: 0, staked: 0, equity: [0], acerto: 0, hasRoi: false, hasClv: false };
    const financial = ts.filter((t) => hasTipsterMetric(t, 'lucro'));
    const agg = financial.length ? Array.from({ length: L }, (_, i) => sumMoneyBy(ts, (t) => t.equityBrl[i] || 0)) : [];
    const withClv = ts.filter((t) => hasTipsterMetric(t, 'clv'));
    const best = financial.slice().sort((a, b) => b.lucro - a.lucro)[0] ?? vazioT;
    // CLV é TAXA: só compete quem alcança o piso de amostra, e o cartão diz
    // sobre quantos fechamentos o número foi medido.
    const bestClv = melhorPorTaxa(withClv, 'clv', AMOSTRA_MINIMA_EXIBICAO);
    const worst = financial.slice().sort((a, b) => a.lucro - b.lucro)[0] ?? vazioT;
    const today = TIP.today;
    return { ts, lucro, staked, nTot, open, clv, roi, hasRoi: metric.roi !== null, hasClv: metric.clv !== null,
      // Amostra ao lado do percentual: +11,66% sobre 83 apostas e sobre 4 são
      // afirmações muito diferentes, e o percentual sozinho as mostra iguais.
      clvSamples: metric.clvSamples, resolvidas: metric.attempts,
      agg, best, bestClv, worst, today };
  }, [TIP]);

  const sorted = useMemo(() => {
    return A.ts.slice().sort((a, b) => compareTipstersByKey(a, b, sortKey));
  }, [sortKey, A]);

  const Sidebar = <AppSidebar active="Dashboard" />;

  return (
    <AppShell sidebar={Sidebar}>
      <div {...porFaixa({ flex: 1, minWidth: 0, maxWidth: 1180, margin: '0 auto' }, { padding: { largo: 46, medio: 26 } }, 'app-main')}>
        <DashboardHeader TIP={TIP} A={A} alertOpen={alertOpen} setAlertOpen={setAlertOpen} />
        <DesdeUltimaVisita since={TIP.visit?.since ?? null} />
        <HojeCard TIP={TIP} A={A} />
        <DashboardKpis A={A} />
        <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: '1.7fr 1fr', medio: '1fr' } })}>
          <EquityCard A={A} />
          <DestaquesCard A={A} />
        </div>
        <RankingCard TIP={TIP} sorted={sorted} sortKey={sortKey} setSortKey={setSortKey} />
        <div style={{ height: 20 }} />
      </div>
    </AppShell>
  );
}
