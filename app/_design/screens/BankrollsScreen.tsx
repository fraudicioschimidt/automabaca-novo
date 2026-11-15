"use client";
// Tipsters: KPIs, lista ordenável, comparação lado a lado e decisão de assinatura.
import { useState, useMemo } from "react";
import { usePersistedState } from "../utils";
import { AppSidebar } from "../AppSidebar";
import { AppShell } from "../kit/primitives";
import { porFaixa } from "../kit/faixas";
import { aggregateTipsterMetrics, compareTipstersByKey, DEFAULT_TIPSTER_SORT } from "../lib/tipster-metrics";
import { sharpModeLabel } from "../lib/sharp-mode";
import { BankrollsHeader } from "./bankrolls/header";
import { BankrollsKpis } from "./bankrolls/kpis";
import { BankrollsListCard } from "./bankrolls/list-card";
import { BankrollsDecisionCard } from "./bankrolls/decision-card";
import { BankrollComparison } from "./bankrolls/comparison-card";
import type { BankrollsScreenProps } from "../screen-types";

export function BankrollsScreen({ data }: BankrollsScreenProps) {
  const TIP = data;

  const [q, setQ] = useState('');
  const [sortKey, setSortKey] = usePersistedState('bankrolls:sort:v2', DEFAULT_TIPSTER_SORT);

  const ts = TIP.tipsters;
  const filtered = useMemo(() => {
    let r = ts;
    if (q.trim()) { const s = q.trim().toLowerCase(); r = r.filter((t) => (t.name + ' ' + sharpModeLabel(t.sharpMode)).toLowerCase().includes(s)); }
    return r.slice().sort((a, b) => compareTipstersByKey(a, b, sortKey));
  }, [q, sortKey, ts]);

  const agg = useMemo(() => {
    const metric = aggregateTipsterMetrics(ts);
    const lucro = metric.lucro;
    const reg = ts.reduce((s, t) => s + t.n, 0);
    const pend = ts.reduce((s, t) => s + t.open, 0);
    return { lucro, roi: metric.roi, winrate: metric.winrate, reg, pend, ativas: ts.filter((t) => t.n > 0).length };
  }, [ts]);

  const Sidebar = <AppSidebar active="Tipsters" />;

  return (
    <AppShell sidebar={Sidebar}>
      <div {...porFaixa({ flex: 1, minWidth: 0, maxWidth: 1180, margin: '0 auto' }, { padding: { largo: 46, medio: 26 } }, 'app-main')}>
        <BankrollsHeader total={ts.length} q={q} setQ={setQ} />
        <BankrollsKpis agg={agg} />
        <BankrollsListCard filtered={filtered} sortKey={sortKey} setSortKey={setSortKey} />
        {ts.length >= 2 ? <BankrollComparison tipsters={ts} /> : null}
        <BankrollsDecisionCard tipsters={ts} />
        <div style={{ height: 20 }} />
      </div>
    </AppShell>
  );
}
