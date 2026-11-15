import styles from "./charts.module.css";
import { uiDisplayColor, uiHexA } from "../../../utils";
import { fmtPct } from "@/src/domain/formato-de-resultado";
import { useDesign } from "../../../kit/context";
import { ChartEmptyState, useResponsiveChartWidth } from "../../../lib/responsive-chart";
import { ChartRealce, ChartReadout, useChartHoverFaixa } from "../../../lib/chart-hover";
import { fatiaDoPeriodo } from "../../../lib/analyzer-view";
import { contagem } from "../../../lib/plural";
import { escalaDeBarras } from "../../../lib/barra-com-sinal";
import { compartilhandoOZero, escala, faixaVertical } from "../../../lib/eixo-secundario";
import { LegendaDaRegua, TrilhoComSinal } from "../../../kit/TrilhoComSinal";
import type { Regua } from "../../../lib/barra-com-sinal";
import type { AnaliseDoRecorte } from "../use-analise-do-recorte";

type Heat = NonNullable<AnaliseDoRecorte["Z"]>;
/** Uma célula dia × faixa de horário do mapa de calor. */
export type CelulaDoHeatmap = Heat["heat"][string];

/**
 * Gráficos de DISTRIBUIÇÃO — como a operação se espalha por faixa.
 *
 * O eixo x é categoria (faixa de odds, bucket de CLV, janela de antecedência),
 * não tempo: reordenar as barras não muda o que o gráfico afirma. É por isso
 * que a leitura no hover aqui indexa por FATIA, e não pelo passo entre pontos
 * como em `linha-do-tempo` — usar o mapeamento contínuo numa barra erra
 * meia fatia e deixa as pontas com alvo de meia largura.
 *
 * `RCChart` é combinado e esconderia a série que não é a barra (a linha de
 * CLV) sem a leitura no hover. `VBars` escreve tudo o que desenha e por
 * isso não ganhou leitura; `HBars` e `Heatmap` não são SVG de série.
 */
export function VBars({ bins, larguraInicial, H = 190 }: {
  bins: readonly { l: string; n: number; color?: string }[];
  /** Largura do primeiro desenho (`LARGURA_INICIAL`); o gráfico se mede depois. */
  larguraInicial?: number;
  H?: number;
}) {
  const { T } = useDesign();
  const { chartRef, chartWidth: W } = useResponsiveChartWidth(larguraInicial);
  if (!bins.length) return <ChartEmptyState height={H} />;
  const mx = Math.max(1, ...bins.map((b) => b.n)); const padB = 26, padT = 18, padL = 26;
  const slot = (W - padL) / bins.length, bw = Math.min(46, slot * 0.5);
  const ys = escala(0, mx, faixaVertical(H, padT, padB)).px;
  return (<svg ref={chartRef} data-responsive-chart="true" role="img" aria-label="Distribuição de apostas por faixa" width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={styles.chart}>
    {[0, mx / 2, mx].map((v, i) => (<g key={i}><line x1={padL} x2={W} y1={ys(v)} y2={ys(v)} stroke={T.borderSoft} strokeWidth="1" />
      <text x={0} y={ys(v) + 3} fontFamily={T.font.num} fontSize="9.5" fill={T.textFaint}>{Math.round(v)}</text></g>))}
    {bins.map((b, i) => { const cx = padL + slot * (i + 0.5), top = ys(b.n); return (<g key={i}>
      <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(0, ys(0) - top)} rx="4" fill={uiDisplayColor(T, b.color || T.accent)} opacity="0.9" />
      <text x={cx} y={H - 8} fontFamily={T.font.body} fontSize="10" fill={T.textFaint} textAnchor="middle">{b.l}</text>
      {b.n > 0 && <text x={cx} y={top - 6} fontFamily={T.font.num} fontSize="10.5" fontWeight="600" fill={T.textMuted} textAnchor="middle">{b.n}</text>}
    </g>); })}
  </svg>);
}

/**
 * Barras horizontais com SINAL e, opcionalmente, uma régua no agregado.
 *
 * `it.v` vem com sinal — quem chama não tira módulo. A geometria inteira sai de
 * `escalaDeBarras`, que é onde a propriedade "posição no trilho é monotônica no
 * valor" está provada. Ver `lib/barra-com-sinal` para a regra.
 *
 * `referencia = { v, rotulo }`: a régua tracejada e a legenda que diz o que ela
 * é. Sem rótulo a linha seria uma marca sem significado no meio do gráfico, e a
 * lição do balde vale aqui — marca que não se explica vira decoração.
 */
export function HBars({ items, referencia = null }: {
  items: readonly { l: string; v: number | null; label2: string; color?: string }[];
  referencia?: Regua | null;
}) {
  // Sem estado vazio o cartão ficaria só com título, igual a desenho quebrado.
  const { T, numFont } = useDesign();
  if (!items.length) return <ChartEmptyState height={72} />;
  const geo = escalaDeBarras(items.map((i) => i.v), { referencia: referencia?.v });
  return (<div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    {items.map((it, i) => (<div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 58, flexShrink: 0, ...numFont, fontSize: 11.5, color: T.textMuted, textAlign: 'right' }}>{it.l}</div>
      <TrilhoComSinal geom={geo.barras[i]!} centrada={geo.centrada} reguaPct={geo.reguaPct} cor={uiDisplayColor(T, it.color || T.accent)} />
      <div style={{ width: 42, flexShrink: 0, ...numFont, fontSize: 11.5, fontWeight: 600, color: T.text, textAlign: 'right' }}>{it.label2}</div>
    </div>))}
    <LegendaDaRegua referencia={referencia} reguaPct={geo.reguaPct} recuo={68} />
  </div>);
}

export function RCChart({ rows, larguraInicial, H = 240 }: {
  rows: readonly { l: string; n: number; roi: number | null; clv: number | null }[];
  /** Largura do primeiro desenho (`LARGURA_INICIAL`); o gráfico se mede depois. */
  larguraInicial?: number;
  H?: number;
}) {
  const { T, ink } = useDesign();
  const { chartRef, chartWidth: W } = useResponsiveChartWidth(larguraInicial);
  const padL = 42, padR = 46, padT = 18, padB = 28;
  // Geometria antes do return antecipado: hook não pode ficar atrás de condicional.
  const { indice, handlers } = useChartHoverFaixa(rows.length, { largura: W, padL, padR });
  if (!rows.length) return <ChartEmptyState height={H} />;
  const rois = rows.map((r) => r.roi).filter((v): v is number => v != null);
  const caixa = faixaVertical(H, padT, padB);
  const eixoRoi = escala(Math.min(0, ...rois, -10) - 5, Math.max(0, ...rois, 5) + 5, caixa);
  const ry = eixoRoi.px;
  // A linha de CLV divide o zero com as barras de ROI: cruzar a linha
  // horizontal tem de significar CLV mudando de sinal.
  const eixoClv = compartilhandoOZero(rows.map((r) => r.clv), eixoRoi, caixa, { minimoAbs: 3 });
  const n = rows.length, slot = (W - padL - padR) / n, bw = Math.min(48, slot * 0.4);
  // O alcance do ROI sempre inclui o zero (lo ≤ −15, hi ≥ 5).
  const base = eixoRoi.pxDoZero!;
  const lp = !eixoClv ? [] : rows.map((r, i) => r.clv != null ? { x: padL + slot * (i + 0.5), y: eixoClv.px(r.clv) } : null)
    .filter((p): p is { x: number; y: number } => p != null);
  const alvo = indice != null && rows[indice] != null ? rows[indice] : null;
  return (<div className={styles.relative}>
  <svg ref={chartRef} data-responsive-chart="true" role="img" aria-label="ROI e CLV por faixa" width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={styles.chartOverflow} {...handlers}>
    {alvo && <ChartRealce x={padL + slot * (indice! + 0.5)} largura={slot} topo={padT} base={H - padB} />}
    <line x1={padL} x2={W - padR} y1={base} y2={base} stroke={T.border} />
    {rows.map((r, i) => { const cx = padL + slot * (i + 0.5); return (<g key={i}>
      {r.roi != null && <><rect x={cx - bw / 2} y={Math.min(base, ry(r.roi))} width={bw} height={Math.max(2, Math.abs(ry(r.roi) - base))} rx="4" fill={r.roi >= 0 ? (T.posDisplay || T.pos) : (T.negDisplay || T.neg)} opacity="0.9" />
        <text x={cx} y={ry(r.roi) + (r.roi >= 0 ? -8 : 16)} fontFamily={T.font.num} fontSize="10.5" fontWeight="600" fill={ink(r.roi)} textAnchor="middle">{fmtPct(r.roi)}</text></>}
      <text x={cx} y={H - 8} fontFamily={T.font.num} fontSize="10.5" fill={T.textFaint} textAnchor="middle">{r.l}</text>
    </g>); })}
    {lp.length > 1 && <polyline points={lp.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={T.chartClvDisplay || T.chartClv} strokeWidth="2" />}
    {lp.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="3.5" fill={T.chartClvDisplay || T.chartClv} stroke={T.surface} strokeWidth="1.5" />)}
    {/* O eixo do CLV, declarado: sem ele a linha era um traço sem unidade. */}
    {eixoClv && <g>
      <text x={W - padR + 6} y={eixoClv.px(eixoClv.hi) + 8} fontFamily={T.font.num} fontSize="10"
        fill={T.chartClvDisplay || T.chartClv} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtPct(eixoClv.hi)}</text>
      <text x={W - padR + 6} y={base + 3} fontFamily={T.font.num} fontSize="10"
        fill={T.chartClvDisplay || T.chartClv} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtPct(0)}</text>
    </g>}
  </svg>
  {alvo && (
    <ChartReadout x={padL + slot * (indice! + 0.5)} largura={W} titulo={alvo.l}
      rodape={fatiaDoPeriodo(alvo.n, rows.reduce((s, r) => s + (r.n ?? 0), 0))}
      linhas={[
        { rotulo: 'ROI', cor: alvo.roi == null ? T.textFaint : (alvo.roi >= 0 ? (T.posDisplay || T.pos) : (T.negDisplay || T.neg)), valor: alvo.roi == null ? '—' : fmtPct(alvo.roi), corValor: alvo.roi == null ? T.textFaint : ink(alvo.roi) },
        // A linha de CLV existia só como traço: o valor por faixa não estava
        // escrito em lugar nenhum, e é ele que diz se a faixa é sharp de fato.
        { rotulo: 'CLV médio', cor: T.chartClvDisplay || T.chartClv, valor: alvo.clv == null ? '—' : fmtPct(alvo.clv), corValor: alvo.clv == null ? T.textFaint : ink(alvo.clv) },
      ]} />
  )}
  </div>);
}

/**
 * O único gráfico do Analyzer sem tabela gêmea — por isso a célula abre a gaveta
 * direto. Sem isso, "quarta-feira 12–15h tem ROI −18%" não tinha como virar
 * "quais apostas são essas": não existe filtro de dia×hora no histórico.
 *
 * A célula é onde contagem e soma têm bases diferentes DE PROPÓSITO: o número
 * grande conta todas (inclusive pendentes) e o ROI só as liquidadas. A gaveta
 * declara as duas em vez de escolher uma e mentir sobre a outra.
 */
export function Heatmap({ Z, aoAbrirCelula }: {
  Z: Pick<Heat, 'hBk' | 'WD' | 'heat'>;
  aoAbrirCelula?: (celula: CelulaDoHeatmap, rotulo: string) => void;
}) {
  const { T, numFont } = useDesign();
  const abre = typeof aoAbrirCelula === 'function';
  const colorFor = (roi: number | null) => { if (roi == null) return T.surface2; const t = Math.max(-10, Math.min(15, roi));
    return t < 0 ? uiHexA(T.negDisplay || T.neg, 0.15 + 0.45 * (-t / 10)) : uiHexA(T.posDisplay || T.pos, 0.1 + 0.5 * (t / 15)); };
  const gtc = '46px repeat(6,1fr)';
  return (<div>
    <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: 5, marginBottom: 5 }}>
      <div />{Z.hBk.map(([l]) => <div key={l} style={{ textAlign: 'center', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.06em', color: T.textFaint }}>{l}</div>)}
    </div>
    {Z.WD.map((wd, wi) => (
      <div key={wi} style={{ display: 'grid', gridTemplateColumns: gtc, gap: 5, marginBottom: 5 }}>
        <div style={{ fontSize: 11.5, color: T.textMuted, display: 'flex', alignItems: 'center' }}>{wd}</div>
        {Z.hBk.map(([faixa], hi) => { const c = Z.heat[wi + '_' + hi], roi = c && c.stake ? c.profit / c.stake * 100 : null;
          const celula = { height: 38, borderRadius: 6, background: c ? colorFor(roi) : T.surface2, border: `1px solid ${T.borderSoft}`, display: 'grid', placeItems: 'center' };
          const conteudo = c && <div style={{ textAlign: 'center' }}><div style={{ ...numFont, fontSize: 11, fontWeight: 600, color: T.text }}>{c.n}</div>{roi != null && <div style={{ ...numFont, fontSize: 9, color: T.textMuted }}>{Math.round(roi)}%</div>}</div>;
          // Célula vazia continua um div: não há o que abrir, e um botão morto
          // só poluiria a ordem de Tab com 42 paradas sem destino.
          if (!abre || !c) return <div key={hi} style={celula}>{conteudo}</div>;
          return (<button key={hi} type="button" style={{ ...celula, cursor: 'pointer', padding: 0, font: 'inherit' }}
            aria-label={`Ver as ${contagem(c.membros.length, 'aposta')} de ${Z.WD[wi]} ${faixa}`}
            onClick={() => aoAbrirCelula(c, `${Z.WD[wi]} · ${faixa}`)}>{conteudo}</button>); })}
      </div>
    ))}
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 11, color: T.textFaint }}>ROI:
      <div style={{ display: 'flex', gap: 3 }}>{[-10, -6, -3, 0, 5, 10, 15].map((v) => <span key={v} style={{ width: 18, height: 10, borderRadius: 2, background: colorFor(v) }} />)}</div>
      <span>−10% → +15%</span></div>
  </div>);
}
