import { OpsCard, SectionHead } from "./ui-primitives";
import { fmtRate } from "@/src/domain/formato-de-resultado";
import styles from "./operacoes.module.css";
import type { MonitoramentoData } from "../../adapters/operacoes";

const PHASE_LABEL: Record<string, string> = {
  PROBATION: "Em prova",
  SHARP_ACTIVE: "Sharp ativo",
  SHARP_OFF: "Só identidade",
};

export function ProbationCard({ segments = [] }: { segments?: MonitoramentoData["probation"] }) {
  const rows = segments;

  return (
    <OpsCard className={styles.cardSpace}>
      <SectionHead title="Probation por segmento" />
      <div className={styles.probationIntro}>
        Mercado×esporte em prova: com ≥100 apostas avaliadas e CLV confiável &lt;50%, o segmento vira &quot;só identidade&quot; sozinho (override manual disponível).</div>
      {rows.length === 0 ? (
        <div className={styles.probationEmpty}>
          <div className={styles.probationEmptyTitle}>Nenhum segmento avaliado ainda</div>
          <div className={styles.probationEmptyText}>Tudo em probation implícita — a prova decide com volume<br />(100 apostas por mercado×esporte).</div>
        </div>
      ) : (
        <div className={styles.probationList}>
          {rows.map((s, i) => {
            const clv = fmtRate(s.clv);
            return (
              <div key={s.id} className={`${styles.probationRow} ${i > 0 ? styles.probationDivider : ''}`}>
                <div className={styles.itemContent}>
                  <div className={styles.probationName}>{s.esporte} · {s.mercado}</div>
                  <div className={styles.probationPhase}>
                    {PHASE_LABEL[s.phase] || s.phase}
                    {s.evaluatedAt ? ` · avaliado ${s.evaluatedAt}` : ""}
                  </div>
                </div>
                <div className={styles.probationStats}>
                  <div>{s.bets} bets</div>
                  <div className={styles.probationClv}>CLV {clv}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </OpsCard>
  );
}
