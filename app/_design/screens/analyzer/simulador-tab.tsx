import { AMOSTRA_MINIMA_CLV, VEREDITO_ROTULO } from "@/src/domain/analyzer/shared";
import { STAKE_POLICIES, type StakePolicy } from "@/src/domain/analyzer/stake-policy";
import { fmtPct } from "@/src/domain/formato-de-resultado";
import { Icon, ICONS } from "../../kit/icons";
import { SEM_COMPACTO, SO_COMPACTO } from "../../kit/faixas";
import { Cap } from "../../kit/primitives";
import { useDesign } from "../../kit/context";
import { contagem, plural } from "../../lib/plural";
import { MultiCurveChart, type ChartCurve } from "./charts/linha-do-tempo";
import { DataTable } from "./tables";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import type { PropsDaAba, StakeSimulationView } from "./use-analise-do-recorte";

/** Nome e regra de cada política; a cor e o traço no gráfico seguem a ordem de `STAKE_POLICIES`. */
const POLICY_LABELS: Record<StakePolicy, { name: string; rule: string }> = {
  tipster: { name: 'Stake do tipster', rule: 'o que foi apostado de fato.' },
  flat: { name: '1u fixa', rule: 'uma unidade em toda aposta.' },
  edgeOnly: { name: `Só com canal em ${VEREDITO_ROTULO.EDGE}`, rule: `a stake do tipster só quando o veredito do canal no post era ${VEREDITO_ROTULO.EDGE}.` },
};

type PolicyRow = StakeSimulationView["rows"][number];

export function StakeSimulatorTab({ periodCard, K, portfolio, wholeHistory }: Pick<PropsDaAba, 'periodCard'> & {
  K: StakeSimulationView;
  /** Carteira: cada banca com o próprio CLV, dinheiro em reais. */
  portfolio: boolean;
  /** Período Tudo e sem filtro: a régua do canal aprende com o histórico inteiro. */
  wholeHistory: boolean;
}) {
  const { T, ink } = useDesign();
  const money = useMoneyFormat();
  const tone = (v: number | null) => (v == null ? T.textFaint : ink(v));
  if (K.settledN === 0) {
    return (
      <div>
        {periodCard}
        <AnalyzerCard title="E se a stake fosse outra?" icon={ICONS.calc}>
          <p style={{ margin: 0, fontSize: 13.5, color: T.textMuted, lineHeight: 1.5 }}>
            Nenhuma aposta liquidada no recorte: não há o que simular.</p>
        </AnalyzerCard>
      </div>
    );
  }
  const smallSample = K.settledN < AMOSTRA_MINIMA_CLV;
  const curves: ChartCurve[] = [];
  const idle: string[] = [];
  for (const { policy, values } of K.curves) {
    const { name } = POLICY_LABELS[policy];
    const series = STAKE_POLICIES.indexOf(policy);
    if (values) curves.push({ key: policy, name, values, color: T.chartSeries[series] ?? T.textMuted, dash: T.chartSeriesDash[series] });
    else idle.push(name);
  }
  const caveats: Array<[title: string, text: string]> = [
    ['Amostra', smallSample
      ? `Só ${contagem(K.settledN, 'aposta liquidada', 'apostas liquidadas')} no recorte. Com menos de ${AMOSTRA_MINIMA_CLV}, a diferença entre as políticas é ruído.`
      : 'O número de apostas de cada política é a amostra dela: a que apostou pouco não prova nada, mesmo com ROI alto.'],
    ['Viés', 'As apostas removidas (👎 no canal ou pelo painel) não estão na base. Se as removidas eram as piores, todas as políticas parecem melhores do que seriam.'],
    ['Recorte', wholeHistory
      ? 'O CLV do canal começa na primeira aposta do histórico.'
      : 'O CLV do canal recomeça no início deste recorte e só conta as apostas do filtro. Em Tudo, sem filtro, a conta usa o histórico inteiro.'],
  ];

  return (
    <div>
      {periodCard}
      <AnalyzerCard title="E se a stake fosse outra?" icon={ICONS.calc} style={{ marginBottom: 22 }}
        sub={`${plural(K.settledN, 'A', 'As')} ${contagem(K.settledN, 'aposta liquidada', 'apostas liquidadas')} do recorte ${plural(K.settledN, 'refeita', 'refeitas')} com outra regra de stake, na ordem dos posts. Em cada aposta a regra só vê o que existia no post: os fechamentos do canal já congelados.`}>
        {smallSample && (
          <p role="note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '0 0 16px', padding: '10px 12px',
            borderRadius: T.radiusSm, background: T.negSoft, color: T.text, fontSize: 13, lineHeight: 1.5 }}>
            <Icon d={ICONS.warn} s={16} style={{ color: T.neg, flexShrink: 0, marginTop: 1 }} />
            Amostra pequena: {contagem(K.settledN, 'liquidada')}. Leia como ilustração, não como resultado.
          </p>
        )}
        <div className={SEM_COMPACTO}>
        <DataTable<PolicyRow> rows={K.rows} cols={[
          { h: 'Política', a: 'left', w: '1.8fr', bold: true, fmt: (r) => POLICY_LABELS[r.policy].name },
          { h: 'Apostas', fmt: (r) => r.n },
          { h: 'Stake', color: () => T.textMuted, fmt: (r) => money.amount(r.stake) },
          { h: 'Lucro', bold: true, color: (r) => tone(r.lucro), fmt: (r) => money.signed(r.lucro) },
          { h: 'ROI', bold: true, color: (r) => tone(r.roi), fmt: (r) => fmtPct(r.roi) },
          { h: 'Drawdown máx.', color: (r) => tone(r.maxDD), fmt: (r) => money.signed(r.maxDD) },
          { h: 'Maior stake', color: () => T.textMuted, fmt: (r) => money.amount(r.maxStake) },
        ]} />
        </div>
        <PolicyList rows={K.rows} />
        <dl style={{ margin: '16px 0 0', display: 'grid', gap: 6, fontSize: 12.5, lineHeight: 1.5 }}>
          {K.rows.map((r) => (
            <div key={r.policy}>
              <dt style={{ display: 'inline', color: T.text, fontWeight: 600 }}>{POLICY_LABELS[r.policy].name}: </dt>
              <dd style={{ display: 'inline', margin: 0, color: T.textMuted }}>{POLICY_LABELS[r.policy].rule}</dd>
            </div>
          ))}
        </dl>
      </AnalyzerCard>
      <AnalyzerCard title="Lucro acumulado por política" style={{ marginBottom: 22 }}
        sub={`Em ${money.unitName}, no fim de cada dia de jogo.`}>
        <MultiCurveChart labels={K.labels} ariaLabel="Lucro acumulado de cada política de stake" series={curves} />
        {idle.length > 0 && (
          <p style={{ margin: '10px 0 0', fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>
            {idle.join(', ')}: sem aposta no recorte, fora do gráfico.</p>
        )}
      </AnalyzerCard>
      <AnalyzerCard title="Antes de concluir" icon={ICONS.warn}
        sub={`O simulador mede o passado deste recorte${portfolio ? '; na carteira, cada tipster decide com a régua dele e o dinheiro soma em reais pelo valor da unidade de cada aposta' : ''}.`}>
        <dl style={{ margin: 0, display: 'grid', gap: 12 }}>
          {caveats.map(([title, text]) => (
            <div key={title}>
              <dt style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>{title}</dt>
              <dd style={{ margin: '3px 0 0', fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>{text}</dd>
            </div>
          ))}
        </dl>
      </AnalyzerCard>
    </div>
  );
}

/** No compacto cada política vira um bloco, com lucro, ROI e drawdown à vista sem rolagem lateral. */
function PolicyList({ rows }: { rows: readonly PolicyRow[] }) {
  const { T, numFont, ink } = useDesign();
  const money = useMoneyFormat();
  const tone = (v: number | null) => (v == null ? T.textFaint : ink(v));
  return (
    <ul className={SO_COMPACTO} aria-label="Políticas de stake" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {rows.map((r) => {
        const metrics: Array<[label: string, value: string, color: string]> = [
          ['Lucro', money.signed(r.lucro), tone(r.lucro)],
          ['ROI', fmtPct(r.roi), tone(r.roi)],
          ['Drawdown máx.', money.signed(r.maxDD), tone(r.maxDD)],
        ];
        return (
          <li key={r.policy} style={{ padding: '12px 0', borderBottom: `1px solid ${T.borderSoft}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{POLICY_LABELS[r.policy].name}</span>
              <span style={{ ...numFont, fontSize: 12, color: T.textMuted, whiteSpace: 'nowrap' }}>{contagem(r.n, 'aposta')}</span>
            </div>
            <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, margin: '8px 0 0' }}>
              {metrics.map(([label, value, color]) => (
                <div key={label} style={{ minWidth: 0 }}>
                  <dt><Cap style={{ fontSize: 9.5 }}>{label}</Cap></dt>
                  <dd style={{ ...numFont, margin: '3px 0 0', fontSize: 14, fontWeight: 600, color, overflowWrap: 'anywhere' }}>{value}</dd>
                </div>
              ))}
            </dl>
            <div style={{ ...numFont, marginTop: 6, fontSize: 11.5, color: T.textFaint }}>
              stake {money.amount(r.stake)} · maior {money.amount(r.maxStake)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
