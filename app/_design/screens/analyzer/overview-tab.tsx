import { uiDisplayColor } from "../../utils";
import { percentOf } from "../../lib/analyzer-view";
import { textoDeCobertura } from "../../lib/cobertura-na-tela";
import { AreaChart, MonthlyChart } from "./charts/linha-do-tempo";
import { ResultCard } from "./shared";
import { OndeOClvSePerde } from "./onde-o-clv-se-perde";
import { KpiGrid, type KpiItem } from "./kpi-grid";
import { contagem, plural } from "../../lib/plural";
import { emCursoDaLinha } from "../../lib/balde-em-curso";
import { ICONS } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import { Cap } from "../../kit/primitives";
import { fmtOdds, fmtPct, fmtPp, fmtRate } from "@/src/domain/formato-de-resultado";
import type { AnaliseDoRecorte, PropsDaAba } from "./use-analise-do-recorte";

export function OverviewTab({ periodCard, D, anterior, emCursoAtual, abrirRecorte }:
  Pick<PropsDaAba, 'periodCard' | 'anterior' | 'emCursoAtual' | 'abrirRecorte'>
  & { D: NonNullable<AnaliseDoRecorte["D"]> }) {
  const { T, numFont, ink } = useDesign();
  const money = useMoneyFormat();
  const A = anterior?.D;
  const kpis: KpiItem[] = [
    { k: 'Lucro total', icon: ICONS.lucro, v: money.signed(D.lucro), c: ink(D.lucro), sub: `${D.settled.length} ${plural(D.settled.length, 'resolvida')} · ${D.pendingBets} ${plural(D.pendingBets, 'pendente')}`, atual: D.lucro, antes: A?.lucro, baseAtual: D.settled.length, baseAnterior: A?.settled.length ?? 0, formato: 'money' },
    { k: 'ROI', icon: ICONS.bars, v: D.roi == null ? '—' : fmtPct(D.roi), c: D.roi == null ? T.textFaint : ink(D.roi), sub: D.roi == null ? 'sem apostas resolvidas' : `sobre ${money.amount(D.stakeSettled)} movimentados`, atual: D.roi, antes: A?.roi, baseAtual: D.settled.length, baseAnterior: A?.settled.length ?? 0 },
    // A cobertura sai de `clvCobertura`, não de uma divisão escrita aqui: a base
    // exclui o que o CLV não alcança (ao vivo, pendente); dividir por FB.length
    // faria banca 100% coberta parecer mediana. Ver `lib/cobertura-na-tela`.
    // A cobertura aparece MESMO sem média: na banca com zero CLV, dizer quantas
    // apostas ficaram sem medição é o caso em que o número mais importa.
    { k: 'CLV médio', icon: ICONS.clv, v: D.clvMean == null ? '—' : fmtPct(D.clvMean), c: D.clvMean == null ? T.textFaint : ink(D.clvMean), sub: D.clvMean == null ? `sem fechamento confiável · cobertura ${textoDeCobertura(D.clvCobertura)}` : `${percentOf(D.clvPlus, D.clvBets.length)}% com CLV+ · cobertura ${textoDeCobertura(D.clvCobertura)}`, atual: D.clvMean, antes: A?.clvMean, baseAtual: D.clvBets.length, baseAnterior: A?.clvBets.length ?? 0 },
  ];
  const realized = D.realizedRoiClv;
  const expected = D.expectedRoi;
  const gap = D.roiClvGap;
  const clvN = D.realizedRoiClvN ?? 0;

  return (
    <div>
      {periodCard}
      <KpiGrid itens={kpis} numero={30} anterior={anterior} emCursoAtual={emCursoAtual} />
      {/* Logo abaixo dos KPIs: quem acabou de ler "cobertura 70%" quer saber o
          que falta. Some sozinho quando não há lacuna. */}
      <OndeOClvSePerde cobertura={D.clvCobertura} abrirRecorte={abrirRecorte} />
      <AnalyzerCard title="Curva de lucro acumulado" sub={`${contagem(D.settled.length, 'aposta')} ${plural(D.settled.length, 'resolvida')} · Max drawdown ${money.signed(D.maxDD)}`} style={{ marginBottom: 22 }}>
        <AreaChart pts={D.equity} color={D.lucro < 0 ? T.chartLine : T.pos} emCurso={emCursoAtual} />
      </AnalyzerCard>
      <AnalyzerCard title="Drawdown" sub="Quanto você está abaixo do pico de lucro — mede a dor da variância." style={{ marginBottom: 22 }}>
        <AreaChart pts={D.dd} color={T.chartLine} H={210} />
      </AnalyzerCard>
      <AnalyzerCard title="Lucro mensal" sub={`Barras: lucro em ${money.unitName}. Ponto: ROI do mês.`} style={{ marginBottom: 22 }}>
        <MonthlyChart data={D.monthly.map((m) => ({ ...m, emCurso: emCursoDaLinha(m) }))} />
      </AnalyzerCard>
      <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: '1fr 1fr', compacto: '1fr' } })}>
        <AnalyzerCard title="ROI realizado vs referência do CLV" sub="Compara o ROI real com uma referência ponderada pela stake, usando a fair de fechamento. Não é previsão de lucro.">
          <div {...porFaixa({ display: 'grid', gap: 16 }, { gridTemplateColumns: { largo: '1fr 1fr 1fr', compacto: '1fr' } })}>
            {([['ROI real', realized == null ? '—' : fmtPct(realized), realized == null ? T.textFaint : ink(realized), realized == null ? 'sem resolvidas com CLV' : `${clvN} ${plural(clvN, 'resolvida')} com CLV`], ['ROI de referência (CLV ponderado)', expected == null ? '—' : fmtPct(expected), expected == null ? T.textFaint : ink(expected), expected == null ? '' : 'mesma amostra'],
              ['Gap (mesma amostra)', gap == null ? '—' : fmtPp(gap), gap == null ? T.textFaint : ink(gap), gap == null ? 'sem amostra comum suficiente' : gap < 0 ? 'abaixo da referência' : 'acima da referência']] satisfies Array<[string, string, string, string]>).map(([l, v, c, h]) => (
              <div key={l}>
                <Cap style={{ fontSize: 9.5, marginBottom: 8 }}>{l}</Cap>
                <div style={{ ...numFont, fontSize: 22, fontWeight: 600, color: c, letterSpacing: '-0.02em' }}>{v}</div>
                {h && <div style={{ fontSize: 10.5, color: T.textFaint, marginTop: 6, lineHeight: 1.4 }}>{h}</div>}
              </div>
            ))}
          </div>
          <div style={{ borderTop: `1px solid ${T.borderSoft}`, marginTop: 16, paddingTop: 14, fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
            A comparação usa somente resolvidas com CLV confiável e pondera a referência pela stake. A diferença, sozinha, não prova sorte ou erro de decisão.</div>
        </AnalyzerCard>
        <AnalyzerCard title="Sequências e qualidade de decisão" sub="Sequências e taxa de acerto em apostas resolvidas.">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
            {([['Maior seq. ganhos', String(D.mw), T.pos], ['Maior seq. perdas', String(D.ml), T.neg],
              ['Acerto', fmtRate(D.acerto), D.acerto == null ? T.textFaint : T.text, D.acerto == null ? 'sem ganhos ou perdas' : `${D.win} G + ${D.halfWin} meia G / ${D.lose} P + ${D.halfLose} meia P`], ['Odd média', fmtOdds(D.oddMean), D.oddMean == null ? T.textFaint : T.text, D.stakeMean == null ? 'sem apostas resolvidas' : `stake média ${money.amount(D.stakeMean)}`]] satisfies Array<[string, string, string, string?]>).map(([l, v, c, h]) => (
              <div key={l}>
                <Cap style={{ fontSize: 9.5, marginBottom: 8 }}>{l}</Cap>
                <div style={{ ...numFont, fontSize: 24, fontWeight: 600, color: uiDisplayColor(T, c), letterSpacing: '-0.02em' }}>{v}</div>
                {h && <div style={{ fontSize: 10.5, color: T.textFaint, marginTop: 5 }}>{h}</div>}
              </div>
            ))}
          </div>
        </AnalyzerCard>
      </div>
      <div {...porFaixa({ display: 'grid', gap: 16 }, { gridTemplateColumns: { largo: '1fr 1fr', compacto: '1fr' } })}>
        <ResultCard icon={ICONS.cup} title="Melhor resultado" bet={D.best} color={ink(D.best ? D.best.profit : 0)} />
        <ResultCard icon={ICONS.trendDown} title="Pior resultado" bet={D.worst} color={ink(D.worst ? D.worst.profit : 0)} />
      </div>
    </div>
  );
}
