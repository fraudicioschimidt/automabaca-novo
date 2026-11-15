import { useMemo } from "react";
import { uiSmooth } from "../../utils";
import { ChartEmptyState, useChartId, useResponsiveChartWidth } from "../../lib/responsive-chart";
import { ChartCrosshair, ChartReadout, useChartHover } from "../../lib/chart-hover";
import { escala, faixaVertical, marcasRedondas } from "../../lib/eixo-secundario";
import { useDesign } from "../../kit/context";
import { Panel } from "../../kit/primitives";
import { BRL_FORMAT, fmtBrl } from "@/src/domain/formato-de-resultado";

export function EquityCard({ A }: { A: { agg: number[]; lucro: number } }) {
  const { T, mode, ink } = useDesign();
  // Largura do primeiro desenho (a coluna larga no desktop); a medida corrige no primeiro quadro.
  const { chartRef, chartWidth: W } = useResponsiveChartWidth(594);
  const gradientId = useChartId("dashboard-equity");
  const H = 210, padT = 12, padB = 16, padL = 76, padR = 6;
  const data = A.agg;
  const geometry = useMemo(() => {
    const lo = Math.min(0, ...data), hi = Math.max(0, ...data), rng = (hi - lo) * 1.1 || 1;
    const xs = (i: number) => padL + (W - padL - padR) * (i / Math.max(data.length - 1, 1));
    // A folga de 5% embaixo entra no ALCANCE, não na fórmula: piso = lo − 5% do vão.
    const piso = lo - rng * 0.05;
    const ys = escala(piso, piso + rng, faixaVertical(H, padT, padB)).px;
    const pts = data.map((v, i) => ({ x: xs(i), y: ys(v) }));
    const marcas = marcasRedondas(piso, piso + rng);
    const line = uiSmooth(pts);
    return { lo, rng, xs, ys, pts, marcas, line };
  }, [data, W]);
  const { lo, rng, xs, ys, pts, marcas, line } = geometry;
  const c = A.lucro >= 0 ? (T.posDisplay || T.pos) : (T.negDisplay || T.neg);

  // Cada passo da curva é legível no hover, com a variação contra o ponto
  // anterior: é ela que responde "que dia foi esse?".
  const { indice, handlers } = useChartHover(data.length, { largura: W, padL, padR });
  const temLeitura = indice != null && data[indice] != null;
  const variacao = temLeitura && indice > 0 ? data[indice]! - data[indice - 1]! : null;

  return (
    <Panel style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 14 }}>
        <h3 style={{ margin: 0, fontFamily: T.font.display, fontSize: 17, fontWeight: 600, color: T.text, letterSpacing: '-0.01em' }}>Lucro acumulado · todos os tipsters</h3>
        <span style={{ marginLeft: 'auto', fontFamily: T.font.num, fontVariantNumeric: 'tabular-nums', fontSize: 18, fontWeight: 600, color: ink(A.lucro) }}>{fmtBrl(A.lucro, true)}</span>
      </div>
      {data.length < 2 ? <ChartEmptyState height={H}>O histórico aparecerá após a primeira movimentação.</ChartEmptyState> : (
      <div style={{ position: 'relative' }}>
        <svg ref={chartRef} data-responsive-chart="true" role="img" aria-label={`Lucro acumulado de ${fmtBrl(A.lucro, true)}`} width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }} {...handlers}>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c} stopOpacity={mode === 'dark' ? 0.26 : 0.18} /><stop offset="100%" stopColor={c} stopOpacity="0" /></linearGradient></defs>
          {marcas.map((g) => (<g key={g}><line x1={padL} x2={W - padR} y1={ys(g)} y2={ys(g)} stroke={Math.abs(g) < 1e-9 ? T.border : T.borderSoft} strokeDasharray={Math.abs(g) < 1e-9 ? '' : '2 4'} /><text x={0} y={ys(g) + 3} fontFamily={T.font.num} fontSize="9.5" fill={T.textFaint}>{BRL_FORMAT.axis(g)}</text></g>))}
          <path d={line + ` L${pts[pts.length - 1]!.x},${ys(lo - rng * 0.05)} L${pts[0]!.x},${ys(lo - rng * 0.05)} Z`} fill={`url(#${gradientId})`} />
          <path d={line} fill="none" stroke={c} strokeWidth="2.6" strokeLinecap="round" />
          <circle cx={pts[pts.length - 1]!.x} cy={pts[pts.length - 1]!.y} r="4" fill={c} />
          {temLeitura && (
            <ChartCrosshair x={xs(indice)} topo={padT} base={H - padB} pontos={[{ y: ys(data[indice]!), cor: c }]} />
          )}
        </svg>
        {temLeitura && (
          <ChartReadout
            x={xs(indice)}
            largura={W}
            titulo={`ponto ${indice + 1} de ${data.length}`}
            linhas={[
              { rotulo: 'Acumulado', cor: c, valor: fmtBrl(data[indice], true), corValor: ink(data[indice]) },
              ...(variacao != null ? [{ rotulo: 'No passo', valor: fmtBrl(variacao, true), corValor: ink(variacao) }] : []),
            ]}
          />
        )}
      </div>
      )}
    </Panel>
  );
}
