import { MonthlyChart } from "./charts/linha-do-tempo";
import { HBars } from "./charts/distribuicao";
import { DataTable } from "./tables";
import { SegKpi } from "./shared";
import { contagem, plural } from "../../lib/plural";
import { recorteDaLinha } from "../../lib/recorte-de-apostas";
import { TiraDeConcentracao } from "./tira-de-concentracao";
import { ranking } from "../../lib/concentracao";
import { regua } from "../../lib/barra-com-sinal";
import { sumMoneyBy } from "@/src/domain/money";
import { AMOSTRA_MINIMA_EXIBICAO as PISO } from "@/src/domain/analyzer/shared";
import { ICONS } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { LARGURA_INICIAL } from "../../lib/responsive-chart";
import { porFaixa } from "../../kit/faixas";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import { fmtOdds, fmtPct, fmtRate } from "@/src/domain/formato-de-resultado";
import type { AnaliseDoRecorte, PropsDaAba } from "./use-analise-do-recorte";

export function CasasTab({ periodCard, P, abrirRecorte }:
  Pick<PropsDaAba, 'periodCard' | 'abrirRecorte'>
  & { P: NonNullable<AnaliseDoRecorte["P"]> }) {
  const { T, ink } = useDesign();
  const money = useMoneyFormat();
  const { casas } = P;
  const casaProfit = casas.filter((c) => c.settledN > 0).sort((a, b) => b.lucro - a.lucro)[0];
  const casasComSteam = ranking(
    casas.filter((c): c is typeof c & { steamPct: number } => c.steamPct != null), "steamPct",
  );
  const casaSteam = casasComSteam.find((c) => c.steamSamples >= PISO);
  const casa5 = casas.filter((c) => c.settledN >= PISO);
  const casaClv5 = casas.filter((c) => c.clvN >= PISO).sort((a, b) => (b.clv ?? 0) - (a.clv ?? 0))[0];
  const casaRoiOrdenada = ranking(casa5, 'roi');
  const casaRoi5 = casaRoiOrdenada[0];
  // "Top casas por lucro": `P.casas` vem em ordem de ENCONTRO; reordena pela
  // métrica do título (ver `lib/concentracao`).
  const casasPorLucro = ranking(casas, 'lucro');

  /**
   * As réguas saem das MESMAS linhas que viram barra — nunca do recorte inteiro.
   * "Acima da média" tem de significar "acima da média destas barras"; puxar o
   * agregado de outro conjunto responderia a uma pergunta que o gráfico não faz,
   * e é a família do `comparacao-de-janelas`.
   */
  const roiAgregado = (() => {
    const stake = sumMoneyBy(casaRoiOrdenada, (c) => c.stake);
    return stake > 0 ? (sumMoneyBy(casaRoiOrdenada, (c) => c.lucro) / stake) * 100 : null;
  })();
  const reguaDeRoi = regua({
    valor: roiAgregado,
    texto: roiAgregado == null ? '' : fmtPct(roiAgregado),
    descricao: `ROI agregado de ${contagem(casaRoiOrdenada.length, 'casa')} do gráfico`,
  });
  // A taxa de entrada acima da abertura é razão de contagens, não de dinheiro:
  // pondera por aberturas, que é o denominador de cada barra.
  const steamAberturas = casasComSteam.reduce((s, c) => s + c.steamSamples, 0);
  const steamAgregado = steamAberturas > 0
    ? (casasComSteam.reduce((s, c) => s + c.steamN, 0) / steamAberturas) * 100
    : null;
  const reguaDeSteam = regua({
    valor: steamAgregado,
    texto: steamAgregado == null ? '' : `${Math.round(steamAgregado)}%`,
    descricao: `entrada acima da abertura, média de ${contagem(casasComSteam.length, 'casa')} do gráfico`,
  });

  return (
    <div>
      {periodCard}
      <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: 'repeat(4,1fr)', compacto: 'repeat(2,minmax(0,1fr))' } })}>
        <SegKpi k="Mais lucrativa" icon={ICONS.cup} name={casaProfit && casaProfit.k} sub={casaProfit ? `${money.signed(casaProfit.lucro)} · ${casaProfit.roi == null ? '—' : fmtPct(casaProfit.roi)} ROI` : 'sem apostas resolvidas'} />
        <SegKpi k={`Maior ROI (≥${contagem(PISO, 'resolvida')})`} icon={ICONS.lucro} name={casaRoi5 && casaRoi5.k} sub={casaRoi5 && casaRoi5.roi != null ? `${fmtPct(casaRoi5.roi)} · ${casaRoi5.settledN} ${plural(casaRoi5.settledN, 'resolvida')}` : 'amostra curta'} />
        <SegKpi k={`Melhor CLV (≥${contagem(PISO, 'fecho')})`} icon={ICONS.clv} name={casaClv5 && casaClv5.k} sub={casaClv5?.clv != null ? `${fmtPct(casaClv5.clv)} · ${casaClv5.clvN} fechamentos` : 'amostra curta'} />
        <SegKpi k="Mais entrada acima da abertura" icon={ICONS.rocket} name={casaSteam && casaSteam.k} sub={casaSteam ? `${Math.round(casaSteam.steamPct)}% de ${casaSteam.steamSamples} aberturas`
          : casasComSteam.length ? `amostra curta · mínimo de ${PISO} aberturas` : 'sem odds de abertura'} />
      </div>
      <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: '1fr 1fr', compacto: '1fr' } })}>
        <AnalyzerCard title="Top casas por lucro" sub={`Barras: lucro em ${money.unitName}. Ponto: ROI da casa.`}><MonthlyChart data={casasPorLucro.map((c) => ({ label: c.k, v: c.lucro, roi: c.roi }))} larguraInicial={LARGURA_INICIAL.metade} /></AnalyzerCard>
        <AnalyzerCard title="Casas com mais entrada acima da abertura" sub="Barra: % de apostas com a odd 2% ou mais acima da abertura bruta Pinnacle.">
          {casasComSteam.length ? <HBars items={casasComSteam.map((c) => ({ l: c.k, v: c.steamPct, label2: Math.round(c.steamPct) + '%', color: T.pos }))} referencia={reguaDeSteam} /> : <div style={{ color: T.textFaint, fontSize: 13 }}>Sem odds de abertura no recorte.</div>}</AnalyzerCard>
      </div>
      <AnalyzerCard title="Tabela completa por casa" style={{ marginBottom: 22 }}>
        <TiraDeConcentracao linhas={casas} substantivo="casas" />
        <DataTable cols={[{ h: 'Casa', a: 'left', w: '1.3fr', bold: true, fmt: (r) => r.k },
          { h: 'Apostas', fmt: (r) => r.n }, { h: 'Stake', color: () => T.textMuted, fmt: (r) => money.amount(r.stake) },
          { h: 'Lucro', bold: true, color: (r) => r.lucro == null ? T.textFaint : ink(r.lucro), fmt: (r) => r.lucro == null ? '—' : money.signed(r.lucro) },
          { h: 'ROI', bold: true, color: (r) => r.roi == null ? T.textFaint : ink(r.roi), fmt: (r) => r.roi == null ? '—' : fmtPct(r.roi) },
          { h: 'Acerto', color: () => T.text, fmt: (r) => fmtRate(r.acerto) },
          { h: 'CLV', bold: true, color: (r) => r.clv == null ? T.textFaint : ink(r.clv), fmt: (r) => r.clv == null ? '—' : fmtPct(r.clv) },
          { h: '% CLV+', color: () => T.textMuted, fmt: (r) => r.clvPct == null ? '—' : Math.round(r.clvPct) + '%' },
          { h: '% acima da abertura', color: () => T.textMuted, fmt: (r) => r.steamPct == null ? '—' : Math.round(r.steamPct) + '%' },
          { h: 'Δ abertura', color: (r) => r.dAb == null ? T.textFaint : ink(r.dAb), fmt: (r) => r.dAb == null ? '—' : fmtPct(r.dAb) },
          { h: 'Odd média', color: () => T.textMuted, fmt: (r) => fmtOdds(r.oddM) }]} rows={casas}
          aoAbrir={(r) => abrirRecorte(recorteDaLinha(r, { money, rotulo: r.k, contexto: `Casa de aposta · ${contagem(r.membros.length, 'aposta')}` }))} />
      </AnalyzerCard>
      <AnalyzerCard title="Top ROI por casa" sub={`Somente casas com ${PISO}+ apostas resolvidas para reduzir ruído.`}>
        {casaRoiOrdenada.length
          ? <HBars items={casaRoiOrdenada.map((c) => ({ l: c.k, v: c.roi, label2: fmtPct(c.roi), color: (c.roi ?? 0) < 0 ? T.neg : T.pos }))} referencia={reguaDeRoi} />
          : <div style={{ color: T.textFaint, fontSize: 13 }}>Nenhuma casa atingiu {contagem(PISO, 'aposta resolvida', 'apostas resolvidas')}.</div>}
      </AnalyzerCard>
    </div>
  );
}
