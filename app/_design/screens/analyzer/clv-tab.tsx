import { uiDisplayColor } from "../../utils";
import { VBars } from "./charts/distribuicao";
import { contagem, plural } from "../../lib/plural";
import { recorteDaLinha } from "../../lib/recorte-de-apostas";
import { DataTable } from "./tables";
import { KpiGrid, type KpiItem } from "./kpi-grid";
import { ICONS } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import { Cap } from "../../kit/primitives";
import { fmtPct, fmtRate } from "@/src/domain/formato-de-resultado";
import type { AnaliseDoRecorte, LinhaAgregada, PropsDaAba } from "./use-analise-do-recorte";

/** Aba de CLV. */
export function ClvTab({ periodCard, E, anterior, emCursoAtual, abrirRecorte }:
  Pick<PropsDaAba, 'periodCard' | 'anterior' | 'emCursoAtual'>
  & Partial<Pick<PropsDaAba, 'abrirRecorte'>>
  & { E: NonNullable<AnaliseDoRecorte["E"]> }) {
  const { T, numFont, ink } = useDesign();
  const money = useMoneyFormat();
  const abrirFaixa = (contexto: string) => (r: LinhaAgregada) => abrirRecorte?.(recorteDaLinha(r, { money, contexto: `${contexto} ${r.l} · ${contagem(r.membros.length, 'aposta')}` }));
  const A = anterior?.E;
  const clvKpis: KpiItem[] = [
    { k: 'CLV médio', icon: ICONS.clv, v: E.clvMean == null ? '—' : fmtPct(E.clvMean), c: E.clvMean == null ? T.textFaint : ink(E.clvMean), sub: E.clvMedian == null ? 'sem fechamento confiável' : `mediana ${fmtPct(E.clvMedian)}`, atual: E.clvMean, antes: A?.clvMean, baseAtual: E.clvB.length, baseAnterior: A?.clvB.length ?? 0 },
    { k: '% CLV positivo', icon: ICONS.clv, v: E.clvB.length ? Math.round(E.clvPos / E.clvB.length * 100) + '%' : '—', c: E.clvB.length ? T.pos : T.textFaint, sub: E.clvB.length ? `${contagem(E.clvB.length, 'aposta')} com CLV` : 'sem fechamento confiável', atual: E.clvB.length ? E.clvPos / E.clvB.length * 100 : null, antes: A?.clvB.length ? A.clvPos / A.clvB.length * 100 : null, baseAtual: E.clvB.length, baseAnterior: A?.clvB.length ?? 0 },
  ];

  return (
    <div>
      {periodCard}
      <KpiGrid itens={clvKpis} numero={28} anterior={anterior} emCursoAtual={emCursoAtual} />
      <AnalyzerCard title="Lucro de referência pelo CLV vs realizado" sub="Referência: soma stake × CLV. Devoluções e meias decisões alteram o lucro esperado; esta conta não modela esses pagamentos nem prevê lucro." style={{ marginBottom: 22 }}>
        <div {...porFaixa({ display: 'grid', gap: 16 }, { gridTemplateColumns: { largo: 'repeat(3,1fr)', compacto: '1fr' } })}>
          {([['Lucro de referência', E.expectedSampleN ? money.signed(E.expProfit) : '—', E.expectedSampleN ? ink(E.expProfit) : T.textFaint, E.expectedSampleN ? 'Σ stake × (CLV/100)' : 'sem resolvidas com CLV confiável'],
            ['Lucro realizado', E.expectedSampleN ? money.signed(E.realProfit) : '—', E.expectedSampleN ? ink(E.realProfit) : T.textFaint, E.expectedSampleN ? `${E.expectedSampleN} ${plural(E.expectedSampleN, 'resolvida')} na mesma amostra` : 'sem amostra comparável'],
            ['Desvio real − referência', E.expectedSampleN ? money.signed(E.realProfit - E.expProfit) : '—', E.expectedSampleN ? ink(E.realProfit - E.expProfit) : T.textFaint, E.expectedSampleN ? (E.realProfit - E.expProfit) < 0 ? 'realizado abaixo da referência' : 'realizado acima da referência' : 'sem amostra comparável']] satisfies Array<[string, string, string, string]>).map(([l, v, c, h]) => (
            <div key={l}><Cap style={{ fontSize: 9.5, marginBottom: 8 }}>{l}</Cap>
              <div style={{ ...numFont, fontSize: 24, fontWeight: 600, color: uiDisplayColor(T, c), letterSpacing: '-0.02em' }}>{v}</div>
              <div style={{ fontSize: 10.5, color: T.textFaint, marginTop: 6 }}>{h}</div></div>
          ))}
        </div>
      </AnalyzerCard>
      <AnalyzerCard title="Distribuição CLV" sub="Em que faixa a maioria das apostas está caindo?" style={{ marginBottom: 22 }}>
        <VBars bins={E.clvDist} />
      </AnalyzerCard>
      <AnalyzerCard title="Desempenho por faixa de CLV realizado" sub="Se tem CLV+ você tende a lucrar; CLV− você queima.">
        <DataTable
          cols={[
            { h: 'Faixa CLV', a: 'left', w: '1.4fr', bold: true, fmt: (r) => r.l },
            { h: 'Apostas', fmt: (r) => r.n },
            { h: 'Stake', color: () => T.textMuted, fmt: (r) => money.amount(r.stake) },
            { h: 'Lucro', bold: true, color: (r) => r.lucro == null ? T.textFaint : ink(r.lucro), fmt: (r) => r.lucro == null ? '—' : money.signed(r.lucro) },
            { h: 'ROI', bold: true, color: (r) => r.roi == null ? T.textFaint : ink(r.roi), fmt: (r) => r.roi == null ? '—' : fmtPct(r.roi) },
            { h: 'Acerto', color: (r) => r.acerto == null ? T.textFaint : T.text, fmt: (r) => fmtRate(r.acerto) },
          ]}
          rows={E.clvPerf}
          aoAbrir={abrirRecorte ? abrirFaixa('Faixa CLV') : undefined} />
      </AnalyzerCard>
    </div>
  );
}
