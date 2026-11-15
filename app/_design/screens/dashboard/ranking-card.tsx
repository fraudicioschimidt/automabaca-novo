import { Fragment } from "react";
import Link from "next/link";
import { uiHexA } from "../../utils";
import { Spark } from "./spark";
import styles from "./ranking-card.module.css";
import { contagem, plural } from "../../lib/plural";
import { ICONS, Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { Cap, Panel } from "../../kit/primitives";
import { fmtPct, fmtRate, fmtU } from "@/src/domain/formato-de-resultado";
import { cssVars } from "../../kit/css-vars";
import type { DashboardScreenProps } from "../../screen-types";

/** O que o ranking lê de cada banca. */
type RankingTipster = Pick<DashboardScreenProps["data"]["tipsters"][number],
  "id" | "name" | "main" | "sharpMode" | "unit" | "equity" | "n" | "open" | "lucro"
  | "hasRoi" | "roi" | "hasClv" | "clv" | "hasAcerto" | "acerto">;

export function RankingCard({ TIP, sorted, sortKey, setSortKey }: {
  TIP: { tipsters: readonly RankingTipster[] };
  sorted: RankingTipster[];
  sortKey: string;
  setSortKey: (key: string) => void;
}) {
  const { T, ink } = useDesign();
  const sorts: [string, string][] = [['decisao', 'Edge'], ['clv', 'CLV confiável'], ['lucro', 'Lucro'], ['roi', 'ROI'], ['volume', 'Volume']];
  const cols: [string, 'left' | 'right' | 'center', number | null][] = [['#', 'center', 32], ['Tipster', 'left', null], ['Curva', 'left', 140], ['Apostas', 'right', 70], ['Aberto', 'right', 62], ['Lucro', 'right', 78], ['ROI', 'right', 70], ['CLV', 'right', 66], ['Acerto', 'right', 64]];
  const gridCols = '32px 1.4fr 140px 70px 62px 78px 70px 66px 64px';

  return (
    <Panel pad={0} className={styles.card} style={cssVars({ '--rank-text': T.text, '--rank-muted': T.textMuted, '--rank-faint': T.textFaint, '--rank-accent': T.accent, '--rank-accent-soft': T.accentSoft, '--rank-surface': T.surface, '--rank-surface-2': T.surface2, '--rank-border': T.border, '--rank-border-soft': T.borderSoft, '--rank-display': T.font.display, '--rank-body': T.font.body, '--rank-num': T.font.num, '--rank-radius-sm': T.radiusSm, '--rank-cols': gridCols, '--rank-title-size': '19px', '--rank-title-weight': 600, '--rank-active-bg': T.text, '--rank-active-text': T.surface, '--rank-column-bg': 'transparent' })}>
      <div className={styles.header}>
        <h3 className={styles.heading}>Top tipsters</h3>
        <div className={`${styles.sorts} no-scrollbar`}>
          <span className={styles.sortLabel}>ordenar por</span>
          {sorts.map(([k, l]) => {
            const on = sortKey === k;
            return (<button key={k} onClick={() => setSortKey(k)} className={`${styles.sortButton} ${on ? styles.sortButtonActive : ''}`}>{l}</button>);
          })}
        </div>
      </div>
      <div className={`${styles.grid} ${styles.columns}`}>
        {cols.map(([c, a]) => <Cap key={c} style={{ fontSize: 9.5, textAlign: a }}>{c}</Cap>)}
      </div>
      {sorted.slice(0, 3).map((t, i) => {
        const top = i === 0;
        const href = '/tipsters/' + t.id + '?bk=' + t.id;
        return (
          <Fragment key={t.id}>
          <Link href={href} className={styles.mobileRow} style={cssVars({ '--rank-row-bg': top ? T.accentSoft : 'transparent', '--rank-value': top ? T.accent : T.textFaint, '--rank-badge-border': uiHexA(T.accent, 0.25) })}>
            <div className={styles.mobileHead}>
              <span className={`${styles.rank} ${styles.mobileRank}`}>{i + 1}</span>
              <div className={styles.itemText}>
                <div className={styles.nameLine}>
                  <span className={styles.name}>{t.name}</span>
                  {t.main && <span className={styles.mainBadge}>principal</span>}
                </div>
                <div className={styles.meta}>{t.unit}</div>
              </div>
              <span className={`${styles.number} ${styles.mobileProfit}`} style={cssVars({ '--rank-value': ink(t.lucro), '--rank-number-weight': 700 })}>{fmtU(t.lucro)}</span>
            </div>
            <div className={styles.spark}><Spark data={t.equity} w={260} h={40} fluid /></div>
            <div className={styles.mobileMetrics}>
              {([
                ['Apostas', String(t.n), T.text],
                ['Aberto', String(t.open), t.open ? T.accent : T.textFaint],
                ['ROI', t.hasRoi ? fmtPct(t.roi) : '—', t.hasRoi ? ink(t.roi) : T.textFaint],
                ['CLV', t.hasClv ? fmtPct(t.clv) : '—', t.hasClv ? ink(t.clv) : T.textFaint],
              ] satisfies [string, string, string][]).map(([label, value, color]) => (
                <div key={label} className={styles.metric} style={cssVars({ '--rank-value': color })}><Cap style={{ fontSize: 8.5, marginBottom: 5 }}>{label}</Cap><div className={styles.metricValue}>{value}</div></div>
              ))}
            </div>
          </Link>
          <Link href={href} className={`${styles.grid} ${styles.desktopRow} ${top ? styles.desktopRowTop : ''}`} style={cssVars({ '--rank-row-bg': top ? T.accentSoft : 'transparent', '--rank-hover-bg': T.surface2, '--rank-value': top ? T.accent : T.textFaint, '--rank-badge-border': uiHexA(T.accent, 0.25) })}>
            <span className={styles.rank}>{i + 1}</span>
            <div className={styles.tipster}>
              <div className={styles.nameLine}>
                <span className={styles.name}>{t.name}</span>
                {t.main && <span className={styles.mainBadge}>principal</span>}
              </div>
              <div className={styles.meta}>{t.unit}</div>
            </div>
            <Spark data={t.equity} />
            <span className={styles.number} style={cssVars({ '--rank-value': T.text })}>{t.n}</span>
            <span className={styles.number} style={cssVars({ '--rank-value': t.open ? T.accent : T.textFaint })}>{t.open}</span>
            <span className={styles.number} style={cssVars({ '--rank-value': ink(t.lucro), '--rank-number-size': '14px', '--rank-number-weight': 600 })}>{fmtU(t.lucro)}</span>
            <span className={styles.number} style={cssVars({ '--rank-value': t.hasRoi ? ink(t.roi) : T.textFaint, '--rank-number-weight': 600 })}>{t.hasRoi ? fmtPct(t.roi) : '—'}</span>
            <span className={styles.number} style={cssVars({ '--rank-value': t.hasClv ? ink(t.clv) : T.textFaint, '--rank-number-weight': 600 })}>{t.hasClv ? fmtPct(t.clv) : '—'}</span>
            <span className={styles.number} style={cssVars({ '--rank-value': T.text })}>{t.hasAcerto ? fmtRate(t.acerto) : '—'}</span>
          </Link>
          </Fragment>
        );
      })}
      <div className={styles.footerRow}>
        <Link href="/tipsters" className={styles.footer}>
          Ver {plural(TIP.tipsters.length, 'o', 'todos os')} {contagem(TIP.tipsters.length, 'tipster')}<Icon d={ICONS.arrow} s={15} /></Link>
        <Link href="/analyzer" prefetch={false} className={styles.footer}>
          Analyzer da carteira<Icon d={ICONS.arrow} s={15} /></Link>
      </div>
    </Panel>
  );
}
