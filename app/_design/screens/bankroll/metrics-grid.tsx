import { useDesign } from "../../kit/context";
import { Label } from "./ui-primitives";
import { uiDisplayColor, uiHexA } from "../../utils";
import { contagem } from "../../lib/plural";
import styles from "./metrics-grid.module.css";
import type { bankrollKpis, BankrollMetric } from "./bankroll-kpis";
import { cssVars } from "../../kit/css-vars";
import { porFaixa } from "../../kit/faixas";

type RecorteInfo = ReturnType<typeof bankrollKpis>["recorteInfo"];

/**
 * Faixa que diz QUAL base a tira está contando: sem ela o número trocaria em
 * silêncio ao filtrar, e o operador precisa saber se lê a banca ou o recorte.
 */
function MarcaDaBase({ info }: { info: RecorteInfo }) {
  const { T } = useDesign();
  if (!info || (!info.ativo && !info.truncado)) return null;
  const truncado = info.truncado;
  return (
    <div
      className={styles.marca}
      style={cssVars({
        '--mg-pad': 'calc(var(--bk-pad) - 2px)',
        '--mg-font': T.font.body,
        '--mg-cor': truncado ? T.textMuted : T.accent,
        '--mg-fundo': truncado ? T.surface2 : uiHexA(T.accent, 0.07),
        '--mg-borda': T.borderSoft,
      })}
    >
      <span className={styles.ponto} />
      {/* A frase inteira num span: solta, ela vira TRÊS itens flex (texto, <b>,
          texto) e o `gap` do container abre buraco dentro da frase —
          "recorte filtrado : 17" com espaço antes dos dois-pontos. */}
      <span>
        {truncado
          ? <>Números de <b>todas as apostas do tipster</b> — o histórico carregado ({contagem(info.de, 'aposta')}) não cobre tudo, então o recorte não pode ser somado aqui.</>
          : <>Contando o <b>recorte filtrado</b>: {info.n} de {contagem(info.de, 'aposta')}.</>}
      </span>
    </div>
  );
}

export function MetricsGrid({ metrics, recorteInfo }: {
  metrics: BankrollMetric[];
  recorteInfo: RecorteInfo;
}) {
  const { T, numFont } = useDesign();
  const borda = `1px solid ${T.borderSoft}`;
  return (
    <div {...porFaixa({ display: 'grid',
      background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius,
      boxShadow: T.cardShadow, overflow: 'hidden', marginBottom: 24 }, { gridTemplateColumns: { largo: `repeat(${metrics.length}, 1fr)`, compacto: 'repeat(2, minmax(0, 1fr))' } })}>
      <MarcaDaBase info={recorteInfo} />
      {metrics.map((m, i) => (
        // No compacto a tira vira grade de 2: a borda à esquerda só na coluna
        // da direita, a de cima a partir da segunda linha, e o último ímpar
        // ocupa a linha inteira.
        <div key={m.k} {...porFaixa({ padding: 'calc(var(--bk-pad) - 4px) calc(var(--bk-pad) - 2px)', minWidth: 0 }, {
          gridColumn: { largo: 'auto', compacto: metrics.length % 2 === 1 && i === metrics.length - 1 ? '1 / -1' : 'auto' },
          borderLeft: { largo: i ? borda : 'none', compacto: i % 2 ? borda : 'none' },
          borderTop: { largo: 'none', compacto: i >= 2 ? borda : 'none' },
        })}>
          <Label style={{ marginBottom: 12 }}>{m.k}</Label>
          <div {...porFaixa({ ...numFont, fontFamily: T.font.num, fontWeight: 600,
            color: uiDisplayColor(T, m.c), letterSpacing: '-0.02em', lineHeight: 1 }, { fontSize: { largo: 30, compacto: 24 } })}>{m.v}</div>
          <div style={{ fontFamily: T.font.body, fontSize: 12, color: T.textFaint, marginTop: 9 }}>{m.sub}</div>
        </div>
      ))}
    </div>
  );
}
