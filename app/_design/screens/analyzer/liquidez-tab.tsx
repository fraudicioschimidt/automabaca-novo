import { DEFINICOES } from "../../lib/definicoes-de-metrica";
import { textoDeCobertura } from "../../lib/cobertura-na-tela";
import { RCChart } from "./charts/distribuicao";
import { PerfTable } from "./tables";
import { contagem } from "../../lib/plural";
import { recorteDaLinha } from "../../lib/recorte-de-apostas";
import { ClsCard, type LinhaDaClassificacao } from "./shared";
import { KpiGrid, type KpiItem } from "./kpi-grid";
import { ICONS } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { LARGURA_INICIAL } from "../../lib/responsive-chart";
import { porFaixa } from "../../kit/faixas";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import { fmtPct } from "@/src/domain/formato-de-resultado";
import type { AnaliseDoRecorte, LinhaAgregada, PropsDaAba } from "./use-analise-do-recorte";

export function LiquidezTab({ periodCard, Z, abrirRecorte }:
  Pick<PropsDaAba, 'periodCard' | 'abrirRecorte'>
  & { Z: NonNullable<AnaliseDoRecorte["Z"]> }) {
  const { T } = useDesign();
  const money = useMoneyFormat();
  const abrir = (contexto: string) => (r: LinhaAgregada) => abrirRecorte(recorteDaLinha(r, { money, contexto: `${contexto} ${r.l} · ${contagem(r.membros.length, 'aposta')}` }));
  const abrirCls = (rotulo: string) => (r: LinhaDaClassificacao) => abrirRecorte(recorteDaLinha(r, { money, rotulo, contexto: `${rotulo} · ${contagem(r.membros.length, 'aposta')}` }));
  // Únicos KPIs do Analyzer sem ícone — os itens não trazem `icon`.
  // Cobertura sobre a base que a liquidez alcança: aposta que a métrica não
  // alcança não conta como falha. Ver `cobertura-na-tela`.
  const liquidezKpis: KpiItem[] = [
    { k: 'Com liquidez no fechamento', v: String(Z.lqClosingN), c: T.text, sub: `cobertura ${textoDeCobertura(Z.liquidezCobertura)}` },
    { k: 'Liq. média abertura', v: Z.lqOpenMean == null ? '—' : '$' + Math.round(Z.lqOpenMean), c: Z.lqOpenMean == null ? T.textFaint : T.chartClv, sub: Z.lqOpenMean == null ? 'sem amostra de abertura' : `${Z.lqOpenN} amostra${Z.lqOpenN === 1 ? '' : 's'} Pinnacle` },
    { k: 'Liq. média no fechamento', v: Z.lqClosingMean == null ? '—' : '$' + Math.round(Z.lqClosingMean), c: Z.lqClosingMean == null ? T.textFaint : T.chartClv, sub: Z.lqClosingMean == null ? 'sem amostra de fechamento' : `${Z.lqClosingN} amostra${Z.lqClosingN === 1 ? '' : 's'} Pinnacle` },
    { k: 'Melhor faixa (ROI)', v: Z.lqBest ? Z.lqBest.l : '—', c: T.text, sub: Z.lqBest?.roi != null ? `ROI ${fmtPct(Z.lqBest.roi)}` : 'mínimo de 2 resolvidas' },
  ];

  return (
    <div>
      {periodCard}
      <AnalyzerCard title={DEFINICOES.liquidez.titulo} sub={DEFINICOES.liquidez.texto} style={{ marginBottom: 22 }} />
      <KpiGrid itens={liquidezKpis} numero={26} legenda={11} />
      <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: '1fr 1fr', compacto: '1fr' } })}>
        <AnalyzerCard title="ROI por liquidez de abertura" sub="Faixas pelo limite informado na abertura."><RCChart rows={Z.lqOpenRows} larguraInicial={LARGURA_INICIAL.metade} H={210} /></AnalyzerCard>
        <AnalyzerCard title="ROI por liquidez no fechamento" sub="Faixas pelo limite informado no fechamento."><RCChart rows={Z.lqClosingRows} larguraInicial={LARGURA_INICIAL.metade} H={210} /></AnalyzerCard>
      </div>
      <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: '1fr 1fr', compacto: '1fr' } })}>
        <AnalyzerCard title="Detalhamento — liquidez de abertura"><PerfTable rows={Z.lqOpenRows} firstHead="Faixa" aoAbrir={abrir('Liquidez de abertura')} /></AnalyzerCard>
        <AnalyzerCard title="Detalhamento — liquidez no fechamento"><PerfTable rows={Z.lqClosingRows} firstHead="Faixa" aoAbrir={abrir('Liquidez no fechamento')} /></AnalyzerCard>
      </div>
      <AnalyzerCard title="Variação do limite cotado" sub="Compara o limite informado na abertura com o do fechamento.">
        <div {...porFaixa({ display: 'grid', gap: 16 }, { gridTemplateColumns: { largo: 'repeat(3,1fr)', compacto: '1fr' } })}>
          <ClsCard icon={ICONS.lucro} color={T.pos} title="Crescendo" desc="Limite no fechamento pelo menos 15% acima da abertura." d={Z.cresc} aoAbrir={abrirCls('Crescendo')} />
          <ClsCard icon={ICONS.arrow} color={T.textMuted} title="Estável" desc="Limite variou menos de 15% entre abertura e fechamento." d={Z.estavel} aoAbrir={abrirCls('Estável')} />
          <ClsCard icon={ICONS.trendDown} color={T.neg} title="Secando" desc="Limite no fechamento pelo menos 15% abaixo da abertura." d={Z.secando} aoAbrir={abrirCls('Secando')} />
        </div>
      </AnalyzerCard>
    </div>
  );
}
