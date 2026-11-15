import { useDesign } from "../../kit/context";
import { OpsCard, SectionHead } from "./ui-primitives";
import styles from "./operacoes.module.css";
import { textoDeRendimento, textoDoCusto } from "../../lib/rendimento-na-tela";
import type { MonitoramentoData } from "../../adapters/operacoes";
import type { CssVarsStyle } from "../../kit/css-vars";

export function BudgetsCard({ budgets }: { budgets: MonitoramentoData["budgets"] }) {
  const { T } = useDesign();
  return (
    <OpsCard className={styles.cardSpace}>
      <SectionHead title="Budgets de providers" sub="gasto do período do teto · entrega dos últimos 7 dias" />
      <div className={styles.budgetList}>
        {budgets.map((b) => {
          const pct = b.cap ? Math.min(100, b.used / b.cap * 100) : null;
          const danger = pct != null && pct >= 70;
          const barStyle: CssVarsStyle = {
            '--ops-progress': `${pct}%`,
            '--ops-tone': danger ? (pct >= 90 ? T.neg : T.accent) : T.pos,
          };
          return (
            <div key={b.name}>
              <div className={`${styles.budgetHead} ${pct != null ? styles.budgetHeadWithBar : ''}`}>
                <span className={styles.budgetName}>{b.name}</span>
                <span className={styles.budgetUsage} title={b.period ?? undefined}>
                  {b.cap == null ? <b className={styles.budgetUnlimited}>ilimitado</b>
                    : <><b className={styles.budgetFraction}>{b.used}/{b.cap}</b> {textoDoCusto(b.janelaDoCusto)} <span className={styles.textFaint}>·</span> {b.label}</>}</span>
              </div>
              {pct != null && (
                <div className={styles.budgetTrack} style={barStyle}><div className={styles.budgetBar} /></div>
              )}
              <div className={styles.budgetYield}>{textoDeRendimento(b.rendimento)}</div>
            </div>
          );
        })}
      </div>
    </OpsCard>
  );
}
