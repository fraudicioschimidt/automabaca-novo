import { useDesign } from "../../kit/context";
import { OpsCard, SectionHead } from "./ui-primitives";
import { uiHexA } from "../../utils";
import styles from "./operacoes.module.css";
import type { MonitoramentoData } from "../../adapters/operacoes";
import type { CssVarsStyle } from "../../kit/css-vars";

const KIND_LABEL: Record<string, string> = { queue: 'filas', provider: 'providers', action: 'ações' };

function fmtMs(ms: number | null) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

export function ObservabilityCard({ rows }: { rows: MonitoramentoData["slo"] }) {
  const { T } = useDesign();
  const breaches = rows.filter((row) => row.status === 'breach').length;
  const ordered = [...rows].sort((left, right) => {
    const rank: Record<string, number> = { breach: 0, warning: 1, healthy: 2 };
    return (rank[left.status] ?? 3) - (rank[right.status] ?? 3)
      || String(left.name).localeCompare(String(right.name), 'pt-BR');
  });
  const hintStyle: CssVarsStyle = { '--ops-hint-color': breaches ? T.neg : T.textFaint };
  return (
    <OpsCard className={styles.cardSpace}>
      <SectionHead title="SLO operacional" sub="janela móvel de 24 horas"
        right={<span className={styles.sectionHint} style={hintStyle}>{breaches ? `${breaches} violação(ões)` : 'disponibilidade · latência · atraso'}</span>} />
      {rows.length === 0 ? (
        <div className={styles.sloEmpty}>
          Coletando as primeiras amostras. Filas e providers aparecerão após as próximas execuções.
        </div>
      ) : (
        <div className={styles.sloGrid}>
          {ordered.map((row) => {
            const tone = row.status === 'breach' ? T.neg : row.status === 'warning' ? T.accent : T.pos;
            const rowStyle: CssVarsStyle = {
              '--ops-tone': tone,
              '--ops-tone-soft': uiHexA(tone, 24 / 255),
              '--ops-reason-color': row.status === 'breach' ? T.neg : T.textFaint,
            };
            return (
              <div key={row.id} className={styles.sloCard} style={rowStyle}>
                <div className={styles.sloHead}>
                  <span className={styles.sloDot} />
                  <span className={styles.sloName}>{row.name}</span>
                  <span className={styles.sloKind}>{KIND_LABEL[row.kind] || row.kind}</span>
                </div>
                <div className={styles.sloMetrics}>
                  <div><div className={styles.sloLabel}>{String(row.name).endsWith('.breaker') ? 'Aberturas' : 'Sucesso'}</div><div className={`${styles.sloValue} ${styles.sloValueTone}`}>{String(row.name).endsWith('.breaker') ? row.errors : `${row.success.toFixed(1)}%`}</div></div>
                  <div><div className={styles.sloLabel}>p95</div><div className={styles.sloValue}>{fmtMs(row.p95)}</div></div>
                  <div><div className={styles.sloLabel}>{row.kind === 'queue' ? 'Atraso' : 'Amostra'}</div><div className={styles.sloValue}>{row.kind === 'queue' ? fmtMs(row.lagP95) : row.samples}</div></div>
                </div>
                <div className={styles.sloReason}>
                  {[row.reasons.length ? row.reasons.join(' · ') : `${row.samples} amostras`, `última ${row.last}`].join(' · ')}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </OpsCard>
  );
}
