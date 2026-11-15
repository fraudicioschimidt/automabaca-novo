import { uiDisplayColor } from "../../utils";
import { contagem, plural } from "../../lib/plural";
import { MetricaComDefinicao } from "../../kit/MetricaComDefinicao";
import { useDesign } from "../../kit/context";
import { Cap, Panel } from "../../kit/primitives";
import { porFaixa } from "../../kit/faixas";
import { fmtBrl, fmtPct } from "@/src/domain/formato-de-resultado";

/** Os agregados de todas as bancas que a tira lê. */
type DashboardTotals = {
  lucro: number;
  staked: number;
  roi: number;
  hasRoi: boolean;
  clv: number;
  hasClv: boolean;
  clvSamples: number;
  open: number;
  nTot: number;
};
type Kpi = {
  k: string;
  metrica: string;
  n: number;
  fmt: (n: number) => string;
  c: string;
  sub: string;
  available?: boolean;
  semDado?: string;
};

/**
 * Cada KPI carrega o número, a DEFINIÇÃO (no rótulo, via tooltip) e a AMOSTRA
 * sobre a qual foi calculado: "CLV médio +11,66%" sobre 83 apostas e sobre 4
 * são afirmações diferentes. Sem a métrica, o "—" diz por quê.
 */
export function DashboardKpis({ A }: { A: DashboardTotals }) {
  const { T, numFont, ink } = useDesign();
  const amostra = (n: number, oQue: string) => n > 0 ? `${contagem(n, 'aposta')} com ${oQue}` : null;

  const kpis: Kpi[] = [
    {
      k: 'Lucro total', metrica: 'lucro', n: A.lucro, fmt: (n) => fmtBrl(n, true), c: ink(A.lucro),
      sub: `${fmtBrl(A.staked)} movimentados`,
    },
    {
      k: 'ROI', metrica: 'roi', n: A.roi, fmt: fmtPct, c: ink(A.roi), available: A.hasRoi,
      sub: 'lucro ÷ stake',
      semDado: 'nenhuma aposta liquidada ainda',
    },
    {
      k: 'CLV médio', metrica: 'clv', n: A.clv, fmt: fmtPct, c: ink(A.clv), available: A.hasClv,
      sub: amostra(A.clvSamples, 'fechamento') ?? 'média dos fechamentos',
      semDado: 'nenhum fechamento confiável ainda — entrada ao vivo e mercado sem linha não contam',
    },
    {
      k: 'Apostas em aberto', metrica: 'tipsEmAberto', n: A.open, fmt: (x: number) => String(Math.round(x)), c: T.accent,
      sub: `${contagem(A.nTot, 'aposta')} ${plural(A.nTot, 'total', 'totais')}`,
    },
  ];

  return (
    <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: 'repeat(4,1fr)', medio: 'repeat(2,1fr)' } })}>
      {kpis.map((m) => {
        const indisponivel = m.available === false;
        const formatted = indisponivel ? "—" : m.fmt(m.n);
        return (
          <Panel key={m.k} pad={20} style={{ containerType: "inline-size" }}>
            <div style={{ marginBottom: 12 }}>
              <MetricaComDefinicao metrica={m.metrica}>
                <Cap>{m.k}</Cap>
              </MetricaComDefinicao>
            </div>
            <div style={{ ...numFont, fontFamily: T.font.num, fontSize: `clamp(24px, calc(100cqi / ${(formatted.length * 0.6).toFixed(2)}), 27px)`, overflowWrap: "anywhere", fontWeight: 600, color: uiDisplayColor(T, indisponivel ? T.textFaint : m.c), letterSpacing: '-0.02em', lineHeight: 1 }}>
              {formatted}
            </div>
            <div style={{ fontFamily: T.font.body, fontSize: 11, color: T.textFaint, marginTop: 9 }}>
              {indisponivel ? (m.semDado ?? m.sub) : m.sub}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
