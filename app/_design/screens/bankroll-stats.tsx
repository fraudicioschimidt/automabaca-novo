// Estatísticas da banca (overlay), calculadas sobre as apostas filtradas.
import type { ReactNode } from "react";
import { uiDisplayColor } from "../utils";
import { useDesign } from "../kit/context";
import { porFaixa } from "../kit/faixas";
import { fmtOdds, fmtPct, fmtUnit } from "@/src/domain/formato-de-resultado";
import { sumMoneyBy } from "@/src/domain/money";
import { resumirApostas } from "../lib/resumo-de-apostas";
import { MetricaComDefinicao } from "../kit/MetricaComDefinicao";
import { LegendaDaRegua, TrilhoComSinal } from "../kit/TrilhoComSinal";
import { escalaDeBarras, regua } from "../lib/barra-com-sinal";
import { contagem, plural } from "../lib/plural";
import { ranking } from "../lib/concentracao";
import { Cap } from "../kit/primitives";
import type { BankrollBet } from "./bankroll/types";

/** O que a contagem de movimentos lê de cada aposta. */
type LineMovementBet = { d?: { moveType?: string | null } | null };
type HistoBin = { label: string; n: number; color: string };
type Grupo = { k: string; n: number; stakes: number[]; clvs: number[] };

export function summarizeLineMovements(bets: readonly LineMovementBet[]) {
  const summary = { steam: 0, drift: 0, estavel: 0 };
  // Sem abertura e fechamento não há movimento medido: a aposta não entra em
  // nenhuma das três contagens.
  for (const b of bets) {
    const type = b.d?.moveType;
    if (type === 'steam' || type === 'drift' || type === 'estavel') summary[type]++;
  }
  return summary;
}

function Card({ title, sub, children, span, right }: {
  title: string;
  sub?: string;
  children?: ReactNode;
  span?: boolean;
  right?: ReactNode;
}) {
  const { T } = useDesign();
  return (
    <div style={{ gridColumn: span ? '1 / -1' : 'auto', background: T.surface2, border: `1px solid ${T.borderSoft}`,
      borderRadius: T.radiusMd, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: T.font.display, fontSize: 15, fontWeight: 600, color: T.text, letterSpacing: '-0.01em' }}>{title}</div>
          {sub && <div style={{ fontSize: 11.5, color: T.textFaint, marginTop: 3 }}>{sub}</div>}
        </div>
        {right && <div style={{ marginLeft: 'auto', textAlign: 'right' }}>{right}</div>}
      </div>
      {children}
    </div>
  );
}

function BarRow({ label, n, max, color, right }: {
  label: string;
  n: number;
  max: number;
  color?: string;
  right: number | null;
}) {
  const { T, numFont, ink } = useDesign();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '5px 0' }}>
      <div style={{ width: 92, flexShrink: 0, fontSize: 12.5, color: T.textMuted, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ flex: 1, height: 8, background: T.inset, borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${max ? n / max * 100 : 0}%`, height: '100%', background: uiDisplayColor(T, color || T.accent), borderRadius: 4 }} />
      </div>
      <div style={{ ...numFont, width: 18, flexShrink: 0, textAlign: 'right', fontSize: 12.5, fontWeight: 600, color: T.text }}>{n}</div>
      <div style={{ ...numFont, width: 58, flexShrink: 0, textAlign: 'right', fontSize: 12, fontWeight: 600,
        color: right == null ? T.textFaint : ink(right) }}>{right == null ? '—' : fmtPct(right)}</div>
    </div>
  );
}

function Histo({ bins }: { bins: HistoBin[] }) {
  const { T, numFont } = useDesign();
  const max = Math.max(1, ...bins.map((b) => b.n));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 124 }}>
        {bins.map((b, i) => (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', height: '100%' }}>
            <div style={{ ...numFont, fontSize: 12, fontWeight: 600, color: b.n ? T.text : T.textFaint, marginBottom: 6 }}>{b.n}</div>
            <div style={{ width: '100%', maxWidth: 44, height: `${Math.max(b.n / max * 100, 2)}%`,
              background: b.color, borderRadius: '6px 6px 0 0', opacity: b.n ? 1 : 0.3 }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        {bins.map((b, i) => <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: 10.5, color: T.textFaint }}>{b.label}</div>)}
      </div>
    </div>
  );
}

export function StatsView({ bets }: { bets: BankrollBet[] }) {
  const { T, numFont, ink } = useDesign();

  // A mesma conta da tira de KPI (`lib/resumo-de-apostas`), para as duas não divergirem.
  const R = resumirApostas(bets);
  const { turnover, clvMean, clvShare } = R;
  // Movimento da linha (abertura → fechamento), em %.
  const movBets = bets.filter((b): b is BankrollBet & { movimento: number } => b.movimento != null && Number.isFinite(b.movimento));
  const movMean = movBets.length ? movBets.reduce((s, b) => s + b.movimento, 0) / movBets.length : null;
  const clvBets = R.comClv;
  const settled = R.liquidadas;
  const refunds = bets.filter((b) => b.status === "void").length;
  const resultCounts = `${settled} ${plural(settled, 'liquidada')} · ${R.pendentes} em aberto${refunds ? ` · ${contagem(refunds, 'reembolso')}` : ''}`;

  const movEdges = [
    { lo: -Infinity, hi: -5, label: '< −5%' },
    { lo: -5, hi: 0, label: '−5–0' },
    { lo: 0, hi: 5, label: '0–5' },
    { lo: 5, hi: Infinity, label: '5%+' },
  ];
  const movBins: HistoBin[] = movEdges.map((e) => ({ label: e.label, n: movBets.filter((b) => b.movimento >= e.lo && b.movimento < e.hi).length,
    color: T.accent }));

  const oddsEdges: [string, number, number][] = [['<1.90', 0, 1.90], ['1.90–1.95', 1.90, 1.95], ['1.95–2.00', 1.95, 2.00], ['2.00+', 2.00, Infinity]];
  const oddsBins = oddsEdges.map(([label, lo, hi]) => ({ label, n: bets.filter((b) => b.odds >= lo && b.odds < hi).length }));

  const groupBy = (key: (b: BankrollBet) => string) => {
    const m: Record<string, Grupo> = Object.create(null);
    bets.forEach((b) => {
      const k = key(b); const e = m[k] || (m[k] = { k, n: 0, stakes: [], clvs: [] });
      e.n++; e.stakes.push(b.stake); if (b.clv != null && Number.isFinite(b.clv)) e.clvs.push(b.clv);
    });
    return ranking(Object.values(m).map((e) => ({ ...e, stake: sumMoneyBy(e.stakes, (v) => v), clvMean: e.clvs.length ? e.clvs.reduce((s, v) => s + v, 0) / e.clvs.length : null })), 'n');
  };
  const byRegion = groupBy((b) => b.region);
  const byLine = groupBy((b) => b.line);

  const mv = summarizeLineMovements(bets);

  const kpis = [
    { k: 'Apostas', metrica: 'amostra', v: String(bets.length), sub: resultCounts, c: T.text },
    { k: 'Turnover', metrica: 'stake', v: fmtUnit(turnover), sub: 'stake total no período', c: T.text },
    { k: 'Linha média', metrica: 'movimento', v: movMean == null ? '—' : fmtPct(movMean), sub: 'abertura → fechamento (justas)', c: movMean == null ? T.textFaint : T.text },
    { k: 'CLV médio', metrica: 'clv', v: clvMean == null ? '—' : fmtPct(clvMean), sub: clvShare == null ? 'sem base alcançável' : `${clvShare}% das alcançáveis c/ fechamento`, c: clvMean == null ? T.textFaint : ink(clvMean) },
  ];
  const oddsMax = Math.max(1, ...oddsBins.map((b) => b.n));
  const regionMax = Math.max(1, ...byRegion.map((b) => b.n));
  const lineMax = Math.max(1, ...byLine.map((b) => b.n));
  const mvTotal = mv.steam + mv.drift + mv.estavel;
  const mvScale = mvTotal || 1;
  // Barras de CLV com o zero no meio do trilho (o sinal não fica só na cor) e
  // a régua no CLV médio que o cabeçalho declara.
  const escalaClv = escalaDeBarras(clvBets.map((b) => b.clv), { referencia: clvMean });
  const reguaClv = regua({
    valor: clvMean,
    texto: clvMean == null ? '' : fmtPct(clvMean),
    descricao: `CLV médio de ${contagem(clvBets.length, 'aposta')} com fechamento`,
  });
  const mvParts: { label: string; metrica?: string; n: number; color: string }[] = [
    { label: 'Steam (a favor)', metrica: 'steam', n: mv.steam, color: T.pos },
    { label: 'Drift (contra)', metrica: 'drift', n: mv.drift, color: T.neg },
    { label: 'Estável', n: mv.estavel, color: T.textFaint },
  ];

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--bk-pad)' }}>
      {/* KPI strip */}
      <div {...porFaixa({ display: 'grid', gap: 14, marginBottom: 16 }, { gridTemplateColumns: { largo: 'repeat(4,1fr)', compacto: 'repeat(2,minmax(0,1fr))' } })}>
        {kpis.map((m) => (
          <div key={m.k} style={{ background: T.surface2, border: `1px solid ${T.borderSoft}`, borderRadius: T.radiusMd, padding: '16px 18px' }}>
            <MetricaComDefinicao metrica={m.metrica}><Cap>{m.k}</Cap></MetricaComDefinicao>
            <div style={{ ...numFont, fontSize: 26, fontWeight: 600, color: uiDisplayColor(T, m.c), letterSpacing: '-0.02em', marginTop: 10, lineHeight: 1 }}>{m.v}</div>
            <div style={{ fontSize: 11, color: T.textFaint, marginTop: 8 }}>{m.sub}</div>
          </div>
        ))}
      </div>

      <div {...porFaixa({ display: 'grid', gap: 16 }, { gridTemplateColumns: { largo: '1fr 1fr', compacto: '1fr' } })}>
        <Card title="Movimento da linha" sub={`${contagem(movBets.length, 'aposta')} com abertura e fechamento`}
          right={<><Cap>média</Cap><div style={{ ...numFont, fontSize: 18, fontWeight: 600, color: movMean == null ? T.textFaint : T.text, marginTop: 4 }}>{movMean == null ? '—' : fmtPct(movMean)}</div></>}>
          <Histo bins={movBins} />
        </Card>

        <Card title="Batendo o fechamento" sub={`${clvBets.length} de ${contagem(bets.length, 'aposta')} com odds de fechamento`}
          right={<><Cap>CLV médio</Cap><div style={{ ...numFont, fontSize: 18, fontWeight: 600, color: clvMean == null ? T.textFaint : ink(clvMean), marginTop: 4 }}>{clvMean == null ? '—' : fmtPct(clvMean)}</div></>}>
          {clvBets.map((b, i) => {
            return (
              <div key={b.id} style={{ padding: '7px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {b.home} <span style={{ color: T.textFaint, fontWeight: 400 }}>vs</span> {b.away}</div>
                  <div style={{ ...numFont, fontSize: 12.5, color: T.textMuted }}>
                    {fmtOdds(b.odds)} <span style={{ color: T.textFaint }}>→</span> {fmtOdds(b.d.close)}</div>
                  <div style={{ ...numFont, width: 56, textAlign: 'right', fontSize: 13, fontWeight: 600, color: ink(b.clv) }}>{fmtPct(b.clv)}</div>
                </div>
                <div style={{ display: 'flex' }}>
                  <TrilhoComSinal geom={escalaClv.barras[i]!} centrada={escalaClv.centrada} reguaPct={escalaClv.reguaPct} cor={ink(b.clv)} altura={6} raio={3} /></div>
              </div>
            );
          })}
          <LegendaDaRegua referencia={reguaClv} reguaPct={escalaClv.reguaPct} />
        </Card>

        <Card title="Por faixa de odds" sub={`distribuição das ${contagem(bets.length, 'aposta')}`}>
          {oddsBins.map((b) => (
            <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '5px 0' }}>
              <div style={{ ...numFont, width: 92, flexShrink: 0, fontSize: 12.5, color: T.textMuted }}>{b.label}</div>
              <div style={{ flex: 1, height: 8, background: T.inset, borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${b.n / oddsMax * 100}%`, height: '100%', background: T.brandAccent || T.accent, borderRadius: 4 }} /></div>
              <div style={{ ...numFont, width: 20, flexShrink: 0, textAlign: 'right', fontSize: 12.5, fontWeight: 600, color: T.text }}>{b.n}</div>
            </div>
          ))}
        </Card>

        <Card title="Movimento de linha" sub={mvTotal ? `${mvTotal} fechamento${mvTotal === 1 ? '' : 's'} ${mvTotal === 1 ? 'confiável' : 'confiáveis'}` : 'sem fechamento confiável no período'}>
          <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden' }}>
            {mvParts.map((p, i) => p.n > 0 && <div key={i} style={{ width: `${p.n / mvScale * 100}%`, height: '100%', background: p.color }} />)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
            {mvParts.map((p, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: p.color, flexShrink: 0 }} />
                {/* O rótulo carrega a definição e por isso hospeda o sublinhado —
                    que precisa ter a largura do TEXTO, não da linha inteira. O
                    empurrão para a direita fica com o espaçador ao lado. */}
                <MetricaComDefinicao metrica={p.metrica}>
                  <span style={{ fontSize: 12.5, color: T.textMuted }}>{p.label}</span>
                </MetricaComDefinicao>
                <span style={{ flex: 1 }} />
                <span style={{ ...numFont, fontSize: 12.5, fontWeight: 600, color: T.text }}>{p.n}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Por país" sub="ranking por volume · CLV médio à direita">
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginBottom: 4 }}>
            <Cap style={{ width: 18, textAlign: 'right' }}>n</Cap><Cap style={{ width: 58, textAlign: 'right' }}>CLV</Cap>
          </div>
          {byRegion.map((r) => <BarRow key={r.k} label={r.k} n={r.n} max={regionMax} right={r.clvMean} />)}
        </Card>

        <Card title="Por seleção / linha" sub="distribuição das seleções de todos os mercados">
          {byLine.map((r) => (
            <div key={r.k} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '5px 0' }}>
              <div style={{ width: 92, flexShrink: 0, fontSize: 12.5, color: T.textMuted }}>{r.k}</div>
              <div style={{ flex: 1, height: 8, background: T.inset, borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${r.n / lineMax * 100}%`, height: '100%', background: T.brandAccent || T.accent, borderRadius: 4 }} /></div>
              <div style={{ ...numFont, width: 20, flexShrink: 0, textAlign: 'right', fontSize: 12.5, fontWeight: 600, color: T.text }}>{r.n}</div>
            </div>
          ))}
        </Card>
      </div>

      <div style={{ fontSize: 11.5, color: T.textFaint, marginTop: 16, textAlign: 'center' }}>
        Amostra do período filtrado · {contagem(bets.length, 'aposta')} · {resultCounts}. Métricas de resultado ganham robustez com mais volume.
      </div>
    </div>
  );
}
