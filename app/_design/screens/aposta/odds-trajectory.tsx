import { useDesign } from "../../kit/context";
import { fmtOdds } from "@/src/domain/formato-de-resultado";
import styles from "./odds-trajectory.module.css";
import { cssVars, type CssVarsStyle } from "../../kit/css-vars";

export type TrajectoryStep = { key: string; label: string; odd: number; liq: number | null; here?: boolean };

function formatLiquidity(value: number): string {
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function OddsTrajectory({ steps, lineColor }: { steps: readonly TrajectoryStep[]; lineColor: string }) {
  const { T } = useDesign();
  const odds = steps.map((step) => Number(step.odd));
  const min = Math.min(...odds);
  const max = Math.max(...odds);
  const spread = max - min;
  const padding = spread * 0.25 || 0.05;
  const low = min - padding;
  const high = max + padding;
  const points = steps.map((step, index) => ({
    ...step,
    x: steps.length === 1 ? 50 : 8 + (84 * index) / (steps.length - 1),
    y: 18 + 64 * (1 - (Number(step.odd) - low) / (high - low)),
  }));
  const vars: CssVarsStyle = {
    "--trajectory-line": lineColor,
    "--trajectory-surface": T.surface,
    "--trajectory-surface-2": T.surface2,
    "--trajectory-border": T.border,
    "--trajectory-border-soft": T.borderSoft,
    "--trajectory-text": T.text,
    "--trajectory-muted": T.textMuted,
    "--trajectory-faint": T.textFaint,
    "--trajectory-accent": T.accent,
    "--trajectory-num-font": T.font.num,
    "--trajectory-body-font": T.font.body,
    "--trajectory-radius-sm": `${T.radiusSm}px`,
    "--trajectory-pill": `${T.pill}px`,
    "--trajectory-value-size": `${T.type.amount.fontSize}px`,
    "--trajectory-label-size": `${T.type.link.fontSize}px`,
    "--trajectory-meta-size": `${T.type.captionSm.fontSize}px`,
    "--trajectory-step-count": steps.length,
  };

  return (
    <div
      className={styles.chart}
      style={vars}
      role="img"
      aria-label={`Trajetória das odds: ${points.map((point) => `${point.label} ${fmtOdds(point.odd)}`).join(", ")}`}
    >
      <div className={styles.plot}>
        <span className={styles.gridLine} data-position="top" aria-hidden="true" />
        <span className={styles.gridLine} data-position="middle" aria-hidden="true" />
        <span className={styles.gridLine} data-position="bottom" aria-hidden="true" />
        {points.length > 1 ? (
          <svg className={styles.line} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline
              points={points.map((point) => `${point.x},${point.y}`).join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : null}
        {points.map((point) => (
          <span
            key={point.key}
            className={styles.point}
            data-current={point.here ? "true" : "false"}
            style={cssVars({ "--trajectory-x": `${point.x}%`, "--trajectory-y": `${point.y}%` })}
            aria-hidden="true"
          >
            <span className={styles.value} data-trajectory-value>{fmtOdds(point.odd)}</span>
            <span className={styles.marker} />
          </span>
        ))}
      </div>
      <div className={styles.labels}>
        {points.map((point, index) => (
          <div
            key={point.key}
            className={styles.stage}
            data-edge={index === 0 ? "first" : index === points.length - 1 ? "last" : "middle"}
          >
            <span className={styles.stageName} data-trajectory-stage>{point.label}</span>
            <span className={styles.stageMeta}>
              {point.liq != null ? `Limite cotado · ${formatLiquidity(point.liq)}` : "Limite cotado não disponível"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
