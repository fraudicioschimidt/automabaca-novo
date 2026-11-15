import { getPeriodHighlights } from "../../lib/analyzer-view";
import { AreaChart, MonthlyChart } from "./charts/linha-do-tempo";
import { RCChart } from "./charts/distribuicao";
import { DataTable } from "./tables";
import { contagem } from "../../lib/plural";
import { recorteDaLinha } from "../../lib/recorte-de-apostas";
import { aindaSeMove, emCursoDaLinha, textoDeEmCurso } from "../../lib/balde-em-curso";
import { uiDisplayColor } from "../../utils";
import { useDesign } from "../../kit/context";
import { LARGURA_INICIAL } from "../../lib/responsive-chart";
import { porFaixa } from "../../kit/faixas";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import { Cap } from "../../kit/primitives";
import { fmtPct, fmtRate } from "@/src/domain/formato-de-resultado";
import type { AnaliseDoRecorte, PropsDaAba } from "./use-analise-do-recorte";

export function PeriodoTab({ periodCard, P, emCursoAtual, abrirRecorte }:
  Pick<PropsDaAba, 'periodCard' | 'emCursoAtual' | 'abrirRecorte'>
  & { P: NonNullable<AnaliseDoRecorte["P"]> }) {
  const { T, numFont, ink } = useDesign();
  const money = useMoneyFormat();
  const bruto = getPeriodHighlights(P);
  const { bestMonth, worstMonth, lastWeek, bestWeek } = bruto;
  // A linha carrega a PRÓPRIA pendência: mês/semana que ainda vai ganhar e
  // perder membros não pode se desenhar igual a um que fechou.
  const monthly = bruto.monthly.map((m) => ({ ...m, emCurso: emCursoDaLinha(m) }));
  const weekly = bruto.weekly.map((w) => ({ ...w, emCurso: emCursoDaLinha(w) }));
  const monthSub = (row: (typeof bruto.monthly)[number] | null) => row ? `${money.signed(row.lucro)} · ${row.roi == null ? 'ROI —' : `${fmtPct(row.roi)} ROI`}` : 'Sem apostas no recorte';

  return (
    <div>
      {periodCard}
      <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: 'repeat(4,1fr)', compacto: 'repeat(2,minmax(0,1fr))' } })}>
        {[{ k: 'Lucro acumulado', v: money.signed(P.lucro), c: ink(P.lucro), sub: `${monthly.length} ${monthly.length === 1 ? 'mês' : 'meses'} no recorte` },
          { k: 'Melhor mês', v: bestMonth?.label || '—', c: bestMonth ? ink(bestMonth.lucro) : T.textFaint, sub: monthSub(bestMonth), serif: true },
          { k: 'Pior mês', v: worstMonth?.label || '—', c: worstMonth ? ink(worstMonth.lucro) : T.textFaint, sub: monthSub(worstMonth), serif: true },
          { k: 'Última semana', v: lastWeek?.l || '—', c: T.text, sub: lastWeek ? `${lastWeek.roi == null ? 'ROI —' : `${fmtPct(lastWeek.roi)} ROI`} · ${lastWeek.clv == null ? 'CLV —' : `${fmtPct(lastWeek.clv)} CLV`}` : 'Sem apostas no recorte', serif: true }].map((m) => (
          <AnalyzerCard key={m.k} pad={20}>
            <Cap style={{ marginBottom: 12 }}>{m.k}</Cap>
            <div style={{ ...numFont, fontFamily: m.serif ? T.font.display : T.font.num, fontSize: 26, fontWeight: 600, color: uiDisplayColor(T, m.c), letterSpacing: '-0.02em', lineHeight: 1 }}>{m.v}</div>
            <div style={{ fontSize: 11, color: T.textFaint, marginTop: 9 }}>{m.sub}</div>
          </AnalyzerCard>
        ))}
      </div>
      <AnalyzerCard title="Evolução mensal" sub="Barras: lucro do mês. Ponto: ROI do mês." style={{ marginBottom: 22 }}>
        <MonthlyChart data={monthly} />
      </AnalyzerCard>
      <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: '1fr 1fr', compacto: '1fr' } })}>
        <AnalyzerCard title="Últimas semanas" sub="Barras: ROI semanal. Linha: CLV médio da semana."><RCChart rows={weekly} larguraInicial={LARGURA_INICIAL.metade} H={210} /></AnalyzerCard>
        <AnalyzerCard title="Lucro diário acumulado" sub="Bom para ler ritmo, sequência e volatilidade."><AreaChart pts={P.daily} color={P.lucro < 0 ? T.chartLine : T.pos} H={210} larguraInicial={LARGURA_INICIAL.metade} emCurso={emCursoAtual} /></AnalyzerCard>
      </div>
      <AnalyzerCard title="Tabela mensal" style={{ marginBottom: 22 }}>
        <DataTable cols={[{ h: 'Período', a: 'left', w: '1.4fr', bold: true, fmt: (r) => r.label },
          { h: 'Apostas', fmt: (r) => r.n },
          { h: 'Em aberto', color: (r) => aindaSeMove(r.emCurso) ? T.textMuted : T.textFaint,
            fmt: (r) => aindaSeMove(r.emCurso) ? r.emCurso.pendentes : '—' }, { h: 'Stake', color: () => T.textMuted, fmt: (r) => money.amount(r.stake) },
          { h: 'Lucro', bold: true, color: (r) => ink(r.lucro), fmt: (r) => money.signed(r.lucro) },
          { h: 'ROI', bold: true, color: (r) => r.roi == null ? T.textFaint : ink(r.roi), fmt: (r) => r.roi == null ? '—' : fmtPct(r.roi) },
          { h: 'Acerto', color: (r) => r.acerto == null ? T.textFaint : T.text, fmt: (r) => fmtRate(r.acerto) },
          { h: 'CLV', bold: true, color: (r) => r.clv == null ? T.textFaint : ink(r.clv), fmt: (r) => r.clv == null ? '—' : fmtPct(r.clv) },
          { h: 'Acumulado', bold: true, color: (r) => ink(r.cum), fmt: (r) => money.signed(r.cum) }]} rows={monthly}
          aoAbrir={(r) => abrirRecorte(recorteDaLinha(r, { money, contexto: aindaSeMove(r.emCurso) ? `${r.label} · ${contagem(r.membros.length, 'aposta')} · ${textoDeEmCurso(r.emCurso)}` : `Liquidadas em ${r.label} · ${contagem(r.membros.length, 'aposta')}` }))} />
      </AnalyzerCard>
      <AnalyzerCard title="Melhor semana do recorte" sub="Semana com melhor ROI entre as últimas.">
        <div {...porFaixa({ display: 'grid', gap: 16 }, { gridTemplateColumns: { largo: 'repeat(4,1fr)', compacto: 'repeat(2,minmax(0,1fr))' } })}>
          {[['Semana', bestWeek?.l || '—', T.accent], ['ROI', bestWeek?.roi == null ? '—' : fmtPct(bestWeek.roi), bestWeek?.roi == null ? T.textFaint : ink(bestWeek.roi)], ['CLV', bestWeek?.clv == null ? '—' : fmtPct(bestWeek.clv), bestWeek?.clv == null ? T.textFaint : ink(bestWeek.clv)], ['Lucro', bestWeek ? money.signed(bestWeek.lucro) : '—', bestWeek ? ink(bestWeek.lucro) : T.textFaint]].map(([l, v, c]) => (
            <div key={l}><Cap style={{ marginBottom: 8 }}>{l}</Cap><div style={{ ...numFont, fontSize: 22, fontWeight: 600, color: c, letterSpacing: '-0.02em' }}>{v}</div></div>
          ))}
        </div>
      </AnalyzerCard>
    </div>
  );
}
