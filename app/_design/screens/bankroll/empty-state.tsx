import Link from "next/link";
import { uiHexA } from "../../utils";
import styles from "./empty-state.module.css";
import { Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { cssVars } from "../../kit/css-vars";
import type { Overlay } from "./types";

export function EmptyState({ setOverlay, canManage = true }: {
  setOverlay: (overlay: Overlay) => void;
  canManage?: boolean;
}) {
  const { T, numFont } = useDesign();
  return (
    <div className={styles.wrapper} style={cssVars({ '--empty-surface': T.surface, '--empty-border': T.border, '--empty-border-soft': T.borderSoft, '--empty-text': T.text, '--empty-muted': T.textMuted, '--empty-faint': T.textFaint, '--empty-accent': T.accent, '--empty-accent-soft': T.accentSoft, '--empty-accent-text': T.accentText, '--empty-display': T.font.display, '--empty-body': T.font.body, '--empty-radius': `${T.radius}px`, '--empty-radius-md': `${T.radiusMd}px`, '--empty-shadow': T.cardShadow, '--empty-button-shadow': `0 8px 20px -8px ${uiHexA(T.accent, 0.55)}`, '--empty-title-size': '26px', '--empty-title-weight': 600 })}>
      <div className={styles.card}>
        <div className={styles.icon}>
          <Icon d="M3 10l14-6-3 13-4-3-2 3-1-4z" s={30} w={1.4} />
        </div>
        <h2 className={styles.title}>O tipster está pronto</h2>
        <p className={styles.description}>
          Conecte um canal do Telegram e o AutomaBACA passa a registrar, enriquecer com a Pinnacle e liquidar suas apostas automaticamente. Nenhuma aposta ainda — assim que a primeira cair, ela aparece aqui.</p>
        <div className={styles.actions}>
          {canManage ? <Link href="/config" className={`${styles.button} ${styles.primary}`}>Conectar canal</Link> : null}
          {canManage ? <button type="button" onClick={() => setOverlay('adicionar')} className={`${styles.button} ${styles.secondary}`}>Adicionar manualmente</button> : null}
        </div>
        <div className={styles.steps}>
          {[['1', 'Conecte', 'um canal do Telegram'], ['2', 'Reaja', 'confirme ou remova'], ['3', 'Relaxe', 'fechamento e liquidação automáticos']].map(([n, t, d]) => (
            <div key={n} className={styles.step}>
              <div className={styles.stepNumber} style={numFont}>{n}</div>
              <div className={styles.stepTitle}>{t}</div>
              <div className={styles.stepDescription}>{d}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
