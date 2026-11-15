import { useMemo } from "react";
import { uiDisplayColor, uiSmooth } from "../../utils";
import { ChartEmptyState, useChartId, useResponsiveChartWidth } from "../../lib/responsive-chart";
import { escala, faixaVertical, marcasRedondas, rotulosQueCabem } from "../../lib/eixo-secundario";
import { ChartCrosshair, ChartReadout, useChartHover } from "../../lib/chart-hover";
import { fmtU } from "@/src/domain/formato-de-resultado";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import type { BankrollView } from "./types";

/**
 * O cursor do hover pertence ao gráfico: mantê-lo aqui evita recalcular os
 * filtros e renderizar todo o histórico da banca a cada movimento do mouse.
 * A curva é a da banca inteira, e o lucro ao lado dela também: o recorte da
 * lista não entra aqui.
 */
export function ProfitChart({ AB }: { AB: BankrollView }) {
  const mLucro = AB.METRICS.lucro;
  const { T, mode, ink, numFont } = useDesign();
  const { chartRef, chartWidth: W } = useResponsiveChartWidth();
  const gradientId = useChartId("bankroll-profit");
  // A curva segue o sinal do lucro, como a do Dashboard.
  const realizedColor = uiDisplayColor(T, (mLucro ?? 0) >= 0 ? T.pos : T.neg);
  const H = 230, padT = 12, padB = 26, padL = 4, padR = 4;
  const SRC = AB.CHART;
  const geometry = useMemo(() => {
    const plotSource = SRC.length ? SRC : [{ label: "", realized: 0 }];
    const vals = plotSource.map((p) => p.realized);
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
    const padv = (hi - lo) * 0.12 || 0.3; lo -= padv; hi += padv;
    const xs = (i: number) => padL + (W - padL - padR) * (SRC.length === 1 ? 0.5 : i / (SRC.length - 1));
    const ys = escala(lo, hi, faixaVertical(H, padT, padB)).px;
    const real = plotSource.map((p, i) => ({ x: xs(i), y: ys(p.realized) }));
    const realD = uiSmooth(real);
    const base = ys(0);
    const areaD = realD + ` L${real[real.length - 1]!.x},${base} L${real[0]!.x},${base} Z`;
    const grid = marcasRedondas(lo, hi);
    const rotulosX = rotulosQueCabem(plotSource.map((p) => p.label), W - padL - padR, 10.5);
    const n = plotSource.length;
    return { plotSource, real, realD, areaD, grid, rotulosX, n, xs, ys };
  }, [SRC, W]);
  const { plotSource, real, realD, areaD, grid, rotulosX, n, xs, ys } = geometry;
  const { indice: hover, handlers } = useChartHover(n, { largura: W, padL, padR });
  const hp = hover != null ? plotSource[hover] : null;
  const hasHover = hover != null && hp != null;

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius,
      boxShadow: T.cardShadow, padding: 'var(--bk-pad)', marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontFamily: T.font.display, fontSize: 18,
          fontWeight: 600, color: T.text, letterSpacing: '-0.01em',
          whiteSpace: 'nowrap', flexShrink: 0 }}>Evolução do lucro</h3>
        <div {...porFaixa({ display: 'flex', alignItems: 'center', whiteSpace: 'nowrap', flexWrap: 'wrap',
          fontFamily: T.font.body, fontSize: 12.5, color: T.textMuted }, { marginLeft: { largo: 'auto', compacto: 0 }, width: { largo: 'auto', compacto: '100%' }, gap: { largo: 18, compacto: 12 } })}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 16, height: 2.5, borderRadius: 2, background: realizedColor }} />Realizado</span>
          <span style={{ ...numFont, color: ink(mLucro), fontWeight: 600, fontSize: 14 }}>{fmtU(mLucro)}</span>
        </div>
      </div>
      <div style={{ position: 'relative' }}>
        {SRC.length === 0 ? <ChartEmptyState height={H} /> : <svg ref={chartRef} data-responsive-chart="true" role="img" aria-label={`Evolução do lucro: ${fmtU(mLucro)}`} width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}
          {...handlers}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={realizedColor} stopOpacity={mode === 'dark' ? 0.26 : 0.18} />
              <stop offset="100%" stopColor={realizedColor} stopOpacity="0" />
            </linearGradient>
          </defs>
          {grid.map((g) => (
            <g key={g}>
              <line x1={padL} x2={W - padR} y1={ys(g)} y2={ys(g)}
                stroke={g === 0 ? T.border : T.borderSoft} strokeWidth="1"
                strokeDasharray={g === 0 ? '' : '2 4'} />
              <text x={padL} y={ys(g) - 5} fontFamily={T.font.num} fontSize="10.5" fill={T.textFaint}
                style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtU(g)}</text>
            </g>
          ))}
          <path d={areaD} fill={`url(#${gradientId})`} />
          <path d={realD} fill="none" stroke={realizedColor} strokeWidth="2.6" strokeLinecap="round" />
          <circle cx={real[real.length - 1]!.x} cy={real[real.length - 1]!.y} r="4" fill={realizedColor} />
          {rotulosX.map((i) => (
            <text key={i} x={xs(i)} y={H - 6} fontFamily={T.font.num} fontSize="10.5" fill={T.textFaint}
              textAnchor={n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              style={{ fontVariantNumeric: 'tabular-nums' }}>{plotSource[i]!.label}</text>
          ))}
          {hasHover && (
            <ChartCrosshair
              x={xs(hover)}
              topo={padT}
              base={H - padB}
              pontos={[
                { y: ys(hp.realized), cor: realizedColor, r: 5 },
              ]}
            />
          )}
        </svg>}
        {hasHover && (
          <ChartReadout
            x={xs(hover)}
            largura={W}
            titulo={hp.label}
            linhas={[
              { rotulo: 'Realizado', cor: realizedColor, valor: fmtU(hp.realized) },
            ]}
          />
        )}
      </div>
    </div>
  );
}
