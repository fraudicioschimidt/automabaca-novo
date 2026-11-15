import type { ComponentProps, ReactNode } from "react";
import { Panel } from "../../kit/primitives";
import { useDesign } from "../../kit/context";
import styles from "./operacoes.module.css";
import type { CssVarsStyle } from "../../kit/css-vars";

export function OpsCard(props: ComponentProps<typeof Panel>) {
  return <Panel pad={26} {...props} />;
}

export function SectionHead({ title, count, sub, right, tone }: {
  title: ReactNode;
  count?: number | null;
  sub?: ReactNode;
  right?: ReactNode;
  tone?: "warn";
}) {
  const { T } = useDesign();
  const countStyle: CssVarsStyle = { '--ops-count-bg': tone === 'warn' ? T.neg : T.accent };
  return (
    <div className={styles.sectionHead}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {count != null && count > 0 && (
        <span className={styles.sectionCount} style={countStyle}>{count}</span>
      )}
      {sub && <span className={styles.sectionSub}>{sub}</span>}
      {right && <div className={styles.sectionRight}>{right}</div>}
    </div>
  );
}

export function Match({ home, away }: { home: ReactNode; away: ReactNode }) {
  return (
    <span><b className={styles.matchStrong}>{home}</b> <span className={styles.matchVs}>vs</span> <b className={styles.matchStrong}>{away}</b></span>
  );
}
