import { useMemo } from "react";
import { chartCoordinate, sampleChartPoints, uiDisplayColor, uiSmooth } from "../../../utils";
import { ChartEmptyState, useChartId, useResponsiveChartWidth } from "../../../lib/responsive-chart";
import { ChartCrosshair, ChartRealce, ChartReadout, useChartHover, useChartHoverFaixa } from "../../../lib/chart-hover";
import { aindaSeMove, textoDeEmCurso, type EmCurso } from "../../../lib/balde-em-curso";
import { compartilhandoOZero, escala, faixaVertical, marcasRedondas, rotulosQueCabem } from "../../../lib/eixo-secundario";
import { fmtPct } from "@/src/domain/formato-de-resultado";
import { useDesign } from "../../../kit/context";
import { useMoneyFormat } from "../ui-primitives";

/**
 * Gráficos de LINHA DO TEMPO — como a operação evoluiu ao longo dela.
 *
 * O eixo x é ordenado e tem sentido de "antes → depois": dia ou período. É o
 * que separa esta família de `distribuicao`, onde o x é uma faixa e a
 * ordem é só arrumação.
 *
 * `MonthlyChart` tem leitura no hover porque é COMBINADO: imprime só a barra,
 * e o ponto de ROI não aparece em número nenhum sem ela.
 */
/**
 * `emCurso` aqui NÃO vira cauda tracejada.
 * A curva é acumulada sobre RESOLVIDAS: o último trecho já é definitivo.
 * O que falta é o que ainda vai ENTRAR, à direita. Tracejar o fim afirmaria que
 * aquele valor é incerto — que é falso — em vez de dizer que a curva não acabou.
 * Por isso a declaração é nota sob o gráfico, não marca sobre a linha.
 */
export function AreaChart({ pts, color, H = 250, larguraInicial, emCurso = null, ariaLabel = "Evolução acumulada" }: {
  pts: readonly { label?: string; v: number }[];
  color: string;
  H?: number;
  /** Largura do primeiro desenho (`LARGURA_INICIAL`); o gráfico se mede depois. */
  larguraInicial?: number;
  emCurso?: EmCurso | null;
  ariaLabel?: string;
}) {
  const { T, mode } = useDesign();
  const money = useMoneyFormat();
  const displayColor = uiDisplayColor(T, color);
  const { chartRef, chartWidth: W } = useResponsiveChartWidth(larguraInicial);
  const gradientId = useChartId("analyzer-area");
  const padT = 14, padB = 26, padL = 48, padR = 8;
  const { indice, handlers } = useChartHover(pts.length, { largura: W, padL, padR });
  const geometry = useMemo(() => {
    if (!pts.length) return null;
    const vals = pts.map((p) => p.v);
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
    const pad = (hi - lo) * 0.12 || 0.3; lo -= pad; hi += pad;
    const eixo = escala(lo, hi, faixaVertical(H, padT, padB));
    const xs = (i: number) => padL + (W - padL - padR) * (pts.length === 1 ? 0.5 : i / (pts.length - 1));
    const ys = eixo.px;
    const P = pts.map((p, i) => ({ x: xs(i), y: ys(p.v) }));
    const line = uiSmooth(P);
    const base = ys(0);
    const area = line + ` L${P[P.length - 1]!.x},${base} L${P[0]!.x},${base} Z`;
    const ticks = marcasRedondas(lo, hi);
    // Sem data no primeiro ponto (o antes da primeira aposta), o eixo começa no seguinte.
    const inicio = pts[0]?.label || pts.length < 2 ? 0 : 1;
    const rotulosX = rotulosQueCabem(pts.slice(inicio).map((p) => p.label ?? ''), W - padR - xs(inicio), 10).map((i) => i + inicio);
    return { P, line, area, ticks, inicio, rotulosX, xs, ys };
  }, [pts, W, H]);
  if (!geometry) return <ChartEmptyState height={H} />;
  const { P, line, area, ticks, inicio, rotulosX, xs, ys } = geometry;
  const alvo = indice != null && pts[indice] != null ? pts[indice] : null;
  return (
    <div style={{ position: 'relative' }}>
    <svg ref={chartRef} data-responsive-chart="true" role="img" aria-label={ariaLabel} width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }} {...handlers}>
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={displayColor} stopOpacity={mode === 'dark' ? 0.28 : 0.2} />
        <stop offset="100%" stopColor={displayColor} stopOpacity="0" /></linearGradient></defs>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={ys(v)} y2={ys(v)} stroke={Math.abs(v) < 1e-9 ? T.border : T.borderSoft}
            strokeWidth="1" strokeDasharray={Math.abs(v) < 1e-9 ? '' : '2 4'} />
          <text x={0} y={ys(v) + 3.5} fontFamily={T.font.num} fontSize="10" fill={T.textFaint} style={{ fontVariantNumeric: 'tabular-nums' }}>
            {money.axis(v)}</text>
        </g>
      ))}
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={displayColor} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      {/* Um ponto só, no valor atual: um marcador por aposta engrossava e serrilhava a linha. */}
      <circle cx={P[P.length - 1]!.x} cy={P[P.length - 1]!.y} r="4" fill={displayColor} />
      {rotulosX.map((i) => pts[i]!.label && (
        <text key={i} x={xs(i)} y={H - 6} fontFamily={T.font.num} fontSize="10" fill={T.textFaint}
          textAnchor={pts.length === 1 ? 'middle' : i === pts.length - 1 ? 'end' : i === inicio ? 'start' : 'middle'}
          style={{ fontVariantNumeric: 'tabular-nums' }}>{pts[i]!.label}</text>
      ))}
      {alvo && <ChartCrosshair x={xs(indice!)} topo={padT} base={H - padB} pontos={[{ y: ys(alvo.v), cor: displayColor }]} />}
    </svg>
    {alvo && (
      <ChartReadout x={xs(indice!)} largura={W} titulo={alvo.label ?? `ponto ${indice! + 1}`}
        linhas={[{ rotulo: 'Acumulado', cor: displayColor, valor: money.signed(alvo.v) }]} />
    )}
    {emCurso && aindaSeMove(emCurso) && (
      <div style={{ marginTop: 8, color: T.textFaint, font: `11.5px ${T.font.body}` }}>
        A curva ainda não terminou: {textoDeEmCurso(emCurso)}.
      </div>
    )}
    </div>
  );
}

export function MonthlyChart({ data, larguraInicial }: {
  data: readonly { label: string; v: number; roi: number | null; emCurso?: EmCurso }[];
  /** Largura do primeiro desenho (`LARGURA_INICIAL`); o gráfico se mede depois. */
  larguraInicial?: number;
}) {
  const { T, ink } = useDesign();
  const money = useMoneyFormat();
  const { chartRef, chartWidth: W } = useResponsiveChartWidth(larguraInicial);
  const H = 230, padT = 16, padB = 30, padL = 54, padR = 54;
  // Antes do return antecipado: hook não pode ficar atrás de condicional.
  const { indice, handlers } = useChartHoverFaixa(data.length, { largura: W, padL, padR });
  if (!data.length) return <ChartEmptyState height={H} />;
  const maxAbs = Math.max(0.3, ...data.map((d) => Math.abs(d.v)));
  const caixa = faixaVertical(H, padT, padB);
  const eixoLucro = escala(-maxAbs * 1.1, maxAbs * 1.1, caixa);
  const ys = eixoLucro.px;
  const n = data.length;
  const slot = (W - padL - padR) / Math.max(n, 1);
  const bw = Math.min(54, slot * 0.5);
  // O ROI divide o zero com o lucro: com escala própria, ROI positivo chegava
  // a sair abaixo da linha que o gráfico chama de zero (`lib/eixo-secundario`).
  // Sem nenhum ROI no recorte não há eixo a declarar: a escala simbólica que
  // `compartilhandoOZero` devolve para "tudo nulo" rotularia +5,5%/0,0% sem ponto.
  const temRoi = data.some((d) => d.roi != null && Number.isFinite(d.roi));
  const eixoRoi = temRoi ? compartilhandoOZero(data.map((d) => d.roi), eixoLucro, caixa, { minimoAbs: 5 }) : null;
  // O alcance do lucro é simétrico em torno do zero.
  const base = eixoLucro.pxDoZero!;
  const alvo = indice != null && data[indice] != null ? data[indice] : null;
  return (
    <div style={{ position: 'relative' }}>
    <svg ref={chartRef} data-responsive-chart="true" role="img" aria-label="Lucro e ROI por período" width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }} {...handlers}>
      {alvo && <ChartRealce x={padL + slot * (indice! + 0.5)} largura={slot} topo={padT} base={H - padB} />}
      <line x1={padL} x2={W - padR} y1={base} y2={base} stroke={T.border} strokeWidth="1" />
      {data.map((d, i) => {
        const cx = padL + slot * (i + 0.5);
        const top = ys(Math.max(0, d.v)), bot = ys(Math.min(0, d.v));
        const cor = d.v >= 0 ? (T.posDisplay || T.pos) : (T.negDisplay || T.neg);
        // Balde que ainda se move sai vazado e tracejado: sólido é o contrato
        // de "este número acabou".
        const move = d.emCurso ? aindaSeMove(d.emCurso) : false;
        return (
          <g key={i}>
            <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(2, bot - top)} rx="4"
              fill={cor} opacity={move ? 0.3 : 0.92}
              stroke={move ? cor : 'none'} strokeWidth={move ? 1.5 : 0}
              strokeDasharray={move ? '3 3' : undefined} />
            {d.roi != null && eixoRoi && <circle cx={cx} cy={eixoRoi.px(d.roi)} r="4" fill={T.brandAccent || T.accent} stroke={T.surface} strokeWidth="2" />}
            <text x={cx} y={H - 8} fontFamily={T.font.num} fontSize="11" fill={T.textMuted} textAnchor="middle"
              style={{ fontVariantNumeric: 'tabular-nums' }}>{d.label}</text>
            <text x={cx} y={(d.v >= 0 ? top : bot + 14) - (d.v >= 0 ? 8 : 0)} fontFamily={T.font.num} fontSize="11.5"
              fontWeight="600" fill={ink(d.v)} textAnchor="middle" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {money.axis(d.v)}</text>
          </g>
        );
      })}
      {/* O eixo do ROI: o zero (comum às duas séries) e o topo da escala. O
          valor de cada ponto fica no hover; rotular o último item só faria
          sentido com o eixo x em tempo, e "Top casas por lucro" não é. */}
      {eixoRoi && <g>
        <text x={W - padR + 6} y={eixoRoi.px(eixoRoi.hi) + 8} fontFamily={T.font.num} fontSize="10"
          fill={T.accent} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtPct(eixoRoi.hi)}</text>
        <text x={W - padR + 6} y={base + 3} fontFamily={T.font.num} fontSize="10"
          fill={T.accent} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtPct(0)}</text>
      </g>}
    </svg>
    {alvo && (
      <ChartReadout x={padL + slot * (indice! + 0.5)} largura={W} titulo={alvo.label}
        linhas={[
          { rotulo: 'Lucro', cor: alvo.v >= 0 ? (T.posDisplay || T.pos) : (T.negDisplay || T.neg), valor: money.signed(alvo.v), corValor: ink(alvo.v) },
          // A razão de existir deste hover: o ponto de ROI nunca teve número.
          { rotulo: 'ROI', cor: T.brandAccent || T.accent, valor: alvo.roi == null ? '—' : fmtPct(alvo.roi), corValor: alvo.roi == null ? T.textFaint : ink(alvo.roi) },
          // A barra vazada diz QUE ainda se move; o hover diz QUANTO.
          ...(alvo.emCurso && aindaSeMove(alvo.emCurso)
            ? [{ rotulo: 'Em aberto', cor: T.textFaint, valor: textoDeEmCurso(alvo.emCurso), corValor: T.textMuted }]
            : []),
        ]} />
    )}
    </div>
  );
}

export type ChartCurve = {
  key: string; name: string; color: string; values: readonly number[];
  /** `stroke-dasharray` da linha e da legenda; vazio é traço contínuo. */
  dash?: string;
};

/**
 * Várias curvas acumuladas no mesmo eixo, com legenda e leitura de todas no
 * mesmo ponto. O traço é reto: a curva suavizada passaria por valores que
 * nenhuma série teve, e aqui as linhas se cruzam. A tabela ao lado do gráfico
 * leva os números; o gráfico mostra o caminho.
 */
export function MultiCurveChart({ labels, series, H = 260, ariaLabel = "Curvas acumuladas" }: {
  labels: readonly string[];
  series: readonly ChartCurve[];
  H?: number;
  ariaLabel?: string;
}) {
  const { T, ink } = useDesign();
  const money = useMoneyFormat();
  const { chartRef, chartWidth: W } = useResponsiveChartWidth();
  const padT = 14, padB = 26, padL = 48, padR = 8;
  const { indice, handlers } = useChartHover(labels.length, { largura: W, padL, padR });
  const geometry = useMemo(() => {
    if (labels.length < 2 || !series.length) return null;
    let lo = 0, hi = 0;
    for (const s of series) for (const v of s.values) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
    const pad = (hi - lo) * 0.12 || 0.3; lo -= pad; hi += pad;
    const ys = escala(lo, hi, faixaVertical(H, padT, padB)).px;
    const xs = (i: number) => padL + (W - padL - padR) * (i / (labels.length - 1));
    const ticks = marcasRedondas(lo, hi);
    const last = labels.length - 1;
    // O ponto 0 é o antes do primeiro resultado, sem data: o eixo começa no primeiro dia.
    const inicio = labels[0] ? 0 : 1;
    const labeled = rotulosQueCabem(labels.slice(inicio), W - padR - xs(inicio), 10).map((i) => i + inicio);
    const paths = series.map((s) => sampleChartPoints(s.values.map((v, j) => ({ x: xs(j), y: ys(v) })))
      .map((point, j) => `${j ? 'L' : 'M'}${chartCoordinate(point.x)},${chartCoordinate(point.y)}`).join(' '));
    return { xs, ys, ticks, last, inicio, labeled, paths };
  }, [labels, series, W, H]);
  if (!geometry) return <ChartEmptyState height={H} />;
  const { xs, ys, ticks, last, inicio, labeled, paths } = geometry;
  const colors = series.map((s) => uiDisplayColor(T, s.color));
  return (
    <div>
      <ul aria-label="Legenda" style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
        {series.map((s, i) => (
          <li key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 7, font: `12px ${T.font.body}`, color: T.textMuted }}>
            <svg aria-hidden="true" width="22" height="4" viewBox="0 0 22 4" style={{ flexShrink: 0, overflow: 'visible' }}>
              <line x1="1" x2="21" y1="2" y2="2" stroke={colors[i]} strokeWidth="2" strokeLinecap="round" strokeDasharray={s.dash || undefined} />
            </svg>
            {s.name}
          </li>
        ))}
      </ul>
      <div style={{ position: 'relative' }}>
        <svg ref={chartRef} data-responsive-chart="true" role="img" aria-label={ariaLabel} width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }} {...handlers}>
          {ticks.map((v, i) => (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={ys(v)} y2={ys(v)} stroke={Math.abs(v) < 1e-9 ? T.border : T.borderSoft}
                strokeWidth="1" strokeDasharray={Math.abs(v) < 1e-9 ? '' : '2 4'} />
              <text x={0} y={ys(v) + 3.5} fontFamily={T.font.num} fontSize="10" fill={T.textFaint} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {money.axis(v)}</text>
            </g>
          ))}
          {/* A primeira série é desenhada por último: quando duas coincidem, a de referência fica por cima. */}
          {series.map((s, i) => ({ s, color: colors[i], path: paths[i] })).reverse().map(({ s, color, path }) => (
            <path key={s.key} data-curve={s.key} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={s.dash || undefined}
              d={path} />
          ))}
          {labeled.map((i) => labels[i] ? (
            <text key={i} x={xs(i)} y={H - 6} fontFamily={T.font.num} fontSize="10" fill={T.textFaint}
              textAnchor={i === last ? 'end' : i === inicio ? 'start' : 'middle'} style={{ fontVariantNumeric: 'tabular-nums' }}>{labels[i]}</text>
          ) : null)}
          {indice != null && <ChartCrosshair x={xs(indice)} topo={padT} base={H - padB}
            pontos={series.map((s, i) => ({ y: ys(s.values[indice] ?? 0), cor: colors[i]!, r: 4 }))} />}
        </svg>
        {indice != null && (
          <ChartReadout x={xs(indice)} largura={W} titulo={labels[indice] || 'início'} larguraCaixa={Math.min(220, W)}
            linhas={series.map((s, i) => {
              const v = s.values[indice] ?? 0;
              return { rotulo: s.name, cor: colors[i], valor: money.signed(v), corValor: ink(v) };
            })} />
        )}
      </div>
    </div>
  );
}
