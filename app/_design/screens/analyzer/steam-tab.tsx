import { DEFINICOES } from "../../lib/definicoes-de-metrica";
import { textoDeCobertura } from "../../lib/cobertura-na-tela";
import { VBars } from "./charts/distribuicao";
import { PerfTable } from "./tables";
import { contagem } from "../../lib/plural";
import { recorteDaLinha } from "../../lib/recorte-de-apostas";
import { Arrow, ClsCard, type LinhaDaClassificacao } from "./shared";
import { KpiGrid, type KpiItem } from "./kpi-grid";
import { ICONS } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { LARGURA_INICIAL } from "../../lib/responsive-chart";
import { porFaixa } from "../../kit/faixas";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import { Cap } from "../../kit/primitives";
import { fmtOdds, fmtPct } from "@/src/domain/formato-de-resultado";
import type { AnaliseDoRecorte, LinhaAgregada, PropsDaAba } from "./use-analise-do-recorte";

export function SteamTab({ periodCard, S, anterior, emCursoAtual, abrirRecorte }:
  Pick<PropsDaAba, 'periodCard' | 'anterior' | 'emCursoAtual' | 'abrirRecorte'>
  & { S: NonNullable<AnaliseDoRecorte["S"]> }) {
  const { T, numFont, ink } = useDesign();
  const money = useMoneyFormat();
  const abrir = (contexto: string) => (r: LinhaAgregada) => abrirRecorte(recorteDaLinha(r, { money, contexto: `${contexto} ${r.l} · ${contagem(r.membros.length, 'aposta')}` }));
  const abrirCls = (rotulo: string) => (r: LinhaDaClassificacao) => abrirRecorte(recorteDaLinha(r, { money, rotulo, contexto: `${rotulo} · ${contagem(r.membros.length, 'aposta')}` }));
  // Só as duas Δ ganham régua: as outras duas são CONTAGENS de cobertura, e
  // comparar "12 com abertura" contra "9" mede volume, não desempenho.
  const A = anterior?.S;
  // Cada cobertura usa sua própria base; a tentativa de congelar um preço
  // rejeitado não o torna disponível para comparar a execução.
  const steamKpis: KpiItem[] = [
    { k: 'Apostas com abertura', icon: ICONS.bars, v: String(S.withOpen.length), c: T.text, sub: textoDeCobertura(S.aberturaCobertura), semRegua: true },
    { k: 'Apostas com fechamento', icon: ICONS.clv, v: String(S.withClose.length), c: T.text, sub: textoDeCobertura(S.fechamentoCobertura), semRegua: true },
    { k: 'Δ vs abertura bruta', icon: ICONS.rocket, v: S.meanOE == null ? '—' : fmtPct(S.meanOE), c: S.meanOE == null ? T.textFaint : ink(S.meanOE), sub: S.meanOE == null ? 'sem odd de abertura' : 'sua odd vs abertura bruta Pinnacle', atual: S.meanOE, antes: A?.meanOE, baseAtual: S.withOpen.length, baseAnterior: A?.withOpen.length ?? 0 },
    { k: 'Δ vs fechamento bruto', icon: ICONS.clv, v: S.meanEF == null ? '—' : fmtPct(S.meanEF), c: S.meanEF == null ? T.textFaint : ink(S.meanEF), sub: S.meanEF == null ? 'sem odd de fechamento final' : 'positivo = acima da odd bruta final', atual: S.meanEF, antes: A?.meanEF, baseAtual: S.withClose.length, baseAnterior: A?.withClose.length ?? 0 },
  ];

  return (
    <div>
      {periodCard}
      <AnalyzerCard title={DEFINICOES.priceComparison.titulo} sub={`${DEFINICOES.priceComparison.texto} ${DEFINICOES.priceComparison.formula}`} style={{ marginBottom: 22 }} />
      <KpiGrid itens={steamKpis} numero={28} anterior={anterior} emCursoAtual={emCursoAtual} />
      {/* A régua aqui é a SUA odd contra a abertura, não o movimento do mercado
          (abertura → fechamento, que a ficha e as Estatísticas chamam de steam). */}
      <AnalyzerCard title="Entrada contra a abertura" sub="Onde a sua odd ficou em relação à abertura bruta da Pinnacle." style={{ marginBottom: 22 }}>
        <div {...porFaixa({ display: 'grid', gap: 16 }, { gridTemplateColumns: { largo: 'repeat(3,1fr)', compacto: '1fr' } })}>
          <ClsCard icon={ICONS.rocket} color={T.pos} title="Acima da abertura" desc="Sua odd ficou 2% ou mais acima da abertura." d={S.steam} aoAbrir={abrirCls('Entrada acima da abertura')} />
          <ClsCard icon={ICONS.arrow} color={T.textMuted} title="Na abertura" desc="Sua odd ficou entre a abertura e 2% acima dela." d={S.neutro} aoAbrir={abrirCls('Entrada na abertura')} />
          <ClsCard icon={ICONS.warn} color={T.neg} title="Abaixo da abertura" desc="Sua odd ficou abaixo da abertura bruta de referência." d={S.reverse} aoAbrir={abrirCls('Entrada abaixo da abertura')} />
        </div>
      </AnalyzerCard>
      <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: '1fr 1fr', compacto: '1fr' } })}>
        <AnalyzerCard title="Distribuição Δ vs abertura bruta" sub="Onde sua odd de entrada caiu em relação à abertura."><VBars bins={S.distOE} larguraInicial={LARGURA_INICIAL.metade} /></AnalyzerCard>
        <AnalyzerCard title="Distribuição Δ vs fechamento bruto" sub="Quanto sua odd supera ou fica abaixo da odd bruta final."><VBars bins={S.distEF} larguraInicial={LARGURA_INICIAL.metade} /></AnalyzerCard>
      </div>
      <AnalyzerCard title="Desempenho por Δ vs abertura bruta" sub="ROI conforme a diferença contra a abertura bruta Pinnacle." style={{ marginBottom: 22 }}>
        <PerfTable rows={S.perfOE} aoAbrir={abrir('Δ vs abertura bruta')} />
      </AnalyzerCard>
      <AnalyzerCard title="Desempenho por Δ vs fechamento bruto" sub="ROI conforme sua odd ficou vs o fechamento bruto final." style={{ marginBottom: 22 }}>
        <PerfTable rows={S.perfEF} aoAbrir={abrir('Δ vs fechamento bruto')} />
      </AnalyzerCard>
      <AnalyzerCard title="Últimas trajetórias de preço" sub="Odds brutas da Pinnacle e sua odd capturada. Setas indicam diferenças entre os preços.">
        <div className="no-scrollbar" role="region" aria-label="Últimas trajetórias de preço" tabIndex={0} style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <div style={{ minWidth: 720 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 110px 130px 110px 90px', gap: 10, padding: '0 0 10px', borderBottom: `1px solid ${T.border}` }}>
          {['Data', 'Evento', 'Abertura bruta', 'Tomada', 'Fechamento bruto', 'Lucro'].map((h, i) => <Cap key={h} style={{ fontSize: 9.5, textAlign: i >= 2 ? 'right' : 'left' }}>{h}</Cap>)}
        </div>
        {S.traj.map((t, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 110px 130px 110px 90px', gap: 10, padding: '11px 0', borderBottom: `1px solid ${T.borderSoft}`, alignItems: 'center' }}>
            <span style={{ ...numFont, fontSize: 12.5, color: T.textMuted }}>{t.day}</span>
            <span style={{ fontFamily: T.font.body, fontSize: 13.5, fontWeight: 500, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.home} <span style={{ color: T.textFaint, fontWeight: 400 }}>vs</span> {t.away}</span>
            <span style={{ ...numFont, fontSize: 13, color: T.textMuted, textAlign: 'right' }}>{fmtOdds(t.open)}</span>
            <span style={{ ...numFont, fontSize: 13, fontWeight: 600, color: T.text, textAlign: 'right', display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
              {t.open != null && <Arrow dir={t.entry - t.open} />}{fmtOdds(t.entry)}{t.close != null && <Arrow dir={t.close - t.entry} />}</span>
            <span style={{ ...numFont, fontSize: 13, color: t.close == null ? T.textFaint : T.textMuted, textAlign: 'right' }}>{t.close == null ? '—' : fmtOdds(t.close)}</span>
            <span style={{ ...numFont, fontSize: 13, fontWeight: 600, color: t.profit == null ? T.textFaint : ink(t.profit), textAlign: 'right' }}>{t.profit == null ? '—' : money.signed(t.profit)}</span>
          </div>
        ))}
          </div>
        </div>
      </AnalyzerCard>
    </div>
  );
}
