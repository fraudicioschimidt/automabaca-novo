import { DataTable } from "./tables";
import { SegKpi } from "./shared";
import { contagem } from "../../lib/plural";
import { recorteDaLinha } from "../../lib/recorte-de-apostas";
import { TiraDeConcentracao } from "./tira-de-concentracao";
import { ranking } from "../../lib/concentracao";
import { escalaDeBarras } from "../../lib/barra-com-sinal";
import { TrilhoComSinal } from "../../kit/TrilhoComSinal";
import { AMOSTRA_MINIMA_EXIBICAO as PISO } from "@/src/domain/analyzer/shared";
import { ICONS } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import { ChannelMarketCard, SuggestedCutsCard } from "./portfolio-cards";
import { fmtPct } from "@/src/domain/formato-de-resultado";
import type { AnaliseDoRecorte, DadosDaCarteira, PropsDaAba, SegView } from "./use-analise-do-recorte";

const SEG_LABEL: Record<SegView, string> = { canal: 'Canal', esporte: 'Esporte', mercado: 'Mercado', competicao: 'Competição', pais: 'País' };
const SEG_SUBSTANTIVO: Record<SegView, string> = { canal: 'canais', esporte: 'esportes', mercado: 'mercados', competicao: 'competições', pais: 'países' };


export function SegmentosTab({ periodCard, segData, carteira, segView, segViews, setSegView, abrirRecorte }:
  Pick<PropsDaAba, 'periodCard' | 'abrirRecorte'> & {
  segData: NonNullable<AnaliseDoRecorte["segData"]>;
  /** Na carteira, com a dimensão Canal: a matriz canal × mercado e os cortes. */
  carteira: DadosDaCarteira | null;
  segView: SegView;
  segViews: readonly SegView[];
  setSegView: (segView: SegView) => void;
}) {
  const { T, numFont, ink } = useDesign();
  const money = useMoneyFormat();
  const segMost = segData[0];
  const segByProfit = segData.filter((s) => s.settledN > 0).sort((a, b) => b.lucro - a.lucro)[0];
  const segRoi5 = segData.filter((s) => s.settledN >= PISO).sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))[0];
  const segClv5 = segData.filter((s) => s.clvN >= PISO).sort((a, b) => (b.clv ?? 0) - (a.clv ?? 0))[0];
  /**
   * A geometria do ranking sai de `escalaDeBarras`, a mesma do `HBars` — nada
   * de reimplementá-la à mão no JSX.
   *
   * SEM régua aqui, e de propósito: as barras são lucro ABSOLUTO, e a linha
   * que importa nesse eixo é o zero — que o trilho centrado já desenha. "Lucro
   * médio por segmento" seria aritmética, não referência, e uma segunda linha
   * tracejada colada no zero só disputaria atenção com ele.
   */
  // O cartão se chama "Ranking por lucro", e `segData` vem ordenado por
  // CONTAGEM: reordena pela métrica do título (ver `lib/concentracao`).
  const segPorLucro = ranking(segData, 'lucro');
  const escalaLucro = escalaDeBarras(segPorLucro.map((s) => s.lucro));
  // Largura única para o valor: variando por linha, o trilho de cada barra
  // teria um comprimento e as barras deixariam de ser comparáveis. Mono avança
  // 0,6em (7,8px a 13px) por caractere; "+R$ 1.234,56" pede mais que "+1.25u".
  const textosDoLucro = segPorLucro.map((s) => money.signed(s.lucro || 0));
  const larguraDoLucro = Math.max(64, Math.ceil(Math.max(0, ...textosDoLucro.map((t) => t.length)) * 7.8));
  const segLabel = SEG_LABEL[segView];

  return (
    <div>
      {periodCard}
      <div className="no-scrollbar" style={{ display: 'flex', gap: 4, marginBottom: 22, maxWidth: '100%', overflowX: 'auto' }}>
        {segViews.map((k) => { const on = segView === k; const l = SEG_LABEL[k]; return (
          <button key={k} onClick={() => setSegView(k)} style={{ fontFamily: T.font.body, fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
            padding: '8px 14px', borderRadius: T.radiusSm, border: 'none', background: on ? T.text : 'transparent', color: on ? T.surface : T.textMuted, letterSpacing: '-0.01em' }}>{l}</button>); })}
      </div>
      <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: 'repeat(4,1fr)', compacto: 'repeat(2,minmax(0,1fr))' } })}>
        <SegKpi k="Mais lucrativo" icon={ICONS.cup} name={segByProfit && segByProfit.k} sub={segByProfit ? `${money.signed(segByProfit.lucro)} · ${segByProfit.roi == null ? '—' : fmtPct(segByProfit.roi)} ROI` : 'sem apostas resolvidas'} />
        <SegKpi k="Mais usado" icon={ICONS.bars} name={segMost && segMost.k} sub={segMost ? contagem(segMost.n, 'aposta') : ''} />
        <SegKpi k={`Maior ROI (≥${contagem(PISO, 'resolvida')})`} icon={ICONS.lucro} name={segRoi5 && segRoi5.k} sub={segRoi5 && segRoi5.roi != null ? fmtPct(segRoi5.roi) : 'amostra curta'} />
        <SegKpi k={`Maior CLV (≥${contagem(PISO, 'fecho')})`} icon={ICONS.clv} name={segClv5 && segClv5.k} sub={segClv5 && segClv5.clv != null ? fmtPct(segClv5.clv) : 'amostra curta'} />
      </div>
      {carteira && <>
        <SuggestedCutsCard carteira={carteira} abrirRecorte={abrirRecorte} />
        <ChannelMarketCard carteira={carteira} abrirRecorte={abrirRecorte} />
      </>}
      <AnalyzerCard title="Ranking por lucro" style={{ marginBottom: 22 }}>
        <TiraDeConcentracao linhas={segPorLucro} substantivo={SEG_SUBSTANTIVO[segView]} />
        {/* `data-ranking` declara no MARCADOR por qual métrica a lista está
            ordenada — o título promete e aqui se prova. */}
        <div data-ranking="lucro" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {segPorLucro.map((s, i) => (
            <div key={s.k} data-rank-label={s.k} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div title={s.k} style={{ width: 130, flexShrink: 0, fontSize: 13, color: T.text, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.k}</div>
              <TrilhoComSinal geom={escalaLucro.barras[i]!} centrada={escalaLucro.centrada} reguaPct={escalaLucro.reguaPct} cor={(s.lucro || 0) < 0 ? T.neg : T.pos} altura={16} />
              <div style={{ width: larguraDoLucro, flexShrink: 0, ...numFont, fontSize: 13, fontWeight: 600, color: ink(s.lucro || 0), textAlign: 'right', whiteSpace: 'nowrap' }}>{textosDoLucro[i]}</div>
            </div>
          ))}
        </div>
      </AnalyzerCard>
      <AnalyzerCard title={`Detalhamento completo — ${segLabel}`}>
        <DataTable cols={[{ h: segLabel, a: 'left', w: '1.4fr', bold: true, fmt: (r) => r.k },
          { h: 'Apostas', fmt: (r) => r.n }, { h: 'Stake', color: () => T.textMuted, fmt: (r) => money.amount(r.stake) },
          { h: 'Lucro', bold: true, color: (r) => r.lucro == null ? T.textFaint : ink(r.lucro), fmt: (r) => r.lucro == null ? '—' : money.signed(r.lucro) },
          { h: 'ROI', bold: true, color: (r) => r.roi == null ? T.textFaint : ink(r.roi), fmt: (r) => r.roi == null ? '—' : fmtPct(r.roi) },
          { h: 'CLV médio', bold: true, color: (r) => r.clv == null ? T.textFaint : ink(r.clv), fmt: (r) => r.clv == null ? '—' : fmtPct(r.clv) },
          { h: '% CLV+', color: () => T.textMuted, fmt: (r) => r.clvPct == null ? '—' : Math.round(r.clvPct) + '%' }]} rows={segData}
          aoAbrir={(r) => abrirRecorte(recorteDaLinha(r, { money, rotulo: r.k, contexto: `${segLabel} · ${contagem(r.membros.length, 'aposta')}` }))} />
      </AnalyzerCard>
    </div>
  );
}
