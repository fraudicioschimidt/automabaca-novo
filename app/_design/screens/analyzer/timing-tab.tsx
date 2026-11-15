import { Heatmap, RCChart, VBars } from "./charts/distribuicao";
import { DataTable } from "./tables";
import { contagem } from "../../lib/plural";
import { recorteDaCelula, recorteDaLinha } from "../../lib/recorte-de-apostas";
import { KpiGrid, type KpiItem } from "./kpi-grid";
import { ICONS } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import { fmtPct, fmtRate } from "@/src/domain/formato-de-resultado";
import { formatDurationMinutes } from "@/src/domain/dates";
import type { AnaliseDoRecorte, PropsDaAba } from "./use-analise-do-recorte";

/**
 * Antecedência pelo instante gravado da entrada. Atraso não prova bola rolando:
 * o painel também aceita lançamento manual retrospectivo.
 */
export function formatLeadTime(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours)) return '—';
  if (hours >= 0) return formatDurationMinutes(hours * 60);
  const late = formatDurationMinutes(-hours * 60);
  return late === '<1 min' ? '<1 min (após início)' : `-${late} (após início)`;
}

export function TimingTab({ periodCard, Z, FB, abrirRecorte }:
  Pick<PropsDaAba, 'periodCard' | 'FB' | 'abrirRecorte'>
  & { Z: NonNullable<AnaliseDoRecorte["Z"]> }) {
  const { T, ink } = useDesign();
  const money = useMoneyFormat();
  const timingKpis: KpiItem[] = [
    { k: 'Antecedência média', icon: ICONS.clv, v: formatLeadTime(Z.leadMean), c: Z.leadMean == null ? T.textFaint : T.text, sub: Z.leadN === FB.length ? `${FB.length} aposta${FB.length === 1 ? '' : 's'} no recorte` : `${Z.leadN} de ${FB.length} com antecedência válida` },
    { k: 'Melhor janela (ROI+CLV)', icon: ICONS.cup, v: Z.bestW ? Z.bestW.l : '—', c: T.pos, sub: Z.bestW ? `${fmtPct(Z.bestW.roi)} ROI · ${fmtPct(Z.bestW.clv)} CLV` : '' },
    { k: 'Pior janela', icon: ICONS.warn, v: Z.worstW ? Z.worstW.l : '—', c: T.neg, sub: Z.worstW ? `${fmtPct(Z.worstW.roi)} ROI · ${fmtPct(Z.worstW.clv)} CLV` : '' },
    { k: 'Janelas ativas', icon: ICONS.bars, v: String(Z.activeW), c: T.text, sub: 'com pelo menos 1 aposta' },
  ];

  return (
    <div>
      {periodCard}
      {/* Sem `anterior`: as quatro medidas aqui são de JANELA, não de desempenho
          — comparar "melhor janela" com a de ontem não diz nada. */}
      <KpiGrid itens={timingKpis} numero={26} legenda={11} />
      <AnalyzerCard title="ROI × CLV por antecedência" sub="Barras: ROI real. Linha: CLV médio. Procure janelas onde ambos estão altos — é a sua faixa ideal." style={{ marginBottom: 22 }}>
        <RCChart rows={Z.tRows} />
      </AnalyzerCard>
      <AnalyzerCard title="Volume por antecedência" sub="Quantas apostas você coloca em cada janela. Compare com o ROI para ver se aloca direito." style={{ marginBottom: 22 }}>
        <VBars bins={Z.tRows.map((r) => ({ l: r.l, n: r.n, color: T.chartClv }))} H={210} />
      </AnalyzerCard>
      <AnalyzerCard title="Mapa de calor — dia da semana × hora da entrada" sub="ROI pelo instante da entrada: post ou edição que completou a aposta; se faltava odd ou stake, a correção. No painel, vale o registro. Vermelho → verde = pior → melhor." style={{ marginBottom: 22 }}>
        <Heatmap Z={Z}
          aoAbrirCelula={(c, rotulo) => abrirRecorte(recorteDaCelula(c, { money, rotulo, contexto: `Janela da entrada · ${contagem(c.membros.length, 'aposta')}` }))} />
      </AnalyzerCard>
      <AnalyzerCard title="Tabela completa por antecedência">
        <DataTable cols={[{ h: 'Janela', a: 'left', w: '1.2fr', bold: true, fmt: (r) => r.l },
          { h: 'Apostas', fmt: (r) => r.n }, { h: 'Stake', color: () => T.textMuted, fmt: (r) => money.amount(r.stake) },
          { h: 'Lucro', bold: true, color: (r) => r.lucro == null ? T.textFaint : ink(r.lucro), fmt: (r) => r.lucro == null ? '—' : money.signed(r.lucro) },
          { h: 'ROI', bold: true, color: (r) => r.roi == null ? T.textFaint : ink(r.roi), fmt: (r) => r.roi == null ? '—' : fmtPct(r.roi) },
          { h: 'CLV médio', bold: true, color: (r) => r.clv == null ? T.textFaint : ink(r.clv), fmt: (r) => r.clv == null ? '—' : fmtPct(r.clv) },
          { h: '% CLV+', color: () => T.textMuted, fmt: (r) => r.clvPct == null ? '—' : Math.round(r.clvPct) + '%' },
          { h: 'Acerto', color: () => T.text, fmt: (r) => fmtRate(r.acerto) }]} rows={Z.tRows}
          aoAbrir={(r) => abrirRecorte(recorteDaLinha(r, { money, contexto: `Antecedência ${r.l} · ${contagem(r.membros.length, 'aposta')}` }))} />
      </AnalyzerCard>
    </div>
  );
}
